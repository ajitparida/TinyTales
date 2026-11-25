import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BookHeart,
  Check,
  Crop,
  Loader2,
  Mic,
  Moon,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Square,
  Star,
  Sun,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import {
  BedtimeSettings,
  CharacterHotspot,
  ReadingSpeed,
  Story,
  VoicePersonaId,
  VoicePreferences,
} from '../types/story';
import { BACKDROP_ART_MAP } from '../data/curatedStories';
import {
  clearAiTtsQuotaCooldown,
  fetchAiNarrationAudio,
  fetchCharacterVoiceAudio,
  isDeviceVoiceSupported,
  playCharacterSound,
  preloadAiNarrationAudio,
  speakCharacterWithDeviceVoice,
  speakWithDeviceVoice,
  stopDeviceVoice,
  TtsQuotaError,
  TtsUnavailableError,
  VOICE_PERSONAS,
} from '../lib/audioEngine';
import {
  clearParentVoicesForStory,
  deleteMediaKey,
  getMediaDataUrl,
  parentVoiceKey,
  resolveStoryMediaUrl,
  saveMediaDataUrl,
  saveStoryMedia,
} from '../lib/mediaStore';
import {
  CLEAR_MIC_CONSTRAINTS,
  createMicLevelMonitor,
  masterParentVoiceBlob,
} from '../lib/voiceStudio';
import { StoryConfetti } from './StoryConfetti';
import { PageImageFramingModal } from './PageImageFramingModal';
import { BottomSheet } from './BottomSheet';

type ReaderSheet = 'voices' | 'recorder' | 'menu' | null;

interface StoryReaderProps {
  story: Story;
  cloudSyncKey?: string;
  bedtimeSettings: BedtimeSettings;
  voicePreferences: VoicePreferences;
  onUpdateVoicePreferences: (next: VoicePreferences) => void;
  onToggleBedtime?: () => void;
  onEditStory?: (story: Story) => void;
  onExit: () => void;
  onStoryCompleted: (story: Story, durationSeconds: number) => void;
}

interface WordSpan {
  word: string;
  start: number;
  end: number;
  paragraphIndex: number;
}

function buildWordSpans(text: string): { spans: WordSpan[]; paragraphCount: number } {
  const safeText = typeof text === 'string' ? text : String(text ?? '');
  const paragraphs = safeText
    .trim()
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return { spans: [], paragraphCount: 0 };

  const rawItems: { word: string; paragraphIndex: number; weight: number }[] = [];
  paragraphs.forEach((para, pIdx) => {
    const words = para.split(/\s+/).filter(Boolean);
    words.forEach((word) => {
      rawItems.push({
        word,
        paragraphIndex: pIdx,
        weight: Math.max(2, word.replace(/[^a-zA-Z0-9]/g, '').length) + 1.5,
      });
    });
  });

  const totalWeight = rawItems.reduce((acc, item) => acc + item.weight, 0) || 1;
  let cursor = 0;
  const spans: WordSpan[] = rawItems.map((item) => {
    const start = cursor / totalWeight;
    cursor += item.weight;
    const end = cursor / totalWeight;
    return {
      word: item.word,
      start,
      end,
      paragraphIndex: item.paragraphIndex,
    };
  });

  return { spans, paragraphCount: paragraphs.length };
}

function HighlightedText({
  text,
  progress,
  isPlaying,
  className,
}: {
  text: string;
  progress: number;
  isPlaying: boolean;
  className?: string;
}) {
  const { spans, paragraphCount } = useMemo(() => buildWordSpans(text), [text]);
  const activeIndex = useMemo(() => {
    if (!isPlaying || progress <= 0) return -1;
    const idx = spans.findIndex((s) => progress >= s.start && progress <= s.end);
    if (idx !== -1) return idx;
    return progress >= 0.99 ? spans.length - 1 : 0;
  }, [spans, progress, isPlaying]);

  const groupedParagraphs = useMemo(() => {
    const groups: Array<Array<WordSpan & { globalIdx: number }>> = Array.from(
      { length: Math.max(1, paragraphCount) },
      () => []
    );
    spans.forEach((span, globalIdx) => {
      groups[span.paragraphIndex]?.push({ ...span, globalIdx });
    });
    return groups;
  }, [spans, paragraphCount]);

  return (
    <div className={className}>
      {groupedParagraphs.map((paraSpans, pIdx) => (
        <p key={pIdx} className={pIdx > 0 ? 'mt-3.5' : undefined}>
          {paraSpans.map((span) => {
            const isCurrent = isPlaying && span.globalIdx === activeIndex;
            const isSpoken = isPlaying && activeIndex > span.globalIdx;
            return (
              <span
                key={`${span.globalIdx}_${span.word}`}
                className={`inline-block mr-[0.28em] rounded-md px-0.5 transition-colors duration-150 ${
                  isCurrent
                    ? 'bg-[#2F7A5E]/18 dark:bg-[#E5A94C]/25 text-[#183F30] dark:text-[#FFF5DC]'
                    : isSpoken
                      ? 'text-[#24292E] dark:text-[#EDE9DF]'
                      : isPlaying
                        ? 'text-[#24292E]/60 dark:text-[#EDE9DF]/60'
                        : 'text-[#24292E] dark:text-[#EDE9DF]'
                }`}
              >
                {span.word}
              </span>
            );
          })}
        </p>
      ))}
    </div>
  );
}

const SPEED_OPTIONS: { value: ReadingSpeed; label: string }[] = [
  { value: 0.8, label: '0.8× Gentle' },
  { value: 1, label: '1.0× Normal' },
  { value: 1.15, label: '1.15× Lively' },
];

