import { GoogleGenAI, Type } from '@google/genai';

const PRIMARY_TRANSCRIBE_MODEL = 'gemini-4-hydrogen';
const FALLBACK_TRANSCRIBE_MODEL = 'gemini-3.1-flash-lite';

const ALLOWED_AUDIO_MIME_TYPES = new Set([
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/aac',
]);

const MIN_AUDIO_BYTES = 256;
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 7000;

export interface TranscribeRequestBody {
  audioBase64?: unknown;
  mimeType?: unknown;
}

export interface TranscribeValidationResult {
  valid: boolean;
  status?: number;
  code?: string;
  error?: string;
  mimeType?: string;
  cleanBase64?: string;
  byteLength?: number;
}

export interface TranscribeDependencies {
  apiKey?: string;
  attemptTimeoutMs?: number;
  generateContentFn?: (params: {
    model: string;
    mimeType: string;
    base64: string;
  }) => Promise<string>;
}

export type TranscribeResult =
  | {
      ok: true;
      transcript: string;
      model: string;
      durationMs: number;
    }
  | {
      ok: false;
      status: number;
      code: string;
      error: string;
    };

const TRANSCRIBE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    transcript: {
      type: Type.STRING,
      description:
        'Exact verbatim words spoken by the user in the clip, or empty string if only noise/silence is heard.',
    },
  },
  required: ['transcript'],
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`Audio transcription timed out after ${timeoutMs}ms`);
      (err as { code?: string; status?: number }).code = 'GEMINI_TIMEOUT';
      (err as { code?: string; status?: number }).status = 504;
      reject(err);
    }, timeoutMs);

    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export function validateTranscribeInput(
  body: TranscribeRequestBody
): TranscribeValidationResult {
  if (!body || typeof body !== 'object') {
    return {
      valid: false,
      status: 400,
      code: 'INVALID_BODY',
      error: 'Request body must be a JSON object containing audio data.',
    };
  }

  let mimeType =
    typeof body.mimeType === 'string'
      ? body.mimeType.trim().toLowerCase().split(';')[0]
      : 'audio/wav';
  if (mimeType === 'audio/wave' || mimeType === 'audio/x-wav') {
    mimeType = 'audio/wav';
  }

  if (!ALLOWED_AUDIO_MIME_TYPES.has(mimeType)) {
    return {
      valid: false,
      status: 400,
      code: 'UNSUPPORTED_AUDIO_FORMAT',
      error: 'Unsupported audio format for voice interruption transcription.',
    };
  }

  const rawAudio = typeof body.audioBase64 === 'string' ? body.audioBase64.trim() : '';
  if (!rawAudio) {
    return {
      valid: false,
      status: 400,
      code: 'MISSING_AUDIO',
      error: 'No audio clip was provided for transcription.',
    };
  }

  const dataUrlMatch = /^data:([a-zA-Z0-9/+.-]+)(?:;[^,]+)?;base64,(.+)$/s.exec(
    rawAudio
  );
  const cleanBase64 = (dataUrlMatch ? dataUrlMatch[2] : rawAudio).replace(/\s+/g, '');

  if (!/^[A-Za-z0-9+/=]+$/.test(cleanBase64)) {
    return {
      valid: false,
      status: 400,
      code: 'INVALID_BASE64',
      error: 'Submitted audio data is not valid base64.',
    };
  }

  const decoded = Buffer.from(cleanBase64, 'base64');
  if (decoded.byteLength < MIN_AUDIO_BYTES) {
    return {
      valid: false,
      status: 400,
      code: 'AUDIO_TOO_SMALL',
      error: 'Captured audio clip is too short to contain speech.',
    };
  }

  if (decoded.byteLength > MAX_AUDIO_BYTES) {
    return {
      valid: false,
      status: 413,
      code: 'AUDIO_TOO_LARGE',
      error: 'Audio clip exceeds the 4 megabyte size limit.',
    };
  }

  return {
    valid: true,
    mimeType,
    cleanBase64,
    byteLength: decoded.byteLength,
  };
}

