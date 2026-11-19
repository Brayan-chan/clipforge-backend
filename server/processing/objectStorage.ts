import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface ObjectStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
}

function getConfig(): ObjectStorageConfig {
  return {
    endpoint: (process.env.S3_ENDPOINT ?? '').trim().replace(/\/+$/, ''),
    region: (process.env.S3_REGION ?? 'auto').trim() || 'auto',
    bucket: (process.env.S3_BUCKET ?? '').trim(),
    accessKeyId: (process.env.S3_ACCESS_KEY_ID ?? '').trim(),
    secretAccessKey: (process.env.S3_SECRET_ACCESS_KEY ?? '').trim(),
    publicBaseUrl: (process.env.S3_PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, ''),
  };
}

export function isObjectStorageConfigured(): boolean {
  const cfg = getConfig();
  return Boolean(cfg.endpoint && cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey);
}

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

export function createPresignedObjectUrl(params: {
  method: 'PUT' | 'GET' | 'DELETE';
  key: string;
  contentType?: string;
  expiresInSeconds?: number;
}): string {
  const cfg = getConfig();
  if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
    throw new Error('Object storage (S3/R2) is not configured on the server.');
  }

  const parsedEndpoint = new URL(cfg.endpoint);
  const host = parsedEndpoint.host;
  const basePath = parsedEndpoint.pathname.replace(/\/+$/, '');
  const cleanKey = params.key.replace(/^\/+/, '');
  const encodedKeyPath = cleanKey.split('/').map(encodeRfc3986).join('/');
  const canonicalUri = `${basePath}/${encodeRfc3986(cfg.bucket)}/${encodedKeyPath}`;

  const now = new Date();
  const isoBasic = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = isoBasic.slice(0, 8);
  const expires = Math.max(60, Math.min(604800, params.expiresInSeconds ?? 3600));
  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;

  const signedHeaderMap: Record<string, string> = { host };
  if (params.method === 'PUT' && params.contentType) {
    signedHeaderMap['content-type'] = params.contentType;
  }
  const signedHeaderNames = Object.keys(signedHeaderMap).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${signedHeaderMap[name]}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');

  const queryParams: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cfg.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': isoBasic,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': signedHeaders,
  };

  const canonicalQuery = Object.keys(queryParams)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(queryParams[k])}`)
    .join('&');

  const canonicalRequest = [
    params.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    isoBasic,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, cfg.region);
  const kService = hmacSha256(kRegion, 's3');
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = crypto
    .createHmac('sha256', kSigning)
    .update(stringToSign, 'utf8')
    .digest('hex');

  return `${parsedEndpoint.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export function buildReadableObjectUrl(key: string): string {
  const cfg = getConfig();
  const cleanKey = key.replace(/^\/+/, '');
  if (cfg.publicBaseUrl) {
    const encodedKeyPath = cleanKey.split('/').map(encodeRfc3986).join('/');
    return `${cfg.publicBaseUrl}/${encodedKeyPath}`;
  }
  return createPresignedObjectUrl({
    method: 'GET',
    key: cleanKey,
    expiresInSeconds: 86400, // 24 hours for FFprobe + FFmpeg Audio-First streaming
  });
}

export function buildStoredObjectUrl(key: string): string {
  const cfg = getConfig();
  const cleanKey = key.replace(/^\/+/, '');
  if (cfg.publicBaseUrl) {
    return `${cfg.publicBaseUrl}/${cleanKey.split('/').map(encodeRfc3986).join('/')}`;
  }
  return `/api/objects?key=${encodeURIComponent(cleanKey)}`;
}

export function extractStoredObjectKey(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('/api/objects?')) {
    const parsed = new URL(url, 'http://clipforge.local');
    return parsed.searchParams.get('key');
  }
  const cfg = getConfig();
  if (cfg.publicBaseUrl && url.startsWith(`${cfg.publicBaseUrl}/`)) {
    return decodeURIComponent(url.slice(cfg.publicBaseUrl.length + 1));
  }
  return null;
}

export async function uploadFileToObjectStorage(params: {
  filePath: string;
  key: string;
  contentType: string;
}): Promise<string> {
  if (!isObjectStorageConfigured()) {
    throw new Error('Object storage is not configured.');
  }
  const stat = fs.statSync(params.filePath);
  const signedUrl = createPresignedObjectUrl({
    method: 'PUT',
    key: params.key,
    contentType: params.contentType,
    expiresInSeconds: 3600,
  });
  const body = fs.createReadStream(params.filePath);
  const response = await fetch(signedUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': params.contentType,
      'Content-Length': String(stat.size),
    },
    body: body as unknown as BodyInit,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  if (!response.ok) {
    throw new Error(`R2 upload failed (${response.status}) for ${path.basename(params.filePath)}.`);
  }
  return buildStoredObjectUrl(params.key);
}

export async function deleteObjectFromStorage(key: string): Promise<void> {
  if (!isObjectStorageConfigured()) return;
  const response = await fetch(createPresignedObjectUrl({
    method: 'DELETE',
    key: key.replace(/^\/+/, ''),
    expiresInSeconds: 900,
  }), { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    throw new Error(`R2 delete failed (${response.status}).`);
  }
}
