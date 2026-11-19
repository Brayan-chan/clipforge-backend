import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { TRANSCRIPTS_DIR, ensureStorageDirs } from '../db';

const execFileAsync = promisify(execFile);

export async function extractMonoAudio(
  videoPath: string,
  videoId: number
): Promise<string> {
  ensureStorageDirs();
  const audioPath = path.join(TRANSCRIPTS_DIR, `video-${videoId}-audio.mp3`);
  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    videoPath,
    '-vn',
    '-acodec',
    'libmp3lame',
    '-ab',
    '48k',
    '-ar',
    '16000',
    '-ac',
    '1',
    audioPath,
  ]);
  return audioPath;
}
