import { ReadingSpeed, VoicePersonaId } from '../types/story';
import {
  characterVoiceKey,
  getMediaDataUrl,
  saveMediaDataUrl,
  ttsCacheKey,
} from './mediaStore';

export interface VoicePersonaOption {
  id: VoicePersonaId;
  label: string;
  voiceName: string;
  description: string;
}

export const VOICE_PERSONAS: VoicePersonaOption[] = [
  {
    id: 'warm',
    label: 'Warm Storyteller',
    voiceName: 'Kore',
    description: 'Gentle, affectionate picture-book narrator',
  },
  {
    id: 'lullaby',
    label: 'Gentle Lullaby',
    voiceName: 'Zephyr',
    description: 'Soft, melodic tone ideal for quiet wind-down',
  },
  {
    id: 'playful',
    label: 'Playful Friend',
    voiceName: 'Puck',
    description: 'Cheerful, bright energy for daytime giggles',
  },
  {
    id: 'fireside',
    label: 'Cozy Fireside',
    voiceName: 'Charon',
    description: 'Calm, reassuring deeper storytelling voice',
  },
  {
    id: 'adventure',
    label: 'Woodland Explorer',
    voiceName: 'Fenrir',
    description: 'Expressive, upbeat voice for ages 4–5 adventures',
  },
];

export class TtsQuotaError extends Error {
  readonly code = 'QUOTA_EXCEEDED';
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds = 3600) {
    super(message);
    this.name = 'TtsQuotaError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const QUOTA_COOLDOWN_KEY = 'meadowtale_ai_tts_quota_until_v1';

export function isAiTtsQuotaCoolingDown(): boolean {
  try {
    const raw = localStorage.getItem(QUOTA_COOLDOWN_KEY);
    if (!raw) return false;
    const until = Number(raw);
    if (!Number.isFinite(until)) return false;
    if (Date.now() >= until) {
      localStorage.removeItem(QUOTA_COOLDOWN_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function markAiTtsQuotaExhausted(retryAfterSeconds = 3600): void {
  try {
    const clampedSeconds = Math.max(60, Math.min(86400, retryAfterSeconds));
    localStorage.setItem(QUOTA_COOLDOWN_KEY, String(Date.now() + clampedSeconds * 1000));
  } catch {
    // Ignore storage errors
  }
}

export function clearAiTtsQuotaCooldown(): void {
  try {
    localStorage.removeItem(QUOTA_COOLDOWN_KEY);
  } catch {
    // Ignore storage errors
  }
}

function sanitizeUserErrorMessage(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('{') || trimmed.includes('"RESOURCE_EXHAUSTED"')) {
    return fallback;
  }
  return trimmed.slice(0, 220);
}

let sharedAudioCtx: AudioContext | null = null;
let lullabyTimer: number | null = null;
let lullabyGain: GainNode | null = null;
const inflightRequests = new Map<string, Promise<string>>();

function getAudioContext(): AudioContext {
  if (!sharedAudioCtx) {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedAudioCtx = new AudioCtx();
  }
  if (sharedAudioCtx.state === 'suspended') {
    void sharedAudioCtx.resume();
  }
  return sharedAudioCtx;
}

/**
 * Plays a gentle, kid-friendly synthesized storybook sound effect
 * when tapping an interactive character hotspot.
 */
export function playCharacterSound(
  cue: 'splash' | 'chime' | 'giggle' | 'chirp' | 'twinkle',
  isBedtime = false
): void {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    const masterVolume = isBedtime ? 0.08 : 0.16;

    const playTone = (
      freq: number,
      startOffset: number,
      duration: number,
      type: OscillatorType = 'sine',
      endFreq?: number
    ) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now + startOffset);
      if (endFreq) {
        osc.frequency.exponentialRampToValueAtTime(endFreq, now + startOffset + duration);
      }
      gain.gain.setValueAtTime(0.001, now + startOffset);
      gain.gain.linearRampToValueAtTime(masterVolume, now + startOffset + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.001, now + startOffset + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + duration + 0.02);
    };

    switch (cue) {
      case 'splash':
        playTone(320, 0, 0.14, 'sine', 520);
        playTone(460, 0.09, 0.18, 'triangle', 680);
        playTone(620, 0.18, 0.22, 'sine', 840);
        break;
      case 'chirp':
        playTone(760, 0, 0.11, 'sine', 1080);
        playTone(880, 0.13, 0.14, 'sine', 1240);
        break;
      case 'giggle':
        playTone(440, 0, 0.1, 'triangle', 550);
        playTone(540, 0.11, 0.1, 'triangle', 660);
        playTone(660, 0.22, 0.15, 'triangle', 780);
        break;
      case 'twinkle':
        playTone(587.33, 0, 0.35, 'sine');
        playTone(880, 0.12, 0.4, 'sine');
        playTone(1174.66, 0.24, 0.45, 'sine');
        break;
      case 'chime':
      default:
        playTone(523.25, 0, 0.32, 'sine');
        playTone(659.25, 0.1, 0.36, 'sine');
        playTone(783.99, 0.2, 0.42, 'sine');
        break;
    }
  } catch {
    // AudioContext blocked until gesture
  }
}

/**
 * Starts or stops a soft, warm pentatonic bedtime lullaby pad.
 */
export function setAmbientLullabyActive(active: boolean): void {
  if (!active) {
    if (lullabyTimer !== null) {
      window.clearInterval(lullabyTimer);
      lullabyTimer = null;
    }
    if (lullabyGain && sharedAudioCtx) {
      try {
        lullabyGain.gain.exponentialRampToValueAtTime(0.0001, sharedAudioCtx.currentTime + 0.5);
      } catch {
        // Ignore fade error
      }
      lullabyGain = null;
    }
    return;
  }

  if (lullabyTimer !== null) return;

  try {
    const ctx = getAudioContext();
    const notes = [261.63, 293.66, 329.63, 392.0, 440.0, 329.63, 293.66, 261.63];
    let step = 0;

    const playLullabyNote = () => {
      if (!sharedAudioCtx) return;
      const now = sharedAudioCtx.currentTime;
      const osc = sharedAudioCtx.createOscillator();
      const gain = sharedAudioCtx.createGain();
      lullabyGain = gain;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(notes[step % notes.length], now);
      step += 1;

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.035, now + 0.5);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 2.3);

      osc.connect(gain);
      gain.connect(sharedAudioCtx.destination);
      osc.start(now);
      osc.stop(now + 2.4);
    };

    playLullabyNote();
    lullabyTimer = window.setInterval(playLullabyNote, 2100);
  } catch {
    // Ignore autoplay restrictions
  }
}

