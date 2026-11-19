import fs from 'node:fs';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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

function createS3Client(): { client: S3Client; config: ObjectStorageConfig } {
  const cfg = getConfig();
  if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
    throw new Error('Object storage (S3/R2) is not configured on the server.');
  }
  return {
    config: cfg,
    client: new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
    }),
  };
}

export async function createPresignedPutUrl(params: {
  key: string;
  contentType: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const { client, config: cfg } = createS3Client();

  const command = new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: params.key.replace(/^\/+/, ''),
    ContentType: params.contentType,
  });

  return getSignedUrl(client, command, {
    expiresIn: Math.max(60, Math.min(604800, params.expiresInSeconds ?? 3600)),
  });
}

export async function buildReadableObjectUrl(key: string): Promise<string> {
  const cfg = getConfig();
  const cleanKey = key.replace(/^\/+/, '');
  if (cfg.publicBaseUrl) {
    const encodedKeyPath = cleanKey.split('/').map(encodeRfc3986).join('/');
    return `${cfg.publicBaseUrl}/${encodedKeyPath}`;
  }
  const { client, config } = createS3Client();
  return getSignedUrl(client, new GetObjectCommand({
    Bucket: config.bucket,
    Key: cleanKey,
  }), {
    expiresIn: 86400, // 24 hours for FFprobe + FFmpeg Audio-First streaming
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
  const signedUrl = await createPresignedPutUrl({
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
  const { client, config } = createS3Client();
  await client.send(new DeleteObjectCommand({
    Bucket: config.bucket,
    Key: key.replace(/^\/+/, ''),
  }));
}
