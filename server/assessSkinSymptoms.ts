import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type {
  MedicalSafetyEvaluation,
  SkinAnalysisObservation,
  SkinAssessmentDraft,
  SkinAssessmentReport,
  SymptomAnswerRecord,
} from '../src/types/assistant.ts';
import {
  assessMedicalSafety,
  enforceSafetyOnReport,
} from '../shared/medicalSafetyEngine.ts';
import { buildFallbackStructuredDraft } from '../shared/symptomQuestionEngine.ts';

const GEMINI_MODEL = 'gemini-4-hydrogen';
const FALLBACK_GEMINI_MODEL = 'gemini-3.1-flash-lite';
const ASSESSMENT_TIMEOUT_MS = 24000;

export interface AssessSymptomsRequestBody {
  observation?: SkinAnalysisObservation | null;
  answers?: SymptomAnswerRecord[];
}

export interface AssessSymptomsDeps {
  apiKey?: string;
  attemptTimeoutMs?: number;
  generateDraftFn?: (params: {
    observation: SkinAnalysisObservation | null;
    answers: SymptomAnswerRecord[];
    safety: MedicalSafetyEvaluation;
  }) => Promise<SkinAssessmentDraft | null>;
}

const ASSESSMENT_SYSTEM_INSTRUCTION = `You are Glow-A-Eye, an accessibility-first educational skin guidance assistant for blind and visually impaired users.
Combine the visual photograph observations, user-reported symptom answers, duration/progression, and the mandatory Medical Safety Engine urgency classification into a clear, conversational structured report for spoken playback.

STRICT RULES:
1. NEVER claim to establish a definitive diagnosis from a photograph or conversation.
2. NEVER claim a skin lesion is benign or rule out cancer (including melanoma).
3. NEVER autonomously prescribe or recommend prescription antibiotics, antifungals, steroids, or prescription dosing.
4. NEVER recommend stopping any prescribed medication without professional medical advice.
5. NEVER invent missing answers. Anything marked "unknown", "skipped", or not asked MUST remain explicitly unknown.
6. NEVER dismiss or minimize user-reported symptoms because the photograph looks mild or normal.
7. Respect the Medical Safety Engine urgency level and warning signs provided in the prompt. If the urgency level is emergency or urgent, prioritize immediate or prompt same-day care rather than watchful waiting.
8. Speak warmly, clearly, and concisely in plain English suitable for text-to-speech.`;

const ASSESSMENT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    whatPhotographShows: {
      type: Type.STRING,
      description: '1. What the photograph appears to show (or its visual limitations).',
    },
    whatAnswersIndicate: {
      type: Type.STRING,
      description:
        '2. What the user answers indicate, explicitly noting any unknown or skipped items.',
    },
    possibleExplanations: {
      type: Type.STRING,
      description:
        '3. Possible non-diagnostic explanations with uncertainty clearly stated.',
    },
    safeGeneralCare: {
      type: Type.STRING,
      description:
        '4. Safe general skin care suggestions appropriate for the urgency level.',
    },
    whatToAvoid: {
      type: Type.STRING,
      description:
        '5. What the user should avoid (including unprescribed medicated creams and stopping prescribed meds without doctor advice).',
    },
    medicalAssessmentRecommendation: {
      type: Type.STRING,
      description:
        '6. Whether and how urgently professional medical assessment is recommended.',
    },
    escalationWarningSigns: {
      type: Type.STRING,
      description: '7. Specific warning signs that require urgent or emergency escalation.',
    },
    simplerSummary: {
      type: Type.STRING,
      description:
        'Short, everyday plain-English summary (2-4 sentences) for "Explain it more simply."',
    },
    whyExplanation: {
      type: Type.STRING,
      description:
        'Clear reasoning connecting the visual signs, reported answers, and urgency recommendation for "Why do you think that?"',
    },
  },
  required: [
    'whatPhotographShows',
    'whatAnswersIndicate',
    'possibleExplanations',
    'safeGeneralCare',
    'whatToAvoid',
    'medicalAssessmentRecommendation',
    'escalationWarningSigns',
    'simplerSummary',
    'whyExplanation',
  ],
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
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

