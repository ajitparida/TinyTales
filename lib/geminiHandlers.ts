import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

interface ScanPageInput {
  imageBase64: string;
  mimeType: string;
}

const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Add GEMINI_API_KEY in AI Studio Settings > Secrets (or Vercel Project Settings > Environment Variables).'
    );
  }
  return new GoogleGenAI({
    apiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function getGeminiErrorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status;
  return typeof status === 'number' ? status : undefined;
}

function isGeminiQuotaError(err: unknown): boolean {
  const status = getGeminiErrorStatus(err);
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return (
    status === 429 ||
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.toLowerCase().includes('quota')
  );
}

function isGeminiAuthError(err: unknown): boolean {
  const status = getGeminiErrorStatus(err);
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return (
    status === 401 ||
    status === 403 ||
    msg.includes('API_KEY_INVALID') ||
    msg.includes('PERMISSION_DENIED') ||
    msg.includes('API key not valid')
  );
}

function parseRetryAfterSeconds(err: unknown, fallbackSeconds = 30): number {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const retryMatch = msg.match(/"retryDelay"\s*:\s*"(\d+)s"/i);
  if (retryMatch) return Math.max(5, Number(retryMatch[1]));
  const inMatch = msg.match(/retry in\s+(\d+(?:\.\d+)?)s/i);
  if (inMatch) return Math.max(5, Math.ceil(Number(inMatch[1])));
  return fallbackSeconds;
}

/**
 * Retries a Gemini call once on transient 5xx / network hiccups while failing fast
 * on 429 quota limits or 400/401/403 errors so free-tier RPM is never wasted.
 */
async function callGeminiWithSingleRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const status = getGeminiErrorStatus(err);
    const isTransient =
      !isGeminiQuotaError(err) &&
      !isGeminiAuthError(err) &&
      (status === 500 || status === 502 || status === 503 || status === 504 || status === undefined);
    if (!isTransient) {
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
    return await fn();
  }
}

/**
 * Strictly sanitizes AI-generated SVG artwork so only safe, Safari/Chrome-compatible
 * vector drawing primitives remain (no scripts, event handlers, filters, external refs, or text).
 */
export function sanitizeIllustrationSvg(rawSvg: string): string | null {
  const startIdx = rawSvg.indexOf('<svg');
  const endIdx = rawSvg.lastIndexOf('</svg>');
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }

  let svg = rawSvg.slice(startIdx, endIdx + 6);

  svg = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?>/gi, '')
    .replace(/<filter[\s\S]*?<\/filter>/gi, '')
    .replace(/<feImage[\s\S]*?(?:\/>|<\/feImage>)/gi, '')
    .replace(/<image[\s\S]*?(?:\/>|<\/image>)/gi, '')
    .replace(/<text[\s\S]*?<\/text>/gi, '')
    .replace(/<tspan[\s\S]*?<\/tspan>/gi, '')
    .replace(/\sfilter\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(
      /(?:href|xlink:href)\s*=\s*(?:"(?:javascript:|data:|https?:)[^"]*"|'(?:javascript:|data:|https?:)[^']*')/gi,
      ''
    )
    .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;');

  svg = svg.replace(/<svg\b([^>]*)>/i, (_match, attrs: string) => {
    let cleanAttrs = attrs;
    if (!/\bxmlns\s*=/i.test(cleanAttrs)) {
      cleanAttrs += ' xmlns="http://www.w3.org/2000/svg"';
    }
    if (!/\bviewBox\s*=/i.test(cleanAttrs)) {
      cleanAttrs += ' viewBox="0 0 800 600"';
    }
    if (!/\bwidth\s*=/i.test(cleanAttrs)) {
      cleanAttrs += ' width="800"';
    }
    if (!/\bheight\s*=/i.test(cleanAttrs)) {
      cleanAttrs += ' height="600"';
    }
    return `<svg${cleanAttrs}>`;
  });

  const primitiveCount = (
    svg.match(/<(?:path|circle|ellipse|rect|polygon|polyline)\b/gi) || []
  ).length;
  return svg.length >= 160 && primitiveCount >= 3 ? svg : null;
}