/**
 * Built-in Device Speech Synthesis engine (unlimited, instant, works offline).
 * Selects the warmest natural English voice available on the device, tunes pitch/rate
 * for the active persona & bedtime mode, and emits smooth follow-along progress events.
 */
export function isDeviceVoiceSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

function selectPreferredDeviceVoice(persona: VoicePersonaId): SpeechSynthesisVoice | null {
  if (!isDeviceVoiceSupported()) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices || voices.length === 0) return null;

  const englishVoices = voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
  const pool = englishVoices.length > 0 ? englishVoices : voices;

  const scoreVoice = (v: SpeechSynthesisVoice): number => {
    const name = v.name.toLowerCase();
    let score = 0;
    if (v.lang.toLowerCase() === 'en-us' || v.lang.toLowerCase() === 'en-gb') score += 8;
    if (name.includes('natural') || name.includes('neural') || name.includes('enhanced')) score += 25;
    if (name.includes('google')) score += 18;
    if (name.includes('samantha') || name.includes('karen') || name.includes('moira')) score += 16;
    if (name.includes('aria') || name.includes('jenny') || name.includes('libby')) score += 16;
    if (persona === 'fireside' || persona === 'adventure') {
      if (name.includes('daniel') || name.includes('arthur') || name.includes('guy') || name.includes('male')) {
        score += 18;
      }
    } else if (name.includes('female') || name.includes('samantha') || name.includes('zoe')) {
      score += 8;
    }
    if (v.localService) score += 4;
    return score;
  };

  return [...pool].sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] || null;
}

let activeDeviceFallbackTimer: number | null = null;

export function stopDeviceVoice(): void {
  if (activeDeviceFallbackTimer !== null) {
    window.clearInterval(activeDeviceFallbackTimer);
    activeDeviceFallbackTimer = null;
  }
  if (isDeviceVoiceSupported()) {
    window.speechSynthesis.cancel();
  }
}

