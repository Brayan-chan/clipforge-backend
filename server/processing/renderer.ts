import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import type {
  AspectRatio,
  ClipComposition,
  ClipRecord,
  SubtitleStyle,
  TranscriptSegment,
} from '../../src/types';
import { getClipComposition, type CompositionVariant } from '../../src/utils/composition';
import { CLIPS_DIR, ensureStorageDirs } from '../db';
import { generateThumbnail } from './videoAnalyzer';
import {
  deleteObjectFromStorage,
  isObjectStorageConfigured,
  uploadFileToObjectStorage,
} from './objectStorage';

const execFileAsync = promisify(execFile);
let assFilterSupport: Promise<boolean> | null = null;

function supportsAssFilter(): Promise<boolean> {
  if (!assFilterSupport) {
    assFilterSupport = execFileAsync('ffmpeg', ['-hide_banner', '-filters'], { timeout: 10000 })
      .then(({ stdout }) => /\bass\s+V->V\b/.test(stdout))
      .catch(() => false);
  }
  return assFilterSupport;
}

function formatSrtTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function formatAssTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function hexToAssBgr(hex: string, alphaHex = '00'): string {
  const cleaned = hex.replace('#', '').trim();
  if (cleaned.length !== 6) return `&H${alphaHex}FFFFFF`;
  const r = cleaned.slice(0, 2);
  const g = cleaned.slice(2, 4);
  const b = cleaned.slice(4, 6);
  return `&H${alphaHex}${b}${g}${r}`.toUpperCase();
}

function getTargetDimensions(aspectRatio: AspectRatio): { width: number; height: number } {
  switch (aspectRatio) {
    case '1:1':
      return { width: 720, height: 720 };
    case '16:9':
      return { width: 1280, height: 720 };
    case '9:16':
    default:
      return { width: 720, height: 1280 };
  }
}

function buildClipSegments(
  segments: TranscriptSegment[],
  clipStart: number,
  clipEnd: number
): TranscriptSegment[] {
  return segments
    .filter((seg) => seg.end > clipStart && seg.start < clipEnd)
    .map((seg, idx) => ({
      id: seg.id || `sub-${idx + 1}`,
      start: Math.max(0, seg.start - clipStart),
      end: Math.max(0.4, Math.min(clipEnd - clipStart, seg.end - clipStart)),
      text: seg.text.trim(),
    }))
    .filter((seg) => seg.text.length > 0);
}

function writeSrtFile(filePath: string, clipSegments: TranscriptSegment[]): void {
  const srt = clipSegments
    .map(
      (seg, i) =>
        `${i + 1}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${seg.text}`
    )
    .join('\n\n');
  fs.writeFileSync(filePath, srt + '\n', 'utf-8');
}

function writeAssFile(
  filePath: string,
  clipSegments: TranscriptSegment[],
  style: SubtitleStyle,
  width: number,
  height: number,
  creditText = ''
): void {
  const scaledFontSize = Math.round((style.fontSize || 22) * (width / 420));
  const primaryColor = hexToAssBgr(style.textColor || '#FFFFFF', '00');
  const secondaryColor = hexToAssBgr(style.highlightColor || '#22C55E', '00');
  const backColor = style.backgroundBox ? '&H66000000' : '&H00000000';
  const outlineColor = '&H00000000';
  const borderStyle = style.backgroundBox ? 3 : 1;
  const outline = style.backgroundBox ? 8 : 3;
  const shadow = style.backgroundBox ? 0 : 2;

  // ASS alignment numpad: 1=BL, 2=BC, 3=BR, 4=ML, 5=MC, 6=MR, 7=TL, 8=TC, 9=TR
  let alignment = 2;
  const colOffset = style.alignment === 'left' ? -1 : style.alignment === 'right' ? 1 : 0;
  if (style.position === 'top') alignment = 8 + colOffset;
  else if (style.position === 'center') alignment = 5 + colOffset;
  else alignment = 2 + colOffset;

  const marginV = style.position === 'center' ? 0 : Math.round(height * 0.11);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,${scaledFontSize},${primaryColor},${secondaryColor},${outlineColor},${backColor},-1,0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${alignment},40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const subtitleEvents = clipSegments
    .flatMap((seg) => {
      const cleanText = seg.text
        .replace(/\\/g, '')
        .replace(/\{|\}/g, '')
        .replace(/\r?\n/g, ' ')
        .trim();
      const words = cleanText.split(/\s+/).filter(Boolean);
      if (words.length === 0) return [];
      const wordDuration = Math.max(0.04, (seg.end - seg.start) / words.length);
      const region = style.region;
      const regionOverride = region
        ? `{\\an5\\pos(${Math.round(width * ((region.x + region.width / 2) / 100))},${Math.round(height * ((region.y + region.height / 2) / 100))})\\clip(${Math.round(width * region.x / 100)},${Math.round(height * region.y / 100)},${Math.round(width * (region.x + region.width) / 100)},${Math.round(height * (region.y + region.height) / 100)})}`
        : '';
      return words.map((_, activeIndex) => {
        const start = seg.start + activeIndex * wordDuration;
        const end = activeIndex === words.length - 1
          ? seg.end
          : Math.min(seg.end, start + wordDuration);
        const highlightedText = words
          .map((word, index) =>
            index === activeIndex
              ? `{\\1c${secondaryColor}}${word}{\\1c${primaryColor}}`
              : word
          )
          .join(' ');
        return `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${regionOverride}${highlightedText}`;
      });
    })
    .join('\n');

  const safeCredit = creditText
    .replace(/\\/g, '')
    .replace(/\{|\}/g, '')
    .replace(/\r?\n/g, ' ')
    .trim();
  const creditEvent = safeCredit
    ? `Dialogue: 1,0:00:00.00,9:59:59.00,Default,,0,0,0,,{\\an7\\fs${Math.max(18, Math.round(scaledFontSize * 0.55))}\\bord2\\shad1\\1c&HFFFFFF&\\3c&H000000&\\pos(${Math.round(width * 0.035)},${Math.round(height * 0.04)})}Source: ${safeCredit}`
    : '';
  const events = [subtitleEvents, creditEvent].filter(Boolean).join('\n');

  fs.writeFileSync(filePath, header + events + '\n', 'utf-8');
}

