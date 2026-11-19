import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ClipRecord, ScoringConfig, TranscriptSegment } from './src/types';
import { ensureClipCompositions, type CompositionVariant } from './src/utils/composition';
import {
  CLIPS_DIR,
  DEFAULT_SUBTITLE_STYLE,
  STORAGE_ROOT,
  THUMBNAILS_DIR,
  TRANSCRIPTS_DIR,
  UPLOADS_DIR,
  ensureStorageDirs,
  getStorageUsageBytes,
  mutateDb,
  readDb,
  recoverInterruptedJobs,
  resolveVideoInputSource,
} from './server/db';
import { runVideoPipeline } from './server/pipeline';
import { processingQueue } from './server/queue';
import {
  detectCandidateClipsHeuristic,
  parseSrtFileContent,
  parseSrtOrTextTranscript,
  scoreWindow,
} from './server/processing/clipScorer';
import {
  isGeminiConfigured,
  refineCandidatesWithGemini,
} from './server/processing/geminiClient';
import { renderClipWithFfmpeg } from './server/processing/renderer';
import {
  SAMPLE_PODCAST_SEGMENTS,
  generateDemoPodcastVideo,
} from './server/processing/sampleGenerator';
import {
  buildReadableObjectUrl,
  buildStoredObjectUrl,
  createPresignedPutUrl,
  deleteObjectFromStorage,
  extractStoredObjectKey,
  isObjectStorageConfigured,
} from './server/processing/objectStorage';
import {
  UrlIngestionError,
  ingestYouTubeUrl,
  probeRemoteDirectUrl,
} from './server/processing/urlIngestor';
import {
  MAX_VIDEO_SIZE_BYTES,
  formatUploadLimitLabel,
  generateSafeMediaFilename,
  hasEnoughDiskSpace,
  isYouTubeUrl,
  safeUnlink,
  validateSafeHttpUrl,
  validateUploadedFileMeta,
} from './server/processing/validation';
import {
  analyzeVideo,
  checkFfmpegBinaries,
  generateThumbnail,
} from './server/processing/videoAnalyzer';

ensureStorageDirs();
const recoveredCount = recoverInterruptedJobs();
if (recoveredCount > 0) {
  console.log(`[ClipForge] Recovered ${recoveredCount} interrupted job(s) from previous session.`);
}

const app = express();
const allowedOrigins = (process.env.FRONTEND_ORIGIN ?? '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin.replace(/\/$/, ''))) {
      callback(null, true);
      return;
    }
    callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Chunk-Index', 'X-Chunk-Offset'],
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'ETag'],
}));
app.use(express.json({ limit: '15mb' }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'clipforge-backend' });
});

// Expose ONLY safe public media subdirectories (never expose clipforge.db.json or transcripts/)
app.use('/storage/uploads', express.static(UPLOADS_DIR));
app.use('/storage/thumbnails', express.static(THUMBNAILS_DIR));
app.use('/storage/clips', express.static(CLIPS_DIR));
app.use('/storage', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.get('/api/objects', async (req, res) => {
  const key = typeof req.query.key === 'string' ? req.query.key.replace(/^\/+/, '') : '';
  if (!key || key.includes('..') || !/^(uploads|clips|thumbnails)\//.test(key)) {
    res.status(400).json({ error: 'Invalid object key.' });
    return;
  }
  try {
    res.redirect(307, await buildReadableObjectUrl(key));
  } catch (error) {
    res.status(503).json({
      error: error instanceof Error ? error.message : 'Object storage unavailable.',
    });
  }
});

function removeClipArtifactsByIds(clipIds: Iterable<number>): number {
  const ids = new Set(clipIds);
  if (ids.size === 0) return 0;
  let removed = 0;
  for (const dir of [CLIPS_DIR, THUMBNAILS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const filename of fs.readdirSync(dir)) {
      const match = filename.match(/^clip-(\d+)-/);
      if (!match || !ids.has(Number(match[1]))) continue;
      safeUnlink(path.join(dir, filename));
      removed++;
    }
  }
  return removed;
}

/** Removes renderer artifacts whose clip record no longer exists. */
function reconcileOrphanedClipArtifacts(): number {
  const liveIds = new Set(readDb().clips.map((clip) => clip.id));
  const orphanIds = new Set<number>();
  for (const dir of [CLIPS_DIR, THUMBNAILS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const filename of fs.readdirSync(dir)) {
      const match = filename.match(/^clip-(\d+)-/);
      if (match && !liveIds.has(Number(match[1]))) orphanIds.add(Number(match[1]));
    }
  }
  return removeClipArtifactsByIds(orphanIds);
}

interface CleanupReport {
  removedFiles: number;
  removedBytes: number;
}

function removeFileWithReport(filePath: string, report: CleanupReport): void {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return;
    fs.unlinkSync(filePath);
    report.removedFiles++;
    report.removedBytes += stat.size;
  } catch {
    // A cache file can disappear between the scan and deletion.
  }
}

function localBasename(url: string | null | undefined, prefix: string): string | null {
  if (!url?.startsWith(prefix)) return null;
  return path.basename(url);
}

async function deleteStoredUrls(urls: Array<string | null | undefined>): Promise<number> {
  const keys = new Set<string>();
  for (const url of urls) {
    if (url?.startsWith('r2://')) keys.add(url.slice('r2://'.length));
    const key = extractStoredObjectKey(url);
    if (key) keys.add(key);
  }
  const results = await Promise.allSettled([...keys].map((key) => deleteObjectFromStorage(key)));
  return results.filter((result) => result.status === 'fulfilled').length;
}

/** Reconciles managed media folders against the database without touching live assets. */
function purgeUnreferencedStorage(): CleanupReport {
  const db = readDb();
  const report: CleanupReport = { removedFiles: 0, removedBytes: 0 };
  const referencedUploads = new Set(
    db.videos.filter((video) => !video.sourceUrl).map((video) => path.basename(video.filename))
  );
  const referencedClips = new Set<string>();
  const referencedThumbnails = new Set<string>();

  for (const video of db.videos) {
    const thumbnail = localBasename(video.thumbnailUrl, '/storage/thumbnails/');
    if (thumbnail) referencedThumbnails.add(thumbnail);
  }
  for (const clip of db.clips) {
    for (const url of [clip.exportedUrl, clip.srtUrl]) {
      const filename = localBasename(url, '/storage/clips/');
      if (filename) referencedClips.add(filename);
    }
    const thumbnail = localBasename(clip.thumbnailUrl, '/storage/thumbnails/');
    if (thumbnail) referencedThumbnails.add(thumbnail);
    for (const variant of Object.values(clip.exportVariants ?? {})) {
      for (const url of [variant?.exportedUrl, variant?.srtUrl]) {
        const filename = localBasename(url, '/storage/clips/');
        if (filename) referencedClips.add(filename);
      }
      const variantThumbnail = localBasename(variant?.thumbnailUrl, '/storage/thumbnails/');
      if (variantThumbnail) referencedThumbnails.add(variantThumbnail);
    }
  }

  const removeUnreferenced = (dir: string, keep: Set<string>) => {
    if (!fs.existsSync(dir)) return;
    for (const filename of fs.readdirSync(dir)) {
      if (!keep.has(filename)) removeFileWithReport(path.join(dir, filename), report);
    }
  };
  removeUnreferenced(UPLOADS_DIR, referencedUploads);
  removeUnreferenced(CLIPS_DIR, referencedClips);
  removeUnreferenced(THUMBNAILS_DIR, referencedThumbnails);

  // Reproducible intermediate files, never canonical user data.
  for (const dir of [TRANSCRIPTS_DIR, PREVIEWS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const filename of fs.readdirSync(dir)) {
      removeFileWithReport(path.join(dir, filename), report);
    }
  }
  if (fs.existsSync(CHUNKS_DIR)) {
    const activeChunkFiles = new Set(
      [...chunkUploadSessions.values()].map((session) => path.basename(session.tempPath))
    );
    for (const filename of fs.readdirSync(CHUNKS_DIR)) {
      if (!activeChunkFiles.has(filename)) {
        removeFileWithReport(path.join(CHUNKS_DIR, filename), report);
      }
    }
  }
  return report;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureStorageDirs();
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    cb(null, generateSafeMediaFilename(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_VIDEO_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    const check = validateUploadedFileMeta({
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: 1,
    });
    if (!check.valid) {
      cb(new Error(check.error));
      return;
    }
    cb(null, true);
  },
});

const srtUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.srt') {
      cb(new Error('Only .srt subtitle files are allowed.'));
      return;
    }
    cb(null, true);
  },
});

const CHUNKS_DIR = path.join(STORAGE_ROOT, '.chunks');
const UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024; // 5 MB chunks stay safely under proxy limits

interface ChunkUploadSession {
  uploadId: string;
  safeFilename: string;
  originalName: string;
  tempPath: string;
  expectedSizeBytes: number;
  receivedBytes: number;
  chunkSizes: Map<number, number>;
  title: string;
  projectId: number;
  useAi: boolean;
  transcriptText: string;
  createdAtMs: number;
  lastActivityMs: number;
  writeChain: Promise<void>;
}

const chunkUploadSessions = new Map<string, ChunkUploadSession>();

function cleanupExpiredChunkSessions(): void {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2 hours of inactivity
  for (const [id, session] of chunkUploadSessions.entries()) {
    if (session.lastActivityMs < cutoff) {
      safeUnlink(session.tempPath);
      chunkUploadSessions.delete(id);
    }
  }
}

async function finalizeUploadedVideo(params: {
  filePath: string;
  filename: string;
  originalName: string;
  sizeBytes: number;
  title: string;
  projectId: number;
  useAi: boolean;
  transcriptText: string;
}) {
  let videoMeta;
  try {
    videoMeta = await analyzeVideo(params.filePath);
  } catch (probeErr) {
    safeUnlink(params.filePath);
    const err = new Error(
      probeErr instanceof Error ? probeErr.message : 'Invalid or corrupted video file.'
    ) as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }

  const { video, job } = await mutateDb((db) => {
    const videoId = db.nextIds.video++;
    const v = {
      id: videoId,
      projectId: params.projectId,
      title: params.title,
      filename: params.filename,
      originalName: path.basename(params.originalName),
      fileUrl: `/storage/uploads/${params.filename}`,
      thumbnailUrl: null as string | null,
      duration: videoMeta.duration,
      width: videoMeta.width,
      height: videoMeta.height,
      fps: videoMeta.fps,
      hasAudio: videoMeta.hasAudio,
      sizeBytes: params.sizeBytes,
      status: 'processing' as const,
      createdAt: new Date().toISOString(),
    };
    db.videos.push(v);

    const jobId = db.nextIds.job++;
    const j = {
      id: jobId,
      projectId: params.projectId,
      videoId,
      stage: 'queued' as const,
      progress: 10,
      message: 'Video validated & queued for sequential processing...',
      useAi: params.useAi,
      updatedAt: new Date().toISOString(),
    };
    db.processingJobs.push(j);
    return { video: v, job: j };
  });

  void runVideoPipeline({
    videoId: video.id,
    jobId: job.id,
    useAi: params.useAi,
    suppliedTranscript: params.transcriptText,
  });

  return { video, job };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'clipforge' });
});

app.get('/api/status', async (_req, res) => {
  const binaries = await checkFfmpegBinaries();
  const db = readDb();
  const queueStats = processingQueue.getStats();
  res.json({
    ffmpegAvailable: binaries.ffmpegAvailable,
    ffprobeAvailable: binaries.ffprobeAvailable,
    geminiConfigured: isGeminiConfigured(),
    maxUploadSizeBytes: MAX_VIDEO_SIZE_BYTES,
    objectStorageConfigured: isObjectStorageConfigured(),
    storageBytes: getStorageUsageBytes(),
    activeQueueTasks: queueStats.active,
    queuedTasks: queueStats.queued,
    tableCounts: {
      users: db.users.length,
      projects: db.projects.length,
      videos: db.videos.length,
      transcriptions: db.transcriptions.length,
      clips: db.clips.length,
      processingJobs: db.processingJobs.length,
    },
  });
});

app.get('/api/workspace', (_req, res) => {
  const db = readDb();
  res.json({
    projects: db.projects,
    videos: [...db.videos].sort((a, b) => b.id - a.id),
    transcriptions: db.transcriptions,
    clips: [...db.clips].sort((a, b) => b.score - a.score),
    jobs: db.processingJobs,
    scoringConfig: db.scoringConfig,
  });
});

app.post('/api/projects', async (req, res) => {
  const { name, description } = req.body as { name?: string; description?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: 'Project name is required' });
    return;
  }
  const project = await mutateDb((db) => {
    const item = {
      id: db.nextIds.project++,
      userId: 1,
      name: name.trim(),
      description: (description ?? '').trim(),
      createdAt: new Date().toISOString(),
    };
    db.projects.push(item);
    return item;
  });
  res.status(201).json(project);
});

app.post('/api/videos/demo', async (req, res) => {
  try {
    // Gemini disabled by default
    const useAi = req.body?.useAi === true;
    const projectId = Number(req.body?.projectId) || 1;
    const demo = await processingQueue.run(() => generateDemoPodcastVideo());
    const meta = await analyzeVideo(demo.filePath);

    const { video, job } = await mutateDb((db) => {
      const videoId = db.nextIds.video++;
      const v = {
        id: videoId,
        projectId,
        title: 'ClipForge Architecture Podcast (Ep. 04)',
        filename: demo.filename,
        originalName: 'demo-podcast-ep04.mp4',
        fileUrl: `/storage/uploads/${demo.filename}`,
        thumbnailUrl: null as string | null,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        fps: meta.fps,
        hasAudio: meta.hasAudio,
        sizeBytes: demo.sizeBytes,
        status: 'processing' as const,
        createdAt: new Date().toISOString(),
      };
      db.videos.push(v);

      const jobId = db.nextIds.job++;
      const j = {
        id: jobId,
        projectId,
        videoId,
        stage: 'queued' as const,
        progress: 8,
        message: 'Queued demo podcast video for deterministic clipping...',
        useAi,
        updatedAt: new Date().toISOString(),
      };
      db.processingJobs.push(j);
      return { video: v, job: j };
    });

    const thumbUrl = await generateThumbnail(
      demo.filePath,
      `video-${video.id}-cover.jpg`,
      2.0
    );
    if (thumbUrl) {
      await mutateDb((db) => {
        const target = db.videos.find((item) => item.id === video.id);
        if (target) target.thumbnailUrl = thumbUrl;
      });
    }

    void runVideoPipeline({
      videoId: video.id,
      jobId: job.id,
      useAi,
      presetSegments: SAMPLE_PODCAST_SEGMENTS,
      transcriptSource: 'sample',
    });

    res.status(201).json({ video, job });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create demo video';
    res.status(500).json({ error: message });
  }
});

