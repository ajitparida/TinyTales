import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Please check your key in Settings > Secrets.'
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

/**
 * Strictly sanitizes AI-generated SVG artwork so only safe vector drawing primitives
 * remain (no scripts, event handlers, external references, or printed text overlays).
 */
function sanitizeIllustrationSvg(rawSvg: string): string | null {
  const startIdx = rawSvg.indexOf('<svg');
  const endIdx = rawSvg.lastIndexOf('</svg>');
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }

  let svg = rawSvg.slice(startIdx, endIdx + 6);

  // Remove dangerous elements and any unwanted text/image overlays
  svg = svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?>/gi, '')
    .replace(/<image[\s\S]*?(?:\/>|<\/image>)/gi, '')
    .replace(/<text[\s\S]*?<\/text>/gi, '')
    .replace(/<tspan[\s\S]*?<\/tspan>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(?:href|xlink:href)\s*=\s*(?:"(?:javascript:|data:|https?:)[^"]*"|'(?:javascript:|data:|https?:)[^']*')/gi, '');

  // Ensure standard xmlns and 4:3 viewBox on opening <svg> tag
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

  return svg.length >= 120 ? svg : null;
}

async function startServer() {
  const app = express();

  app.use(express.json({ limit: '30mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'meadowtale' });
  });

  /**
   * POST /api/stories/scan
   * Extracts printed text & scene details from 1-6 photographed storybook pages or screenshots,
   * optionally auto-splitting dense text into short, readable kid-friendly pages (up to 10 total),
   * generating per-page visual scene descriptions, interactive character tap hotspots,
   * and crafting a meaningful end-of-story moral.
   */
  app.post('/api/stories/scan', async (req, res) => {
    try {
      const { pages, ageGroup, titleHint, textMode, autoSplitPages, maxPages } = req.body as {
        pages?: ScanPageInput[];
        ageGroup?: '2-3' | '4-5';
        titleHint?: string;
        textMode?: 'verbatim' | 'simplified';
        autoSplitPages?: boolean;
        maxPages?: number;
      };

      if (!Array.isArray(pages) || pages.length === 0 || pages.length > 6) {
        res.status(400).json({
          error: 'Please provide between 1 and 6 storybook page photos to convert.',
        });
        return;
      }

      const targetAge = ageGroup === '4-5' ? '4-5' : '2-3';
      const resolvedTextMode = textMode === 'simplified' ? 'simplified' : 'verbatim';
      const shouldAutoSplit = autoSplitPages !== false;
      const requestedMax =
        typeof maxPages === 'number' && Number.isFinite(maxPages)
          ? Math.round(maxPages)
          : 10;
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
          res.status(400).json({
            error: `Page ${i + 1} has an invalid or unsupported image format.`,
          });
          return;
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
              'CRITICAL TRANSCRIPTION RULE: Transcribe EVERY SINGLE STORY WORD, SENTENCE, DIALOGUE LINE, AND PARAGRAPH printed in the uploaded photo(s) faithfully, word-for-word, in natural reading order (top-to-bottom, left-to-right; if a two-page open spread is photographed, read the left page completely first, then the right page completely).',
              'DO NOT summarize, DO NOT shorten, DO NOT paraphrase, and DO NOT skip lines. Preserve punctuation and dialogue quotes faithfully.',
              'Ignore phone status bars, battery/clock icons, browser buttons, isolated page numbers, or copyright/publisher footers. Only write original scene narration if a photo literally contains ZERO printed story words.',
            ].join('\n')
          : targetAge === '2-3'
            ? 'Read the printed text and adapt it into short, gentle toddler narration (1-2 rhythmic, easy-to-follow sentences per page) for ages 2 to 3.'
            : 'Read the printed text and adapt it into warm 2-3 sentence picture-book narration with vivid imagery for ages 4 to 5.';

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
          'You are a careful children\'s picture book digitizer converting photographed physical storybook pages or mobile screenshots into an interactive multi-page digital storybook.',
          pageSplitGuidance,
          textExtractionGuidance,
          titleHint ? `Parent title suggestion: "${String(titleHint).slice(0, 100)}".` : '',
          'For EACH returned page (including every split page), write a UNIQUE, vivid, specific visual sceneSummary describing the exact story moment on THAT page (characters, actions, expressions, clothing, props, setting, colors, lighting) so a dedicated matching watercolor illustration can be painted specifically for that page.',
          'For each page, also identify 2 playful interactive character or object tap hotspots located visibly inside the scene (x and y as percentages between 20 and 80), with a friendly character name, short playful spoken line (under 10 words), and reaction style (bounce, wiggle, or sparkle).',
          `At the end of the story, craft a clear, heartwarming positive moral tailored for ages ${targetAge} (e.g., Kindness, Sharing, Courage, Patience, Honesty) with a concise moral title, a 1-2 sentence child-friendly lesson, and a short parent-child talk-together question.`,
        ]
          .filter(Boolean)
          .join('\n'),
      });

      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: { parts: contentParts },
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
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
                description: 'Gentle question a parent can ask their child after reading (max 180 characters)',
              },
              suggestedBackdrop: {
                type: Type.STRING,
                description: 'One of: pond, forest, twilight, bridge',
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
                        'Unique, vivid visual description of the characters, actions, colors, and setting specifically for this page',
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
                  required: ['sourcePhotoIndex', 'text', 'sceneSummary', 'hotspots'],
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
          },
        },
      });

      const rawText = (response.text ?? '').trim();
      if (!rawText) {
        res.status(502).json({
          error: 'Could not read text from the storybook photo. Please try a clearer image.',
        });
        return;
      }

      const cleanedJson = rawText
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(cleanedJson) as Record<string, unknown>;
      } catch {
        res.status(502).json({
          error: 'Storybook scan returned an unreadable response. Please try again with a clearer photo.',
        });
        return;
      }

      if (Array.isArray(parsed.pages) && parsed.pages.length > resolvedMaxPages) {
        parsed.pages = parsed.pages.slice(0, resolvedMaxPages);
      }
      res.json(parsed);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Storybook conversion failed.';
      console.error('Error in /api/stories/scan:', message);
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/stories/redraw
   * Generates or redraws a clean, glare-free, text-free children's picture-book illustration
   * (layered painterly SVG finished on watercolor canvas). Supports both photo-referenced
   * redraws AND pure text/scene-driven generation for split or newly added storybook pages.
   */
  app.post('/api/stories/redraw', async (req, res) => {
    try {
      const { imageBase64, mimeType, sceneSummary, pageText, artStyle, pageNumber, totalPages } =
        req.body as {
          imageBase64?: string;
          mimeType?: string;
          sceneSummary?: string;
          pageText?: string;
          artStyle?: 'watercolor' | 'pastel' | 'gouache';
          pageNumber?: number;
          totalPages?: number;
        };

      const hasReferencePhoto =
        typeof imageBase64 === 'string' &&
        imageBase64.length >= 32 &&
        typeof mimeType === 'string' &&
        ALLOWED_IMAGE_MIME.has(mimeType);

      const safeScene = typeof sceneSummary === 'string' ? sceneSummary.trim().slice(0, 320) : '';
      const safePageText = typeof pageText === 'string' ? pageText.trim().slice(0, 420) : '';

      if (!hasReferencePhoto && !safeScene && !safePageText) {
        res.status(400).json({
          error: 'Please provide a page photo or story text to illustrate.',
        });
        return;
      }

      const stylePalette =
        artStyle === 'pastel'
          ? 'Soft dreamy pastel picture-book palette (blush peach, buttercream yellow, powder sky blue, sage mint, soft lavender shadows) with gentle rounded shapes.'
          : artStyle === 'gouache'
            ? 'Rich woodland gouache children\'s book palette (warm ochre, terracotta, forest pine, golden amber sunlight, cozy cream highlights) with expressive painterly layering.'
            : 'Warm Beatrix-Potter-inspired watercolor picture-book palette (soft golden sunlight, meadow sage, warm honey, sky cerulean, dusty rose) with translucent layered washes and delicate soft strokes.';

      const parts: Array<
        { inlineData: { mimeType: string; data: string } } | { text: string }
      > = [];

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
          'You are a warm children\'s picture-book illustrator.',
          hasReferencePhoto
            ? 'Use the uploaded photo above as visual character/world inspiration, and PAINT a fresh, clean, full-bleed SVG picture-book illustration specifically depicting the story moment below with viewBox="0 0 800 600".'
            : 'Paint a fresh, warm, charming, full-bleed SVG picture-book illustration specifically depicting the story moment below with viewBox="0 0 800 600".',
          pagePosNote,
          safeScene ? `Scene visual brief: ${safeScene}` : '',
          safePageText ? `Story text for this page: ${safePageText}` : '',
          `Art palette: ${stylePalette}`,
          'STRICT RULES:',
          '1. Output ONLY the raw <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600">...</svg> markup with no markdown fences and no extra explanation.',
          '2. NEVER include <text>, <tspan>, letters, words, speech bubbles, page numbers, phone UI, book creases, hands, or borders.',
          '3. Keep the SVG concise and expressive (22 to 38 clean layered shapes total, using simple rounded integer coordinates): include 2-3 <defs> gradients (warm sky/backdrop + ground), rolling hills/trees/clouds or cozy room interior, lovingly detailed main characters acting out THIS page\'s moment (expressive eyes, rosy cheeks, clear silhouette, grounded shadow, soft #4A3B31 strokes), and charming foreground details (flowers, leaves, stars, or cozy props).',
        ]
          .filter(Boolean)
          .join('\n'),
      });

      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: { parts },
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        },
      });

      const rawText = (response.text ?? '').trim();
      if (!rawText) {
        res.status(502).json({ error: 'Illustration generator returned an empty response.' });
        return;
      }

      const sanitizedSvg = sanitizeIllustrationSvg(rawText);
      if (!sanitizedSvg) {
        res.status(502).json({
          error: 'Could not generate a clean storybook illustration. Please try again.',
        });
        return;
      }

      const styleLabel =
        artStyle === 'pastel'
          ? 'Soft Pastel'
          : artStyle === 'gouache'
            ? 'Woodland Gouache'
            : 'Warm Watercolor';

      res.json({
        svg: sanitizedSvg,
        styleNote: `Illustrated in ${styleLabel} picture-book style.`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Illustration generation failed.';
      console.error('Error in /api/stories/redraw:', message);
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/tts/narrate
   * Synthesizes expressive daytime, bedtime, or interactive character narration
   * via gemini-3.8-flash-lite-tts across 5 prebuilt voices.
   * Returns complete unary WAV audio as base64.
   */
  app.post('/api/tts/narrate', async (req, res) => {
    try {
      const { text, mode, voiceName, voicePersona, characterName } = req.body as {
        text?: string;
        mode?: 'daytime' | 'bedtime' | 'character';
        voiceName?: string;
        voicePersona?: 'warm' | 'lullaby' | 'playful' | 'fireside' | 'adventure';
        characterName?: string;
      };

      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!trimmed || trimmed.length > 3500) {
        res.status(400).json({ error: 'Narration text must be between 1 and 3500 characters.' });
        return;
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
      let stylePrompt =
        mode === 'bedtime' ? persona.bedtimeStyle : persona.daytimeStyle;

      if (mode === 'character') {
        const lowerChar = (characterName || '').toLowerCase();
        if (lowerChar.includes('badger') || lowerChar.includes('owl') || lowerChar.includes('bear')) {
          selectedVoice = 'Charon';
          stylePrompt =
            'Warm, kind, gentle woodland storybook friend speaking a brief cheerful greeting to a young child';
        } else if (lowerChar.includes('luma') || lowerChar.includes('moon') || lowerChar.includes('lily')) {
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

      const base64Audio =
        response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

      if (!base64Audio) {
        res.status(502).json({ error: 'Voice narration returned empty audio.' });
        return;
      }

      res.json({
        audioBase64: base64Audio,
        mimeType: 'audio/wav',
      });
    } catch (err: unknown) {
      const rawMessage = err instanceof Error ? err.message : String(err ?? '');
      const status =
        typeof (err as { status?: unknown })?.status === 'number'
          ? (err as { status: number }).status
          : undefined;
      const isQuota =
        status === 429 ||
        rawMessage.includes('429') ||
        rawMessage.includes('RESOURCE_EXHAUSTED') ||
        rawMessage.toLowerCase().includes('quota');

      if (isQuota) {
        const retryMatch = rawMessage.match(/"retryDelay"\s*:\s*"(\d+)s"/i);
        const retryAfterSeconds = retryMatch ? Number(retryMatch[1]) : 3600;
        console.warn('Gemini TTS quota reached (429 RESOURCE_EXHAUSTED).');
        res.status(429).json({
          code: 'QUOTA_EXCEEDED',
          retryAfterSeconds,
          error:
            'Daily AI voice limit reached on the free plan. You can switch to the built-in device voice for unlimited instant narration.',
        });
        return;
      }

      console.error('Error in /api/tts/narrate:', rawMessage);
      res.status(500).json({
        code: 'TTS_UNAVAILABLE',
        error: 'AI voice narration is temporarily unavailable. You can use the built-in device voice instead.',
      });
    }
  });

  // Ensure unmatched /api/* endpoints always return JSON rather than Vite/SPA index.html
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  // Express JSON error middleware so body-parser 413/400 errors never return HTML
  app.use(
    (
      err: { status?: number; statusCode?: number; type?: string; message?: string },
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (!req.path.startsWith('/api')) {
        next(err);
        return;
      }
      const status = err.status || err.statusCode || 500;
      if (err.type === 'entity.too.large' || status === 413) {
        res.status(413).json({
          error: 'The uploaded photos are too large to scan all at once. Try scanning 1–3 photos at a time.',
        });
        return;
      }
      if (err.type === 'entity.parse.failed' || status === 400) {
        res.status(400).json({ error: 'Invalid request payload sent to server.' });
        return;
      }
      res.status(status).json({
        error: err.message || 'Server error while handling API request.',
      });
    }
  );

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Meadowtale server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Meadowtale server:', err);
  process.exit(1);
});
