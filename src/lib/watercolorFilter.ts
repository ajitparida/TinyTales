/**
 * Non-blocking client-side HTML5 Canvas image processing for physical storybook snapshots:
 * 1. Yields cleanly to the browser paint loop between stages so progress bars & spinners stay smooth.
 * 2. Uses async canvas.toBlob() encoding instead of synchronous main-thread canvas.toDataURL().
 * 3. Uses a tiny 48x48 exposure sample + cached cotton-paper CanvasPattern instead of full-frame
 *    getImageData pixel loops and thousands of fillRect calls (eliminates UI freezes).
 */

export type ImageProgressCallback = (percent: number) => void;

/**
 * Yields control back to the browser so React state updates (progress bars, spinners)
 * actually paint before the next canvas step executes.
 */
export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // Safeguard timer ensures we never stall if the tab is backgrounded
    const timer = window.setTimeout(done, 36);
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => {
        window.clearTimeout(timer);
        window.setTimeout(done, 0);
      });
    }
  });
}

/**
 * Encodes an HTMLCanvasElement to a data URL asynchronously using canvas.toBlob()
 * so JPEG compression does not lock the main UI thread.
 */
function canvasToDataUrlAsync(
  canvas: HTMLCanvasElement,
  mimeType = 'image/jpeg',
  quality = 0.88
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      try {
        resolve(canvas.toDataURL(mimeType, quality));
      } catch (err) {
        reject(err);
      }
      return;
    }

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          try {
            resolve(canvas.toDataURL(mimeType, quality));
          } catch (err) {
            reject(err);
          }
          return;
        }
        const reader = new FileReader();
        reader.onloadend = () => {
          if (typeof reader.result === 'string') {
            resolve(reader.result);
          } else {
            reject(new Error('Could not read encoded image data.'));
          }
        };
        reader.onerror = () => reject(new Error('Failed to encode processed image.'));
        reader.readAsDataURL(blob);
      },
      mimeType,
      quality
    );
  });
}

function loadImageElement(src: string, errorMessage: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new Image();
    el.decoding = 'async';
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error(errorMessage));
    el.src = src;
  });
}

let cachedPaperGrainTile: HTMLCanvasElement | null = null;

function getPaperGrainTile(): HTMLCanvasElement {
  if (cachedPaperGrainTile) return cachedPaperGrainTile;
  const tile = document.createElement('canvas');
  tile.width = 256;
  tile.height = 256;
  const tCtx = tile.getContext('2d');
  if (tCtx) {
    // Pre-render subtle cold-press watercolor paper grain once in memory
    for (let i = 0; i < 420; i++) {
      const rx = Math.abs((Math.sin(i * 12.9898) * 43758.5453) % 1);
      const ry = Math.abs((Math.sin(i * 78.233) * 43758.5453) % 1);
      const px = Math.floor(rx * 256);
      const py = Math.floor(ry * 256);
      tCtx.fillStyle = i % 3 === 0 ? 'rgba(255, 252, 245, 0.09)' : 'rgba(128, 108, 84, 0.055)';
      tCtx.fillRect(px, py, i % 4 === 0 ? 3 : 2, 2);
    }
  }
  cachedPaperGrainTile = tile;
  return tile;
}

/**
 * Samples a tiny 48x48 version of the image (<1ms) to estimate dim indoor lighting
 * without forcing a full-resolution GPU-to-CPU readback stall.
 */
function estimatePhotoBrightnessBoost(img: HTMLImageElement): number {
  try {
    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = 48;
    sampleCanvas.height = 48;
    const sCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
    if (!sCtx) return 1.05;
    sCtx.drawImage(img, 0, 0, 48, 48);
    const data = sCtx.getImageData(0, 0, 48, 48).data;
    let lumSum = 0;
    const pixelCount = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      lumSum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    }
    const avgLum = lumSum / Math.max(1, pixelCount);
    if (avgLum < 125) {
      // Gently brighten dimly lit indoor book photos
      return Number(Math.min(1.22, 1.05 + ((125 - avgLum) / 125) * 0.17).toFixed(2));
    }
    return 1.05;
  } catch {
    return 1.05;
  }
}

