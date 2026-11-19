import type {
  ClipRecord,
  JobStage,
  TranscriptSegment,
} from '../src/types';
import { ensureClipCompositions } from '../src/utils/composition';
import {
  DEFAULT_SUBTITLE_STYLE,
  mutateDb,
  readDb,
  resolveVideoInputSource,
} from './db';
import { processingQueue } from './queue';
import { extractMonoAudio } from './processing/audioExtractor';
import {
  parseSrtOrTextTranscript,
  type CandidateClip,
} from './processing/clipScorer';
import {
  isGeminiConfigured,
  refineCandidatesWithGemini,
  transcribeAudioWithGemini,
} from './processing/geminiClient';
import { renderClipWithFfmpeg } from './processing/renderer';
import { analyzeAudioEvents } from './processing/momentDetection/audioEvents';
import {
  closeCandidateBoundaries,
  detectNarrativeMoments,
} from './processing/momentDetection/momentDetector';
import {
  analyzeVideo,
  detectSceneChanges,
  generateThumbnail,
} from './processing/videoAnalyzer';

async function updateJob(
  jobId: number,
  stage: JobStage,
  progress: number,
  message: string
): Promise<void> {
  await mutateDb((db) => {
    const job = db.processingJobs.find((j) => j.id === jobId);
    if (job) {
      job.stage = stage;
      job.progress = progress;
      job.message = message;
      job.updatedAt = new Date().toISOString();
    }
  });
}

