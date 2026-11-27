import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
  handleRedrawStoryRequest,
  handleScanStoryRequest,
  handleTtsNarrateRequest,
} from './lib/geminiHandlers.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;

async function startServer() {
  const app = express();

  app.use(express.json({ limit: '30mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'meadowtale' });
  });

  /**
   * POST /api/stories/scan
   * Extracts printed text & scene details from 1-6 photographed storybook pages or screenshots,
   * optionally auto-splitting dense text into short, readable kid-friendly pages (up to 10 total).
   */
  app.post('/api/stories/scan', async (req, res) => {
    const result = await handleScanStoryRequest(req.body);
    res.status(result.status).json(result.body);
  });

  /**
   * POST /api/stories/redraw
   * Generates or redraws a clean, glare-free, text-free children's picture-book illustration.
   */
  app.post('/api/stories/redraw', async (req, res) => {
    const result = await handleRedrawStoryRequest(req.body);
    res.status(result.status).json(result.body);
  });

  /**
   * POST /api/tts/narrate
   * Synthesizes expressive daytime, bedtime, or interactive character narration via Gemini TTS.
   */
  app.post('/api/tts/narrate', async (req, res) => {
    const result = await handleTtsNarrateRequest(req.body);
    res.status(result.status).json(result.body);
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
          error:
            'The uploaded photos are too large to scan all at once. Try scanning 1–3 photos at a time.',
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

  let viteServer: { middlewares: express.RequestHandler; close: () => Promise<void> } | null = null;

  if (process.env.NODE_ENV !== 'production') {
    const viteReady = import('vite')
      .then(({ createServer: createViteServer }) =>
        createViteServer({
          server: { middlewareMode: true, hmr: false },
          appType: 'spa',
        })
      )
      .then((vite) => {
        viteServer = vite;
        return vite;
      });

    app.use((req, res, next) => {
      if (viteServer) {
        viteServer.middlewares(req, res, next);
        return;
      }
      viteReady
        .then((vite) => vite.middlewares(req, res, next))
        .catch(next);
    });

    // Warm up Vite middleware immediately in the background while port 3000 is already listening
    viteReady.catch((err) => {
      console.error('Failed to initialize Vite middleware:', err);
      process.exit(1);
    });
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Meadowtale server listening on http://0.0.0.0:${PORT}`);
  });

  const shutdown = () => {
    httpServer.close(() => {
      if (viteServer) {
        void viteServer.close().finally(() => process.exit(0));
      } else {
        process.exit(0);
      }
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer().catch((err) => {
  console.error('Failed to start Meadowtale server:', err);
  process.exit(1);
});