app.post('/api/videos/upload', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Please attach a valid video file (.mp4, .mov, .webm, .mkv).' });
      return;
    }

    const metaCheck = validateUploadedFileMeta(req.file);
    if (!metaCheck.valid) {
      safeUnlink(req.file.path);
      res.status(400).json({ error: metaCheck.error });
      return;
    }

    const title =
      (req.body.title as string | undefined)?.trim().slice(0, 120) ||
      req.file.originalname.replace(/\.[^.]+$/, '');
    const projectId = Number(req.body.projectId) || 1;
    const useAi = req.body.useAi === 'true' || req.body.useAi === true;
    const transcriptText = (req.body.transcriptText as string | undefined) ?? '';

    const result = await finalizeUploadedVideo({
      filePath: req.file.path,
      filename: req.file.filename,
      originalName: req.file.originalname,
      sizeBytes: req.file.size,
      title,
      projectId,
      useAi,
      transcriptText,
    });

    res.status(201).json(result);
  } catch (err) {
    if (req.file?.path) safeUnlink(req.file.path);
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    const message = err instanceof Error ? err.message : 'Upload failed';
    res.status(statusCode).json({ error: message });
  }
});

app.post('/api/videos/upload/init', (req, res) => {
  cleanupExpiredChunkSessions();
  const {
    filename,
    mimetype = 'video/mp4',
    sizeBytes,
    title,
    projectId,
    useAi = false,
    transcriptText = '',
  } = req.body as {
    filename?: string;
    mimetype?: string;
    sizeBytes?: number;
    title?: string;
    projectId?: number;
    useAi?: boolean;
    transcriptText?: string;
  };

  if (!filename || typeof sizeBytes !== 'number' || sizeBytes <= 0) {
    res.status(400).json({ error: 'Invalid upload metadata.' });
    return;
  }

  const check = validateUploadedFileMeta({
    originalname: filename,
    mimetype,
    size: sizeBytes,
  });
  if (!check.valid) {
    res.status(400).json({ error: check.error });
    return;
  }

  const diskCheck = hasEnoughDiskSpace(sizeBytes, STORAGE_ROOT);
  if (!diskCheck.ok) {
    res.status(507).json({
      error: `Insufficient host disk space for this upload (available: ${(
        diskCheck.availableBytes /
        (1024 * 1024 * 1024)
      ).toFixed(1)} GB). Configure S3/R2 object storage or free disk space.`,
    });
    return;
  }

  fs.mkdirSync(CHUNKS_DIR, { recursive: true });
  const uploadId = crypto.randomUUID();
  const safeFilename = generateSafeMediaFilename(filename);
  const tempPath = path.join(CHUNKS_DIR, `${uploadId}.part`);
  fs.writeFileSync(tempPath, Buffer.alloc(0));

  const now = Date.now();
  chunkUploadSessions.set(uploadId, {
    uploadId,
    safeFilename,
    originalName: path.basename(filename),
    tempPath,
    expectedSizeBytes: sizeBytes,
    receivedBytes: 0,
    chunkSizes: new Map<number, number>(),
    title:
      (title ?? '').trim().slice(0, 120) ||
      path.basename(filename).replace(/\.[^.]+$/, ''),
    projectId: Number(projectId) || 1,
    useAi: useAi === true,
    transcriptText: typeof transcriptText === 'string' ? transcriptText : '',
    createdAtMs: now,
    lastActivityMs: now,
    writeChain: Promise.resolve(),
  });

  res.status(201).json({
    uploadId,
    chunkSizeBytes: UPLOAD_CHUNK_BYTES,
    concurrency: 3,
  });
});

app.post(
  '/api/videos/upload/chunk/:uploadId',
  express.raw({ type: 'application/octet-stream', limit: '8mb' }),
  async (req, res) => {
    const session = chunkUploadSessions.get(req.params.uploadId);
    if (!session) {
      res.status(404).json({ error: 'Upload session not found or expired.' });
      return;
    }

    const chunk = req.body;
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
      res.status(400).json({ error: 'Empty upload chunk.' });
      return;
    }

    const rawIndex = req.query.index ?? req.headers['x-chunk-index'];
    const rawOffset = req.query.offset ?? req.headers['x-chunk-offset'];
    const hasPositionalArgs = rawIndex !== undefined && rawOffset !== undefined;
    const chunkIndex = hasPositionalArgs ? Number(rawIndex) : -1;
    const chunkOffset = hasPositionalArgs ? Number(rawOffset) : -1;

    if (
      hasPositionalArgs &&
      (!Number.isInteger(chunkIndex) ||
        chunkIndex < 0 ||
        !Number.isInteger(chunkOffset) ||
        chunkOffset < 0 ||
        chunkOffset + chunk.length > session.expectedSizeBytes ||
        chunkOffset + chunk.length > MAX_VIDEO_SIZE_BYTES)
    ) {
      res.status(400).json({ error: 'Invalid chunk index or byte offset.' });
      return;
    }

    if (!hasPositionalArgs && session.receivedBytes + chunk.length > MAX_VIDEO_SIZE_BYTES) {
      safeUnlink(session.tempPath);
      chunkUploadSessions.delete(session.uploadId);
      res.status(400).json({
        error: `Video exceeds maximum ${formatUploadLimitLabel()} limit.`,
      });
      return;
    }

    try {
      session.writeChain = session.writeChain.then(async () => {
        if (hasPositionalArgs) {
          const handle = await fs.promises.open(
            session.tempPath,
            fs.existsSync(session.tempPath) ? 'r+' : 'w+'
          );
          try {
            await handle.write(chunk, 0, chunk.length, chunkOffset);
          } finally {
            await handle.close();
          }
          session.chunkSizes.set(chunkIndex, chunk.length);
          let sum = 0;
          for (const sz of session.chunkSizes.values()) sum += sz;
          session.receivedBytes = sum;
        } else {
          await fs.promises.appendFile(session.tempPath, chunk);
          session.receivedBytes += chunk.length;
        }
        session.lastActivityMs = Date.now();
      });
      await session.writeChain;
      res.json({ ok: true, receivedBytes: session.receivedBytes });
    } catch (err) {
      safeUnlink(session.tempPath);
      chunkUploadSessions.delete(session.uploadId);
      const message = err instanceof Error ? err.message : 'Failed to write upload chunk.';
      res.status(500).json({ error: message });
    }
  }
);

