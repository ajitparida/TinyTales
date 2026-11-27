import type { IncomingMessage, ServerResponse } from 'http';
import { handleTtsNarrateRequest } from '../../lib/geminiHandlers.ts';

interface VercelRequest extends IncomingMessage {
  body?: unknown;
}

interface VercelResponse extends ServerResponse {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      res.status(400).json({ error: 'Invalid JSON request payload.' });
      return;
    }
  }

  const result = await handleTtsNarrateRequest(body);
  res.status(result.status).json(result.body);
}
