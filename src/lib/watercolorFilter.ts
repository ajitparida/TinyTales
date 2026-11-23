/**
 * Client-side HTML5 Canvas image processing for physical storybook snapshots:
 * 1. Compresses camera/uploaded photos cleanly for fast Gemini vision scanning.
 * 2. Renders an enhanced Painterly Watercolor Retouch (auto white-balance + shadow lift +
 *    watercolor wash + cotton paper texture) directly from a book photo.
 * 3. Composites AI-redrawn layered storybook SVG illustrations onto cold-press watercolor
 *    cotton paper so redrawn pages match Meadowtale's hand-painted picture-book aesthetic.
 */

export async function fileToCompressedDataUrl(
  file: File,
  maxDimension = 1400,
  quality = 0.88
): Promise<{ dataUrl: string; mimeType: string }> {
  const imageBitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDimension / Math.max(imageBitmap.width, imageBitmap.height));
  const width = Math.max(1, Math.round(imageBitmap.width * scale));
  const height = Math.max(1, Math.round(imageBitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not initialize image canvas.');
  }

  ctx.drawImage(imageBitmap, 0, 0, width, height);
  imageBitmap.close();

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return { dataUrl, mimeType: 'image/jpeg' };
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
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to load image for upload compression.'));
      el.src = sourceDataUrl;
    });

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
    return {
      dataUrl: canvas.toDataURL('image/jpeg', quality),
      mimeType: 'image/jpeg',
    };
  } catch {
    return { dataUrl: sourceDataUrl, mimeType: 'image/jpeg' };
  }
}

function applyCottonPaperFinish(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  options: { glazeOpacity: number; borderOpacity: number }
) {
  // Warm cotton watercolor paper glaze
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = `rgba(250, 243, 228, ${options.glazeOpacity})`;
  ctx.fillRect(0, 0, width, height);

  // Subtle organic cold-press paper grain
  ctx.globalCompositeOperation = 'source-over';
  const speckCount = Math.min(2600, Math.floor((width * height) / 340));
  for (let i = 0; i < speckCount; i++) {
    const rx = Math.abs((Math.sin(i * 12.9898) * 43758.5453) % 1);
    const ry = Math.abs((Math.sin(i * 78.233) * 43758.5453) % 1);
    const px = rx * width;
    const py = ry * height;
    ctx.fillStyle = i % 3 === 0 ? 'rgba(255, 252, 245, 0.08)' : 'rgba(128, 108, 84, 0.055)';
    ctx.fillRect(px, py, i % 4 === 0 ? 3 : 2, 2);
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
 * Normalizes indoor lamp tint, boosts faded book contrast, and softens photographic noise
 * into painterly watercolor brushwork on cotton paper.
 */
export async function renderWatercolorStorybookStyle(sourceDataUrl: string): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Failed to load image for watercolor styling.'));
    el.src = sourceDataUrl;
  });

  const width = Math.min(img.width, 1080);
  const height = Math.round((img.height / img.width) * width);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return sourceDataUrl;

  // Step 1: Soft painterly watercolor base wash (smooths paper glare & camera grain)
  ctx.filter = 'brightness(1.06) contrast(1.08) saturate(1.28) blur(1.3px)';
  ctx.drawImage(img, 0, 0, width, height);

  // Step 2: Soft-light pigment bloom layer for rich picture-book color depth
  ctx.save();
  ctx.globalCompositeOperation = 'soft-light';
  ctx.globalAlpha = 0.32;
  ctx.filter = 'saturate(1.45) contrast(1.12) blur(2.4px)';
  ctx.drawImage(img, 0, 0, width, height);
  ctx.restore();

  // Step 3: Blend subtle crisp illustration contours back over the wash
  ctx.save();
  ctx.globalAlpha = 0.48;
  ctx.filter = 'contrast(1.22) brightness(1.03) saturate(1.12)';
  ctx.drawImage(img, 0, 0, width, height);
  ctx.restore();

  // Step 4: Gentle white-balance & shadow-lift normalization for dimly lit book photos
  try {
    const imageData = ctx.getImageData(0, 0, width, height);
    const d = imageData.data;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    const sampleStep = 16;
    let count = 0;
    for (let i = 0; i < d.length; i += 4 * sampleStep) {
      sumR += d[i];
      sumG += d[i + 1];
      sumB += d[i + 2];
      count++;
    }
    if (count > 0) {
      const avgR = sumR / count;
      const avgG = sumG / count;
      const avgB = sumB / count;
      const avgLum = (avgR + avgG + avgB) / 3 || 128;
      // Gentle partial gray-world correction (35% strength) so warm art stays warm while yellow lamp casts clear up
      const gainR = 1 + ((avgLum / Math.max(40, avgR)) - 1) * 0.35;
      const gainG = 1 + ((avgLum / Math.max(40, avgG)) - 1) * 0.35;
      const gainB = 1 + ((avgLum / Math.max(40, avgB)) - 1) * 0.35;
      const lift = avgLum < 125 ? Math.min(18, (125 - avgLum) * 0.4) : 0;

      for (let i = 0; i < d.length; i += 4) {
        d[i] = Math.min(255, Math.max(0, d[i] * gainR + lift));
        d[i + 1] = Math.min(255, Math.max(0, d[i + 1] * gainG + lift));
        d[i + 2] = Math.min(255, Math.max(0, d[i + 2] * gainB + lift));
      }
      ctx.putImageData(imageData, 0, 0);
    }
  } catch {
    // Ignore pixel-access edge cases gracefully
  }

  applyCottonPaperFinish(ctx, width, height, { glazeOpacity: 0.2, borderOpacity: 0.85 });

  return canvas.toDataURL('image/jpeg', 0.88);
}

/**
 * Rasterizes a sanitized AI-redrawn SVG illustration onto a crisp 4:3 watercolor canvas
 * with cold-press paper texture and warm storybook finishing.
 */
export async function renderRedrawnSvgToWatercolorCanvas(svgMarkup: string): Promise<string> {
  const blob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not render redrawn illustration.'));
      el.src = blobUrl;
    });

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
    ctx.filter = 'blur(4px) saturate(1.18)';
    ctx.drawImage(img, 0, 0, width, height);
    ctx.restore();

    applyCottonPaperFinish(ctx, width, height, { glazeOpacity: 0.14, borderOpacity: 0.45 });

    return canvas.toDataURL('image/jpeg', 0.9);
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
  settings: ImageFrameSettings
): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Failed to load image for resizing.'));
    el.src = sourceDataUrl;
  });

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

  return canvas.toDataURL('image/jpeg', 0.9);
}

