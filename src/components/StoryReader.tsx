import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowLeft,
  ArrowRight,
  BookHeart,
  Check,
  Crop,
  Loader2,
  Mic,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Square,
  Star,
  Trash2,
  Volume2,
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
  VOICE_PERSONAS,
} from '../lib/audioEngine';
import {
  clearParentVoicesForStory,
  deleteMediaKey,
  getMediaDataUrl,
  parentVoiceKey,
  saveMediaDataUrl,
} from '../lib/mediaStore';
import {
  CLEAR_MIC_CONSTRAINTS,
  createMicLevelMonitor,
  masterParentVoiceBlob,
} from '../lib/voiceStudio';
import { StoryConfetti } from './StoryConfetti';
import { PageImageFramingModal } from './PageImageFramingModal';

interface StoryReaderProps {
  story: Story;
  bedtimeSettings: BedtimeSettings;
  voicePreferences: VoicePreferences;
  onUpdateVoicePreferences: (next: VoicePreferences) => void;
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
  const paragraphs = text
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
  bedtimeSettings,
  voicePreferences,
  onUpdateVoicePreferences,
  onEditStory,
  onExit,
  onStoryCompleted,
}: StoryReaderProps) {
  const totalPages = story.pages.length;
  const [pageIndex, setPageIndex] = useState(0);
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
  const [voiceSource, setVoiceSource] = useState<'ai' | 'parent'>('ai');
  const [hasParentRecording, setHasParentRecording] = useState(false);
  const [nextPagePreloaded, setNextPagePreloaded] = useState(false);
  const [showVoiceSettings, setShowVoiceSettings] = useState(false);
  const stopDeviceSpeechRef = useRef<(() => void) | null>(null);

  // Parent Voice Studio state
  const [showRecorder, setShowRecorder] = useState(false);
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
      if (story.coverMediaId) {
        void getMediaDataUrl(story.coverMediaId).then((url) => {
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
      void getMediaDataUrl(currentPage.mediaId).then((url) => {
        if (active) setResolvedPageImage(url || fallback);
      });
    } else {
      setResolvedPageImage(
        BACKDROP_ART_MAP[currentPage.fallbackArtId || story.coverFallbackId] ||
          BACKDROP_ART_MAP.forest
      );
    }

    return () => {
      active = false;
    };
  }, [pageIndex, isMoralSpread, currentPage, story, stopAudio, stopCharacterAudio]);

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

  const playCurrentPageNarration = useCallback(async () => {
    setAudioError(null);

    if (voiceSource === 'parent') {
      const savedClip = await getMediaDataUrl(parentVoiceKey(story.id, currentPageKeyId));
      if (savedClip) {
        playDataUrlAudio(savedClip);
        return;
      }
    }

    if (voiceEngine === 'device') {
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
      playDataUrlAudio(wavDataUrl);
    } catch (err) {
      if (err instanceof TtsQuotaError) {
        // Seamlessly switch to built-in device voice and keep reading without interruption
        onUpdateVoicePreferences({
          ...voicePreferences,
          voiceEngine: 'device',
        });
        setVoiceNotice(
          'Daily AI voice limit reached on the free plan. Switched automatically to Built-in Device Voice for unlimited reading.'
        );
        if (isDeviceVoiceSupported()) {
          playDeviceVoiceNarration();
        } else {
          setAudioError(err.message);
        }
      } else {
        setAudioError(
          err instanceof Error
            ? err.message
            : 'AI voice narration is temporarily unavailable. You can switch to built-in device voice instead.'
        );
      }
    } finally {
      setIsLoadingAudio(false);
    }
  }, [
    currentNarrationText,
    currentPageKeyId,
    effectiveMode,
    onUpdateVoicePreferences,
    playDataUrlAudio,
    playDeviceVoiceNarration,
    story.id,
    voiceEngine,
    voicePreferences,
    voiceSource,
  ]);

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
    setVoiceSource('ai');
    onUpdateVoicePreferences({
      ...voicePreferences,
      voiceEngine: 'ai',
    });
  };

  const speakCharacterHotspot = async (hotspot: CharacterHotspot) => {
    stopAudio(true);
    stopCharacterAudio();

    if (voiceEngine === 'device') {
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
      // Seamlessly speak the character line via built-in device voice if AI TTS quota is reached
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

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
      <StoryConfetti
        triggerKey={confettiBurstKey}
        isBedtime={bedtimeSettings.bedtimeEnabled}
        reducedMotion={reduced}
      />

      {/* Top Story Context Strip */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <button
          type="button"
          onClick={() => {
            stopAudio(true);
            stopCharacterAudio();
            onExit();
          }}
          className="inline-flex items-center gap-2 text-sm font-semibold text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Library
        </button>

        <div className="flex flex-wrap items-center gap-2.5 text-xs sm:text-sm font-medium text-[#5C646B] dark:text-[#A4AEC2]">
          <span className="font-display font-semibold text-[#24292E] dark:text-[#EDE9DF]">
            {story.title}
          </span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">
            {isMoralSpread ? 'Story Moral' : `Page ${safePageIndex + 1} of ${totalPages}`}
          </span>
          {story.isCustom && onEditStory && (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => {
                  stopAudio(true);
                  stopCharacterAudio();
                  onEditStory(story);
                }}
                className="inline-flex items-center gap-1 text-xs font-semibold text-[#2F7A5E] dark:text-[#E5A94C] hover:underline cursor-pointer"
              >
                <Pencil className="w-3.5 h-3.5" />
                Edit Book
              </button>
            </>
          )}
        </div>

        {/* Visual Progress Dots */}
        <div className="flex items-center gap-1.5" aria-label="Reading progress">
          {story.pages.map((p, idx) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                pendingAutoStartRef.current = false;
                setPageIndex(idx);
              }}
              aria-label={`Go to page ${idx + 1}`}
              className={`h-2 rounded-full transition-all cursor-pointer ${
                idx === pageIndex
                  ? 'w-7 bg-[#2F7A5E] dark:bg-[#E5A94C]'
                  : idx < pageIndex
                    ? 'w-2.5 bg-[#2F7A5E]/45 dark:bg-[#E5A94C]/50'
                    : 'w-2.5 bg-[#D8D1C4] dark:bg-[#2A324B]'
              }`}
            />
          ))}
          <button
            type="button"
            onClick={() => {
              pendingAutoStartRef.current = false;
              setPageIndex(totalPages);
            }}
            aria-label="Go to end-of-story moral"
            className={`h-2 rounded-full transition-all cursor-pointer ${
              isMoralSpread
                ? 'w-7 bg-[#D98A1C] dark:bg-[#E5A94C]'
                : 'w-2.5 bg-[#D8D1C4] dark:bg-[#2A324B]'
            }`}
          />
        </div>
      </div>

      {/* Main Two-Zone Open-Book Reading Stage */}
      <AnimatePresence mode="wait">
        {!isMoralSpread && currentPage ? (
          <motion.div
            key={currentPage.id}
            initial={reduced ? { opacity: 1 } : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 1 } : { opacity: 0, y: -8 }}
            transition={{ duration: 0.25 }}
            className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-stretch"
          >
            {/* Left Zone (65% / 8 cols): Interactive Watercolor Illustration Canvas */}
            <div className="lg:col-span-8 flex flex-col">
              <div className="relative aspect-[4/3] w-full rounded-2xl overflow-hidden bg-[#EFEBE2] dark:bg-[#151A2B] border border-[#E6E1D8] dark:border-[#2A324B]">
                {resolvedPageImage && (
                  <img
                    src={resolvedPageImage}
                    alt={currentPage.sceneSummary || story.title}
                    referrerPolicy="no-referrer"
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
                      initial={{ opacity: 0, y: 12, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.96 }}
                      transition={{ duration: 0.2 }}
                      className="absolute bottom-4 left-4 right-4 sm:left-6 sm:right-auto sm:max-w-md bg-white/95 dark:bg-[#1A2033]/95 backdrop-blur-md border border-[#E6E1D8] dark:border-[#34405E] rounded-2xl p-4 shadow-lg"
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
                            className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-[#2F7A5E] dark:text-[#5CA49B] hover:underline disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
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
                          className="text-xs font-medium text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] px-2 py-1 cursor-pointer"
                        >
                          Close
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#5C646B] dark:text-[#A4AEC2] mt-2.5">
                <span>
                  Tap glowing circles to hear {currentPage.hotspots.map((h) => h.name).join(' and ')} speak aloud.
                </span>
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

            {/* Right Zone (35% / 4 cols): Follow-Along Prose, Voice Persona, Auto-Read & Parent Voice Studio */}
            <div className="lg:col-span-4 flex flex-col justify-between bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] rounded-2xl p-6 sm:p-7 watercolor-paper-frame">
              <div>
                <div className="flex items-center justify-between gap-2 text-xs font-medium text-[#5C646B] dark:text-[#A4AEC2] mb-4">
                  <span>Ages {story.ageGroup}</span>
                  <span>
                    {voiceSource === 'parent' && hasParentRecording
                      ? 'Parent Voice'
                      : voiceEngine === 'device'
                        ? `Device Voice · ${voicePreferences.readingSpeed}×`
                        : `${activePersonaOption.label} · ${voicePreferences.readingSpeed}×`}
                  </span>
                </div>

                {/* Follow-Along Highlighted Early-Reader Text (adapts gracefully for long verbatim scanned pages) */}
                <div
                  className={`mb-6 ${
                    currentPage.text.length > 260
                      ? 'max-h-[300px] sm:max-h-[360px] overflow-y-auto pr-2'
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
                          : 'text-2xl sm:text-[1.6rem] leading-[1.54]'
                    }`}
                  />
                </div>

                {/* Primary Toddler-Friendly Tap-to-Play Voice Button */}
                <button
                  type="button"
                  onClick={handleToggleNarration}
                  disabled={isLoadingAudio}
                  className="w-full min-h-[58px] px-6 py-3.5 rounded-2xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] font-semibold text-base flex items-center justify-center gap-3 transition-colors disabled:opacity-65 cursor-pointer"
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

                {/* Auto-Read & Voice Options Row */}
                <div className="mt-3.5 flex items-center justify-between gap-2">
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
                    className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap cursor-pointer ${
                      voicePreferences.autoRead
                        ? 'bg-[#2F7A5E]/12 dark:bg-[#E5A94C]/18 border-[#2F7A5E]/35 dark:border-[#E5A94C]/40 text-[#2F7A5E] dark:text-[#E5A94C]'
                        : 'border-[#E6E1D8] dark:border-[#2A324B] text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF]'
                    }`}
                  >
                    <span>Auto-Read: {voicePreferences.autoRead ? 'On' : 'Off'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowVoiceSettings((v) => !v)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] hover:bg-[#F3EFE8] dark:hover:bg-[#232B42] transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                    Voices & Speed
                  </button>
                </div>

                {/* Expandable Voice Engine, 5-Voice Persona & Reading Speed Controls */}
                {showVoiceSettings && (
                  <div className="mt-3 p-3.5 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B] space-y-3">
                    <div>
                      <div className="text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-1.5">
                        Narration Engine
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          type="button"
                          onClick={handleSwitchBackToAiVoice}
                          className={`py-2 px-2.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                            voiceEngine === 'ai'
                              ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624]'
                              : 'bg-white dark:bg-[#1A2033] text-[#5C646B] dark:text-[#A4AEC2] border border-[#E6E1D8] dark:border-[#2A324B]'
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
                          className={`py-2 px-2.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                            voiceEngine === 'device'
                              ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624]'
                              : 'bg-white dark:bg-[#1A2033] text-[#5C646B] dark:text-[#A4AEC2] border border-[#E6E1D8] dark:border-[#2A324B]'
                          }`}
                        >
                          Device Voice (Free)
                        </button>
                      </div>
                    </div>

                    <div>
                      <div className="text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-1.5">
                        {voiceEngine === 'device' ? 'Voice Tone Style' : 'AI Storyteller Voice'}
                      </div>
                      <div className="grid grid-cols-1 gap-1">
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
                              className={`text-left px-3 py-2 rounded-lg text-xs transition-colors cursor-pointer flex items-center justify-between gap-2 ${
                                active
                                  ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF] font-semibold border border-[#2F7A5E]/35 dark:border-[#E5A94C]/40'
                                  : 'text-[#5C646B] dark:text-[#A4AEC2] hover:bg-white/60 dark:hover:bg-[#1A2033]'
                              }`}
                            >
                              <span>{persona.label}</span>
                              <span className="text-[11px] opacity-75 truncate">
                                {persona.description.split(',')[0]}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <div className="text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-1.5">
                        Reading Speed
                      </div>
                      <div className="grid grid-cols-3 gap-1.5">
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
                            className={`py-1.5 px-2 rounded-lg text-xs font-semibold font-mono tabular-nums transition-colors cursor-pointer ${
                              voicePreferences.readingSpeed === opt.value
                                ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624]'
                                : 'bg-white dark:bg-[#1A2033] text-[#5C646B] dark:text-[#A4AEC2] border border-[#E6E1D8] dark:border-[#2A324B]'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* Voice Source Switcher & Clear Parent Voice Studio */}
                <div className="mt-4 pt-4 border-t border-[#E6E1D8] dark:border-[#2A324B]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-[#F2EFE8] dark:bg-[#121624]">
                      <button
                        type="button"
                        onClick={handleSwitchBackToAiVoice}
                        className={`px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                          voiceSource === 'ai' && voiceEngine === 'ai'
                            ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF]'
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
                        className={`px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                          voiceSource === 'ai' && voiceEngine === 'device'
                            ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF]'
                            : 'text-[#5C646B] dark:text-[#A4AEC2]'
                        }`}
                      >
                        Device Voice
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          stopAudio(true);
                          if (!hasParentRecording) {
                            setShowRecorder(true);
                          } else {
                            setVoiceSource('parent');
                          }
                        }}
                        className={`px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                          voiceSource === 'parent'
                            ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF]'
                            : 'text-[#5C646B] dark:text-[#A4AEC2]'
                        }`}
                      >
                        Parent
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => setShowRecorder((prev) => !prev)}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#2F7A5E] dark:text-[#E5A94C] hover:underline whitespace-nowrap cursor-pointer"
                    >
                      <Mic className="w-3.5 h-3.5" />
                      {showRecorder
                        ? 'Hide Studio'
                        : hasParentRecording
                          ? 'Parent Studio'
                          : 'Record Voice'}
                    </button>
                  </div>

                  {showRecorder && (
                    <div className="mt-3 p-3.5 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B] space-y-3">
                      <p className="text-xs text-[#5C646B] dark:text-[#A4AEC2] leading-relaxed">
                        Noise reduction & automatic vocal leveling keep your recording warm and crystal-clear.
                      </p>

                      {/* Live Microphone Level Bar */}
                      {isRecording && (
                        <div>
                          <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-[#C84B58] dark:text-[#E06D7A] mb-1">
                            <span>Recording clearly...</span>
                            <span>{recordingSeconds}s</span>
                          </div>
                          <div className="h-2 w-full rounded-full bg-[#E6E1D8] dark:bg-[#2A324B] overflow-hidden">
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
                        <div className="flex items-center gap-2 text-xs text-[#2F7A5E] dark:text-[#5CA49B]">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>{studioStatus || 'Cleaning audio...'}</span>
                        </div>
                      )}

                      {/* Primary Record / Stop Buttons */}
                      {!previewDataUrl && !isProcessingVoice && (
                        <div className="flex flex-wrap items-center gap-2">
                          {!isRecording ? (
                            <button
                              type="button"
                              onClick={() => void startParentRecording()}
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#C84B58] hover:bg-[#B33D4A] text-white text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer"
                            >
                              <Mic className="w-3.5 h-3.5" />
                              {hasParentRecording ? 'Record New Take' : 'Start Recording'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={stopParentRecording}
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#24292E] dark:bg-[#EDE9DF] text-white dark:text-[#121624] text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer"
                            >
                              <Square className="w-3.5 h-3.5 fill-current" />
                              Stop & Clean ({recordingSeconds}s)
                            </button>
                          )}
                        </div>
                      )}

                      {/* Preview & Boost Before Saving */}
                      {previewDataUrl && !isProcessingVoice && (
                        <div className="space-y-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => playDataUrlAudio(previewDataUrl, true)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] bg-white dark:bg-[#1A2033] text-xs font-semibold cursor-pointer"
                            >
                              <Play className="w-3.5 h-3.5" />
                              Preview
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleToggleExtraBoost()}
                              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer ${
                                extraBoost
                                  ? 'bg-[#2F7A5E]/15 dark:bg-[#E5A94C]/20 border-[#2F7A5E]/40 dark:border-[#E5A94C]/40 text-[#2F7A5E] dark:text-[#E5A94C]'
                                  : 'border-[#D8D1C4] dark:border-[#34405E] text-[#5C646B] dark:text-[#A4AEC2]'
                              }`}
                            >
                              Clarity Boost: {extraBoost ? 'On' : 'Standard'}
                            </button>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              disabled={isSavingVoiceClip}
                              onClick={() => void handleSavePreviewClip()}
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] text-white dark:text-[#121624] text-xs font-semibold disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                            >
                              {isSavingVoiceClip ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Check className="w-3.5 h-3.5" />
                              )}
                              {isSavingVoiceClip ? 'Saving...' : 'Save Voice Clip'}
                            </button>
                            <button
                              type="button"
                              disabled={isSavingVoiceClip}
                              onClick={() => {
                                setPreviewDataUrl(null);
                                setRawCapturedBlob(null);
                                setStudioStatus(null);
                              }}
                              className="px-2.5 py-1.5 text-xs font-medium text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] disabled:opacity-50 cursor-pointer"
                            >
                              Discard
                            </button>
                          </div>
                        </div>
                      )}

                      {studioStatus && !isProcessingVoice && (
                        <p className="text-[11px] text-[#2F7A5E] dark:text-[#5CA49B]">
                          {studioStatus}
                        </p>
                      )}

                      {/* Clear Saved Parent Voice Controls */}
                      {!isRecording && (hasParentRecording || studioStatus) && (
                        <div className="pt-2.5 border-t border-[#E6E1D8] dark:border-[#2A324B] flex flex-wrap items-center justify-between gap-2 text-xs">
                          {hasParentRecording && (
                            <button
                              type="button"
                              disabled={clearingVoiceAction !== null}
                              onClick={() => void clearParentRecording()}
                              className="inline-flex items-center gap-1 font-medium text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#C84B58] dark:hover:text-[#E06D7A] disabled:opacity-55 disabled:cursor-not-allowed cursor-pointer"
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
                            className="inline-flex items-center gap-1 font-medium text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#C84B58] dark:hover:text-[#E06D7A] disabled:opacity-55 disabled:cursor-not-allowed cursor-pointer"
                          >
                            {clearingVoiceAction === 'book' && (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            )}
                            {clearingVoiceAction === 'book'
                              ? 'Clearing...'
                              : 'Clear All Clips in Book'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {voiceNotice && !audioError && (
                    <div className="mt-3 p-3 rounded-xl bg-[#D98A1C]/10 dark:bg-[#E5A94C]/12 border border-[#D98A1C]/30 dark:border-[#E5A94C]/30 text-xs text-[#6E450A] dark:text-[#F4D39B] space-y-2">
                      <p className="leading-relaxed">{voiceNotice}</p>
                      <div className="flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          onClick={handleSwitchBackToAiVoice}
                          className="font-semibold underline cursor-pointer"
                        >
                          Try AI Voice Again
                        </button>
                        <button
                          type="button"
                          onClick={() => setVoiceNotice(null)}
                          className="opacity-80 hover:opacity-100 cursor-pointer"
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  )}

                  {audioError && (
                    <div className="mt-3 p-3.5 rounded-xl bg-[#C84B58]/10 border border-[#C84B58]/30 text-xs text-[#9C2F3B] dark:text-[#F299A3] space-y-2.5">
                      <p className="leading-relaxed">{audioError}</p>
                      <button
                        type="button"
                        onClick={handleSwitchToDeviceVoiceAndPlay}
                        className="w-full py-2 px-3 rounded-lg bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-xs font-semibold transition-colors cursor-pointer"
                      >
                        Switch to Built-in Device Voice & Play
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Page Navigation Buttons (Large Kid-Friendly Touch Targets) */}
              <div className="mt-6 pt-5 border-t border-[#E6E1D8] dark:border-[#2A324B] flex items-center justify-between gap-3">
                <button
                  type="button"
                  disabled={pageIndex === 0}
                  onClick={() => {
                    pendingAutoStartRef.current = false;
                    setPageIndex((i) => Math.max(0, i - 1));
                  }}
                  className="inline-flex items-center justify-center gap-2 min-h-[48px] px-4 py-2.5 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF] hover:bg-[#F3EFE8] dark:hover:bg-[#232B42] disabled:opacity-40 transition-colors cursor-pointer"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Previous
                </button>
                <button
                  type="button"
                  onClick={() => {
                    pendingAutoStartRef.current = false;
                    setPageIndex((i) => Math.min(totalPages, i + 1));
                  }}
                  className="flex-1 inline-flex items-center justify-center gap-2 min-h-[48px] px-5 py-2.5 rounded-xl bg-[#24292E] hover:bg-[#363D44] dark:bg-[#5CA49B] dark:hover:bg-[#4A8F86] text-white dark:text-[#121624] text-sm font-semibold transition-colors cursor-pointer"
                >
                  {pageIndex === totalPages - 1 ? 'Read Story Moral' : 'Next Page'}
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </motion.div>
        ) : (
          /* Celebratory End-of-Story Moral Spread */
          <motion.section
            key="moral-spread"
            initial={reduced ? { opacity: 1 } : { opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="max-w-4xl mx-auto bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] rounded-2xl overflow-hidden watercolor-paper-frame"
          >
            <div className="grid grid-cols-1 md:grid-cols-12 items-stretch">
              <div className="md:col-span-5 relative min-h-[240px] bg-[#EFEBE2] dark:bg-[#151A2B]">
                {resolvedPageImage && (
                  <img
                    src={resolvedPageImage}
                    alt={story.title}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                )}
              </div>

              <div className="md:col-span-7 p-7 sm:p-9 flex flex-col justify-between">
                <div>
                  <button
                    type="button"
                    onClick={() => {
                      setConfettiBurstKey((k) => k + 1);
                      playCharacterSound('twinkle', bedtimeSettings.bedtimeEnabled);
                    }}
                    className="inline-flex items-center gap-2 text-xs font-semibold text-[#D98A1C] dark:text-[#E5A94C] mb-3 hover:opacity-85 transition-opacity cursor-pointer"
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

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleToggleNarration}
                    disabled={isLoadingAudio}
                    className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-sm font-semibold transition-colors whitespace-nowrap disabled:opacity-65 disabled:cursor-not-allowed cursor-pointer"
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
                    onClick={() => {
                      pendingAutoStartRef.current = false;
                      setPageIndex(0);
                    }}
                    className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF] hover:bg-[#F3EFE8] dark:hover:bg-[#232B42] transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <RotateCcw className="w-4 h-4" />
                    Read Again
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      stopAudio(true);
                      stopCharacterAudio();
                      onExit();
                    }}
                    className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold text-[#2F7A5E] dark:text-[#5CA49B] hover:underline whitespace-nowrap cursor-pointer"
                  >
                    <Check className="w-4 h-4" />
                    Choose Another Book
                  </button>
                </div>

                {voiceNotice && !audioError && (
                  <div className="mt-4 p-3 rounded-xl bg-[#D98A1C]/10 dark:bg-[#E5A94C]/12 border border-[#D98A1C]/30 dark:border-[#E5A94C]/30 text-xs text-[#6E450A] dark:text-[#F4D39B] flex flex-wrap items-center justify-between gap-2">
                    <span>{voiceNotice}</span>
                    <button
                      type="button"
                      onClick={() => setVoiceNotice(null)}
                      className="font-semibold underline cursor-pointer"
                    >
                      Dismiss
                    </button>
                  </div>
                )}

                {audioError && (
                  <div className="mt-4 p-3 rounded-xl bg-[#C84B58]/10 border border-[#C84B58]/30 text-xs text-[#9C2F3B] dark:text-[#F299A3] flex flex-wrap items-center justify-between gap-3">
                    <span>{audioError}</span>
                    <button
                      type="button"
                      onClick={handleSwitchToDeviceVoiceAndPlay}
                      className="px-3 py-1.5 rounded-lg bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624] font-semibold cursor-pointer"
                    >
                      Use Built-in Device Voice
                    </button>
                  </div>
                )}
              </div>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      {showImageResizer && currentPage?.mediaId && resolvedPageImage && (
        <PageImageFramingModal
          sourceImageUrl={resolvedPageImage}
          pageLabel={`Page ${pageIndex + 1}`}
          onCancel={() => setShowImageResizer(false)}
          onApply={(framedUrl) => {
            void saveMediaDataUrl(currentPage.mediaId!, framedUrl).then(() => {
              setResolvedPageImage(framedUrl);
              setShowImageResizer(false);
            });
          }}
        />
      )}
    </main>
  );
}
