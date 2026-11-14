import { SkinAnalysisObservation } from '../types/assistant';
import { formatSpokenTime } from '../utils/accessibility';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

const MAX_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 55000;

let activeAnalysisInFlight = false;

export type SkinAnalysisClientResult =
  | { ok: true; observation: SkinAnalysisObservation }
  | { ok: false; error: string; code: string };

export function parseAndValidateDataUrl(dataUrl: string):
  | { valid: true; mimeType: string; base64: string; byteLength: number }
  | { valid: false; error: string; code: string } {
  const match = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) {
    return {
      valid: false,
      code: 'INVALID_FORMAT',
      error: 'The captured photograph format could not be read. Please retake the photo.',
    };
  }

  let mimeType = match[1].toLowerCase();
  if (mimeType === 'image/jpg') mimeType = 'image/jpeg';

  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return {
      valid: false,
      code: 'UNSUPPORTED_FORMAT',
      error: 'Unsupported image format. Please capture a JPEG, PNG, or WebP photograph.',
    };
  }

  const base64 = match[2].replace(/\s+/g, '');
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const byteLength = Math.floor((base64.length * 3) / 4) - padding;

  if (byteLength < 128) {
    return {
      valid: false,
      code: 'IMAGE_TOO_SMALL',
      error: 'The captured image appears empty. Please retake the photograph.',
    };
  }

  if (byteLength > MAX_BYTES) {
    return {
      valid: false,
      code: 'IMAGE_TOO_LARGE',
      error: 'The photograph exceeds the 5 megabyte limit. Please capture a smaller image.',
    };
  }

  return {
    valid: true,
    mimeType,
    base64,
    byteLength,
  };
}

export async function requestSkinObservation(
  dataUrl: string
): Promise<SkinAnalysisClientResult> {
  if (activeAnalysisInFlight) {
    return {
      ok: false,
      code: 'DUPLICATE_REQUEST',
      error: 'Analysis is already in progress. Please wait for the current check to finish.',
    };
  }

  const parsed = parseAndValidateDataUrl(dataUrl);
  if (!parsed.valid) {
    return { ok: false, error: parsed.error, code: parsed.code };
  }

  activeAnalysisInFlight = true;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch('/api/analyze-skin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        imageBase64: parsed.base64,
        mimeType: parsed.mimeType,
      }),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => null)) as {
      analysis?: Omit<SkinAnalysisObservation, 'analyzedAt'>;
      error?: string;
      code?: string;
    } | null;

    if (!response.ok || !payload?.analysis) {
      return {
        ok: false,
        code: payload?.code || `HTTP_${response.status}`,
        error:
          payload?.error ||
          'Skin photograph analysis could not be completed right now. No observations were generated.',
      };
    }

    return {
      ok: true,
      observation: {
        ...payload.analysis,
        analyzedAt: formatSpokenTime(),
      },
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return {
        ok: false,
        code: 'TIMEOUT',
        error:
          'The analysis request timed out waiting for a server response. Please check your connection and try again.',
      };
    }
    return {
      ok: false,
      code: 'NETWORK_ERROR',
      error:
        'Could not connect to the Glow-A-Eye observation service. Check your internet connection and try again.',
    };
  } finally {
    activeAnalysisInFlight = false;
    window.clearTimeout(timeoutId);
  }
}

export function formatFullObservationSpeech(obs: SkinAnalysisObservation): string {
  if (!obs.showsSkin || !obs.imageQualitySufficient) {
    return `${obs.safetyDisclaimer} Quality note: ${obs.qualityAssessment} What I can observe: ${obs.whatICanObserve} Recommended next steps: ${obs.recommendedNextSteps} You can say "Retake" to capture a clearer photograph.`;
  }

  const traits =
    obs.observableCharacteristics.length > 0
      ? ` Visible traits noted: ${obs.observableCharacteristics.join(', ')}.`
      : '';

  return `${obs.safetyDisclaimer} What I can observe: ${obs.whatICanObserve}${traits} Apparent location: ${obs.apparentLocation}. What it might indicate: ${obs.whatItMightIndicate} What I cannot determine: ${obs.whatICannotDetermine} Recommended next steps: ${obs.recommendedNextSteps} You can say "Repeat the observations", "Explain that in simpler terms", "What could be causing this?", or "What should I do next?".`;
}

export function formatObservationsOnlySpeech(obs: SkinAnalysisObservation): string {
  const traits =
    obs.observableCharacteristics.length > 0
      ? ` Observable traits: ${obs.observableCharacteristics.join(', ')}.`
      : '';
  return `What I can observe: ${obs.whatICanObserve}${traits} Apparent location: ${obs.apparentLocation}. Quality note: ${obs.qualityAssessment}`;
}

export function formatSimplerSpeech(obs: SkinAnalysisObservation): string {
  return `In simpler terms: ${obs.simplerSummary} Remember, this is not a medical diagnosis.`;
}

export function formatCausesSpeech(obs: SkinAnalysisObservation): string {
  return `What it might indicate: ${obs.whatItMightIndicate} What I cannot determine: ${obs.whatICannotDetermine}`;
}

export function formatNextStepsSpeech(obs: SkinAnalysisObservation): string {
  return `Recommended next steps: ${obs.recommendedNextSteps}`;
}
