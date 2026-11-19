import fs from 'node:fs';
import path from 'node:path';
import type {
  ClipRecord,
  ProcessingJob,
  Project,
  ScoringConfig,
  SubtitleStyle,
  TranscriptionRecord,
  User,
  VideoRecord,
} from '../src/types';
import { buildReadableObjectUrl } from './processing/objectStorage';

export const STORAGE_ROOT = path.resolve(
  (process.env.STORAGE_ROOT ?? '').trim() || path.join(process.cwd(), 'storage')
);
export const UPLOADS_DIR = path.join(STORAGE_ROOT, 'uploads');
export const CLIPS_DIR = path.join(STORAGE_ROOT, 'clips');
export const THUMBNAILS_DIR = path.join(STORAGE_ROOT, 'thumbnails');
export const TRANSCRIPTS_DIR = path.join(STORAGE_ROOT, 'transcripts');
export const DB_FILE = path.join(STORAGE_ROOT, 'clipforge.db.json');

export async function resolveVideoInputSource(
  video: Pick<VideoRecord, 'filename' | 'sourceUrl'>
): Promise<string> {
  if (video.sourceUrl?.startsWith('r2://')) {
    return buildReadableObjectUrl(video.sourceUrl.slice('r2://'.length));
  }
  if (video.sourceUrl && /^https?:\/\//i.test(video.sourceUrl)) {
    return video.sourceUrl;
  }
  return path.join(UPLOADS_DIR, path.basename(video.filename));
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  enabled: true,
  preset: 'hormozi',
  fontSize: 22,
  textColor: '#FFFFFF',
  highlightColor: '#22C55E',
  position: 'bottom',
  alignment: 'center',
  backgroundBox: true,
  region: { x: 8, y: 72, width: 84, height: 20 },
};

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  hookWeight: 25,
  infoWeight: 25,
  emotionWeight: 20,
  selfContainedWeight: 20,
  durationWeight: 10,
  llmThreshold: 55,
  minClipSeconds: 12,
  maxClipSeconds: 60,
};

export interface DatabaseSchema {
  users: User[];
  projects: Project[];
  videos: VideoRecord[];
  transcriptions: TranscriptionRecord[];
  clips: ClipRecord[];
  processingJobs: ProcessingJob[];
  scoringConfig: ScoringConfig;
  nextIds: {
    user: number;
    project: number;
    video: number;
    transcription: number;
    clip: number;
    job: number;
  };
}

export function ensureStorageDirs(): void {
  for (const dir of [STORAGE_ROOT, UPLOADS_DIR, CLIPS_DIR, THUMBNAILS_DIR, TRANSCRIPTS_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function createInitialDb(): DatabaseSchema {
  return {
    users: [
      {
        id: 1,
        email: 'creator@clipforge.local',
        name: 'Studio Creator',
      },
    ],
    projects: [
      {
        id: 1,
        userId: 1,
        name: 'Podcast & Tech Clips MVP',
        description: 'Long-form interviews and builder episodes converted into 9:16 vertical shorts.',
        createdAt: new Date().toISOString(),
      },
    ],
    videos: [],
    transcriptions: [],
    clips: [],
    processingJobs: [],
    scoringConfig: { ...DEFAULT_SCORING_CONFIG },
    nextIds: {
      user: 2,
      project: 2,
      video: 1,
      transcription: 1,
      clip: 1,
      job: 1,
    },
  };
}

let cachedDb: DatabaseSchema | null = null;
let writeMutex: Promise<void> = Promise.resolve();

function atomicWriteSync(db: DatabaseSchema): void {
  ensureStorageDirs();
  const tmpFile = `${DB_FILE}.tmp.${process.pid}`;
  const payload = JSON.stringify(db, null, 2);
  fs.writeFileSync(tmpFile, payload, 'utf-8');
  fs.renameSync(tmpFile, DB_FILE);
}

export function readDb(): DatabaseSchema {
  ensureStorageDirs();
  if (cachedDb) return cachedDb;
  if (!fs.existsSync(DB_FILE)) {
    const initial = createInitialDb();
    atomicWriteSync(initial);
    cachedDb = initial;
    return cachedDb;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as DatabaseSchema;
    if (!parsed.scoringConfig) {
      parsed.scoringConfig = { ...DEFAULT_SCORING_CONFIG };
    }
    cachedDb = parsed;
    return cachedDb;
  } catch {
    const initial = createInitialDb();
    atomicWriteSync(initial);
    cachedDb = initial;
    return cachedDb;
  }
}

export function writeDb(db: DatabaseSchema): void {
  cachedDb = db;
  atomicWriteSync(db);
}

/**
 * Serializes mutations across concurrent async requests and writes atomically.
 */
export async function mutateDb<T>(mutator: (db: DatabaseSchema) => T | Promise<T>): Promise<T> {
  let result!: T;
  const run = async () => {
    const db = readDb();
    result = await mutator(db);
    writeDb(db);
  };
  writeMutex = writeMutex.then(run, run);
  await writeMutex;
  return result;
}

/**
 * Detects jobs & videos left in 'processing' state from an unexpected shutdown
 * and marks them 'interrupted' so users can retry cleanly.
 */
export function recoverInterruptedJobs(): number {
  const db = readDb();
  let recovered = 0;

  for (const job of db.processingJobs) {
    if (
      job.stage !== 'completed' &&
      job.stage !== 'failed' &&
      job.stage !== 'interrupted'
    ) {
      job.stage = 'interrupted';
      job.message = 'Task interrupted by server restart. Click Retry to resume.';
      job.updatedAt = new Date().toISOString();
      recovered++;
    }
  }

  for (const video of db.videos) {
    if (video.status === 'processing') {
      video.status = 'interrupted';
      video.errorMessage = 'Processing interrupted by restart. Ready to retry.';
      recovered++;
    }
  }

  if (recovered > 0) {
    writeDb(db);
  }
  return recovered;
}

export function getStorageUsageBytes(): number {
  ensureStorageDirs();
  let total = 0;
  const dirs = [
    UPLOADS_DIR,
    CLIPS_DIR,
    THUMBNAILS_DIR,
    TRANSCRIPTS_DIR,
    path.join(STORAGE_ROOT, 'previews'),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) total += stat.size;
      } catch {
        // ignore missing temp files
      }
    }
  }
  return total;
}
