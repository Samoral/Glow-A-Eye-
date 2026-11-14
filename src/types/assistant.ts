export type AssistantStatus =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

export type PermissionState =
  | 'unknown'
  | 'prompt'
  | 'granted'
  | 'denied'
  | 'unsupported';

export type ActiveSection =
  | 'assistant'
  | 'assessment'
  | 'history'
  | 'camera'
  | 'settings'
  | 'about';

export type SpeechRatePreset = 0.85 | 1 | 1.15;

export type DisplayTheme = 'light' | 'dark';

export type TextScale = 'standard' | 'large';

export interface ConversationMessage {
  id: string;
  sender: 'assistant' | 'user' | 'system';
  text: string;
  timestamp: string;
}

export interface AssistantSettings {
  speechRate: SpeechRatePreset;
  selectedVoiceURI: string;
  autoAnnounceMic: boolean;
  audioCuesEnabled: boolean;
  theme: DisplayTheme;
  textScale: TextScale;
}

export interface SkinAnalysisObservation {
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
  analyzedAt: string;
}

export type UrgencyLevel =
  | 'emergency'
  | 'urgent'
  | 'prompt_review'
  | 'routine_self_care';

export type SymptomQuestionId =
  | 'onset_duration'
  | 'sensory_symptoms'
  | 'progression_spreading'
  | 'surface_discharge'
  | 'recurrence_history'
  | 'new_exposures'
  | 'systemic_symptoms'
  | 'lesion_changes'
  | 'airway_allergy_check';

export type SymptomAnswerStatus = 'answered' | 'unknown' | 'skipped';

export interface ExtractedSymptomFacts {
  hasEmergencyAirwayOrAnaphylaxis?: boolean;
  hasFeverOrSystemicIllness?: boolean;
  hasSpreadingRedness?: boolean;
  hasRapidWorseningSwelling?: boolean;
  hasSeverePain?: boolean;
  hasSignificantBlisteringOrPeeling?: boolean;
  hasPusOrDischarge?: boolean;
  hasChangingMoleOrLesion?: boolean;
  hasUnexplainedBleedingOrNonHealing?: boolean;
  isPersistentOrWorsening?: boolean;
  isRecurrent?: boolean;
  hasItching?: boolean;
  hasBurningOrTenderness?: boolean;
  hasNewProductOrMedExposure?: boolean;
  durationSummary?: string;
}

export interface SymptomAnswerRecord {
  questionId: SymptomQuestionId;
  questionPrompt: string;
  status: SymptomAnswerStatus;
  rawAnswer: string;
  normalizedSummary: string;
  extractedFacts: ExtractedSymptomFacts;
  answeredAt: string;
}

export interface SymptomQuestionDefinition {
  id: SymptomQuestionId;
  topicLabel: string;
  spokenQuestion: string;
  plainExplanation: string;
}

export interface MedicalSafetyEvaluation {
  urgencyLevel: UrgencyLevel;
  urgencyLabel: string;
  actionHeadline: string;
  triggeredWarningSigns: string[];
  missingInformation: string[];
  uncertainSafety: boolean;
  rationale: string;
  mandatoryNextSteps: string;
  mandatoryEscalationSigns: string;
}

export interface SkinAssessmentDraft {
  whatPhotographShows: string;
  whatAnswersIndicate: string;
  possibleExplanations: string;
  safeGeneralCare: string;
  whatToAvoid: string;
  medicalAssessmentRecommendation: string;
  escalationWarningSigns: string;
  simplerSummary: string;
  whyExplanation: string;
}

export interface SkinAssessmentReport extends SkinAssessmentDraft {
  urgencyLevel: UrgencyLevel;
  urgencyLabel: string;
  actionHeadline: string;
  triggeredWarningSigns: string[];
  missingInformation: string[];
  safetyOverrideApplied: boolean;
  safetyOverrideNotes: string[];
  educationalDisclaimer: string;
  generatedAt: string;
}

export interface SavedAssessmentRecord {
  id: string;
  savedAtIso: string;
  savedDateLabel: string;
  urgencyLevel: UrgencyLevel;
  urgencyLabel: string;
  actionHeadline: string;
  apparentLocation: string;
  visualObservationsSummary: string;
  reportedSymptoms: string[];
  recommendations: {
    medicalAssessmentRecommendation: string;
    safeGeneralCare: string;
    escalationWarningSigns: string;
  };
  triggeredWarningSigns: string[];
}

export interface VoiceCommandAction {
  type:
    | 'none'
    | 'repeat'
    | 'stop_speaking'
    | 'stop_listening'
    | 'open_camera'
    | 'activate_camera'
    | 'close_camera'
    | 'capture_photo'
    | 'retake_photo'
    | 'cancel_camera'
    | 'repeat_camera_guide'
    | 'simplify_camera_guide'
    | 'check_camera_framing'
    | 'analyze_photo'
    | 'repeat_observations'
    | 'explain_simpler'
    | 'what_could_cause'
    | 'what_next'
    | 'start_questions'
    | 'decline_questions'
    | 'symptom_answer'
    | 'symptom_repeat_question'
    | 'symptom_explain_question'
    | 'symptom_skip_question'
    | 'symptom_dont_know'
    | 'symptom_go_back'
    | 'symptom_finish_assessment'
    | 'assessment_why'
    | 'assessment_what_now'
    | 'assessment_see_doctor'
    | 'assessment_explain_simpler'
    | 'assessment_repeat'
    | 'save_assessment'
    | 'read_history'
    | 'delete_history'
    | 'open_about'
    | 'open_settings'
    | 'focus_assistant'
    | 'end_conversation'
    | 'restart_conversation'
    | 'set_rate_slow'
    | 'set_rate_normal'
    | 'set_rate_fast'
    | 'enable_dark_theme'
    | 'enable_light_theme'
    | 'enable_large_text';
  transcript?: string;
}


