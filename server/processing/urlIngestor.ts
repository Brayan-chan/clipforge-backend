import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { Innertube } from 'youtubei.js';
import type { TranscriptSegment } from '../../src/types';
import { TRANSCRIPTS_DIR, UPLOADS_DIR, ensureStorageDirs } from '../db';
import { parseSrtFileContent } from './clipScorer';
import {
  MAX_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_SIZE_BYTES,
  MAX_VIDEO_SIZE_MB,
  extractYouTubeVideoId,
  formatUploadLimitLabel,
  generateSafeMediaFilename,
  safeUnlink,
} from './validation';
import { analyzeVideo, type VideoMetadata } from './videoAnalyzer';

const execFileAsync = promisify(execFile);

export class UrlIngestionError extends Error {
  statusCode: number;
  detectedTitle?: string;
  youtubeBlocked?: boolean;

  constructor(
    message: string,
    statusCode = 400,
    extra?: { detectedTitle?: string; youtubeBlocked?: boolean }
  ) {
    super(message);
    this.statusCode = statusCode;
    this.detectedTitle = extra?.detectedTitle;
    this.youtubeBlocked = extra?.youtubeBlocked;
  }
}

export async function fetchYouTubeOembed(
  url: string
): Promise<{ title?: string; authorName?: string; thumbnailUrl?: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };
    return {
      title: data.title,
      authorName: data.author_name,
      thumbnailUrl: data.thumbnail_url,
    };
  } catch {
    return null;
  }
}

