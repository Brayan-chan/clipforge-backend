import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { THUMBNAILS_DIR, ensureStorageDirs } from '../db';
import { MAX_VIDEO_DURATION_SECONDS } from './validation';
import {
  isObjectStorageConfigured,
  uploadFileToObjectStorage,
} from './objectStorage';

const execFileAsync = promisify(execFile);

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  codec: string;
}

export async function checkFfmpegBinaries(): Promise<{
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
}> {
  let ffmpegAvailable = false;
  let ffprobeAvailable = false;
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
  try {
    await execFileAsync('ffprobe', ['-version'], { timeout: 5000 });
    ffprobeAvailable = true;
  } catch {
    ffprobeAvailable = false;
  }
  return { ffmpegAvailable, ffprobeAvailable };
}

export async function analyzeVideo(filePath: string): Promise<VideoMetadata> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ],
    { timeout: filePath.startsWith('http') ? 30000 : 15000 }
  );

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }>;
  };

  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  if (!videoStream || !videoStream.width || !videoStream.height) {
    throw new Error('File does not contain a valid video stream.');
  }

  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');

  let fps = 30;
  if (videoStream.r_frame_rate) {
    const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
    if (num && den && den > 0) {
      fps = Math.round((num / den) * 100) / 100;
    }
  }

  const duration = Number(parsed.format?.duration ?? 0) || 0;
  if (duration <= 0.5) {
    throw new Error('Video duration is invalid or too short (< 0.5s).');
  }
  if (duration > MAX_VIDEO_DURATION_SECONDS) {
    throw new Error(
      `Video duration (${Math.round(duration)}s) exceeds the 60-minute prototype limit.`
    );
  }

  return {
    duration: Math.round(duration * 100) / 100,
    width: videoStream.width,
    height: videoStream.height,
    fps,
    hasAudio: Boolean(audioStream),
    codec: videoStream.codec_name ?? 'h264',
  };
}

/**
 * Lightweight FFmpeg visual scene-change detector for Stage 3 foundation.
 * Returns timestamps (in seconds) of visual scene cuts/action changes.
 */
export async function detectSceneChanges(
  videoPath: string,
  durationSeconds: number
): Promise<number[]> {
  if (videoPath.startsWith('http') || durationSeconds > 600) {
    // Skip full-frame decode on remote streams or very long videos
    return [];
  }
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-i',
        videoPath,
        '-vf',
        "scale=320:-2,select='gt(scene,0.28)',showinfo",
        '-f',
        'null',
        '-',
      ],
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }
    );

    const timestamps: number[] = [];
    const rx = /pts_time:(\d+(?:\.\d+)?)/g;
    let match: RegExpExecArray | null;
    while ((match = rx.exec(stderr)) !== null) {
      const t = Number(match[1]);
      if (Number.isFinite(t)) {
        timestamps.push(Math.round(t * 100) / 100);
      }
    }
    return timestamps;
  } catch {
    return [];
  }
}

export async function generateThumbnail(
  videoPath: string,
  outputFilename: string,
  timestampSeconds: number
): Promise<string | null> {
  ensureStorageDirs();
  const safeName = path.basename(outputFilename);
  const outPath = path.join(THUMBNAILS_DIR, safeName);
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-ss',
        Math.max(0, timestampSeconds).toFixed(2),
        '-i',
        videoPath,
        '-vframes',
        '1',
        '-vf',
        'scale=640:-2',
        '-q:v',
        '3',
        outPath,
      ],
      { timeout: videoPath.startsWith('http') ? 25000 : 15000 }
    );
    if (isObjectStorageConfigured()) {
      const storedUrl = await uploadFileToObjectStorage({
        filePath: outPath,
        key: `thumbnails/${safeName}`,
        contentType: 'image/jpeg',
      });
      fs.unlinkSync(outPath);
      return storedUrl;
    }
    return `/storage/thumbnails/${safeName}`;
  } catch {
    return null;
  }
}