const ALLOWED_QUESTION_IDS = new Set([
  'onset_duration',
  'sensory_symptoms',
  'progression_spreading',
  'surface_discharge',
  'recurrence_history',
  'new_exposures',
  'systemic_symptoms',
  'lesion_changes',
  'airway_allergy_check',
]);

const ALLOWED_ANSWER_STATUSES = new Set(['answered', 'unknown', 'skipped']);

export function validateAssessSymptomsInput(body: unknown):
  | { valid: true }
  | { valid: false; status: number; code: string; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      valid: false,
      status: 400,
      code: 'INVALID_BODY',
      error: 'Request body must be a JSON object.',
    };
  }

  const candidate = body as AssessSymptomsRequestBody;
  if (candidate.answers !== undefined) {
    if (!Array.isArray(candidate.answers)) {
      return {
        valid: false,
        status: 400,
        code: 'INVALID_ANSWERS',
        error: 'Symptom answers must be provided as an array.',
      };
    }
    if (candidate.answers.length > 30) {
      return {
        valid: false,
        status: 400,
        code: 'TOO_MANY_ANSWERS',
        error: 'Too many symptom answers were submitted.',
      };
    }
    for (const item of candidate.answers) {
      if (!item || typeof item !== 'object') {
        return {
          valid: false,
          status: 400,
          code: 'INVALID_ANSWER_ENTRY',
          error: 'Each symptom answer must be an object.',
        };
      }
      const entry = item as Partial<SymptomAnswerRecord>;
      if (
        typeof entry.questionId !== 'string' ||
        !ALLOWED_QUESTION_IDS.has(entry.questionId) ||
        typeof entry.status !== 'string' ||
        !ALLOWED_ANSWER_STATUSES.has(entry.status)
      ) {
        return {
          valid: false,
          status: 400,
          code: 'INVALID_ANSWER_FIELDS',
          error: 'Each symptom answer must include a valid questionId and status.',
        };
      }
    }
  }

  return { valid: true };
}

function sanitizeObservation(obs: unknown): SkinAnalysisObservation | null {
  if (!obs || typeof obs !== 'object') return null;
  const o = obs as Partial<SkinAnalysisObservation>;
  if (typeof o.whatICanObserve !== 'string') return null;
  return {
    imageQualitySufficient: Boolean(o.imageQualitySufficient),
    showsSkin: Boolean(o.showsSkin),
    qualityAssessment:
      typeof o.qualityAssessment === 'string' ? o.qualityAssessment.slice(0, 1000) : '',
    apparentLocation:
      typeof o.apparentLocation === 'string' ? o.apparentLocation.slice(0, 200) : 'Unknown',
    observableCharacteristics: Array.isArray(o.observableCharacteristics)
      ? o.observableCharacteristics
          .filter((x): x is string => typeof x === 'string')
          .slice(0, 20)
          .map((x) => x.slice(0, 200))
      : [],
    whatICanObserve: o.whatICanObserve.slice(0, 2500),
    whatItMightIndicate:
      typeof o.whatItMightIndicate === 'string' ? o.whatItMightIndicate.slice(0, 2500) : '',
    whatICannotDetermine:
      typeof o.whatICannotDetermine === 'string' ? o.whatICannotDetermine.slice(0, 2500) : '',
    recommendedNextSteps:
      typeof o.recommendedNextSteps === 'string' ? o.recommendedNextSteps.slice(0, 2500) : '',
    simplerSummary: typeof o.simplerSummary === 'string' ? o.simplerSummary.slice(0, 1500) : '',
    safetyDisclaimer:
      typeof o.safetyDisclaimer === 'string' ? o.safetyDisclaimer.slice(0, 1000) : '',
    analyzedAt: typeof o.analyzedAt === 'string' ? o.analyzedAt.slice(0, 64) : '',
  };
}

