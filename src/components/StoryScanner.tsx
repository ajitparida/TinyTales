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
  Image as ImageIcon,
  ImagePlus,
  Images,
  Layers,
  Loader2,
  Paintbrush,
  PenLine,
  RefreshCw,
  Scissors,
  Sparkles,
  Star,
  Trash2,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import { AgeGroup, BackdropId, CharacterHotspot, Story, StoryPage } from '../types/story';
import { BACKDROP_ART_MAP } from '../data/curatedStories';
import {
  compressDataUrlForApi,
  fileToCompressedDataUrl,
  renderRedrawnSvgToWatercolorCanvas,
  renderWatercolorStorybookStyle,
} from '../lib/watercolorFilter';
import { getMediaDataUrl, saveMediaDataUrl } from '../lib/mediaStore';
import { sanitizeId } from '../lib/firebase';
import { PageImageFramingModal } from './PageImageFramingModal';

type VisualMode = 'photo' | 'watercolor' | 'redraw';
type TextMode = 'verbatim' | 'simplified';
type RedrawStyle = 'watercolor' | 'pastel' | 'gouache';
type CreateMode = 'scan' | 'manual';

const MAX_STORY_PAGES = 10;
const MAX_UPLOAD_BATCH = 6;

interface CapturedPageDraft {
  id: string;
  originalDataUrl: string;
  watercolorDataUrl: string | null;
  mimeType: string;
  visualMode: VisualMode;
}

interface ReviewedPageDraft {
  id: string;
  text: string;
  sceneSummary: string;
  visualMode: VisualMode;
  artStyle: RedrawStyle;
  existingMediaId?: string;
  mediaDirty?: boolean;
  originalDataUrl: string | null;
  mimeType: string | null;
  watercolorDataUrl: string | null;
  redrawnDataUrl: string | null;
  framedOverrideUrl?: string | null;
  redrawNote?: string;
  isRedrawing?: boolean;
  redrawError?: string | null;
  hotspots: CharacterHotspot[];
}

interface StoryScannerProps {
  defaultAgeGroup: AgeGroup;
  isSignedIn: boolean;
  editingStory?: Story | null;
  initialCreateMode?: CreateMode;
  onCancel: () => void;
  onSaveStory: (story: Story, isUpdate: boolean) => Promise<void>;
}

const REDRAW_STYLES: { id: RedrawStyle; label: string }[] = [
  { id: 'watercolor', label: 'Warm Watercolor' },
  { id: 'pastel', label: 'Soft Pastel' },
  { id: 'gouache', label: 'Woodland Gouache' },
];

const BACKDROP_CHOICES: { id: BackdropId; label: string }[] = [
  { id: 'forest', label: 'Meadow Forest' },
  { id: 'pond', label: 'Sunny Pond' },
  { id: 'twilight', label: 'Starlit Twilight' },
  { id: 'bridge', label: 'Mossy Bridge' },
];

function createStarterPageDraft(
  index: number,
  defaultStyle: RedrawStyle,
  text = ''
): ReviewedPageDraft {
  const newId = sanitizeId(`page_manual_${Date.now()}_${index + 1}_${Math.random().toString(36).slice(2, 5)}`);
  return {
    id: newId,
    text,
    sceneSummary: text
      ? `Warm children's storybook scene illustrating: ${text.slice(0, 180)}`
      : `Page ${index + 1} storybook illustration`,
    visualMode: 'photo',
    artStyle: defaultStyle,
    mediaDirty: true,
    originalDataUrl: null,
    mimeType: null,
    watercolorDataUrl: null,
    redrawnDataUrl: null,
    framedOverrideUrl: null,
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
  if (page.visualMode === 'redraw' && page.redrawnDataUrl) return page.redrawnDataUrl;
  if (page.visualMode === 'watercolor' && page.watercolorDataUrl) return page.watercolorDataUrl;
  if (page.originalDataUrl) return page.originalDataUrl;
  if (page.redrawnDataUrl) return page.redrawnDataUrl;
  if (page.watercolorDataUrl) return page.watercolorDataUrl;
  return BACKDROP_ART_MAP[fallbackBackdrop] || BACKDROP_ART_MAP.forest;
}

/**
 * Safely posts JSON to an API route, handling non-JSON HTML proxy responses
 * (such as 413 Payload Too Large, 502/504 gateway pages, or transient preview restarts)
 * with an automatic single retry and clear, human-readable errors.
 */
async function postApiJson<T extends Record<string, unknown>>(
  url: string,
  payload: unknown,
  fallbackError: string
): Promise<T> {
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const rawText = await response.text();
    const trimmed = rawText.trim();
    const looksLikeHtml =
      contentType.includes('text/html') ||
      trimmed.startsWith('<!') ||
      trimmed.toLowerCase().startsWith('<html');

    if (looksLikeHtml) {
      if (attempt < maxAttempts && (response.status >= 500 || response.status === 200)) {
        await new Promise((r) => window.setTimeout(r, 1100));
        continue;
      }
      if (response.status === 413) {
        throw new Error(
          'Your photos were too large to scan all at once. Try scanning 1–3 photos at a time.'
        );
      }
      if (response.status === 504 || response.status === 502 || response.status === 503) {
        throw new Error(
          'The storybook scan took too long or the server was briefly busy. Please try again with 1–3 photos.'
        );
      }
      throw new Error(
        'The server returned a webpage instead of scan results (your preview session may have refreshed). Please reload the page and try scanning again.'
      );
    }

    let parsed: T;
    try {
      parsed = (trimmed ? JSON.parse(trimmed) : {}) as T;
    } catch {
      if (attempt < maxAttempts && response.status >= 500) {
        await new Promise((r) => window.setTimeout(r, 900));
        continue;
      }
      throw new Error(`${fallbackError} (HTTP ${response.status}). Please try again.`);
    }

    if (!response.ok) {
      const serverMsg =
        typeof parsed.error === 'string' && parsed.error.trim() ? parsed.error : fallbackError;
      throw new Error(serverMsg);
    }

    return parsed;
  }

  throw new Error(fallbackError);
}