app.post('/api/videos/upload/complete/:uploadId', async (req, res) => {
  const session = chunkUploadSessions.get(req.params.uploadId);
  if (!session) {
    res.status(404).json({ error: 'Upload session not found or expired.' });
    return;
  }
  chunkUploadSessions.delete(session.uploadId);

  try {
    await session.writeChain;
  } catch {
    // checked below
  }

  if (session.receivedBytes === 0 || !fs.existsSync(session.tempPath)) {
    safeUnlink(session.tempPath);
    res.status(400).json({ error: 'No video bytes were uploaded.' });
    return;
  }

  ensureStorageDirs();
  const finalPath = path.join(UPLOADS_DIR, session.safeFilename);
  try {
    await fs.promises.rename(session.tempPath, finalPath);
    const result = await finalizeUploadedVideo({
      filePath: finalPath,
      filename: session.safeFilename,
      originalName: session.originalName,
      sizeBytes: session.receivedBytes,
      title: session.title,
      projectId: session.projectId,
      useAi: session.useAi,
      transcriptText: session.transcriptText,
    });
    res.status(201).json(result);
  } catch (err) {
    safeUnlink(session.tempPath);
    safeUnlink(finalPath);
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    const message = err instanceof Error ? err.message : 'Failed to finalize uploaded video.';
    res.status(statusCode).json({ error: message });
  }
});

app.delete('/api/videos/upload/:uploadId', (req, res) => {
  const session = chunkUploadSessions.get(req.params.uploadId);
  if (session) {
    safeUnlink(session.tempPath);
    chunkUploadSessions.delete(session.uploadId);
  }
  res.json({ ok: true });
});

app.post('/api/uploads/presign', async (req, res) => {
  if (!isObjectStorageConfigured()) {
    res.status(501).json({
      error: 'Direct S3/R2 object storage is not configured on this server.',
    });
    return;
  }

  const { filename, mimetype = 'video/mp4', sizeBytes } = req.body as {
    filename?: string;
    mimetype?: string;
    sizeBytes?: number;
  };

  if (!filename || typeof sizeBytes !== 'number' || sizeBytes <= 0) {
    res.status(400).json({ error: 'Invalid upload metadata.' });
    return;
  }

  const check = validateUploadedFileMeta({
    originalname: filename,
    mimetype,
    size: sizeBytes,
  });
  if (!check.valid) {
    res.status(400).json({ error: check.error });
    return;
  }

  const safeFilename = generateSafeMediaFilename(filename);
  const key = `uploads/${safeFilename}`;
  const putUrl = await createPresignedPutUrl({
    key,
    contentType: mimetype || 'video/mp4',
    expiresInSeconds: 3600,
  });

  res.status(201).json({ key, putUrl });
});

app.post('/api/videos/from-storage', async (req, res) => {
  if (!isObjectStorageConfigured()) {
    res.status(501).json({ error: 'Object storage (S3/R2) is not configured.' });
    return;
  }

  try {
    const {
      key,
      originalName = 'uploaded-video.mp4',
      sizeBytes = 0,
      title,
      projectId = 1,
      useAi = false,
      transcriptText = '',
    } = req.body as {
      key?: string;
      originalName?: string;
      sizeBytes?: number;
      title?: string;
      projectId?: number;
      useAi?: boolean;
      transcriptText?: string;
    };

    if (!key || !key.startsWith('uploads/') || key.includes('..')) {
      res.status(400).json({ error: 'Invalid object storage key.' });
      return;
    }

    const readUrl = await buildReadableObjectUrl(key);
    const probed = await probeRemoteDirectUrl(readUrl);
    const numericProjectId = Number(projectId) || 1;
    const aiEnabled = useAi === true;
    const cleanTranscript = typeof transcriptText === 'string' ? transcriptText.trim() : '';
    const resolvedName = path.basename(originalName || probed.originalName);
    const resolvedTitle =
      (title ?? '').trim().slice(0, 120) ||
      resolvedName.replace(/\.[^.]+$/, '') ||
      'Uploaded Video';

    const { video, job } = await mutateDb((db) => {
      const videoId = db.nextIds.video++;
      const v = {
        id: videoId,
        projectId: numericProjectId,
        title: resolvedTitle,
        filename: path.basename(key),
        originalName: resolvedName,
        fileUrl: buildStoredObjectUrl(key),
        sourceUrl: `r2://${key}`,
        sourceType: 'url' as const,
        thumbnailUrl: null as string | null,
        duration: probed.meta.duration,
        width: probed.meta.width,
        height: probed.meta.height,
        fps: probed.meta.fps,
        hasAudio: probed.meta.hasAudio,
        sizeBytes: Number(sizeBytes) || probed.sizeBytes,
        status: 'processing' as const,
        createdAt: new Date().toISOString(),
      };
      db.videos.push(v);

      const jobId = db.nextIds.job++;
      const j = {
        id: jobId,
        projectId: numericProjectId,
        videoId,
        stage: 'queued' as const,
        progress: 10,
        message: 'Object storage video verified & queued (Audio-First + Fast Seek)...',
        useAi: aiEnabled,
        updatedAt: new Date().toISOString(),
      };
      db.processingJobs.push(j);
      return { video: v, job: j };
    });

    const thumbUrl = await generateThumbnail(
      readUrl,
      `video-${video.id}-cover.jpg`,
      Math.min(2, Math.max(0.2, probed.meta.duration * 0.15))
    );
    if (thumbUrl) {
      await mutateDb((db) => {
        const target = db.videos.find((item) => item.id === video.id);
        if (target) target.thumbnailUrl = thumbUrl;
      });
    }

    void runVideoPipeline({
      videoId: video.id,
      jobId: job.id,
      useAi: aiEnabled,
      suppliedTranscript: cleanTranscript,
    });

    res.status(201).json({ video, job });
  } catch (err) {
    const statusCode =
      err instanceof UrlIngestionError
        ? err.statusCode
        : (err as { statusCode?: number }).statusCode ?? 500;
    const message =
      err instanceof Error ? err.message : 'Failed to register uploaded object storage video';
    res.status(statusCode).json({ error: message });
  }
});

