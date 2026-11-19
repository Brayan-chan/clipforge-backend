import type {
  ClipScoreBreakdown,
  ContextStatus,
  ScoringConfig,
  TranscriptSegment,
} from '../../src/types';
import { DEFAULT_SCORING_CONFIG } from '../db';

export interface CandidateClip {
  title: string;
  hookText: string;
  hookType: string;
  contextStatus: ContextStatus;
  sceneChanges: number;
  startTime: number;
  endTime: number;
  score: number;
  breakdown: ClipScoreBreakdown;
  reason: string;
  transcriptExcerpt: string;
}

const HOOK_ARCHETYPES: Array<{ label: string; patterns: RegExp[]; bonus: number }> = [
  {
    label: 'Curiosity Gap',
    patterns: [
      /\b(nadie te (dice|explica)|esta es la razón|el secreto|lo que nadie|la verdad sobre|mucha gente piensa)\b/i,
      /\b(nobody tells you|here is why|the secret|what nobody|the truth about|most people think)\b/i,
    ],
    bonus: 0.35,
  },
  {
    label: 'Mistake / Lesson',
    patterns: [
      /\b(cometí un error|el error que|cuidado con|fracasan|perdí|me costó)\b/i,
      /\b(i made a mistake|biggest mistake|stop doing|cost me|why .* fail)\b/i,
    ],
    bonus: 0.35,
  },
  {
    label: 'Contrarian Claim',
    patterns: [
      /\b(no necesitas|olvídate de|mentira|realmente el \d+|en realidad)\b/i,
      /\b(you don't need|forget about|actually|stop believing)\b/i,
    ],
    bonus: 0.3,
  },
  {
    label: 'Direct Question',
    patterns: [/\?/, /\b(por qué|cómo|qué pasa si|alguna vez)\b/i, /\b(why|how|what if)\b/i],
    bonus: 0.25,
  },
  {
    label: 'Actionable Framework',
    patterns: [
      /\b(paso uno|paso \d+|primero|regla|la clave|estrategia)\b/i,
      /\b(step one|step \d+|\d+ steps|framework|rule of thumb)\b/i,
    ],
    bonus: 0.25,
  },
];

const INFO_PATTERNS = [
  /\b(paso|arquitectura|sistema|costo|presupuesto|ffmpeg|modelo|pipeline|algoritmo|regla|datos|ejemplo|estructura|ahorrar|gratis|velocidad|token|rúbrica)\b/i,
  /\b(step|architecture|system|cost|budget|model|pipeline|algorithm|rule|data|example|framework|save|free|fast|because|token|rubric)\b/i,
  /\b(primero|segundo|tercero|entonces|por eso|la clave|significa)\b/i,
];

const EMOTION_PATTERNS = [
  /\b(fracasan|fracaso|imposible|peligroso|increíble|brutal|caro|cero|nunca|siempre|controver|debate|fuerte|sorprendente|error)\b/i,
  /\b(fail|failure|impossible|dangerous|incredible|expensive|zero|never|always|controvers|debate|crazy|huge|mistake)\b/i,
  /!/,
];

const DANGLING_STARTS =
  /^(y |pero |o |sin embargo |además |entonces |también |así que |por eso |pues |and |but |so |then |also |therefore |however )/i;

const DANGLING_PRONOUNS =
  /^(esto |eso |aquello |él |ella |ellos |it |that |this |they |he |she )\b/i;

const SRT_TIME_REGEX =
  /(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{3})/;

function parseSrtTimestampMatch(match: RegExpMatchArray): { start: number; end: number } {
  const startH = match[1] ? parseInt(match[1], 10) : 0;
  const startM = parseInt(match[2], 10);
  const startS = parseInt(match[3], 10);
  const startMs = parseInt(match[4], 10);
  const endH = match[5] ? parseInt(match[5], 10) : 0;
  const endM = parseInt(match[6], 10);
  const endS = parseInt(match[7], 10);
  const endMs = parseInt(match[8], 10);
  const start = startH * 3600 + startM * 60 + startS + startMs / 1000;
  const end = endH * 3600 + endM * 60 + endS + endMs / 1000;
  return {
    start: Math.round(start * 100) / 100,
    end: Math.round(Math.max(start + 0.5, end) * 100) / 100,
  };
}

export function parseSrtFileContent(rawText: string): TranscriptSegment[] {
  const cleaned = rawText.replace(/^\uFEFF/, '').trim();
  if (!cleaned) return [];

  const lines = cleaned.split(/\r?\n/);
  const parsed: TranscriptSegment[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const match = line.match(SRT_TIME_REGEX);
    if (!match) {
      i++;
      continue;
    }

    const { start, end } = parseSrtTimestampMatch(match);
    const textLines: string[] = [];
    let j = i + 1;

    while (j < lines.length) {
      const nextLine = lines[j].trim();
      if (!nextLine) {
        j++;
        break;
      }
      if (SRT_TIME_REGEX.test(nextLine)) {
        break;
      }
      // If a purely numeric cue index immediately precedes a timestamp line, stop before it
      if (
        /^\d+$/.test(nextLine) &&
        j + 1 < lines.length &&
        SRT_TIME_REGEX.test(lines[j + 1].trim())
      ) {
        break;
      }
      textLines.push(nextLine);
      j++;
    }

    const text = textLines
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (text) {
      parsed.push({
        id: `seg-${parsed.length + 1}`,
        start,
        end,
        text,
      });
    }

    i = j;
  }

  return parsed;
}

export function parseSrtOrTextTranscript(
  rawText: string,
  videoDuration: number
): TranscriptSegment[] {
  const trimmed = rawText.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return [];

  const parsedSrt = parseSrtFileContent(trimmed);
  if (parsedSrt.length > 0) return parsedSrt;

  const lineSegments: TranscriptSegment[] = [];
  const simpleLines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const simpleTimeRegex = /^\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\]?\s*[-–:]?\s*(.+)$/;
  for (const line of simpleLines) {
    const m = line.match(simpleTimeRegex);
    if (m) {
      const p1 = parseInt(m[1], 10);
      const p2 = parseInt(m[2], 10);
      const p3 = m[3] ? parseInt(m[3], 10) : null;
      const start = p3 !== null ? p1 * 3600 + p2 * 60 + p3 : p1 * 60 + p2;
      lineSegments.push({
        id: `seg-${lineSegments.length + 1}`,
        start,
        end: start + 5,
        text: m[4].trim(),
      });
    }
  }
  if (lineSegments.length > 0) {
    for (let i = 0; i < lineSegments.length; i++) {
      if (i < lineSegments.length - 1) {
        lineSegments[i].end = Math.max(lineSegments[i].start + 1.5, lineSegments[i + 1].start);
      } else {
        lineSegments[i].end = Math.max(
          lineSegments[i].start + 4,
          videoDuration || lineSegments[i].start + 6
        );
      }
    }
    return lineSegments;
  }

  const sentences = trimmed
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length === 0) return [];
  const totalWords = sentences.reduce((acc, s) => acc + s.split(/\s+/).length, 0) || 1;
  const effectiveDuration = Math.max(videoDuration, sentences.length * 4);
  let cursor = 0;
  return sentences.map((sentence, idx) => {
    const words = sentence.split(/\s+/).length;
    const slice = Math.max(2.5, (words / totalWords) * effectiveDuration);
    const start = Math.round(cursor * 100) / 100;
    const end =
      idx === sentences.length - 1
        ? Math.round(effectiveDuration * 100) / 100
        : Math.round(Math.min(effectiveDuration, cursor + slice) * 100) / 100;
    cursor = end;
    return {
      id: `seg-${idx + 1}`,
      start,
      end,
      text: sentence,
    };
  });
}

