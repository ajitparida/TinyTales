import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpenText,
  BookPlus,
  Camera,
  Check,
  Crop,
  FilePlus2,
  Focus,
  Globe,
  Image as ImageIcon,
  ImagePlus,
  Images,
  Layers,
  Loader2,
  Paintbrush,
  Palette,
  PenLine,
  RefreshCw,
  Scissors,
  Sparkles,
  Square,
  Star,
  Trash2,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import { AgeGroup, BackdropId, CharacterHotspot, Story, StoryPage } from '../types/story';
import {
  BACKDROP_ART_MAP,
  BACKDROP_SCENE_CATALOG,
  normalizeBackdropId,
} from '../data/curatedStories';
import {
  ArtCropBox,
  compressDataUrlForApi,
  fileToCompressedDataUrl,
  LOCAL_DISPLAY_MAX_DIM,
  LOCAL_DISPLAY_QUALITY,
  REDRAW_REF_MAX_DIM,
  REDRAW_REF_QUALITY,
  renderRedrawnSvgToWatercolorCanvas,
  renderSmartFramedArt,
  renderWatercolorStorybookStyle,
  sanitizeArtCropBox,
  SCAN_API_MAX_DIM,
  SCAN_API_QUALITY,
  yieldToBrowser,
} from '../lib/watercolorFilter';
import { resolveStoryMediaUrl, saveStoryMedia } from '../lib/mediaStore';
import { sanitizeId } from '../lib/firebase';
import { PageImageFramingModal } from './PageImageFramingModal';

type VisualMode = 'photo' | 'watercolor' | 'scene' | 'redraw';
type CaptureVisualMode = 'watercolor' | 'scene' | 'photo';
type TextMode = 'verbatim' | 'simplified';
type RedrawStyle = 'watercolor' | 'pastel' | 'gouache';
type CreateMode = 'scan' | 'manual';

const MAX_STORY_PAGES = 10;
const MAX_UPLOAD_BATCH = 6;
const SCAN_TIMEOUT_MS = 60_000;
const REDRAW_TIMEOUT_MS = 50_000;

/** Accepts image files even when mobile browsers (iOS/Android) omit file.type on camera/gallery uploads. */
function isLikelyImageFile(file: File): boolean {
  if (file.type && file.type.toLowerCase().startsWith('image/')) return true;
  return /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(file.name || '');
}

/** Keeps 1-2 photo scans razor-sharp while keeping 3-6 photo batches safely under Vercel's 4.5MB API body cap. */
function getAdaptiveScanUploadParams(photoCount: number): { maxDim: number; quality: number } {
  if (photoCount <= 2) return { maxDim: SCAN_API_MAX_DIM, quality: SCAN_API_QUALITY };
  if (photoCount <= 4) return { maxDim: 1120, quality: 0.76 };
  return { maxDim: 960, quality: 0.72 };
}

interface CapturedPageDraft {
  id: string;
  originalDataUrl: string;
  watercolorDataUrl: string | null;
  mimeType: string;
  visualMode: CaptureVisualMode;
}

interface ReviewedPageDraft {
  id: string;
  text: string;
  sceneSummary: string;
  visualMode: VisualMode;
  sceneBackdropId: BackdropId;
  artStyle: RedrawStyle;
  existingMediaId?: string;
  mediaDirty?: boolean;
  originalDataUrl: string | null;
  mimeType: string | null;
  watercolorDataUrl: string | null;
  redrawnDataUrl: string | null;
  framedOverrideUrl?: string | null;
  hasIllustration?: boolean;
  artCropBox?: ArtCropBox | null;
  smartFramedUrl?: string | null;
  isSmartFramed?: boolean;
  redrawNote?: string;
  isRedrawing?: boolean;
  redrawError?: string | null;
  redrawIsQuota?: boolean;
  hotspots: CharacterHotspot[];
}

interface StoryScannerProps {
  defaultAgeGroup: AgeGroup;
  isSignedIn: boolean;
  isAdmin?: boolean;
  isAlreadyPublished?: boolean;
  editingStory?: Story | null;
  initialCreateMode?: CreateMode;
  onCancel: () => void;
  onSaveStory: (story: Story, isUpdate: boolean, publishToMainSite?: boolean) => Promise<void>;
}

const REDRAW_STYLES: { id: RedrawStyle; label: string }[] = [
  { id: 'watercolor', label: 'Warm Watercolor' },
  { id: 'pastel', label: 'Soft Pastel' },
  { id: 'gouache', label: 'Woodland Gouache' },
];

class ApiRequestError extends Error {
  status?: number;
  code?: string;
  retryAfterSeconds?: number;

  constructor(
    message: string,
    opts?: { status?: number; code?: string; retryAfterSeconds?: number }
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = opts?.status;
    this.code = opts?.code;
    this.retryAfterSeconds = opts?.retryAfterSeconds;
  }
}

interface UploadProgressState {
  percent: number;
  label: string;
  detail?: string;
}

