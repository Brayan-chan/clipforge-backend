import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ALLOWED_VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.webm',
  '.mkv',
  '.m4v',
]);

const rawMaxMb = Number(process.env.MAX_VIDEO_SIZE_MB);
export const MAX_VIDEO_SIZE_MB =
  Number.isFinite(rawMaxMb) && rawMaxMb >= 100
    ? Math.min(10240, Math.round(rawMaxMb))
    : 2048; // 2 GB default, configurable up to 10 GB

export const MAX_VIDEO_SIZE_BYTES = MAX_VIDEO_SIZE_MB * 1024 * 1024;
export const MAX_VIDEO_DURATION_SECONDS = 10800; // 3 hours

export function formatUploadLimitLabel(bytes: number = MAX_VIDEO_SIZE_BYTES): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    const gb = mb / 1024;
    return Number.isInteger(gb) ? `${gb} GB` : `${gb.toFixed(1)} GB`;
  }
  return `${Math.round(mb)} MB`;
}

export function hasEnoughDiskSpace(
  requiredBytes: number,
  targetDir: string
): { ok: boolean; availableBytes: number } {
  try {
    const stats = fs.statfsSync(targetDir);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const safetyBuffer = 512 * 1024 * 1024; // Keep at least 512 MB free on host disk
    return {
      ok: availableBytes > requiredBytes + safetyBuffer,
      availableBytes,
    };
  } catch {
    return { ok: true, availableBytes: MAX_VIDEO_SIZE_BYTES };
  }
}

export function extractYouTubeVideoId(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl.trim());
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      const v = u.searchParams.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      const parts = u.pathname.split('/').filter(Boolean);
      if ((parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed') && parts[1]) {
        return /^[a-zA-Z0-9_-]{11}$/.test(parts[1]) ? parts[1] : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function isYouTubeUrl(rawUrl: string): boolean {
  return extractYouTubeVideoId(rawUrl) !== null;
}

export function validateSafeHttpUrl(rawUrl: string): { valid: boolean; url?: URL; error?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { valid: false, error: 'Please provide a valid http:// or https:// URL.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: 'Only http:// and https:// video URLs are allowed.' };
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === 'metadata.google.internal' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('169.254.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return { valid: false, error: 'Private or local network URLs are not permitted.' };
  }

  return { valid: true, url: parsed };
}

export function generateSafeMediaFilename(originalName: string): string {
  const ext = path.extname(originalName || '').toLowerCase();
  const safeExt = ALLOWED_VIDEO_EXTENSIONS.has(ext) ? ext : '.mp4';
  return `${Date.now()}-${crypto.randomUUID()}${safeExt}`;
}

export function validateUploadedFileMeta(file: {
  originalname: string;
  mimetype: string;
  size: number;
}): { valid: boolean; error?: string } {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_VIDEO_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      error: `Unsupported extension "${ext || 'none'}". Allowed: .mp4, .mov, .webm, .mkv, .m4v.`,
    };
  }
  if (!file.mimetype.startsWith('video/') && file.mimetype !== 'application/octet-stream') {
    return {
      valid: false,
      error: `Unsupported MIME type "${file.mimetype}". Expected a video file.`,
    };
  }
  if (file.size <= 0 || file.size > MAX_VIDEO_SIZE_BYTES) {
    return {
      valid: false,
      error: `File size must be between 1 B and ${formatUploadLimitLabel()}.`,
    };
  }
  return { valid: true };
}

export function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore cleanup failures
  }
}