/**
 * Shared handler for POST /api/stories/scan (used by both Express server.ts and Vercel /api).
 */
export async function handleScanStoryRequest(rawBody: unknown): Promise<HandlerResult> {
  try {
    const body = (rawBody && typeof rawBody === 'object' ? rawBody : {}) as {
      pages?: ScanPageInput[];
      ageGroup?: '2-3' | '4-5';
      titleHint?: string;
      textMode?: 'verbatim' | 'simplified';
      autoSplitPages?: boolean;
      maxPages?: number;
    };

    const { pages, ageGroup, titleHint, textMode, autoSplitPages, maxPages } = body;

    if (!Array.isArray(pages) || pages.length === 0 || pages.length > 6) {
      return {
        status: 400,
        body: {
          error: 'Please provide between 1 and 6 storybook page photos to convert.',
        },
      };
    }

    const targetAge = ageGroup === '4-5' ? '4-5' : '2-3';
    const resolvedTextMode = textMode === 'simplified' ? 'simplified' : 'verbatim';
    const shouldAutoSplit = autoSplitPages !== false;
    const requestedMax =
      typeof maxPages === 'number' && Number.isFinite(maxPages) ? Math.round(maxPages) : 10;
    const resolvedMaxPages = Math.max(pages.length, Math.min(10, requestedMax));

    const contentParts: Array<
      { inlineData: { mimeType: string; data: string } } | { text: string }
    > = [];

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (
        !page ||
        typeof page.imageBase64 !== 'string' ||
        page.imageBase64.length < 32 ||
        !ALLOWED_IMAGE_MIME.has(page.mimeType)
      ) {
        return {
          status: 400,
          body: {
            error: `Page ${i + 1} has an invalid or unsupported image format.`,
          },
        };
      }
      const cleanedBase64 = page.imageBase64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
      contentParts.push({
        text: `Uploaded Photo ${i + 1} (sourcePhotoIndex = ${i}):`,
      });
      contentParts.push({
        inlineData: {
          mimeType: page.mimeType === 'image/jpg' ? 'image/jpeg' : page.mimeType,
          data: cleanedBase64,
        },
      });
    }

    const textExtractionGuidance =
      resolvedTextMode === 'verbatim'
        ? [
            'CRITICAL OCR & TRANSCRIPTION RULE: Carefully inspect every region of the uploaded photo(s)—including slightly tilted pages, curved book spines, small or stylized storybook fonts, text printed over colored/illustrated backgrounds, and tall mobile screenshots.',
            'Transcribe EVERY SINGLE STORY WORD, SENTENCE, DIALOGUE LINE, AND PARAGRAPH faithfully, word-for-word, in natural reading order (top-to-bottom, left-to-right; if a two-page open spread is photographed, read the left page completely first, then the right page completely).',
            'DO NOT summarize, DO NOT shorten, DO NOT paraphrase, and DO NOT skip lines. Preserve punctuation and dialogue quotes faithfully.',
            'Ignore phone status bars, battery/clock icons, browser buttons, isolated page numbers, or copyright/publisher footers. NEVER output placeholder text like "Tap Play to listen". Only write gentle original picture narration if a photo literally contains ZERO printed story words.',
          ].join('\n')
        : targetAge === '2-3'
          ? 'Read ALL printed story text carefully and adapt it into short, gentle toddler narration (1-2 rhythmic, easy-to-follow sentences per page) for ages 2 to 3.'
          : 'Read ALL printed story text carefully and adapt it into warm 2-3 sentence picture-book narration with vivid imagery for ages 4 to 5.';

    const pageSplitGuidance = shouldAutoSplit
      ? [
          `MULTI-PAGE AUTO-SPLIT RULE: There are ${pages.length} uploaded photo(s), and you may return between ${pages.length} and ${resolvedMaxPages} storybook pages total (NEVER more than ${resolvedMaxPages} pages).`,
          targetAge === '2-3'
            ? 'If an uploaded photo or screenshot contains more than 2-3 sentences or multiple paragraphs, split its story text cleanly across multiple consecutive storybook pages (about 1-3 short, easy-to-read sentences per page) so a toddler can enjoy each moment without a crowded wall of text.'
            : 'If an uploaded photo or screenshot contains more than 3-4 sentences or multiple paragraphs, split its story text cleanly across multiple consecutive storybook pages (about 2-4 crisp, easy-to-read sentences per page) so a young reader can follow comfortably.',
          'When splitting in verbatim mode, concatenating the text of all split pages from a photo MUST preserve 100% of the printed story sentences in exact order without dropping or rewriting words.',
          `For every returned page object, set sourcePhotoIndex to the 0-based index (0 to ${pages.length - 1}) of the uploaded photo it came from.`,
        ].join('\n')
      : `ONE-PHOTO-PER-PAGE RULE: There are ${pages.length} uploaded photo(s). Return exactly ${pages.length} entries in the pages array, matching sourcePhotoIndex 0 through ${pages.length - 1} in order.`;

    contentParts.push({
      text: [
        "You are an accurate children's picture book OCR digitizer converting photographed storybook pages or mobile screenshots into a structured digital storybook.",
        pageSplitGuidance,
        textExtractionGuidance,
        titleHint ? `Parent title suggestion: "${String(titleHint).slice(0, 100)}".` : '',
        'For EACH returned page, write a concise, vivid sceneSummary (1-2 sentences describing the exact characters, colors, clothing, action, setting, and mood) and choose the closest matching suggestedBackdrop from: meadow, cottage, forest, pond, brook, bridge, twilight, starlight.',
        'Set hasIllustration to true if its source photo actually contains a storybook picture/artwork/drawing, or false if the source photo is mostly plain text/screenshot without an illustration.',
        'ARTWORK EXTRACTION RULE: If hasIllustration is true AND the source photo shows an illustration alongside text blocks, page margins, table edges, or phone borders, ALWAYS provide artCropBox as [ymin, xmin, ymax, xmax] integers in 0..1000 coordinates tightly framing ONLY the illustration/picture region (excluding printed text blocks, table background, and phone UI). Only return [] if the entire photo is already a full-bleed illustration with no text margins.',
        'For each page, include 2 playful character/object tap hotspots (x and y percentages between 20 and 80, short dialogue under 10 words, reaction: bounce, wiggle, or sparkle).',
        `At the end, craft a warm positive moral for ages ${targetAge} (moralTitle, moralLesson, parentDiscussionPrompt).`,
      ]
        .filter(Boolean)
        .join('\n'),
    });

    const scanResponseSchema = {
      type: Type.OBJECT,
      properties: {
        title: {
          type: Type.STRING,
          description: 'Storybook title (max 80 characters)',
        },
        subtitle: {
          type: Type.STRING,
          description: 'Short cozy one-sentence summary (max 140 characters)',
        },
        moralTitle: {
          type: Type.STRING,
          description: 'Short value name like Kindness, Courage, or Sharing (max 40 characters)',
        },
        moralLesson: {
          type: Type.STRING,
          description: 'Warm 1-2 sentence moral lesson for a young child (max 280 characters)',
        },
        parentDiscussionPrompt: {
          type: Type.STRING,
          description:
            'Gentle question a parent can ask their child after reading (max 180 characters)',
        },
        suggestedBackdrop: {
          type: Type.STRING,
          description: 'One of: meadow, cottage, forest, pond, brook, bridge, twilight, starlight',
        },
        pages: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              sourcePhotoIndex: {
                type: Type.INTEGER,
                description: '0-based index of the uploaded photo this page came from',
              },
              text: {
                type: Type.STRING,
                description:
                  'Readable story text for this page (preserving every printed word across split pages in verbatim mode)',
              },
              sceneSummary: {
                type: Type.STRING,
                description:
                  'Concise vivid visual description of the characters, action, and setting for this page',
              },
              suggestedBackdrop: {
                type: Type.STRING,
                description:
                  'Best matching watercolor backdrop for this page: meadow, cottage, forest, pond, brook, bridge, twilight, or starlight',
              },
              hasIllustration: {
                type: Type.BOOLEAN,
                description:
                  'True if the source photo contains real storybook artwork; false if it is plain text or a text-only screenshot',
              },
              artCropBox: {
                type: Type.ARRAY,
                items: { type: Type.INTEGER },
                description:
                  'Optional [ymin, xmin, ymax, xmax] in 0..1000 coordinates tightly framing the illustration when separated from text margins, or []',
              },
              hotspots: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    x: { type: Type.NUMBER },
                    y: { type: Type.NUMBER },
                    dialogue: { type: Type.STRING },
                    reaction: { type: Type.STRING },
                  },
                  required: ['name', 'x', 'y', 'dialogue', 'reaction'],
                },
              },
            },
            required: [
              'sourcePhotoIndex',
              'text',
              'sceneSummary',
              'suggestedBackdrop',
              'hasIllustration',
              'hotspots',
            ],
          },
        },
      },
      required: [
        'title',
        'subtitle',
        'moralTitle',
        'moralLesson',
        'parentDiscussionPrompt',
        'suggestedBackdrop',
        'pages',
      ],
    };

    const ai = getGeminiClient();
    const response = await callGeminiWithSingleRetry(async () => {
      try {
        return await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: { parts: contentParts },
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: 'application/json',
            responseSchema: scanResponseSchema,
          },
        });
      } catch (primaryErr) {
        if (isGeminiQuotaError(primaryErr) || isGeminiAuthError(primaryErr)) {
          throw primaryErr;
        }
        console.warn(
          'Primary scan model failed, falling back to gemini-3.1-flash-lite:',
          primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
        );
        return await ai.models.generateContent({
          model: 'gemini-3.1-flash-lite',
          contents: { parts: contentParts },
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
            responseMimeType: 'application/json',
            responseSchema: scanResponseSchema,
          },
        });
      }
    });

    const rawText = (response.text ?? '').trim();
    if (!rawText) {
      return {
        status: 502,
        body: {
          error: 'Could not read text from the storybook photo. Please try a clearer image.',
        },
      };
    }

    const cleanedJson = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleanedJson) as Record<string, unknown>;
    } catch {
      return {
        status: 502,
        body: {
          error:
            'Storybook scan returned an unreadable response. Please try again with a clearer photo.',
        },
      };
    }

    if (Array.isArray(parsed.pages) && parsed.pages.length > resolvedMaxPages) {
      parsed.pages = parsed.pages.slice(0, resolvedMaxPages);
    }
    return { status: 200, body: parsed };
  } catch (err: unknown) {
    if (isGeminiAuthError(err)) {
      console.error('Gemini scan auth error (401/403).');
      return {
        status: 401,
        body: {
          code: 'AUTH_ERROR',
          error:
            'Gemini API key is missing or invalid. Please check GEMINI_API_KEY in Settings > Secrets (or Vercel Environment Variables).',
        },
      };
    }
    if (isGeminiQuotaError(err)) {
      const retryAfterSeconds = parseRetryAfterSeconds(err, 30);
      console.warn('Gemini scan quota/rate limit reached (429 RESOURCE_EXHAUSTED).');
      return {
        status: 429,
        body: {
          code: 'QUOTA_EXCEEDED',
          retryAfterSeconds,
          error: `Free-tier AI scan rate limit reached. Please wait about ${retryAfterSeconds}s and try again, or continue manually with your photos.`,
        },
      };
    }
    const message = err instanceof Error ? err.message : 'Storybook conversion failed.';
    console.error('Error in /api/stories/scan:', message);
    return { status: 500, body: { error: message } };
  }
}

