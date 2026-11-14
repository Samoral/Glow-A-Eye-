import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSkinPhotograph, runGeminiTextProbe } from './server/analyzeSkin.ts';
import { assessSkinSymptoms } from './server/assessSkinSymptoms.ts';
import { transcribeInterruptionAudio } from './server/transcribeInterruption.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '8mb' }));

  // Handle oversized JSON payload errors cleanly as JSON
  app.use(
    (
      err: { type?: string; status?: number },
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (err?.type === 'entity.too.large' || err?.status === 413) {
        res.status(413).json({
          code: 'PAYLOAD_TOO_LARGE',
          error:
            'The submitted photograph is too large for the server to process. Please capture a smaller image.',
        });
        return;
      }
      if (err instanceof SyntaxError) {
        res.status(400).json({
          code: 'INVALID_JSON',
          error: 'Invalid request format sent to the observation service.',
        });
        return;
      }
      next(err);
    }
  );

  app.get('/api/health', async (req, res) => {
    const geminiConfigured = Boolean(
      process.env.GEMINI_API_KEY &&
        process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
    );

    if (req.query.probe === 'text') {
      const probeResult = await runGeminiTextProbe();
      res.status(probeResult.ok ? 200 : 502).json({
        ok: probeResult.ok,
        service: 'glow-a-eye',
        geminiConfigured,
        textProbe: probeResult,
      });
      return;
    }

    res.json({
      ok: true,
      service: 'glow-a-eye',
      geminiConfigured,
    });
  });

  app.post('/api/analyze-skin', async (req, res) => {
    try {
      const result = await analyzeSkinPhotograph(req.body);
      if (!result.ok) {
        res.status(result.status).json({
          code: result.code,
          error: result.error,
        });
        return;
      }
      res.json({
        analysis: result.data,
        meta: {
          model: result.diagnostics.model,
          durationMs: result.diagnostics.durationMs,
          sizeBytes: result.diagnostics.sizeBytes,
          mimeType: result.diagnostics.mimeType,
        },
      });
    } catch {
      res.status(500).json({
        code: 'INTERNAL_ERROR',
        error: 'An unexpected error occurred while processing the skin observation request.',
      });
    }
  });

  app.post('/api/assess-symptoms', async (req, res) => {
    try {
      const result = await assessSkinSymptoms(req.body);
      if (!result.ok) {
        res.status(result.status).json({
          code: result.code,
          error: result.error,
        });
        return;
      }
      res.json({
        report: result.report,
        meta: result.meta,
      });
    } catch {
      res.status(500).json({
        code: 'INTERNAL_ERROR',
        error: 'An unexpected error occurred while running the symptom safety check.',
      });
    }
  });

  app.post('/api/transcribe-interruption', async (req, res) => {
    try {
      const result = await transcribeInterruptionAudio(req.body);
      if (!result.ok) {
        res.status(result.status).json({
          code: result.code,
          error: result.error,
        });
        return;
      }
      res.json({
        transcript: result.transcript,
        meta: {
          model: result.model,
          durationMs: result.durationMs,
        },
      });
    } catch {
      res.status(500).json({
        code: 'INTERNAL_ERROR',
        error: 'An unexpected error occurred while transcribing audio.',
      });
    }
  });

  return app;
}

async function startServer() {
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
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

  app.listen(port, '0.0.0.0', () => {
    console.log(`Glow-A-Eye server listening on http://0.0.0.0:${port}`);
  });
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isMainModule) {
  void startServer();
}