export async function fileToCompressedDataUrl(
  file: File,
  maxDimension = 1400,
  quality = 0.88,
  onProgress?: ImageProgressCallback
): Promise<{ dataUrl: string; mimeType: string }> {
  onProgress?.(10);
  await yieldToBrowser();

  let sourceWidth = 0;
  let sourceHeight = 0;
  let bitmap: ImageBitmap | null = null;
  let fallbackImg: HTMLImageElement | null = null;
  let fallbackUrl: string | null = null;

  try {
    if (typeof createImageBitmap === 'function') {
      try {
        bitmap = await createImageBitmap(file);
        sourceWidth = bitmap.width;
        sourceHeight = bitmap.height;
      } catch {
        bitmap = null;
      }
    }

    if (!bitmap) {
      fallbackUrl = URL.createObjectURL(file);
      fallbackImg = await loadImageElement(fallbackUrl, 'Could not read the selected image file.');
      sourceWidth = fallbackImg.naturalWidth || fallbackImg.width;
      sourceHeight = fallbackImg.naturalHeight || fallbackImg.height;
    }

    onProgress?.(45);
    await yieldToBrowser();

    const scale = Math.min(1, maxDimension / Math.max(1, sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not initialize image canvas.');
    }

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    if (bitmap) {
      ctx.drawImage(bitmap, 0, 0, width, height);
    } else if (fallbackImg) {
      ctx.drawImage(fallbackImg, 0, 0, width, height);
    }

    onProgress?.(75);
    await yieldToBrowser();

    const dataUrl = await canvasToDataUrlAsync(canvas, 'image/jpeg', quality);
    onProgress?.(100);
    return { dataUrl, mimeType: 'image/jpeg' };
  } finally {
    if (bitmap) bitmap.close();
    if (fallbackUrl) URL.revokeObjectURL(fallbackUrl);
  }
}

/**
 * Re-compresses an image data URL specifically for fast, reliable API uploads
 * (prevents proxy 413 Payload Too Large or timeout HTML responses on large multi-photo scans
 * while preserving crisp legibility for Gemini OCR and scene reference).
 */
export async function compressDataUrlForApi(
  sourceDataUrl: string,
  maxDimension = 1080,
  quality = 0.74
): Promise<{ dataUrl: string; mimeType: string }> {
  try {
    const img = await loadImageElement(
      sourceDataUrl,
      'Failed to load image for upload compression.'
    );
    await yieldToBrowser();

    const scale = Math.min(1, maxDimension / Math.max(img.width || 1, img.height || 1));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { dataUrl: sourceDataUrl, mimeType: 'image/jpeg' };

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    const dataUrl = await canvasToDataUrlAsync(canvas, 'image/jpeg', quality);
    return {
      dataUrl,
      mimeType: 'image/jpeg',
    };
  } catch {
    return { dataUrl: sourceDataUrl, mimeType: 'image/jpeg' };
  }
}

/**
 * Compresses a custom storybook illustration into a crisp JPEG data URL guaranteed
 * to stay well below Firestore's 700KB security rule limit (and 1MB document ceiling)
 * so custom book artwork syncs seamlessly across browsers, incognito sessions, and devices.
 */
export async function compressImageForCloudSync(
  sourceDataUrl: string,
  maxChars = 580_000
): Promise<{ dataUrl: string; mimeType: 'image/jpeg' }> {
  const attempts: Array<{ maxDim: number; quality: number }> = [
    { maxDim: 960, quality: 0.78 },
    { maxDim: 820, quality: 0.68 },
    { maxDim: 680, quality: 0.58 },
    { maxDim: 540, quality: 0.5 },
  ];

  let lastResult = { dataUrl: sourceDataUrl, mimeType: 'image/jpeg' as const };
  for (const step of attempts) {
    const compressed = await compressDataUrlForApi(sourceDataUrl, step.maxDim, step.quality);
    lastResult = { dataUrl: compressed.dataUrl, mimeType: 'image/jpeg' };
    if (compressed.dataUrl.length <= maxChars) {
      return lastResult;
    }
  }
  return lastResult;
}

function applyCottonPaperFinish(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  options: { glazeOpacity: number; borderOpacity: number }
) {
  ctx.save();

  // Warm cotton watercolor paper glaze
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = `rgba(250, 243, 228, ${options.glazeOpacity})`;
  ctx.fillRect(0, 0, width, height);

  // Instant repeating cold-press paper grain via cached 256x256 CanvasPattern (<1ms)
  ctx.globalCompositeOperation = 'source-over';
  const pattern = ctx.createPattern(getPaperGrainTile(), 'repeat');
  if (pattern) {
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, width, height);
  }

  // Soft deckled cream watercolor border frame
  const vignette = ctx.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.38,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.72
  );
  vignette.addColorStop(0, 'rgba(250, 248, 244, 0)');
  vignette.addColorStop(0.84, `rgba(250, 248, 244, ${(options.borderOpacity * 0.22).toFixed(2)})`);
  vignette.addColorStop(1, `rgba(250, 248, 244, ${options.borderOpacity.toFixed(2)})`);
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  ctx.restore();
}

/**
 * Brightens dimly lit book photos and softens photographic noise into a warm
 * painterly watercolor finish on cotton paper — non-blocking with progress updates.
 */
