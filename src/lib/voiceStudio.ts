/**
 * Client-side Parent Voice Studio mastering & live mic level monitor.
 * Applies speech-focused noise filtering (95Hz rumble cut + gentle presence clarity),
 * dynamic range smoothing, and safe peak volume normalization, outputting a clean 24kHz WAV.
 */

export const CLEAR_MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

function encodeMonoWav(samples: Float32Array, sampleRate: number): Blob {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // Byte rate
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function blobToDataUrlLocal(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Failed to encode WAV clip.'));
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read WAV blob.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Cleans, balances, and normalizes a raw parent microphone recording into a crisp WAV data URL.
 */
export async function masterParentVoiceBlob(
  rawBlob: Blob,
  options: { extraBoost?: boolean } = {}
): Promise<string> {
  try {
    const arrayBuffer = await rawBlob.arrayBuffer();
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const decodeCtx = new AudioCtx();
    const decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
    await decodeCtx.close();

    const targetRate = 24000;
    const frameCount = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const offline = new OfflineAudioContext(1, frameCount, targetRate);

    const source = offline.createBufferSource();
    source.buffer = decoded;

    // 1. Cut low-frequency room hum, AC fan, and mic handling rumble below 95Hz
    const highpass = offline.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 95;
    highpass.Q.value = 0.7;

    // 2. Gentle speech presence clarity around 2.8kHz
    const presence = offline.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 2800;
    presence.Q.value = 1.0;
    presence.gain.value = options.extraBoost ? 3.2 : 2.0;

    // 3. Soft vocal dynamics compression so quiet whispers & warm peaks sit evenly
    const compressor = offline.createDynamicsCompressor();
    compressor.threshold.value = options.extraBoost ? -28 : -22;
    compressor.knee.value = 18;
    compressor.ratio.value = options.extraBoost ? 5 : 3.5;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.16;

    source.connect(highpass);
    highpass.connect(presence);
    presence.connect(compressor);
    compressor.connect(offline.destination);
    source.start(0);

    const rendered = await offline.startRendering();
    const channelData = rendered.getChannelData(0);

    // 4. Trim subtle leading/trailing dead air & normalize peak safely
    const out = new Float32Array(channelData.length);
    let peak = 0;
    for (let i = 0; i < channelData.length; i++) {
      const abs = Math.abs(channelData[i]);
      if (abs > peak) peak = abs;
    }

    const targetPeak = options.extraBoost ? 0.94 : 0.84;
    const gain = peak > 0.005 ? Math.min(options.extraBoost ? 4.5 : 3.2, targetPeak / peak) : 1;

    const fadeSamples = Math.min(Math.floor(targetRate * 0.015), Math.floor(out.length / 4));
    for (let i = 0; i < channelData.length; i++) {
      let sample = channelData[i] * gain;
      // Soft knee limiter to prevent any harsh clipping
      if (sample > 0.96) sample = 0.96 + Math.tanh((sample - 0.96) * 4) * 0.03;
      else if (sample < -0.96) sample = -0.96 + Math.tanh((sample + 0.96) * 4) * 0.03;

      if (i < fadeSamples) {
        sample *= i / fadeSamples;
      } else if (i > channelData.length - fadeSamples) {
        sample *= (channelData.length - i) / fadeSamples;
      }
      out[i] = sample;
    }

    const wavBlob = encodeMonoWav(out, targetRate);
    return blobToDataUrlLocal(wavBlob);
  } catch (err) {
    console.warn('Voice mastering fallback to raw recording:', err);
    return blobToDataUrlLocal(rawBlob);
  }
}

/**
 * Monitors real-time microphone RMS volume (0 to 1) for visual feedback during recording.
 */
export function createMicLevelMonitor(
  stream: MediaStream,
  onLevel: (level: number) => void
): () => void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let rafId = 0;
    let active = true;

    const tick = () => {
      if (!active) return;
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const normalized = (data[i] - 128) / 128;
        sumSquares += normalized * normalized;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      const scaled = Math.min(1, rms * 4.2);
      onLevel(scaled);
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);

    return () => {
      active = false;
      window.cancelAnimationFrame(rafId);
      source.disconnect();
      void ctx.close();
      onLevel(0);
    };
  } catch {
    return () => onLevel(0);
  }
}