app.post('/api/videos/from-url', async (req, res) => {
  try {
    const {
      url,
      title,
      projectId = 1,
      useAi = false,
      transcriptText = '',
    } = req.body as {
      url?: string;
      title?: string;
      projectId?: number;
      useAi?: boolean;
      transcriptText?: string;
    };

    if (!url || !url.trim()) {
      res.status(400).json({ error: 'Please provide a video URL or YouTube link.' });
      return;
    }

    const urlCheck = validateSafeHttpUrl(url);
    if (!urlCheck.valid || !urlCheck.url) {
      res.status(400).json({ error: urlCheck.error });
      return;
    }

    const cleanUrl = urlCheck.url.toString();
    const numericProjectId = Number(projectId) || 1;
    const aiEnabled = useAi === true;
    const cleanTranscript = typeof transcriptText === 'string' ? transcriptText.trim() : '';

    if (isYouTubeUrl(cleanUrl)) {
      const yt = await processingQueue.run(() => ingestYouTubeUrl(cleanUrl));
      const result = await finalizeUploadedVideo({
        filePath: yt.filePath,
        filename: yt.filename,
        originalName: yt.originalName,
        sizeBytes: yt.sizeBytes,
        title: (title ?? '').trim().slice(0, 120) || yt.title,
        projectId: numericProjectId,
        useAi: aiEnabled,
        transcriptText: cleanTranscript,
      });

      // If YouTube provided native captions and user didn't override, persist them immediately
      if (!cleanTranscript && yt.segments.length > 0) {
        await mutateDb((db) => {
          db.transcriptions = db.transcriptions.filter((t) => t.videoId !== result.video.id);
          db.transcriptions.push({
            id: db.nextIds.transcription++,
            videoId: result.video.id,
            source: 'srt',
            language: 'auto',
            segments: yt.segments,
            createdAt: new Date().toISOString(),
          });
          const v = db.videos.find((item) => item.id === result.video.id);
          if (v) v.sourceType = 'youtube';
        });
      } else {
        await mutateDb((db) => {
          const v = db.videos.find((item) => item.id === result.video.id);
          if (v) v.sourceType = 'youtube';
        });
      }

      res.status(201).json(result);
      return;
    }

    // Direct remote video URL (MP4 / WebM / MOV / R2 / S3): Audio-First + HTTP Range Fast-Seek
    const probed = await probeRemoteDirectUrl(cleanUrl);
    const resolvedTitle =
      (title ?? '').trim().slice(0, 120) ||
      probed.originalName.replace(/\.[^.]+$/, '') ||
      'Remote Video';

    const { video, job } = await mutateDb((db) => {
      const videoId = db.nextIds.video++;
      const v = {
        id: videoId,
        projectId: numericProjectId,
        title: resolvedTitle,
        filename: probed.originalName,
        originalName: probed.originalName,
        fileUrl: cleanUrl,
        sourceUrl: cleanUrl,
        sourceType: 'url' as const,
        thumbnailUrl: null as string | null,
        duration: probed.meta.duration,
        width: probed.meta.width,
        height: probed.meta.height,
        fps: probed.meta.fps,
        hasAudio: probed.meta.hasAudio,
        sizeBytes: probed.sizeBytes,
        status: 'processing' as const,
        createdAt: new Date().toISOString(),
      };
      db.videos.push(v);

      const jobId = db.nextIds.job++;
      const j = {
        id: jobId,
        projectId: numericProjectId,
        videoId,
        stage: 'queued' as const,
        progress: 10,
        message: 'Remote video stream verified & queued (Audio-First + Fast Seek)...',
        useAi: aiEnabled,
        updatedAt: new Date().toISOString(),
      };
      db.processingJobs.push(j);
      return { video: v, job: j };
    });

    const thumbUrl = await generateThumbnail(
      cleanUrl,
      `video-${video.id}-cover.jpg`,
      Math.min(2, Math.max(0.2, probed.meta.duration * 0.15))
    );
    if (thumbUrl) {
      await mutateDb((db) => {
        const target = db.videos.find((item) => item.id === video.id);
        if (target) target.thumbnailUrl = thumbUrl;
      });
    }

    void runVideoPipeline({
      videoId: video.id,
      jobId: job.id,
      useAi: aiEnabled,
      suppliedTranscript: cleanTranscript,
    });

    res.status(201).json({ video, job });
  } catch (err) {
    const statusCode =
      err instanceof UrlIngestionError
        ? err.statusCode
        : (err as { statusCode?: number }).statusCode ?? 500;
    const message = err instanceof Error ? err.message : 'Failed to import video from URL';
    const extra =
      err instanceof UrlIngestionError
        ? {
            detectedTitle: err.detectedTitle,
            youtubeBlocked: err.youtubeBlocked,
          }
        : {};
    res.status(statusCode).json({ error: message, ...extra });
  }
});

app.post('/api/videos/:id/retry', async (req, res) => {
  const videoId = Number(req.params.id);
  const useAi = req.body?.useAi === true;
  const db = readDb();
  const video = db.videos.find((v) => v.id === videoId);
  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  const existingTranscript = db.transcriptions.find((t) => t.videoId === videoId);
  const job = await mutateDb((state) => {
    const j = {
      id: state.nextIds.job++,
      projectId: video.projectId,
      videoId,
      stage: 'queued' as const,
      progress: 10,
      message: 'Retrying video pipeline in sequential queue...',
      useAi,
      updatedAt: new Date().toISOString(),
    };
    state.processingJobs.push(j);
    const target = state.videos.find((v) => v.id === videoId);
    if (target) {
      target.status = 'processing';
      target.errorMessage = undefined;
    }
    return j;
  });

  void runVideoPipeline({
    videoId,
    jobId: job.id,
    useAi,
    presetSegments: existingTranscript?.segments,
    transcriptSource: existingTranscript?.source,
  });

  res.json({ job });
});

app.post('/api/videos/:id/process', async (req, res) => {
  const videoId = Number(req.params.id);
  const { useAi = false, transcriptText } = req.body as {
    useAi?: boolean;
    transcriptText?: string;
  };
  const db = readDb();
  const video = db.videos.find((v) => v.id === videoId);
  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  const existingTranscript = db.transcriptions.find((t) => t.videoId === videoId);

  const job = await mutateDb((state) => {
    const j = {
      id: state.nextIds.job++,
      projectId: video.projectId,
      videoId,
      stage: 'queued' as const,
      progress: 10,
      message: 'Re-running moment detection pipeline...',
      useAi,
      updatedAt: new Date().toISOString(),
    };
    state.processingJobs.push(j);
    return j;
  });

  void runVideoPipeline({
    videoId,
    jobId: job.id,
    useAi,
    suppliedTranscript: transcriptText,
    presetSegments: !transcriptText && existingTranscript ? existingTranscript.segments : undefined,
    transcriptSource: existingTranscript?.source,
  });

  res.json({ job });
});

app.get('/api/jobs/:videoId', (req, res) => {
  const videoId = Number(req.params.videoId);
  const db = readDb();
  const jobs = db.processingJobs.filter((j) => j.videoId === videoId);
  const latest = jobs[jobs.length - 1] ?? null;
  res.json({ job: latest });
});

const execFileAsync = promisify(execFile);
const PREVIEWS_DIR = path.join(STORAGE_ROOT, 'previews');
const activePreviewJobs = new Map<string, Promise<void>>();

