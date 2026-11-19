import type { ClipComposition, ClipRecord } from '../types';

export type CompositionVariant = 'vertical' | 'horizontal';

export function createDefaultComposition(variant: CompositionVariant): ClipComposition {
  return {
    aspectRatio: variant === 'vertical' ? '9:16' : '16:9',
    layout: variant === 'vertical' ? 'stacked' : 'focus',
    focus: variant === 'vertical' ? 'split' : 'content',
    cameraEnabled: variant === 'vertical',
    // Common streamer layout: facecam in a lower-left corner, content fills the frame.
    camera: { x: 2, y: 57, width: 28, height: 40 },
    content: { x: 0, y: 0, width: 100, height: 100 },
    cameraPosition: 'top',
    cameraScale: 32,
    creditEnabled: false,
    creditText: '',
  };
}

export function getClipComposition(
  clip: Pick<ClipRecord, 'compositions'>,
  variant: CompositionVariant
): ClipComposition {
  const defaults = createDefaultComposition(variant);
  return { ...defaults, ...(clip.compositions?.[variant] ?? {}) };
}

export function ensureClipCompositions(
  clip: Pick<ClipRecord, 'compositions'>
): NonNullable<ClipRecord['compositions']> {
  return {
    vertical: getClipComposition(clip, 'vertical'),
    horizontal: getClipComposition(clip, 'horizontal'),
  };
}