export function speakWithDeviceVoice(params: {
  text: string;
  persona: VoicePersonaId;
  readingSpeed: ReadingSpeed;
  isBedtime: boolean;
  onProgress?: (progress: number) => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
}): () => void {
  stopDeviceVoice();

  if (!isDeviceVoiceSupported()) {
    params.onError?.('Built-in device voice is not supported on this browser.');
    return () => {};
  }

  const cleanText = params.text.trim();
  if (!cleanText) {
    params.onEnd?.();
    return () => {};
  }

  const utter = new SpeechSynthesisUtterance(cleanText);
  const preferredVoice = selectPreferredDeviceVoice(params.persona);
  if (preferredVoice) {
    utter.voice = preferredVoice;
    utter.lang = preferredVoice.lang;
  } else {
    utter.lang = 'en-US';
  }

  const personaPitch: Record<VoicePersonaId, number> = {
    warm: 1.03,
    lullaby: 0.96,
    playful: 1.12,
    fireside: 0.88,
    adventure: 1.05,
  };

  const baseRate = params.isBedtime
    ? Math.max(0.72, params.readingSpeed * 0.84)
    : params.readingSpeed;
  utter.rate = Math.max(0.65, Math.min(1.4, baseRate));
  utter.pitch = params.isBedtime ? Math.min(1.0, personaPitch[params.persona]) : personaPitch[params.persona];

  let cancelled = false;
  let sawBoundary = false;
  const wordCount = cleanText.split(/\s+/).filter(Boolean).length;
  const estimatedMs = Math.max(2500, (wordCount / (2.5 * utter.rate)) * 1000);
  const startedAt = Date.now();

  utter.onboundary = (event) => {
    if (cancelled) return;
    if (typeof event.charIndex === 'number' && cleanText.length > 0) {
      sawBoundary = true;
      const ratio = Math.min(0.99, Math.max(0.01, event.charIndex / cleanText.length));
      params.onProgress?.(ratio);
    }
  };

  utter.onend = () => {
    if (activeDeviceFallbackTimer !== null) {
      window.clearInterval(activeDeviceFallbackTimer);
      activeDeviceFallbackTimer = null;
    }
    if (cancelled) return;
    params.onProgress?.(1);
    params.onEnd?.();
  };

  utter.onerror = (event) => {
    if (activeDeviceFallbackTimer !== null) {
      window.clearInterval(activeDeviceFallbackTimer);
      activeDeviceFallbackTimer = null;
    }
    if (cancelled || event.error === 'interrupted' || event.error === 'canceled') return;
    params.onError?.('Could not play built-in device voice on this browser.');
  };

  // Smooth fallback progress ticker for browsers that do not emit speechSynthesis boundary events
  activeDeviceFallbackTimer = window.setInterval(() => {
    if (cancelled || sawBoundary) return;
    const elapsed = Date.now() - startedAt;
    const est = Math.min(0.95, Math.max(0.02, elapsed / estimatedMs));
    params.onProgress?.(est);
  }, 140);

  params.onProgress?.(0.01);
  window.speechSynthesis.speak(utter);

  return () => {
    cancelled = true;
    stopDeviceVoice();
  };
}

export function speakCharacterWithDeviceVoice(params: {
  characterName: string;
  dialogue: string;
  readingSpeed: ReadingSpeed;
}): void {
  if (!isDeviceVoiceSupported()) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(params.dialogue);
  const lower = params.characterName.toLowerCase();
  const persona: VoicePersonaId =
    lower.includes('bear') || lower.includes('badger') || lower.includes('owl')
      ? 'fireside'
      : lower.includes('luma') || lower.includes('moon')
        ? 'lullaby'
        : 'playful';

  const voice = selectPreferredDeviceVoice(persona);
  if (voice) utter.voice = voice;
  utter.rate = Math.max(0.85, Math.min(1.25, params.readingSpeed));
  utter.pitch = persona === 'fireside' ? 0.88 : persona === 'playful' ? 1.18 : 1.06;
  window.speechSynthesis.speak(utter);
}

/**
 * Fetches expressive AI WAV narration from /api/tts/narrate with deduplicated inflight
 * requests and IndexedDB caching per persona and mode.
 */
