import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { TranscriptSegment } from '../../src/types';
import { UPLOADS_DIR, ensureStorageDirs } from '../db';

const execFileAsync = promisify(execFile);

export const SAMPLE_PODCAST_SEGMENTS: TranscriptSegment[] = [
  {
    id: 'seg-1',
    start: 0,
    end: 5.5,
    text: 'Mucha gente piensa que lanzar un SaaS de clipping de video requiere cinco agentes de IA conversando.',
  },
  {
    id: 'seg-2',
    start: 5.5,
    end: 11.5,
    text: 'Pero realmente el 80 por ciento del problema se resuelve con procesamiento tradicional y FFmpeg.',
  },
  {
    id: 'seg-3',
    start: 11.5,
    end: 17.5,
    text: 'Por qué fracasan los prototipos caros? Porque queman tokens antes de filtrar los mejores momentos.',
  },
  {
    id: 'seg-4',
    start: 17.5,
    end: 23.5,
    text: 'La arquitectura ganadora usa una rúbrica determinista de 100 puntos antes de llamar al modelo.',
  },
  {
    id: 'seg-5',
    start: 23.5,
    end: 30.0,
    text: 'Paso uno: extraer audio ligero y transcribir con marcas de tiempo exactas para cada frase.',
  },
  {
    id: 'seg-6',
    start: 30.0,
    end: 36.0,
    text: 'Paso dos: FFmpeg recorta a formato vertical 9:16, quema subtítulos y exporta tu clip listo!',
  },
];

export async function generateDemoPodcastVideo(): Promise<{
  filePath: string;
  filename: string;
  sizeBytes: number;
}> {
  ensureStorageDirs();
  const filename = `demo-podcast-${Date.now()}.mp4`;
  const outPath = path.join(UPLOADS_DIR, filename);

  // Build a real 36-second 1280x720 30fps studio podcast video with FFmpeg:
  // Visual: Deep slate studio background with animated subtle color gradient + audio waveform bars + speaker framing
  // Audio: Clean pleasant ambient chord pulse (non-harsh low-volume sine harmonic) so hasAudio=true and audio extraction works
  const vf = [
    `drawbox=x=0:y=0:w=1280:h=720:color=#0B0F17:t=fill`,
    // Left podcast guest frame
    `drawbox=x=90:y=110:w=520:h=460:color=#161E2E:t=fill`,
    `drawbox=x=90:y=110:w=520:h=460:color=#22C55E@0.35:t=3`,
    // Right host frame
    `drawbox=x=670:y=110:w=520:h=460:color=#151B28:t=fill`,
    `drawbox=x=670:y=110:w=520:h=460:color=#38BDF8@0.30:t=3`,
    // Minimalist geometric speaker silhouettes + mic icons
    `drawbox=x=290:y=210:w=120:h=120:color=#22C55E@0.22:t=fill`,
    `drawbox=x=245:y=350:w=210:h=170:color=#263248:t=fill`,
    `drawbox=x=870:y=210:w=120:h=120:color=#38BDF8@0.22:t=fill`,
    `drawbox=x=825:y=350:w=210:h=170:color=#263248:t=fill`,
    // Labels and live timecode badge via drawtext
    `drawtext=text='CLIPFORGE STUDIO PODCAST · EP. 04':x=90:y=56:fontsize=24:fontcolor=#E2E8F0`,
    `drawtext=text='HOST · BRAYAN':x=118:y=530:fontsize=18:fontcolor=#94A3B8`,
    `drawtext=text='GUEST · ARCHITECTURE LAB':x=698:y=530:fontsize=18:fontcolor=#94A3B8`,
    `drawtext=text='00\\:%{eif\\:t\\:d\\:2}':x=1110:y=56:fontsize=22:fontcolor=#22C55E`,
    // Moving studio progress bar at bottom
    `drawbox=x=90:y=632:w=1100:h=6:color=#1E293B:t=fill`,
    `drawbox=x=90:y=632:w='min(1100,1100*t/36)':h=6:color=#22C55E:t=fill`,
  ].join(',');

  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=#0B0F17:s=1280x720:r=20:d=36',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:sample_rate=44100:duration=36',
    '-vf',
    vf,
    '-af',
    'volume=0.06,atempo=1.0',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '26',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-shortest',
    outPath,
  ]);

  const stat = fs.statSync(outPath);
  return {
    filePath: outPath,
    filename,
    sizeBytes: stat.size,
  };
}
