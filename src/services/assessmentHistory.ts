import type {
  SavedAssessmentRecord,
  SkinAnalysisObservation,
  SkinAssessmentReport,
  SymptomAnswerRecord,
} from '../types/assistant.ts';

export const ASSESSMENT_HISTORY_STORAGE_KEY = 'glow_a_eye_assessment_history_v1';
const MAX_SAVED_RECORDS = 20;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getDefaultStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isValidSavedRecord(item: unknown): item is SavedAssessmentRecord {
  if (!item || typeof item !== 'object') return false;
  const r = item as Partial<SavedAssessmentRecord>;
  return (
    typeof r.id === 'string' &&
    typeof r.savedAtIso === 'string' &&
    typeof r.savedDateLabel === 'string' &&
    typeof r.urgencyLabel === 'string' &&
    typeof r.visualObservationsSummary === 'string' &&
    Array.isArray(r.reportedSymptoms) &&
    Boolean(r.recommendations) &&
    typeof r.recommendations?.medicalAssessmentRecommendation === 'string'
  );
}

export function loadAssessmentHistory(
  storage: StorageLike | null = getDefaultStorage()
): SavedAssessmentRecord[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(ASSESSMENT_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidSavedRecord);
  } catch {
    return [];
  }
}

export function buildSavedAssessmentRecord(params: {
  report: SkinAssessmentReport;
  observation: SkinAnalysisObservation | null;
  answers: SymptomAnswerRecord[];
  now?: Date;
}): SavedAssessmentRecord {
  const now = params.now ?? new Date();
  const savedDateLabel = now.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const reportedSymptoms = params.answers.map((a) => a.normalizedSummary);
  if (reportedSymptoms.length === 0) {
    reportedSymptoms.push('No specific symptom answers recorded.');
  }

  return {
    id: `assess-${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
    savedAtIso: now.toISOString(),
    savedDateLabel,
    urgencyLevel: params.report.urgencyLevel,
    urgencyLabel: params.report.urgencyLabel,
    actionHeadline: params.report.actionHeadline,
    apparentLocation: params.observation?.apparentLocation ?? 'Not specified',
    visualObservationsSummary: params.report.whatPhotographShows,
    reportedSymptoms,
    recommendations: {
      medicalAssessmentRecommendation: params.report.medicalAssessmentRecommendation,
      safeGeneralCare: params.report.safeGeneralCare,
      escalationWarningSigns: params.report.escalationWarningSigns,
    },
    triggeredWarningSigns: [...params.report.triggeredWarningSigns],
  };
}

export function saveAssessmentRecord(
  params: {
    consentGiven: boolean;
    report: SkinAssessmentReport;
    observation: SkinAnalysisObservation | null;
    answers: SymptomAnswerRecord[];
    now?: Date;
  },
  storage: StorageLike | null = getDefaultStorage()
):
  | { ok: true; record: SavedAssessmentRecord; records: SavedAssessmentRecord[] }
  | { ok: false; error: string } {
  if (!params.consentGiven) {
    return {
      ok: false,
      error:
        'Explicit consent is required before saving an assessment summary. Nothing was saved.',
    };
  }

  if (!storage) {
    return {
      ok: false,
      error:
        'On-device browser storage is unavailable right now, so this assessment could not be saved.',
    };
  }

  const record = buildSavedAssessmentRecord({
    report: params.report,
    observation: params.observation,
    answers: params.answers,
    now: params.now,
  });

  const existing = loadAssessmentHistory(storage);
  const next = [record, ...existing].slice(0, MAX_SAVED_RECORDS);

  try {
    storage.setItem(ASSESSMENT_HISTORY_STORAGE_KEY, JSON.stringify(next));
    return { ok: true, record, records: next };
  } catch {
    return {
      ok: false,
      error: 'Could not write to local device storage. Your browser storage may be full or restricted.',
    };
  }
}

export function deleteAssessmentRecord(
  id: string,
  storage: StorageLike | null = getDefaultStorage()
): SavedAssessmentRecord[] {
  const existing = loadAssessmentHistory(storage);
  const next = existing.filter((item) => item.id !== id);
  if (storage) {
    try {
      if (next.length === 0) {
        storage.removeItem(ASSESSMENT_HISTORY_STORAGE_KEY);
      } else {
        storage.setItem(ASSESSMENT_HISTORY_STORAGE_KEY, JSON.stringify(next));
      }
    } catch {
      // Ignore storage write errors
    }
  }
  return next;
}

export function clearAssessmentHistory(
  storage: StorageLike | null = getDefaultStorage()
): SavedAssessmentRecord[] {
  if (storage) {
    try {
      storage.removeItem(ASSESSMENT_HISTORY_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
  }
  return [];
}

export function formatRecordAloud(record: SavedAssessmentRecord, label = 'Saved assessment'): string {
  const symptomsText = record.reportedSymptoms.join('; ');
  const warnings =
    record.triggeredWarningSigns.length > 0
      ? ` Warning signs noted: ${record.triggeredWarningSigns.join('; ')}.`
      : '';
  return `${label} from ${record.savedDateLabel}. Classification: ${record.urgencyLabel}.${warnings} Apparent area: ${record.apparentLocation}. Visual observations: ${record.visualObservationsSummary} Reported symptoms: ${symptomsText}. Recommendations: ${record.recommendations.medicalAssessmentRecommendation} General care: ${record.recommendations.safeGeneralCare} Escalation signs: ${record.recommendations.escalationWarningSigns}`;
}

export function formatHistorySummarySpeech(records: SavedAssessmentRecord[]): string {
  if (records.length === 0) {
    return 'You have no saved assessments on this device. After completing a symptom assessment, you can give consent to save its text summary locally without storing any photograph.';
  }

  const latest = records[0];
  const countLine =
    records.length === 1
      ? 'You have 1 saved assessment on this device.'
      : `You have ${records.length} saved assessments on this device. Reading the most recent one.`;

  return `${countLine} ${formatRecordAloud(latest, 'Most recent assessment')}`;
}
