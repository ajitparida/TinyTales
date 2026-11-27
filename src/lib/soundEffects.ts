import { CharacterHotspot } from '../types/story';

export type CharacterSoundCue = CharacterHotspot['soundCue'];

export type SoundEffectId =
  | 'pageTurnForward'
  | 'pageTurnBackward'
  | 'bookOpen'
  | 'moralFanfare'
  | 'splash'
  | 'chirp'
  | 'giggle'
  | 'chime'
  | 'twinkle'
  | 'ribbit'
  | 'hoot'
  | 'hop';

export interface SoundEffectOptions {
  enabled?: boolean;
  isBedtime?: boolean;
  volume?: number; // 0.0 to 1.0 (default 0.85)
}

export interface SoundPreviewItem {
  id: SoundEffectId;
  label: string;
}

export const STORYBOOK_SFX_PREVIEWS: ReadonlyArray<SoundPreviewItem> = [
  { id: 'pageTurnForward', label: 'Page Turn' },
  { id: 'splash', label: 'Splash' },
  { id: 'chirp', label: 'Chirp' },
  { id: 'giggle', label: 'Giggle' },
  { id: 'chime', label: 'Chime' },
  { id: 'twinkle', label: 'Twinkle' },
];

let sfxCtx: AudioContext | null = null;
let sfxCompressor: DynamicsCompressorNode | null = null;
let cachedPinkNoiseBuffer: AudioBuffer | null = null;
let lastTapDetuneStep = 0;

function ensureAudioContext(): { ctx: AudioContext; destination: AudioNode } | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!sfxCtx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      sfxCtx = new AudioCtx();

      const comp = sfxCtx.createDynamicsCompressor();
      comp.threshold.setValueAtTime(-16, sfxCtx.currentTime);
      comp.knee.setValueAtTime(18, sfxCtx.currentTime);
      comp.ratio.setValueAtTime(4, sfxCtx.currentTime);
      comp.attack.setValueAtTime(0.004, sfxCtx.currentTime);
      comp.release.setValueAtTime(0.18, sfxCtx.currentTime);
      comp.connect(sfxCtx.destination);
      sfxCompressor = comp;
    }

    if (sfxCtx.state === 'suspended') {
      void sfxCtx.resume();
    }

    return {
      ctx: sfxCtx,
      destination: sfxCompressor || sfxCtx.destination,
    };
  } catch {
    return null;
  }
}

/**
 * Generates and caches a 1.2-second pink-weighted noise buffer for warm,
 * organic paper rustles, gentle splashes, and soft woodland air textures.
 */
function getWarmNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (cachedPinkNoiseBuffer && cachedPinkNoiseBuffer.sampleRate === ctx.sampleRate) {
    return cachedPinkNoiseBuffer;
  }
  const length = Math.floor(ctx.sampleRate * 1.2);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);

  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;

  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.14;
    b6 = white * 0.115926;
    data[i] = Math.max(-1, Math.min(1, pink));
  }

  cachedPinkNoiseBuffer = buffer;
  return buffer;
}

function createToneBus(
  ctx: AudioContext,
  destination: AudioNode,
  isBedtime: boolean,
  volume: number
): { input: GainNode; masterLevel: number } {
  const safeVol = Math.max(0.15, Math.min(1, Number.isFinite(volume) ? volume : 0.85));
  const masterLevel = (isBedtime ? 0.46 : 1) * safeVol;

  const warmthFilter = ctx.createBiquadFilter();
  warmthFilter.type = 'lowpass';
  warmthFilter.frequency.setValueAtTime(isBedtime ? 3400 : 7600, ctx.currentTime);
  warmthFilter.Q.setValueAtTime(0.6, ctx.currentTime);

  const busGain = ctx.createGain();
  busGain.gain.setValueAtTime(masterLevel, ctx.currentTime);

  busGain.connect(warmthFilter);
  warmthFilter.connect(destination);

  return { input: busGain, masterLevel };
}

