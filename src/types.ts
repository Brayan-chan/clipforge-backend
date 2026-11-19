export type AspectRatio = '9:16' | '1:1' | '16:9';
export type FramingMode = 'crop' | 'blur';
export type CompositionLayout = 'focus' | 'stacked' | 'picture-in-picture';
export type CompositionFocus = 'auto' | 'camera' | 'content' | 'split';

export interface CompositionRegion {
  /** Percentages relative to the source frame (0..100). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ClipComposition {
  aspectRatio: '9:16' | '16:9';
  layout: CompositionLayout;
  focus: CompositionFocus;
  cameraEnabled: boolean;
  camera: CompositionRegion;
  content: CompositionRegion;
  cameraPosition: 'top' | 'bottom';
  cameraScale: number;
  creditEnabled: boolean;
  creditText: string;
}

export interface ClipExportVariant {
  exportedUrl: string;
  srtUrl: string;
  exportedSizeBytes: number;
  thumbnailUrl: string | null;
}
export type ClipStatus = 'candidate' | 'approved' | 'rejected' | 'exported';
export type ContextStatus = 'self-contained' | 'partial' | 'needs-context';
export type JobStage =
  | 'queued'
  | 'analyzing_video'
  | 'extracting_audio'
  | 'transcribing'
  | 'scoring_moments'
  | 'generating_thumbnails'
  | 'completed'
  | 'failed'
  | 'interrupted';

export interface User {
  id: number;
  email: string;
  name: string;
}

export interface Project {
  id: number;
  userId: number;
  name: string;
  description: string;
  createdAt: string;
}

export interface VideoRecord {
  id: number;
  projectId: number;
  title: string;
  filename: string;
  originalName: string;
  fileUrl: string;
  thumbnailUrl: string | null;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  sizeBytes: number;
  sourceUrl?: string;
  sourceType?: 'upload' | 'demo' | 'url' | 'youtube';
  status: 'uploaded' | 'processing' | 'ready' | 'error' | 'interrupted';
  errorMessage?: string;
  createdAt: string;
}

export interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionRecord {
  id: number;
  videoId: number;
  source: 'gemini' | 'srt' | 'manual' | 'sample';
  language: string;
  segments: TranscriptSegment[];
  createdAt: string;
}

export interface ClipScoreBreakdown {
  hook: number; // max 25
  infoValue: number; // max 25
  emotion: number; // max 20
  selfContained: number; // max 20
  durationFit: number; // max 10
}

export interface SubtitleStyle {
  enabled: boolean;
  preset: 'hormozi' | 'clean' | 'boxed' | 'minimal';
  fontSize: number;
  textColor: string;
  highlightColor: string;
  position: 'bottom' | 'center' | 'top';
  alignment: 'left' | 'center' | 'right';
  backgroundBox: boolean;
  /** Editable subtitle area as percentages of the exported frame. */
  region?: CompositionRegion;
}

export interface ClipRecord {
  id: number;
  videoId: number;
  title: string;
  hookText: string;
  hookType?: string;
  contextStatus?: ContextStatus;
  sceneChanges?: number;
  startTime: number;
  endTime: number;
  score: number;
  breakdown: ClipScoreBreakdown;
  reason: string;
  scoringSource: 'heuristic' | 'gemini' | 'manual';
  status: ClipStatus;
  aspectRatio: AspectRatio;
  framingMode: FramingMode;
  cropX: number; // 0..100
  cropY: number; // 0..100
  zoom: number; // 1.0..2.0
  compositions?: {
    vertical: ClipComposition;
    horizontal: ClipComposition;
  };
  exportVariants?: Partial<Record<'vertical' | 'horizontal', ClipExportVariant>>;
  subtitleStyle: SubtitleStyle;
  exportedUrl: string | null;
  srtUrl: string | null;
  thumbnailUrl: string | null;
  exportedSizeBytes?: number;
  createdAt: string;
}

export interface ProcessingJob {
  id: number;
  projectId: number;
  videoId: number;
  stage: JobStage;
  progress: number;
  message: string;
  useAi: boolean;
  updatedAt: string;
}

export interface ScoringConfig {
  hookWeight: number;
  infoWeight: number;
  emotionWeight: number;
  selfContainedWeight: number;
  durationWeight: number;
  llmThreshold: number;
  minClipSeconds: number;
  maxClipSeconds: number;
}

export interface SystemStatus {
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  geminiConfigured: boolean;
  maxUploadSizeBytes?: number;
  objectStorageConfigured?: boolean;
  storageBytes: number;
  activeQueueTasks: number;
  queuedTasks: number;
  tableCounts: {
    users: number;
    projects: number;
    videos: number;
    transcriptions: number;
    clips: number;
    processingJobs: number;
  };
}
