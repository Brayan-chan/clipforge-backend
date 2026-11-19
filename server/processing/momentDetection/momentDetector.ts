import type { ScoringConfig, TranscriptSegment } from '../../../src/types';
import type { CandidateClip } from '../clipScorer';
import type { AudioEventAnalysis } from './audioEvents';

const REACTION = /\b(guau|wow|uf+|uoh|no me lo puedo creer|madre m[ií]a|dios|brutal|incre[ií]ble|locura|qu[eé] guapo|por dios|ojito|atentos|jaj+a|ja ja|risas|se cay[oó]|what|oh my god|holy|crazy|amazing|laugh)/i;
const REVEAL = /\b(3\s*2\s*1|ah[ií] est[aá]|mirad esto|fijaos|atentos|empieza|vamos a ver|resultado|por fin|en persona|revel|unbox|descubr|look at this|here it is|watch this|finally)/i;
const SETUP = /\b(voy a|vamos a|intentar|a ver si|qu[eé] pasa si|tengo miedo|el problema|la cosa es|espera|antes de|let'?s|i'?m going to|what if|wait)/i;
const RESOLUTION = /\b(y ya est[aá]|al final|as[ií] que|esa es|por eso|en resumen|total|listo|terminar|conclusi[oó]n|there you go|in the end|that'?s why|done)/i;
const LAUGHTER_OR_SFX = /\[(risas?|m[uú]sica|aplausos?|gritos?)\]/i;
const FILLER_ONLY = /^(eh+|hm+|bueno|vale|a ver|pues|o sea|y+|no+|s[ií]+|okay|well)[\s,.!?-]*$/i;
const BAD_START = /^(y|pero|porque|aunque|entonces|adem[aá]s|tambi[eé]n|as[ií] que|por eso|pues|esto|eso|[ée]l|ella|ellos|media|and|but|because|so|then|also|this|that|it)\b/i;
const TRANSCRIPT_FRAGMENT_START = /^(aqu[ií] esto|por aqu[ií]|de y|y y|eh[, ]|hm[, ]|media[, ])/i;
const BAD_END = /\b(y|o|pero|porque|aunque|que|para|de|del|con|sin|si|cuando|como|and|or|but|because|that|to|with|if)$/i;

interface EventSeed {
  index: number;
  strength: number;
  kinds: string[];
}

function near(values: number[], time: number, radius: number): boolean {
  return values.some((value) => Math.abs(value - time) <= radius);
}

function sentenceLooksClosed(text: string): boolean {
  const clean = text.trim();
  return /[.!?\]”"]$/.test(clean) && !BAD_END.test(clean.replace(/[.!?\]”"]+$/, '').trim());
}

/** Snaps model/detector ranges to caption boundaries and avoids cutting an open sentence. */
export function closeCandidateBoundaries(
  candidates: CandidateClip[],
  segments: TranscriptSegment[],
  videoDuration: number,
  maxExtensionSeconds = 10
): CandidateClip[] {
  if (segments.length === 0) return candidates;
  return candidates.map((candidate) => {
    const originalEnd = candidate.endTime;
    let index = segments.findIndex(
      (segment) => segment.start <= originalEnd && segment.end >= originalEnd
    );
    if (index < 0) {
      for (let candidateIndex = segments.length - 1; candidateIndex >= 0; candidateIndex--) {
        if (segments[candidateIndex].end <= originalEnd + 0.8) {
          index = candidateIndex;
          break;
        }
      }
    }
    if (index < 0) return candidate;

    let end = Math.max(originalEnd, segments[index].end + 0.35);
    while (
      index < segments.length - 1 &&
      !sentenceLooksClosed(segments[index].text) &&
      segments[index + 1].end <= originalEnd + maxExtensionSeconds
    ) {
      index++;
      end = segments[index].end + 0.35;
    }
    return {
      ...candidate,
      endTime: Math.round(Math.min(videoDuration, end) * 100) / 100,
      transcriptExcerpt: segments
        .filter((segment) => segment.end > candidate.startTime && segment.start < end)
        .map((segment) => segment.text)
        .join(' '),
    };
  });
}