function nextSubtleDetuneRatio(): number {
  const steps = [1, 1.022, 0.982, 1.014, 0.99];
  const ratio = steps[lastTapDetuneStep % steps.length];
  lastTapDetuneStep = (lastTapDetuneStep + 1) % steps.length;
  return ratio;
}

function scheduleTone(
  ctx: AudioContext,
  dest: AudioNode,
  opts: {
    start: number;
    duration: number;
    freq: number;
    endFreq?: number;
    type?: OscillatorType;
    peakGain: number;
    attack?: number;
  }
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const attack = opts.attack ?? 0.016;

  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(Math.max(40, opts.freq), opts.start);
  if (opts.endFreq && opts.endFreq > 0) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(40, opts.endFreq),
      opts.start + opts.duration
    );
  }

  gain.gain.setValueAtTime(0.0001, opts.start);
  gain.gain.linearRampToValueAtTime(Math.max(0.001, opts.peakGain), opts.start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, opts.start + opts.duration);

  osc.connect(gain);
  gain.connect(dest);

  osc.start(opts.start);
  osc.stop(opts.start + opts.duration + 0.025);
}

function scheduleNoiseSweep(
  ctx: AudioContext,
  dest: AudioNode,
  opts: {
    start: number;
    duration: number;
    startFreq: number;
    midFreq: number;
    endFreq: number;
    q?: number;
    peakGain: number;
    filterType?: BiquadFilterType;
    bufferOffset?: number;
  }
): void {
  const buffer = getWarmNoiseBuffer(ctx);
  const src = ctx.createBufferSource();
  src.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = opts.filterType ?? 'bandpass';
  filter.Q.setValueAtTime(opts.q ?? 1.4, opts.start);
  filter.frequency.setValueAtTime(opts.startFreq, opts.start);
  filter.frequency.exponentialRampToValueAtTime(opts.midFreq, opts.start + opts.duration * 0.45);
  filter.frequency.exponentialRampToValueAtTime(opts.endFreq, opts.start + opts.duration);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, opts.start);
  gain.gain.linearRampToValueAtTime(opts.peakGain, opts.start + opts.duration * 0.28);
  gain.gain.exponentialRampToValueAtTime(0.0001, opts.start + opts.duration);

  src.connect(filter);
  filter.connect(gain);
  gain.connect(dest);

  const maxOffset = Math.max(0, buffer.duration - opts.duration - 0.05);
  const offset =
    typeof opts.bufferOffset === 'number'
      ? Math.min(maxOffset, opts.bufferOffset)
      : Math.random() * maxOffset;

  src.start(opts.start, offset, opts.duration + 0.03);
}

function playPageTurnEffect(
  ctx: AudioContext,
  dest: AudioNode,
  direction: 1 | -1
): void {
  const now = ctx.currentTime;

  if (direction > 0) {
    // Crisp forward cotton-paper page flip: light lift + airy arc + soft settle
    scheduleNoiseSweep(ctx, dest, {
      start: now,
      duration: 0.14,
      startFreq: 950,
      midFreq: 2500,
      endFreq: 1350,
      q: 1.25,
      peakGain: 0.24,
    });
    scheduleNoiseSweep(ctx, dest, {
      start: now + 0.095,
      duration: 0.14,
      startFreq: 1700,
      midFreq: 1050,
      endFreq: 680,
      q: 1.5,
      peakGain: 0.15,
    });
    // Subtle warm paper-spine settle thump
    scheduleTone(ctx, dest, {
      start: now + 0.145,
      duration: 0.085,
      freq: 135,
      endFreq: 74,
      type: 'sine',
      peakGain: 0.055,
      attack: 0.008,
    });
  } else {
    // Soft backward page flip: slightly warmer downward sweep
    scheduleNoiseSweep(ctx, dest, {
      start: now,
      duration: 0.13,
      startFreq: 2150,
      midFreq: 1180,
      endFreq: 860,
      q: 1.35,
      peakGain: 0.2,
    });
    scheduleNoiseSweep(ctx, dest, {
      start: now + 0.085,
      duration: 0.125,
      startFreq: 1050,
      midFreq: 1620,
      endFreq: 900,
      q: 1.55,
      peakGain: 0.12,
    });
    scheduleTone(ctx, dest, {
      start: now + 0.13,
      duration: 0.075,
      freq: 118,
      endFreq: 68,
      type: 'sine',
      peakGain: 0.045,
      attack: 0.008,
    });
  }
}