export function scoreWindow(
  windowSegs: TranscriptSegment[],
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
  sceneTimestamps: number[] = []
): {
  score: number;
  breakdown: ClipScoreBreakdown;
  reason: string;
  title: string;
  hookText: string;
  hookType: string;
  contextStatus: ContextStatus;
  sceneChanges: number;
} {
  const firstText = (windowSegs[0]?.text ?? '').trim();
  const lastText = (windowSegs[windowSegs.length - 1]?.text ?? '').trim();
  const fullText = windowSegs.map((s) => s.text).join(' ');
  const startTime = windowSegs[0]?.start ?? 0;
  const endTime = windowSegs[windowSegs.length - 1]?.end ?? 0;
  const duration = Math.max(1, endTime - startTime);

  // 1. Enhanced Hook Detection (0..hookWeight)
  let hookScoreRatio = 0.25;
  let hookType = 'Standard Opener';
  for (const archetype of HOOK_ARCHETYPES) {
    if (archetype.patterns.some((rx) => rx.test(firstText))) {
      hookScoreRatio += archetype.bonus;
      if (hookType === 'Standard Opener') {
        hookType = archetype.label;
      }
    }
  }
  if (/\b\d+\b/.test(firstText)) hookScoreRatio += 0.15;
  if (firstText.length >= 26 && firstText.length <= 125) hookScoreRatio += 0.15;
  hookScoreRatio = Math.min(1, hookScoreRatio);
  const hook = Math.round(hookScoreRatio * config.hookWeight);

  // 2. Informational Value (0..infoWeight)
  let infoHits = 0;
  for (const rx of INFO_PATTERNS) {
    if (rx.test(fullText)) infoHits += 1;
  }
  const wordCount = fullText.split(/\s+/).filter(Boolean).length;
  const densityBonus = wordCount >= 24 ? 0.28 : 0.12;
  const infoRatio = Math.min(1, 0.25 + infoHits * 0.22 + densityBonus);
  const infoValue = Math.round(infoRatio * config.infoWeight);

  // 3. Emotion / Controversy (0..emotionWeight)
  let emotionHits = 0;
  for (const rx of EMOTION_PATTERNS) {
    if (rx.test(fullText)) emotionHits += 1;
  }
  const emotionRatio = Math.min(1, 0.2 + emotionHits * 0.3);
  const emotion = Math.round(emotionRatio * config.emotionWeight);

  // 4. Context Independence Check (0..selfContainedWeight)
  let selfRatio = 0.85;
  if (DANGLING_STARTS.test(firstText)) selfRatio -= 0.42;
  if (DANGLING_PRONOUNS.test(firstText)) selfRatio -= 0.28;
  if (/[.!?]$/.test(lastText)) selfRatio += 0.15;
  selfRatio = Math.max(0.15, Math.min(1, selfRatio));
  const selfContained = Math.round(selfRatio * config.selfContainedWeight);

  const contextStatus: ContextStatus =
    selfRatio >= 0.72
      ? 'self-contained'
      : selfRatio >= 0.48
      ? 'partial'
      : 'needs-context';

  // 5. Duration Fit (0..durationWeight)
  let durationRatio = 0.5;
  if (duration >= 14 && duration <= 30) durationRatio = 1.0;
  else if (duration >= config.minClipSeconds && duration <= config.maxClipSeconds)
    durationRatio = 0.78;
  else if (duration >= 8) durationRatio = 0.55;
  const durationFit = Math.round(durationRatio * config.durationWeight);

  // Count visual scene changes in range
  const sceneChanges = sceneTimestamps.filter((t) => t >= startTime && t <= endTime).length;

  const rawTotal = hook + infoValue + emotion + selfContained + durationFit;
  const maxPossible =
    config.hookWeight +
    config.infoWeight +
    config.emotionWeight +
    config.selfContainedWeight +
    config.durationWeight;
  const normalizedScore =
    maxPossible > 0 ? Math.min(100, Math.round((rawTotal / maxPossible) * 100)) : 0;

  const reasons: string[] = [];
  if (hookType !== 'Standard Opener') reasons.push(`${hookType} opening`);
  if (infoValue >= config.infoWeight * 0.7) reasons.push('High informational density');
  if (emotion >= config.emotionWeight * 0.65) reasons.push('Strong emotional contrast');
  if (contextStatus === 'self-contained') reasons.push('Self-contained context');
  else if (contextStatus === 'needs-context') reasons.push('Starts mid-thought (may need trimming)');
  if (sceneChanges > 0) reasons.push(`${sceneChanges} visual scene cuts`);
  if (reasons.length === 0) reasons.push('Structured spoken segment');

  const words = firstText.replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);
  const shortTitle = words.slice(0, 7).join(' ') + (words.length > 7 ? '...' : '');

  return {
    score: normalizedScore,
    breakdown: { hook, infoValue, emotion, selfContained, durationFit },
    reason: reasons.join(' · '),
    title: shortTitle || 'Highlight Clip',
    hookText: firstText.slice(0, 120),
    hookType,
    contextStatus,
    sceneChanges,
  };
}