export async function runVideoPipeline(params: {
  videoId: number;
  jobId: number;
  useAi: boolean;
  suppliedTranscript?: string;
  presetSegments?: TranscriptSegment[];
  transcriptSource?: 'gemini' | 'srt' | 'manual' | 'sample';
}): Promise<void> {
  const {
    videoId,
    jobId,
    useAi,
    suppliedTranscript,
    presetSegments,
    transcriptSource,
  } = params;

  await processingQueue.run(async () => {
    try {
      const initialVideo = readDb().videos.find((v) => v.id === videoId);
      if (!initialVideo) throw new Error('Video record not found');

      await mutateDb((db) => {
        const v = db.videos.find((item) => item.id === videoId);
        if (v) {
          v.status = 'processing';
          v.errorMessage = undefined;
        }
      });

      const videoPath = resolveVideoInputSource(initialVideo);

      // Stage 1: Stream metadata + visual scene change detection
      await updateJob(
        jobId,
        'analyzing_video',
        18,
        'Inspecting streams, duration & visual scene changes via FFmpeg...'
      );
      const meta = await analyzeVideo(videoPath);
      const sceneTimestamps = await detectSceneChanges(videoPath, meta.duration);
      const coverUrl = await generateThumbnail(
        videoPath,
        `video-${videoId}-cover.jpg`,
        Math.min(2, Math.max(0.2, meta.duration * 0.15))
      );

      await mutateDb((db) => {
        const v = db.videos.find((item) => item.id === videoId);
        if (v) {
          v.duration = meta.duration;
          v.width = meta.width;
          v.height = meta.height;
          v.fps = meta.fps;
          v.hasAudio = meta.hasAudio;
          if (coverUrl) v.thumbnailUrl = coverUrl;
        }
      });

      // Stage 2 & 3: Audio extraction + Transcription (Interactions API or Local SRT/Text)
      let segments: TranscriptSegment[] = [];
      let resolvedSource: 'gemini' | 'srt' | 'manual' | 'sample' =
        transcriptSource ?? 'manual';

      if (presetSegments && presetSegments.length > 0) {
        await updateJob(jobId, 'transcribing', 52, 'Loading synced transcript segments...');
        segments = presetSegments;
        resolvedSource = transcriptSource ?? 'sample';
      } else if (suppliedTranscript && suppliedTranscript.trim().length > 0) {
        await updateJob(jobId, 'transcribing', 52, 'Parsing supplied SRT / transcript timestamps...');
        segments = parseSrtOrTextTranscript(suppliedTranscript, meta.duration);
        resolvedSource = 'srt';
      } else if (useAi && isGeminiConfigured()) {
        if (!meta.hasAudio) {
          throw new Error(
            'This video has no audio stream. Paste an SRT/text transcript to run deterministic scoring.'
          );
        }
        await updateJob(jobId, 'extracting_audio', 35, 'Extracting lightweight 16kHz mono MP3 audio...');
        const audioPath = await extractMonoAudio(videoPath, videoId);

        await updateJob(
          jobId,
          'transcribing',
          56,
          'Transcribing audio via Gemini 3.5 Transcribe Interactions API...'
        );
        segments = await transcribeAudioWithGemini(audioPath, meta.duration);
        resolvedSource = 'gemini';
      } else {
        throw new Error(
          'No transcript provided. Paste an SRT/transcript for 0-cost mode, or enable Gemini AI with GEMINI_API_KEY.'
        );
      }

      if (segments.length === 0) {
        throw new Error('Could not parse any spoken transcript segments.');
      }

      await mutateDb((db) => {
        db.transcriptions = db.transcriptions.filter((t) => t.videoId !== videoId);
        db.transcriptions.push({
          id: db.nextIds.transcription++,
          videoId,
          source: resolvedSource,
          language: 'auto',
          segments,
          createdAt: new Date().toISOString(),
        });
      });

      // Stage 4: Event-based deterministic detection + optional Gemini refinement.
      await updateJob(
        jobId,
        'scoring_moments',
        74,
        'Detecting complete narrative events, reactions and natural speech boundaries...'
      );

      const config = readDb().scoringConfig;
      const audioEvents = meta.hasAudio
        ? await analyzeAudioEvents(videoPath, meta.duration)
        : { energyPeaks: [], silenceEnds: [], available: false };
      let candidates: CandidateClip[] = detectNarrativeMoments({
        segments,
        config,
        sceneTimestamps,
        audio: audioEvents,
      });
      let scoringSource: 'heuristic' | 'gemini' = 'heuristic';
      let fallbackNote = '';

      if (useAi && candidates.length > 0) {
        if (isGeminiConfigured()) {
          try {
            await updateJob(
              jobId,
              'scoring_moments',
              82,
              'Ranking top filtered transcript excerpts via Gemini 4 Hydrogen...'
            );
            candidates = await refineCandidatesWithGemini(candidates, config);
            scoringSource = 'gemini';
          } catch (aiErr) {
            // Deterministic fallback if Gemini fails
            fallbackNote =
              aiErr instanceof Error
                ? ` (Gemini fallback -> deterministic rubric: ${aiErr.message.slice(0, 60)})`
                : ' (Gemini unavailable -> used deterministic rubric)';
          }
        } else {
          fallbackNote = ' (GEMINI_API_KEY missing -> used deterministic rubric)';
        }
      }

      candidates = closeCandidateBoundaries(candidates, segments, meta.duration);

      // Stage 5: Generate per-clip preview thumbnails & render real playable MP4 clips
      await updateJob(jobId, 'generating_thumbnails', 86, 'Generating clip thumbnails & preparing cuts...');

      const thumbUrls: Array<string | null> = [];
      const clipIds: number[] = [];
      await mutateDb((db) => {
        db.clips = db.clips.filter((c) => c.videoId !== videoId);
        for (let i = 0; i < candidates.length; i++) {
          clipIds.push(db.nextIds.clip++);
        }
      });

      for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        const midTime = (cand.startTime + cand.endTime) / 2;
        const thumb = await generateThumbnail(
          videoPath,
          `clip-${clipIds[i]}-preview.jpg`,
          midTime
        );
        thumbUrls.push(thumb);
      }

      const createdClips: ClipRecord[] = [];
      await mutateDb((db) => {
        for (let i = 0; i < candidates.length; i++) {
          const cand = candidates[i];
          const newClip: ClipRecord = {
            id: clipIds[i],
            videoId,
            title: cand.title,
            hookText: cand.hookText,
            hookType: cand.hookType,
            contextStatus: cand.contextStatus,
            sceneChanges: cand.sceneChanges,
            startTime: cand.startTime,
            endTime: cand.endTime,
            score: cand.score,
            breakdown: cand.breakdown,
            reason: cand.reason,
            scoringSource,
            status: i === 0 ? 'approved' : 'candidate',
            aspectRatio: '9:16',
            framingMode: 'crop',
            cropX: 50,
            cropY: 50,
            zoom: 1.0,
            compositions: ensureClipCompositions({}),
            exportVariants: {},
            subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
            exportedUrl: null,
            srtUrl: null,
            thumbnailUrl: thumbUrls[i] ?? coverUrl,
            createdAt: new Date().toISOString(),
          };
          db.clips.push(newClip);
          createdClips.push(newClip);
        }
      });

      let renderedCount = 0;
      for (let i = 0; i < createdClips.length; i++) {
        const clip = createdClips[i];
        const pct = 88 + Math.round(((i + 0.5) / Math.max(1, createdClips.length)) * 11);
        await updateJob(
          jobId,
          'generating_thumbnails',
          pct,
          `Cutting & rendering real MP4 clip ${i + 1}/${createdClips.length}...`
        );
        try {
          const rendered = await renderClipWithFfmpeg({
            clip,
            videoPath,
            hasAudio: meta.hasAudio,
            segments,
            variant: 'vertical',
          });
          renderedCount++;
          await mutateDb((db) => {
            const target = db.clips.find((c) => c.id === clip.id);
            if (target) {
              target.exportedUrl = rendered.exportedUrl;
              target.srtUrl = rendered.srtUrl;
              target.exportedSizeBytes = rendered.exportedSizeBytes;
              target.exportVariants = { vertical: rendered };
              if (rendered.thumbnailUrl) target.thumbnailUrl = rendered.thumbnailUrl;
              target.status = i === 0 ? 'approved' : 'exported';
            }
          });
        } catch (renderErr) {
          console.warn(
            `[ClipForge] Failed auto-rendering clip ${clip.id}:`,
            renderErr instanceof Error ? renderErr.message : renderErr
          );
        }
      }

      await mutateDb((db) => {
        const finalVideo = db.videos.find((v) => v.id === videoId);
        if (finalVideo) {
          finalVideo.status = 'ready';
          finalVideo.errorMessage = undefined;
        }
      });

      await updateJob(
        jobId,
        'completed',
        100,
        `Pipeline complete: ${renderedCount}/${createdClips.length} real MP4 clips created & ready.${fallbackNote}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected processing error';
      await mutateDb((db) => {
        const video = db.videos.find((v) => v.id === videoId);
        if (video) {
          video.status = 'error';
          video.errorMessage = message;
        }
      });
      await updateJob(jobId, 'failed', 100, message);
    }
  });
}