function sanitizeAnswers(raw: unknown): SymptomAnswerRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is SymptomAnswerRecord =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as SymptomAnswerRecord).questionId === 'string' &&
        ALLOWED_QUESTION_IDS.has((item as SymptomAnswerRecord).questionId) &&
        typeof (item as SymptomAnswerRecord).status === 'string' &&
        ALLOWED_ANSWER_STATUSES.has((item as SymptomAnswerRecord).status)
    )
    .slice(0, 30)
    .map((item) => ({
      ...item,
      rawAnswer: typeof item.rawAnswer === 'string' ? item.rawAnswer.slice(0, 1000) : '',
      questionPrompt:
        typeof item.questionPrompt === 'string' ? item.questionPrompt.slice(0, 500) : '',
      normalizedSummary:
        typeof item.normalizedSummary === 'string' ? item.normalizedSummary.slice(0, 1200) : '',
      extractedFacts:
        item.extractedFacts && typeof item.extractedFacts === 'object'
          ? item.extractedFacts
          : {},
      answeredAt: typeof item.answeredAt === 'string' ? item.answeredAt.slice(0, 64) : '',
    }));
}

export async function assessSkinSymptoms(
  body: AssessSymptomsRequestBody,
  deps: AssessSymptomsDeps = {}
): Promise<
  | {
      ok: true;
      report: SkinAssessmentReport;
      meta: {
        model: string;
        usedFallbackDraft: boolean;
        safetyOverrideApplied: boolean;
        durationMs: number;
      };
    }
  | {
      ok: false;
      status: number;
      code: string;
      error: string;
    }