/**
 * Shared handler for POST /api/stories/redraw (used by both Express server.ts and Vercel /api).
 */
export async function handleRedrawStoryRequest(rawBody: unknown): Promise<HandlerResult> {
  try {
    const body = (rawBody && typeof rawBody === 'object' ? rawBody : {}) as {
      imageBase64?: string;
      mimeType?: string;
      sceneSummary?: string;
      pageText?: string;
      artStyle?: 'watercolor' | 'pastel' | 'gouache';
      pageNumber?: number;
      totalPages?: number;
    };

    const { imageBase64, mimeType, sceneSummary, pageText, artStyle, pageNumber, totalPages } =
      body;

    const hasReferencePhoto =
      typeof imageBase64 === 'string' &&
      imageBase64.length >= 32 &&
      typeof mimeType === 'string' &&
      ALLOWED_IMAGE_MIME.has(mimeType);

    const safeScene = typeof sceneSummary === 'string' ? sceneSummary.trim().slice(0, 320) : '';
    const safePageText = typeof pageText === 'string' ? pageText.trim().slice(0, 420) : '';

    if (!hasReferencePhoto && !safeScene && !safePageText) {
      return {
        status: 400,
        body: {
          error: 'Please provide a page photo or story text to illustrate.',
        },
      };
    }

    const stylePalette =
      artStyle === 'pastel'
        ? 'Soft dreamy pastel picture-book palette (blush peach, buttercream yellow, powder sky blue, sage mint, soft lavender shadows) with gentle rounded shapes.'
        : artStyle === 'gouache'
          ? "Rich woodland gouache children's book palette (warm ochre, terracotta, forest pine, golden amber sunlight, cozy cream highlights) with expressive painterly layering."
          : 'Warm Beatrix-Potter-inspired watercolor picture-book palette (soft golden sunlight, meadow sage, warm honey, sky cerulean, dusty rose) with translucent layered washes and delicate soft strokes.';

    const parts: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }> = [];

    if (hasReferencePhoto && imageBase64 && mimeType) {
      const cleanedBase64 = imageBase64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
      parts.push({
        inlineData: {
          mimeType: mimeType === 'image/jpg' ? 'image/jpeg' : mimeType,
          data: cleanedBase64,
        },
      });
    }

    const pagePosNote =
      typeof pageNumber === 'number' && typeof totalPages === 'number' && totalPages > 1
        ? `This is Page ${pageNumber} of ${totalPages} in a multi-page book—make its composition, camera framing, and action distinct for THIS exact story moment.`
        : '';

    parts.push({
      text: [
        "You are an award-winning children's picture-book illustrator in the tradition of Beatrix Potter and classic cold-press watercolor storybooks.",
        hasReferencePhoto
          ? 'Use the uploaded photo above for character appearance, colors, and world inspiration, and PAINT a lush, charming, full-bleed SVG picture-book spread depicting the story moment below with viewBox="0 0 800 600".'
          : 'Paint a lush, charming, full-bleed SVG picture-book spread depicting the story moment below with viewBox="0 0 800 600".',
        pagePosNote,
        safeScene ? `Scene visual brief: ${safeScene}` : '',
        safePageText ? `Story text for this page: ${safePageText}` : '',
        `Art palette: ${stylePalette}`,
        'ARTISTIC COMPOSITION & SVG RULES:',
        '1. Output ONLY valid, well-formed XML <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600">...</svg> markup with no markdown fences, no XML comments, and no extra commentary.',
        '2. NEVER include <text>, <tspan>, <filter>, <feGaussianBlur>, <image>, letters, words, speech bubbles, page numbers, UI chrome, or picture frames.',
        '3. Create rich storybook depth using 30 to 48 organic, hand-crafted SVG elements (cubic bezier <path> curves, <circle>, and soft <ellipse> shapes, avoiding stiff boxy rectangles):',
        '   - <defs> with 4-6 harmonious <linearGradient> / <radialGradient> definitions (sunlit sky, glowing sun/moon halo, layered hills/meadow or cozy room lighting, water/path reflections). Use layered semi-transparent shapes (fill-opacity="0.25" to "0.75") for soft watercolor clouds, light shafts, and pigment blooms instead of SVG filters.',
        '   - Distinct background, midground, and foreground layers (distant hills/trees or cozy cottage walls, winding path/pond/furniture, foreground botanical leaves, wildflowers, grass tufts, or twinkling fireflies).',
        '   - Lovingly illustrated main character(s) faithfully matching the colors and spirit of the reference image and acting out THIS exact page moment with warm organic proportions, gentle shadows underneath, expressive sparkling eyes, rosy cheeks, and soft warm sepia ink contours (#4A3B31, stroke-linecap="round", stroke-opacity="0.7").',
      ]
        .filter(Boolean)
        .join('\n'),
    });

    const ai = getGeminiClient();
    const generateSvgWithModel = async (useFallbackModel: boolean): Promise<string | null> => {
      const response = await ai.models.generateContent({
        model: useFallbackModel ? 'gemini-3.1-flash-lite' : 'gemini-4-hydrogen',
        contents: { parts },
        config: {
          thinkingConfig: {
            thinkingLevel: useFallbackModel ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW,
          },
        },
      });
      const rawText = (response.text ?? '').trim();
      return rawText ? sanitizeIllustrationSvg(rawText) : null;
    };

    let sanitizedSvg: string | null = null;
    try {
      sanitizedSvg = await callGeminiWithSingleRetry(() => generateSvgWithModel(false));
    } catch (primaryErr) {
      if (isGeminiQuotaError(primaryErr) || isGeminiAuthError(primaryErr)) {
        throw primaryErr;
      }
      console.warn(
        'Primary redraw model failed, trying gemini-3.1-flash-lite:',
        primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
      );
    }

    if (!sanitizedSvg) {
      sanitizedSvg = await generateSvgWithModel(true);
    }

    if (!sanitizedSvg) {
      return {
        status: 502,
        body: {
          error: 'Could not generate a clean storybook illustration. Please tap Retry.',
        },
      };
    }

    const styleLabel =
      artStyle === 'pastel'
        ? 'Soft Pastel'
        : artStyle === 'gouache'
          ? 'Woodland Gouache'
          : 'Warm Watercolor';

    return {
      status: 200,
      body: {
        svg: sanitizedSvg,
        styleNote: `Illustrated in ${styleLabel} storybook style.`,
      },
    };
  } catch (err: unknown) {
    if (isGeminiAuthError(err)) {
      console.error('Gemini redraw auth error (401/403).');
      return {
        status: 401,
        body: {
          code: 'AUTH_ERROR',
          error:
            'Gemini API key is missing or invalid. Please check GEMINI_API_KEY in Settings > Secrets (or Vercel Environment Variables).',
        },
      };
    }
    if (isGeminiQuotaError(err)) {
      const retryAfterSeconds = parseRetryAfterSeconds(err, 30);
      console.warn('Gemini redraw quota/rate limit reached (429 RESOURCE_EXHAUSTED).');
      return {
        status: 429,
        body: {
          code: 'QUOTA_EXCEEDED',
          retryAfterSeconds,
          error: `Free-tier AI illustration limit reached. Wait ~${retryAfterSeconds}s to retry, or switch this page to a built-in Painterly Scene or Watercolor Photo instantaneously.`,
        },
      };
    }
    const message = err instanceof Error ? err.message : 'Illustration generation failed.';
    console.error('Error in /api/stories/redraw:', message);
    return { status: 500, body: { error: message } };
  }
}

