import {
  SkinAnalysisObservation,
  SkinAssessmentReport,
  SymptomAnswerRecord,
} from '../types/assistant';
import {
  assessMedicalSafety,
  enforceSafetyOnReport,
} from '../../shared/medicalSafetyEngine';
import { buildFallbackStructuredDraft } from '../../shared/symptomQuestionEngine';

const ASSESSMENT_CLIENT_TIMEOUT_MS = 35000;

export async function requestSymptomAssessment(params: {
  observation: SkinAnalysisObservation | null;
  answers: SymptomAnswerRecord[];
}): Promise<{ report: SkinAssessmentReport; fromFallback: boolean }> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    ASSESSMENT_CLIENT_TIMEOUT_MS
  );

  try {
    const response = await fetch('/api/assess-symptoms', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        observation: params.observation,
        answers: params.answers,
      }),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => null)) as {
      report?: SkinAssessmentReport;
    } | null;

    if (response.ok && payload?.report) {
      return { report: payload.report, fromFallback: false };
    }
  } catch {
    // Fall through cleanly to local deterministic Medical Safety Engine fallback
  } finally {
    window.clearTimeout(timeoutId);
  }

  const safety = assessMedicalSafety(params.observation, params.answers);
  const draft = buildFallbackStructuredDraft(params.observation, params.answers, safety);
  const report = enforceSafetyOnReport(
    draft,
    safety,
    params.observation,
    params.answers
  );
  return { report, fromFallback: true };
}

export function formatFullAssessmentSpeech(report: SkinAssessmentReport): string {
  const warnings =
    report.triggeredWarningSigns.length > 0
      ? ` Safety warning signs noted: ${report.triggeredWarningSigns.join('; ')}.`
      : '';

  return `${report.urgencyLabel}. ${report.actionHeadline}${warnings} Here is your full summary. 1. What the photograph appears to show: ${report.whatPhotographShows} 2. What your answers indicate: ${report.whatAnswersIndicate} 3. Possible explanations: ${report.possibleExplanations} 4. Safe general care: ${report.safeGeneralCare} 5. What to avoid: ${report.whatToAvoid} 6. Medical assessment recommendation: ${report.medicalAssessmentRecommendation} 7. Warning signs that require escalation: ${report.escalationWarningSigns} ${report.educationalDisclaimer} You can ask me: "Why do you think that?", "What should I do now?", "Should I see a doctor?", "Explain it more simply", or "Repeat my assessment."`;
}

export function formatAssessmentWhySpeech(report: SkinAssessmentReport): string {
  return `Why I gave this guidance (${report.urgencyLabel}): ${report.whyExplanation} Remember, ${report.educationalDisclaimer}`;
}

export function formatAssessmentWhatNowSpeech(report: SkinAssessmentReport): string {
  return `What to do now (${report.urgencyLabel}): ${report.medicalAssessmentRecommendation} Safe general care: ${report.safeGeneralCare} What to avoid: ${report.whatToAvoid}`;
}

export function formatAssessmentDoctorSpeech(report: SkinAssessmentReport): string {
  return `${report.urgencyLabel}. ${report.medicalAssessmentRecommendation} Watch closely for escalation warning signs: ${report.escalationWarningSigns}`;
}

export function formatAssessmentSimplerSpeech(report: SkinAssessmentReport): string {
  return `In simpler terms: ${report.simplerSummary} ${report.educationalDisclaimer}`;
}