function playBookOpenEffect(ctx: AudioContext, dest: AudioNode): void {
  const now = ctx.currentTime;
  scheduleNoiseSweep(ctx, dest, {
    start: now,
    duration: 0.2,
    startFreq: 700,
    midFreq: 1850,
    endFreq: 950,
    q: 1.1,
    peakGain: 0.18,
  });
  scheduleTone(ctx, dest, {
    start: now + 0.06,
    duration: 0.34,
    freq: 523.25, // C5
    type: 'sine',
    peakGain: 0.09,
    attack: 0.02,
  });
  scheduleTone(ctx, dest, {
    start: now + 0.14,
    duration: 0.42,
    freq: 783.99, // G5
    type: 'triangle',
    peakGain: 0.075,
    attack: 0.02,
  });
}

function playMoralFanfareEffect(ctx: AudioContext, dest: AudioNode): void {
  const now = ctx.currentTime;
  const notes = [523.25, 659.25, 783.99, 987.77, 1046.5, 1318.51];
  notes.forEach((freq, i) => {
    const start = now + i * 0.082;
    scheduleTone(ctx, dest, {
      start,
      duration: 0.52,
      freq,
      type: 'sine',
      peakGain: i === notes.length - 1 ? 0.13 : 0.1,
      attack: 0.015,
    });
    // Soft celesta overtone shimmer
    scheduleTone(ctx, dest, {
      start: start + 0.01,
      duration: 0.28,
      freq: freq * 2,
      type: 'sine',
      peakGain: 0.026,
      attack: 0.01,
    });
  });
}

function playSplashEffect(ctx: AudioContext, dest: AudioNode, detune: number): void {
  const now = ctx.currentTime;
  // Soft water spray burst
  scheduleNoiseSweep(ctx, dest, {
    start: now,
    duration: 0.18,
    startFreq: 1400,
    midFreq: 3200,
    endFreq: 1100,
    q: 1.0,
    peakGain: 0.18,
  });
  // Three organic rising water-droplet plops
  const drops = [
    { offset: 0.0, f0: 290, f1: 710, dur: 0.12, gain: 0.16 },
    { offset: 0.075, f0: 410, f1: 920, dur: 0.14, gain: 0.14 },
    { offset: 0.155, f0: 540, f1: 1180, dur: 0.16, gain: 0.11 },
  ];
  for (const d of drops) {
    scheduleTone(ctx, dest, {
      start: now + d.offset,
      duration: d.dur,
      freq: d.f0 * detune,
      endFreq: d.f1 * detune,
      type: 'sine',
      peakGain: d.gain,
      attack: 0.01,
    });
  }
}

function playChirpEffect(ctx: AudioContext, dest: AudioNode, detune: number): void {
  const now = ctx.currentTime;
  const chirps = [
    { offset: 0, f0: 840, f1: 1380, dur: 0.11 },
    { offset: 0.125, f0: 960, f1: 1580, dur: 0.135 },
  ];
  for (const c of chirps) {
    const start = now + c.offset;
    const osc = ctx.createOscillator();
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(c.f0 * detune, start);
    osc.frequency.exponentialRampToValueAtTime(c.f1 * detune, start + c.dur * 0.72);
    osc.frequency.exponentialRampToValueAtTime(c.f1 * 0.88 * detune, start + c.dur);

    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(36, start);
    lfoGain.gain.setValueAtTime(48, start);
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(0.15, start + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + c.dur);

    osc.connect(gain);
    gain.connect(dest);

    osc.start(start);
    lfo.start(start);
    osc.stop(start + c.dur + 0.02);
    lfo.stop(start + c.dur + 0.02);
  }
}