export async function fetchAiNarrationAudio(params: {
  storyId: string;
  pageId: string;
  text: string;
  mode: 'daytime' | 'bedtime';
  voicePersona: VoicePersonaId;
}): Promise<string> {
  const cacheKey = ttsCacheKey(params.storyId, params.pageId, params.mode, params.voicePersona);
  const cached = await getMediaDataUrl(cacheKey);
  if (cached) {
    return cached;
  }

  if (isAiTtsQuotaCoolingDown()) {
    throw new TtsQuotaError(
      'Daily AI voice limit reached on the free plan. Switched to built-in device voice so storytime continues smoothly.'
    );
  }

  const existing = inflightRequests.get(cacheKey);
  if (existing) {
    return existing;
  }

  const reqPromise = (async () => {
    const res = await fetch('/api/tts/narrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: params.text,
        mode: params.mode,
        voicePersona: params.voicePersona,
      }),
    });

    const data = (await res.json()) as {
      audioBase64?: string;
      mimeType?: string;
      error?: string;
      code?: string;
      retryAfterSeconds?: number;
    };

    if (res.status === 429 || data.code === 'QUOTA_EXCEEDED') {
      markAiTtsQuotaExhausted(data.retryAfterSeconds ?? 3600);
      throw new TtsQuotaError(
        sanitizeUserErrorMessage(
          data.error,
          'Daily AI voice limit reached on the free plan. You can switch to the built-in device voice for unlimited instant narration.'
        ),
        data.retryAfterSeconds ?? 3600
      );
    }

    if (!res.ok || !data.audioBase64) {
      throw new Error(
        sanitizeUserErrorMessage(
          data.error,
          'AI voice narration is temporarily unavailable. You can use the built-in device voice instead.'
        )
      );
    }

    const dataUrl = `data:${data.mimeType || 'audio/wav'};base64,${data.audioBase64}`;
    await saveMediaDataUrl(cacheKey, dataUrl);
    return dataUrl;
  })();

  inflightRequests.set(cacheKey, reqPromise);
  try {
    return await reqPromise;
  } finally {
    inflightRequests.delete(cacheKey);
  }
}

/**
 * Quietly preloads the upcoming page's AI narration into IndexedDB for zero-wait page turns.
 * Automatically skips when quota cooldown is active so free-tier quota is preserved.
 */
export async function preloadAiNarrationAudio(params: {
  storyId: string;
  pageId: string;
  text: string;
  mode: 'daytime' | 'bedtime';
  voicePersona: VoicePersonaId;
}): Promise<boolean> {
  if (isAiTtsQuotaCoolingDown()) {
    return false;
  }
  try {
    await fetchAiNarrationAudio(params);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetches and caches spoken character dialogue when a child taps an interactive hotspot.
 */
export async function fetchCharacterVoiceAudio(params: {
  storyId: string;
  hotspotId: string;
  characterName: string;
  dialogue: string;
}): Promise<string> {
  const cacheKey = characterVoiceKey(params.storyId, params.hotspotId);
  const cached = await getMediaDataUrl(cacheKey);
  if (cached) {
    return cached;
  }

  if (isAiTtsQuotaCoolingDown()) {
    throw new TtsQuotaError('Daily AI voice limit reached.');
  }

  const existing = inflightRequests.get(cacheKey);
  if (existing) {
    return existing;
  }

  const reqPromise = (async () => {
    const res = await fetch('/api/tts/narrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: params.dialogue,
        mode: 'character',
        characterName: params.characterName,
      }),
    });
    const data = (await res.json()) as {
      audioBase64?: string;
      mimeType?: string;
      error?: string;
      code?: string;
      retryAfterSeconds?: number;
    };
    if (res.status === 429 || data.code === 'QUOTA_EXCEEDED') {
      markAiTtsQuotaExhausted(data.retryAfterSeconds ?? 3600);
      throw new TtsQuotaError('Daily AI voice limit reached.', data.retryAfterSeconds ?? 3600);
    }
    if (!res.ok || !data.audioBase64) {
      throw new Error(
        sanitizeUserErrorMessage(data.error, 'Could not speak character line right now.')
      );
    }
    const dataUrl = `data:${data.mimeType || 'audio/wav'};base64,${data.audioBase64}`;
    await saveMediaDataUrl(cacheKey, dataUrl);
    return dataUrl;
  })();

  inflightRequests.set(cacheKey, reqPromise);
  try {
    return await reqPromise;
  } finally {
    inflightRequests.delete(cacheKey);
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to encode audio recording.'));
      }
    };
    reader.onerror = () => reject(reader.error || new Error('Audio read error'));
    reader.readAsDataURL(blob);
  });
}
