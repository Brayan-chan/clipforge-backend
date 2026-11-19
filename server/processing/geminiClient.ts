import fs from 'node:fs';
import { GoogleGenAI, Type } from '@google/genai';
import type {
  ClipScoreBreakdown,
  ScoringConfig,
  TranscriptSegment,
} from '../../src/types';
import { parseSrtOrTextTranscript, type CandidateClip } from './clipScorer';

const MAX_LLM_CANDIDATES = 4;

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Add it in Settings > Secrets, or use 0-cost deterministic mode with an SRT/transcript.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

/**
 * Uses the Gemini Interactions API (`ai.interactions.create`) for `gemini-3.5-transcribe`
 * per official SDK guidelines, then aligns timestamps from transcript text only.
 */
export async function transcribeAudioWithGemini(
  audioPath: string,
  videoDuration: number
): Promise<TranscriptSegment[]> {
  const ai = getAiClient();
  const audioBuffer = fs.readFileSync(audioPath);
  const maxBytes = 18 * 1024 * 1024;
  if (audioBuffer.byteLength > maxBytes) {
    throw new Error(
      `Extracted audio is ${(audioBuffer.byteLength / (1024 * 1024)).toFixed(1)} MB, exceeding the 18 MB inline limit. Paste an SRT transcript instead.`
    );
  }

  const base64Audio = audioBuffer.toString('base64');

  const interaction = await ai.interactions.create({
    model: 'gemini-3.5-transcribe',
    input: [
      {
        type: 'audio',
        data: base64Audio,
        mime_type: 'audio/mp3',
      },
      {
        type: 'text',
        text: 'Transcribe the spoken audio accurately in its original language, preserving punctuation and speaker turns.',
      },
    ],
  });

  const rawTranscript = (interaction.output_text ?? '').trim();
  if (!rawTranscript) {
    throw new Error('Transcription returned empty text.');
  }

  // Segment text proportionally over real videoDuration without re-sending audio/video
  return parseSrtOrTextTranscript(rawTranscript, videoDuration);
}

/**
 * Evaluates ONLY top pre-filtered transcript excerpts (max 4) via `gemini-4-hydrogen`
 * using structured JSON. Never sends full video files to the LLM.
 */
export async function refineCandidatesWithGemini(
  candidates: CandidateClip[],
  config: ScoringConfig
): Promise<CandidateClip[]> {
  const ai = getAiClient();
  const qualified = candidates.filter((c) => c.score >= config.llmThreshold);
  const pool = (qualified.length > 0 ? qualified : candidates).slice(0, MAX_LLM_CANDIDATES);
  if (pool.length === 0) return [];

  const promptPayload = pool.map((c, idx) => ({
    index: idx,
    startTime: c.startTime,
    endTime: c.endTime,
    heuristicScore: c.score,
    hookType: c.hookType,
    contextStatus: c.contextStatus,
    transcript: c.transcriptExcerpt.slice(0, 900),
  }));

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: `Evaluate these pre-filtered transcript excerpts for short-form social media (TikTok, Reels, Shorts). Return structured evaluations in the same language as the transcript.
Rubric maximums:
- hook: 0-${config.hookWeight}
- infoValue: 0-${config.infoWeight}
- emotion: 0-${config.emotionWeight}
- selfContained: 0-${config.selfContainedWeight}
- durationFit: 0-${config.durationWeight}

Candidates:
${JSON.stringify(promptPayload, null, 2)}`,
    config: {
      systemInstruction:
        'You are a deterministic video editor assistant. Output strictly valid JSON scoring each candidate objectively without inventing timestamps outside the candidate range.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            index: { type: Type.INTEGER },
            title: { type: Type.STRING, description: 'Short punchy clip title (max 8 words)' },
            hookText: { type: Type.STRING, description: 'Opening hook phrase' },
            hook: { type: Type.INTEGER },
            infoValue: { type: Type.INTEGER },
            emotion: { type: Type.INTEGER },
            selfContained: { type: Type.INTEGER },
            durationFit: { type: Type.INTEGER },
            reason: { type: Type.STRING, description: 'Concise reason why this clip works' },
          },
          required: [
            'index',
            'title',
            'hookText',
            'hook',
            'infoValue',
            'emotion',
            'selfContained',
            'durationFit',
            'reason',
          ],
        },
      },
    },
  });

  const evaluated = JSON.parse((response.text ?? '[]').trim()) as Array<{
    index: number;
    title: string;
    hookText: string;
    hook: number;
    infoValue: number;
    emotion: number;
    selfContained: number;
    durationFit: number;
    reason: string;
  }>;

  const evalMap = new Map(evaluated.map((e) => [e.index, e]));

  return pool
    .map((cand, idx) => {
      const ev = evalMap.get(idx);
      if (!ev) return cand;
      const breakdown: ClipScoreBreakdown = {
        hook: Math.min(config.hookWeight, Math.max(0, ev.hook)),
        infoValue: Math.min(config.infoWeight, Math.max(0, ev.infoValue)),
        emotion: Math.min(config.emotionWeight, Math.max(0, ev.emotion)),
        selfContained: Math.min(config.selfContainedWeight, Math.max(0, ev.selfContained)),
        durationFit: Math.min(config.durationWeight, Math.max(0, ev.durationFit)),
      };
      const rawTotal =
        breakdown.hook +
        breakdown.infoValue +
        breakdown.emotion +
        breakdown.selfContained +
        breakdown.durationFit;
      const maxTotal =
        config.hookWeight +
        config.infoWeight +
        config.emotionWeight +
        config.selfContainedWeight +
        config.durationWeight;
      const score =
        maxTotal > 0 ? Math.min(100, Math.round((rawTotal / maxTotal) * 100)) : cand.score;

      return {
        ...cand,
        title: ev.title || cand.title,
        hookText: ev.hookText || cand.hookText,
        score,
        breakdown,
        reason: ev.reason || cand.reason,
      };
    })
    .sort((a, b) => b.score - a.score);
}