app.get('/api/videos/:id/preview', async (req, res) => {
  const videoId = Number(req.params.id);
  const format = req.query.format === 'webm' ? 'webm' : 'mp4';
  const db = readDb();
  const video = db.videos.find((v) => v.id === videoId);
  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  const videoPath = await resolveVideoInputSource(video);
  if (!videoPath.startsWith('http') && !fs.existsSync(videoPath)) {
    res.status(404).json({ error: 'Source video file is missing on disk.' });
    return;
  }

  const rawStart = Number(req.query.start);
  const rawEnd = Number(req.query.end);
  const hasWindow = Number.isFinite(rawStart) || Number.isFinite(rawEnd);
  const totalDur = Math.max(1, video.duration || 60);
  const winStart = Number.isFinite(rawStart)
    ? Math.max(0, Math.min(totalDur - 1, Math.floor(rawStart)))
    : 0;
  // Cap any single transcode slice to 75 seconds so long videos respond in ~2-4s instead of timing out
  const maxSlice = 75;
  const targetEnd = Number.isFinite(rawEnd)
    ? Math.max(winStart + 2, Math.min(totalDur, Math.ceil(rawEnd)))
    : Math.min(totalDur, winStart + (totalDur > 90 ? 60 : totalDur));
  const winDur = Math.max(2, Math.min(maxSlice, targetEnd - winStart));

  fs.mkdirSync(PREVIEWS_DIR, { recursive: true });
  const cacheTag = hasWindow || totalDur > 90 ? `w${winStart}-${Math.round(winDur)}` : 'full';
  const outPath = path.join(PREVIEWS_DIR, `video-${video.id}-${cacheTag}-preview.${format}`);

  try {
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      let pending = activePreviewJobs.get(outPath);
      if (!pending) {
        const tmpPath = `${outPath}.tmp.${Date.now()}.${format}`;
        const seekArgs = hasWindow || totalDur > 90
          ? ['-ss', winStart.toFixed(2), '-t', winDur.toFixed(2)]
          : [];
        const args =
          format === 'webm'
            ? [
                '-y',
                ...seekArgs,
                '-i',
                videoPath,
                '-vf',
                'scale=-2:480',
                '-r',
                '30',
                '-c:v',
                'libvpx',
                '-deadline',
                'realtime',
                '-cpu-used',
                '8',
                '-b:v',
                '900k',
                ...(video.hasAudio ? ['-c:a', 'libopus', '-b:a', '96k'] : ['-an']),
                tmpPath,
              ]
            : [
                '-y',
                ...seekArgs,
                '-i',
                videoPath,
                '-vf',
                'scale=-2:480',
                '-r',
                '30',
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-crf',
                '26',
                '-pix_fmt',
                'yuv420p',
                '-movflags',
                '+faststart',
                ...(video.hasAudio ? ['-c:a', 'aac', '-b:a', '96k'] : ['-an']),
                tmpPath,
              ];

        pending = execFileAsync('ffmpeg', args, { timeout: 90000 })
          .then(() => {
            fs.renameSync(tmpPath, outPath);
          })
          .catch((err) => {
            safeUnlink(tmpPath);
            throw err;
          })
          .finally(() => {
            activePreviewJobs.delete(outPath);
          });
        activePreviewJobs.set(outPath, pending);
      }
      await pending;
    }

    res.sendFile(outPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Preview generation failed';
    res.status(500).json({ error: message });
  }
});

app.delete('/api/videos/:id', async (req, res) => {
  const videoId = Number(req.params.id);
  const storageBefore = getStorageUsageBytes();
  const db = readDb();
  const video = db.videos.find((v) => v.id === videoId);
  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  if (!video.sourceUrl) {
    safeUnlink(path.join(UPLOADS_DIR, path.basename(video.filename)));
  }
  if (fs.existsSync(PREVIEWS_DIR)) {
    for (const f of fs.readdirSync(PREVIEWS_DIR)) {
      if (f.startsWith(`video-${video.id}-`)) {
        safeUnlink(path.join(PREVIEWS_DIR, f));
      }
    }
  }
  const videoClips = db.clips.filter((c) => c.videoId === videoId);
  const remoteUrls: Array<string | null | undefined> = [
    video.sourceUrl,
    video.fileUrl,
    video.thumbnailUrl,
  ];
  for (const clip of videoClips) {
    remoteUrls.push(clip.exportedUrl, clip.srtUrl, clip.thumbnailUrl);
    if (clip.exportedUrl) safeUnlink(path.join(CLIPS_DIR, path.basename(clip.exportedUrl)));
    if (clip.srtUrl) safeUnlink(path.join(CLIPS_DIR, path.basename(clip.srtUrl)));
    for (const variant of Object.values(clip.exportVariants ?? {})) {
      remoteUrls.push(variant?.exportedUrl, variant?.srtUrl, variant?.thumbnailUrl);
      if (variant?.exportedUrl) safeUnlink(path.join(CLIPS_DIR, path.basename(variant.exportedUrl)));
      if (variant?.srtUrl) safeUnlink(path.join(CLIPS_DIR, path.basename(variant.srtUrl)));
    }
  }

  await mutateDb((state) => {
    state.videos = state.videos.filter((v) => v.id !== videoId);
    state.transcriptions = state.transcriptions.filter((t) => t.videoId !== videoId);
    state.clips = state.clips.filter((c) => c.videoId !== videoId);
    state.processingJobs = state.processingJobs.filter((j) => j.videoId !== videoId);
  });

  let removedArtifacts = removeClipArtifactsByIds(videoClips.map((clip) => clip.id));
  removedArtifacts += await deleteStoredUrls(remoteUrls);
  removedArtifacts += reconcileOrphanedClipArtifacts();
  for (const filename of fs.readdirSync(THUMBNAILS_DIR)) {
    if (filename.startsWith(`video-${videoId}-`)) {
      safeUnlink(path.join(THUMBNAILS_DIR, filename));
      removedArtifacts++;
    }
  }
  for (const filename of fs.readdirSync(TRANSCRIPTS_DIR)) {
    if (filename.startsWith(`video-${videoId}-`)) {
      safeUnlink(path.join(TRANSCRIPTS_DIR, filename));
      removedArtifacts++;
    }
  }

  res.json({
    ok: true,
    removedArtifacts,
    removedBytes: Math.max(0, storageBefore - getStorageUsageBytes()),
  });
});

app.patch('/api/transcriptions/:videoId', async (req, res) => {
  const videoId = Number(req.params.videoId);
  const { segments } = req.body as { segments?: TranscriptSegment[] };
  if (!Array.isArray(segments)) {
    res.status(400).json({ error: 'segments array is required' });
    return;
  }
  const updated = await mutateDb((db) => {
    const existing = db.transcriptions.find((t) => t.videoId === videoId);
    if (!existing) return null;
    existing.segments = segments;
    return existing;
  });
  if (!updated) {
    res.status(404).json({ error: 'Transcription not found for this video' });
    return;
  }
  res.json(updated);
});