function playGiggleEffect(ctx: AudioContext, dest: AudioNode, detune: number): void {
  const now = ctx.currentTime;
  // Bouncy wooden marimba arpeggio that feels playful & giggly
  const notes = [587.33, 739.99, 880, 1174.66];
  notes.forEach((n, idx) => {
    const start = now + idx * 0.072;
    scheduleTone(ctx, dest, {
      start,
      duration: 0.13,
      freq: n * 0.94 * detune,
      endFreq: n * 1.04 * detune,
      type: 'triangle',
      peakGain: 0.145,
      attack: 0.008,
    });
    scheduleTone(ctx, dest, {
      start,
      duration: 0.055,
      freq: n * 2 * detune,
      type: 'sine',
      peakGain: 0.04,
      attack: 0.004,
    });
  });
}

function playChimeEffect(ctx: AudioContext, dest: AudioNode, detune: number): void {
  const now = ctx.currentTime;
  // Warm music-box / kalimba major-9th chord
  const chord = [523.25, 659.25, 783.99, 1174.66];
  chord.forEach((freq, idx) => {
    const start = now + idx * 0.068;
    scheduleTone(ctx, dest, {
      start,
      duration: 0.44,
      freq: freq * detune,
      type: 'sine',
      peakGain: 0.125,
      attack: 0.012,
    });
    scheduleTone(ctx, dest, {
      start: start + 0.008,
      duration: 0.22,
      freq: freq * 2.003 * detune,
      type: 'sine',
      peakGain: 0.028,
      attack: 0.01,
    });
  });
}

function playTwinkleEffect(ctx: AudioContext, dest: AudioNode, detune: number): void {
  const now = ctx.currentTime;
  // Fairy-harp sparkle glissando
  const notes = [587.33, 739.99, 880, 1174.66, 1479.98];
  notes.forEach((freq, idx) => {
    const start = now + idx * 0.062;
    scheduleTone(ctx, dest, {
      start,
      duration: 0.42,
      freq: freq * detune,
      type: 'sine',
      peakGain: 0.11,
      attack: 0.01,
    });
    scheduleTone(ctx, dest, {
      start: start + 0.01,
      duration: 0.2,
      freq: freq * 3 * detune,
      type: 'sine',
      peakGain: 0.018,
      attack: 0.008,
    });
  });
}

