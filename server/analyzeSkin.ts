import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

export interface AnalyzedSkinPayload {
  imageQualitySufficient: boolean;
  showsSkin: boolean;
  qualityAssessment: string;
  apparentLocation: string;
  observableCharacteristics: string[];
  whatICanObserve: string;
  whatItMightIndicate: string;
  whatICannotDetermine: string;
  recommendedNextSteps: string;
  simplerSummary: string;
  safetyDisclaimer: string;
}

export interface AnalyzeSkinRequestBody {
  imageBase64?: unknown;
  mimeType?: unknown;
}

export interface AnalyzeSkinValidationResult {
  valid: boolean;
  status?: number;
  code?: string;
  error?: string;
  mimeType?: string;
  cleanBase64?: string;
  byteLength?: number;
}

const GEMINI_MODEL = 'gemini-4-hydrogen';
const FALLBACK_GEMINI_MODEL = 'gemini-3.1-flash-lite';
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const MIN_IMAGE_BYTES = 128;
const PER_ATTEMPT_TIMEOUT_MS = 28000;
const RETRY_BUDGET_CUTOFF_MS = 18000;

const SYSTEM_INSTRUCTION = `You are Glow-A-Eye, an accessibility-first skin observation assistant designed for blind and visually impaired users.
Your role is to examine a user-submitted photograph and describe visible skin characteristics clearly, calmly, and honestly for spoken audio playback.

STRICT SAFETY AND ACCURACY RULES:
1. Never diagnose a skin condition or claim certainty about what a condition is.
2. Never claim to detect cancer or rule out cancer (including melanoma) from a photograph.
3. Never prescribe, dose, or recommend antibiotics, antifungals, steroids, or other prescription/medicated treatments.
4. Never invent or guess visual findings. Describe ONLY what is genuinely observable in the photograph.
5. If the photograph does not show human skin, or is too blurry, dark, overexposed, or unclear for useful visual observations, set "showsSkin" and/or "imageQualitySufficient" to false, explain honestly why the image cannot be reliably observed, keep "observableCharacteristics" empty or minimal, and advise taking another clear photograph.
6. Frame any possible explanations strictly as possibilities ("might indicate", "could be consistent with", "one possibility is"), never diagnoses.
7. Clearly state what cannot be determined from a static 2D photograph (such as texture depth, warmth, tenderness, duration, underlying infection/cause, or clinical diagnosis).
8. Recommend appropriate professional evaluation by a doctor, pharmacist, or dermatologist, and advise prompt medical care if there are concerning symptoms like rapid spreading, severe pain, fever, pus, or bleeding.
9. Keep language concise, plain, respectful, and natural when read aloud by a screen reader or text-to-speech voice.`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    imageQualitySufficient: {
      type: Type.BOOLEAN,
      description:
        'True only if clarity, lighting, and framing allow useful visual observation of skin.',
    },
    showsSkin: {
      type: Type.BOOLEAN,
      description: 'True if human skin is clearly visible as the subject of the photograph.',
    },
    qualityAssessment: {
      type: Type.STRING,
      description:
        'Brief honest note about photograph clarity, focus, lighting, and skin visibility.',
    },
    apparentLocation: {
      type: Type.STRING,
      description:
        'Apparent body area if identifiable (e.g., forearm, hand, cheek), or "Not clearly identifiable from this close-up photograph".',
    },
    observableCharacteristics: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        'Only genuinely visible traits such as redness, raised bumps, dryness, scaling, swelling, discoloration, or irregular borders. Empty array if not visible or unclear.',
    },
    whatICanObserve: {
      type: Type.STRING,
      description:
        'Clear plain-language description of what is visibly present (or why the image is unclear / does not show skin).',
    },
    whatItMightIndicate: {
      type: Type.STRING,
      description:
        'Cautious, non-diagnostic possibilities clearly framed as possibilities rather than diagnoses, or guidance to retake if image is unclear.',
    },
    whatICannotDetermine: {
      type: Type.STRING,
      description:
        'What cannot reliably be determined from a photograph alone, including diagnosis, underlying cause, or ruling out serious conditions.',
    },
    recommendedNextSteps: {
      type: Type.STRING,
      description:
        'Safe, practical next steps including seeking professional medical assessment and warning signs that warrant prompt care.',
    },
    simplerSummary: {
      type: Type.STRING,
      description:
        'A shorter, everyday plain-English summary (2-4 sentences) suitable for "Explain that in simpler terms."',
    },
    safetyDisclaimer: {
      type: Type.STRING,
      description:
        'Clear statement that this observation is informational only and is not a medical diagnosis.',
    },
  },
  required: [
    'imageQualitySufficient',
    'showsSkin',
    'qualityAssessment',
    'apparentLocation',
    'observableCharacteristics',
    'whatICanObserve',
    'whatItMightIndicate',
    'whatICannotDetermine',
    'recommendedNextSteps',
    'simplerSummary',
    'safetyDisclaimer',
  ],
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${timeoutMs}ms`);
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

export function validateAnalyzeSkinInput(
  body: AnalyzeSkinRequestBody
): AnalyzeSkinValidationResult {
  if (!body || typeof body !== 'object') {
    return {
      valid: false,
      status: 400,
      code: 'INVALID_BODY',
      error: 'Request body must be a JSON object containing an image.',
    };
  }

  const rawMime = typeof body.mimeType === 'string' ? body.mimeType.trim().toLowerCase() : '';
  const rawImage = typeof body.imageBase64 === 'string' ? body.imageBase64.trim() : '';

  if (!rawImage) {
    return {
      valid: false,
      status: 400,
      code: 'MISSING_IMAGE',
      error: 'No photograph was provided for analysis.',
    };
  }

  let mimeType = rawMime;
  let cleanBase64 = rawImage;

  const dataUrlMatch = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/s.exec(rawImage);
  if (dataUrlMatch) {
    mimeType = mimeType || dataUrlMatch[1].toLowerCase();
    cleanBase64 = dataUrlMatch[2].replace(/\s+/g, '');
  } else {
    cleanBase64 = rawImage.replace(/\s+/g, '');
  }

  if (mimeType === 'image/jpg') {
    mimeType = 'image/jpeg';
  }

  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return {
      valid: false,
      status: 400,
      code: 'UNSUPPORTED_FORMAT',
      error:
        'Unsupported image format. Please provide a JPEG, PNG, or WebP photograph.',
    };
  }

  if (!/^[A-Za-z0-9+/=]+$/.test(cleanBase64)) {
    return {
      valid: false,
      status: 400,
      code: 'INVALID_BASE64',
      error: 'The submitted image data is not valid base64.',
    };
  }

  const decodedBuffer = Buffer.from(cleanBase64, 'base64');
  if (decodedBuffer.byteLength < MIN_IMAGE_BYTES) {
    return {
      valid: false,
      status: 400,
      code: 'IMAGE_TOO_SMALL',
      error: 'The captured photograph appears empty or corrupted. Please retake it.',
    };
  }

  if (decodedBuffer.byteLength > MAX_IMAGE_BYTES) {
    return {
      valid: false,
      status: 413,
      code: 'IMAGE_TOO_LARGE',
      error:
        'The photograph exceeds the 5 megabyte size limit. Please capture a smaller image.',
    };
  }

  return {
    valid: true,
    mimeType,
    cleanBase64,
    byteLength: decodedBuffer.byteLength,
  };
}

function isQuotaOrRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  const status = (err as { status?: number })?.status;
  return (
    status === 429 ||
    msg.includes('429') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota')
  );
}

function isDailyQuotaExhaustedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes('perday') ||
    msg.includes('requests per day') ||
    msg.includes('exceeded your current quota') ||
    msg.includes('free_tier_requests')
  );
}

function isTransientError(err: unknown): boolean {
  if (isDailyQuotaExhaustedError(err)) {
    return false;
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  const status = (err as { status?: number })?.status;
  const code = (err as { code?: string })?.code;
  return (
    code === 'GEMINI_TIMEOUT' ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('econnreset')
  );
}

function mapGeminiError(err: unknown): { status: number; code: string; error: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  const rawStatus = (err as { status?: number })?.status;
  const rawCode = (err as { code?: string })?.code;

  if (
    rawCode === 'GEMINI_TIMEOUT' ||
    rawStatus === 504 ||
    lower.includes('timed out') ||
    lower.includes('deadline_exceeded')
  ) {
    return {
      status: 504,
      code: 'GATEWAY_TIMEOUT',
      error:
        'The observation service took too long to respond for this photograph. Please try again or retake in even lighting.',
    };
  }

  if (isQuotaOrRateLimitError(err)) {
    return {
      status: 429,
      code: 'RATE_LIMITED',
      error: isDailyQuotaExhaustedError(err)
        ? 'The daily free-tier Gemini API quota has been reached. Please try again later, or select a billing-enabled API key in Settings > Secrets to increase your quota.'
        : 'The observation service is temporarily busy due to rate limits. Please wait a moment and try analyzing again.',
    };
  }

  if (
    rawStatus === 401 ||
    rawStatus === 403 ||
    lower.includes('api_key_invalid') ||
    lower.includes('permission_denied') ||
    lower.includes('api key not valid')
  ) {
    return {
      status: 503,
      code: 'API_KEY_INVALID',
      error:
        'The server-side Gemini API key is missing or invalid. Please check GEMINI_API_KEY in Settings > Secrets.',
    };
  }

  if (rawStatus === 404 || lower.includes('not_found')) {
    return {
      status: 502,
      code: 'MODEL_UNAVAILABLE',
      error:
        'The configured Gemini vision model could not be reached right now. Please try again shortly.',
    };
  }

  if (
    rawStatus === 400 ||
    lower.includes('invalid_argument') ||
    lower.includes('unable to process input image')
  ) {
    return {
      status: 400,
      code: 'INVALID_IMAGE_INPUT',
      error:
        'The photograph could not be decoded by the vision service. Please retake or choose another JPEG, PNG, or WebP photo.',
    };
  }

  if (lower.includes('fetch') || lower.includes('network') || lower.includes('enotfound')) {
    return {
      status: 502,
      code: 'NETWORK_ERROR',
      error:
        'Unable to reach the observation service because of a network error. Please check connectivity and try again.',
    };
  }

  return {
    status: 502,
    code: 'ANALYSIS_FAILED',
    error:
      'Skin photograph analysis could not be completed right now. No visual observations were generated. Please try again.',
  };
}

export interface AnalyzeSkinDeps {
  apiKey?: string;
  attemptTimeoutMs?: number;
  generateContentFn?: (params: {
    mimeType: string;
    cleanBase64: string;
    model: string;
  }) => Promise<string | undefined>;
}

/**
 * Text-only Gemini diagnostic probe to distinguish general API issues from image-specific issues.
 */
export async function runGeminiTextProbe(apiKeyOverride?: string): Promise<{
  ok: boolean;
  model: string;
  elapsedMs: number;
  responsePreview?: string;
  error?: string;
}> {
  const startedAt = Date.now();
  const apiKey = apiKeyOverride ?? process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return {
      ok: false,
      model: GEMINI_MODEL,
      elapsedMs: Date.now() - startedAt,
      error: 'GEMINI_API_KEY is missing.',
    };
  }

  const candidateModels = [GEMINI_MODEL, FALLBACK_GEMINI_MODEL];
  let lastProbeError: unknown = null;

  for (const model of candidateModels) {
    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
      });

      const response = await withTimeout(
        ai.models.generateContent({
          model,
          contents: 'Reply with "Glow-A-Eye text probe OK" and nothing else.',
          ...(model === GEMINI_MODEL
            ? { config: { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } }
            : {}),
        }),
        15000,
        'Gemini text probe'
      );

      return {
        ok: true,
        model,
        elapsedMs: Date.now() - startedAt,
        responsePreview: (response.text ?? '').trim().slice(0, 80),
      };
    } catch (err) {
      lastProbeError = err;
      if (!isQuotaOrRateLimitError(err)) {
        break;
      }
    }
  }

  const mapped = mapGeminiError(lastProbeError);
  return {
    ok: false,
    model: GEMINI_MODEL,
    elapsedMs: Date.now() - startedAt,
    error: `${mapped.code}: ${mapped.error}`,
  };
}

export async function analyzeSkinPhotograph(
  body: AnalyzeSkinRequestBody,
  deps: AnalyzeSkinDeps = {}
): Promise<
  | {
      ok: true;
      data: AnalyzedSkinPayload;
      diagnostics: { model: string; durationMs: number; sizeBytes: number; mimeType: string };
    }
  | { ok: false; status: number; code: string; error: string }
> {
  const requestStartMs = Date.now();
  const reqId = Math.random().toString(36).slice(2, 8);
  console.info(`[Glow-A-Eye][${reqId}] Request received for /api/analyze-skin`);

  const validation = validateAnalyzeSkinInput(body);
  if (
    !validation.valid ||
    !validation.mimeType ||
    !validation.cleanBase64 ||
    validation.byteLength === undefined
  ) {
    console.warn(
      `[Glow-A-Eye][${reqId}] Validation failed: code=${validation.code ?? 'INVALID_IMAGE'} durationMs=${Date.now() - requestStartMs}`
    );
    return {
      ok: false,
      status: validation.status ?? 400,
      code: validation.code ?? 'INVALID_IMAGE',
      error: validation.error ?? 'Invalid photograph submitted.',
    };
  }

  console.info(
    `[Glow-A-Eye][${reqId}] Image validation completed: mimeType=${validation.mimeType} sizeBytes=${validation.byteLength}`
  );

  const apiKey = deps.apiKey ?? process.env.GEMINI_API_KEY;
  if (!deps.generateContentFn && (!apiKey || apiKey === 'MY_GEMINI_API_KEY')) {
    console.error(`[Glow-A-Eye][${reqId}] Missing GEMINI_API_KEY on server`);
    return {
      ok: false,
      status: 503,
      code: 'API_KEY_MISSING',
      error:
        'Gemini observation service is not configured on the server (GEMINI_API_KEY is missing).',
    };
  }

  const attemptTimeoutMs = deps.attemptTimeoutMs ?? PER_ATTEMPT_TIMEOUT_MS;

  const callGemini =
    deps.generateContentFn ??
    (async ({ mimeType, cleanBase64, model }) => {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const response = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: cleanBase64,
              },
            },
            {
              text: 'Examine this photograph carefully for Glow-A-Eye. Report whether human skin is visible and whether image quality is sufficient. Describe only genuinely observable visual characteristics (such as redness, bumps, dryness, scaling, swelling, discoloration, or irregular borders if present), apparent body location if identifiable, cautious non-diagnostic possibilities, what cannot be determined from a photograph, safe next steps, and a simpler plain-language summary.',
            },
          ],
        },
        config: {
          ...(model === GEMINI_MODEL
            ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
            : {}),
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      });

      return response.text;
    });

  let lastError: unknown = null;
  let activeModel = GEMINI_MODEL;
  let usedModel = GEMINI_MODEL;
  let switchedToFallback = false;
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStartMs = Date.now();
    const modelForAttempt = activeModel;
    console.info(
      `[Glow-A-Eye][${reqId}] Gemini request started: model=${modelForAttempt} attempt=${attempt}`
    );

    try {
      const rawText = await withTimeout(
        callGemini({
          mimeType: validation.mimeType,
          cleanBase64: validation.cleanBase64,
          model: modelForAttempt,
        }),
        attemptTimeoutMs,
        'Gemini skin observation request'
      );

      usedModel = modelForAttempt;
      console.info(
        `[Glow-A-Eye][${reqId}] Gemini response received: model=${usedModel} attempt=${attempt} geminiMs=${Date.now() - attemptStartMs}`
      );

      if (!rawText || !rawText.trim()) {
        console.warn(
          `[Glow-A-Eye][${reqId}] Empty Gemini response totalMs=${Date.now() - requestStartMs}`
        );
        return {
          ok: false,
          status: 502,
          code: 'EMPTY_RESPONSE',
          error:
            'The observation service returned an empty response. Please try analyzing again.',
        };
      }

      const parsed = JSON.parse(rawText.trim()) as Partial<AnalyzedSkinPayload>;

      if (
        typeof parsed.whatICanObserve !== 'string' ||
        typeof parsed.whatItMightIndicate !== 'string' ||
        typeof parsed.whatICannotDetermine !== 'string' ||
        typeof parsed.recommendedNextSteps !== 'string'
      ) {
        console.warn(
          `[Glow-A-Eye][${reqId}] Malformed Gemini JSON payload totalMs=${Date.now() - requestStartMs}`
        );
        return {
          ok: false,
          status: 502,
          code: 'MALFORMED_RESPONSE',
          error:
            'The observation response was incomplete and could not be displayed safely. Please try again.',
        };
      }

      const normalized: AnalyzedSkinPayload = {
        imageQualitySufficient: Boolean(parsed.imageQualitySufficient),
        showsSkin: Boolean(parsed.showsSkin),
        qualityAssessment:
          typeof parsed.qualityAssessment === 'string' && parsed.qualityAssessment.trim()
            ? parsed.qualityAssessment.trim()
            : 'Image clarity could not be fully verified.',
        apparentLocation:
          typeof parsed.apparentLocation === 'string' && parsed.apparentLocation.trim()
            ? parsed.apparentLocation.trim()
            : 'Not clearly identifiable from this photograph.',
        observableCharacteristics: Array.isArray(parsed.observableCharacteristics)
          ? parsed.observableCharacteristics.filter(
              (item): item is string => typeof item === 'string' && item.trim().length > 0
            )
          : [],
        whatICanObserve: parsed.whatICanObserve.trim(),
        whatItMightIndicate: parsed.whatItMightIndicate.trim(),
        whatICannotDetermine: parsed.whatICannotDetermine.trim(),
        recommendedNextSteps: parsed.recommendedNextSteps.trim(),
        simplerSummary:
          typeof parsed.simplerSummary === 'string' && parsed.simplerSummary.trim()
            ? parsed.simplerSummary.trim()
            : `${parsed.whatICanObserve.trim()} ${parsed.recommendedNextSteps.trim()}`,
        safetyDisclaimer:
          typeof parsed.safetyDisclaimer === 'string' && parsed.safetyDisclaimer.trim()
            ? parsed.safetyDisclaimer.trim()
            : 'This observation is not a medical diagnosis. Please consult a qualified clinician for medical advice.',
      };

      const totalDurationMs = Date.now() - requestStartMs;
      console.info(
        `[Glow-A-Eye][${reqId}] Analysis succeeded: model=${usedModel} totalMs=${totalDurationMs} showsSkin=${normalized.showsSkin} qualitySufficient=${normalized.imageQualitySufficient}`
      );

      return {
        ok: true,
        data: normalized,
        diagnostics: {
          model: usedModel,
          durationMs: totalDurationMs,
          sizeBytes: validation.byteLength,
          mimeType: validation.mimeType,
        },
      };
    } catch (err) {
      lastError = err;
      const elapsedSoFar = Date.now() - requestStartMs;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[Glow-A-Eye][${reqId}] Gemini attempt=${attempt} (${modelForAttempt}) error after ${elapsedSoFar}ms: ${errMsg}`
      );

      if (attempt < maxAttempts && elapsedSoFar < RETRY_BUDGET_CUTOFF_MS) {
        if (isQuotaOrRateLimitError(err) && !switchedToFallback) {
          switchedToFallback = true;
          activeModel = FALLBACK_GEMINI_MODEL;
          console.info(
            `[Glow-A-Eye][${reqId}] Primary model quota/rate-limited; switching to fallback model=${FALLBACK_GEMINI_MODEL}`
          );
          continue;
        }
        if (isTransientError(err)) {
          await new Promise((resolve) => setTimeout(resolve, 650));
          continue;
        }
      }
      break;
    }
  }

  const mapped = mapGeminiError(lastError);
  console.error(
    `[Glow-A-Eye][${reqId}] Analysis failed: code=${mapped.code} status=${mapped.status} totalMs=${Date.now() - requestStartMs}`
  );
  return {
    ok: false,
    status: mapped.status,
    code: mapped.code,
    error: mapped.error,
  };
}