export function detectCandidateClipsHeuristic(
  segments: TranscriptSegment[],
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
  sceneTimestamps: number[] = []
): CandidateClip[] {
  if (segments.length === 0) return [];

  const totalDur =
    (segments[segments.length - 1]?.end ?? 0) - (segments[0]?.start ?? 0);
  const candidates: CandidateClip[] = [];
  const minDur = Math.max(6, Math.min(config.minClipSeconds, Math.floor(totalDur * 0.45)));
  const maxDur =
    totalDur > config.minClipSeconds * 1.8
      ? Math.min(config.maxClipSeconds, Math.max(minDur + 4, Math.round(totalDur * 0.52)))
      : Math.max(minDur + 5, config.maxClipSeconds);

  for (let i = 0; i < segments.length; i++) {
    const startSeg = segments[i];
    const windowSegs: TranscriptSegment[] = [startSeg];
    for (let j = i + 1; j < segments.length; j++) {
      const nextSeg = segments[j];
      const projectedDur = nextSeg.end - startSeg.start;
      if (projectedDur > maxDur) break;
      windowSegs.push(nextSeg);
      const currentDur = nextSeg.end - startSeg.start;
      if (currentDur >= minDur) {
        const evalResult = scoreWindow(windowSegs, config, sceneTimestamps);
        candidates.push({
          title: evalResult.title,
          hookText: evalResult.hookText,
          hookType: evalResult.hookType,
          contextStatus: evalResult.contextStatus,
          sceneChanges: evalResult.sceneChanges,
          startTime: Math.round(startSeg.start * 100) / 100,
          endTime: Math.round(nextSeg.end * 100) / 100,
          score: evalResult.score,
          breakdown: evalResult.breakdown,
          reason: evalResult.reason,
          transcriptExcerpt: windowSegs.map((s) => s.text).join(' '),
        });
      }
    }
  }

  if (candidates.length === 0 && segments.length > 0) {
    const evalResult = scoreWindow(segments, config, sceneTimestamps);
    candidates.push({
      title: evalResult.title,
      hookText: evalResult.hookText,
      hookType: evalResult.hookType,
      contextStatus: evalResult.contextStatus,
      sceneChanges: evalResult.sceneChanges,
      startTime: Math.round(segments[0].start * 100) / 100,
      endTime: Math.round(segments[segments.length - 1].end * 100) / 100,
      score: evalResult.score,
      breakdown: evalResult.breakdown,
      reason: evalResult.reason,
      transcriptExcerpt: segments.map((s) => s.text).join(' '),
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const selected: CandidateClip[] = [];
  for (const cand of candidates) {
    const overlaps = selected.some((existing) => {
      const overlapStart = Math.max(existing.startTime, cand.startTime);
      const overlapEnd = Math.min(existing.endTime, cand.endTime);
      if (overlapEnd <= overlapStart) return false;
      const overlapDur = overlapEnd - overlapStart;
      const candDur = Math.max(1, cand.endTime - cand.startTime);
      return overlapDur / candDur > 0.45;
    });
    if (!overlaps) {
      selected.push(cand);
    }
    if (selected.length >= 6) break;
  }

  return selected;
}