function ImageProgressBar({
  label,
  percent,
  detail,
}: {
  label: string;
  percent: number;
  detail?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="p-3.5 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#2F7A5E]/30 dark:border-[#E5A94C]/30 space-y-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-semibold text-[#1E5641] dark:text-[#F4D39B] flex items-center gap-2 min-w-0">
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-[#2F7A5E] dark:text-[#E5A94C]" />
          <span className="truncate">{label}</span>
        </span>
        <span className="font-mono tabular-nums font-semibold text-[#24292E] dark:text-[#EDE9DF] shrink-0">
          {clamped}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="h-2 w-full rounded-full bg-[#E6E1D8] dark:bg-[#27304A] overflow-hidden"
      >
        <div
          className="h-full rounded-full bg-[#2F7A5E] dark:bg-[#E5A94C] transition-[width] duration-150 ease-out"
          style={{ width: `${clamped}%` }}
        />
      </div>
      {detail && <div className="text-[11px] text-[#5C646B] dark:text-[#A4AEC2]">{detail}</div>}
    </div>
  );
}

function createStarterPageDraft(
  index: number,
  defaultStyle: RedrawStyle,
  text = '',
  defaultScene: BackdropId = 'meadow'
): ReviewedPageDraft {
  const newId = sanitizeId(`page_manual_${Date.now()}_${index + 1}_${Math.random().toString(36).slice(2, 5)}`);
  return {
    id: newId,
    text,
    sceneSummary: text
      ? `Warm children's storybook scene illustrating: ${text.slice(0, 180)}`
      : `Page ${index + 1} storybook illustration`,
    visualMode: 'scene',
    sceneBackdropId: defaultScene,
    artStyle: defaultStyle,
    mediaDirty: true,
    originalDataUrl: null,
    mimeType: null,
    watercolorDataUrl: null,
    redrawnDataUrl: null,
    framedOverrideUrl: null,
    hasIllustration: false,
    artCropBox: null,
    smartFramedUrl: null,
    isSmartFramed: false,
    hotspots: [
      {
        id: `hs_${newId}_1`,
        name: 'Story Friend',
        x: 45,
        y: 52,
        dialogue: 'Let us read this page together!',
        soundCue: 'chime',
        reaction: 'bounce',
      },
      {
        id: `hs_${newId}_2`,
        name: 'Little Helper',
        x: 68,
        y: 44,
        dialogue: 'What happens next in our story?',
        soundCue: 'twinkle',
        reaction: 'sparkle',
      },
    ],
  };
}

/**
 * Splits a full pasted or typed story into short, kid-friendly pages (1..maxPages)
 * purely client-side without dropping any words.
 */
function autoSplitFullStoryText(
  rawText: string,
  ageGroup: AgeGroup,
  maxPages = MAX_STORY_PAGES
): string[] {
  const normalized = rawText.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const targetWords = ageGroup === '2-3' ? 28 : 48;

  // Respect explicit paragraph breaks first
  const rawParagraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  // Break overly long paragraphs into sentences so every unit fits comfortably on a page
  const units: string[] = [];
  for (const para of rawParagraphs) {
    if (countWords(para) <= targetWords * 1.35) {
      units.push(para);
    } else {
      const sentences = para
        .split(/(?<=[.!?]["”']?)\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (sentences.length >= 2) {
        units.push(...sentences);
      } else {
        // Fallback for unpunctuated long blocks: split by words
        const words = para.split(/\s+/);
        for (let i = 0; i < words.length; i += targetWords) {
          units.push(words.slice(i, i + targetWords).join(' '));
        }
      }
    }
  }

  // Group units into short kid-friendly pages
  const grouped: string[] = [];
  let current = '';
  for (const unit of units) {
    if (!current) {
      current = unit;
      continue;
    }
    if (countWords(current) + countWords(unit) <= targetWords) {
      current = `${current} ${unit}`;
    } else {
      grouped.push(current);
      current = unit;
    }
  }
  if (current) grouped.push(current);

  if (grouped.length <= maxPages) {
    return grouped.map((p) => p.slice(0, 3000));
  }

  // Rebalance evenly across maxPages without losing any text
  const totalWords = units.reduce((acc, u) => acc + countWords(u), 0);
  const perPageTarget = Math.max(1, Math.ceil(totalWords / maxPages));
  const balanced: string[] = [];
  let bucket = '';
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (!bucket) {
      bucket = unit;
    } else if (
      balanced.length < maxPages - 1 &&
      countWords(bucket) + countWords(unit) > perPageTarget
    ) {
      balanced.push(bucket.slice(0, 3000));
      bucket = unit;
    } else {
      bucket = `${bucket} ${unit}`;
    }
  }
  if (bucket) balanced.push(bucket.slice(0, 3000));

  return balanced.slice(0, maxPages);
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Splits a page's story text cleanly near the midpoint along a paragraph break
 * or sentence boundary so both resulting pages read naturally without dropping words.
 */
function splitStoryTextCleanly(rawText: string): [string, string] {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return ['Write the first part of this page here.', 'Write the next moment of the story here.'];
  }

  // Prefer splitting between paragraphs if multiple exist
  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length >= 2) {
    const mid = Math.ceil(paragraphs.length / 2);
    return [paragraphs.slice(0, mid).join('\n\n'), paragraphs.slice(mid).join('\n\n')];
  }

  // Otherwise split on sentence boundaries nearest the midpoint
  const sentences = trimmed
    .split(/(?<=[.!?]["”']?)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length >= 2) {
    const totalChars = trimmed.length;
    let bestSplit = Math.ceil(sentences.length / 2);
    let bestDiff = Infinity;
    let running = 0;
    for (let i = 0; i < sentences.length - 1; i++) {
      running += sentences[i].length + 1;
      const diff = Math.abs(running - totalChars / 2);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestSplit = i + 1;
      }
    }
    return [sentences.slice(0, bestSplit).join(' '), sentences.slice(bestSplit).join(' ')];
  }

  // Fallback: split by words if one very long unpunctuated sentence
  const words = trimmed.split(/\s+/);
  if (words.length >= 6) {
    const mid = Math.ceil(words.length / 2);
    return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
  }

  return [trimmed, 'And what happened next in the story?'];
}

function getPageDisplayImage(page: ReviewedPageDraft, fallbackBackdrop: BackdropId): string {
  if (page.framedOverrideUrl) return page.framedOverrideUrl;
  if (page.visualMode === 'scene') {
    return BACKDROP_ART_MAP[page.sceneBackdropId || fallbackBackdrop] || BACKDROP_ART_MAP.meadow;
  }
  if (page.visualMode === 'redraw' && page.redrawnDataUrl) return page.redrawnDataUrl;
  if (page.isSmartFramed && page.smartFramedUrl) return page.smartFramedUrl;
  if (page.visualMode === 'watercolor' && page.watercolorDataUrl) return page.watercolorDataUrl;
  if (page.originalDataUrl) return page.originalDataUrl;
  if (page.redrawnDataUrl) return page.redrawnDataUrl;
  if (page.watercolorDataUrl) return page.watercolorDataUrl;
  return BACKDROP_ART_MAP[page.sceneBackdropId || fallbackBackdrop] || BACKDROP_ART_MAP.meadow;
}

/**
 * Safely posts JSON to an API route with timeout + AbortSignal support, handling
 * non-JSON HTML proxy responses and 429 free-tier quota responses cleanly.
 */
async function postApiJson<T extends Record<string, unknown>>(
  url: string,
  payload: unknown,
  fallbackError: string,
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<T> {
  const maxAttempts = 2;
  const timeoutMs = options?.timeoutMs ?? SCAN_TIMEOUT_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const onExternalAbort = () => controller.abort();
    if (options?.signal) {
      if (options.signal.aborted) {
        window.clearTimeout(timeoutId);
        throw new ApiRequestError('Scan cancelled.', { code: 'ABORTED' });
      }
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify(payload),
      });
    } catch (fetchErr) {
      window.clearTimeout(timeoutId);
      options?.signal?.removeEventListener('abort', onExternalAbort);
      if (options?.signal?.aborted) {
        throw new ApiRequestError('Scan cancelled.', { code: 'ABORTED' });
      }
      if (timedOut) {
        throw new ApiRequestError(
          'The request timed out on the free tier. Try scanning 1–3 photos at a time or continue manually with your photos.',
          { status: 504, code: 'TIMEOUT' }
        );
      }
      if (attempt < maxAttempts) {
        await new Promise((r) => window.setTimeout(r, 850));
        continue;
      }
      throw new ApiRequestError(
        fetchErr instanceof Error ? fetchErr.message : fallbackError,
        { code: 'NETWORK' }
      );
    } finally {
      window.clearTimeout(timeoutId);
      options?.signal?.removeEventListener('abort', onExternalAbort);
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const rawText = await response.text();
    const trimmed = rawText.trim();
    const looksLikeHtml =
      contentType.includes('text/html') ||
      trimmed.startsWith('<!') ||
      trimmed.toLowerCase().startsWith('<html');

    if (looksLikeHtml) {
      if (attempt < maxAttempts && (response.status >= 500 || response.status === 200)) {
        await new Promise((r) => window.setTimeout(r, 1000));
        continue;
      }
      if (response.status === 413) {
        throw new ApiRequestError(
          'Your photos were too large to scan all at once. Try scanning 1–3 photos at a time.',
          { status: 413 }
        );
      }
      if (response.status === 504 || response.status === 502 || response.status === 503) {
        throw new ApiRequestError(
          'The storybook scan took too long or the server was briefly busy. Please try again with 1–3 photos.',
          { status: response.status }
        );
      }
      throw new ApiRequestError(
        'The server returned a webpage instead of scan results (your preview session may have refreshed). Please reload the page and try scanning again.',
        { status: response.status }
      );
    }

    let parsed: T;
    try {
      parsed = (trimmed ? JSON.parse(trimmed) : {}) as T;
    } catch {
      if (attempt < maxAttempts && response.status >= 500) {
        await new Promise((r) => window.setTimeout(r, 850));
        continue;
      }
      throw new ApiRequestError(`${fallbackError} (HTTP ${response.status}). Please try again.`, {
        status: response.status,
      });
    }

    if (!response.ok) {
      const serverMsg =
        typeof parsed.error === 'string' && parsed.error.trim() ? parsed.error : fallbackError;
      const code = typeof parsed.code === 'string' ? parsed.code : undefined;
      const retryAfterSeconds =
        typeof parsed.retryAfterSeconds === 'number' ? parsed.retryAfterSeconds : undefined;
      throw new ApiRequestError(serverMsg, {
        status: response.status,
        code: response.status === 429 ? code || 'QUOTA_EXCEEDED' : code,
        retryAfterSeconds,
      });
    }

    return parsed;
  }

  throw new ApiRequestError(fallbackError);
}

async function requestAiRedrawIllustration(params: {
  imageBase64?: string | null;
  mimeType?: string | null;
  includePhotoRef?: boolean;
  sceneSummary?: string;
  pageText?: string;
  artStyle: RedrawStyle;
  pageNumber?: number;
  totalPages?: number;
  signal?: AbortSignal;
}): Promise<{ dataUrl: string; styleNote: string }> {
  const payload: Record<string, unknown> = {
    sceneSummary: params.sceneSummary,
    pageText: params.pageText,
    artStyle: params.artStyle,
    pageNumber: params.pageNumber,
    totalPages: params.totalPages,
  };
  if (
    params.includePhotoRef !== false &&
    params.imageBase64 &&
    params.mimeType &&
    params.imageBase64.startsWith('data:image/')
  ) {
    // Lightweight 512px reference thumbnail minimizes free-tier token usage & latency
    const compactRef = await compressDataUrlForApi(
      params.imageBase64,
      REDRAW_REF_MAX_DIM,
      REDRAW_REF_QUALITY
    );
    payload.imageBase64 = compactRef.dataUrl;
    payload.mimeType = compactRef.mimeType;
  }

  const data = await postApiJson<{ svg?: string; styleNote?: string; error?: string }>(
    '/api/stories/redraw',
    payload,
    'Could not generate storybook illustration.',
    { signal: params.signal, timeoutMs: REDRAW_TIMEOUT_MS }
  );
  if (typeof data.svg !== 'string') {
    throw new ApiRequestError(data.error || 'Could not generate storybook illustration.');
  }
  const renderedDataUrl = await renderRedrawnSvgToWatercolorCanvas(data.svg);
  return {
    dataUrl: renderedDataUrl,
    styleNote: String(data.styleNote || 'Illustrated in warm storybook style.'),
  };
}

export function StoryScanner({
  defaultAgeGroup,
  isSignedIn,
  isAdmin = false,
  isAlreadyPublished = false,
  editingStory = null,
  initialCreateMode = 'scan',
  onCancel,
  onSaveStory,
}: StoryScannerProps) {
  const isEditMode = Boolean(editingStory);
  const [createMode, setCreateMode] = useState<CreateMode>(initialCreateMode);
  const [publishToMainSite, setPublishToMainSite] = useState<boolean>(isAlreadyPublished);

  useEffect(() => {
    setPublishToMainSite(isAlreadyPublished);
  }, [isAlreadyPublished, editingStory?.id]);

  const [step, setStep] = useState<'capture' | 'converting' | 'review'>(
    isEditMode || initialCreateMode === 'manual' ? 'review' : 'capture'
  );
  const [isHydratingEdit, setIsHydratingEdit] = useState(isEditMode);
  const [ageGroup, setAgeGroup] = useState<AgeGroup>(editingStory?.ageGroup || defaultAgeGroup);
  const [textMode, setTextMode] = useState<TextMode>('verbatim');
  const [autoSplitPages, setAutoSplitPages] = useState<boolean>(true);
  const [titleHint, setTitleHint] = useState('');
  const [defaultVisualMode, setDefaultVisualMode] = useState<CaptureVisualMode>('watercolor');
  const [defaultRedrawStyle, setDefaultRedrawStyle] = useState<RedrawStyle>('watercolor');
  const [capturedPages, setCapturedPages] = useState<CapturedPageDraft[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [studioBanner, setStudioBanner] = useState<string | null>(null);
  const [conversionStatus, setConversionStatus] = useState(
    'Optimizing photos for fast free-tier scanning...'
  );
  const [conversionProgress, setConversionProgress] = useState<number>(0);

  // Abort controllers for responsive scan & batch cancellation
  const scanAbortRef = useRef<AbortController | null>(null);
  const batchAbortRef = useRef<AbortController | null>(null);

  // Live camera capture modal state
  const [cameraOpen, setCameraOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Review / Edit Studio draft state
  const [draftTitle, setDraftTitle] = useState(editingStory?.title || '');
  const [draftSubtitle, setDraftSubtitle] = useState(editingStory?.subtitle || '');
  const [draftMoralTitle, setDraftMoralTitle] = useState(editingStory?.moralTitle || '');
  const [draftMoralLesson, setDraftMoralLesson] = useState(editingStory?.moralLesson || '');
  const [draftDiscussionPrompt, setDraftDiscussionPrompt] = useState(
    editingStory?.parentDiscussionPrompt || ''
  );
  const [draftBackdrop, setDraftBackdrop] = useState<BackdropId>(
    normalizeBackdropId(editingStory?.coverFallbackId, 'meadow')
  );
  const [coverPageIndex, setCoverPageIndex] = useState<number>(0);
  const [reviewedPages, setReviewedPages] = useState<ReviewedPageDraft[]>(() =>
    !isEditMode && initialCreateMode === 'manual' ? [createStarterPageDraft(0, 'watercolor')] : []
  );
  const [framingPageId, setFramingPageId] = useState<string | null>(null);
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [batchProgressText, setBatchProgressText] = useState<string | null>(null);
  const [batchProgressPercent, setBatchProgressPercent] = useState<number>(0);
  const [isSaving, setIsSaving] = useState(false);
  const [isSnappingPhoto, setIsSnappingPhoto] = useState(false);
  const [isAddingCaptureFiles, setIsAddingCaptureFiles] = useState(false);
  const [isBulkUploadingImages, setIsBulkUploadingImages] = useState(false);
  const [replacingPageId, setReplacingPageId] = useState<string | null>(null);
  const [replacingPageProgress, setReplacingPageProgress] = useState<{
    pageId: string;
    percent: number;
    stage: string;
  } | null>(null);
  const [isLoadingManualPhotos, setIsLoadingManualPhotos] = useState(false);
  const [captureUploadProgress, setCaptureUploadProgress] = useState<UploadProgressState | null>(
    null
  );
  const [studioUploadProgress, setStudioUploadProgress] = useState<UploadProgressState | null>(
    null
  );

  // Manual quick-paste & bulk local image uploader state
  const [showManualPasteBox, setShowManualPasteBox] = useState(
    !isEditMode && initialCreateMode === 'manual'
  );
  const [manualFullText, setManualFullText] = useState('');

  // Inline "Import Extra Photos" state (inside Review / Edit Studio)
  const [showExtraImporter, setShowExtraImporter] = useState(false);
  const [isImportingExtra, setIsImportingExtra] = useState(false);
  const [extraImportStatus, setExtraImportStatus] = useState<string | null>(null);
  const [extraImportProgress, setExtraImportProgress] = useState<number>(0);
  const [extraUseScenes, setExtraUseScenes] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const extraPhotoInputRef = useRef<HTMLInputElement | null>(null);
  const bulkManualImagesInputRef = useRef<HTMLInputElement | null>(null);
  const replacePhotoInputRef = useRef<HTMLInputElement | null>(null);
  const replaceTargetPageIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      scanAbortRef.current?.abort();
      batchAbortRef.current?.abort();
    };
  }, []);

  // Hydrate existing saved book when entering Edit Mode
  useEffect(() => {
    if (!editingStory) {
      setIsHydratingEdit(false);
      return;
    }

    let active = true;
    setIsHydratingEdit(true);
    setStep('review');
    setDraftTitle(editingStory.title);
    setDraftSubtitle(editingStory.subtitle);
    setAgeGroup(editingStory.ageGroup);
    setDraftMoralTitle(editingStory.moralTitle);
    setDraftMoralLesson(editingStory.moralLesson);
    setDraftDiscussionPrompt(editingStory.parentDiscussionPrompt);
    setDraftBackdrop(editingStory.coverFallbackId || 'forest');

    void (async () => {
      try {
        const loaded: ReviewedPageDraft[] = [];
        let matchedCoverIdx = 0;

        for (let i = 0; i < editingStory.pages.length; i++) {
          const p = editingStory.pages[i];
          if (editingStory.coverMediaId && p.mediaId === editingStory.coverMediaId) {
            matchedCoverIdx = i;
          }
          const savedDataUrl = p.mediaId
            ? await resolveStoryMediaUrl(p.mediaId, {
                preferPublished: Boolean(editingStory.isPublished),
              })
            : null;
          const sceneBackdrop = normalizeBackdropId(
            p.fallbackArtId || editingStory.coverFallbackId,
            'meadow'
          );
          const mode: VisualMode =
            p.visualMode === 'scene' || (!savedDataUrl && !p.mediaId)
              ? 'scene'
              : p.visualMode === 'redraw'
                ? 'redraw'
                : p.visualMode === 'watercolor'
                  ? 'watercolor'
                  : 'photo';

          loaded.push({
            id: p.id || `page_${i + 1}`,
            text: p.text,
            sceneSummary: p.sceneSummary || `Page ${i + 1} illustration`,
            visualMode: mode,
            sceneBackdropId: sceneBackdrop,
            artStyle: 'watercolor',
            existingMediaId: p.mediaId,
            mediaDirty: false,
            originalDataUrl: savedDataUrl,
            mimeType: savedDataUrl?.startsWith('data:image/png')
              ? 'image/png'
              : savedDataUrl?.startsWith('data:image/')
                ? 'image/jpeg'
                : null,
            watercolorDataUrl: mode === 'watercolor' ? savedDataUrl : null,
            redrawnDataUrl: mode === 'redraw' ? savedDataUrl : null,
            framedOverrideUrl: null,
            hasIllustration: Boolean(savedDataUrl),
            artCropBox: null,
            smartFramedUrl: null,
            isSmartFramed: false,
            hotspots:
              Array.isArray(p.hotspots) && p.hotspots.length > 0
                ? p.hotspots
                : [
                    {
                      id: `hs_${i + 1}_1`,
                      name: 'Story Friend',
                      x: 50,
                      y: 50,
                      dialogue: 'Let us turn the page together!',
                      soundCue: 'chime',
                      reaction: 'bounce',
                    },
                  ],
          });
        }

        if (!active) return;
        setReviewedPages(loaded);
        setCoverPageIndex(matchedCoverIdx);
      } finally {
        if (active) setIsHydratingEdit(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [editingStory]);

  const stopCameraStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraOpen(false);
  };

  const openLiveCamera = async () => {
    setErrorMsg(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      cameraInputRef.current?.click();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOpen(true);
      window.setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();
        }
      }, 60);
    } catch {
      cameraInputRef.current?.click();
    }
  };

  const snapFromLiveCamera = async () => {
    const video = videoRef.current;
    if (!video || capturedPages.length >= MAX_UPLOAD_BATCH || isSnappingPhoto) return;
    setIsSnappingPhoto(true);
    setCaptureUploadProgress({
      percent: 25,
      label: 'Capturing snapshot from camera...',
    });
    await yieldToBrowser();

    try {
      const canvas = document.createElement('canvas');
      const srcW = video.videoWidth || LOCAL_DISPLAY_MAX_DIM;
      const srcH = video.videoHeight || Math.round(LOCAL_DISPLAY_MAX_DIM * 0.75);
      const scale = Math.min(1, LOCAL_DISPLAY_MAX_DIM / Math.max(srcW, srcH));
      const width = Math.max(1, Math.round(srcW * scale));
      const height = Math.max(1, Math.round(srcH * scale));
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', LOCAL_DISPLAY_QUALITY);

      setCapturedPages((prev) => [
        ...prev,
        {
          id: `snap_${Date.now()}_${prev.length + 1}`,
          originalDataUrl: dataUrl,
          watercolorDataUrl: null,
          mimeType: 'image/jpeg',
          visualMode: defaultVisualMode,
        },
      ]);
      stopCameraStream();
    } finally {
      setIsSnappingPhoto(false);
      setCaptureUploadProgress(null);
    }
  };

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setErrorMsg(null);
    const files = Array.from(e.target.files || []).filter(isLikelyImageFile);
    e.target.value = '';
    if (files.length === 0) return;

    const remainingSlots = Math.max(0, MAX_UPLOAD_BATCH - capturedPages.length);
    const batch = files.slice(0, remainingSlots);
    if (batch.length === 0) return;

    setIsAddingCaptureFiles(true);
    setCaptureUploadProgress({
      percent: 6,
      label: `Adding photo 1 of ${batch.length}...`,
      detail: batch[0].name,
    });
    await yieldToBrowser();

    try {
      for (let i = 0; i < batch.length; i++) {
        const file = batch[i];
        const basePct = (i / batch.length) * 100;
        const stepSpan = 100 / batch.length;
        try {
          setCaptureUploadProgress({
            percent: Math.max(6, Math.round(basePct + stepSpan * 0.12)),
            label: `Adding photo ${i + 1} of ${batch.length}...`,
            detail: file.name,
          });

          // Keep a crisp 1120px local copy; defer watercolor canvas pass until Review so upload stays instant
          const { dataUrl, mimeType } = await fileToCompressedDataUrl(
            file,
            LOCAL_DISPLAY_MAX_DIM,
            LOCAL_DISPLAY_QUALITY,
            (pct) => {
              setCaptureUploadProgress({
                percent: Math.min(99, Math.round(basePct + stepSpan * (pct / 100))),
                label: `Adding photo ${i + 1} of ${batch.length}...`,
                detail: file.name,
              });
            }
          );

          const draft: CapturedPageDraft = {
            id: `snap_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
            originalDataUrl: dataUrl,
            watercolorDataUrl: null,
            mimeType,
            visualMode: defaultVisualMode,
          };

          setCapturedPages((prev) => [...prev, draft]);
          await yieldToBrowser();
        } catch (err) {
          setErrorMsg(err instanceof Error ? err.message : 'Could not read image file.');
        }
      }

      setCaptureUploadProgress({
        percent: 100,
        label: `Added ${batch.length} ${batch.length === 1 ? 'photo' : 'photos'}!`,
      });
      await yieldToBrowser();
    } finally {
      setIsAddingCaptureFiles(false);
      setCaptureUploadProgress(null);
    }
  };

  const toggleCapturedVisualMode = (id: string, mode: CaptureVisualMode) => {
    setCapturedPages((prev) => prev.map((p) => (p.id === id ? { ...p, visualMode: mode } : p)));
  };

  const removeCapturedPage = (id: string) => {
    setCapturedPages((prev) => prev.filter((p) => p.id !== id));
  };

  const handleRedrawSinglePage = async (
    pageId: string,
    styleOverride?: RedrawStyle,
    explicitPage?: ReviewedPageDraft,
    pageIdxHint?: number,
    totalCountHint?: number,
    signal?: AbortSignal
  ): Promise<'ok' | 'quota' | 'aborted' | 'error'> => {
    const idx =
      typeof pageIdxHint === 'number'
        ? pageIdxHint
        : reviewedPages.findIndex((p) => p.id === pageId);
    const target = explicitPage || reviewedPages[idx];
    if (!target || target.isRedrawing) return 'error';

    const chosenStyle = styleOverride ?? target.artStyle;
    setReviewedPages((prev) =>
      prev.map((p) =>
        p.id === pageId
          ? {
              ...p,
              artStyle: chosenStyle,
              visualMode: 'redraw',
              isRedrawing: true,
              redrawError: null,
              redrawIsQuota: false,
            }
          : p
      )
    );

    try {
      const refImage = target.smartFramedUrl || target.originalDataUrl;
      const result = await requestAiRedrawIllustration({
        imageBase64: refImage,
        mimeType: target.mimeType || (refImage?.startsWith('data:image/png') ? 'image/png' : 'image/jpeg'),
        includePhotoRef: target.hasIllustration !== false && Boolean(refImage),
        sceneSummary: target.sceneSummary,
        pageText: target.text,
        artStyle: chosenStyle,
        pageNumber: idx >= 0 ? idx + 1 : 1,
        totalPages: totalCountHint ?? reviewedPages.length,
        signal,
      });

      setReviewedPages((prev) =>
        prev.map((p) =>
          p.id === pageId
            ? {
                ...p,
                visualMode: 'redraw',
                redrawnDataUrl: result.dataUrl,
                framedOverrideUrl: null,
                isSmartFramed: false,
                mediaDirty: true,
                redrawNote: result.styleNote,
                isRedrawing: false,
                redrawError: null,
                redrawIsQuota: false,
              }
            : p
        )
      );
      return 'ok';
    } catch (err) {
      const isAborted = err instanceof ApiRequestError && err.code === 'ABORTED';
      const isQuota =
        err instanceof ApiRequestError && (err.status === 429 || err.code === 'QUOTA_EXCEEDED');
      const msg = isAborted
        ? null
        : err instanceof Error
          ? err.message
          : 'Could not paint this page.';

      setReviewedPages((prev) =>
        prev.map((p) =>
          p.id === pageId
            ? {
                ...p,
                isRedrawing: false,
                redrawError: msg,
                redrawIsQuota: isQuota,
                visualMode: p.redrawnDataUrl
                  ? 'redraw'
                  : p.originalDataUrl && p.hasIllustration !== false
                    ? p.watercolorDataUrl
                      ? 'watercolor'
                      : 'photo'
                    : 'scene',
              }
            : p
        )
      );
      if (isAborted) return 'aborted';
      if (isQuota) return 'quota';
      return 'error';
    }
  };

  const handleStopBatchGeneration = () => {
    batchAbortRef.current?.abort();
  };

  const handleGenerateAllIllustrations = async () => {
    if (isBatchGenerating || reviewedPages.length === 0) return;
    const controller = new AbortController();
    batchAbortRef.current = controller;
    setIsBatchGenerating(true);
    setBatchProgressPercent(5);
    setErrorMsg(null);
    setStudioBanner(null);

    const snapshot = [...reviewedPages];
    let succeeded = 0;
    let stoppedByQuota = false;
    let cancelledByUser = false;

    try {
      for (let i = 0; i < snapshot.length; i++) {
        if (controller.signal.aborted) {
          cancelledByUser = true;
          break;
        }
        const page = snapshot[i];
        setBatchProgressPercent(Math.max(5, Math.round((i / snapshot.length) * 100)));
        setBatchProgressText(
          `Painting ${
            REDRAW_STYLES.find((s) => s.id === defaultRedrawStyle)?.label || 'Watercolor'
          } art for Page ${i + 1} of ${snapshot.length}...`
        );
        await yieldToBrowser();

        const outcome = await handleRedrawSinglePage(
          page.id,
          defaultRedrawStyle,
          page,
          i,
          snapshot.length,
          controller.signal
        );

        if (outcome === 'ok') {
          succeeded++;
        } else if (outcome === 'aborted') {
          cancelledByUser = true;
          break;
        } else if (outcome === 'quota') {
          stoppedByQuota = true;
          break;
        }

        setBatchProgressPercent(Math.round(((i + 1) / snapshot.length) * 100));

        // Gentle pacing pause between pages to stay friendly to free-tier RPM limits
        if (i < snapshot.length - 1 && !controller.signal.aborted) {
          await new Promise((r) => window.setTimeout(r, 750));
        }
      }

      if (stoppedByQuota) {
        setStudioBanner(
          `Painted ${succeeded} ${succeeded === 1 ? 'page' : 'pages'} before reaching the free-tier rate limit. Wait ~30 seconds to paint remaining pages, or pick an instant Painterly Scene!`
        );
      } else if (cancelledByUser) {
        setStudioBanner(
          `Stopped batch painting after ${succeeded} ${succeeded === 1 ? 'page' : 'pages'}.`
        );
      } else {
        setStudioBanner(
          `Finished painting fresh illustrations across ${succeeded} ${
            succeeded === 1 ? 'page' : 'pages'
          }.`
        );
      }
    } finally {
      batchAbortRef.current = null;
      setIsBatchGenerating(false);
      setBatchProgressText(null);
      setBatchProgressPercent(0);
    }
  };

  const handleSelectReviewVisualMode = async (pageId: string, mode: VisualMode) => {
    const target = reviewedPages.find((p) => p.id === pageId);
    if (!target) return;

    if (mode === 'redraw' && !target.redrawnDataUrl && !target.isRedrawing) {
      await handleRedrawSinglePage(pageId);
      return;
    }

    if (mode === 'watercolor' && !target.watercolorDataUrl && target.originalDataUrl) {
      setReplacingPageId(pageId);
      setReplacingPageProgress({
        pageId,
        percent: 12,
        stage: 'Applying watercolor finish...',
      });
      await yieldToBrowser();
      try {
        const watercolorUrl = await renderWatercolorStorybookStyle(target.originalDataUrl, (pct) => {
          setReplacingPageProgress({
            pageId,
            percent: Math.max(12, pct),
            stage: 'Applying watercolor finish...',
          });
        });
        setReviewedPages((prev) =>
          prev.map((item) =>
            item.id === pageId
              ? {
                  ...item,
                  visualMode: 'watercolor',
                  watercolorDataUrl: watercolorUrl,
                  framedOverrideUrl: null,
                  mediaDirty: true,
                  redrawError: null,
                }
              : item
          )
        );
      } finally {
        setReplacingPageId(null);
        setReplacingPageProgress(null);
      }
      return;
    }

    setReviewedPages((prev) =>
      prev.map((item) =>
        item.id === pageId
          ? {
              ...item,
              visualMode: mode,
              framedOverrideUrl: null,
              isSmartFramed: mode === 'scene' || mode === 'redraw' ? false : item.isSmartFramed,
              mediaDirty: true,
              redrawError: mode === 'scene' ? null : item.redrawError,
            }
          : item
      )
    );
  };

  const handleSelectPageScene = (pageId: string, sceneId: BackdropId) => {
    setReviewedPages((prev) =>
      prev.map((item) =>
        item.id === pageId
          ? {
              ...item,
              visualMode: 'scene',
              sceneBackdropId: sceneId,
              framedOverrideUrl: null,
              isSmartFramed: false,
              mediaDirty: true,
              redrawError: null,
              redrawIsQuota: false,
            }
          : item
      )
    );
  };

  const handleToggleSmartFrame = async (pageId: string) => {
    const target = reviewedPages.find((p) => p.id === pageId);
    if (!target || !target.originalDataUrl || !target.artCropBox) return;

    if (target.isSmartFramed) {
      setReviewedPages((prev) =>
        prev.map((item) =>
          item.id === pageId
            ? { ...item, isSmartFramed: false, framedOverrideUrl: null, mediaDirty: true }
            : item
        )
      );
      return;
    }

    if (target.smartFramedUrl) {
      setReviewedPages((prev) =>
        prev.map((item) =>
          item.id === pageId
            ? {
                ...item,
                visualMode: item.visualMode === 'photo' ? 'photo' : 'watercolor',
                isSmartFramed: true,
                framedOverrideUrl: null,
                mediaDirty: true,
              }
            : item
        )
      );
      return;
    }

    setReplacingPageId(pageId);
    setReplacingPageProgress({
      pageId,
      percent: 24,
      stage: 'Smart-framing book artwork...',
    });
    await yieldToBrowser();
    try {
      const smartUrl = await renderSmartFramedArt(
        target.originalDataUrl,
        target.artCropBox,
        target.visualMode !== 'photo'
      );
      setReviewedPages((prev) =>
        prev.map((item) =>
          item.id === pageId
            ? {
                ...item,
                visualMode: item.visualMode === 'photo' ? 'photo' : 'watercolor',
                smartFramedUrl: smartUrl,
                isSmartFramed: true,
                framedOverrideUrl: null,
                mediaDirty: true,
              }
            : item
        )
      );
    } finally {
      setReplacingPageId(null);
      setReplacingPageProgress(null);
    }
  };

  const handleTriggerReplacePhoto = (pageId: string) => {
    replaceTargetPageIdRef.current = pageId;
    replacePhotoInputRef.current?.click();
  };

  const handleReplacePhotoFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const targetPageId = replaceTargetPageIdRef.current;
    e.target.value = '';
    if (!file || !targetPageId || !isLikelyImageFile(file)) return;

    setReplacingPageId(targetPageId);
    setReplacingPageProgress({
      pageId: targetPageId,
      percent: 8,
      stage: 'Reading uploaded image...',
    });
    await yieldToBrowser();

    try {
      const { dataUrl, mimeType } = await fileToCompressedDataUrl(file, 1400, 0.88, (pct) => {
        setReplacingPageProgress({
          pageId: targetPageId,
          percent: Math.max(8, Math.round(pct * 0.5)),
          stage: 'Optimizing image resolution...',
        });
      });

      setReplacingPageProgress({
        pageId: targetPageId,
        percent: 55,
        stage: 'Applying watercolor paper finish...',
      });
      await yieldToBrowser();

      const watercolorUrl = await renderWatercolorStorybookStyle(dataUrl, (pct) => {
        setReplacingPageProgress({
          pageId: targetPageId,
          percent: Math.min(99, 50 + Math.round(pct * 0.5)),
          stage: 'Applying watercolor paper finish...',
        });
      });

      setReplacingPageProgress({
        pageId: targetPageId,
        percent: 100,
        stage: 'Updating page preview...',
      });
      await yieldToBrowser();

      setReviewedPages((prev) =>
        prev.map((p) =>
          p.id === targetPageId
            ? {
                ...p,
                originalDataUrl: dataUrl,
                mimeType,
                watercolorDataUrl: watercolorUrl,
                framedOverrideUrl: null,
                visualMode: 'watercolor',
                mediaDirty: true,
                redrawError: null,
              }
            : p
        )
      );
      setStudioBanner('Replaced page image — you can resize, crop, or AI redraw it anytime.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not load replacement image.');
    } finally {
      setReplacingPageId(null);
      setReplacingPageProgress(null);
    }
  };

  const handleMovePage = (index: number, direction: -1 | 1) => {
    const nextIdx = index + direction;
    if (nextIdx < 0 || nextIdx >= reviewedPages.length) return;
    setReviewedPages((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(index, 1);
      copy.splice(nextIdx, 0, moved);
      return copy;
    });
    setCoverPageIndex((prevCover) => {
      if (prevCover === index) return nextIdx;
      if (prevCover === nextIdx) return index;
      return prevCover;
    });
  };

  const handleSplitPage = (index: number) => {
    if (reviewedPages.length >= MAX_STORY_PAGES) {
      setErrorMsg(`Storybooks can have up to ${MAX_STORY_PAGES} pages.`);
      return;
    }
    const source = reviewedPages[index];
    if (!source) return;

    const [partA, partB] = splitStoryTextCleanly(source.text);
    const newPageId = sanitizeId(`page_split_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`);

    const pageA: ReviewedPageDraft = {
      ...source,
      text: partA,
    };
    const nextSceneIdx =
      (BACKDROP_SCENE_CATALOG.findIndex((b) => b.id === source.sceneBackdropId) + 1) %
      BACKDROP_SCENE_CATALOG.length;
    const nextSceneId = BACKDROP_SCENE_CATALOG[nextSceneIdx]?.id || draftBackdrop;

    const pageB: ReviewedPageDraft = {
      id: newPageId,
      text: partB,
      sceneSummary: `Illustration showing: ${partB.slice(0, 180)}`,
      visualMode:
        source.visualMode === 'scene'
          ? 'scene'
          : source.originalDataUrl && source.hasIllustration !== false
            ? 'watercolor'
            : 'scene',
      sceneBackdropId: nextSceneId,
      artStyle: source.artStyle,
      mediaDirty: true,
      originalDataUrl: source.originalDataUrl,
      mimeType: source.mimeType,
      watercolorDataUrl: source.watercolorDataUrl,
      redrawnDataUrl: null,
      framedOverrideUrl: null,
      hasIllustration: source.hasIllustration,
      artCropBox: source.artCropBox,
      smartFramedUrl: source.smartFramedUrl,
      isSmartFramed: source.isSmartFramed,
      hotspots: [
        {
          id: `hs_${newPageId}_1`,
          name: 'Story Friend',
          x: 42,
          y: 52,
          dialogue: 'Look what happens next!',
          soundCue: 'chime',
          reaction: 'bounce',
        },
        {
          id: `hs_${newPageId}_2`,
          name: 'Little Helper',
          x: 68,
          y: 46,
          dialogue: 'Tap to explore this page!',
          soundCue: 'twinkle',
          reaction: 'sparkle',
        },
      ],
    };

    setReviewedPages((prev) => {
      const next = [...prev];
      next.splice(index, 1, pageA, pageB);
      return next;
    });
    if (coverPageIndex > index) {
      setCoverPageIndex((c) => c + 1);
    }
    setStudioBanner(
      `Split Page ${index + 1} into Pages ${index + 1} & ${index + 2}. Pick a Painterly Scene or tap "Paint AI Art" on Page ${
        index + 2
      } anytime!`
    );
  };

  const handleDeletePage = (index: number) => {
    if (reviewedPages.length <= 1) return;
    setReviewedPages((prev) => prev.filter((_, idx) => idx !== index));
    setCoverPageIndex((prevCover) => {
      if (prevCover === index) return 0;
      if (prevCover > index) return prevCover - 1;
      return prevCover;
    });
    setStudioBanner(`Removed Page ${index + 1}.`);
  };

  const handleAddBlankPage = () => {
    if (reviewedPages.length >= MAX_STORY_PAGES) {
      setErrorMsg(`Storybooks support up to ${MAX_STORY_PAGES} pages.`);
      return;
    }
    const newId = sanitizeId(`page_new_${Date.now()}`);
    const nextScene =
      BACKDROP_SCENE_CATALOG[reviewedPages.length % BACKDROP_SCENE_CATALOG.length]?.id ||
      draftBackdrop;
    const newPage: ReviewedPageDraft = {
      id: newId,
      text: '',
      sceneSummary: 'Cozy storybook scene matching the story text on this page',
      visualMode: 'scene',
      sceneBackdropId: nextScene,
      artStyle: defaultRedrawStyle,
      mediaDirty: true,
      originalDataUrl: null,
      mimeType: null,
      watercolorDataUrl: null,
      redrawnDataUrl: null,
      framedOverrideUrl: null,
      hasIllustration: false,
      artCropBox: null,
      smartFramedUrl: null,
      isSmartFramed: false,
      hotspots: [
        {
          id: `hs_${newId}_1`,
          name: 'Story Friend',
          x: 48,
          y: 50,
          dialogue: 'Hello, little reader!',
          soundCue: 'chime',
          reaction: 'bounce',
        },
      ],
    };
    setReviewedPages((prev) => [...prev, newPage]);
    setStudioBanner(
      `Added Page ${reviewedPages.length + 1} with a Painterly Scene. Upload a photo or tap "Paint AI Art" anytime.`
    );
  };

  /**
   * Switches between Scan Photos and Write Manually modes during book creation.
   */
  const handleSwitchCreateMode = (nextMode: CreateMode) => {
    if (isEditMode) return;
    stopCameraStream();
    setCreateMode(nextMode);
    setErrorMsg(null);
    setStudioBanner(null);

    if (nextMode === 'manual') {
      if (reviewedPages.length === 0) {
        setReviewedPages([createStarterPageDraft(0, defaultRedrawStyle)]);
        setShowManualPasteBox(true);
      }
      setStep('review');
    } else {
      setStep('capture');
    }
  };

  /**
   * Converts currently uploaded photos straight into editable Studio pages (100% client-side,
   * zero server calls) so users can write/paste text manually without losing their photos.
   */
  const handleContinueManuallyWithCapturedPhotos = async () => {
    if (isLoadingManualPhotos) return;
    setIsLoadingManualPhotos(true);
    setErrorMsg(null);
    const total = Math.max(1, capturedPages.length);
    setCaptureUploadProgress({
      percent: 6,
      label: `Preparing ${total} ${total === 1 ? 'photo' : 'photos'} for Manual Studio...`,
    });
    await yieldToBrowser();

    try {
      const manualPages: ReviewedPageDraft[] = [];

      for (let i = 0; i < capturedPages.length; i++) {
        const cap = capturedPages[i];
        const basePct = (i / total) * 100;
        const span = 100 / total;
        setCaptureUploadProgress({
          percent: Math.max(6, Math.round(basePct + span * 0.1)),
          label: `Preparing photo ${i + 1} of ${capturedPages.length} for Manual Studio...`,
        });

        const watercolorUrl =
          cap.watercolorDataUrl ||
          (await renderWatercolorStorybookStyle(cap.originalDataUrl, (pct) => {
            setCaptureUploadProgress({
              percent: Math.min(99, Math.round(basePct + span * (pct / 100))),
              label: `Preparing photo ${i + 1} of ${capturedPages.length} for Manual Studio...`,
            });
          }));
        const base = createStarterPageDraft(i, defaultRedrawStyle, '');
        manualPages.push({
          ...base,
          visualMode: cap.visualMode === 'photo' ? 'photo' : 'watercolor',
          originalDataUrl: cap.originalDataUrl,
          mimeType: cap.mimeType,
          watercolorDataUrl: watercolorUrl,
          mediaDirty: true,
        });
        await yieldToBrowser();
      }

      if (manualPages.length === 0) {
        manualPages.push(createStarterPageDraft(0, defaultRedrawStyle, ''));
      }

      if (titleHint.trim() && !draftTitle.trim()) {
        setDraftTitle(titleHint.trim());
      }
      setReviewedPages(manualPages);
      setCoverPageIndex(0);
      setCreateMode('manual');
      setShowManualPasteBox(true);
      setStep('review');
      setStudioBanner(
        `Loaded ${manualPages.length} ${
          manualPages.length === 1 ? 'photo' : 'photos'
        } directly into the Storybook Studio. Type or paste your story text below — no scan server required!`
      );
    } finally {
      setIsLoadingManualPhotos(false);
      setCaptureUploadProgress(null);
    }
  };

  /**
   * Splits pasted full-book text into short kid-friendly pages locally (0 server calls),
   * keeping any images already attached to existing pages.
   */
  const handleApplyAutoSplitManualText = () => {
    const chunks = autoSplitFullStoryText(manualFullText, ageGroup, MAX_STORY_PAGES);
    if (chunks.length === 0) {
      setErrorMsg('Paste or type your story text first before splitting into pages.');
      return;
    }
    setErrorMsg(null);

    setReviewedPages((prev) => {
      const next: ReviewedPageDraft[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const existing = prev[i];
        const chunkText = chunks[i];
        if (existing) {
          next.push({
            ...existing,
            text: chunkText,
            sceneSummary: `Warm children's storybook scene illustrating: ${chunkText.slice(0, 180)}`,
          });
        } else {
          next.push(createStarterPageDraft(i, defaultRedrawStyle, chunkText));
        }
      }
      return next;
    });

    setCoverPageIndex((c) => Math.min(c, Math.max(0, chunks.length - 1)));
    setShowManualPasteBox(false);
    setStudioBanner(
      `Split your story into ${chunks.length} short, kid-friendly ${
        chunks.length === 1 ? 'page' : 'pages'
      }! Upload images for any page, crop & resize, or click "Paint AI Art".`
    );
  };

  /**
   * Uploads 1–10 images directly onto pages locally (zero server/AI scan calls),
   * filling pages that don't have images yet and creating new pages up to MAX_STORY_PAGES.
   */
  const handleBulkUploadManualImages = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter(isLikelyImageFile);
    e.target.value = '';
    if (files.length === 0) return;

    const emptyPageSlots = reviewedPages.filter(
      (p) => !p.originalDataUrl && !p.redrawnDataUrl
    ).length;
    const extraPageSlots = Math.max(0, MAX_STORY_PAGES - reviewedPages.length);
    const openSlots = emptyPageSlots + extraPageSlots;

    if (openSlots <= 0) {
      setStudioBanner(
        'All existing pages already have images (use "Replace Image" on a specific page to swap it).'
      );
      return;
    }

    const batch = files.slice(0, openSlots);
    setIsBulkUploadingImages(true);
    setErrorMsg(null);
    setStudioUploadProgress({
      percent: 4,
      label: `Uploading image 1 of ${batch.length}...`,
      detail: batch[0].name,
    });
    await yieldToBrowser();

    try {
      let attachedCount = 0;
      for (let i = 0; i < batch.length; i++) {
        const file = batch[i];
        const basePct = (i / batch.length) * 100;
        const stepSpan = 100 / batch.length;

        try {
          setStudioUploadProgress({
            percent: Math.max(4, Math.round(basePct + stepSpan * 0.08)),
            label: `Uploading image ${i + 1} of ${batch.length}...`,
            detail: `Optimizing ${file.name}`,
          });

          const { dataUrl, mimeType } = await fileToCompressedDataUrl(file, 1400, 0.88, (pct) => {
            setStudioUploadProgress({
              percent: Math.min(99, Math.round(basePct + stepSpan * (pct / 100) * 0.5)),
              label: `Uploading image ${i + 1} of ${batch.length}...`,
              detail: `Optimizing ${file.name}`,
            });
          });

          setStudioUploadProgress({
            percent: Math.min(99, Math.round(basePct + stepSpan * 0.54)),
            label: `Styling image ${i + 1} of ${batch.length}...`,
            detail: 'Applying warm watercolor finish',
          });

          const watercolorUrl = await renderWatercolorStorybookStyle(dataUrl, (pct) => {
            setStudioUploadProgress({
              percent: Math.min(99, Math.round(basePct + stepSpan * (0.5 + (pct / 100) * 0.5))),
              label: `Styling image ${i + 1} of ${batch.length}...`,
              detail: 'Applying warm watercolor finish',
            });
          });

          // Stream each processed image onto the next open page immediately
          setReviewedPages((prev) => {
            const copy = [...prev];
            const emptyIdx = copy.findIndex((p) => !p.originalDataUrl && !p.redrawnDataUrl);
            if (emptyIdx >= 0) {
              copy[emptyIdx] = {
                ...copy[emptyIdx],
                originalDataUrl: dataUrl,
                mimeType,
                watercolorDataUrl: watercolorUrl,
                framedOverrideUrl: null,
                visualMode: 'watercolor',
                mediaDirty: true,
              };
            } else if (copy.length < MAX_STORY_PAGES) {
              const base = createStarterPageDraft(copy.length, defaultRedrawStyle, '');
              copy.push({
                ...base,
                originalDataUrl: dataUrl,
                mimeType,
                watercolorDataUrl: watercolorUrl,
                visualMode: 'watercolor',
                mediaDirty: true,
              });
            }
            return copy;
          });
          attachedCount++;
          await yieldToBrowser();
        } catch (err) {
          setErrorMsg(
            err instanceof Error ? err.message : 'Could not load one of the selected images.'
          );
        }
      }

      setStudioUploadProgress({
        percent: 100,
        label: 'Images ready!',
      });
      await yieldToBrowser();

      if (attachedCount > 0) {
        setStudioBanner(
          `Added ${attachedCount} ${
            attachedCount === 1 ? 'image' : 'images'
          } directly to your pages with warm watercolor framing. You can switch to Original Photo or Resize & Crop anytime.`
        );
      }
    } finally {
      setIsBulkUploadingImages(false);
      setStudioUploadProgress(null);
    }
  };

  /**
   * Imports extra photos/screenshots directly into an existing open book in the Studio
   * using a single fast free-tier scan call (no blocking AI redraw loop).
   */
  const handleImportExtraPhotos = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter(isLikelyImageFile);
    e.target.value = '';
    if (files.length === 0) return;

    const remainingPageSlots = Math.max(0, MAX_STORY_PAGES - reviewedPages.length);
    if (remainingPageSlots <= 0) {
      setErrorMsg(`This storybook already has ${MAX_STORY_PAGES} pages (the maximum).`);
      return;
    }

    const batchFiles = files.slice(0, Math.min(MAX_UPLOAD_BATCH, remainingPageSlots));
    setIsImportingExtra(true);
    setErrorMsg(null);
    setExtraImportProgress(8);
    setExtraImportStatus(`Optimizing ${batchFiles.length} photo(s) for fast scanning...`);
    await yieldToBrowser();

    try {
      const prepared: Array<{ dataUrl: string; mimeType: string }> = [];
      for (let i = 0; i < batchFiles.length; i++) {
        const file = batchFiles[i];
        const basePct = 8 + (i / batchFiles.length) * 26;
        const span = 26 / batchFiles.length;
        setExtraImportStatus(`Preparing photo ${i + 1} of ${batchFiles.length}...`);
        const { dataUrl, mimeType } = await fileToCompressedDataUrl(
          file,
          LOCAL_DISPLAY_MAX_DIM,
          LOCAL_DISPLAY_QUALITY,
          (pct) => {
            setExtraImportProgress(Math.round(basePct + span * (pct / 100)));
          }
        );
        prepared.push({ dataUrl, mimeType });
        await yieldToBrowser();
      }

      setExtraImportProgress(40);
      setExtraImportStatus(`Reading story text from ${batchFiles.length} photo(s)...`);
      await yieldToBrowser();

      const scanParams = getAdaptiveScanUploadParams(prepared.length);
      const compactPagesForApi = [];
      for (const p of prepared) {
        compactPagesForApi.push(
          await compressDataUrlForApi(p.dataUrl, scanParams.maxDim, scanParams.quality)
        );
      }

      const data = await postApiJson<Record<string, unknown>>(
        '/api/stories/scan',
        {
          ageGroup,
          textMode,
          autoSplitPages,
          maxPages: remainingPageSlots,
          titleHint: draftTitle.trim() || undefined,
          pages: compactPagesForApi.map((p) => ({
            imageBase64: p.dataUrl,
            mimeType: p.mimeType,
          })),
        },
        'Could not read extra photos.'
      );
      setExtraImportProgress(78);

      const apiPages: Array<Record<string, unknown>> = Array.isArray(data.pages)
        ? data.pages.slice(0, remainingPageSlots)
        : [];
      const baseIndex = reviewedPages.length;
      const watercolorBySource = new Map<number, string>();
      const smartFrameByKey = new Map<string, string>();
      const appended: ReviewedPageDraft[] = [];

      for (let i = 0; i < apiPages.length; i++) {
        const aiPage = apiPages[i];
        const rawSrcIdx = Number(aiPage.sourcePhotoIndex);
        const srcIdx = Number.isInteger(rawSrcIdx)
          ? Math.max(0, Math.min(prepared.length - 1, rawSrcIdx))
          : Math.min(prepared.length - 1, i);
        const src = prepared[srcIdx] || prepared[0];

        const pageText = String(
          aiPage.text || 'Tap Play to listen to this storybook page.'
        ).slice(0, 3000);
        const sceneSummary = String(
          aiPage.sceneSummary || `Page ${baseIndex + i + 1} illustration`
        ).slice(0, 300);
        const pageSceneId = normalizeBackdropId(aiPage.suggestedBackdrop, draftBackdrop);
        const hasIllustration = aiPage.hasIllustration !== false;
        const artCropBox = hasIllustration ? sanitizeArtCropBox(aiPage.artCropBox) : null;

        const useSceneMode = extraUseScenes || !hasIllustration;
        let watercolorUrl: string | null = null;
        let smartFramedUrl: string | null = null;
        let autoSmartFramed = false;

        if (!useSceneMode) {
          if (artCropBox) {
            const cropKey = `${srcIdx}:${artCropBox.join(',')}`;
            smartFramedUrl = smartFrameByKey.get(cropKey) || null;
            if (!smartFramedUrl) {
              smartFramedUrl = await renderSmartFramedArt(src.dataUrl, artCropBox, true);
              smartFrameByKey.set(cropKey, smartFramedUrl);
            }
            autoSmartFramed = true;
          } else {
            watercolorUrl = watercolorBySource.get(srcIdx) || null;
            if (!watercolorUrl) {
              watercolorUrl = await renderWatercolorStorybookStyle(src.dataUrl);
              watercolorBySource.set(srcIdx, watercolorUrl);
            }
          }
        }

        const rawHotspots = Array.isArray(aiPage.hotspots) ? aiPage.hotspots : [];
        const pageUid = sanitizeId(`page_imp_${Date.now()}_${i}`);
        const hotspots: CharacterHotspot[] =
          rawHotspots.length > 0
            ? rawHotspots.slice(0, 3).map((h: Record<string, unknown>, hIdx: number) => ({
                id: `hs_${pageUid}_${hIdx + 1}`,
                name: String(h.name || 'Story Friend').slice(0, 40),
                x: Math.max(18, Math.min(82, Number(h.x) || 35 + hIdx * 28)),
                y: Math.max(20, Math.min(78, Number(h.y) || 48)),
                dialogue: String(h.dialogue || 'Hello, little reader!').slice(0, 120),
                soundCue: hIdx % 2 === 0 ? 'chime' : 'giggle',
                reaction:
                  h.reaction === 'wiggle' || h.reaction === 'sparkle' ? h.reaction : 'bounce',
              }))
            : [
                {
                  id: `hs_${pageUid}_1`,
                  name: 'Story Friend',
                  x: 50,
                  y: 50,
                  dialogue: 'Let us turn the page together!',
                  soundCue: 'chime',
                  reaction: 'bounce',
                },
              ];

        appended.push({
          id: pageUid,
          text: pageText,
          sceneSummary,
          visualMode: useSceneMode ? 'scene' : 'watercolor',
          sceneBackdropId: pageSceneId,
          artStyle: defaultRedrawStyle,
          mediaDirty: true,
          originalDataUrl: src.dataUrl,
          mimeType: src.mimeType,
          watercolorDataUrl: watercolorUrl,
          redrawnDataUrl: null,
          framedOverrideUrl: null,
          hasIllustration,
          artCropBox,
          smartFramedUrl,
          isSmartFramed: autoSmartFramed,
          hotspots,
        });
      }

      setExtraImportProgress(100);
      setReviewedPages((prev) => [...prev, ...appended].slice(0, MAX_STORY_PAGES));
      setShowExtraImporter(false);
      setStudioBanner(
        `Imported ${appended.length} new ${
          appended.length === 1 ? 'page' : 'pages'
        } into “${draftTitle || 'this storybook'}”.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to import extra photos.');
    } finally {
      setIsImportingExtra(false);
      setExtraImportStatus(null);
      setExtraImportProgress(0);
    }
  };

  const handleCancelScan = () => {
    scanAbortRef.current?.abort();
    scanAbortRef.current = null;
    setStep('capture');
    setConversionProgress(0);
  };

  const handleConvertPages = async () => {
    if (capturedPages.length === 0) {
      setErrorMsg('Add at least one storybook page photo or screenshot first.');
      return;
    }

    scanAbortRef.current?.abort();
    const controller = new AbortController();
    scanAbortRef.current = controller;

    setErrorMsg(null);
    setStudioBanner(null);
    setStep('converting');
    setConversionProgress(10);
    setConversionStatus(
      `Compressing ${capturedPages.length} ${
        capturedPages.length === 1 ? 'photo' : 'photos'
      } for fast free-tier scanning...`
    );
    await yieldToBrowser();

    try {
      // Adaptive crisp JPEG payload keeps text sharp for OCR while staying safely below Vercel's 4.5MB API limit
      const scanParams = getAdaptiveScanUploadParams(capturedPages.length);
      const compactPagesForApi = [];
      for (let i = 0; i < capturedPages.length; i++) {
        if (controller.signal.aborted) {
          throw new ApiRequestError('Scan cancelled.', { code: 'ABORTED' });
        }
        compactPagesForApi.push(
          await compressDataUrlForApi(
            capturedPages[i].originalDataUrl,
            scanParams.maxDim,
            scanParams.quality
          )
        );
        setConversionProgress(10 + Math.round(((i + 1) / capturedPages.length) * 18));
      }

      setConversionProgress(35);
      setConversionStatus(
        autoSplitPages
          ? 'Reading printed text and splitting into short kid-friendly pages...'
          : textMode === 'verbatim'
            ? 'Reading every printed word from your photos...'
            : 'Reading and adapting storybook text for your child...'
      );
      await yieldToBrowser();

      // Single fast free-tier Gemini call (ThinkingLevel.MINIMAL) — zero blocking redraw loop!
      const data = await postApiJson<Record<string, unknown>>(
        '/api/stories/scan',
        {
          ageGroup,
          textMode,
          autoSplitPages,
          maxPages: MAX_STORY_PAGES,
          titleHint: titleHint.trim() || undefined,
          pages: compactPagesForApi.map((p) => ({
            imageBase64: p.dataUrl,
            mimeType: p.mimeType,
          })),
        },
        'Could not convert storybook pages.',
        { signal: controller.signal, timeoutMs: SCAN_TIMEOUT_MS }
      );

      if (controller.signal.aborted) {
        throw new ApiRequestError('Scan cancelled.', { code: 'ABORTED' });
      }

      setConversionProgress(76);
      setConversionStatus('Finishing watercolor pages and opening Review Studio...');
      await yieldToBrowser();

      const safeBackdrop = normalizeBackdropId(data.suggestedBackdrop, 'meadow');
      const apiPages: Array<Record<string, unknown>> =
        Array.isArray(data.pages) && data.pages.length > 0
          ? data.pages.slice(0, MAX_STORY_PAGES)
          : capturedPages.map((_, idx) => ({
              sourcePhotoIndex: idx,
              text: 'Tap Play to listen to this storybook page.',
              sceneSummary: `Page ${idx + 1} illustration`,
              suggestedBackdrop: safeBackdrop,
              hasIllustration: true,
              hotspots: [],
            }));

      // Cache watercolor retouch & extracted smart-framed artwork per unique source photo
      const watercolorBySource = new Map<number, string>();
      const smartFrameByKey = new Map<string, string>();
      const builtReviewed: ReviewedPageDraft[] = [];
      let autoMatchedSceneCount = 0;
      let autoExtractedArtCount = 0;

      for (let i = 0; i < apiPages.length; i++) {
        const aiPage = apiPages[i] || {};
        const rawSrcIdx = Number(aiPage.sourcePhotoIndex);
        const sourceIdx = Number.isInteger(rawSrcIdx)
          ? Math.max(0, Math.min(capturedPages.length - 1, rawSrcIdx))
          : Math.min(capturedPages.length - 1, i);
        const cap = capturedPages[sourceIdx] || capturedPages[0];

        const pageText = String(
          aiPage.text || 'Tap Play to listen to this storybook page.'
        ).slice(0, 3000);
        const sceneSummary = String(
          aiPage.sceneSummary || `Page ${i + 1} illustration`
        ).slice(0, 300);

        const pageBackdrop = normalizeBackdropId(
          aiPage.suggestedBackdrop,
          BACKDROP_SCENE_CATALOG[i % BACKDROP_SCENE_CATALOG.length]?.id || safeBackdrop
        );
        const hasIllustration = aiPage.hasIllustration !== false;
        const artCropBox = hasIllustration ? sanitizeArtCropBox(aiPage.artCropBox) : null;

        // Text-only screenshots automatically receive matched painterly watercolor scenes (0 extra API calls)
        let resolvedVisualMode: VisualMode;
        if (cap.visualMode === 'scene' || (!hasIllustration && cap.visualMode !== 'photo')) {
          resolvedVisualMode = 'scene';
          autoMatchedSceneCount++;
        } else if (cap.visualMode === 'photo') {
          resolvedVisualMode = 'photo';
        } else {
          resolvedVisualMode = 'watercolor';
        }

        let watercolorUrl: string | null = watercolorBySource.get(sourceIdx) || cap.watercolorDataUrl;
        let smartFramedUrl: string | null = null;
        let autoSmartFramed = false;

        // Automatically extract the illustration region when detected alongside printed text margins
        if (artCropBox && (resolvedVisualMode === 'watercolor' || resolvedVisualMode === 'photo')) {
          const applyWatercolor = resolvedVisualMode === 'watercolor';
          const cropKey = `${sourceIdx}:${applyWatercolor ? 'wc' : 'raw'}:${artCropBox.join(',')}`;
          smartFramedUrl = smartFrameByKey.get(cropKey) || null;
          if (!smartFramedUrl) {
            smartFramedUrl = await renderSmartFramedArt(
              cap.originalDataUrl,
              artCropBox,
              applyWatercolor
            );
            smartFrameByKey.set(cropKey, smartFramedUrl);
          }
          autoSmartFramed = true;
          autoExtractedArtCount++;
        } else if (resolvedVisualMode === 'watercolor' && !watercolorUrl) {
          watercolorUrl = await renderWatercolorStorybookStyle(cap.originalDataUrl);
          watercolorBySource.set(sourceIdx, watercolorUrl);
        }

        setConversionProgress(
          Math.min(98, 76 + Math.round(((i + 1) / Math.max(1, apiPages.length)) * 22))
        );

        const rawHotspots = Array.isArray(aiPage.hotspots) ? aiPage.hotspots : [];
        const hotspots: CharacterHotspot[] =
          rawHotspots.length > 0
            ? rawHotspots.slice(0, 3).map((h: Record<string, unknown>, hIdx: number) => ({
                id: `hs_${i + 1}_${hIdx + 1}`,
                name: String(h.name || 'Story Friend').slice(0, 40),
                x: Math.max(18, Math.min(82, Number(h.x) || 35 + hIdx * 28)),
                y: Math.max(20, Math.min(78, Number(h.y) || 48)),
                dialogue: String(h.dialogue || 'Hello, little reader!').slice(0, 120),
                soundCue: hIdx % 2 === 0 ? 'chime' : 'giggle',
                reaction:
                  h.reaction === 'wiggle' || h.reaction === 'sparkle' ? h.reaction : 'bounce',
              }))
            : [
                {
                  id: `hs_${i + 1}_1`,
                  name: 'Story Friend',
                  x: 50,
                  y: 50,
                  dialogue: 'Let us turn the page together!',
                  soundCue: 'chime',
                  reaction: 'bounce',
                },
              ];

        builtReviewed.push({
          id: `page_${i + 1}`,
          text: pageText,
          sceneSummary,
          visualMode: resolvedVisualMode,
          sceneBackdropId: pageBackdrop,
          artStyle: defaultRedrawStyle,
          mediaDirty: true,
          originalDataUrl: cap.originalDataUrl,
          mimeType: cap.mimeType,
          watercolorDataUrl: watercolorUrl,
          redrawnDataUrl: null,
          framedOverrideUrl: null,
          hasIllustration,
          artCropBox,
          smartFramedUrl,
          isSmartFramed: autoSmartFramed,
          hotspots,
        });
      }

      setDraftTitle(String(data.title || titleHint || 'Our Family Storybook').slice(0, 120));
      setDraftSubtitle(
        String(data.subtitle || 'Converted from your physical storybook shelf.').slice(0, 180)
      );
      setDraftMoralTitle(String(data.moralTitle || 'Kindness').slice(0, 60));
      setDraftMoralLesson(
        String(
          data.moralLesson || 'Every story helps us learn how to be kind, curious, and brave.'
        ).slice(0, 360)
      );
      setDraftDiscussionPrompt(
        String(
          data.parentDiscussionPrompt || 'Which moment in this story did you like best?'
        ).slice(0, 240)
      );
      setDraftBackdrop(safeBackdrop);
      setCoverPageIndex(0);
      setReviewedPages(builtReviewed);

      if (autoExtractedArtCount > 0) {
        setStudioBanner(
          `Read story text and extracted clean artwork across ${builtReviewed.length} ${
            builtReviewed.length === 1 ? 'page' : 'pages'
          }! You can toggle Full Photo, Resize & Crop, pick a Painterly Scene, or tap "Paint AI Art" on any page.`
        );
      } else if (autoMatchedSceneCount > 0) {
        setStudioBanner(
          `Scanned ${builtReviewed.length} ${
            builtReviewed.length === 1 ? 'page' : 'pages'
          }! Text-only pages were paired with built-in watercolor scenes — switch scenes, use your photo, or paint custom AI art on any page.`
        );
      } else if (builtReviewed.length > capturedPages.length) {
        setStudioBanner(
          `Auto-split ${capturedPages.length} ${
            capturedPages.length === 1 ? 'photo' : 'photos'
          } into ${builtReviewed.length} short, kid-friendly pages. Switch any page to Watercolor, Smart Frame, a Painterly Scene, or On-Demand AI Art!`
        );
      }

      setConversionProgress(100);
      setStep('review');
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'ABORTED') {
        setStep('capture');
        return;
      }
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Something went wrong while scanning your storybook pages.'
      );
      setStep('capture');
    } finally {
      scanAbortRef.current = null;
    }
  };

  const handleSaveConvertedStory = async () => {
    if (!draftTitle.trim() || reviewedPages.length === 0) {
      setErrorMsg('Please enter a story title and keep at least one page before saving.');
      return;
    }

    if (reviewedPages.some((p) => p.isRedrawing) || isBatchGenerating || isImportingExtra) {
      setErrorMsg('Please wait a moment for page illustrations to finish before saving.');
      return;
    }

    setIsSaving(true);
    setErrorMsg(null);
    try {
      const storyId = editingStory ? editingStory.id : sanitizeId(`scanned_${Date.now()}`);
      const saveNonce = Date.now().toString(36);
      const pagesToSave: StoryPage[] = [];

      for (let i = 0; i < reviewedPages.length; i++) {
        const p = reviewedPages[i];
        const isPureScenePage = p.visualMode === 'scene' && !p.framedOverrideUrl;

        const chosenImage = isPureScenePage
          ? null
          : p.framedOverrideUrl ||
            (p.visualMode === 'redraw' && p.redrawnDataUrl
              ? p.redrawnDataUrl
              : p.isSmartFramed && p.smartFramedUrl
                ? p.smartFramedUrl
                : p.visualMode === 'watercolor' && p.watercolorDataUrl
                  ? p.watercolorDataUrl
                  : p.originalDataUrl || p.redrawnDataUrl || p.watercolorDataUrl);

        let mediaId = isPureScenePage ? '' : p.existingMediaId || '';
        if (chosenImage && (p.mediaDirty || !mediaId)) {
          mediaId = sanitizeId(`media_${storyId}_p${i + 1}_${saveNonce}`);
          await saveStoryMedia(storyId, mediaId, chosenImage);
        }

        pagesToSave.push({
          id: sanitizeId(p.id || `page_${i + 1}`),
          text: p.text.trim() || 'Enjoy this page together.',
          sceneSummary: p.sceneSummary.trim() || `Page ${i + 1} illustration`,
          mediaId: mediaId || undefined,
          visualMode: p.visualMode,
          fallbackArtId: normalizeBackdropId(p.sceneBackdropId || draftBackdrop, 'meadow'),
          hotspots: p.hotspots,
        });
      }

      const safeCoverIdx = Math.max(0, Math.min(pagesToSave.length - 1, coverPageIndex));
      const coverPage = pagesToSave[safeCoverIdx] || pagesToSave[0];
      const totalWords = pagesToSave.reduce((acc, p) => acc + countWords(p.text), 0);
      const estimatedMinutes = Math.max(1, Math.min(20, Math.ceil(totalWords / 110)));

      const finalStory: Story = {
        id: storyId,
        title: draftTitle.trim(),
        subtitle: draftSubtitle.trim() || 'Captured from your family bookshelf.',
        ageGroup,
        moralTitle: draftMoralTitle.trim() || 'Kindness',
        moralLesson:
          draftMoralLesson.trim() || 'Every story teaches us something gentle and good.',
        parentDiscussionPrompt:
          draftDiscussionPrompt.trim() || 'What was your favorite picture in this book?',
        coverMediaId: coverPage?.mediaId ?? '',
        coverFallbackId: normalizeBackdropId(coverPage?.fallbackArtId || draftBackdrop, 'meadow'),
        readMinutes: estimatedMinutes,
        isCustom: true,
        pages: pagesToSave,
        createdAtMs: editingStory?.createdAtMs ?? Date.now(),
      };

      await onSaveStory(finalStory, isEditMode, isAdmin ? publishToMainSite : false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save storybook changes.');
    } finally {
      setIsSaving(false);
    }
  };

  const remainingPageSlots = Math.max(0, MAX_STORY_PAGES - reviewedPages.length);

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-8 lg:py-10">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <button
          type="button"
          onClick={() => {
            stopCameraStream();
            onCancel();
          }}
          className="inline-flex items-center gap-2 min-h-[40px] text-sm font-semibold text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          {isEditMode ? 'Cancel Editing' : 'Back to Library'}
        </button>

        <div className="text-xs font-medium text-[#5C646B] dark:text-[#A4AEC2]">
          {isSignedIn ? 'Cloud Sync Active' : 'Saved on This Device'}
        </div>
      </div>

      <div className="mb-6">
        <h1 className="font-display text-2xl sm:text-4xl font-semibold text-[#24292E] dark:text-[#EDE9DF] mb-2">
          {isEditMode
            ? `Edit Storybook · ${editingStory?.title}`
            : createMode === 'manual'
              ? 'Create a Storybook Manually'
              : 'Scan a Physical Book or Screenshot'}
        </h1>
        <p className="text-sm sm:text-base text-[#5C646B] dark:text-[#A4AEC2] max-w-2xl leading-relaxed">
          {isEditMode
            ? 'Polish story text, split long pages for easier reading, choose built-in watercolor scenes or retouched photos, paint optional AI art, crop images, reorder pages, or import extra photos.'
            : createMode === 'manual'
              ? 'Write or paste your own story text, auto-split it into short kid-friendly pages, and upload your own photos or pick built-in painterly scenes — works 100% locally with zero scan required.'
              : 'Snap or upload book pages or screenshots for a fast single-pass scan. Keep softly retouched watercolor photos, pair text with 8 built-in painterly scenes, or paint optional AI illustrations per page.'}
        </p>

        {/* Creation Method Switcher (Scan vs Write Manually) */}
        {!isEditMode && step !== 'converting' && (
          <div
            role="tablist"
            aria-label="Choose how to add a storybook"
            className="mt-5 grid grid-cols-2 sm:inline-flex items-center gap-1 p-1 rounded-xl bg-[#EFECE5] dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] w-full sm:w-auto"
          >
            <button
              type="button"
              role="tab"
              aria-selected={createMode === 'scan'}
              onClick={() => handleSwitchCreateMode('scan')}
              className={`inline-flex items-center justify-center gap-2 min-h-[44px] px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-colors active:scale-[0.98] whitespace-nowrap cursor-pointer ${
                createMode === 'scan'
                  ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF] shadow-xs'
                  : 'text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF]'
              }`}
            >
              <Camera className="w-4 h-4 shrink-0" />
              <span className="sm:hidden">Scan Photos</span>
              <span className="hidden sm:inline">Scan Photos / Screenshots</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={createMode === 'manual'}
              onClick={() => handleSwitchCreateMode('manual')}
              className={`inline-flex items-center justify-center gap-2 min-h-[44px] px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-colors active:scale-[0.98] whitespace-nowrap cursor-pointer ${
                createMode === 'manual'
                  ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF] shadow-xs'
                  : 'text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF]'
              }`}
            >
              <PenLine className="w-4 h-4 shrink-0" />
              <span className="sm:hidden">Write Manually</span>
              <span className="hidden sm:inline">Write Manually (Text &amp; Images)</span>
            </button>
          </div>
        )}
      </div>

      {errorMsg && (
        <div className="mb-6 p-4 rounded-xl bg-[#C84B58]/10 border border-[#C84B58]/30 text-sm text-[#9C2F3B] dark:text-[#F299A3] flex flex-wrap items-center justify-between gap-3">
          <span className="flex-1 min-w-[220px]">{errorMsg}</span>
          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            {!isEditMode && step === 'capture' && capturedPages.length > 0 && (
              <>
                <button
                  type="button"
                  disabled={isLoadingManualPhotos}
                  onClick={() => void handleConvertPages()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-[#C84B58]/40 bg-white dark:bg-[#1A2033] hover:bg-[#C84B58]/10 text-[#9C2F3B] dark:text-[#F299A3] text-xs font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Retry Scan
                </button>
                <button
                  type="button"
                  disabled={isLoadingManualPhotos}
                  onClick={() => void handleContinueManuallyWithCapturedPhotos()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-xs font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                >
                  {isLoadingManualPhotos ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <PenLine className="w-3.5 h-3.5" />
                  )}
                  {isLoadingManualPhotos ? 'Preparing Studio...' : 'Continue Manually with These Photos'}
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              className="text-xs font-semibold underline shrink-0 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {studioBanner && (
        <div className="mb-6 p-3.5 rounded-xl bg-[#2F7A5E]/10 dark:bg-[#E5A94C]/12 border border-[#2F7A5E]/30 dark:border-[#E5A94C]/30 text-sm text-[#1E5641] dark:text-[#F4D39B] flex items-center justify-between gap-4">
          <span>{studioBanner}</span>
          <button
            type="button"
            onClick={() => setStudioBanner(null)}
            className="text-xs font-semibold underline shrink-0 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Hidden inputs for per-page image replacement, bulk local image upload & extra AI photo import */}
      <input
        ref={replacePhotoInputRef}
        type="file"
        accept="image/*"
        onChange={(e) => void handleReplacePhotoFile(e)}
        className="hidden"
      />
      <input
        ref={bulkManualImagesInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => void handleBulkUploadManualImages(e)}
        className="hidden"
      />
      <input
        ref={extraPhotoInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => void handleImportExtraPhotos(e)}
        className="hidden"
      />

      {/* Live Camera Modal */}
      {cameraOpen && (
        <div className="mb-8 p-5 rounded-2xl bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B]">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF]">
              Position a storybook page inside the frame
            </span>
            <button
              type="button"
              onClick={stopCameraStream}
              className="p-1.5 rounded-lg text-[#5C646B] hover:bg-[#F3EFE8] dark:hover:bg-[#232B42] cursor-pointer"
              aria-label="Close camera"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="relative aspect-[4/3] max-h-[380px] w-full rounded-xl overflow-hidden bg-black mb-4">
            <video ref={videoRef} playsInline muted className="w-full h-full object-cover" />
          </div>
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={stopCameraStream}
              className="px-4 py-2 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] text-sm font-semibold cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isSnappingPhoto}
              onClick={() => void snapFromLiveCamera()}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] text-white dark:text-[#121624] text-sm font-semibold disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            >
              {isSnappingPhoto ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Camera className="w-4 h-4" />
              )}
              {isSnappingPhoto ? 'Capturing...' : 'Capture Page'}
            </button>
          </div>
        </div>
      )}

      {/* STEP 1: CAPTURE NEW BOOK PHOTOS */}
      {step === 'capture' && !isEditMode && (
        <div className="space-y-6">
          <div className="bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] rounded-2xl p-6 sm:p-7">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-6 pb-6 border-b border-[#E6E1D8] dark:border-[#2A324B]">
              {/* Multi-Page Auto-Split Toggle */}
              <div>
                <label className="flex items-center gap-1.5 text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-2">
                  <Layers className="w-3.5 h-3.5" />
                  Multi-Page Reading Layout
                </label>
                <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-[#F2EFE8] dark:bg-[#121624] w-full">
                  <button
                    type="button"
                    onClick={() => setAutoSplitPages(true)}
                    className={`flex-1 py-2 px-2.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                      autoSplitPages
                        ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF]'
                        : 'text-[#5C646B] dark:text-[#A4AEC2]'
                    }`}
                  >
                    Auto-Split Short Pages
                  </button>
                  <button
                    type="button"
                    onClick={() => setAutoSplitPages(false)}
                    className={`flex-1 py-2 px-2.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                      !autoSplitPages
                        ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF]'
                        : 'text-[#5C646B] dark:text-[#A4AEC2]'
                    }`}
                  >
                    1 Photo = 1 Page
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-[#5C646B] dark:text-[#A4AEC2]">
                  {autoSplitPages
                    ? 'Splits long text or screenshots into short, easy-to-read storybook pages (up to 10 pages) with fresh art per page.'
                    : 'Keeps each uploaded photo as one single storybook page.'}
                </p>
              </div>

              {/* Reading Mode (Full Verbatim vs Simplified) */}
              <div>
                <label className="flex items-center gap-1.5 text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-2">
                  <BookOpenText className="w-3.5 h-3.5" />
                  Text Reading Mode
                </label>
                <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-[#F2EFE8] dark:bg-[#121624] w-full">
                  <button
                    type="button"
                    onClick={() => setTextMode('verbatim')}
                    className={`flex-1 py-2 px-2.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                      textMode === 'verbatim'
                        ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF]'
                        : 'text-[#5C646B] dark:text-[#A4AEC2]'
                    }`}
                  >
                    Read Every Word
                  </button>
                  <button
                    type="button"
                    onClick={() => setTextMode('simplified')}
                    className={`flex-1 py-2 px-2.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                      textMode === 'simplified'
                        ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF]'
                        : 'text-[#5C646B] dark:text-[#A4AEC2]'
                    }`}
                  >
                    Simplify for Age
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-[#5C646B] dark:text-[#A4AEC2]">
                  {textMode === 'verbatim'
                    ? 'Preserves every printed sentence verbatim across your split pages without summarizing.'
                    : `Adapts page text into gentle narration for ages ${ageGroup}.`}
                </p>
              </div>

              {/* Default Illustration Look */}
              <div>
                <label className="flex items-center gap-1.5 text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-2">
                  <Paintbrush className="w-3.5 h-3.5" />
                  Default Artwork Style
                </label>
                <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-[#F2EFE8] dark:bg-[#121624] w-full">
                  <button
                    type="button"
                    onClick={() => setDefaultVisualMode('watercolor')}
                    className={`flex-1 py-2 px-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                      defaultVisualMode === 'watercolor'
                        ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF]'
                        : 'text-[#5C646B] dark:text-[#A4AEC2]'
                    }`}
                  >
                    Watercolor Photo
                  </button>
                  <button
                    type="button"
                    onClick={() => setDefaultVisualMode('scene')}
                    className={`flex-1 py-2 px-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                      defaultVisualMode === 'scene'
                        ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF]'
                        : 'text-[#5C646B] dark:text-[#A4AEC2]'
                    }`}
                  >
                    Painterly Scenes
                  </button>
                  <button
                    type="button"
                    onClick={() => setDefaultVisualMode('photo')}
                    className={`flex-1 py-2 px-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                      defaultVisualMode === 'photo'
                        ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF]'
                        : 'text-[#5C646B] dark:text-[#A4AEC2]'
                    }`}
                  >
                    Original
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-[#5C646B] dark:text-[#A4AEC2]">
                  {defaultVisualMode === 'watercolor'
                    ? 'Instantly softens book photos into watercolor spreads; text-only screenshots automatically pair with matching painterly scenes.'
                    : defaultVisualMode === 'scene'
                      ? 'Pairs every page with our 8 built-in watercolor scenes — instant, crisp, and ideal for text screenshots.'
                      : 'Keeps your original photos as-is (you can still crop, retouch, pick a scene, or paint AI art in Review).'}
                </p>
              </div>

              {/* Target Age Group + Optional Title Hint */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 items-start">
                <div>
                  <label className="block text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-2">
                    Target Age Group
                  </label>
                  <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-[#F2EFE8] dark:bg-[#121624] w-full">
                    {(['2-3', '4-5'] as const).map((tier) => (
                      <button
                        key={tier}
                        type="button"
                        onClick={() => setAgeGroup(tier)}
                        className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                          ageGroup === tier
                            ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF]'
                            : 'text-[#5C646B] dark:text-[#A4AEC2]'
                        }`}
                      >
                        Ages {tier}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="scan-title-hint"
                    className="block text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-2"
                  >
                    Book Title (Optional)
                  </label>
                  <input
                    id="scan-title-hint"
                    type="text"
                    maxLength={100}
                    value={titleHint}
                    onChange={(e) => setTitleHint(e.target.value)}
                    placeholder="Auto-detected from pages"
                    className="w-full px-3.5 py-2 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#D8D1C4] dark:border-[#34405E] text-sm text-[#24292E] dark:text-[#EDE9DF] focus:outline-2 focus:outline-[#2F7A5E]"
                  />
                </div>
              </div>
            </div>

            {/* Capture Action Zone */}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={capturedPages.length >= MAX_UPLOAD_BATCH}
                onClick={() => void openLiveCamera()}
                className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-sm font-semibold transition-colors disabled:opacity-50 cursor-pointer"
              >
                <Camera className="w-4 h-4" />
                Take Snapshot
              </button>

              <button
                type="button"
                disabled={capturedPages.length >= MAX_UPLOAD_BATCH || isAddingCaptureFiles}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 px-5 py-3 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] hover:bg-[#F3EFE8] dark:hover:bg-[#232B42] text-[#24292E] dark:text-[#EDE9DF] text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {isAddingCaptureFiles ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
                {isAddingCaptureFiles ? 'Loading Photos...' : 'Upload Photos / Screenshots'}
              </button>

              <span className="text-xs text-[#5C646B] dark:text-[#A4AEC2] font-mono tabular-nums">
                {capturedPages.length} / {MAX_UPLOAD_BATCH} photos added
              </span>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={(e) => void handleFilesSelected(e)}
                className="hidden"
              />
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => void handleFilesSelected(e)}
                className="hidden"
              />
            </div>

            {captureUploadProgress && (
              <div className="mt-4">
                <ImageProgressBar
                  label={captureUploadProgress.label}
                  percent={captureUploadProgress.percent}
                  detail={captureUploadProgress.detail}
                />
              </div>
            )}

            {/* Captured Photos Grid */}
            {capturedPages.length > 0 && (
              <div className="mt-7 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {capturedPages.map((page, idx) => {
                  const previewUrl =
                    page.visualMode === 'watercolor' && page.watercolorDataUrl
                      ? page.watercolorDataUrl
                      : page.originalDataUrl;
                  return (
                    <div
                      key={page.id}
                      className="rounded-xl border border-[#E6E1D8] dark:border-[#2A324B] overflow-hidden bg-[#FAF8F4] dark:bg-[#121624]"
                    >
                      <div className="relative aspect-[4/3] overflow-hidden">
                        <img
                          src={previewUrl}
                          alt={`Uploaded photo ${idx + 1}`}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                        {page.visualMode === 'scene' && (
                          <div className="absolute bottom-2 left-2 right-2 px-2.5 py-1.5 rounded-lg bg-[#1A2033]/85 text-[#FAF8F4] text-[11px] font-medium flex items-center gap-1.5">
                            <Palette className="w-3.5 h-3.5 text-[#E5A94C] shrink-0" />
                            <span>
                              {autoSplitPages
                                ? 'Will split & pair with painterly scenes'
                                : 'Will pair with a matching painterly scene'}
                            </span>
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => removeCapturedPage(page.id)}
                          aria-label={`Remove photo ${idx + 1}`}
                          className="absolute top-2.5 right-2.5 w-8 h-8 rounded-lg bg-black/60 hover:bg-[#C84B58] text-white flex items-center justify-center transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>

                      <div className="p-3.5">
                        <div className="flex items-center justify-between text-xs font-semibold text-[#24292E] dark:text-[#EDE9DF] mb-2.5">
                          <span>Photo {idx + 1}</span>
                          <span className="text-[#5C646B] dark:text-[#A4AEC2] font-normal">
                            {page.visualMode === 'watercolor'
                              ? 'Watercolor Retouch'
                              : page.visualMode === 'scene'
                                ? 'Painterly Scene'
                                : 'Original Photo'}
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-1">
                          <button
                            type="button"
                            onClick={() => void toggleCapturedVisualMode(page.id, 'watercolor')}
                            className={`inline-flex items-center justify-center gap-1 py-1.5 px-1.5 rounded-lg text-[11px] font-semibold border transition-colors cursor-pointer ${
                              page.visualMode === 'watercolor'
                                ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624] border-transparent'
                                : 'border-[#D8D1C4] dark:border-[#34405E] text-[#5C646B] dark:text-[#A4AEC2]'
                            }`}
                          >
                            <Paintbrush className="w-3 h-3" />
                            Watercolor
                          </button>
                          <button
                            type="button"
                            onClick={() => void toggleCapturedVisualMode(page.id, 'scene')}
                            className={`inline-flex items-center justify-center gap-1 py-1.5 px-1.5 rounded-lg text-[11px] font-semibold border transition-colors cursor-pointer ${
                              page.visualMode === 'scene'
                                ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624] border-transparent'
                                : 'border-[#D8D1C4] dark:border-[#34405E] text-[#5C646B] dark:text-[#A4AEC2]'
                            }`}
                          >
                            <Palette className="w-3 h-3" />
                            Scene
                          </button>
                          <button
                            type="button"
                            onClick={() => void toggleCapturedVisualMode(page.id, 'photo')}
                            className={`inline-flex items-center justify-center gap-1 py-1.5 px-1.5 rounded-lg text-[11px] font-semibold border transition-colors cursor-pointer ${
                              page.visualMode === 'photo'
                                ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624] border-transparent'
                                : 'border-[#D8D1C4] dark:border-[#34405E] text-[#5C646B] dark:text-[#A4AEC2]'
                            }`}
                          >
                            <ImageIcon className="w-3 h-3" />
                            Photo
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {capturedPages.length > 0 && (
              <div className="mt-7 pt-5 border-t border-[#E6E1D8] dark:border-[#2A324B] flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  disabled={isLoadingManualPhotos || isAddingCaptureFiles}
                  onClick={() => void handleContinueManuallyWithCapturedPhotos()}
                  className="inline-flex items-center gap-2 px-4 py-3 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] hover:bg-[#F3EFE8] dark:hover:bg-[#232B42] text-[#24292E] dark:text-[#EDE9DF] text-xs sm:text-sm font-semibold transition-colors disabled:opacity-55 disabled:cursor-not-allowed cursor-pointer"
                >
                  {isLoadingManualPhotos ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <PenLine className="w-4 h-4" />
                  )}
                  {isLoadingManualPhotos ? 'Preparing Studio...' : 'Skip Scan & Add Text Manually'}
                </button>
                <button
                  type="button"
                  disabled={isLoadingManualPhotos || isAddingCaptureFiles}
                  onClick={() => void handleConvertPages()}
                  className="inline-flex items-center gap-2.5 px-6 py-3.5 rounded-xl bg-[#24292E] hover:bg-[#363D44] dark:bg-[#5CA49B] dark:hover:bg-[#4A8F86] text-white dark:text-[#121624] text-sm font-semibold transition-colors disabled:opacity-55 disabled:cursor-not-allowed cursor-pointer"
                >
                  <Sparkles className="w-4 h-4" />
                  {autoSplitPages
                    ? `Fast Scan & Split ${capturedPages.length} ${
                        capturedPages.length === 1 ? 'Photo' : 'Photos'
                      }`
                    : `Fast Scan ${capturedPages.length} ${
                        capturedPages.length === 1 ? 'Photo' : 'Photos'
                      }`}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* STEP 2: CONVERTING LOADER */}
      {(step === 'converting' || isHydratingEdit) && (
        <div className="bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] rounded-2xl p-10 sm:p-12 text-center">
          <Loader2 className="w-10 h-10 text-[#2F7A5E] dark:text-[#E5A94C] animate-spin mx-auto mb-4" />
          <h2 className="font-display text-2xl font-semibold text-[#24292E] dark:text-[#EDE9DF] mb-2">
            {isHydratingEdit
              ? 'Opening your saved storybook...'
              : 'Creating your multi-page interactive storybook'}
          </h2>
          <p className="text-sm text-[#5C646B] dark:text-[#A4AEC2] max-w-md mx-auto">
            {isHydratingEdit ? 'Loading pages and high-resolution artwork...' : conversionStatus}
          </p>
          {!isHydratingEdit && (
            <div className="max-w-md mx-auto mt-5 space-y-3">
              <div className="space-y-1.5">
                <div
                  role="progressbar"
                  aria-valuenow={conversionProgress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={conversionStatus}
                  className="h-2.5 w-full rounded-full bg-[#E6E1D8] dark:bg-[#27304A] overflow-hidden"
                >
                  <div
                    className="h-full rounded-full bg-[#2F7A5E] dark:bg-[#E5A94C] transition-[width] duration-200 ease-out"
                    style={{ width: `${Math.max(6, conversionProgress)}%` }}
                  />
                </div>
                <div className="text-xs font-mono tabular-nums font-semibold text-[#5C646B] dark:text-[#A4AEC2]">
                  {Math.max(6, conversionProgress)}%
                </div>
              </div>
              <button
                type="button"
                onClick={handleCancelScan}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] hover:bg-[#F3EFE8] dark:hover:bg-[#232B42] text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                Cancel Scan
              </button>
            </div>
          )}
        </div>
      )}

      {/* STEP 3: UNIFIED STORYBOOK STUDIO (REVIEW NEW SCAN OR EDIT SAVED BOOK) */}
      {step === 'review' && !isHydratingEdit && (
        <div className="space-y-6">
          {/* Book Details & Studio Action Bar */}
          <div className="bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] rounded-2xl p-6 sm:p-7 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-[#E6E1D8] dark:border-[#2A324B]">
              <div>
                <h2 className="font-display text-2xl font-semibold text-[#24292E] dark:text-[#EDE9DF]">
                  {isEditMode ? 'Storybook Studio' : 'Review & Customize Your Book'}
                </h2>
                <p className="text-xs text-[#5C646B] dark:text-[#A4AEC2] mt-0.5">
                  Edit text, split long pages, switch between Watercolor Photo, 8 Painterly Scenes, or optional on-demand AI art, smart-frame or crop images, reorder pages, or import extra photos.
                </p>
              </div>

              <div className="font-mono text-xs font-semibold tabular-nums px-3 py-1.5 rounded-lg bg-[#FAF8F4] dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B] text-[#24292E] dark:text-[#EDE9DF]">
                {reviewedPages.length} / {MAX_STORY_PAGES} pages
              </div>
            </div>

            {/* Book Metadata Fields */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
              <div className="md:col-span-4">
                <label className="block text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-1.5">
                  Story Title
                </label>
                <input
                  type="text"
                  maxLength={120}
                  value={draftTitle}
                  placeholder="e.g., Barnaby’s Big Picnic"
                  onChange={(e) => setDraftTitle(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#D8D1C4] dark:border-[#34405E] text-sm text-[#24292E] dark:text-[#EDE9DF]"
                />
              </div>

              <div className="md:col-span-4">
                <label className="block text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-1.5">
                  Short Summary
                </label>
                <input
                  type="text"
                  maxLength={180}
                  value={draftSubtitle}
                  placeholder="A gentle tale about sharing and wonder."
                  onChange={(e) => setDraftSubtitle(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#D8D1C4] dark:border-[#34405E] text-sm text-[#24292E] dark:text-[#EDE9DF]"
                />
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-1.5">
                  Age Group
                </label>
                <select
                  value={ageGroup}
                  onChange={(e) => setAgeGroup(e.target.value as AgeGroup)}
                  className="w-full px-3 py-2.5 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#D8D1C4] dark:border-[#34405E] text-sm font-medium text-[#24292E] dark:text-[#EDE9DF]"
                >
                  <option value="2-3">Ages 2–3</option>
                  <option value="4-5">Ages 4–5</option>
                </select>
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-1.5">
                  Default Backdrop
                </label>
                <select
                  value={draftBackdrop}
                  onChange={(e) => setDraftBackdrop(e.target.value as BackdropId)}
                  className="w-full px-3 py-2.5 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#D8D1C4] dark:border-[#34405E] text-sm font-medium text-[#24292E] dark:text-[#EDE9DF]"
                >
                  {BACKDROP_SCENE_CATALOG.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Quick Paste Full Story & Auto-Split Helper (100% client-side) */}
            {showManualPasteBox && (
              <div className="p-4 sm:p-5 rounded-xl bg-[#F4EFE6] dark:bg-[#161C2E] border border-[#D8D1C4] dark:border-[#34405E] space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF] flex items-center gap-1.5">
                      <Layers className="w-4 h-4 text-[#2F7A5E] dark:text-[#E5A94C]" />
                      Paste Full Story &amp; Auto-Split into Short Pages
                    </h3>
                    <p className="text-xs text-[#5C646B] dark:text-[#A4AEC2] mt-0.5">
                      Paste an entire story below and click Auto-Split to divide it into short,
                      kid-friendly pages for ages {ageGroup} — or close this box to type page by
                      page.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowManualPasteBox(false)}
                    className="p-1 rounded-md text-[#5C646B] hover:text-[#24292E] dark:hover:text-[#EDE9DF] cursor-pointer"
                    aria-label="Hide quick paste box"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <textarea
                  rows={5}
                  value={manualFullText}
                  onChange={(e) => setManualFullText(e.target.value)}
                  placeholder="Paste or type your full story here (paragraphs or sentences). Meadowtale will neatly split it into up to 10 short storybook pages without dropping a single word..."
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#121624] border border-[#D8D1C4] dark:border-[#34405E] text-sm leading-relaxed text-[#24292E] dark:text-[#EDE9DF] focus:outline-2 focus:outline-[#2F7A5E]"
                />

                <div className="flex flex-wrap items-center justify-between gap-2.5">
                  <span className="text-[11px] font-mono tabular-nums text-[#5C646B] dark:text-[#A4AEC2]">
                    {countWords(manualFullText)} words pasted
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={isBulkUploadingImages}
                      onClick={() => bulkManualImagesInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] bg-white dark:bg-[#1A2033] hover:border-[#2F7A5E] dark:hover:border-[#E5A94C] text-xs font-semibold text-[#24292E] dark:text-[#EDE9DF] disabled:opacity-55 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {isBulkUploadingImages ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Images className="w-3.5 h-3.5" />
                      )}
                      {isBulkUploadingImages ? 'Adding Images...' : 'Upload Page Images'}
                    </button>
                    <button
                      type="button"
                      disabled={!manualFullText.trim()}
                      onClick={handleApplyAutoSplitManualText}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-xs font-semibold transition-colors disabled:opacity-45 cursor-pointer"
                    >
                      <Scissors className="w-3.5 h-3.5" />
                      Auto-Split into Short Pages
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Batch Multi-Image Generator & Page Adding Toolbar */}
            <div className="p-4 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B] flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Illustration style for batch painting"
                  value={defaultRedrawStyle}
                  onChange={(e) => setDefaultRedrawStyle(e.target.value as RedrawStyle)}
                  className="px-3 py-2 rounded-lg bg-white dark:bg-[#1A2033] border border-[#D8D1C4] dark:border-[#34405E] text-xs font-semibold text-[#24292E] dark:text-[#EDE9DF]"
                >
                  {REDRAW_STYLES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  disabled={isBatchGenerating || isImportingExtra || reviewedPages.length === 0}
                  onClick={() => void handleGenerateAllIllustrations()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-xs font-semibold transition-colors disabled:opacity-50 cursor-pointer"
                >
                  {isBatchGenerating ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Wand2 className="w-3.5 h-3.5" />
                  )}
                  {isBatchGenerating
                    ? 'Painting AI Art...'
                    : `Paint AI Art for All ${reviewedPages.length} Pages`}
                </button>

                {isBatchGenerating && (
                  <button
                    type="button"
                    onClick={handleStopBatchGeneration}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#C84B58] hover:bg-[#AD3B47] text-white text-xs font-semibold transition-colors cursor-pointer"
                  >
                    <Square className="w-3 h-3 fill-current" />
                    Stop
                  </button>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {!showManualPasteBox && (
                  <button
                    type="button"
                    onClick={() => setShowManualPasteBox(true)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] bg-white dark:bg-[#1A2033] hover:border-[#2F7A5E] dark:hover:border-[#E5A94C] text-xs font-semibold text-[#24292E] dark:text-[#EDE9DF] cursor-pointer"
                  >
                    <Layers className="w-3.5 h-3.5" />
                    Paste &amp; Auto-Split Text
                  </button>
                )}

                <button
                  type="button"
                  disabled={isBatchGenerating || isImportingExtra || isBulkUploadingImages}
                  onClick={() => bulkManualImagesInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] bg-white dark:bg-[#1A2033] hover:border-[#2F7A5E] dark:hover:border-[#E5A94C] text-xs font-semibold text-[#24292E] dark:text-[#EDE9DF] disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer"
                >
                  {isBulkUploadingImages ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Images className="w-3.5 h-3.5" />
                  )}
                  {isBulkUploadingImages ? 'Adding Images...' : 'Upload Page Images'}
                </button>

                <button
                  type="button"
                  disabled={remainingPageSlots <= 0 || isBatchGenerating || isImportingExtra}
                  onClick={() => setShowExtraImporter((prev) => !prev)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] bg-white dark:bg-[#1A2033] hover:border-[#2F7A5E] dark:hover:border-[#E5A94C] text-xs font-semibold text-[#24292E] dark:text-[#EDE9DF] disabled:opacity-45 cursor-pointer"
                >
                  <ImagePlus className="w-3.5 h-3.5" />
                  Scan Extra Photos
                </button>

                <button
                  type="button"
                  disabled={remainingPageSlots <= 0 || isBatchGenerating || isImportingExtra}
                  onClick={handleAddBlankPage}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] bg-white dark:bg-[#1A2033] hover:border-[#2F7A5E] dark:hover:border-[#E5A94C] text-xs font-semibold text-[#24292E] dark:text-[#EDE9DF] disabled:opacity-45 cursor-pointer"
                >
                  <FilePlus2 className="w-3.5 h-3.5" />
                  Add Blank Page
                </button>
              </div>
            </div>

            {studioUploadProgress && (
              <ImageProgressBar
                label={studioUploadProgress.label}
                percent={studioUploadProgress.percent}
                detail={studioUploadProgress.detail}
              />
            )}

            {batchProgressText && (
              <ImageProgressBar label={batchProgressText} percent={batchProgressPercent} />
            )}

            {/* Inline Extra Photos Importer Drawer */}
            {showExtraImporter && (
              <div className="p-4 rounded-xl bg-[#F4EFE6] dark:bg-[#161C2E] border border-[#D8D1C4] dark:border-[#34405E] space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF]">
                      Import Extra Photos into This Book
                    </h3>
                    <p className="text-xs text-[#5C646B] dark:text-[#A4AEC2] mt-0.5">
                      Add up to {remainingPageSlots} more{' '}
                      {remainingPageSlots === 1 ? 'page' : 'pages'} from new photos or screenshots.
                      Text will be read verbatim and appended to this storybook.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowExtraImporter(false)}
                    className="p-1 rounded-md text-[#5C646B] hover:text-[#24292E] dark:hover:text-[#EDE9DF] cursor-pointer"
                    aria-label="Close extra photo importer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-4 text-xs text-[#24292E] dark:text-[#EDE9DF]">
                    <label className="inline-flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoSplitPages}
                        onChange={(e) => setAutoSplitPages(e.target.checked)}
                        className="w-4 h-4 accent-[#2F7A5E] dark:accent-[#E5A94C]"
                      />
                      Auto-split long text
                    </label>
                    <label className="inline-flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={extraUseScenes}
                        onChange={(e) => setExtraUseScenes(e.target.checked)}
                        className="w-4 h-4 accent-[#2F7A5E] dark:accent-[#E5A94C]"
                      />
                      Pair imported pages with Painterly Scenes instead of photos
                    </label>
                  </div>

                  <button
                    type="button"
                    disabled={isImportingExtra || remainingPageSlots <= 0}
                    onClick={() => extraPhotoInputRef.current?.click()}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] text-white dark:text-[#121624] text-xs font-semibold disabled:opacity-50 cursor-pointer"
                  >
                    {isImportingExtra ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Upload className="w-3.5 h-3.5" />
                    )}
                    {isImportingExtra ? 'Importing...' : 'Choose Photos to Append'}
                  </button>
                </div>

                {extraImportStatus && (
                  <ImageProgressBar label={extraImportStatus} percent={extraImportProgress} />
                )}
              </div>
            )}

            {/* Editable Multi-Page List */}
            <div className="space-y-5 pt-1">
              {reviewedPages.map((page, idx) => {
                const displaySrc = getPageDisplayImage(page, draftBackdrop);
                const wordCount = countWords(page.text);
                const isCover = idx === coverPageIndex;
                const hasSourcePhoto = Boolean(page.originalDataUrl);

                return (
                  <div
                    key={page.id}
                    className="grid grid-cols-1 lg:grid-cols-12 gap-5 p-4 sm:p-5 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B]"
                  >
                    {/* Left Column: Artwork Preview + Image Controls */}
                    <div className="lg:col-span-5 space-y-2.5">
                      <div className="relative aspect-[4/3] rounded-xl overflow-hidden bg-[#EFEBE2] dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B]">
                        <img
                          src={displaySrc}
                          alt={`Page ${idx + 1}`}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />

                        {/* Cover Selector Tag */}
                        <div className="absolute top-2.5 left-2.5">
                          {isCover ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624] text-[11px] font-semibold shadow-sm">
                              <Star className="w-3 h-3 fill-current" />
                              Book Cover
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setCoverPageIndex(idx)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#121624]/70 hover:bg-[#121624]/90 text-white text-[11px] font-medium transition-colors cursor-pointer"
                            >
                              <Star className="w-3 h-3" />
                              Use as Cover
                            </button>
                          )}
                        </div>

                        {page.isRedrawing && (
                          <div className="absolute inset-0 bg-[#121624]/75 backdrop-blur-xs flex flex-col items-center justify-center text-white p-4 text-center">
                            <Loader2 className="w-7 h-7 animate-spin text-[#E5A94C] mb-2" />
                            <span className="text-xs font-semibold">
                              Painting Page {idx + 1} illustration...
                            </span>
                          </div>
                        )}

                        {replacingPageProgress?.pageId === page.id && (
                          <div className="absolute inset-0 bg-[#121624]/78 backdrop-blur-xs flex flex-col items-center justify-center text-white p-5">
                            <Loader2 className="w-6 h-6 animate-spin text-[#E5A94C] mb-2.5" />
                            <div className="w-full max-w-[220px] space-y-1.5">
                              <div className="flex items-center justify-between gap-2 text-[11px] font-semibold">
                                <span className="truncate">{replacingPageProgress.stage}</span>
                                <span className="font-mono tabular-nums shrink-0">
                                  {replacingPageProgress.percent}%
                                </span>
                              </div>
                              <div
                                role="progressbar"
                                aria-valuenow={replacingPageProgress.percent}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-label={replacingPageProgress.stage}
                                className="h-2 w-full rounded-full bg-white/20 overflow-hidden"
                              >
                                <div
                                  className="h-full rounded-full bg-[#E5A94C] transition-[width] duration-150 ease-out"
                                  style={{ width: `${replacingPageProgress.percent}%` }}
                                />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* 4-Way Artwork Mode Switcher */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                        <button
                          type="button"
                          disabled={page.isRedrawing || !hasSourcePhoto}
                          onClick={() => void handleSelectReviewVisualMode(page.id, 'watercolor')}
                          className={`inline-flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-[11px] font-semibold border cursor-pointer disabled:opacity-40 whitespace-nowrap ${
                            page.visualMode === 'watercolor'
                              ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624] border-transparent'
                              : 'border-[#D8D1C4] dark:border-[#34405E] text-[#5C646B] dark:text-[#A4AEC2]'
                          }`}
                        >
                          <Paintbrush className="w-3 h-3 shrink-0" />
                          Watercolor
                        </button>
                        <button
                          type="button"
                          disabled={page.isRedrawing}
                          onClick={() => void handleSelectReviewVisualMode(page.id, 'scene')}
                          className={`inline-flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-[11px] font-semibold border cursor-pointer disabled:opacity-50 whitespace-nowrap ${
                            page.visualMode === 'scene'
                              ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624] border-transparent'
                              : 'border-[#D8D1C4] dark:border-[#34405E] text-[#5C646B] dark:text-[#A4AEC2]'
                          }`}
                        >
                          <Palette className="w-3 h-3 shrink-0" />
                          Scene
                        </button>
                        <button
                          type="button"
                          disabled={page.isRedrawing || !hasSourcePhoto}
                          onClick={() => void handleSelectReviewVisualMode(page.id, 'photo')}
                          className={`inline-flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-[11px] font-semibold border cursor-pointer disabled:opacity-40 whitespace-nowrap ${
                            page.visualMode === 'photo'
                              ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624] border-transparent'
                              : 'border-[#D8D1C4] dark:border-[#34405E] text-[#5C646B] dark:text-[#A4AEC2]'
                          }`}
                        >
                          <ImageIcon className="w-3 h-3 shrink-0" />
                          Photo
                        </button>
                        <button
                          type="button"
                          disabled={page.isRedrawing}
                          onClick={() => void handleSelectReviewVisualMode(page.id, 'redraw')}
                          className={`inline-flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-[11px] font-semibold border cursor-pointer disabled:opacity-50 whitespace-nowrap ${
                            page.visualMode === 'redraw'
                              ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624] border-transparent'
                              : 'border-[#D8D1C4] dark:border-[#34405E] text-[#5C646B] dark:text-[#A4AEC2]'
                          }`}
                        >
                          <Wand2 className="w-3 h-3 shrink-0" />
                          AI Art
                        </button>
                      </div>

                      {/* Built-in 8 Painterly Scenes Visual Picker (instant, zero API calls) */}
                      {page.visualMode === 'scene' && (
                        <div className="p-2.5 rounded-xl bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B]">
                          <div className="flex items-center justify-between text-[11px] font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-2">
                            <span>Choose Painterly Scene</span>
                            <span className="font-normal">
                              {BACKDROP_SCENE_CATALOG.find((s) => s.id === page.sceneBackdropId)
                                ?.label || 'Sunny Meadow'}
                            </span>
                          </div>
                          <div className="grid grid-cols-4 gap-1.5">
                            {BACKDROP_SCENE_CATALOG.map((scene) => {
                              const selected = page.sceneBackdropId === scene.id;
                              return (
                                <button
                                  key={scene.id}
                                  type="button"
                                  onClick={() => handleSelectPageScene(page.id, scene.id)}
                                  title={`${scene.label} — ${scene.mood}`}
                                  aria-label={`Use ${scene.label} scene for Page ${idx + 1}`}
                                  aria-pressed={selected}
                                  className={`group rounded-lg overflow-hidden border text-left transition-all cursor-pointer ${
                                    selected
                                      ? 'border-[#2F7A5E] dark:border-[#E5A94C] ring-2 ring-[#2F7A5E]/35 dark:ring-[#E5A94C]/40'
                                      : 'border-[#E6E1D8] dark:border-[#2A324B] hover:border-[#2F7A5E]/60 dark:hover:border-[#E5A94C]/60'
                                  }`}
                                >
                                  <div className="aspect-[4/3] overflow-hidden bg-[#EFEBE2] dark:bg-[#121624]">
                                    <img
                                      src={BACKDROP_ART_MAP[scene.id]}
                                      alt={scene.label}
                                      referrerPolicy="no-referrer"
                                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                                    />
                                  </div>
                                  <div className="px-1 py-0.5 text-[10px] font-medium text-[#24292E] dark:text-[#EDE9DF] truncate text-center bg-[#FAF8F4] dark:bg-[#121624]">
                                    {scene.label.split(' ')[0]}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* 1-Tap Smart Frame Illustration Button (when scan detected artwork region) */}
                      {hasSourcePhoto &&
                        page.artCropBox &&
                        page.visualMode !== 'scene' &&
                        page.visualMode !== 'redraw' && (
                          <button
                            type="button"
                            disabled={page.isRedrawing || replacingPageId === page.id}
                            onClick={() => void handleToggleSmartFrame(page.id)}
                            className={`w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors disabled:opacity-50 cursor-pointer ${
                              page.isSmartFramed
                                ? 'bg-[#2F7A5E]/12 dark:bg-[#E5A94C]/15 border-[#2F7A5E]/40 dark:border-[#E5A94C]/40 text-[#1E5641] dark:text-[#F4D39B]'
                                : 'bg-white dark:bg-[#1A2033] border-[#D8D1C4] dark:border-[#34405E] hover:border-[#2F7A5E] dark:hover:border-[#E5A94C] text-[#24292E] dark:text-[#EDE9DF]'
                            }`}
                          >
                            <Focus className="w-3.5 h-3.5 text-[#2F7A5E] dark:text-[#E5A94C]" />
                            {page.isSmartFramed
                              ? 'Show Full Page Photo'
                              : 'Smart Frame Illustration'}
                          </button>
                        )}

                      {/* Optional On-Demand AI Art Style Picker + Paint / Redraw Button */}
                      <div className="flex items-center gap-1.5">
                        <select
                          aria-label={`Illustration style for page ${idx + 1}`}
                          value={page.artStyle}
                          disabled={page.isRedrawing}
                          onChange={(e) => {
                            const nextStyle = e.target.value as RedrawStyle;
                            setReviewedPages((prev) =>
                              prev.map((item) =>
                                item.id === page.id ? { ...item, artStyle: nextStyle } : item
                              )
                            );
                          }}
                          className="flex-1 px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#1A2033] border border-[#D8D1C4] dark:border-[#34405E] text-xs font-medium text-[#24292E] dark:text-[#EDE9DF]"
                        >
                          {REDRAW_STYLES.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.label}
                            </option>
                          ))}
                        </select>

                        <button
                          type="button"
                          disabled={page.isRedrawing || isBatchGenerating}
                          onClick={() => void handleRedrawSinglePage(page.id, page.artStyle)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#24292E] hover:bg-[#363D44] dark:bg-[#27304A] dark:hover:bg-[#333F61] text-white text-xs font-semibold transition-colors disabled:opacity-55 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
                        >
                          {page.isRedrawing ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" />
                          )}
                          {page.isRedrawing
                            ? 'Painting...'
                            : page.redrawnDataUrl
                              ? 'Redraw AI Art'
                              : 'Paint AI Art'}
                        </button>
                      </div>

                      {/* Resize & Crop + Replace Photo Row */}
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          type="button"
                          disabled={page.isRedrawing || replacingPageId === page.id}
                          onClick={() => setFramingPageId(page.id)}
                          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] bg-white dark:bg-[#1A2033] hover:border-[#2F7A5E] dark:hover:border-[#E5A94C] text-xs font-semibold text-[#24292E] dark:text-[#EDE9DF] transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                        >
                          <Crop className="w-3.5 h-3.5 text-[#2F7A5E] dark:text-[#E5A94C]" />
                          {page.framedOverrideUrl ? 'Adjust Crop' : 'Resize & Crop'}
                        </button>

                        <button
                          type="button"
                          disabled={page.isRedrawing || replacingPageId === page.id}
                          onClick={() => handleTriggerReplacePhoto(page.id)}
                          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] bg-white dark:bg-[#1A2033] hover:border-[#2F7A5E] dark:hover:border-[#E5A94C] text-xs font-semibold text-[#24292E] dark:text-[#EDE9DF] transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                        >
                          {replacingPageId === page.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Upload className="w-3.5 h-3.5" />
                          )}
                          {replacingPageId === page.id
                            ? 'Loading...'
                            : hasSourcePhoto || page.redrawnDataUrl
                              ? 'Replace Image'
                              : 'Upload Image'}
                        </button>
                      </div>

                      {page.redrawError && (
                        <div className="p-2.5 rounded-lg bg-[#C84B58]/10 border border-[#C84B58]/30 space-y-2">
                          <p className="text-[11px] leading-snug text-[#9C2F3B] dark:text-[#F299A3]">
                            {page.redrawError}
                          </p>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              disabled={page.isRedrawing || isBatchGenerating}
                              onClick={() => void handleRedrawSinglePage(page.id, page.artStyle)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#24292E] hover:bg-[#363D44] dark:bg-[#27304A] dark:hover:bg-[#333F61] text-white text-[11px] font-semibold disabled:opacity-50 cursor-pointer"
                            >
                              <RefreshCw className="w-3 h-3" />
                              Retry
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSelectPageScene(page.id, page.sceneBackdropId)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-[11px] font-semibold cursor-pointer"
                            >
                              <Palette className="w-3 h-3" />
                              Use Painterly Scene
                            </button>
                          </div>
                        </div>
                      )}
                      {page.redrawNote && page.visualMode === 'redraw' && !page.redrawError && (
                        <p className="text-[11px] text-[#2F7A5E] dark:text-[#5CA49B]">
                          {page.redrawNote}
                        </p>
                      )}
                    </div>

                    {/* Right Column: Editable Text, Scene Prompt & Structure Controls */}
                    <div className="lg:col-span-7 flex flex-col gap-3">
                      {/* Page Header & Structure Actions */}
                      <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#E6E1D8] dark:border-[#2A324B]">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-semibold text-[#24292E] dark:text-[#EDE9DF]">
                            Page {idx + 1}
                          </span>
                          <span aria-hidden="true" className="text-[#5C646B] dark:text-[#A4AEC2]">
                            ·
                          </span>
                          <span className="font-mono tabular-nums text-[#5C646B] dark:text-[#A4AEC2]">
                            {wordCount} {wordCount === 1 ? 'word' : 'words'}
                          </span>
                          {wordCount > 65 && (
                            <span className="text-[11px] font-medium text-[#B86E14] dark:text-[#E5A94C]">
                              · Long text — try Split Page
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={idx === 0}
                            onClick={() => handleMovePage(idx, -1)}
                            title="Move page earlier"
                            aria-label={`Move page ${idx + 1} up`}
                            className="p-1.5 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] bg-white dark:bg-[#1A2033] text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] disabled:opacity-35 cursor-pointer"
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={idx === reviewedPages.length - 1}
                            onClick={() => handleMovePage(idx, 1)}
                            title="Move page later"
                            aria-label={`Move page ${idx + 1} down`}
                            className="p-1.5 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] bg-white dark:bg-[#1A2033] text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] disabled:opacity-35 cursor-pointer"
                          >
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={reviewedPages.length >= MAX_STORY_PAGES}
                            onClick={() => handleSplitPage(idx)}
                            title="Split this page into two pages"
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] bg-white dark:bg-[#1A2033] hover:border-[#2F7A5E] dark:hover:border-[#E5A94C] text-[11px] font-semibold text-[#24292E] dark:text-[#EDE9DF] disabled:opacity-35 cursor-pointer"
                          >
                            <Scissors className="w-3.5 h-3.5" />
                            Split Page
                          </button>
                          <button
                            type="button"
                            disabled={reviewedPages.length <= 1}
                            onClick={() => handleDeletePage(idx)}
                            title="Delete page"
                            aria-label={`Delete page ${idx + 1}`}
                            className="p-1.5 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] bg-white dark:bg-[#1A2033] text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#C84B58] dark:hover:text-[#E06D7A] disabled:opacity-35 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Story Text Editor */}
                      <div className="flex-1 flex flex-col">
                        <label className="text-[11px] font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-1">
                          Story Text (Read Aloud on This Page)
                        </label>
                        <textarea
                          rows={Math.min(10, Math.max(4, Math.ceil(page.text.length / 78)))}
                          maxLength={3000}
                          value={page.text}
                          placeholder="Write or edit the story sentences for this page..."
                          onChange={(e) => {
                            const val = e.target.value;
                            setReviewedPages((prev) =>
                              prev.map((item) =>
                                item.id === page.id ? { ...item, text: val } : item
                              )
                            );
                          }}
                          className="w-full flex-1 px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#1A2033] border border-[#D8D1C4] dark:border-[#34405E] text-sm leading-relaxed text-[#24292E] dark:text-[#EDE9DF] focus:outline-2 focus:outline-[#2F7A5E]"
                        />
                      </div>

                      {/* Editable Scene Description Cue for AI Illustrator */}
                      <div>
                        <label className="text-[11px] font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-1 block">
                          Scene Cue for AI Illustrator (Optional)
                        </label>
                        <input
                          type="text"
                          maxLength={300}
                          value={page.sceneSummary}
                          placeholder="Describe characters, colors, or action to illustrate on this page..."
                          onChange={(e) => {
                            const val = e.target.value;
                            setReviewedPages((prev) =>
                              prev.map((item) =>
                                item.id === page.id ? { ...item, sceneSummary: val } : item
                              )
                            );
                          }}
                          className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] text-xs text-[#24292E] dark:text-[#EDE9DF] focus:outline-2 focus:outline-[#2F7A5E]"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* End-of-Story Moral Editor */}
            <div className="pt-5 border-t border-[#E6E1D8] dark:border-[#2A324B] space-y-4">
              <h3 className="font-display text-lg font-semibold text-[#24292E] dark:text-[#EDE9DF]">
                End-of-Story Moral & Family Prompt
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-1.5">
                    Core Value
                  </label>
                  <input
                    type="text"
                    maxLength={60}
                    value={draftMoralTitle}
                    onChange={(e) => setDraftMoralTitle(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#D8D1C4] dark:border-[#34405E] text-sm text-[#24292E] dark:text-[#EDE9DF]"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-1.5">
                    Child-Friendly Moral Lesson
                  </label>
                  <input
                    type="text"
                    maxLength={360}
                    value={draftMoralLesson}
                    onChange={(e) => setDraftMoralLesson(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#D8D1C4] dark:border-[#34405E] text-sm text-[#24292E] dark:text-[#EDE9DF]"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-1.5">
                  Parent Talk-Together Question
                </label>
                <input
                  type="text"
                  maxLength={240}
                  value={draftDiscussionPrompt}
                  onChange={(e) => setDraftDiscussionPrompt(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#D8D1C4] dark:border-[#34405E] text-sm text-[#24292E] dark:text-[#EDE9DF]"
                />
              </div>
            </div>

            {/* Admin Publish-to-Main-Site Toggle */}
            {isAdmin && (
              <label className="flex items-start gap-3 p-4 rounded-xl bg-[#2F7A5E]/6 dark:bg-[#E5A94C]/10 border border-[#2F7A5E]/25 dark:border-[#E5A94C]/25 cursor-pointer">
                <input
                  type="checkbox"
                  checked={publishToMainSite}
                  onChange={(e) => setPublishToMainSite(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded accent-[#2F7A5E] dark:accent-[#E5A94C] cursor-pointer"
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF]">
                    <Globe className="w-4 h-4 text-[#2F7A5E] dark:text-[#E5A94C] shrink-0" />
                    <span>Publish to Main Site (Admin)</span>
                  </div>
                  <p className="text-xs text-[#5C646B] dark:text-[#A4AEC2] mt-0.5">
                    Make this storybook and its artwork visible on the public Meadowtale shelf for
                    all visitors, including guests and other devices.
                  </p>
                </div>
              </label>
            )}

            {/* Footer Save Actions */}
            <div className="pt-5 border-t border-[#E6E1D8] dark:border-[#2A324B] flex flex-wrap items-center justify-between gap-3">
              {!isEditMode && createMode === 'scan' ? (
                <button
                  type="button"
                  onClick={() => setStep('capture')}
                  className="px-4 py-2.5 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] text-sm font-semibold text-[#5C646B] dark:text-[#A4AEC2] cursor-pointer"
                >
                  Back to Photos
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onCancel}
                  className="px-4 py-2.5 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] text-sm font-semibold text-[#5C646B] dark:text-[#A4AEC2] cursor-pointer"
                >
                  {isEditMode ? 'Discard Changes' : 'Cancel'}
                </button>
              )}

              <button
                type="button"
                disabled={isSaving || isBatchGenerating || isImportingExtra || isBulkUploadingImages}
                onClick={() => void handleSaveConvertedStory()}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-sm font-semibold transition-colors disabled:opacity-65 disabled:cursor-not-allowed cursor-pointer"
              >
                {isSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : isEditMode ? (
                  <Check className="w-4 h-4" />
                ) : (
                  <BookPlus className="w-4 h-4" />
                )}
                {isSaving
                  ? isAdmin && publishToMainSite
                    ? 'Saving & Publishing...'
                    : isEditMode
                      ? 'Saving Changes...'
                      : 'Saving Storybook...'
                  : isAdmin && publishToMainSite
                    ? isEditMode
                      ? 'Save & Update Main Site'
                      : 'Save & Publish to Main Site'
                    : isEditMode
                      ? 'Save Storybook Changes'
                      : 'Save to Storybook Library'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Interactive Resize, Crop & Watercolor Framing Modal */}
      {framingPageId &&
        (() => {
          const targetIdx = reviewedPages.findIndex((p) => p.id === framingPageId);
          const target = reviewedPages[targetIdx];
          if (!target) return null;
          const baseSrc =
            target.framedOverrideUrl || getPageDisplayImage(target, draftBackdrop);
          return (
            <PageImageFramingModal
              sourceImageUrl={baseSrc}
              pageLabel={`Page ${targetIdx + 1}`}
              onCancel={() => setFramingPageId(null)}
              onApply={(framedUrl) => {
                setReviewedPages((prev) =>
                  prev.map((item) =>
                    item.id === framingPageId
                      ? { ...item, framedOverrideUrl: framedUrl, mediaDirty: true }
                      : item
                  )
                );
                setFramingPageId(null);
                setStudioBanner(`Updated crop & framing for Page ${targetIdx + 1}.`);
              }}
            />
          );
        })()}
    </main>
  );
}