function buildSeeds(
  segments: TranscriptSegment[],
  audio: AudioEventAnalysis,
  sceneTimestamps: number[]
): EventSeed[] {
  const seeds: EventSeed[] = [];
  segments.forEach((segment, index) => {
    const kinds: string[] = [];
    let strength = 0;
    if (REACTION.test(segment.text)) { strength += 3; kinds.push('reaction'); }
    if (REVEAL.test(segment.text)) { strength += 3; kinds.push('reveal'); }
    if (SETUP.test(segment.text)) { strength += 1.2; kinds.push('setup'); }
    if (RESOLUTION.test(segment.text)) { strength += 1.2; kinds.push('resolution'); }
    if (LAUGHTER_OR_SFX.test(segment.text)) { strength += 2.2; kinds.push('audio cue'); }
    const mid = (segment.start + segment.end) / 2;
    if (near(audio.energyPeaks, mid, 2.5)) { strength += 2; kinds.push('energy peak'); }
    if (near(sceneTimestamps, mid, 1.6)) { strength += 0.8; kinds.push('visual change'); }
    if (strength >= 2.2) seeds.push({ index, strength, kinds });
  });
  return seeds;
}

function refineBoundaries(
  segments: TranscriptSegment[],
  seed: EventSeed,
  audio: AudioEventAnalysis,
  config: ScoringConfig
): TranscriptSegment[] {
  const anchor = segments[seed.index];
  let start = seed.index;
  let end = seed.index;
  const maxBefore = Math.min(14, Math.max(7, config.minClipSeconds * 0.65));
  const maxAfter = Math.min(34, Math.max(18, config.maxClipSeconds * 0.65));

  // Recover setup/context, stopping at a meaningful pause or completed prior thought.
  while (start > 0 && anchor.start - segments[start - 1].start <= maxBefore) {
    const previous = segments[start - 1];
    const gap = segments[start].start - previous.end;
    if (gap > 1.15 && sentenceLooksClosed(previous.text)) break;
    start--;
    if (SETUP.test(previous.text) && !BAD_START.test(previous.text.trim())) break;
  }
  while (
    start < seed.index &&
    (BAD_START.test(segments[start].text.trim()) ||
      TRANSCRIPT_FRAGMENT_START.test(segments[start].text.trim()) ||
      FILLER_ONLY.test(segments[start].text.trim()))
  ) start++;

  // Keep the reaction and consequence; never stop solely because min duration was reached.
  while (end < segments.length - 1 && segments[end + 1].end - anchor.start <= maxAfter) {
    const current = segments[end];
    const next = segments[end + 1];
    const gap = next.start - current.end;
    const reachedUsefulLength = current.end - segments[start].start >= Math.max(10, config.minClipSeconds);
    const naturalPause = gap >= 0.65 || near(audio.silenceEnds, current.end, 0.45);
    if (reachedUsefulLength && sentenceLooksClosed(current.text) && naturalPause) break;
    end++;
    if (reachedUsefulLength && RESOLUTION.test(next.text) && sentenceLooksClosed(next.text)) break;
  }

  // If a cue is split by caption timing, extend until its grammatical closure.
  while (
    end < segments.length - 1 &&
    !sentenceLooksClosed(segments[end].text) &&
    segments[end + 1].end - segments[start].start <= config.maxClipSeconds
  ) end++;

  return segments.slice(start, end + 1);
}