app.post('/api/transcriptions/:videoId/import-srt', srtUpload.single('srt'), async (req, res) => {
  const videoId = Number(req.params.videoId);
  const db = readDb();
  const video = db.videos.find((v) => v.id === videoId);
  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  const rawSrt = req.file
    ? req.file.buffer.toString('utf-8')
    : typeof req.body?.srtText === 'string'
    ? req.body.srtText
    : '';

  if (!rawSrt.trim()) {
    res.status(400).json({ error: 'Please attach an .srt file or provide srtText.' });
    return;
  }

  const segments = parseSrtFileContent(rawSrt);
  if (segments.length === 0) {
    res.status(400).json({
      error: 'No valid SRT cue blocks found (expected format: 00:00:01,000 --> 00:00:04,000).',
    });
    return;
  }

  const transcription = await mutateDb((state) => {
    const existing = state.transcriptions.find((t) => t.videoId === videoId);
    if (existing) {
      existing.segments = segments;
      existing.source = 'srt';
      return existing;
    }
    const created = {
      id: state.nextIds.transcription++,
      videoId,
      source: 'srt' as const,
      language: 'auto',
      segments,
      createdAt: new Date().toISOString(),
    };
    state.transcriptions.push(created);
    return created;
  });

  res.json({ transcription, importedCount: segments.length });
});

app.post('/api/clips', async (req, res) => {
  const { videoId, startTime, endTime, title } = req.body as {
    videoId: number;
    startTime: number;
    endTime: number;
    title?: string;
  };
  const db = readDb();
  const video = db.videos.find((v) => v.id === videoId);
  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  const start = Math.max(0, Math.min(video.duration - 2, Number(startTime) || 0));
  const end = Math.max(start + 2, Math.min(video.duration, Number(endTime) || start + 15));
  const trans = db.transcriptions.find((t) => t.videoId === videoId);
  const segsInRange = (trans?.segments ?? []).filter(
    (s) => s.end > start && s.start < end
  );
  const scored = scoreWindow(
    segsInRange.length > 0
      ? segsInRange
      : [{ id: 'manual', start, end, text: title || 'Custom segment' }],
    db.scoringConfig
  );

  const nextId = db.nextIds.clip;
  const videoPath = await resolveVideoInputSource(video);
  const thumbUrl = await generateThumbnail(
    videoPath,
    `clip-${nextId}-preview.jpg`,
    (start + end) / 2
  );

  const clip = await mutateDb((state) => {
    const clipId = state.nextIds.clip++;
    const item: ClipRecord = {
      id: clipId,
      videoId,
      title: title?.trim() || scored.title,
      hookText: scored.hookText,
      hookType: scored.hookType,
      contextStatus: scored.contextStatus,
      sceneChanges: scored.sceneChanges,
      startTime: Math.round(start * 100) / 100,
      endTime: Math.round(end * 100) / 100,
      score: scored.score,
      breakdown: scored.breakdown,
      reason: scored.reason,
      scoringSource: 'manual',
      status: 'approved',
      aspectRatio: '9:16',
      framingMode: 'crop',
      cropX: 50,
      cropY: 50,
      zoom: 1.0,
      compositions: ensureClipCompositions({}),
      exportVariants: {},
      subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
      exportedUrl: null,
      srtUrl: null,
      thumbnailUrl: thumbUrl ?? video.thumbnailUrl,
      createdAt: new Date().toISOString(),
    };
    state.clips.push(item);
    return item;
  });

  res.status(201).json(clip);
});

app.patch('/api/clips/:id', async (req, res) => {
  const clipId = Number(req.params.id);
  const patch = req.body as Partial<ClipRecord>;

  const updated = await mutateDb((db) => {
    const clip = db.clips.find((c) => c.id === clipId);
    if (!clip) return null;

    if (typeof patch.title === 'string') clip.title = patch.title;
    if (typeof patch.startTime === 'number') clip.startTime = Math.max(0, patch.startTime);
    if (typeof patch.endTime === 'number')
      clip.endTime = Math.max(clip.startTime + 1, patch.endTime);
    if (patch.status) clip.status = patch.status;
    if (patch.aspectRatio) clip.aspectRatio = patch.aspectRatio;
    if (patch.framingMode) clip.framingMode = patch.framingMode;
    if (typeof patch.cropX === 'number') clip.cropX = Math.min(100, Math.max(0, patch.cropX));
    if (typeof patch.cropY === 'number') clip.cropY = Math.min(100, Math.max(0, patch.cropY));
    if (typeof patch.zoom === 'number') clip.zoom = Math.min(2, Math.max(1, patch.zoom));
    if (patch.compositions) {
      clip.compositions = {
        ...ensureClipCompositions(clip),
        ...patch.compositions,
      };
    }
    if (patch.subtitleStyle) {
      clip.subtitleStyle = { ...clip.subtitleStyle, ...patch.subtitleStyle };
    }
    return clip;
  });

  if (!updated) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  res.json(updated);
});

app.post('/api/clips/:id/rescore', async (req, res) => {
  try {
    const clipId = Number(req.params.id);
    const useAi = req.body?.useAi === true;
    const db = readDb();
    const clip = db.clips.find((c) => c.id === clipId);
    if (!clip) {
      res.status(404).json({ error: 'Clip not found' });
      return;
    }
    const trans = db.transcriptions.find((t) => t.videoId === clip.videoId);
    const segsInRange = (trans?.segments ?? []).filter(
      (s) => s.end > clip.startTime && s.start < clip.endTime
    );
    const segs =
      segsInRange.length > 0
        ? segsInRange
        : [{ id: 'range', start: clip.startTime, end: clip.endTime, text: clip.title }];

    const heuristicResult = scoreWindow(segs, db.scoringConfig);
    let finalScore = heuristicResult.score;
    let finalBreakdown = heuristicResult.breakdown;
    let finalReason = heuristicResult.reason;
    let finalHookText = heuristicResult.hookText;
    let scoringSource: 'heuristic' | 'gemini' = 'heuristic';

    if (useAi && isGeminiConfigured()) {
      try {
        const evaluated = await refineCandidatesWithGemini(
          [
            {
              title: clip.title,
              hookText: heuristicResult.hookText,
              hookType: heuristicResult.hookType,
              contextStatus: heuristicResult.contextStatus,
              sceneChanges: heuristicResult.sceneChanges,
              startTime: clip.startTime,
              endTime: clip.endTime,
              score: heuristicResult.score,
              breakdown: heuristicResult.breakdown,
              reason: heuristicResult.reason,
              transcriptExcerpt: segs.map((s) => s.text).join(' '),
            },
          ],
          db.scoringConfig
        );
        if (evaluated[0]) {
          finalScore = evaluated[0].score;
          finalBreakdown = evaluated[0].breakdown;
          finalReason = evaluated[0].reason;
          finalHookText = evaluated[0].hookText;
          scoringSource = 'gemini';
        }
      } catch {
        // Deterministic fallback if Gemini fails
        finalReason = `${heuristicResult.reason} (Gemini fallback -> heuristic)`;
      }
    }

    const updated = await mutateDb((state) => {
      const target = state.clips.find((c) => c.id === clipId);
      if (!target) return null;
      target.score = finalScore;
      target.breakdown = finalBreakdown;
      target.reason = finalReason;
      target.hookText = finalHookText;
      target.hookType = heuristicResult.hookType;
      target.contextStatus = heuristicResult.contextStatus;
      target.scoringSource = scoringSource;
      return target;
    });

    res.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Rescore failed';
    res.status(500).json({ error: message });
  }
});