export async function renderWatercolorStorybookStyle(
  sourceDataUrl: string,
  onProgress?: ImageProgressCallback
): Promise<string> {
  onProgress?.(10);
  const img = await loadImageElement(sourceDataUrl, 'Failed to load image for watercolor styling.');

  onProgress?.(25);
  await yieldToBrowser();

  const width = Math.min(img.width || 1080, 1080);
  const height = Math.max(1, Math.round(((img.height || 810) / Math.max(1, img.width || 1080)) * width));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return sourceDataUrl;

  const brightnessBoost = estimatePhotoBrightnessBoost(img);

  // Step 1: Soft painterly watercolor base wash
  ctx.filter = `brightness(${brightnessBoost}) contrast(1.07) saturate(1.26) blur(0.9px)`;
  ctx.drawImage(img, 0, 0, width, height);

  onProgress?.(50);
  await yieldToBrowser();

  // Step 2: Soft-light pigment bloom layer for rich picture-book color depth
  ctx.save();
  ctx.globalCompositeOperation = 'soft-light';
  ctx.globalAlpha = 0.28;
  ctx.filter = 'saturate(1.38) contrast(1.1) blur(1.6px)';
  ctx.drawImage(img, 0, 0, width, height);
  ctx.restore();

  // Step 3: Blend crisp illustration contours back over the wash
  ctx.save();
  ctx.globalAlpha = 0.48;
  ctx.filter = `contrast(1.18) brightness(${Math.min(1.12, brightnessBoost)}) saturate(1.1)`;
  ctx.drawImage(img, 0, 0, width, height);
  ctx.restore();

  onProgress?.(72);
  await yieldToBrowser();

  // Step 4: Instant cached cotton-paper texture & cream deckled edge
  applyCottonPaperFinish(ctx, width, height, { glazeOpacity: 0.2, borderOpacity: 0.85 });

  onProgress?.(86);
  await yieldToBrowser();

  const dataUrl = await canvasToDataUrlAsync(canvas, 'image/jpeg', 0.88);
  onProgress?.(100);
  return dataUrl;
}

/**
 * Rasterizes a sanitized AI-redrawn SVG illustration onto a crisp 4:3 watercolor canvas
 * with cold-press paper texture and warm storybook finishing.
 */
export async function renderRedrawnSvgToWatercolorCanvas(svgMarkup: string): Promise<string> {
  const blob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);

  try {
    const img = await loadImageElement(blobUrl, 'Could not render redrawn illustration.');
    await yieldToBrowser();

    const width = 1080;
    const height = 810;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not initialize illustration canvas.');
    }

    // Warm cream watercolor paper base
    ctx.fillStyle = '#FAF6EE';
    ctx.fillRect(0, 0, width, height);

    // Draw crisp SVG illustration full-bleed
    ctx.drawImage(img, 0, 0, width, height);

    // Soft atmospheric watercolor bloom pass
    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = 0.2;
    ctx.filter = 'blur(3px) saturate(1.18)';
    ctx.drawImage(img, 0, 0, width, height);
    ctx.restore();

    applyCottonPaperFinish(ctx, width, height, { glazeOpacity: 0.14, borderOpacity: 0.45 });

    await yieldToBrowser();
    return await canvasToDataUrlAsync(canvas, 'image/jpeg', 0.9);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export interface ImageFrameSettings {
  fitMode: 'cover' | 'contain';
  zoom: number; // 0.5 to 2.5
  offsetX: number; // Normalized pan offset (-1 to 1 of frame width)
  offsetY: number; // Normalized pan offset (-1 to 1 of frame height)
  rotationDeg: 0 | 90 | 180 | 270;
}

/**
 * Renders an image with custom resize/zoom, pan offset, fit/fill mode, and 90-degree
 * rotation onto a crisp 4:3 (1080x810) storybook canvas with a warm cotton-paper matte.
 */
export async function renderFramedPageImage(
  sourceDataUrl: string,
  settings: ImageFrameSettings,
  onProgress?: ImageProgressCallback
): Promise<string> {
  onProgress?.(15);
  const img = await loadImageElement(sourceDataUrl, 'Failed to load image for resizing.');

  onProgress?.(40);
  await yieldToBrowser();

  const outWidth = 1080;
  const outHeight = 810;
  const canvas = document.createElement('canvas');
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return sourceDataUrl;

  // Warm cotton-paper backdrop (prevents black bars when zoomed out or in Fit mode)
  ctx.fillStyle = '#FAF6EE';
  ctx.fillRect(0, 0, outWidth, outHeight);

  const isQuarterTurn = settings.rotationDeg === 90 || settings.rotationDeg === 270;
  const effectiveW = isQuarterTurn ? img.height : img.width;
  const effectiveH = isQuarterTurn ? img.width : img.height;

  const baseScale =
    settings.fitMode === 'contain'
      ? Math.min(outWidth / effectiveW, outHeight / effectiveH)
      : Math.max(outWidth / effectiveW, outHeight / effectiveH);

  const clampedZoom = Math.max(0.5, Math.min(2.5, settings.zoom));
  const finalScale = baseScale * clampedZoom;

  const drawW = img.width * finalScale;
  const drawH = img.height * finalScale;

  const cx = outWidth / 2 + settings.offsetX * outWidth * 0.5;
  const cy = outHeight / 2 + settings.offsetY * outHeight * 0.5;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((settings.rotationDeg * Math.PI) / 180);
  ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();

  onProgress?.(75);
  await yieldToBrowser();

  const dataUrl = await canvasToDataUrlAsync(canvas, 'image/jpeg', 0.9);
  onProgress?.(100);
  return dataUrl;
}