function playRibbitEffect(ctx: AudioContext, dest: AudioNode, detune: number): void {
  const now = ctx.currentTime;
  [0, 0.135].forEach((offset, idx) => {
    const start = now + offset;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime((idx === 0 ? 155 : 172) * detune, start);
    osc.frequency.exponentialRampToValueAtTime((idx === 0 ? 295 : 330) * detune, start + 0.095);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(720 * detune, start);
    filter.frequency.exponentialRampToValueAtTime(1180 * detune, start + 0.095);
    filter.Q.setValueAtTime(3.2, start);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(0.16, start + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(dest);

    osc.start(start);
    osc.stop(start + 0.125);
  });
}

function playHootEffect(ctx: AudioContext, dest: AudioNode, detune: number): void {
  const now = ctx.currentTime;
  // Soft velvety woodland owl "hoo-hoo"
  scheduleTone(ctx, dest, {
    start: now,
    duration: 0.16,
    freq: 430 * detune,
    endFreq: 390 * detune,
    type: 'sine',
    peakGain: 0.135,
    attack: 0.03,
  });
  scheduleTone(ctx, dest, {
    start: now + 0.18,
    duration: 0.28,
    freq: 425 * detune,
    endFreq: 355 * detune,
    type: 'sine',
    peakGain: 0.15,
    attack: 0.035,
  });
}

function playHopEffect(ctx: AudioContext, dest: AudioNode, detune: number): void {
  const now = ctx.currentTime;
  scheduleTone(ctx, dest, {
    start: now,
    duration: 0.14,
    freq: 240 * detune,
    endFreq: 560 * detune,
    type: 'triangle',
    peakGain: 0.14,
    attack: 0.008,
  });
}

/**
 * Plays any named sound effect from the Meadowtale storybook SFX library.
 * Safe to invoke anywhere — silently no-ops if disabled or before gesture unlock.
 */
export function playSoundEffect(
  id: SoundEffectId,
  options: SoundEffectOptions = {}
): void {
  if (options.enabled === false) return;
  const audio = ensureAudioContext();
  if (!audio) return;

  const isBedtime = Boolean(options.isBedtime);
  const { input } = createToneBus(audio.ctx, audio.destination, isBedtime, options.volume ?? 0.85);
  const detune = nextSubtleDetuneRatio();

  switch (id) {
    case 'pageTurnForward':
      playPageTurnEffect(audio.ctx, input, 1);
      break;
    case 'pageTurnBackward':
      playPageTurnEffect(audio.ctx, input, -1);
      break;
    case 'bookOpen':
      playBookOpenEffect(audio.ctx, input);
      break;
    case 'moralFanfare':
      playMoralFanfareEffect(audio.ctx, input);
      break;
    case 'splash':
      playSplashEffect(audio.ctx, input, detune);
      break;
    case 'chirp':
      playChirpEffect(audio.ctx, input, detune);
      break;
    case 'giggle':
      playGiggleEffect(audio.ctx, input, detune);
      break;
    case 'twinkle':
      playTwinkleEffect(audio.ctx, input, detune);
      break;
    case 'ribbit':
      playRibbitEffect(audio.ctx, input, detune);
      break;
    case 'hoot':
      playHootEffect(audio.ctx, input, detune);
      break;
    case 'hop':
      playHopEffect(audio.ctx, input, detune);
      break;
    case 'chime':
    default:
      playChimeEffect(audio.ctx, input, detune);
      break;
  }
}

/**
 * Plays a crisp, directional cotton-paper page-turn sound effect.
 */
export function playPageTurnSound(
  direction: 1 | -1,
  options: SoundEffectOptions = {}
): void {
  playSoundEffect(direction > 0 ? 'pageTurnForward' : 'pageTurnBackward', options);
}

/**
 * Plays the end-of-story celebratory harp & celesta fanfare.
 */
export function playMoralCelebrationSound(options: SoundEffectOptions = {}): void {
  playSoundEffect('moralFanfare', options);
}

/**
 * Plays a rich, character-aware sound effect when a child taps an interactive hotspot.
 * Automatically layers authentic woodland character cues (frog ribbit, owl hoot, bunny hop)
 * alongside the hotspot's configured soundCue so every character feels distinct and alive.
 */
export function playCharacterTapSound(
  hotspot: Pick<CharacterHotspot, 'name' | 'soundCue' | 'reaction'>,
  options: SoundEffectOptions = {}
): void {
  if (options.enabled === false) return;
  const lowerName = (hotspot.name || '').toLowerCase();

  if (lowerName.includes('frog')) {
    playSoundEffect('ribbit', options);
    return;
  }
  if (lowerName.includes('owl')) {
    playSoundEffect('hoot', options);
    return;
  }
  if (lowerName.includes('bunny') || lowerName.includes('rabbit')) {
    playSoundEffect('hop', options);
    window.setTimeout(() => {
      playSoundEffect(hotspot.soundCue, {
        ...options,
        volume: (options.volume ?? 0.85) * 0.72,
      });
    }, 85);
    return;
  }

  playSoundEffect(hotspot.soundCue, options);
}