app.post('/api/clips/:id/compile', async (req, res) => {
  try {
    const clipId = Number(req.params.id);
    const variant: CompositionVariant = req.query.variant === 'horizontal' ? 'horizontal' : 'vertical';
    const db = readDb();
    const clip = db.clips.find((c) => c.id === clipId);
    if (!clip) {
      res.status(404).json({ error: 'Clip not found' });
      return;
    }
    const video = db.videos.find((v) => v.id === clip.videoId);
    if (!video) {
      res.status(404).json({ error: 'Source video not found' });
      return;
    }
    const trans = db.transcriptions.find((t) => t.videoId === clip.videoId);
    const videoPath = await resolveVideoInputSource(video);
    const previousVariant = clip.exportVariants?.[variant];

    // Serialize heavy FFmpeg rendering through the single-worker queue
    const rendered = await processingQueue.run(() =>
      renderClipWithFfmpeg({
        clip,
        videoPath,
        hasAudio: video.hasAudio,
        segments: trans?.segments ?? [],
        variant,
      })
    );

    const updated = await mutateDb((state) => {
      const target = state.clips.find((c) => c.id === clipId);
      if (!target) return null;
      target.exportedUrl = rendered.exportedUrl;
      target.srtUrl = rendered.srtUrl;
      target.exportedSizeBytes = rendered.exportedSizeBytes;
      if (rendered.thumbnailUrl) target.thumbnailUrl = rendered.thumbnailUrl;
      target.exportVariants = {
        ...(target.exportVariants ?? {}),
        [variant]: rendered,
      };
      target.aspectRatio = variant === 'vertical' ? '9:16' : '16:9';
      target.status = 'exported';
      return target;
    });

    await deleteStoredUrls([
      previousVariant?.exportedUrl && previousVariant.exportedUrl !== rendered.exportedUrl
        ? previousVariant.exportedUrl
        : null,
      previousVariant?.srtUrl && previousVariant.srtUrl !== rendered.srtUrl
        ? previousVariant.srtUrl
        : null,
      previousVariant?.thumbnailUrl && previousVariant.thumbnailUrl !== rendered.thumbnailUrl
        ? previousVariant.thumbnailUrl
        : null,
    ]);

    res.json(updated);
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : 'FFmpeg compilation failed';
    const diagnostic = rawMessage
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3)
      .join(' ')
      .slice(0, 700);
    const message = rawMessage.includes('maxBuffer')
      ? 'FFmpeg produced too much diagnostic output. The render was stopped safely; retry after restarting the server.'
      : `FFmpeg could not compile this clip. ${diagnostic}`;
    res.status(500).json({ error: message });
  }
});

app.get('/api/clips/:id/download', async (req, res) => {
  const clipId = Number(req.params.id);
  const format = req.query.format === 'srt' ? 'srt' : 'mp4';
  const db = readDb();
  const clip = db.clips.find((c) => c.id === clipId);
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }

  const variant: CompositionVariant = req.query.variant === 'horizontal' ? 'horizontal' : 'vertical';
  const variantExport = clip.exportVariants?.[variant];
  const targetUrl = format === 'srt'
    ? variantExport?.srtUrl ?? clip.srtUrl
    : variantExport?.exportedUrl ?? clip.exportedUrl;
  if (!targetUrl) {
    res.status(400).json({ error: 'Clip has not been compiled yet. Click Compile & Export first.' });
    return;
  }

  const objectKey = extractStoredObjectKey(targetUrl);
  if (objectKey) {
    res.redirect(307, await buildReadableObjectUrl(objectKey));
    return;
  }
  if (/^https?:\/\//i.test(targetUrl)) {
    res.redirect(307, targetUrl);
    return;
  }

  const filename = path.basename(targetUrl);
  const fullPath = path.join(CLIPS_DIR, filename);
  if (!fs.existsSync(fullPath)) {
    res.status(404).json({ error: 'Rendered file missing on disk. Recompile the clip.' });
    return;
  }

  const safeDownloadName =
    clip.title.replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase().slice(0, 48) || `clip-${clip.id}`;
  res.download(fullPath, `${safeDownloadName}.${format}`);
});

app.delete('/api/clips/:id', async (req, res) => {
  const clipId = Number(req.params.id);
  const clip = readDb().clips.find((c) => c.id === clipId);
  if (clip?.exportedUrl) safeUnlink(path.join(CLIPS_DIR, path.basename(clip.exportedUrl)));
  if (clip?.srtUrl) safeUnlink(path.join(CLIPS_DIR, path.basename(clip.srtUrl)));
  for (const variant of Object.values(clip?.exportVariants ?? {})) {
    if (variant?.exportedUrl) safeUnlink(path.join(CLIPS_DIR, path.basename(variant.exportedUrl)));
    if (variant?.srtUrl) safeUnlink(path.join(CLIPS_DIR, path.basename(variant.srtUrl)));
  }
  await mutateDb((db) => {
    db.clips = db.clips.filter((c) => c.id !== clipId);
  });
  const remoteUrls = clip
    ? [
        clip.exportedUrl,
        clip.srtUrl,
        clip.thumbnailUrl,
        ...Object.values(clip.exportVariants ?? {}).flatMap((variant) => [
          variant?.exportedUrl,
          variant?.srtUrl,
          variant?.thumbnailUrl,
        ]),
      ]
    : [];
  const removedArtifacts =
    removeClipArtifactsByIds([clipId]) +
    reconcileOrphanedClipArtifacts() +
    await deleteStoredUrls(remoteUrls);
  res.json({ ok: true, removedArtifacts });
});

app.put('/api/scoring-config', async (req, res) => {
  const patch = req.body as Partial<ScoringConfig>;
  const updated = await mutateDb((db) => {
    db.scoringConfig = { ...db.scoringConfig, ...patch };
    return db.scoringConfig;
  });
  res.json(updated);
});

app.post('/api/scoring-lab/test', (req, res) => {
  const { transcript, config } = req.body as {
    transcript?: string;
    config?: ScoringConfig;
  };
  if (!transcript?.trim()) {
    res.status(400).json({ error: 'Provide transcript or SRT text to evaluate.' });
    return;
  }
  const db = readDb();
  const activeConfig = config ?? db.scoringConfig;
  const segments = parseSrtOrTextTranscript(transcript, 120);
  const candidates = detectCandidateClipsHeuristic(segments, activeConfig);
  res.json({ segments, candidates });
});

app.post('/api/storage/cleanup', (_req, res) => {
  const queue = processingQueue.getStats();
  if (queue.active > 0 || queue.queued > 0) {
    res.status(409).json({
      error: 'Storage cannot be purged while videos or clips are being processed.',
    });
    return;
  }
  const report = purgeUnreferencedStorage();
  res.json({
    ok: true,
    removed: report.removedFiles,
    removedFiles: report.removedFiles,
    removedBytes: report.removedBytes,
    storageBytes: getStorageUsageBytes(),
  });
});

// Express error handler for multer / upload validation errors
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (err instanceof Error) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
);

async function startServer() {
  const port = Number(process.env.PORT) || 3000;

  app.listen(port, '0.0.0.0', () => {
    console.log(`ClipForge backend running on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start ClipForge server:', err);
  process.exit(1);
});