function writeTextOverlayPng(params: {
  filePath: string;
  width: number;
  height: number;
  text: string;
  style: SubtitleStyle;
  credit?: boolean;
  highlightWordIndex?: number;
}): void {
  const { filePath, width, height, text, style, credit = false, highlightWordIndex } = params;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const fontSize = credit
    ? Math.max(20, Math.round(width * 0.025))
    : Math.max(28, Math.round((style.fontSize || 22) * (width / 420)));
  ctx.font = `700 ${fontSize}px sans-serif`;
  ctx.textAlign = style.region && !credit
    ? 'center'
    : credit || style.alignment === 'left'
    ? 'left'
    : style.alignment === 'right'
    ? 'right'
    : 'center';
  ctx.textBaseline = 'middle';

  const region = style.region ?? {
    x: 8,
    y: style.position === 'top' ? 6 : style.position === 'center' ? 40 : 72,
    width: 84,
    height: 20,
  };
  const maxWidth = credit ? width * 0.88 : width * (region.width / 100) * 0.92;
  const words = text.trim().split(/\s+/);
  const lines: Array<Array<{ text: string; index: number }>> = [];
  let line: Array<{ text: string; index: number }> = [];
  words.forEach((word, index) => {
    const candidate = [...line, { text: word, index }];
    if (ctx.measureText(candidate.map((item) => item.text).join(' ')).width > maxWidth && line.length) {
      lines.push(line);
      line = [{ text: word, index }];
    } else line = candidate;
  });
  if (line.length) lines.push(line);
  const visibleLines = credit ? lines.slice(0, 1) : lines.slice(0, 3);
  const lineHeight = fontSize * 1.2;
  const blockHeight = credit
    ? visibleLines.length * lineHeight + fontSize * 0.65
    : Math.min(height * (region.height / 100), visibleLines.length * lineHeight + fontSize * 0.65);
  const centerY = credit
    ? height * 0.055
    : height * ((region.y + region.height / 2) / 100);
  const anchorX = style.region && !credit
    ? width * ((region.x + region.width / 2) / 100)
    : credit || style.alignment === 'left'
    ? width * 0.06
    : style.alignment === 'right'
    ? width * 0.94
    : width / 2;

  if (style.backgroundBox || credit) {
    ctx.fillStyle = 'rgba(0,0,0,0.70)';
    ctx.fillRect(
      credit ? width * 0.04 : width * (region.x / 100),
      centerY - blockHeight / 2,
      credit ? width * 0.92 : width * (region.width / 100),
      blockHeight
    );
  }
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(3, Math.round(fontSize * 0.12));
  ctx.strokeStyle = '#000000';
  ctx.textAlign = 'left';
  visibleLines.forEach((value, index) => {
    const y = centerY + (index - (visibleLines.length - 1) / 2) * lineHeight;
    const lineText = value.map((item) => item.text).join(' ');
    const lineWidth = ctx.measureText(lineText).width;
    let x = credit || style.alignment === 'left'
      ? anchorX
      : style.alignment === 'right'
      ? anchorX - lineWidth
      : anchorX - lineWidth / 2;
    value.forEach((item, wordPosition) => {
      const rendered = `${item.text}${wordPosition < value.length - 1 ? ' ' : ''}`;
      ctx.strokeText(rendered, x, y);
      ctx.fillStyle = credit
        ? '#FFFFFF'
        : item.index === highlightWordIndex
        ? style.highlightColor
        : style.textColor;
      ctx.fillText(rendered, x, y);
      x += ctx.measureText(rendered).width;
    });
  });
  fs.writeFileSync(filePath, canvas.toBuffer('image/png'));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cropFilter(region: ClipComposition['camera']): string {
  const width = clamp(region.width, 5, 100) / 100;
  const height = clamp(region.height, 5, 100) / 100;
  const x = clamp(region.x, 0, 100 - width * 100) / 100;
  const y = clamp(region.y, 0, 100 - height * 100) / 100;
  return `crop=iw*${width.toFixed(4)}:ih*${height.toFixed(4)}:iw*${x.toFixed(4)}:ih*${y.toFixed(4)}`;
}

function coverFilter(width: number, height: number): string {
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
}

function buildCompositionFilter(
  composition: ClipComposition,
  width: number,
  height: number
): string {
  const contentCrop = cropFilter(composition.content);
  const cameraCrop = cropFilter(composition.camera);

  if (!composition.cameraEnabled) {
    return `${contentCrop},${coverFilter(width, height)}`;
  }

  if (composition.layout === 'stacked') {
    const cameraHeight = Math.round(height * clamp(composition.cameraScale, 20, 60) / 100);
    const contentHeight = height - cameraHeight;
    const topIsCamera = composition.cameraPosition === 'top';
    return [
      'split=2[contentSource][cameraSource]',
      `[contentSource]${contentCrop},${coverFilter(width, contentHeight)}[content]`,
      `[cameraSource]${cameraCrop},${coverFilter(width, cameraHeight)}[camera]`,
      topIsCamera ? '[camera][content]vstack=inputs=2,setsar=1' : '[content][camera]vstack=inputs=2,setsar=1',
    ].join(';');
  }

  if (composition.layout === 'picture-in-picture') {
    const pipWidth = Math.round(width * clamp(composition.cameraScale, 18, 48) / 100);
    const pipHeight = Math.max(2, Math.round(pipWidth * 9 / 16 / 2) * 2);
    const overlayY = composition.cameraPosition === 'top' ? Math.round(height * 0.04) : `H-h-${Math.round(height * 0.04)}`;
    return [
      'split=2[contentSource][cameraSource]',
      `[contentSource]${contentCrop},${coverFilter(width, height)}[content]`,
      `[cameraSource]${cameraCrop},${coverFilter(pipWidth, pipHeight)}[camera]`,
      `[content][camera]overlay=${Math.round(width * 0.04)}:${overlayY}:format=auto,setsar=1`,
    ].join(';');
  }

  const region = composition.focus === 'camera' ? composition.camera : composition.content;
  return `${cropFilter(region)},${coverFilter(width, height)}`;
}

export async function renderClipWithFfmpeg(params: {
  clip: ClipRecord;
  videoPath: string;
  hasAudio: boolean;
  segments: TranscriptSegment[];
  variant?: CompositionVariant;
}): Promise<{
  exportedUrl: string;
  srtUrl: string;
  thumbnailUrl: string | null;
  exportedSizeBytes: number;
}> {
  ensureStorageDirs();
  const { clip, videoPath, hasAudio, segments, variant } = params;
  const composition = variant ? getClipComposition(clip, variant) : null;
  const aspectRatio = composition?.aspectRatio ?? clip.aspectRatio;
  const { width, height } = getTargetDimensions(aspectRatio);
  const clipDuration = Math.max(1, clip.endTime - clip.startTime);

  const stamp = Date.now();
  const variantTag = variant ? `-${variant}` : '';
  const mp4Name = `clip-${clip.id}${variantTag}-${stamp}.mp4`;
  const srtName = `clip-${clip.id}${variantTag}-${stamp}.srt`;
  const assName = `clip-${clip.id}${variantTag}-${stamp}.ass`;
  const thumbName = `clip-${clip.id}${variantTag}-${stamp}.jpg`;

  const mp4Path = path.join(CLIPS_DIR, mp4Name);
  const srtPath = path.join(CLIPS_DIR, srtName);
  const assPath = path.join(CLIPS_DIR, assName);

  const clipSegments = buildClipSegments(segments, clip.startTime, clip.endTime);
  writeSrtFile(srtPath, clipSegments);

  const zoom = Math.min(2.0, Math.max(1.0, clip.zoom || 1.0));
  const cropXRatio = Math.min(1, Math.max(0, (clip.cropX ?? 50) / 100));
  const cropYRatio = Math.min(1, Math.max(0, (clip.cropY ?? 50) / 100));

  let videoFilter = '';
  if (composition) {
    videoFilter = buildCompositionFilter(composition, width, height);
  } else if (clip.framingMode === 'blur') {
    videoFilter = [
      `split=2[bg][fg]`,
      `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=16:2[bgb]`,
      `[fg]scale=${Math.round(width * zoom)}:${Math.round(height * zoom)}:force_original_aspect_ratio=decrease[fgb]`,
      `[bgb][fgb]overlay=(W-w)/2:(H-h)/2,setsar=1`,
    ].join(';');
  } else {
    const scaledW = Math.round(width * zoom);
    const scaledH = Math.round(height * zoom);
    videoFilter = `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase,crop=${width}:${height}:(iw-${width})*${cropXRatio.toFixed(3)}:(ih-${height})*${cropYRatio.toFixed(3)},setsar=1`;
  }

  const shouldBurnSubtitles = clip.subtitleStyle.enabled && clipSegments.length > 0;
  const shouldBurnCredit = Boolean(composition?.creditEnabled && composition.creditText.trim());
  const canBurnAss =
    (shouldBurnSubtitles || shouldBurnCredit) &&
    await supportsAssFilter();
  const overlaySpecs: Array<{ path: string; start: number; end: number }> = [];
  let subtitleTimeline: { concatPath: string; imagePaths: string[] } | null = null;
  if (canBurnAss) {
    writeAssFile(
      assPath,
      shouldBurnSubtitles ? clipSegments : [],
      clip.subtitleStyle,
      width,
      height,
      composition?.creditEnabled ? composition.creditText : ''
    );
    const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    if (clip.framingMode === 'blur') {
      videoFilter = `${videoFilter},ass=filename='${escapedAss}'`;
    } else {
      videoFilter = `${videoFilter},ass=filename='${escapedAss}'`;
    }
  } else if (shouldBurnSubtitles || shouldBurnCredit) {
    // Portable fallback for FFmpeg builds without libass: render transparent
    // subtitle cards as PNGs and time them with the standard overlay filter.
    if (shouldBurnSubtitles) {
      const timelineEntries: Array<{ path: string; duration: number }> = [];
      const imagePaths: string[] = [];
      const blankPath = path.join(CLIPS_DIR, `clip-${clip.id}-${stamp}-sub-blank.png`);
      const blankCanvas = createCanvas(width, height);
      fs.writeFileSync(blankPath, blankCanvas.toBuffer('image/png'));
      imagePaths.push(blankPath);
      let timelineCursor = 0;
      clipSegments.forEach((segment, segmentIndex) => {
        const words = segment.text.trim().split(/\s+/).filter(Boolean);
        const wordDuration = Math.max(0.04, (segment.end - segment.start) / Math.max(1, words.length));
        if (segment.start > timelineCursor) {
          timelineEntries.push({ path: blankPath, duration: segment.start - timelineCursor });
        }
        words.forEach((_, wordIndex) => {
          const overlayPath = path.join(
            CLIPS_DIR,
            `clip-${clip.id}-${stamp}-sub-${segmentIndex}-${wordIndex}.png`
          );
          writeTextOverlayPng({
            filePath: overlayPath,
            width,
            height,
            text: segment.text,
            style: clip.subtitleStyle,
            highlightWordIndex: wordIndex,
          });
          imagePaths.push(overlayPath);
          const start = segment.start + wordIndex * wordDuration;
          const end = wordIndex === words.length - 1
            ? segment.end
            : Math.min(segment.end, start + wordDuration);
          timelineEntries.push({ path: overlayPath, duration: Math.max(0.04, end - start) });
        });
        timelineCursor = Math.max(timelineCursor, segment.end);
      });
      if (timelineCursor < clipDuration) {
        timelineEntries.push({ path: blankPath, duration: clipDuration - timelineCursor });
      }
      if (timelineEntries.length > 0) {
        const concatPath = path.join(CLIPS_DIR, `clip-${clip.id}-${stamp}-subtitles.ffconcat`);
        const escapeConcatPath = (value: string) => value.replace(/'/g, "'\\''");
        const concatBody = [
          'ffconcat version 1.0',
          ...timelineEntries.flatMap((entry) => [
            `file '${escapeConcatPath(entry.path)}'`,
            `duration ${entry.duration.toFixed(6)}`,
          ]),
          `file '${escapeConcatPath(timelineEntries[timelineEntries.length - 1].path)}'`,
        ].join('\n');
        fs.writeFileSync(concatPath, `${concatBody}\n`, 'utf8');
        subtitleTimeline = { concatPath, imagePaths };
      }
    }
    if (shouldBurnCredit && composition) {
      const overlayPath = path.join(CLIPS_DIR, `clip-${clip.id}-${stamp}-credit.png`);
      writeTextOverlayPng({
        filePath: overlayPath,
        width,
        height,
        text: `Fuente: ${composition.creditText}`,
        style: clip.subtitleStyle,
        credit: true,
      });
      overlaySpecs.push({ path: overlayPath, start: 0, end: clipDuration });
    }
  }

  const args: string[] = [
    '-y',
    '-ss',
    clip.startTime.toFixed(2),
    '-t',
    clipDuration.toFixed(2),
    '-i',
    videoPath,
  ];

  if (subtitleTimeline) {
    args.push('-f', 'concat', '-safe', '0', '-i', subtitleTimeline.concatPath);
  }
  if (overlaySpecs.length > 0) {
    for (const overlay of overlaySpecs) args.push('-loop', '1', '-i', overlay.path);
  }
  if (subtitleTimeline || overlaySpecs.length > 0) {
    const chains: string[] = [`${videoFilter}[composition]`];
    let previous = 'composition';
    let inputIndex = 1;
    if (subtitleTimeline) {
      chains.push(`[${previous}][${inputIndex}:v]overlay=0:0:eof_action=pass:shortest=0[subtitleoverlay]`);
      previous = 'subtitleoverlay';
      inputIndex++;
    }
    overlaySpecs.forEach((overlay, index) => {
      const output = `overlay${index}`;
      chains.push(
        `[${previous}][${inputIndex + index}:v]overlay=0:0:shortest=0:eof_action=pass:enable='between(t,${overlay.start.toFixed(3)},${overlay.end.toFixed(3)})'[${output}]`
      );
      previous = output;
    });
    args.push('-filter_complex', chains.join(';'), '-map', `[${previous}]`);
    if (hasAudio) args.push('-map', '0:a?');
  } else {
    args.push('-vf', videoFilter);
  }

  args.push(
    '-r',
    '30',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '24',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-t',
    clipDuration.toFixed(2)
  );

  if (hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-an');
  }

  args.push(mp4Path);

  try {
    await execFileAsync('ffmpeg', args, { timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    safeDeleteFile(mp4Path);
    throw error;
  } finally {
    // Always remove the temporary burn-in file, including failed renders.
    if (fs.existsSync(assPath)) fs.unlinkSync(assPath);
    for (const overlay of overlaySpecs) {
      if (fs.existsSync(overlay.path)) fs.unlinkSync(overlay.path);
    }
    if (subtitleTimeline) {
      safeDeleteFile(subtitleTimeline.concatPath);
      for (const imagePath of subtitleTimeline.imagePaths) safeDeleteFile(imagePath);
    }
  }

  const stat = fs.statSync(mp4Path);
  const thumbnailUrl = await generateThumbnail(mp4Path, thumbName, Math.min(1.5, clipDuration / 2));

  if (isObjectStorageConfigured()) {
    const mp4Key = `clips/${mp4Name}`;
    const srtKey = `clips/${srtName}`;
    try {
      const [exportedUrl, storedSrtUrl] = await Promise.all([
        uploadFileToObjectStorage({
          filePath: mp4Path,
          key: mp4Key,
          contentType: 'video/mp4',
        }),
        uploadFileToObjectStorage({
          filePath: srtPath,
          key: srtKey,
          contentType: 'application/x-subrip; charset=utf-8',
        }),
      ]);
      safeDeleteFile(mp4Path);
      safeDeleteFile(srtPath);
      return {
        exportedUrl,
        srtUrl: storedSrtUrl,
        thumbnailUrl,
        exportedSizeBytes: stat.size,
      };
    } catch (error) {
      await Promise.allSettled([
        deleteObjectFromStorage(mp4Key),
        deleteObjectFromStorage(srtKey),
      ]);
      throw error;
    }
  }

  return {
    exportedUrl: `/storage/clips/${mp4Name}`,
    srtUrl: `/storage/clips/${srtName}`,
    thumbnailUrl,
    exportedSizeBytes: stat.size,
  };
}

function safeDeleteFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup; the original render error is more useful to callers.
  }
}