async function requestAiRedrawIllustration(params: {
  imageBase64?: string | null;
  mimeType?: string | null;
  sceneSummary?: string;
  pageText?: string;
  artStyle: RedrawStyle;
  pageNumber?: number;
  totalPages?: number;
}): Promise<{ dataUrl: string; styleNote: string }> {
  const payload: Record<string, unknown> = {
    sceneSummary: params.sceneSummary,
    pageText: params.pageText,
    artStyle: params.artStyle,
    pageNumber: params.pageNumber,
    totalPages: params.totalPages,
  };
  if (params.imageBase64 && params.mimeType && params.imageBase64.startsWith('data:image/')) {
    const compactRef = await compressDataUrlForApi(params.imageBase64, 768, 0.68);
    payload.imageBase64 = compactRef.dataUrl;
    payload.mimeType = compactRef.mimeType;
  }

  const data = await postApiJson<{ svg?: string; styleNote?: string; error?: string }>(
    '/api/stories/redraw',
    payload,
    'Could not generate storybook illustration.'
  );
  if (typeof data.svg !== 'string') {
    throw new Error(data.error || 'Could not generate storybook illustration.');
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
  editingStory = null,
  initialCreateMode = 'scan',
  onCancel,
  onSaveStory,
}: StoryScannerProps) {
  const isEditMode = Boolean(editingStory);
  const [createMode, setCreateMode] = useState<CreateMode>(initialCreateMode);

  const [step, setStep] = useState<'capture' | 'converting' | 'review'>(
    isEditMode || initialCreateMode === 'manual' ? 'review' : 'capture'
  );
  const [isHydratingEdit, setIsHydratingEdit] = useState(isEditMode);
  const [ageGroup, setAgeGroup] = useState<AgeGroup>(editingStory?.ageGroup || defaultAgeGroup);
  const [textMode, setTextMode] = useState<TextMode>('verbatim');
  const [autoSplitPages, setAutoSplitPages] = useState<boolean>(true);
  const [titleHint, setTitleHint] = useState('');
  const [defaultVisualMode, setDefaultVisualMode] = useState<VisualMode>('redraw');
  const [defaultRedrawStyle, setDefaultRedrawStyle] = useState<RedrawStyle>('watercolor');
  const [capturedPages, setCapturedPages] = useState<CapturedPageDraft[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [studioBanner, setStudioBanner] = useState<string | null>(null);
  const [conversionStatus, setConversionStatus] = useState(
    'Reading every printed word and preparing kid-friendly pages...'
  );

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
    editingStory?.coverFallbackId || 'forest'
  );
  const [coverPageIndex, setCoverPageIndex] = useState<number>(0);
  const [reviewedPages, setReviewedPages] = useState<ReviewedPageDraft[]>(() =>
    !isEditMode && initialCreateMode === 'manual' ? [createStarterPageDraft(0, 'watercolor')] : []
  );
  const [framingPageId, setFramingPageId] = useState<string | null>(null);
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [batchProgressText, setBatchProgressText] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Manual quick-paste & bulk local image uploader state
  const [showManualPasteBox, setShowManualPasteBox] = useState(
    !isEditMode && initialCreateMode === 'manual'
  );
  const [manualFullText, setManualFullText] = useState('');

  // Inline "Import Extra Photos" state (inside Review / Edit Studio)
  const [showExtraImporter, setShowExtraImporter] = useState(false);
  const [isImportingExtra, setIsImportingExtra] = useState(false);
  const [extraImportStatus, setExtraImportStatus] = useState<string | null>(null);
  const [extraAutoIllustrate, setExtraAutoIllustrate] = useState(true);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const extraPhotoInputRef = useRef<HTMLInputElement | null>(null);
  const bulkManualImagesInputRef = useRef<HTMLInputElement | null>(null);
  const replacePhotoInputRef = useRef<HTMLInputElement | null>(null);
  const replaceTargetPageIdRef = useRef<string | null>(null);

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
          const savedDataUrl = p.mediaId ? await getMediaDataUrl(p.mediaId) : null;
          const mode: VisualMode =
            p.visualMode === 'redraw'
              ? 'redraw'
              : p.visualMode === 'watercolor'
                ? 'watercolor'
                : 'photo';

          loaded.push({
            id: p.id || `page_${i + 1}`,
            text: p.text,
            sceneSummary: p.sceneSummary || `Page ${i + 1} illustration`,
            visualMode: mode,
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
    if (!video || capturedPages.length >= MAX_UPLOAD_BATCH) return;
    const canvas = document.createElement('canvas');
    const width = Math.min(video.videoWidth || 1400, 1400);
    const height = Math.round(((video.videoHeight || 1050) / (video.videoWidth || 1400)) * width);
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
    const watercolorUrl =
      defaultVisualMode === 'watercolor' ? await renderWatercolorStorybookStyle(dataUrl) : null;

    setCapturedPages((prev) => [
      ...prev,
      {
        id: `snap_${Date.now()}_${prev.length + 1}`,
        originalDataUrl: dataUrl,
        watercolorDataUrl: watercolorUrl,
        mimeType: 'image/jpeg',
        visualMode: defaultVisualMode,
      },
    ]);
    stopCameraStream();
  };

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setErrorMsg(null);
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const remainingSlots = Math.max(0, MAX_UPLOAD_BATCH - capturedPages.length);
    const batch = files.slice(0, remainingSlots);
    const newDrafts: CapturedPageDraft[] = [];

    for (let i = 0; i < batch.length; i++) {
      const file = batch[i];
      if (!file.type.startsWith('image/')) continue;
      try {
        const { dataUrl, mimeType } = await fileToCompressedDataUrl(file);
        const watercolorUrl =
          defaultVisualMode === 'watercolor'
            ? await renderWatercolorStorybookStyle(dataUrl)
            : null;
        newDrafts.push({
          id: `snap_${Date.now()}_${i}`,
          originalDataUrl: dataUrl,
          watercolorDataUrl: watercolorUrl,
          mimeType,
          visualMode: defaultVisualMode,
        });
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Could not read image file.');
      }
    }

    if (newDrafts.length > 0) {
      setCapturedPages((prev) => [...prev, ...newDrafts]);
    }
    e.target.value = '';
  };

  const toggleCapturedVisualMode = async (id: string, mode: VisualMode) => {
    const target = capturedPages.find((p) => p.id === id);
    if (!target) return;

    let watercolorUrl = target.watercolorDataUrl;
    if (mode === 'watercolor' && !watercolorUrl) {
      watercolorUrl = await renderWatercolorStorybookStyle(target.originalDataUrl);
    }

    setCapturedPages((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, visualMode: mode, watercolorDataUrl: watercolorUrl } : p
      )
    );
  };

  const removeCapturedPage = (id: string) => {
    setCapturedPages((prev) => prev.filter((p) => p.id !== id));
  };

  const handleRedrawSinglePage = async (
    pageId: string,
    styleOverride?: RedrawStyle,
    explicitPage?: ReviewedPageDraft,
    pageIdxHint?: number,
    totalCountHint?: number
  ) => {
    const idx =
      typeof pageIdxHint === 'number'
        ? pageIdxHint
        : reviewedPages.findIndex((p) => p.id === pageId);
    const target = explicitPage || reviewedPages[idx];
    if (!target || target.isRedrawing) return;

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
            }
          : p
      )
    );

    try {
      const result = await requestAiRedrawIllustration({
        imageBase64: target.originalDataUrl,
        mimeType: target.mimeType,
        sceneSummary: target.sceneSummary,
        pageText: target.text,
        artStyle: chosenStyle,
        pageNumber: idx >= 0 ? idx + 1 : 1,
        totalPages: totalCountHint ?? reviewedPages.length,
      });

      setReviewedPages((prev) =>
        prev.map((p) =>
          p.id === pageId
            ? {
                ...p,
                visualMode: 'redraw',
                redrawnDataUrl: result.dataUrl,
                framedOverrideUrl: null,
                mediaDirty: true,
                redrawNote: result.styleNote,
                isRedrawing: false,
                redrawError: null,
              }
            : p
        )
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not paint this page.';
      setReviewedPages((prev) =>
        prev.map((p) =>
          p.id === pageId
            ? {
                ...p,
                isRedrawing: false,
                redrawError: msg,
                visualMode: p.redrawnDataUrl
                  ? 'redraw'
                  : p.watercolorDataUrl
                    ? 'watercolor'
                    : 'photo',
              }
            : p
        )
      );
    }
  };

  const handleGenerateAllIllustrations = async () => {
    if (isBatchGenerating || reviewedPages.length === 0) return;
    setIsBatchGenerating(true);
    setErrorMsg(null);
    setStudioBanner(null);

    const snapshot = [...reviewedPages];
    let succeeded = 0;

    try {
      for (let i = 0; i < snapshot.length; i++) {
        const page = snapshot[i];
        setBatchProgressText(
          `Painting matching ${
            REDRAW_STYLES.find((s) => s.id === defaultRedrawStyle)?.label || 'Watercolor'
          } illustration for Page ${i + 1} of ${snapshot.length}...`
        );
        await handleRedrawSinglePage(page.id, defaultRedrawStyle, page, i, snapshot.length);
        succeeded++;
      }
      setStudioBanner(
        `Finished generating fresh matching illustrations across ${succeeded} ${
          succeeded === 1 ? 'page' : 'pages'
        }.`
      );
    } finally {
      setIsBatchGenerating(false);
      setBatchProgressText(null);
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
      const watercolorUrl = await renderWatercolorStorybookStyle(target.originalDataUrl);
      setReviewedPages((prev) =>
        prev.map((item) =>
          item.id === pageId
            ? {
                ...item,
                visualMode: 'watercolor',
                watercolorDataUrl: watercolorUrl,
                framedOverrideUrl: null,
                mediaDirty: true,
              }
            : item
        )
      );
      return;
    }

    setReviewedPages((prev) =>
      prev.map((item) =>
        item.id === pageId
          ? { ...item, visualMode: mode, framedOverrideUrl: null, mediaDirty: true }
          : item
      )
    );
  };

  const handleTriggerReplacePhoto = (pageId: string) => {
    replaceTargetPageIdRef.current = pageId;
    replacePhotoInputRef.current?.click();
  };

  const handleReplacePhotoFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const targetPageId = replaceTargetPageIdRef.current;
    e.target.value = '';
    if (!file || !targetPageId || !file.type.startsWith('image/')) return;

    try {
      const { dataUrl, mimeType } = await fileToCompressedDataUrl(file);
      const watercolorUrl = await renderWatercolorStorybookStyle(dataUrl);
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
    const pageB: ReviewedPageDraft = {
      id: newPageId,
      text: partB,
      sceneSummary: `Illustration showing: ${partB.slice(0, 180)}`,
      visualMode: source.originalDataUrl ? 'watercolor' : 'redraw',
      artStyle: source.artStyle,
      mediaDirty: true,
      originalDataUrl: source.originalDataUrl,
      mimeType: source.mimeType,
      watercolorDataUrl: source.watercolorDataUrl,
      redrawnDataUrl: null,
      framedOverrideUrl: null,
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
      `Split Page ${index + 1} into Pages ${index + 1} & ${index + 2}. Click "Paint AI Art" on Page ${
        index + 2
      } for its own fresh illustration!`
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
    const newPage: ReviewedPageDraft = {
      id: newId,
      text: '',
      sceneSummary: 'Cozy storybook scene matching the story text on this page',
      visualMode: 'redraw',
      artStyle: defaultRedrawStyle,
      mediaDirty: true,
      originalDataUrl: null,
      mimeType: null,
      watercolorDataUrl: null,
      redrawnDataUrl: null,
      framedOverrideUrl: null,
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
      `Added Page ${reviewedPages.length + 1}. Type your story text, then click "Upload Image" or "Paint AI Art".`
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
    setErrorMsg(null);
    const manualPages: ReviewedPageDraft[] = [];

    for (let i = 0; i < capturedPages.length; i++) {
      const cap = capturedPages[i];
      const watercolorUrl =
        cap.watercolorDataUrl || (await renderWatercolorStorybookStyle(cap.originalDataUrl));
      const base = createStarterPageDraft(i, defaultRedrawStyle, '');
      manualPages.push({
        ...base,
        visualMode: cap.visualMode === 'photo' ? 'photo' : 'watercolor',
        originalDataUrl: cap.originalDataUrl,
        mimeType: cap.mimeType,
        watercolorDataUrl: watercolorUrl,
        mediaDirty: true,
      });
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
    const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
    e.target.value = '';
    if (files.length === 0) return;

    setErrorMsg(null);
    const prepared: Array<{ dataUrl: string; mimeType: string; watercolorUrl: string }> = [];
    for (const file of files.slice(0, MAX_STORY_PAGES)) {
      try {
        const { dataUrl, mimeType } = await fileToCompressedDataUrl(file);
        const watercolorUrl = await renderWatercolorStorybookStyle(dataUrl);
        prepared.push({ dataUrl, mimeType, watercolorUrl });
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Could not load one of the selected images.');
      }
    }
    if (prepared.length === 0) return;

    let attachedCount = 0;
    setReviewedPages((prev) => {
      const copy = [...prev];
      let imgCursor = 0;

      // First attach to existing pages that do not have an uploaded photo yet
      for (let i = 0; i < copy.length && imgCursor < prepared.length; i++) {
        if (!copy[i].originalDataUrl && !copy[i].redrawnDataUrl) {
          const img = prepared[imgCursor++];
          copy[i] = {
            ...copy[i],
            originalDataUrl: img.dataUrl,
            mimeType: img.mimeType,
            watercolorDataUrl: img.watercolorUrl,
            framedOverrideUrl: null,
            visualMode: 'watercolor',
            mediaDirty: true,
          };
          attachedCount++;
        }
      }

      // Create additional pages for any remaining uploaded images (up to MAX_STORY_PAGES)
      while (imgCursor < prepared.length && copy.length < MAX_STORY_PAGES) {
        const img = prepared[imgCursor++];
        const base = createStarterPageDraft(copy.length, defaultRedrawStyle, '');
        copy.push({
          ...base,
          originalDataUrl: img.dataUrl,
          mimeType: img.mimeType,
          watercolorDataUrl: img.watercolorUrl,
          visualMode: 'watercolor',
          mediaDirty: true,
        });
        attachedCount++;
      }

      return copy;
    });

    if (attachedCount > 0) {
      setStudioBanner(
        `Added ${attachedCount} ${
          attachedCount === 1 ? 'image' : 'images'
        } directly to your pages with warm watercolor framing. You can switch to Original Photo or Resize & Crop anytime.`
      );
    } else {
      setStudioBanner(
        'All existing pages already have images (use "Replace Image" on a specific page to swap it).'
      );
    }
  };

  /**
   * Imports extra photos/screenshots directly into an existing open book in the Studio.
   */
  const handleImportExtraPhotos = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
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
    setExtraImportStatus(`Reading ${batchFiles.length} newly added photo(s)...`);

    try {
      const prepared: Array<{ dataUrl: string; mimeType: string; watercolorUrl: string }> = [];
      for (const file of batchFiles) {
        const { dataUrl, mimeType } = await fileToCompressedDataUrl(file);
        const watercolorUrl = await renderWatercolorStorybookStyle(dataUrl);
        prepared.push({ dataUrl, mimeType, watercolorUrl });
      }

      const compactPagesForApi = await Promise.all(
        prepared.map((p) => compressDataUrlForApi(p.dataUrl, 1080, 0.74))
      );

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

      const apiPages: Array<Record<string, unknown>> = Array.isArray(data.pages)
        ? data.pages.slice(0, remainingPageSlots)
        : [];
      const baseIndex = reviewedPages.length;
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

        let redrawnDataUrl: string | null = null;
        let redrawNote: string | undefined;
        let redrawError: string | null = null;
        let visualMode: VisualMode = extraAutoIllustrate ? 'redraw' : 'watercolor';

        if (extraAutoIllustrate) {
          setExtraImportStatus(
            `Painting matching illustration for imported page ${i + 1} of ${apiPages.length}...`
          );
          try {
            const painted = await requestAiRedrawIllustration({
              imageBase64: src.dataUrl,
              mimeType: src.mimeType,
              sceneSummary,
              pageText,
              artStyle: defaultRedrawStyle,
              pageNumber: baseIndex + i + 1,
              totalPages: baseIndex + apiPages.length,
            });
            redrawnDataUrl = painted.dataUrl;
            redrawNote = painted.styleNote;
          } catch (paintErr) {
            redrawError =
              paintErr instanceof Error ? paintErr.message : 'Illustration did not finish.';
            visualMode = 'watercolor';
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
          visualMode,
          artStyle: defaultRedrawStyle,
          mediaDirty: true,
          originalDataUrl: src.dataUrl,
          mimeType: src.mimeType,
          watercolorDataUrl: src.watercolorUrl,
          redrawnDataUrl,
          redrawNote,
          redrawError,
          hotspots,
        });
      }

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
    }
  };

  const handleConvertPages = async () => {
    if (capturedPages.length === 0) {
      setErrorMsg('Add at least one storybook page photo or screenshot first.');
      return;
    }

    setErrorMsg(null);
    setStudioBanner(null);
    setStep('converting');
    setConversionStatus(
      autoSplitPages
        ? 'Reading every printed word and splitting into short kid-friendly pages...'
        : textMode === 'verbatim'
          ? 'Reading every printed word from your storybook photos...'
          : 'Reading and adapting storybook text for your child...'
    );

    try {
      const compactPagesForApi = await Promise.all(
        capturedPages.map((p) => compressDataUrlForApi(p.originalDataUrl, 1080, 0.74))
      );

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
        'Could not convert storybook pages.'
      );

      const apiPages: Array<Record<string, unknown>> =
        Array.isArray(data.pages) && data.pages.length > 0
          ? data.pages.slice(0, MAX_STORY_PAGES)
          : capturedPages.map((_, idx) => ({
              sourcePhotoIndex: idx,
              text: 'Tap Play to listen to this storybook page.',
              sceneSummary: `Page ${idx + 1} illustration`,
              hotspots: [],
            }));

      // Cache watercolor retouch per source photo so split pages don't recompute canvas filters needlessly
      const watercolorBySource = new Map<number, string>();
      const builtReviewed: ReviewedPageDraft[] = [];

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

        let watercolorUrl = watercolorBySource.get(sourceIdx) || cap.watercolorDataUrl;
        if (!watercolorUrl) {
          watercolorUrl = await renderWatercolorStorybookStyle(cap.originalDataUrl);
          watercolorBySource.set(sourceIdx, watercolorUrl);
        }

        const shouldPaintAi = cap.visualMode === 'redraw' || defaultVisualMode === 'redraw';
        setConversionStatus(
          shouldPaintAi
            ? `Painting unique matching illustration for Page ${i + 1} of ${apiPages.length}...`
            : `Preparing Page ${i + 1} of ${apiPages.length} watercolor spread...`
        );

        let redrawnDataUrl: string | null = null;
        let redrawNote: string | undefined;
        let redrawError: string | null = null;
        let resolvedVisualMode: VisualMode = shouldPaintAi ? 'redraw' : cap.visualMode;

        if (shouldPaintAi) {
          try {
            const redrawn = await requestAiRedrawIllustration({
              imageBase64: cap.originalDataUrl,
              mimeType: cap.mimeType,
              sceneSummary,
              pageText,
              artStyle: defaultRedrawStyle,
              pageNumber: i + 1,
              totalPages: apiPages.length,
            });
            redrawnDataUrl = redrawn.dataUrl;
            redrawNote = redrawn.styleNote;
          } catch (redrawErr) {
            redrawError =
              redrawErr instanceof Error
                ? redrawErr.message
                : 'Illustration did not complete; showing Watercolor Retouch instead.';
            resolvedVisualMode = 'watercolor';
          }
        }

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
          artStyle: defaultRedrawStyle,
          mediaDirty: true,
          originalDataUrl: cap.originalDataUrl,
          mimeType: cap.mimeType,
          watercolorDataUrl: watercolorUrl,
          redrawnDataUrl,
          redrawNote,
          redrawError,
          hotspots,
        });
      }

      const backdropCandidate = String(data.suggestedBackdrop || 'forest');
      const safeBackdrop: BackdropId = (
        ['pond', 'forest', 'twilight', 'bridge'].includes(backdropCandidate)
          ? backdropCandidate
          : 'forest'
      ) as BackdropId;

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
      if (builtReviewed.length > capturedPages.length) {
        setStudioBanner(
          `Auto-split ${capturedPages.length} ${
            capturedPages.length === 1 ? 'photo' : 'photos'
          } into ${builtReviewed.length} short, kid-friendly pages with matching illustrations!`
        );
      }
      setStep('review');
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Something went wrong while scanning your storybook pages.'
      );
      setStep('capture');
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
        const chosenImage =
          p.framedOverrideUrl ||
          (p.visualMode === 'redraw' && p.redrawnDataUrl
            ? p.redrawnDataUrl
            : p.visualMode === 'watercolor' && p.watercolorDataUrl
              ? p.watercolorDataUrl
              : p.originalDataUrl || p.redrawnDataUrl || p.watercolorDataUrl);

        let mediaId = p.existingMediaId || '';
        if (chosenImage && (p.mediaDirty || !mediaId)) {
          mediaId = sanitizeId(`media_${storyId}_p${i + 1}_${saveNonce}`);
          await saveMediaDataUrl(mediaId, chosenImage);
        }

        pagesToSave.push({
          id: sanitizeId(p.id || `page_${i + 1}`),
          text: p.text.trim() || 'Enjoy this page together.',
          sceneSummary: p.sceneSummary.trim() || `Page ${i + 1} illustration`,
          mediaId: mediaId || undefined,
          visualMode: p.visualMode,
          fallbackArtId: draftBackdrop,
          hotspots: p.hotspots,
        });
      }

      const safeCoverIdx = Math.max(0, Math.min(pagesToSave.length - 1, coverPageIndex));
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
        coverMediaId: pagesToSave[safeCoverIdx]?.mediaId || pagesToSave[0]?.mediaId,
        coverFallbackId: draftBackdrop,
        readMinutes: estimatedMinutes,
        isCustom: true,
        pages: pagesToSave,
        createdAtMs: editingStory?.createdAtMs ?? Date.now(),
      };

      await onSaveStory(finalStory, isEditMode);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save storybook changes.');
    } finally {
      setIsSaving(false);
    }
  };

  const remainingPageSlots = Math.max(0, MAX_STORY_PAGES - reviewedPages.length);

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-10">
      <div className="flex items-center justify-between gap-4 mb-6">
        <button
          type="button"
          onClick={() => {
            stopCameraStream();
            onCancel();
          }}
          className="inline-flex items-center gap-2 text-sm font-semibold text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          {isEditMode ? 'Cancel Editing' : 'Back to Library'}
        </button>

        <div className="text-xs font-medium text-[#5C646B] dark:text-[#A4AEC2]">
          {isSignedIn ? 'Cloud Sync Active' : 'Saved on This Device (Sign in to sync)'}
        </div>
      </div>

      <div className="mb-6">
        <h1 className="font-display text-3xl sm:text-4xl font-semibold text-[#24292E] dark:text-[#EDE9DF] mb-2">
          {isEditMode
            ? `Edit Storybook · ${editingStory?.title}`
            : createMode === 'manual'
              ? 'Create a Storybook Manually'
              : 'Scan a Physical Book or Screenshot'}
        </h1>
        <p className="text-sm sm:text-base text-[#5C646B] dark:text-[#A4AEC2] max-w-2xl leading-relaxed">
          {isEditMode
            ? 'Polish story text, split long pages for easier reading, generate matching watercolor illustrations, resize or replace images, reorder pages, or import extra photos.'
            : createMode === 'manual'
              ? 'Write or paste your own story text, auto-split it into short kid-friendly pages, and upload your own photos or artwork directly — works 100% locally with zero scan required.'
              : 'Snap or upload book pages or story screenshots. Meadowtale reads every printed word verbatim, auto-splits dense text into short kid-friendly pages, and paints a unique watercolor illustration for each page.'}
        </p>

        {/* Creation Method Switcher (Scan vs Write Manually) */}
        {!isEditMode && step !== 'converting' && (
          <div
            role="tablist"
            aria-label="Choose how to add a storybook"
            className="mt-5 inline-flex items-center gap-1 p-1 rounded-xl bg-[#EFECE5] dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B]"
          >
            <button
              type="button"
              role="tab"
              aria-selected={createMode === 'scan'}
              onClick={() => handleSwitchCreateMode('scan')}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                createMode === 'scan'
                  ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF] shadow-xs'
                  : 'text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF]'
              }`}
            >
              <Camera className="w-4 h-4" />
              Scan Photos / Screenshots
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={createMode === 'manual'}
              onClick={() => handleSwitchCreateMode('manual')}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                createMode === 'manual'
                  ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF] shadow-xs'
                  : 'text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF]'
              }`}
            >
              <PenLine className="w-4 h-4" />
              Write Manually (Text &amp; Images)
            </button>
          </div>
        )}
      </div>

      {errorMsg && (
        <div className="mb-6 p-4 rounded-xl bg-[#C84B58]/10 border border-[#C84B58]/30 text-sm text-[#9C2F3B] dark:text-[#F299A3] flex flex-wrap items-center justify-between gap-3">
          <span className="flex-1 min-w-[220px]">{errorMsg}</span>
          <div className="flex items-center gap-2.5 shrink-0">
            {!isEditMode && step === 'capture' && capturedPages.length > 0 && (
              <button
                type="button"
                onClick={() => void handleContinueManuallyWithCapturedPhotos()}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-xs font-semibold transition-colors cursor-pointer"
              >
                <PenLine className="w-3.5 h-3.5" />
                Continue Manually with These Photos
              </button>
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
              onClick={() => void snapFromLiveCamera()}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] text-white dark:text-[#121624] text-sm font-semibold cursor-pointer"
            >
              <Camera className="w-4 h-4" />
              Capture Page
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
                  <Wand2 className="w-3.5 h-3.5" />
                  Multi-Page Artwork Style
                </label>
                <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-[#F2EFE8] dark:bg-[#121624] w-full">
                  <button
                    type="button"
                    onClick={() => setDefaultVisualMode('redraw')}
                    className={`flex-1 py-2 px-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                      defaultVisualMode === 'redraw'
                        ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF]'
                        : 'text-[#5C646B] dark:text-[#A4AEC2]'
                    }`}
                  >
                    AI Art Per Page
                  </button>
                  <button
                    type="button"
                    onClick={() => setDefaultVisualMode('watercolor')}
                    className={`flex-1 py-2 px-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                      defaultVisualMode === 'watercolor'
                        ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF]'
                        : 'text-[#5C646B] dark:text-[#A4AEC2]'
                    }`}
                  >
                    Watercolor
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
                  {defaultVisualMode === 'redraw'
                    ? 'Paints a unique, text-free free-tier watercolor scene matched to each split page.'
                    : defaultVisualMode === 'watercolor'
                      ? 'Brightens and softens your photos into painterly watercolor spreads.'
                      : 'Keeps your original uploaded photos (you can still crop or paint any page in Review).'}
                </p>
              </div>

              {/* Target Age Group + Illustration Palette + Title Hint */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
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
                  <label className="block text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-2">
                    AI Watercolor Palette
                  </label>
                  <select
                    value={defaultRedrawStyle}
                    onChange={(e) => setDefaultRedrawStyle(e.target.value as RedrawStyle)}
                    className="w-full px-3 py-2 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#D8D1C4] dark:border-[#34405E] text-xs font-semibold text-[#24292E] dark:text-[#EDE9DF] focus:outline-2 focus:outline-[#2F7A5E]"
                  >
                    {REDRAW_STYLES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <label
                    htmlFor="scan-title-hint"
                    className="block text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-1.5"
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
                disabled={capturedPages.length >= MAX_UPLOAD_BATCH}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 px-5 py-3 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] hover:bg-[#F3EFE8] dark:hover:bg-[#232B42] text-[#24292E] dark:text-[#EDE9DF] text-sm font-semibold transition-colors disabled:opacity-50 cursor-pointer"
              >
                <Upload className="w-4 h-4" />
                Upload Photos / Screenshots
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
                          className="w-full h-full object-cover"
                        />
                        {page.visualMode === 'redraw' && (
                          <div className="absolute bottom-2 left-2 right-2 px-2.5 py-1.5 rounded-lg bg-[#1A2033]/85 text-[#FAF8F4] text-[11px] font-medium flex items-center gap-1.5">
                            <Wand2 className="w-3.5 h-3.5 text-[#E5A94C] shrink-0" />
                            <span>
                              {autoSplitPages
                                ? 'Will split & paint fresh art per page'
                                : 'Will paint clean watercolor art'}
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
                            {page.visualMode === 'redraw'
                              ? 'AI Watercolor'
                              : page.visualMode === 'watercolor'
                                ? 'Watercolor Retouch'
                                : 'Original Photo'}
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-1">
                          <button
                            type="button"
                            onClick={() => void toggleCapturedVisualMode(page.id, 'redraw')}
                            className={`inline-flex items-center justify-center gap-1 py-1.5 px-1.5 rounded-lg text-[11px] font-semibold border transition-colors cursor-pointer ${
                              page.visualMode === 'redraw'
                                ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624] border-transparent'
                                : 'border-[#D8D1C4] dark:border-[#34405E] text-[#5C646B] dark:text-[#A4AEC2]'
                            }`}
                          >
                            <Wand2 className="w-3 h-3" />
                            AI Art
                          </button>
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
                            Retouch
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
                  onClick={() => void handleContinueManuallyWithCapturedPhotos()}
                  className="inline-flex items-center gap-2 px-4 py-3 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] hover:bg-[#F3EFE8] dark:hover:bg-[#232B42] text-[#24292E] dark:text-[#EDE9DF] text-xs sm:text-sm font-semibold transition-colors cursor-pointer"
                >
                  <PenLine className="w-4 h-4" />
                  Skip Scan &amp; Add Text Manually
                </button>
                <button
                  type="button"
                  onClick={() => void handleConvertPages()}
                  className="inline-flex items-center gap-2.5 px-6 py-3.5 rounded-xl bg-[#24292E] hover:bg-[#363D44] dark:bg-[#5CA49B] dark:hover:bg-[#4A8F86] text-white dark:text-[#121624] text-sm font-semibold transition-colors cursor-pointer"
                >
                  <Sparkles className="w-4 h-4" />
                  {autoSplitPages
                    ? `Scan, Auto-Split & Illustrate ${capturedPages.length} ${
                        capturedPages.length === 1 ? 'Photo' : 'Photos'
                      }`
                    : `Read & Convert ${capturedPages.length} ${
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
        <div className="bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] rounded-2xl p-12 text-center">
          <Loader2 className="w-10 h-10 text-[#2F7A5E] dark:text-[#E5A94C] animate-spin mx-auto mb-4" />
          <h2 className="font-display text-2xl font-semibold text-[#24292E] dark:text-[#EDE9DF] mb-2">
            {isHydratingEdit
              ? 'Opening your saved storybook...'
              : 'Creating your multi-page interactive storybook'}
          </h2>
          <p className="text-sm text-[#5C646B] dark:text-[#A4AEC2] max-w-md mx-auto">
            {isHydratingEdit ? 'Loading pages and high-resolution artwork...' : conversionStatus}
          </p>
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
                  Edit text, split long pages, generate fresh watercolor art per page, resize/crop images, reorder pages, or import extra photos.
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
                  {BACKDROP_CHOICES.map((b) => (
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
                      onClick={() => bulkManualImagesInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] bg-white dark:bg-[#1A2033] hover:border-[#2F7A5E] dark:hover:border-[#E5A94C] text-xs font-semibold text-[#24292E] dark:text-[#EDE9DF] cursor-pointer"
                    >
                      <Images className="w-3.5 h-3.5" />
                      Upload Page Images
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
                  Paint Matching Art for All {reviewedPages.length} Pages
                </button>
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
                  disabled={isBatchGenerating || isImportingExtra}
                  onClick={() => bulkManualImagesInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] bg-white dark:bg-[#1A2033] hover:border-[#2F7A5E] dark:hover:border-[#E5A94C] text-xs font-semibold text-[#24292E] dark:text-[#EDE9DF] disabled:opacity-45 cursor-pointer"
                >
                  <Images className="w-3.5 h-3.5" />
                  Upload Page Images
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

            {batchProgressText && (
              <div className="px-4 py-3 rounded-xl bg-[#2F7A5E]/10 dark:bg-[#E5A94C]/12 border border-[#2F7A5E]/25 dark:border-[#E5A94C]/25 text-xs font-medium text-[#1E5641] dark:text-[#F4D39B] flex items-center gap-2.5">
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                <span>{batchProgressText}</span>
              </div>
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
                        checked={extraAutoIllustrate}
                        onChange={(e) => setExtraAutoIllustrate(e.target.checked)}
                        className="w-4 h-4 accent-[#2F7A5E] dark:accent-[#E5A94C]"
                      />
                      Paint matching AI art automatically
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
                  <p className="text-xs font-medium text-[#2F7A5E] dark:text-[#E5A94C] flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {extraImportStatus}
                  </p>
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
                      </div>

                      {/* 3-Way Artwork Mode Switcher */}
                      <div className="grid grid-cols-3 gap-1.5">
                        <button
                          type="button"
                          disabled={page.isRedrawing}
                          onClick={() => void handleSelectReviewVisualMode(page.id, 'redraw')}
                          className={`inline-flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-xs font-semibold border cursor-pointer disabled:opacity-50 ${
                            page.visualMode === 'redraw'
                              ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624] border-transparent'
                              : 'border-[#D8D1C4] dark:border-[#34405E] text-[#5C646B] dark:text-[#A4AEC2]'
                          }`}
                        >
                          <Wand2 className="w-3.5 h-3.5" />
                          AI Art
                        </button>
                        <button
                          type="button"
                          disabled={page.isRedrawing || !hasSourcePhoto}
                          onClick={() => void handleSelectReviewVisualMode(page.id, 'watercolor')}
                          className={`inline-flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-xs font-semibold border cursor-pointer disabled:opacity-40 ${
                            page.visualMode === 'watercolor'
                              ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624] border-transparent'
                              : 'border-[#D8D1C4] dark:border-[#34405E] text-[#5C646B] dark:text-[#A4AEC2]'
                          }`}
                        >
                          <Paintbrush className="w-3.5 h-3.5" />
                          Watercolor
                        </button>
                        <button
                          type="button"
                          disabled={page.isRedrawing || !hasSourcePhoto}
                          onClick={() => void handleSelectReviewVisualMode(page.id, 'photo')}
                          className={`inline-flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-xs font-semibold border cursor-pointer disabled:opacity-40 ${
                            page.visualMode === 'photo'
                              ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624] border-transparent'
                              : 'border-[#D8D1C4] dark:border-[#34405E] text-[#5C646B] dark:text-[#A4AEC2]'
                          }`}
                        >
                          <ImageIcon className="w-3.5 h-3.5" />
                          Photo
                        </button>
                      </div>

                      {/* Style Picker + Paint / Redraw Button */}
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
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#24292E] hover:bg-[#363D44] dark:bg-[#27304A] dark:hover:bg-[#333F61] text-white text-xs font-semibold transition-colors disabled:opacity-50 cursor-pointer whitespace-nowrap"
                        >
                          <RefreshCw
                            className={`w-3.5 h-3.5 ${page.isRedrawing ? 'animate-spin' : ''}`}
                          />
                          {page.redrawnDataUrl ? 'Redraw Art' : 'Paint AI Art'}
                        </button>
                      </div>

                      {/* Resize & Crop + Replace Photo Row */}
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          type="button"
                          disabled={page.isRedrawing}
                          onClick={() => setFramingPageId(page.id)}
                          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] bg-white dark:bg-[#1A2033] hover:border-[#2F7A5E] dark:hover:border-[#E5A94C] text-xs font-semibold text-[#24292E] dark:text-[#EDE9DF] transition-colors disabled:opacity-50 cursor-pointer"
                        >
                          <Crop className="w-3.5 h-3.5 text-[#2F7A5E] dark:text-[#E5A94C]" />
                          {page.framedOverrideUrl ? 'Adjust Crop' : 'Resize & Crop'}
                        </button>

                        <button
                          type="button"
                          disabled={page.isRedrawing}
                          onClick={() => handleTriggerReplacePhoto(page.id)}
                          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] bg-white dark:bg-[#1A2033] hover:border-[#2F7A5E] dark:hover:border-[#E5A94C] text-xs font-semibold text-[#24292E] dark:text-[#EDE9DF] transition-colors disabled:opacity-50 cursor-pointer"
                        >
                          <Upload className="w-3.5 h-3.5" />
                          {hasSourcePhoto || page.redrawnDataUrl ? 'Replace Image' : 'Upload Image'}
                        </button>
                      </div>

                      {page.redrawError && (
                        <p className="text-[11px] text-[#9C2F3B] dark:text-[#F299A3]">
                          {page.redrawError}
                        </p>
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
                disabled={isSaving || isBatchGenerating || isImportingExtra}
                onClick={() => void handleSaveConvertedStory()}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-sm font-semibold transition-colors disabled:opacity-60 cursor-pointer"
              >
                {isEditMode ? <Check className="w-4 h-4" /> : <BookPlus className="w-4 h-4" />}
                {isSaving
                  ? isEditMode
                    ? 'Saving Changes...'
                    : 'Saving Storybook...'
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