export function StoryReader({
  story,
  cloudSyncKey = '',
  bedtimeSettings,
  voicePreferences,
  onUpdateVoicePreferences,
  onToggleBedtime,
  onEditStory,
  onExit,
  onStoryCompleted,
}: StoryReaderProps) {
  const totalPages = story.pages.length;
  const [pageIndex, setPageIndex] = useState(0);
  const [pageDirection, setPageDirection] = useState<1 | -1>(1);
  const safePageIndex = Math.min(pageIndex, totalPages);
  const isMoralSpread = safePageIndex >= totalPages;
  const currentPage = !isMoralSpread ? story.pages[safePageIndex] : null;

  const [resolvedPageImage, setResolvedPageImage] = useState<string>('');
  const [showImageResizer, setShowImageResizer] = useState(false);
  const [activeHotspot, setActiveHotspot] = useState<CharacterHotspot | null>(null);
  const [tappedHotspotIds, setTappedHotspotIds] = useState<Set<string>>(new Set());
  const [characterVoiceLoading, setCharacterVoiceLoading] = useState(false);

  // Page audio playback & follow-along highlighting
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const characterAudioRef = useRef<HTMLAudioElement | null>(null);
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const progressRafRef = useRef<number | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [audioProgress, setAudioProgress] = useState(0);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [aiVoiceToast, setAiVoiceToast] = useState<{
    message: string;
    hotspot?: CharacterHotspot;
  } | null>(null);
  const [voiceSource, setVoiceSource] = useState<'ai' | 'parent'>('ai');
  const [hasParentRecording, setHasParentRecording] = useState(false);
  const [nextPagePreloaded, setNextPagePreloaded] = useState(false);
  const [activeSheet, setActiveSheet] = useState<ReaderSheet>(null);
  const stopDeviceSpeechRef = useRef<(() => void) | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  // Swipe-to-turn page touch gesture state
  const [swipeOffsetX, setSwipeOffsetX] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const touchGestureRef = useRef<{
    startX: number;
    startY: number;
    startTime: number;
    axis: 'undecided' | 'horizontal' | 'vertical';
    ignored: boolean;
  } | null>(null);

  const dismissAiVoiceToast = useCallback(() => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setAiVoiceToast(null);
  }, []);

  const showAiVoiceErrorToast = useCallback(
    (message: string, hotspot?: CharacterHotspot) => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
      setAiVoiceToast({ message, hotspot });
      toastTimerRef.current = window.setTimeout(() => {
        toastTimerRef.current = null;
        setAiVoiceToast(null);
      }, 7000);
    },
    []
  );

  // Parent Voice Studio state
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessingVoice, setIsProcessingVoice] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [rawCapturedBlob, setRawCapturedBlob] = useState<Blob | null>(null);
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [extraBoost, setExtraBoost] = useState(false);
  const [studioStatus, setStudioStatus] = useState<string | null>(null);
  const [isSavingVoiceClip, setIsSavingVoiceClip] = useState(false);
  const [clearingVoiceAction, setClearingVoiceAction] = useState<'page' | 'book' | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const stopMicMonitorRef = useRef<(() => void) | null>(null);

  // Reading completion & celebration tracking
  const startTimeRef = useRef<number>(Date.now());
  const loggedCompletionRef = useRef<boolean>(false);
  const [confettiBurstKey, setConfettiBurstKey] = useState(0);
  const pendingAutoStartRef = useRef<boolean>(false);

  const currentPageKeyId = isMoralSpread ? 'moral' : currentPage?.id || `p_${pageIndex}`;
  const currentNarrationText = isMoralSpread
    ? `The moral of ${story.title} is ${story.moralTitle}. ${story.moralLesson}`
    : currentPage?.text || '';

  const effectiveMode: 'daytime' | 'bedtime' = bedtimeSettings.bedtimeEnabled
    ? 'bedtime'
    : 'daytime';

  const voiceEngine = voicePreferences.voiceEngine === 'device' ? 'device' : 'ai';

  const activePersonaOption =
    VOICE_PERSONAS.find((v) => v.id === voicePreferences.voicePersona) || VOICE_PERSONAS[0];

  const stopProgressLoop = useCallback(() => {
    if (progressRafRef.current !== null) {
      window.cancelAnimationFrame(progressRafRef.current);
      progressRafRef.current = null;
    }
  }, []);

  const stopAutoAdvance = useCallback(() => {
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
  }, []);

  const stopCharacterAudio = useCallback(() => {
    if (characterAudioRef.current) {
      characterAudioRef.current.pause();
      characterAudioRef.current.currentTime = 0;
      characterAudioRef.current = null;
    }
    setCharacterVoiceLoading(false);
  }, []);

  const stopAudio = useCallback(
    (clearAutoFlag = false) => {
      stopAutoAdvance();
      stopProgressLoop();
      if (clearAutoFlag) {
        pendingAutoStartRef.current = false;
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        audioRef.current = null;
      }
      if (stopDeviceSpeechRef.current) {
        stopDeviceSpeechRef.current();
        stopDeviceSpeechRef.current = null;
      } else {
        stopDeviceVoice();
      }
      setIsPlaying(false);
      setAudioProgress(0);
    },
    [stopAutoAdvance, stopProgressLoop]
  );

  // Sync live playbackRate when user adjusts reading speed mid-sentence
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = voicePreferences.readingSpeed;
    }
  }, [voicePreferences.readingSpeed]);

  // Resolve current page illustration
  useEffect(() => {
    let active = true;
    setActiveHotspot(null);
    setAudioError(null);
    setPreviewDataUrl(null);
    setRawCapturedBlob(null);
    setStudioStatus(null);
    stopCharacterAudio();
    stopAudio(false);

    if (isMoralSpread) {
      const fallback =
        story.coverImageUrl || BACKDROP_ART_MAP[story.coverFallbackId] || BACKDROP_ART_MAP.forest;
      const coverKey = story.coverMediaId || story.pages[0]?.mediaId;
      if (coverKey) {
        void resolveStoryMediaUrl(coverKey, { preferPublished: story.isPublished }).then((url) => {
          if (active) setResolvedPageImage(url || fallback);
        });
      } else {
        setResolvedPageImage(fallback);
      }
      return () => {
        active = false;
      };
    }

    if (!currentPage) return;
    if (currentPage.imageUrl) {
      setResolvedPageImage(currentPage.imageUrl);
    } else if (currentPage.mediaId) {
      const fallback =
        BACKDROP_ART_MAP[currentPage.fallbackArtId || story.coverFallbackId] ||
        BACKDROP_ART_MAP.forest;
      void resolveStoryMediaUrl(currentPage.mediaId, { preferPublished: story.isPublished }).then(
        (url) => {
          if (active) setResolvedPageImage(url || fallback);
        }
      );
    } else {
      setResolvedPageImage(
        BACKDROP_ART_MAP[currentPage.fallbackArtId || story.coverFallbackId] ||
          BACKDROP_ART_MAP.forest
      );
    }

    return () => {
      active = false;
    };
  }, [pageIndex, isMoralSpread, currentPage, story, cloudSyncKey, stopAudio, stopCharacterAudio]);

  // Check if parent has recorded a voice clip for the current page
  useEffect(() => {
    let active = true;
    void getMediaDataUrl(parentVoiceKey(story.id, currentPageKeyId)).then((clip) => {
      if (!active) return;
      const exists = Boolean(clip);
      setHasParentRecording(exists);
      setVoiceSource(exists ? 'parent' : 'ai');
    });
    return () => {
      active = false;
    };
  }, [story.id, currentPageKeyId]);

  // Zero-Wait Background Preloader: preloads upcoming page only when AI engine is active
  useEffect(() => {
    let active = true;
    setNextPagePreloaded(false);

    if (isMoralSpread || voiceEngine === 'device') return;

    const nextIsMoral = pageIndex === totalPages - 1;
    const nextPage = nextIsMoral ? null : story.pages[pageIndex + 1];
    const nextPageId = nextIsMoral ? 'moral' : nextPage?.id;
    const nextText = nextIsMoral
      ? `The moral of ${story.title} is ${story.moralTitle}. ${story.moralLesson}`
      : nextPage?.text;

    if (!nextPageId || !nextText) return;

    const timer = window.setTimeout(() => {
      void preloadAiNarrationAudio({
        storyId: story.id,
        pageId: nextPageId,
        text: nextText,
        mode: effectiveMode,
        voicePersona: voicePreferences.voicePersona,
      }).then((ok) => {
        if (active && ok) setNextPagePreloaded(true);
      });
    }, 350);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [
    pageIndex,
    isMoralSpread,
    totalPages,
    story,
    effectiveMode,
    voiceEngine,
    voicePreferences.voicePersona,
  ]);

  // Trigger celebratory confetti & completion callback when entering the Moral Spread
  useEffect(() => {
    if (isMoralSpread) {
      setConfettiBurstKey((k) => k + 1);
      playCharacterSound('twinkle', bedtimeSettings.bedtimeEnabled);
      if (!loggedCompletionRef.current) {
        loggedCompletionRef.current = true;
        const elapsedSec = Math.max(15, Math.round((Date.now() - startTimeRef.current) / 1000));
        onStoryCompleted(story, elapsedSec);
      }
    }
  }, [isMoralSpread, story, onStoryCompleted, bedtimeSettings.bedtimeEnabled]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopAudio(true);
      stopCharacterAudio();
      stopMicMonitorRef.current?.();
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
      if (recordTimerRef.current) window.clearInterval(recordTimerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    };
  }, [stopAudio, stopCharacterAudio]);

  const startProgressTracking = useCallback(
    (audio: HTMLAudioElement) => {
      stopProgressLoop();
      const tick = () => {
        if (!audioRef.current || audioRef.current !== audio || audio.paused) return;
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          setAudioProgress(Math.min(1, audio.currentTime / audio.duration));
        }
        progressRafRef.current = window.requestAnimationFrame(tick);
      };
      progressRafRef.current = window.requestAnimationFrame(tick);
    },
    [stopProgressLoop]
  );

  const playDataUrlAudio = useCallback(
    (dataUrl: string, isPreview = false) => {
      stopCharacterAudio();
      stopAudio(false);

      const audio = new Audio(dataUrl);
      audio.playbackRate = isPreview ? 1 : voicePreferences.readingSpeed;
      audioRef.current = audio;

      audio.onended = () => {
        stopProgressLoop();
        setIsPlaying(false);
        setAudioProgress(0);
        if (!isPreview && voicePreferences.autoRead && !isMoralSpread) {
          pendingAutoStartRef.current = true;
          autoAdvanceTimerRef.current = window.setTimeout(() => {
            setPageDirection(1);
            setPageIndex((prev) => Math.min(totalPages, prev + 1));
          }, 1500);
        }
      };

      audio.onerror = () => {
        stopProgressLoop();
        setIsPlaying(false);
        setAudioProgress(0);
        setAudioError('Could not play audio clip on this browser.');
      };

      setIsPlaying(true);
      setAudioProgress(0.01);
      void audio
        .play()
        .then(() => {
          if (!isPreview) startProgressTracking(audio);
        })
        .catch((err) => {
          stopProgressLoop();
          setIsPlaying(false);
          setAudioProgress(0);
          setAudioError(err instanceof Error ? err.message : 'Tap again to start playback.');
        });
    },
    [
      isMoralSpread,
      startProgressTracking,
      stopAudio,
      stopCharacterAudio,
      stopProgressLoop,
      totalPages,
      voicePreferences.autoRead,
      voicePreferences.readingSpeed,
    ]
  );

  const playDeviceVoiceNarration = useCallback(() => {
    stopCharacterAudio();
    stopAudio(false);
    setAudioError(null);

    if (!isDeviceVoiceSupported()) {
      setAudioError('Built-in device voice is not available on this browser.');
      return;
    }

    setIsPlaying(true);
    setAudioProgress(0.01);
    stopDeviceSpeechRef.current = speakWithDeviceVoice({
      text: currentNarrationText,
      persona: voicePreferences.voicePersona,
      readingSpeed: voicePreferences.readingSpeed,
      isBedtime: bedtimeSettings.bedtimeEnabled,
      onProgress: (ratio) => setAudioProgress(ratio),
      onEnd: () => {
        stopDeviceSpeechRef.current = null;
        setIsPlaying(false);
        setAudioProgress(0);
        if (voicePreferences.autoRead && !isMoralSpread) {
          pendingAutoStartRef.current = true;
          autoAdvanceTimerRef.current = window.setTimeout(() => {
            setPageDirection(1);
            setPageIndex((prev) => Math.min(totalPages, prev + 1));
          }, 1500);
        }
      },
      onError: (msg) => {
        stopDeviceSpeechRef.current = null;
        setIsPlaying(false);
        setAudioProgress(0);
        setAudioError(msg);
      },
    });
  }, [
    bedtimeSettings.bedtimeEnabled,
    currentNarrationText,
    isMoralSpread,
    stopAudio,
    stopCharacterAudio,
    totalPages,
    voicePreferences.autoRead,
    voicePreferences.readingSpeed,
    voicePreferences.voicePersona,
  ]);

  const playCurrentPageNarration = useCallback(
    async (options?: { forceAi?: boolean }) => {
      setAudioError(null);
      const forceAi = Boolean(options?.forceAi);

      if (!forceAi && voiceSource === 'parent') {
        const savedClip = await getMediaDataUrl(parentVoiceKey(story.id, currentPageKeyId));
        if (savedClip) {
          playDataUrlAudio(savedClip);
          return;
        }
      }

      if (!forceAi && voiceEngine === 'device') {
        playDeviceVoiceNarration();
        return;
      }

      setIsLoadingAudio(true);
      try {
        const wavDataUrl = await fetchAiNarrationAudio({
          storyId: story.id,
          pageId: currentPageKeyId,
          text: currentNarrationText,
          mode: effectiveMode,
          voicePersona: voicePreferences.voicePersona,
        });
        setVoiceNotice(null);
        dismissAiVoiceToast();
        playDataUrlAudio(wavDataUrl);
      } catch (err) {
        const isQuota = err instanceof TtsQuotaError;
        const isUnavailable = err instanceof TtsUnavailableError;

        // Seamlessly fall back to built-in device voice on any AI voice failure so reading never breaks
        if (isDeviceVoiceSupported()) {
          const fallbackMessage = isQuota
            ? 'Daily AI voice limit reached. Playing with Built-in Device Voice instead.'
            : isUnavailable
              ? 'AI voice generation failed. Playing with Built-in Device Voice instead.'
              : 'AI voice hit a snag. Playing with Built-in Device Voice instead.';

          onUpdateVoicePreferences({
            ...voicePreferences,
            voiceEngine: 'device',
          });
          setVoiceNotice(fallbackMessage);
          showAiVoiceErrorToast(fallbackMessage);
          playDeviceVoiceNarration();
        } else {
          const errMessage = isQuota
            ? 'Daily AI voice limit reached on the free plan. Retry later or record a parent voiceover.'
            : 'AI voice generation failed on this browser. Tap Retry or record a parent voiceover.';
          setAudioError(errMessage);
          showAiVoiceErrorToast(errMessage);
        }
      } finally {
        setIsLoadingAudio(false);
      }
    },
    [
      currentNarrationText,
      currentPageKeyId,
      dismissAiVoiceToast,
      effectiveMode,
      onUpdateVoicePreferences,
      playDataUrlAudio,
      playDeviceVoiceNarration,
      showAiVoiceErrorToast,
      story.id,
      voiceEngine,
      voicePreferences,
      voiceSource,
    ]
  );

  // Hands-free Auto-Read continuation after automatic page turn
  useEffect(() => {
    if (!pendingAutoStartRef.current) return;
    if (!voicePreferences.autoRead) {
      pendingAutoStartRef.current = false;
      return;
    }
    pendingAutoStartRef.current = false;
    const t = window.setTimeout(() => {
      void playCurrentPageNarration();
    }, 320);
    return () => window.clearTimeout(t);
  }, [pageIndex, voicePreferences.autoRead, playCurrentPageNarration]);

  const handleToggleNarration = () => {
    if (isPlaying) {
      stopAudio(true);
      return;
    }
    void playCurrentPageNarration();
  };

  const handleSwitchToDeviceVoiceAndPlay = () => {
    stopAudio(true);
    setAudioError(null);
    dismissAiVoiceToast();
    setVoiceSource('ai');
    onUpdateVoicePreferences({
      ...voicePreferences,
      voiceEngine: 'device',
    });
    setVoiceNotice('Using Built-in Device Voice (unlimited & instant).');
    playDeviceVoiceNarration();
  };

  const handleSwitchBackToAiVoice = () => {
    stopAudio(true);
    clearAiTtsQuotaCooldown();
    setAudioError(null);
    setVoiceNotice(null);
    dismissAiVoiceToast();
    setVoiceSource('ai');
    onUpdateVoicePreferences({
      ...voicePreferences,
      voiceEngine: 'ai',
    });
  };

  const handleRetryAiVoice = useCallback(() => {
    if (isLoadingAudio) return;
    stopAudio(true);
    clearAiTtsQuotaCooldown();
    setAudioError(null);
    setVoiceNotice(null);
    dismissAiVoiceToast();
    setVoiceSource('ai');
    onUpdateVoicePreferences({
      ...voicePreferences,
      voiceEngine: 'ai',
    });
    void playCurrentPageNarration({ forceAi: true });
  }, [
    dismissAiVoiceToast,
    isLoadingAudio,
    onUpdateVoicePreferences,
    playCurrentPageNarration,
    stopAudio,
    voicePreferences,
  ]);

  const speakCharacterHotspot = async (
    hotspot: CharacterHotspot,
    options?: { forceAi?: boolean }
  ) => {
    stopAudio(true);
    stopCharacterAudio();
    const forceAi = Boolean(options?.forceAi);

    if (!forceAi && voiceEngine === 'device') {
      speakCharacterWithDeviceVoice({
        characterName: hotspot.name,
        dialogue: hotspot.dialogue,
        readingSpeed: voicePreferences.readingSpeed,
      });
      return;
    }

    setCharacterVoiceLoading(true);
    try {
      const wavUrl = await fetchCharacterVoiceAudio({
        storyId: story.id,
        hotspotId: hotspot.id,
        characterName: hotspot.name,
        dialogue: hotspot.dialogue,
      });
      dismissAiVoiceToast();
      const charAudio = new Audio(wavUrl);
      charAudio.playbackRate = voicePreferences.readingSpeed;
      characterAudioRef.current = charAudio;
      charAudio.onended = () => {
        if (characterAudioRef.current === charAudio) {
          characterAudioRef.current = null;
        }
      };
      await charAudio.play();
    } catch {
      showAiVoiceErrorToast(
        `AI character voice for ${hotspot.name} failed. Playing with Built-in Device Voice.`,
        hotspot
      );
      // Seamlessly speak the character line via built-in device voice if AI TTS fails
      speakCharacterWithDeviceVoice({
        characterName: hotspot.name,
        dialogue: hotspot.dialogue,
        readingSpeed: voicePreferences.readingSpeed,
      });
    } finally {
      setCharacterVoiceLoading(false);
    }
  };

  const handleTapHotspot = (hotspot: CharacterHotspot) => {
    setActiveHotspot(hotspot);
    setTappedHotspotIds((prev) => new Set(prev).add(hotspot.id));
    playCharacterSound(hotspot.soundCue, bedtimeSettings.bedtimeEnabled);
    void speakCharacterHotspot(hotspot);
  };

  // Studio-Clear Parent Voice Recording
  const startParentRecording = async () => {
    setAudioError(null);
    setStudioStatus(null);
    setPreviewDataUrl(null);
    setRawCapturedBlob(null);
    stopAudio(true);
    stopCharacterAudio();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: CLEAR_MIC_CONSTRAINTS,
      });
      stopMicMonitorRef.current?.();
      stopMicMonitorRef.current = createMicLevelMonitor(stream, setMicLevel);

      const recorder = new MediaRecorder(stream);
      recordedChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stopMicMonitorRef.current?.();
        stopMicMonitorRef.current = null;
        stream.getTracks().forEach((t) => t.stop());
        if (recordTimerRef.current) {
          window.clearInterval(recordTimerRef.current);
          recordTimerRef.current = null;
        }
        setIsRecording(false);

        const blob = new Blob(recordedChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        if (blob.size > 0) {
          setRawCapturedBlob(blob);
          setIsProcessingVoice(true);
          setStudioStatus('Reducing background noise & balancing volume...');
          try {
            const masteredUrl = await masterParentVoiceBlob(blob, { extraBoost });
            setPreviewDataUrl(masteredUrl);
            setStudioStatus('Voice cleaned and ready to preview.');
          } finally {
            setIsProcessingVoice(false);
          }
        }
      };

      mediaRecorderRef.current = recorder;
      setRecordingSeconds(0);
      setIsRecording(true);
      recorder.start();
      recordTimerRef.current = window.setInterval(() => {
        setRecordingSeconds((s) => s + 1);
      }, 1000);
    } catch {
      setAudioError('Microphone access is needed to record a parent voiceover.');
    }
  };

  const stopParentRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  const handleToggleExtraBoost = async () => {
    const nextBoost = !extraBoost;
    setExtraBoost(nextBoost);
    if (!rawCapturedBlob) return;
    setIsProcessingVoice(true);
    setStudioStatus(nextBoost ? 'Applying extra vocal clarity boost...' : 'Balancing standard level...');
    try {
      const masteredUrl = await masterParentVoiceBlob(rawCapturedBlob, { extraBoost: nextBoost });
      setPreviewDataUrl(masteredUrl);
      setStudioStatus(nextBoost ? 'Extra clarity boost ready to preview.' : 'Standard clean level ready.');
    } finally {
      setIsProcessingVoice(false);
    }
  };

  const handleSavePreviewClip = async () => {
    if (!previewDataUrl || isSavingVoiceClip) return;
    setIsSavingVoiceClip(true);
    try {
      await saveMediaDataUrl(parentVoiceKey(story.id, currentPageKeyId), previewDataUrl);
      setHasParentRecording(true);
      setVoiceSource('parent');
      setPreviewDataUrl(null);
      setRawCapturedBlob(null);
      setStudioStatus('Saved clear parent voice for this page.');
    } finally {
      setIsSavingVoiceClip(false);
    }
  };

  const clearParentRecording = async () => {
    if (clearingVoiceAction) return;
    setClearingVoiceAction('page');
    try {
      stopAudio(true);
      await deleteMediaKey(parentVoiceKey(story.id, currentPageKeyId));
      setHasParentRecording(false);
      setPreviewDataUrl(null);
      setRawCapturedBlob(null);
      setVoiceSource('ai');
      setStudioStatus('Cleared parent voice for this page.');
    } finally {
      setClearingVoiceAction(null);
    }
  };

  const clearAllClipsInThisBook = async () => {
    if (clearingVoiceAction) return;
    setClearingVoiceAction('book');
    try {
      stopAudio(true);
      const removed = await clearParentVoicesForStory(story.id);
      setHasParentRecording(false);
      setPreviewDataUrl(null);
      setRawCapturedBlob(null);
      setVoiceSource('ai');
      setStudioStatus(
        removed > 0
          ? `Cleared ${removed} parent ${removed === 1 ? 'recording' : 'recordings'} from this book.`
          : 'No saved parent recordings found in this book.'
      );
    } finally {
      setClearingVoiceAction(null);
    }
  };

  const reduced = bedtimeSettings.bedtimeEnabled && bedtimeSettings.reducedMotion;

  const goToPage = useCallback(
    (nextIndex: number) => {
      const clamped = Math.max(0, Math.min(totalPages, nextIndex));
      if (clamped === safePageIndex) return;
      pendingAutoStartRef.current = false;
      setPageDirection(clamped > safePageIndex ? 1 : -1);
      setPageIndex(clamped);
    },
    [safePageIndex, totalPages]
  );

  // Keyboard arrow navigation for desktop & iPad hardware keyboards
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (activeSheet || showImageResizer) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (e.key === 'ArrowRight') {
        goToPage(safePageIndex + 1);
      } else if (e.key === 'ArrowLeft') {
        goToPage(safePageIndex - 1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeSheet, showImageResizer, goToPage, safePageIndex]);

  // Native swipe-left / swipe-right page turn gesture handlers
  const handleStageTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 1 || activeSheet || showImageResizer) return;
    const target = e.target as HTMLElement | null;
    const isInteractiveIgnore = Boolean(target?.closest('[data-no-swipe="true"]'));
    const touch = e.touches[0];
    touchGestureRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      startTime: Date.now(),
      axis: 'undecided',
      ignored: isInteractiveIgnore,
    };
    setSwipeOffsetX(0);
    setIsSwiping(false);
  };

  const handleStageTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const gesture = touchGestureRef.current;
    if (!gesture || gesture.ignored || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - gesture.startX;
    const dy = touch.clientY - gesture.startY;

    if (gesture.axis === 'undecided') {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (Math.abs(dx) > Math.abs(dy) * 1.15) {
        gesture.axis = 'horizontal';
        setIsSwiping(true);
      } else {
        gesture.axis = 'vertical';
        return;
      }
    }

    if (gesture.axis !== 'horizontal') return;

    const atStartPullingRight = safePageIndex === 0 && dx > 0;
    const atEndPullingLeft = isMoralSpread && dx < 0;
    const resistance = atStartPullingRight || atEndPullingLeft ? 0.24 : 0.72;
    const clampedOffset = Math.max(-130, Math.min(130, dx * resistance));
    setSwipeOffsetX(clampedOffset);
  };

  const handleStageTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    const gesture = touchGestureRef.current;
    touchGestureRef.current = null;
    if (!gesture || gesture.ignored || gesture.axis !== 'horizontal') {
      setSwipeOffsetX(0);
      setIsSwiping(false);
      return;
    }

    const endTouch = e.changedTouches[0];
    const rawDx = endTouch ? endTouch.clientX - gesture.startX : 0;
    const elapsed = Math.max(1, Date.now() - gesture.startTime);
    const velocity = Math.abs(rawDx) / elapsed;

    setSwipeOffsetX(0);
    setIsSwiping(false);

    const passedThreshold = Math.abs(rawDx) >= 56 || (Math.abs(rawDx) >= 28 && velocity >= 0.35);
    if (!passedThreshold) return;

    if (rawDx < 0 && safePageIndex < totalPages) {
      goToPage(safePageIndex + 1);
    } else if (rawDx > 0 && safePageIndex > 0) {
      goToPage(safePageIndex - 1);
    }
  };

  const handleStageTouchCancel = () => {
    touchGestureRef.current = null;
    setSwipeOffsetX(0);
    setIsSwiping(false);
  };

  const pageTransitionVariants = {
    enter: (dir: number) =>
      reduced ? { opacity: 1, x: 0 } : { opacity: 0, x: dir > 0 ? 38 : -38 },
    center: { opacity: 1, x: 0 },
    exit: (dir: number) =>
      reduced ? { opacity: 0, x: 0 } : { opacity: 0, x: dir > 0 ? -38 : 38 },
  };

  const handleExitReader = () => {
    stopAudio(true);
    stopCharacterAudio();
    onExit();
  };

  return (
    <main className="min-h-[100dvh] flex flex-col max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-6 lg:pb-8">
      <StoryConfetti
        triggerKey={confettiBurstKey}
        isBedtime={bedtimeSettings.bedtimeEnabled}
        reducedMotion={reduced}
      />

      {/* Immersive Compact Sticky Reader Header (52px, safe-area top aware) */}
      <div className="sticky top-0 z-20 -mx-4 sm:-mx-6 lg:-mx-8 px-3 sm:px-6 lg:px-8 pt-safe bg-[#FAF8F4]/92 dark:bg-[#121624]/92 backdrop-blur-md border-b border-[#E6E1D8]/85 dark:border-[#2A324B]/85 mb-4 sm:mb-6">
        <div className="h-[52px] sm:h-14 flex items-center justify-between gap-2 sm:gap-4">
          {/* Left: Back to Library */}
          <button
            type="button"
            onClick={handleExitReader}
            aria-label="Back to Library"
            className="inline-flex items-center gap-1.5 min-h-[44px] min-w-[44px] px-2 sm:px-3 -ml-1 rounded-xl text-sm font-semibold text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] hover:bg-[#EFECE5]/80 dark:hover:bg-[#1E263D] transition-colors active:scale-95 cursor-pointer shrink-0"
          >
            <ArrowLeft className="w-5 h-5 sm:w-4 sm:h-4" />
            <span className="hidden sm:inline">Library</span>
          </button>

          {/* Center: Story Title + Tabular Page Counter */}
          <div className="min-w-0 flex-1 text-center">
            <div className="font-display text-sm sm:text-base font-semibold text-[#24292E] dark:text-[#EDE9DF] truncate">
              {story.title}
            </div>
            <div className="text-[11px] sm:text-xs font-medium text-[#5C646B] dark:text-[#A4AEC2] tabular-nums leading-tight">
              {isMoralSpread ? 'Story Moral' : `Page ${safePageIndex + 1} of ${totalPages}`}
            </div>
          </div>

          {/* Right: Bedtime Toggle + Voices Sheet + More Actions */}
          <div className="flex items-center gap-1 shrink-0">
            {onToggleBedtime && (
              <button
                type="button"
                onClick={onToggleBedtime}
                aria-label={
                  bedtimeSettings.bedtimeEnabled
                    ? 'Switch to Daytime Mode'
                    : 'Switch to Bedtime Mode'
                }
                aria-pressed={bedtimeSettings.bedtimeEnabled}
                className={`min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center transition-colors active:scale-95 cursor-pointer ${
                  bedtimeSettings.bedtimeEnabled
                    ? 'bg-[#E5A94C]/18 text-[#E5A94C]'
                    : 'text-[#5C646B] dark:text-[#A4AEC2] hover:bg-[#EFECE5] dark:hover:bg-[#1E263D] hover:text-[#24292E] dark:hover:text-[#EDE9DF]'
                }`}
              >
                {bedtimeSettings.bedtimeEnabled ? (
                  <Sun className="w-[19px] h-[19px]" />
                ) : (
                  <Moon className="w-[19px] h-[19px]" />
                )}
              </button>
            )}

            <button
              type="button"
              onClick={() => setActiveSheet('voices')}
              aria-label="Voices and reading speed"
              className="inline-flex items-center justify-center gap-1.5 min-w-[44px] min-h-[44px] sm:px-3 rounded-xl text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] hover:bg-[#EFECE5] dark:hover:bg-[#1E263D] transition-colors active:scale-95 cursor-pointer"
            >
              <SlidersHorizontal className="w-[18px] h-[18px]" />
              <span className="hidden md:inline">Voices</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSheet('menu')}
              aria-label="Story options"
              className="min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] hover:bg-[#EFECE5] dark:hover:bg-[#1E263D] transition-colors active:scale-95 cursor-pointer"
            >
              <MoreHorizontal className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Visual Progress Dots + Subtle Swipe Hint */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4 sm:mb-5">
        <div
          className="flex items-center gap-1 overflow-x-auto no-scrollbar max-w-full"
          aria-label="Reading progress"
        >
          {story.pages.map((p, idx) => (
            <button
              key={p.id}
              type="button"
              onClick={() => goToPage(idx)}
              aria-label={`Go to page ${idx + 1}`}
              className="min-h-[36px] px-1 flex items-center justify-center cursor-pointer"
            >
              <span
                className={`block h-2 rounded-full transition-all ${
                  idx === safePageIndex
                    ? 'w-7 bg-[#2F7A5E] dark:bg-[#E5A94C]'
                    : idx < safePageIndex
                      ? 'w-2.5 bg-[#2F7A5E]/45 dark:bg-[#E5A94C]/50'
                      : 'w-2.5 bg-[#D8D1C4] dark:bg-[#2A324B]'
                }`}
              />
            </button>
          ))}
          <button
            type="button"
            onClick={() => goToPage(totalPages)}
            aria-label="Go to end-of-story moral"
            className="min-h-[36px] px-1 flex items-center justify-center cursor-pointer"
          >
            <span
              className={`block h-2 rounded-full transition-all ${
                isMoralSpread
                  ? 'w-7 bg-[#D98A1C] dark:bg-[#E5A94C]'
                  : 'w-2.5 bg-[#D8D1C4] dark:bg-[#2A324B]'
              }`}
            />
          </button>
        </div>

        <div className="flex items-center gap-3 text-[11px] sm:text-xs text-[#5C646B] dark:text-[#A4AEC2]">
          <span className="lg:hidden">Swipe left or right to turn pages</span>
          {story.isCustom && onEditStory && (
            <button
              type="button"
              onClick={() => {
                stopAudio(true);
                stopCharacterAudio();
                onEditStory(story);
              }}
              className="hidden sm:inline-flex items-center gap-1 font-semibold text-[#2F7A5E] dark:text-[#E5A94C] hover:underline cursor-pointer"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit Book
            </button>
          )}
        </div>
      </div>

      {/* Swipeable Main Two-Zone Open-Book Reading Stage */}
      <div
        onTouchStart={handleStageTouchStart}
        onTouchMove={handleStageTouchMove}
        onTouchEnd={handleStageTouchEnd}
        onTouchCancel={handleStageTouchCancel}
        style={{
          transform: swipeOffsetX !== 0 ? `translate3d(${swipeOffsetX}px, 0, 0)` : undefined,
          transition: isSwiping ? 'none' : 'transform 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
        className="flex-1 will-change-transform"
      >
        <AnimatePresence mode="wait" custom={pageDirection} initial={false}>
          {!isMoralSpread && currentPage ? (
            <motion.div
              key={currentPage.id}
              custom={pageDirection}
              variants={pageTransitionVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={
                reduced
                  ? { duration: 0.08 }
                  : { duration: 0.24, ease: [0.16, 1, 0.3, 1] }
              }
              className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6 lg:gap-8 items-stretch"
            >
              {/* Left Zone (65% / 8 cols): Interactive Watercolor Illustration Canvas */}
              <div className="lg:col-span-8 flex flex-col">
                <div className="relative aspect-[4/3] w-full rounded-2xl overflow-hidden bg-[#EFEBE2] dark:bg-[#151A2B] border border-[#E6E1D8] dark:border-[#2A324B] shadow-xs">
                  {resolvedPageImage && (
                    <img
                      src={resolvedPageImage}
                      alt={currentPage.sceneSummary || story.title}
                      referrerPolicy="no-referrer"
                      draggable={false}
                      className="w-full h-full object-cover select-none"
                    />
                  )}

                  {/* Tappable Interactive Character Hotspots */}
                  {currentPage.hotspots.map((hotspot) => {
                    const isSelected = activeHotspot?.id === hotspot.id;
                    const wasTapped = tappedHotspotIds.has(hotspot.id);
                    const animateProps =
                      isSelected && !reduced
                        ? hotspot.reaction === 'bounce'
                          ? { y: [0, -10, 0] }
                          : hotspot.reaction === 'wiggle'
                            ? { rotate: [0, -12, 12, -6, 0] }
                            : { scale: [1, 1.22, 1] }
                        : {};

                    return (
                      <motion.button
                        key={hotspot.id}
                        type="button"
                        data-no-swipe="true"
                        onClick={() => handleTapHotspot(hotspot)}
                        animate={animateProps}
                        transition={{ duration: 0.45 }}
                        style={{
                          left: `${hotspot.x}%`,
                          top: `${hotspot.y}%`,
                        }}
                        aria-label={`Tap ${hotspot.name} to hear them speak`}
                        className="absolute -translate-x-1/2 -translate-y-1/2 w-12 h-12 sm:w-14 sm:h-14 rounded-full flex items-center justify-center cursor-pointer focus-visible:outline-2 focus-visible:outline-white group"
                      >
                        {!reduced && (
                          <span className="absolute inset-0 rounded-full border-2 border-[#FFF8E7] bg-[#D98A1C]/20 animate-ring-ripple" />
                        )}
                        <span
                          className={`relative z-10 w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center border-2 border-white shadow-md transition-transform group-hover:scale-110 ${
                            isSelected
                              ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624]'
                              : wasTapped
                                ? 'bg-[#D98A1C] text-white'
                                : 'bg-white/90 text-[#2F7A5E]'
                          }`}
                        >
                          <Sparkles className="w-4 h-4" />
                        </span>
                      </motion.button>
                    );
                  })}

                  {/* Spoken Character Speech Callout Overlay */}
                  <AnimatePresence>
                    {activeHotspot && (
                      <motion.div
                        key={activeHotspot.id}
                        data-no-swipe="true"
                        initial={{ opacity: 0, y: 12, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 8, scale: 0.96 }}
                        transition={{ duration: 0.2 }}
                        className="absolute bottom-3 left-3 right-3 sm:bottom-4 sm:left-6 sm:right-auto sm:max-w-md bg-white/95 dark:bg-[#1A2033]/95 backdrop-blur-md border border-[#E6E1D8] dark:border-[#34405E] rounded-2xl p-4 shadow-lg"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="flex items-center gap-2 text-xs font-semibold text-[#D98A1C] dark:text-[#E5A94C] mb-1">
                              <span>{activeHotspot.name} says</span>
                              {characterVoiceLoading && (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              )}
                            </div>
                            <p className="text-sm sm:text-base font-medium text-[#24292E] dark:text-[#EDE9DF] leading-snug">
                              “{activeHotspot.dialogue}”
                            </p>
                            <button
                              type="button"
                              disabled={characterVoiceLoading}
                              onClick={() => void speakCharacterHotspot(activeHotspot)}
                              className="mt-2 inline-flex items-center gap-1.5 min-h-[36px] text-xs font-semibold text-[#2F7A5E] dark:text-[#5CA49B] hover:underline disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                            >
                              {characterVoiceLoading ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Volume2 className="w-3.5 h-3.5" />
                              )}
                              {characterVoiceLoading ? 'Preparing voice...' : 'Hear again'}
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              stopCharacterAudio();
                              setActiveHotspot(null);
                            }}
                            className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg text-xs font-medium text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] cursor-pointer"
                          >
                            Close
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#5C646B] dark:text-[#A4AEC2] mt-2.5">
                  {currentPage.hotspots.length > 0 ? (
                    <span>
                      Tap glowing circles to hear {currentPage.hotspots.map((h) => h.name).join(' and ')} speak aloud.
                    </span>
                  ) : (
                    <span />
                  )}
                  <div className="flex items-center gap-3">
                    {story.isCustom && currentPage.mediaId && resolvedPageImage && (
                      <button
                        type="button"
                        onClick={() => setShowImageResizer(true)}
                        className="inline-flex items-center gap-1 font-semibold text-[#2F7A5E] dark:text-[#E5A94C] hover:underline cursor-pointer"
                      >
                        <Crop className="w-3.5 h-3.5" />
                        Resize Image
                      </button>
                    )}
                    {nextPagePreloaded && (
                      <span className="text-[#2F7A5E] dark:text-[#5CA49B]">
                        Next page voice preloaded
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Right Zone (35% / 4 cols): Follow-Along Prose, Tap-to-Play, & Sheet Triggers */}
              <div className="lg:col-span-4 flex flex-col justify-between bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] rounded-2xl p-5 sm:p-7 watercolor-paper-frame">
                <div>
                  <div className="flex items-center justify-between gap-2 text-xs font-medium text-[#5C646B] dark:text-[#A4AEC2] mb-3.5">
                    <span>Ages {story.ageGroup}</span>
                    <span>
                      {voiceSource === 'parent' && hasParentRecording
                        ? 'Parent Voice'
                        : voiceEngine === 'device'
                          ? `Device Voice · ${voicePreferences.readingSpeed}×`
                          : `${activePersonaOption.label} · ${voicePreferences.readingSpeed}×`}
                    </span>
                  </div>

                  {/* Follow-Along Highlighted Early-Reader Text */}
                  <div
                    className={`mb-5 ${
                      currentPage.text.length > 260
                        ? 'max-h-[260px] sm:max-h-[340px] overflow-y-auto overscroll-contain pr-2'
                        : ''
                    }`}
                  >
                    <HighlightedText
                      text={currentPage.text}
                      progress={audioProgress}
                      isPlaying={isPlaying}
                      className={`font-display ${
                        currentPage.text.length > 520
                          ? 'text-base sm:text-lg leading-[1.62]'
                          : currentPage.text.length > 240
                            ? 'text-lg sm:text-xl leading-[1.58]'
                            : 'text-[1.35rem] sm:text-[1.6rem] leading-[1.52]'
                      }`}
                    />
                  </div>

                  {/* Primary Toddler-Friendly Tap-to-Play Voice Button */}
                  <button
                    type="button"
                    data-no-swipe="true"
                    onClick={handleToggleNarration}
                    disabled={isLoadingAudio}
                    className="w-full min-h-[56px] px-6 py-3.5 rounded-2xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] font-semibold text-base flex items-center justify-center gap-3 transition-all active:scale-[0.98] disabled:opacity-65 cursor-pointer"
                  >
                    {isLoadingAudio ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Preparing Voice...
                      </>
                    ) : isPlaying ? (
                      <>
                        <Pause className="w-5 h-5" />
                        Pause Narration
                      </>
                    ) : (
                      <>
                        <Volume2 className="w-5 h-5" />
                        {voiceSource === 'parent' && hasParentRecording
                          ? 'Tap to Hear Parent Voice'
                          : 'Tap to Play Voice'}
                      </>
                    )}
                  </button>

                  {/* Auto-Read & Native Bottom Sheet Triggers */}
                  <div className="mt-3 grid grid-cols-2 gap-2" data-no-swipe="true">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={voicePreferences.autoRead}
                      onClick={() =>
                        onUpdateVoicePreferences({
                          ...voicePreferences,
                          autoRead: !voicePreferences.autoRead,
                        })
                      }
                      className={`inline-flex items-center justify-center gap-2 min-h-[44px] px-3 py-2 rounded-xl text-xs font-semibold border transition-colors active:scale-[0.98] whitespace-nowrap cursor-pointer ${
                        voicePreferences.autoRead
                          ? 'bg-[#2F7A5E]/12 dark:bg-[#E5A94C]/18 border-[#2F7A5E]/35 dark:border-[#E5A94C]/40 text-[#2F7A5E] dark:text-[#E5A94C]'
                          : 'border-[#E6E1D8] dark:border-[#2A324B] text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF]'
                      }`}
                    >
                      <span>Auto-Read: {voicePreferences.autoRead ? 'On' : 'Off'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setActiveSheet('voices')}
                      className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3 py-2 rounded-xl text-xs font-semibold border border-[#E6E1D8] dark:border-[#2A324B] text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] hover:bg-[#F3EFE8] dark:hover:bg-[#232B42] transition-colors active:scale-[0.98] whitespace-nowrap cursor-pointer"
                    >
                      <SlidersHorizontal className="w-3.5 h-3.5" />
                      Voices & Speed
                    </button>
                  </div>

                  {/* Quick Voice Source Switcher + Parent Studio Sheet Trigger */}
                  <div
                    className="mt-4 pt-4 border-t border-[#E6E1D8] dark:border-[#2A324B] space-y-2.5"
                    data-no-swipe="true"
                  >
                    <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-[#F2EFE8] dark:bg-[#121624]">
                      <button
                        type="button"
                        onClick={handleSwitchBackToAiVoice}
                        className={`min-h-[38px] px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                          voiceSource === 'ai' && voiceEngine === 'ai'
                            ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF] shadow-2xs'
                            : 'text-[#5C646B] dark:text-[#A4AEC2]'
                        }`}
                      >
                        AI Voice
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          stopAudio(true);
                          setAudioError(null);
                          setVoiceSource('ai');
                          onUpdateVoicePreferences({
                            ...voicePreferences,
                            voiceEngine: 'device',
                          });
                        }}
                        className={`min-h-[38px] px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                          voiceSource === 'ai' && voiceEngine === 'device'
                            ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF] shadow-2xs'
                            : 'text-[#5C646B] dark:text-[#A4AEC2]'
                        }`}
                      >
                        Device
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          stopAudio(true);
                          if (!hasParentRecording) {
                            setActiveSheet('recorder');
                          } else {
                            setVoiceSource('parent');
                          }
                        }}
                        className={`min-h-[38px] px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                          voiceSource === 'parent'
                            ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF] shadow-2xs'
                            : 'text-[#5C646B] dark:text-[#A4AEC2]'
                        }`}
                      >
                        Parent
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => setActiveSheet('recorder')}
                      className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E6E1D8] dark:border-[#2A324B] hover:bg-[#FAF8F4] dark:hover:bg-[#232B42] inline-flex items-center justify-center gap-2 text-xs font-semibold text-[#2F7A5E] dark:text-[#E5A94C] transition-colors active:scale-[0.98] whitespace-nowrap cursor-pointer"
                    >
                      <Mic className="w-4 h-4" />
                      {hasParentRecording ? 'Open Parent Voice Studio' : 'Record Parent Voice'}
                    </button>

                    {voiceNotice && !audioError && (
                      <div
                        role="status"
                        className="p-3.5 rounded-xl bg-[#D98A1C]/10 dark:bg-[#E5A94C]/12 border border-[#D98A1C]/35 dark:border-[#E5A94C]/35 text-xs text-[#6E450A] dark:text-[#F4D39B] space-y-2.5"
                      >
                        <div className="flex items-start gap-2">
                          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-[#D98A1C] dark:text-[#E5A94C]" />
                          <p className="leading-relaxed">{voiceNotice}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2.5 pl-6">
                          <button
                            type="button"
                            disabled={isLoadingAudio}
                            onClick={handleRetryAiVoice}
                            className="inline-flex items-center gap-1.5 min-h-[36px] px-3 py-1.5 rounded-lg bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                          >
                            {isLoadingAudio ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <RefreshCw className="w-3.5 h-3.5" />
                            )}
                            {isLoadingAudio ? 'Retrying...' : 'Retry AI Voice'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setVoiceNotice(null)}
                            className="min-h-[36px] px-2 py-1 font-medium opacity-80 hover:opacity-100 cursor-pointer"
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                    )}

                    {audioError && (
                      <div
                        role="alert"
                        className="p-3.5 rounded-xl bg-[#C84B58]/10 border border-[#C84B58]/35 text-xs text-[#9C2F3B] dark:text-[#F299A3] space-y-2.5"
                      >
                        <div className="flex items-start gap-2">
                          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-[#C84B58] dark:text-[#F299A3]" />
                          <p className="leading-relaxed">{audioError}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={isLoadingAudio}
                            onClick={handleRetryAiVoice}
                            className="inline-flex items-center justify-center gap-1.5 flex-1 min-h-[40px] py-2 px-3 rounded-lg border border-[#C84B58]/40 bg-white/80 dark:bg-[#1A2033] hover:bg-white dark:hover:bg-[#232B42] text-[#9C2F3B] dark:text-[#F299A3] text-xs font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
                          >
                            {isLoadingAudio ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <RefreshCw className="w-3.5 h-3.5" />
                            )}
                            {isLoadingAudio ? 'Retrying...' : 'Retry'}
                          </button>
                          <button
                            type="button"
                            onClick={handleSwitchToDeviceVoiceAndPlay}
                            className="flex-1 min-h-[40px] py-2 px-3 rounded-lg bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap"
                          >
                            Use Device Voice
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Page Navigation Buttons (Large Kid-Friendly Touch Targets) */}
                <div
                  className="mt-5 pt-4 border-t border-[#E6E1D8] dark:border-[#2A324B] flex items-center justify-between gap-3"
                  data-no-swipe="true"
                >
                  <button
                    type="button"
                    disabled={safePageIndex === 0}
                    onClick={() => goToPage(safePageIndex - 1)}
                    className="inline-flex items-center justify-center gap-2 min-h-[48px] px-4 py-2.5 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF] hover:bg-[#F3EFE8] dark:hover:bg-[#232B42] disabled:opacity-40 transition-all active:scale-[0.97] cursor-pointer"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => goToPage(safePageIndex + 1)}
                    className="flex-1 inline-flex items-center justify-center gap-2 min-h-[48px] px-5 py-2.5 rounded-xl bg-[#24292E] hover:bg-[#363D44] dark:bg-[#5CA49B] dark:hover:bg-[#4A8F86] text-white dark:text-[#121624] text-sm font-semibold transition-all active:scale-[0.98] cursor-pointer"
                  >
                    {safePageIndex === totalPages - 1 ? 'Read Story Moral' : 'Next Page'}
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </motion.div>
          ) : (
            /* Celebratory End-of-Story Moral Spread */
            <motion.section
              key="moral-spread"
              custom={pageDirection}
              variants={pageTransitionVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={
                reduced
                  ? { duration: 0.08 }
                  : { duration: 0.26, ease: [0.16, 1, 0.3, 1] }
              }
              className="max-w-4xl mx-auto bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] rounded-2xl overflow-hidden watercolor-paper-frame"
            >
              <div className="grid grid-cols-1 md:grid-cols-12 items-stretch">
                <div className="md:col-span-5 relative min-h-[240px] bg-[#EFEBE2] dark:bg-[#151A2B]">
                  {resolvedPageImage && (
                    <img
                      src={resolvedPageImage}
                      alt={story.title}
                      referrerPolicy="no-referrer"
                      draggable={false}
                      className="w-full h-full object-cover"
                    />
                  )}
                </div>

                <div className="md:col-span-7 p-6 sm:p-9 flex flex-col justify-between">
                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        setConfettiBurstKey((k) => k + 1);
                        playCharacterSound('twinkle', bedtimeSettings.bedtimeEnabled);
                      }}
                      className="inline-flex items-center gap-2 min-h-[36px] text-xs font-semibold text-[#D98A1C] dark:text-[#E5A94C] mb-2 hover:opacity-85 transition-opacity cursor-pointer"
                      title="Tap to celebrate again"
                    >
                      <Star className="w-4 h-4 fill-current" />
                      <span>Reading Star Earned</span>
                      <span aria-hidden="true">·</span>
                      <span>Moral of the Story</span>
                    </button>

                    <h2 className="font-display text-3xl sm:text-4xl font-semibold text-[#24292E] dark:text-[#EDE9DF] mb-4">
                      {story.moralTitle}
                    </h2>

                    <HighlightedText
                      text={`“${story.moralLesson}”`}
                      progress={audioProgress}
                      isPlaying={isPlaying}
                      className="font-display text-xl leading-relaxed mb-6"
                    />

                    {story.parentDiscussionPrompt && (
                      <div className="p-4 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B] mb-6">
                        <div className="flex items-center gap-2 text-xs font-semibold text-[#2F7A5E] dark:text-[#5CA49B] mb-1">
                          <BookHeart className="w-3.5 h-3.5" />
                          <span>Talk Together</span>
                        </div>
                        <p className="text-sm text-[#5C646B] dark:text-[#A4AEC2] leading-relaxed">
                          {story.parentDiscussionPrompt}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3" data-no-swipe="true">
                    <button
                      type="button"
                      onClick={handleToggleNarration}
                      disabled={isLoadingAudio}
                      className="inline-flex items-center justify-center gap-2 min-h-[48px] px-5 py-3 rounded-xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-sm font-semibold transition-all active:scale-[0.98] whitespace-nowrap disabled:opacity-65 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {isLoadingAudio ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : isPlaying ? (
                        <Pause className="w-4 h-4" />
                      ) : (
                        <Play className="w-4 h-4" />
                      )}
                      {isLoadingAudio
                        ? 'Preparing Voice...'
                        : isPlaying
                          ? 'Pause Moral'
                          : 'Listen to Moral'}
                    </button>

                    <button
                      type="button"
                      onClick={() => goToPage(0)}
                      className="inline-flex items-center justify-center gap-2 min-h-[48px] px-4 py-3 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF] hover:bg-[#F3EFE8] dark:hover:bg-[#232B42] transition-all active:scale-[0.98] whitespace-nowrap cursor-pointer"
                    >
                      <RotateCcw className="w-4 h-4" />
                      Read Again
                    </button>

                    <button
                      type="button"
                      onClick={handleExitReader}
                      className="inline-flex items-center justify-center gap-2 min-h-[48px] px-4 py-3 rounded-xl text-sm font-semibold text-[#2F7A5E] dark:text-[#5CA49B] hover:underline whitespace-nowrap cursor-pointer"
                    >
                      <Check className="w-4 h-4" />
                      Choose Another Book
                    </button>
                  </div>

                  {voiceNotice && !audioError && (
                    <div
                      role="status"
                      className="mt-4 p-3.5 rounded-xl bg-[#D98A1C]/10 dark:bg-[#E5A94C]/12 border border-[#D98A1C]/35 dark:border-[#E5A94C]/35 text-xs text-[#6E450A] dark:text-[#F4D39B] flex flex-wrap items-center justify-between gap-2.5"
                    >
                      <div className="flex items-start gap-2 min-w-0 flex-1">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-[#D98A1C] dark:text-[#E5A94C]" />
                        <span>{voiceNotice}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={isLoadingAudio}
                          onClick={handleRetryAiVoice}
                          className="inline-flex items-center gap-1.5 min-h-[36px] px-3 py-1.5 rounded-lg bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                        >
                          {isLoadingAudio ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" />
                          )}
                          {isLoadingAudio ? 'Retrying...' : 'Retry'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setVoiceNotice(null)}
                          className="min-h-[36px] px-2 font-semibold underline cursor-pointer"
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  )}

                  {audioError && (
                    <div
                      role="alert"
                      className="mt-4 p-3.5 rounded-xl bg-[#C84B58]/10 border border-[#C84B58]/35 text-xs text-[#9C2F3B] dark:text-[#F299A3] flex flex-wrap items-center justify-between gap-3"
                    >
                      <div className="flex items-start gap-2 min-w-0 flex-1">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-[#C84B58] dark:text-[#F299A3]" />
                        <span>{audioError}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={isLoadingAudio}
                          onClick={handleRetryAiVoice}
                          className="inline-flex items-center gap-1.5 min-h-[36px] px-3 py-1.5 rounded-lg border border-[#C84B58]/40 bg-white/80 dark:bg-[#1A2033] text-[#9C2F3B] dark:text-[#F299A3] font-semibold disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                        >
                          {isLoadingAudio ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" />
                          )}
                          {isLoadingAudio ? 'Retrying...' : 'Retry'}
                        </button>
                        <button
                          type="button"
                          onClick={handleSwitchToDeviceVoiceAndPlay}
                          className="min-h-[36px] px-3 py-1.5 rounded-lg bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624] font-semibold cursor-pointer"
                        >
                          Use Device Voice
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </motion.section>
          )}
        </AnimatePresence>
      </div>

      {/* Native Bottom Sheet: Voices & Reading Speed */}
      <BottomSheet
        open={activeSheet === 'voices'}
        onClose={() => setActiveSheet(null)}
        title="Voices & Reading Speed"
        subtitle="Customize storytelling voice, pace, and automatic page turning"
        reducedMotion={reduced}
      >
        <div>
          <div className="text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-2">
            Narration Engine
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={handleSwitchBackToAiVoice}
              className={`min-h-[46px] py-2.5 px-3 rounded-xl text-xs font-semibold transition-colors active:scale-[0.98] cursor-pointer ${
                voiceEngine === 'ai'
                  ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624]'
                  : 'bg-white dark:bg-[#121624] text-[#5C646B] dark:text-[#A4AEC2] border border-[#E6E1D8] dark:border-[#2A324B]'
              }`}
            >
              AI Storyteller
            </button>
            <button
              type="button"
              onClick={() => {
                stopAudio(true);
                setAudioError(null);
                setVoiceSource('ai');
                onUpdateVoicePreferences({
                  ...voicePreferences,
                  voiceEngine: 'device',
                });
              }}
              className={`min-h-[46px] py-2.5 px-3 rounded-xl text-xs font-semibold transition-colors active:scale-[0.98] cursor-pointer ${
                voiceEngine === 'device'
                  ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624]'
                  : 'bg-white dark:bg-[#121624] text-[#5C646B] dark:text-[#A4AEC2] border border-[#E6E1D8] dark:border-[#2A324B]'
              }`}
            >
              Device Voice (Free)
            </button>
          </div>
        </div>

        <div>
          <div className="text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-2">
            {voiceEngine === 'device' ? 'Voice Tone Style' : 'AI Storyteller Voice'}
          </div>
          <div className="space-y-1.5">
            {VOICE_PERSONAS.map((persona) => {
              const active = voicePreferences.voicePersona === persona.id;
              return (
                <button
                  key={persona.id}
                  type="button"
                  onClick={() => {
                    stopAudio(true);
                    setVoiceSource('ai');
                    onUpdateVoicePreferences({
                      ...voicePreferences,
                      voicePersona: persona.id as VoicePersonaId,
                    });
                  }}
                  className={`w-full min-h-[48px] text-left px-3.5 py-2.5 rounded-xl text-sm transition-colors cursor-pointer flex items-center justify-between gap-3 ${
                    active
                      ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF] font-semibold border border-[#2F7A5E]/40 dark:border-[#E5A94C]/45 shadow-2xs'
                      : 'bg-white/60 dark:bg-[#121624]/60 text-[#5C646B] dark:text-[#A4AEC2] border border-transparent hover:border-[#E6E1D8] dark:hover:border-[#2A324B]'
                  }`}
                >
                  <span className="truncate">{persona.label}</span>
                  <span className="text-xs opacity-75 truncate shrink-0">
                    {persona.description.split(',')[0]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-2">
            Reading Speed
          </div>
          <div className="grid grid-cols-3 gap-2">
            {SPEED_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() =>
                  onUpdateVoicePreferences({
                    ...voicePreferences,
                    readingSpeed: opt.value,
                  })
                }
                className={`min-h-[46px] py-2 px-2 rounded-xl text-xs font-semibold font-mono tabular-nums transition-colors active:scale-[0.98] cursor-pointer ${
                  voicePreferences.readingSpeed === opt.value
                    ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624]'
                    : 'bg-white dark:bg-[#121624] text-[#5C646B] dark:text-[#A4AEC2] border border-[#E6E1D8] dark:border-[#2A324B]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={voicePreferences.autoRead}
          onClick={() =>
            onUpdateVoicePreferences({
              ...voicePreferences,
              autoRead: !voicePreferences.autoRead,
            })
          }
          className="w-full min-h-[52px] px-4 py-3 rounded-xl bg-white dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B] flex items-center justify-between gap-3 cursor-pointer"
        >
          <div className="text-left">
            <div className="text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF]">
              Hands-Free Auto-Read
            </div>
            <div className="text-xs text-[#5C646B] dark:text-[#A4AEC2]">
              Automatically turns to the next page when narration finishes
            </div>
          </div>
          <span
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold shrink-0 ${
              voicePreferences.autoRead
                ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624]'
                : 'bg-[#EFECE5] dark:bg-[#232B42] text-[#5C646B] dark:text-[#A4AEC2]'
            }`}
          >
            {voicePreferences.autoRead ? 'On' : 'Off'}
          </span>
        </button>
      </BottomSheet>

      {/* Native Bottom Sheet: Parent Voice Studio */}
      <BottomSheet
        open={activeSheet === 'recorder'}
        onClose={() => {
          if (isRecording) stopParentRecording();
          setActiveSheet(null);
        }}
        title="Parent Voice Studio"
        subtitle={
          isMoralSpread
            ? `Recording for Story Moral`
            : `Recording for Page ${safePageIndex + 1} of ${totalPages}`
        }
        reducedMotion={reduced}
      >
        <p className="text-xs text-[#5C646B] dark:text-[#A4AEC2] leading-relaxed">
          Noise reduction & automatic vocal leveling keep your recording warm and crystal-clear for bedtime listening.
        </p>

        {/* Live Microphone Level Bar */}
        {isRecording && (
          <div className="p-4 rounded-2xl bg-white dark:bg-[#121624] border border-[#C84B58]/35">
            <div className="flex items-center justify-between text-xs font-mono tabular-nums text-[#C84B58] dark:text-[#E06D7A] mb-2">
              <span>Recording clearly...</span>
              <span>{recordingSeconds}s</span>
            </div>
            <div className="h-2.5 w-full rounded-full bg-[#E6E1D8] dark:bg-[#2A324B] overflow-hidden">
              <div
                style={{
                  transform: `scaleX(${Math.max(0.08, micLevel)})`,
                  transformOrigin: 'left center',
                }}
                className="h-full w-full bg-[#C84B58] dark:bg-[#E06D7A] transition-transform duration-75"
              />
            </div>
          </div>
        )}

        {isProcessingVoice && (
          <div className="p-4 rounded-2xl bg-white dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B] flex items-center gap-2.5 text-sm text-[#2F7A5E] dark:text-[#5CA49B]">
            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
            <span>{studioStatus || 'Cleaning audio...'}</span>
          </div>
        )}

        {/* Primary Record / Stop Buttons */}
        {!previewDataUrl && !isProcessingVoice && (
          <div>
            {!isRecording ? (
              <button
                type="button"
                onClick={() => void startParentRecording()}
                className="w-full min-h-[52px] inline-flex items-center justify-center gap-2 px-4 py-3 rounded-2xl bg-[#C84B58] hover:bg-[#B33D4A] text-white text-sm font-semibold transition-all active:scale-[0.98] cursor-pointer"
              >
                <Mic className="w-4 h-4" />
                {hasParentRecording ? 'Record New Take' : 'Start Recording'}
              </button>
            ) : (
              <button
                type="button"
                onClick={stopParentRecording}
                className="w-full min-h-[52px] inline-flex items-center justify-center gap-2 px-4 py-3 rounded-2xl bg-[#24292E] dark:bg-[#EDE9DF] text-white dark:text-[#121624] text-sm font-semibold transition-all active:scale-[0.98] cursor-pointer"
              >
                <Square className="w-4 h-4 fill-current" />
                Stop & Clean ({recordingSeconds}s)
              </button>
            )}
          </div>
        )}

        {/* Preview & Boost Before Saving */}
        {previewDataUrl && !isProcessingVoice && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => playDataUrlAudio(previewDataUrl, true)}
                className="min-h-[46px] inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] bg-white dark:bg-[#121624] text-xs font-semibold cursor-pointer"
              >
                <Play className="w-4 h-4" />
                Preview Take
              </button>
              <button
                type="button"
                onClick={() => void handleToggleExtraBoost()}
                className={`min-h-[46px] px-3 py-2 rounded-xl text-xs font-semibold border cursor-pointer ${
                  extraBoost
                    ? 'bg-[#2F7A5E]/15 dark:bg-[#E5A94C]/20 border-[#2F7A5E]/40 dark:border-[#E5A94C]/40 text-[#2F7A5E] dark:text-[#E5A94C]'
                    : 'bg-white dark:bg-[#121624] border-[#D8D1C4] dark:border-[#34405E] text-[#5C646B] dark:text-[#A4AEC2]'
                }`}
              >
                Clarity Boost: {extraBoost ? 'On' : 'Standard'}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                disabled={isSavingVoiceClip}
                onClick={() => void handleSavePreviewClip()}
                className="min-h-[48px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] text-white dark:text-[#121624] text-sm font-semibold disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
              >
                {isSavingVoiceClip ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
                {isSavingVoiceClip ? 'Saving...' : 'Save Clip'}
              </button>
              <button
                type="button"
                disabled={isSavingVoiceClip}
                onClick={() => {
                  setPreviewDataUrl(null);
                  setRawCapturedBlob(null);
                  setStudioStatus(null);
                }}
                className="min-h-[48px] px-4 py-2.5 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] text-sm font-medium text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] disabled:opacity-50 cursor-pointer"
              >
                Discard
              </button>
            </div>
          </div>
        )}

        {studioStatus && !isProcessingVoice && (
          <p className="text-xs font-medium text-[#2F7A5E] dark:text-[#5CA49B]">
            {studioStatus}
          </p>
        )}

        {/* Clear Saved Parent Voice Controls */}
        {!isRecording && (hasParentRecording || studioStatus) && (
          <div className="pt-3 border-t border-[#E6E1D8] dark:border-[#2A324B] flex flex-wrap items-center justify-between gap-2 text-xs">
            {hasParentRecording && (
              <button
                type="button"
                disabled={clearingVoiceAction !== null}
                onClick={() => void clearParentRecording()}
                className="inline-flex items-center gap-1.5 min-h-[40px] px-2 font-medium text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#C84B58] dark:hover:text-[#E06D7A] disabled:opacity-55 disabled:cursor-not-allowed cursor-pointer"
              >
                {clearingVoiceAction === 'page' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
                {clearingVoiceAction === 'page' ? 'Clearing...' : 'Clear This Page'}
              </button>
            )}
            <button
              type="button"
              disabled={clearingVoiceAction !== null}
              onClick={() => void clearAllClipsInThisBook()}
              className="inline-flex items-center gap-1.5 min-h-[40px] px-2 font-medium text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#C84B58] dark:hover:text-[#E06D7A] disabled:opacity-55 disabled:cursor-not-allowed cursor-pointer"
            >
              {clearingVoiceAction === 'book' && (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              )}
              {clearingVoiceAction === 'book' ? 'Clearing...' : 'Clear All Clips in Book'}
            </button>
          </div>
        )}
      </BottomSheet>

      {/* Native Bottom Sheet: Reader Quick Options Menu */}
      <BottomSheet
        open={activeSheet === 'menu'}
        onClose={() => setActiveSheet(null)}
        title={story.title}
        subtitle={`Ages ${story.ageGroup} · Moral: ${story.moralTitle}`}
        reducedMotion={reduced}
      >
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setActiveSheet('voices')}
            className="w-full min-h-[52px] px-4 py-3 rounded-2xl bg-white dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B] flex items-center gap-3 text-left text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF] active:scale-[0.99] cursor-pointer"
          >
            <SlidersHorizontal className="w-4 h-4 text-[#2F7A5E] dark:text-[#E5A94C] shrink-0" />
            <span>Voices & Reading Speed</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveSheet('recorder')}
            className="w-full min-h-[52px] px-4 py-3 rounded-2xl bg-white dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B] flex items-center gap-3 text-left text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF] active:scale-[0.99] cursor-pointer"
          >
            <Mic className="w-4 h-4 text-[#2F7A5E] dark:text-[#E5A94C] shrink-0" />
            <span>{hasParentRecording ? 'Parent Voice Studio' : 'Record Parent Voice'}</span>
          </button>

          {story.isCustom && currentPage?.mediaId && resolvedPageImage && (
            <button
              type="button"
              onClick={() => {
                setActiveSheet(null);
                setShowImageResizer(true);
              }}
              className="w-full min-h-[52px] px-4 py-3 rounded-2xl bg-white dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B] flex items-center gap-3 text-left text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF] active:scale-[0.99] cursor-pointer"
            >
              <Crop className="w-4 h-4 text-[#2F7A5E] dark:text-[#E5A94C] shrink-0" />
              <span>Crop / Resize Page Image</span>
            </button>
          )}

          {story.isCustom && onEditStory && (
            <button
              type="button"
              onClick={() => {
                setActiveSheet(null);
                stopAudio(true);
                stopCharacterAudio();
                onEditStory(story);
              }}
              className="w-full min-h-[52px] px-4 py-3 rounded-2xl bg-white dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B] flex items-center gap-3 text-left text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF] active:scale-[0.99] cursor-pointer"
            >
              <Pencil className="w-4 h-4 text-[#2F7A5E] dark:text-[#E5A94C] shrink-0" />
              <span>Edit Book in Studio</span>
            </button>
          )}

          {onToggleBedtime && (
            <button
              type="button"
              onClick={() => {
                onToggleBedtime();
                setActiveSheet(null);
              }}
              className="w-full min-h-[52px] px-4 py-3 rounded-2xl bg-white dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B] flex items-center gap-3 text-left text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF] active:scale-[0.99] cursor-pointer"
            >
              {bedtimeSettings.bedtimeEnabled ? (
                <Sun className="w-4 h-4 text-[#E5A94C] shrink-0" />
              ) : (
                <Moon className="w-4 h-4 text-[#2F7A5E] shrink-0" />
              )}
              <span>
                {bedtimeSettings.bedtimeEnabled ? 'Switch to Daytime Mode' : 'Switch to Bedtime Mode'}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setActiveSheet(null);
              goToPage(0);
            }}
            className="w-full min-h-[52px] px-4 py-3 rounded-2xl bg-white dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B] flex items-center gap-3 text-left text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF] active:scale-[0.99] cursor-pointer"
          >
            <RotateCcw className="w-4 h-4 text-[#5C646B] dark:text-[#A4AEC2] shrink-0" />
            <span>Restart Story from Page 1</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setActiveSheet(null);
              handleExitReader();
            }}
            className="w-full min-h-[52px] px-4 py-3 rounded-2xl bg-[#EFECE5] dark:bg-[#232B42] flex items-center gap-3 text-left text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF] active:scale-[0.99] cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4 shrink-0" />
            <span>Back to Library</span>
          </button>
        </div>
      </BottomSheet>

      {/* AI Voice Error Toast Notification with Quick Retry */}
      <AnimatePresence>
        {aiVoiceToast && (
          <motion.div
            role="alert"
            aria-live="polite"
            initial={reduced ? { opacity: 1 } : { opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.2 }}
            className="fixed bottom-safe-toast right-4 left-4 sm:left-auto sm:right-5 z-50 sm:max-w-sm rounded-2xl bg-white dark:bg-[#1A2033] border border-[#D98A1C]/45 dark:border-[#E5A94C]/45 shadow-xl p-4"
          >
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl bg-[#D98A1C]/12 dark:bg-[#E5A94C]/15 text-[#D98A1C] dark:text-[#E5A94C] flex items-center justify-center shrink-0">
                <AlertCircle className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-[#24292E] dark:text-[#EDE9DF]">
                  AI Voice Notice
                </div>
                <p className="text-xs text-[#5C646B] dark:text-[#A4AEC2] mt-0.5 leading-relaxed">
                  {aiVoiceToast.message}
                </p>
                <div className="mt-2.5 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isLoadingAudio || characterVoiceLoading}
                    onClick={() => {
                      const targetHotspot = aiVoiceToast.hotspot;
                      if (targetHotspot) {
                        clearAiTtsQuotaCooldown();
                        dismissAiVoiceToast();
                        void speakCharacterHotspot(targetHotspot, { forceAi: true });
                      } else {
                        handleRetryAiVoice();
                      }
                    }}
                    className="inline-flex items-center gap-1.5 min-h-[36px] px-3 py-1.5 rounded-lg bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-xs font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {isLoadingAudio || characterVoiceLoading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                    {isLoadingAudio || characterVoiceLoading ? 'Retrying...' : 'Retry'}
                  </button>
                  <button
                    type="button"
                    onClick={dismissAiVoiceToast}
                    className="min-h-[36px] px-2 py-1 text-xs font-medium text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] cursor-pointer"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
              <button
                type="button"
                onClick={dismissAiVoiceToast}
                aria-label="Close voice notification"
                className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {showImageResizer && currentPage?.mediaId && resolvedPageImage && (
        <PageImageFramingModal
          sourceImageUrl={resolvedPageImage}
          pageLabel={`Page ${safePageIndex + 1}`}
          onCancel={() => setShowImageResizer(false)}
          onApply={(framedUrl) => {
            void saveStoryMedia(story.id, currentPage.mediaId!, framedUrl).then(() => {
              setResolvedPageImage(framedUrl);
              setShowImageResizer(false);
            });
          }}
        />
      )}
    </main>
  );
}