> {
  const startedAt = Date.now();
  const reqId = Math.random().toString(36).slice(2, 8);

  const validation = validateAssessSymptomsInput(body);
  if (!validation.valid) {
    return {
      ok: false,
      status: validation.status,
      code: validation.code,
      error: validation.error,
    };
  }

  const observation = sanitizeObservation(body?.observation ?? null);
  const answers = sanitizeAnswers(body?.answers ?? []);

  // Step 1: Always run the separate deterministic Medical Safety Engine first
  const safety = assessMedicalSafety(observation, answers);
  console.info(
    `[Glow-A-Eye][${reqId}] Safety engine evaluated: urgency=${safety.urgencyLevel} answers=${answers.length} warnings=${safety.triggeredWarningSigns.length}`
  );

  let aiDraft: SkinAssessmentDraft | null = null;
  let usedFallbackDraft = false;
  let modelUsed = GEMINI_MODEL;

  const apiKey = deps.apiKey ?? process.env.GEMINI_API_KEY;
  const timeoutMs = deps.attemptTimeoutMs ?? ASSESSMENT_TIMEOUT_MS;

  if (deps.generateDraftFn) {
    try {
      aiDraft = await withTimeout(
        deps.generateDraftFn({ observation, answers, safety }),
        timeoutMs,
        'Symptom draft generator'
      );
    } catch (err) {
      console.warn(
        `[Glow-A-Eye][${reqId}] Custom draft generator failed, using deterministic safe draft: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  } else if (apiKey && apiKey !== 'MY_GEMINI_API_KEY') {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });

    const promptContext = JSON.stringify(
      {
        imageObservation: observation
          ? {
              showsSkin: observation.showsSkin,
              imageQualitySufficient: observation.imageQualitySufficient,
              apparentLocation: observation.apparentLocation,
              observableCharacteristics: observation.observableCharacteristics,
              whatICanObserve: observation.whatICanObserve,
              whatItMightIndicate: observation.whatItMightIndicate,
            }
          : null,
        userSymptomAnswers: answers.map((a) => ({
          topic: a.questionId,
          status: a.status,
          answer: a.status === 'answered' ? a.rawAnswer : a.status,
        })),
        medicalSafetyClassification: {
          urgencyLevel: safety.urgencyLevel,
          urgencyLabel: safety.urgencyLabel,
          triggeredWarningSigns: safety.triggeredWarningSigns,
          missingOrUnknownInformation: safety.missingInformation,
        },
      },
      null,
      2
    );

    const candidateModels = [GEMINI_MODEL, FALLBACK_GEMINI_MODEL];
    for (const model of candidateModels) {
      try {
        const response = await withTimeout(
          ai.models.generateContent({
            model,
            contents: `Create a structured educational skin symptom assessment from this verified data:\n${promptContext}`,
            config: {
              ...(model === GEMINI_MODEL
                ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                : {}),
              systemInstruction: ASSESSMENT_SYSTEM_INSTRUCTION,
              responseMimeType: 'application/json',
              responseSchema: ASSESSMENT_SCHEMA,
            },
          }),
          timeoutMs,
          'Gemini symptom assessment'
        );

        const text = (response.text ?? '').trim();
        if (text) {
          const parsed = JSON.parse(text) as Partial<SkinAssessmentDraft>;
          if (
            typeof parsed.whatPhotographShows === 'string' &&
            typeof parsed.whatAnswersIndicate === 'string' &&
            typeof parsed.possibleExplanations === 'string' &&
            typeof parsed.safeGeneralCare === 'string' &&
            typeof parsed.whatToAvoid === 'string' &&
            typeof parsed.medicalAssessmentRecommendation === 'string' &&
            typeof parsed.escalationWarningSigns === 'string'
          ) {
            modelUsed = model;
            aiDraft = {
              whatPhotographShows: parsed.whatPhotographShows.trim(),
              whatAnswersIndicate: parsed.whatAnswersIndicate.trim(),
              possibleExplanations: parsed.possibleExplanations.trim(),
              safeGeneralCare: parsed.safeGeneralCare.trim(),
              whatToAvoid: parsed.whatToAvoid.trim(),
              medicalAssessmentRecommendation:
                parsed.medicalAssessmentRecommendation.trim(),
              escalationWarningSigns: parsed.escalationWarningSigns.trim(),
              simplerSummary:
                typeof parsed.simplerSummary === 'string' &&
                parsed.simplerSummary.trim()
                  ? parsed.simplerSummary.trim()
                  : `${safety.urgencyLabel}: ${safety.mandatoryNextSteps}`,
              whyExplanation:
                typeof parsed.whyExplanation === 'string' &&
                parsed.whyExplanation.trim()
                  ? parsed.whyExplanation.trim()
                  : safety.rationale,
            };
            break;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = (err as { status?: number })?.status;
        const isQuota =
          status === 429 ||
          msg.includes('429') ||
          msg.toLowerCase().includes('resource_exhausted') ||
          msg.toLowerCase().includes('quota');
        console.warn(
          `[Glow-A-Eye][${reqId}] Gemini assessment synthesis (${model}) failed: ${msg}`
        );
        if (!isQuota) {
          break;
        }
      }
    }
  }

  if (!aiDraft) {
    usedFallbackDraft = true;
    aiDraft = buildFallbackStructuredDraft(observation, answers, safety);
  }

  // Step 2: Enforce Medical Safety Engine rules over any AI draft (overrides unsafe recs)
  const finalReport = enforceSafetyOnReport(aiDraft, safety, observation, answers);
  const durationMs = Date.now() - startedAt;

  console.info(
    `[Glow-A-Eye][${reqId}] Symptom assessment complete: urgency=${finalReport.urgencyLevel} override=${finalReport.safetyOverrideApplied} fallback=${usedFallbackDraft} durationMs=${durationMs}`
  );

  return {
    ok: true,
    report: finalReport,
    meta: {
      model: usedFallbackDraft ? 'deterministic-safety-fallback' : modelUsed,
      usedFallbackDraft,
      safetyOverrideApplied: finalReport.safetyOverrideApplied,
      durationMs,
    },
  };
}
