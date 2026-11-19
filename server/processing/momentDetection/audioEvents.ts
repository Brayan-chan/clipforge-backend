import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface AudioEventAnalysis {
  energyPeaks: number[];
  silenceEnds: number[];
  available: boolean;
}

/**
 * Performs a cheap, local audio pass. RMS is sampled twice per second at 8 kHz;
 * peaks are relative to the video's own loudness, so quiet podcasts and loud
 * streams are evaluated on the same scale.
 */
export async function analyzeAudioEvents(
  videoPath: string,
  duration: number
): Promise<AudioEventAnalysis> {
  if (!Number.isFinite(duration) || duration <= 0) {
    return { energyPeaks: [], silenceEnds: [], available: false };
  }

  try {
    const filter = [
      'aresample=8000',
      'asetnsamples=n=4000:p=1',
      'astats=metadata=1:reset=1',
      'ametadata=print:key=lavfi.astats.Overall.RMS_level',
      'silencedetect=noise=-36dB:d=0.32',
    ].join(',');
    const { stdout, stderr } = await execFileAsync(
      'ffmpeg',
      ['-hide_banner', '-nostats', '-i', videoPath, '-vn', '-af', filter, '-f', 'null', '-'],
      { timeout: Math.max(90000, Math.min(600000, Math.round(duration * 380))) }
    );
    const output = `${stdout}\n${stderr}`;
    const samples: Array<{ time: number; rms: number }> = [];
    let currentTime: number | null = null;
    for (const line of output.split(/\r?\n/)) {
      const timeMatch = line.match(/pts_time:([\d.]+)/);
      if (timeMatch) currentTime = Number(timeMatch[1]);
      const rmsMatch = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+)/);
      if (rmsMatch && currentTime !== null) {
        const rms = Number(rmsMatch[1]);
        if (Number.isFinite(rms)) samples.push({ time: currentTime, rms });
      }
    }

    const finite = samples.map((s) => s.rms).filter(Number.isFinite).sort((a, b) => a - b);
    const median = finite.length ? finite[Math.floor(finite.length * 0.5)] : -30;
    const upper = finite.length ? finite[Math.floor(finite.length * 0.85)] : median + 5;
    const threshold = Math.max(median + 5.5, upper);
    const rawPeaks = samples.filter((sample) => sample.rms >= threshold);
    const energyPeaks: number[] = [];
    for (const peak of rawPeaks) {
      const previous = energyPeaks[energyPeaks.length - 1];
      if (previous === undefined || peak.time - previous >= 2.25) energyPeaks.push(peak.time);
    }

    const silenceEnds = [...output.matchAll(/silence_end:\s*([\d.]+)/g)]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite);

    return { energyPeaks, silenceEnds, available: samples.length > 0 };
  } catch {
    return { energyPeaks: [], silenceEnds: [], available: false };
  }
}