function parseTranscriptPayload(rawText: string): string {
  const cleaned = rawText.trim();
  if (!cleaned) return '';

  try {
    const parsed = JSON.parse(cleaned) as { transcript?: unknown };
    if (typeof parsed.transcript === 'string') {
      return parsed.transcript.trim();
    }
  } catch {
    // Fall back cleanly if model returned plain text
  }

  const stripped = cleaned
    .replace(/^```json\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  if (stripped.startsWith('{')) {
    try {
      const parsed = JSON.parse(stripped) as { transcript?: unknown };
      if (typeof parsed.transcript === 'string') {
        return parsed.transcript.trim();
      }
    } catch {
      return '';
    }
  }
  return cleaned;
}

export async function transcribeInterruptionAudio(
  body: TranscribeRequestBody,
  deps: TranscribeDependencies = {}
): Promise<TranscribeResult> {
  const startedAt = Date.now();
  const validation = validateTranscribeInput(body);
  if (!validation.valid || !validation.cleanBase64 || !validation.mimeType) {
    return {
      ok: false,
      status: validation.status ?? 400,
      code: validation.code ?? 'INVALID_AUDIO',
      error: validation.error ?? 'Invalid audio clip.',
    };
  }

  // Guard against muted mics / flat zero buffers triggering hallucinated ASR transcripts
  if (validation.mimeType === 'audio/wav') {
    const wavBytes = Buffer.from(validation.cleanBase64, 'base64');
    if (
      wavBytes.byteLength > 44 &&
      wavBytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      wavBytes.subarray(8, 12).toString('ascii') === 'WAVE'
    ) {
      let peak = 0;
      for (let i = 44; i + 1 < wavBytes.byteLength; i += 2) {
        const sample = Math.abs(wavBytes.readInt16LE(i));
        if (sample > peak) peak = sample;
      }
      // Below ~0.003 normalized full-scale (-50 dBFS) contains no human speech
      if (peak < 100) {
        return {
          ok: true,
          transcript: '',
          model: 'silence-gate',
          durationMs: Date.now() - startedAt,
        };
      }
    }
  }

  const apiKey = deps.apiKey ?? process.env.GEMINI_API_KEY;
  if (
    !deps.generateContentFn &&
    (!apiKey || apiKey === 'MY_GEMINI_API_KEY')
  ) {
    return {
      ok: false,
      status: 500,
      code: 'API_KEY_MISSING',
      error: 'Server speech transcription service is not configured.',
    };
  }

  const timeoutMs = deps.attemptTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const invokeModel =
    deps.generateContentFn ??
    (async ({ model, mimeType, base64 }) => {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: 'Listen carefully to the audio clip and transcribe ONLY the exact spoken words that are clearly audible. Return JSON {"transcript": "..."}. If the audio contains only silence, static, background hum, breathing, or unintelligible noise with no clear human speech, return {"transcript": ""}. Never guess, complete, or invent words.',
              },
              {
                inlineData: {
                  mimeType,
                  data: base64,
                },
              },
            ],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: TRANSCRIBE_SCHEMA,
          temperature: 0,
        },
      });
      return response.text ?? '';
    });

  const models = [PRIMARY_TRANSCRIBE_MODEL, FALLBACK_TRANSCRIBE_MODEL];
  let lastErr: unknown = null;

  for (const model of models) {
    try {
      const rawText = await withTimeout(
        invokeModel({
          model,
          mimeType: validation.mimeType,
          base64: validation.cleanBase64,
        }),
        timeoutMs
      );
      const transcript = parseTranscriptPayload(rawText);
      return {
        ok: true,
        transcript,
        model,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      lastErr = err;
    }
  }

  const status = (lastErr as { status?: number })?.status;
  if (status === 504 || (lastErr as { code?: string })?.code === 'GEMINI_TIMEOUT') {
    return {
      ok: false,
      status: 504,
      code: 'GATEWAY_TIMEOUT',
      error: 'Interruption transcription timed out. Switching to live microphone.',
    };
  }

  if (status === 429) {
    return {
      ok: false,
      status: 429,
      code: 'RATE_LIMITED',
      error: 'Transcription service is temporarily busy. Switching to live microphone.',
    };
  }

  return {
    ok: false,
    status: 502,
    code: 'TRANSCRIPTION_FAILED',
    error: 'Could not transcribe interrupted audio clip. Switching to live microphone.',
  };
}