/**
 * Shared handler for POST /api/tts/narrate (used by both Express server.ts and Vercel /api).
 */
export async function handleTtsNarrateRequest(rawBody: unknown): Promise<HandlerResult> {
  try {
    const body = (rawBody && typeof rawBody === 'object' ? rawBody : {}) as {
      text?: string;
      mode?: 'daytime' | 'bedtime' | 'character';
      voiceName?: string;
      voicePersona?: 'warm' | 'lullaby' | 'playful' | 'fireside' | 'adventure';
      characterName?: string;
    };

    const { text, mode, voiceName, voicePersona, characterName } = body;

    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed || trimmed.length > 3500) {
      return {
        status: 400,
        body: { error: 'Narration text must be between 1 and 3500 characters.' },
      };
    }

    const personaMap: Record<
      string,
      { voice: string; daytimeStyle: string; bedtimeStyle: string }
    > = {
      warm: {
        voice: 'Kore',
        daytimeStyle:
          "Warm, affectionate, expressive children's picture-book storyteller reading clearly to a young child",
        bedtimeStyle:
          'Warm, very soft, unhurried bedtime storyteller speaking gently to help a young child drift to sleep',
      },
      lullaby: {
        voice: 'Zephyr',
        daytimeStyle:
          'Gentle, soothing, melodic storybook narrator with calm comforting warmth for toddlers',
        bedtimeStyle:
          'Soft, whisper-gentle bedtime lullaby storyteller with a slow, peaceful, dreamy cadence',
      },
      playful: {
        voice: 'Puck',
        daytimeStyle:
          'Cheerful, lively, friendly meadow storyteller full of gentle wonder and smiles for kids',
        bedtimeStyle:
          'Friendly, hushed, cozy storyteller winding down playfully at bedtime with soft warmth',
      },
      fireside: {
        voice: 'Charon',
        daytimeStyle:
          'Calm, reassuring, cozy fireside grandfather storyteller with rich, gentle warmth and clear diction',
        bedtimeStyle:
          'Deep, peaceful, slow bedtime fireside storyteller speaking softly and soothingly',
      },
      adventure: {
        voice: 'Fenrir',
        daytimeStyle:
          'Expressive, enthusiastic woodland adventure storyteller with warm storybook charm',
        bedtimeStyle:
          'Calm, gentle, comforting evening storyteller with warm hushed wonder',
      },
    };

    const allowedVoices = new Set(['Kore', 'Puck', 'Zephyr', 'Charon', 'Fenrir']);
    const persona = (voicePersona && personaMap[voicePersona]) || personaMap.warm;

    let selectedVoice = persona.voice;
    let stylePrompt = mode === 'bedtime' ? persona.bedtimeStyle : persona.daytimeStyle;

    if (mode === 'character') {
      const lowerChar = (characterName || '').toLowerCase();
      if (
        lowerChar.includes('badger') ||
        lowerChar.includes('owl') ||
        lowerChar.includes('bear')
      ) {
        selectedVoice = 'Charon';
        stylePrompt =
          'Warm, kind, gentle woodland storybook friend speaking a brief cheerful greeting to a young child';
      } else if (
        lowerChar.includes('luma') ||
        lowerChar.includes('moon') ||
        lowerChar.includes('lily')
      ) {
        selectedVoice = 'Zephyr';
        stylePrompt =
          'Soft, sparkling, gentle fairy-tale creature speaking softly and warmly to a young child';
      } else {
        selectedVoice = 'Puck';
        stylePrompt =
          'Playful, cheerful, adorable little storybook animal friend speaking briefly and happily to a toddler';
      }
    } else if (voiceName && allowedVoices.has(voiceName)) {
      selectedVoice = voiceName;
    }

    const ai = getGeminiClient();
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash-lite-tts',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: trimmed,
              speechMetadata: {
                style: stylePrompt,
              },
            },
          ],
        },
      ],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: selectedVoice },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!base64Audio) {
      return { status: 502, body: { error: 'Voice narration returned empty audio.' } };
    }

    return {
      status: 200,
      body: {
        audioBase64: base64Audio,
        mimeType: 'audio/wav',
      },
    };
  } catch (err: unknown) {
    const rawMessage = err instanceof Error ? err.message : String(err ?? '');
    if (isGeminiQuotaError(err)) {
      const retryAfterSeconds = parseRetryAfterSeconds(err, 3600);
      console.warn('Gemini TTS quota reached (429 RESOURCE_EXHAUSTED).');
      return {
        status: 429,
        body: {
          code: 'QUOTA_EXCEEDED',
          retryAfterSeconds,
          error:
            'Daily AI voice limit reached on the free plan. You can switch to the built-in device voice for unlimited instant narration.',
        },
      };
    }

    console.error('Error in /api/tts/narrate:', rawMessage);
    return {
      status: 500,
      body: {
        code: 'TTS_UNAVAILABLE',
        error:
          'AI voice narration is temporarily unavailable. You can use the built-in device voice instead.',
      },
    };
  }
}