function evaluateEvent(
  window: TranscriptSegment[],
  seed: EventSeed,
  audio: AudioEventAnalysis,
  sceneTimestamps: number[],
  config: ScoringConfig
): CandidateClip | null {
  const first = window[0].text.trim();
  const last = window[window.length - 1].text.trim();
  const text = window.map((segment) => segment.text).join(' ').replace(/\s+/g, ' ').trim();
  const startTime = window[0].start;
  const endTime = window[window.length - 1].end;
  const duration = endTime - startTime;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const hasReaction = REACTION.test(text) || LAUGHTER_OR_SFX.test(text);
  const hasReveal = REVEAL.test(text);
  const hasSetup = SETUP.test(text.slice(0, Math.ceil(text.length * 0.55)));
  const hasResolution = RESOLUTION.test(text) || sentenceLooksClosed(last);
  const energyCount = audio.energyPeaks.filter((time) => time >= startTime && time <= endTime).length;
  const sceneChanges = sceneTimestamps.filter((time) => time >= startTime && time <= endTime).length;
  const startsBadly = BAD_START.test(first) || TRANSCRIPT_FRAGMENT_START.test(first) || FILLER_ONLY.test(first);
  const endsBadly = BAD_END.test(last.replace(/[,.!?]+$/, '').trim()) || !hasResolution;

  // Hard validity gates: invalid boundaries and eventless chatter are not rankable clips.
  if (duration < 8 || duration > config.maxClipSeconds + 5) return null;
  if (wordCount < 16) return null;
  if (startsBadly && !hasSetup) return null;
  if (endsBadly) return null;
  if (!hasReaction && !hasReveal && energyCount === 0) return null;

  const eventInterest = Math.min(30, (hasReveal ? 13 : 0) + (hasReaction ? 11 : 0) + Math.min(6, seed.strength));
  const reaction = Math.min(20, (hasReaction ? 11 : 0) + Math.min(7, energyCount * 3.5) + (LAUGHTER_OR_SFX.test(text) ? 2 : 0));
  const narrative = Math.min(20, (hasSetup ? 7 : 2) + (hasReveal ? 6 : 2) + (hasResolution ? 7 : 0));
  const context = Math.max(0, Math.min(15, 13 - (startsBadly ? 7 : 0) - (endsBadly ? 7 : 0)));
  const hook = Math.min(10, (REACTION.test(first) || REVEAL.test(first) ? 7 : 3) + (/[?!]/.test(first) ? 2 : 0));
  const pace = Math.min(5, (duration <= 38 ? 3 : 1) + (sceneChanges > 0 ? 1 : 0) + (energyCount > 0 ? 1 : 0));
  const score = Math.round(eventInterest + reaction + narrative + context + hook + pace);
  if (score < Math.max(58, config.llmThreshold)) return null;

  const headline = window.find((segment) => REVEAL.test(segment.text) || REACTION.test(segment.text))?.text ?? first;
  const titleWords = headline.replace(/\[[^\]]+\]/g, '').replace(/[^\p{L}\p{N}\s¿?¡!]/gu, '').split(/\s+/).filter(Boolean);
  const title = `${titleWords.slice(0, 9).join(' ')}${titleWords.length > 9 ? '…' : ''}`;
  return {
    title: title || 'Momento destacado',
    hookText: first.slice(0, 140),
    hookType: seed.kinds.includes('reveal') ? 'Revelación' : seed.kinds.includes('reaction') ? 'Reacción' : 'Evento',
    contextStatus: startsBadly ? 'partial' : 'self-contained',
    sceneChanges,
    startTime: Math.max(0, Math.round((startTime - 0.35) * 100) / 100),
    endTime: Math.round((endTime + 0.55) * 100) / 100,
    score,
    breakdown: {
      hook: Math.round((hook / 10) * config.hookWeight),
      infoValue: Math.round((eventInterest / 30) * config.infoWeight),
      emotion: Math.round((reaction / 20) * config.emotionWeight),
      selfContained: Math.round(((narrative + context) / 35) * config.selfContainedWeight),
      durationFit: Math.round((pace / 5) * config.durationWeight),
    },
    reason: `${seed.kinds.join(' + ')} · evento completo · cierre natural`,
    transcriptExcerpt: text,
  };
}

export function detectNarrativeMoments(params: {
  segments: TranscriptSegment[];
  config: ScoringConfig;
  sceneTimestamps: number[];
  audio: AudioEventAnalysis;
}): CandidateClip[] {
  const { segments, config, sceneTimestamps, audio } = params;
  const candidates = buildSeeds(segments, audio, sceneTimestamps)
    .map((seed) => evaluateEvent(refineBoundaries(segments, seed, audio, config), seed, audio, sceneTimestamps, config))
    .filter((candidate): candidate is CandidateClip => candidate !== null)
    .sort((a, b) => b.score - a.score);

  const selected: CandidateClip[] = [];
  for (const candidate of candidates) {
    const duplicate = selected.some((existing) => {
      const intersection = Math.max(0, Math.min(existing.endTime, candidate.endTime) - Math.max(existing.startTime, candidate.startTime));
      const union = Math.max(existing.endTime, candidate.endTime) - Math.min(existing.startTime, candidate.startTime);
      return union > 0 && intersection / union >= 0.42;
    });
    if (!duplicate) selected.push(candidate);
    if (selected.length >= 3) break;
  }
  return selected;
}