async function isYtDlpAvailable(): Promise<boolean> {
  try {
    await execFileAsync('yt-dlp', ['--version'], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export interface IngestedYouTubeResult {
  filePath: string;
  filename: string;
  originalName: string;
  title: string;
  sizeBytes: number;
  segments: TranscriptSegment[];
}

export async function ingestYouTubeUrl(url: string): Promise<IngestedYouTubeResult> {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    throw new UrlIngestionError('Invalid YouTube video URL.', 400);
  }

  ensureStorageDirs();
  const oembed = await fetchYouTubeOembed(url);
  const fallbackTitle = oembed?.title || `YouTube (${videoId})`;
  const safeFilename = generateSafeMediaFilename(`youtube-${videoId}.mp4`);
  const outPath = path.join(UPLOADS_DIR, safeFilename);

  // 1. Prefer yt-dlp if installed locally on the host machine
  if (await isYtDlpAvailable()) {
    try {
      const { stdout: jsonOut } = await execFileAsync(
        'yt-dlp',
        ['--dump-single-json', '--no-playlist', '--no-warnings', url],
        { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }
      );
      const info = JSON.parse(jsonOut) as { title?: string; duration?: number };
      if ((info.duration ?? 0) > MAX_VIDEO_DURATION_SECONDS) {
        throw new UrlIngestionError(
          `YouTube video duration exceeds ${Math.round(MAX_VIDEO_DURATION_SECONDS / 60)} min limit.`,
          400
        );
      }

      await execFileAsync(
        'yt-dlp',
        [
          '-f',
          'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best',
          '--merge-output-format',
          'mp4',
          '--no-playlist',
          '--max-filesize',
          `${MAX_VIDEO_SIZE_MB}M`,
          '-o',
          outPath,
          url,
        ],
        { timeout: 180000 }
      );

      // Best-effort auto/manual subtitle download
      let segments: TranscriptSegment[] = [];
      const subBase = path.join(TRANSCRIPTS_DIR, `yt-${videoId}-${Date.now()}`);
      try {
        await execFileAsync(
          'yt-dlp',
          [
            '--skip-download',
            '--write-subs',
            '--write-auto-subs',
            '--sub-format',
            'srt',
            '--sub-langs',
            'es.*,en.*',
            '-o',
            subBase,
            url,
          ],
          { timeout: 20000 }
        );
        const dirFiles = fs.readdirSync(TRANSCRIPTS_DIR);
        const prefix = path.basename(subBase);
        const srtFile = dirFiles.find((f) => f.startsWith(prefix) && f.endsWith('.srt'));
        if (srtFile) {
          const srtPath = path.join(TRANSCRIPTS_DIR, srtFile);
          segments = parseSrtFileContent(fs.readFileSync(srtPath, 'utf-8'));
          safeUnlink(srtPath);
        }
      } catch {
        // subtitles optional; pipeline can fall back to user SRT or Gemini audio
      }

      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        const stat = fs.statSync(outPath);
        return {
          filePath: outPath,
          filename: safeFilename,
          originalName: `${info.title || fallbackTitle}.mp4`,
          title: (info.title || fallbackTitle).slice(0, 120),
          sizeBytes: stat.size,
          segments,
        };
      }
    } catch (err) {
      safeUnlink(outPath);
      if (err instanceof UrlIngestionError) throw err;
    }
  }

  // 2. Pure-JS Innertube attempt (works on residential/non-blocked IPs)
  try {
    const yt = await Innertube.create({ generate_session_locally: true });
    const info = await yt.getInfo(videoId);

    if (!info.streaming_data) {
      throw new Error('LOGIN_REQUIRED: Streaming data blocked by YouTube bot verification');
    }

    const duration = info.basic_info?.duration ?? 0;
    if (duration > MAX_VIDEO_DURATION_SECONDS) {
      throw new UrlIngestionError(
        `YouTube video duration (${duration}s) exceeds limit.`,
        400
      );
    }

    let segments: TranscriptSegment[] = [];
    try {
      const tr = await info.getTranscript();
      const rawSegs = tr?.transcript?.content?.body?.initial_segments ?? [];
      segments = rawSegs
        .map((seg, idx) => {
          const start = Number(seg.start_ms ?? 0) / 1000;
          const end = Math.max(start + 1, Number(seg.end_ms ?? start * 1000 + 3000) / 1000);
          const text = (seg.snippet?.text ?? '').trim();
          return { id: `seg-${idx + 1}`, start, end, text };
        })
        .filter((s) => s.text.length > 0);
    } catch {
      // No captions available
    }

    const webStream = await info.download({
      type: 'video+audio',
      quality: 'best',
      format: 'mp4',
    });

    let totalBytes = 0;
    const nodeStream = Readable.fromWeb(webStream as unknown as import('stream/web').ReadableStream);
    nodeStream.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_VIDEO_SIZE_BYTES) {
        nodeStream.destroy(
          new Error(`YouTube download exceeded ${formatUploadLimitLabel()} limit.`)
        );
      }
    });

    await pipeline(nodeStream, fs.createWriteStream(outPath));
    const stat = fs.statSync(outPath);
    if (stat.size === 0) {
      throw new Error('Downloaded empty stream from YouTube.');
    }

    return {
      filePath: outPath,
      filename: safeFilename,
      originalName: `${info.basic_info?.title || fallbackTitle}.mp4`,
      title: (info.basic_info?.title || fallbackTitle).slice(0, 120),
      sizeBytes: stat.size,
      segments,
    };
  } catch (err) {
    safeUnlink(outPath);
    if (err instanceof UrlIngestionError) throw err;

    const rawMsg = err instanceof Error ? err.message : String(err);
    const isBotOrCipherGate =
      rawMsg.includes('LOGIN_REQUIRED') ||
      rawMsg.includes('not a bot') ||
      rawMsg.includes('Streaming data') ||
      rawMsg.includes('decipher') ||
      rawMsg.includes('JavaScript evaluator') ||
      rawMsg.includes('400');

    if (isBotOrCipherGate) {
      throw new UrlIngestionError(
        `YouTube bloqueó la descarga automática desde el servidor ("${fallbackTitle}"). Sube el archivo de video directamente o usa un enlace directo (.mp4/.webm/R2/S3); en ejecución local puedes instalar yt-dlp.`,
        422,
        {
          detectedTitle: fallbackTitle.slice(0, 120),
          youtubeBlocked: true,
        }
      );
    }

    throw new UrlIngestionError(
      `No se pudo descargar desde YouTube ("${fallbackTitle}"): ${rawMsg.slice(0, 160)}`,
      422,
      {
        detectedTitle: fallbackTitle.slice(0, 120),
        youtubeBlocked: true,
      }
    );
  }
}

export async function probeRemoteDirectUrl(url: string): Promise<{
  meta: VideoMetadata;
  sizeBytes: number;
  originalName: string;
}> {
  let sizeBytes = 0;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const headRes = await fetch(url, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timer);
    const contentType = (headRes.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      throw new UrlIngestionError(
        'The URL points to an HTML webpage instead of a direct video stream (.mp4/.mov/.webm).',
        400
      );
    }
    const len = Number(headRes.headers.get('content-length') || 0);
    if (Number.isFinite(len) && len > 0) {
      sizeBytes = len;
    }
  } catch (err) {
    if (err instanceof UrlIngestionError) throw err;
    // Some CDNs block HEAD; continue with ffprobe directly
  }

  let meta: VideoMetadata;
  try {
    meta = await analyzeVideo(url);
  } catch (err) {
    throw new UrlIngestionError(
      err instanceof Error
        ? `Could not inspect remote video stream: ${err.message}`
        : 'Remote URL does not contain a readable video stream.',
      400
    );
  }

  let originalName = 'remote-video.mp4';
  try {
    const parsed = new URL(url);
    const base = path.basename(parsed.pathname);
    if (base && base.includes('.')) {
      originalName = base.slice(0, 120);
    }
  } catch {
    // fallback name
  }

  return { meta, sizeBytes, originalName };
}
