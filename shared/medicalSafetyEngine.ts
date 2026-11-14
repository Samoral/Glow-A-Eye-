import type {
  MedicalSafetyEvaluation,
  SkinAnalysisObservation,
  SkinAssessmentDraft,
  SkinAssessmentReport,
  SymptomAnswerRecord,
} from '../src/types/assistant.ts';
import {
  mergeAllExtractedFacts,
  profileObservation,
  SYMPTOM_QUESTIONS,
} from './symptomQuestionEngine.ts';

export const EDUCATIONAL_DISCLAIMER =
  'Glow-A-Eye is an educational support tool, not a medical diagnosis or a replacement for a qualified healthcare professional.';

function collectImageText(observation: SkinAnalysisObservation | null): string {
  if (!observation) return '';
  return [
    observation.whatICanObserve,
    observation.whatItMightIndicate,
    observation.qualityAssessment,
    ...(observation.observableCharacteristics || []),
  ]
    .join(' ')
    .toLowerCase();
}

function collectMissingInformation(answers: SymptomAnswerRecord[]): string[] {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const missing: string[] = [];

  for (const ans of answers) {
    if (ans.status === 'unknown') {
      missing.push(`${SYMPTOM_QUESTIONS[ans.questionId].topicLabel} (unknown)`);
    } else if (ans.status === 'skipped') {
      missing.push(`${SYMPTOM_QUESTIONS[ans.questionId].topicLabel} (skipped)`);
    }
  }

  // Flag critical unasked safety topics unless emergency already ended questioning
  const facts = mergeAllExtractedFacts(answers);
  if (!facts.hasEmergencyAirwayOrAnaphylaxis) {
    if (!byId.has('systemic_symptoms') && !byId.has('airway_allergy_check')) {
      missing.push('Fever and breathing/allergic reaction status (not asked)');
    }
    if (!byId.has('progression_spreading')) {
      missing.push('Spreading or progression status (not asked)');
    }
  }

  return missing;
}

/**
 * Dedicated deterministic Medical Safety Engine.
 * Operates completely independently from ordinary AI generation and takes final authority
 * over urgency classification, warning-sign detection, and recommendation overrides.
 */
export function assessMedicalSafety(
  observation: SkinAnalysisObservation | null,
  answers: SymptomAnswerRecord[]
): MedicalSafetyEvaluation {
  const facts = mergeAllExtractedFacts(answers);
  const profile = profileObservation(observation);
  const imageText = collectImageText(observation);
  const missingInformation = collectMissingInformation(answers);

  const emergencySigns: string[] = [];
  const urgentSigns: string[] = [];
  const promptReviewSigns: string[] = [];

  // 1. Emergency triggers (user-reported symptoms always override any benign/normal image)
  if (facts.hasEmergencyAirwayOrAnaphylaxis) {
    emergencySigns.push(
      'Breathing difficulty, throat tightness, or swelling of the lips, tongue, or face'
    );
  }

  // 2. Urgent triggers
  if (facts.hasFeverOrSystemicIllness && facts.hasSpreadingRedness) {
    urgentSigns.push('Fever or systemic symptoms combined with spreading redness');
  } else if (facts.hasFeverOrSystemicIllness) {
    urgentSigns.push('Fever, chills, or feeling unwell alongside a skin concern');
  }

  if (facts.hasRapidWorseningSwelling) {
    urgentSigns.push('Rapidly worsening swelling');
  }
  if (facts.hasSeverePain) {
    urgentSigns.push('Severe or worsening pain');
  }
  if (facts.hasSignificantBlisteringOrPeeling) {
    urgentSigns.push('Significant blistering, peeling, or raw skin damage');
  }
  if (
    facts.hasPusOrDischarge &&
    (facts.hasSpreadingRedness ||
      facts.hasFeverOrSystemicIllness ||
      facts.hasBurningOrTenderness ||
      profile.isPossibleInfection)
  ) {
    urgentSigns.push('Pus or oozing discharge with signs of possible skin infection');
  }

  // 3. Prompt professional review triggers
  if (
    facts.hasChangingMoleOrLesion ||
    (profile.isMoleOrPigmented && /\b(irregular|asymmetr|variegat|multi.?col|change)\b/.test(imageText))
  ) {
    promptReviewSigns.push('Changing mole or pigmented skin lesion');
  }
  if (facts.hasUnexplainedBleedingOrNonHealing) {
    promptReviewSigns.push('Unexplained bleeding or a sore that is not healing');
  }
  if (facts.isPersistentOrWorsening && urgentSigns.length === 0) {
    promptReviewSigns.push('Persistent or worsening skin abnormality');
  }
  if (facts.isRecurrent) {
    promptReviewSigns.push('Symptoms that repeatedly return or do not fully resolve');
  }
  if (facts.hasPusOrDischarge && urgentSigns.length === 0) {
    promptReviewSigns.push('Crusting, oozing, or discharge');
  }

  // Check uncertainty: cannot confidently clear as routine self-care if key answers are missing/skipped/unknown
  const answeredCount = answers.filter((a) => a.status === 'answered').length;
  const unknownOrSkippedCount = answers.filter((a) => a.status !== 'answered').length;
  const systemicAnswered = answers.some(
    (a) =>
      (a.questionId === 'systemic_symptoms' || a.questionId === 'airway_allergy_check') &&
      a.status === 'answered'
  );
  const uncertainSafety =
    answeredCount === 0 ||
    unknownOrSkippedCount >= 2 ||
    (!systemicAnswered && (profile.isPossibleInfection || profile.isRashOrAllergy || profile.isUnclearOrNoSkin)) ||
    Boolean(observation && (!observation.showsSkin || !observation.imageQualitySufficient) && answeredCount < 3);

  // Determine highest urgency level (strict priority order)
  if (emergencySigns.length > 0) {
    return {
      urgencyLevel: 'emergency',
      urgencyLabel: 'Emergency Attention Needed Now',
      actionHeadline:
        'Seek immediate emergency medical care or call emergency services (such as 911, 999, or 112) right away.',
      triggeredWarningSigns: emergencySigns,
      missingInformation,
      uncertainSafety: false,
      rationale: `Emergency warning signs were reported (${emergencySigns.join('; ')}). Immediate emergency assessment takes priority regardless of how the photograph appears.`,
      mandatoryNextSteps:
        'Call your local emergency number or go to the nearest emergency department immediately. Do not wait to see if symptoms settle on their own, and do not drive yourself if you feel dizzy or short of breath.',
      mandatoryEscalationSigns:
        'You already reported emergency warning signs. If breathing worsens, your voice becomes hoarse, or you feel faint, call emergency services immediately.',
    };
  }

  if (urgentSigns.length > 0) {
    return {
      urgencyLevel: 'urgent',
      urgencyLabel: 'Urgent Medical Assessment Recommended',
      actionHeadline:
        'Arrange prompt same-day assessment with a qualified clinician, urgent care clinic, or doctor today.',
      triggeredWarningSigns: urgentSigns,
      missingInformation,
      uncertainSafety,
      rationale: `Urgent warning signs were identified (${urgentSigns.join('; ')}). Prompt same-day medical evaluation is needed even if parts of the photo look mild.`,
      mandatoryNextSteps:
        'Contact a doctor, urgent care clinic, or nurse advice line today for prompt in-person evaluation. If symptoms worsen rapidly before you are seen, go to an urgent care center or emergency department.',
      mandatoryEscalationSigns:
        'Seek immediate emergency care if you develop difficulty breathing, swelling of your lips, tongue, or throat, dizziness, confusion, high fever, or rapidly spreading redness.',
    };
  }

  if (promptReviewSigns.length > 0 || uncertainSafety) {
    const reasons =
      promptReviewSigns.length > 0
        ? promptReviewSigns
        : ['Insufficient or uncertain symptom/image information to rule out concerning skin changes'];
    return {
      urgencyLevel: 'prompt_review',
      urgencyLabel: 'Prompt Professional Review Recommended',
      actionHeadline:
        'Schedule a timely appointment with a primary care doctor or dermatologist for an in-person check.',
      triggeredWarningSigns: promptReviewSigns,
      missingInformation,
      uncertainSafety,
      rationale:
        promptReviewSigns.length > 0
          ? `Signs needing professional evaluation were noted (${reasons.join('; ')}).`
          : 'Because important symptom or image details are missing or uncertain, the safest course is a professional clinical check rather than assuming everything is mild.',
      mandatoryNextSteps:
        'Book an appointment with a doctor or dermatologist promptly so they can examine the skin in person. Do not assume a changing, bleeding, persistent, or unclear skin concern is harmless.',
      mandatoryEscalationSigns:
        'Seek urgent or emergency care sooner if you develop fever, chills, rapidly spreading redness, worsening swelling, severe pain, significant blistering, or any trouble breathing.',
    };
  }

  return {
    urgencyLevel: 'routine_self_care',
    urgencyLabel: 'Cautious General Guidance',
    actionHeadline:
      'No immediate emergency or urgent warning signs were reported; monitor carefully and see a clinician if it persists or worsens.',
    triggeredWarningSigns: [],
    missingInformation,
    uncertainSafety: false,
    rationale:
      'Based on the reported answers and image observations, no immediate emergency, urgent infection, or high-risk lesion warning signs were identified.',
    mandatoryNextSteps:
      'You may follow gentle skin care measures while watching the area closely. Arrange a routine appointment with a healthcare professional or pharmacist if there is no improvement within a week or two, or earlier if you remain unsure.',
    mandatoryEscalationSigns:
      'Seek prompt medical attention if you notice fever, spreading redness, warmth, pus, worsening swelling, severe pain, bleeding, blistering, or any breathing difficulty.',
  };
}

function containsUnsafeClaim(text: string): {
  hasDiagnosis: boolean;
  hasBenignOrCancerRuleOut: boolean;
  hasPrescriptionAdvice: boolean;
  hasStopMedAdvice: boolean;
  hasMinimizeUrgency: boolean;
} {
  const lower = text.toLowerCase();

  const hasDiagnosis =
    /\b(you definitely have|this is definitely|your diagnosis is|diagnosed with|you have (?:acne|eczema|psoriasis|cellulitis|melanoma|ringworm|impetigo|contact dermatitis|shingles))\b/.test(
      lower
    );

  const hasBenignOrCancerRuleOut =
    /\b(completely benign|definitely benign|is benign|not cancer|not cancerous|not melanoma|rules? out cancer|ruled out cancer|rules? out melanoma|nothing to worry about|totally harmless|guaranteed harmless)\b/.test(
      lower
    );

  const hasPrescriptionAdvice =
    /\b(take (?:amoxicillin|cephalexin|doxycycline|oral antibiotics|prednisone|oral steroids)|apply (?:mupirocin|clobetasol|betamethasone|prescription steroid|hydrocortisone|antifungal cream)|start (?:antibiotics|steroids|antifungals)|use (?:a )?prescription (?:antibiotic|steroid|antifungal))\b/.test(
      lower
    ) && !/\b(avoid|do not|never)\b[^.]{0,50}\b(antibiotic|steroid|antifungal|prescription)\b/.test(lower);

  const hasStopMedAdvice =
    /\b(stop taking|discontinue|quit taking|stop using)\b[^.]{0,40}\b(prescribed|prescription|medication|medicine)\b/.test(
      lower
    ) && !/\b(without|do not|never)\b[^.]{0,40}\b(stop|discontinue)\b/.test(lower);

  const hasMinimizeUrgency =
    /\b(no need to see a doctor|you do not need medical care|just wait and see|nothing serious|treat at home and wait|wait a few weeks before seeing|image looks normal so (?:you are|it is) fine)\b/.test(
      lower
    );

  return {
    hasDiagnosis,
    hasBenignOrCancerRuleOut,
    hasPrescriptionAdvice,
    hasStopMedAdvice,
    hasMinimizeUrgency,
  };
}

function sanitizePrescriptiveOrDiagnosticText(
  text: string,
  safeReplacement: string
): { text: string; overridden: boolean; reasons: string[] } {
  const flags = containsUnsafeClaim(text);
  const reasons: string[] = [];

  if (flags.hasDiagnosis) reasons.push('Removed definitive diagnostic claim');
  if (flags.hasBenignOrCancerRuleOut) {
    reasons.push('Removed unsafe benign/cancer-rule-out claim');
  }
  if (flags.hasPrescriptionAdvice) {
    reasons.push('Removed unauthorized prescription medication recommendation');
  }
  if (flags.hasStopMedAdvice) {
    reasons.push('Removed unsafe advice to stop prescribed medication');
  }
  if (flags.hasMinimizeUrgency) {
    reasons.push('Removed minimizing/reassuring statement');
  }

  if (reasons.length > 0) {
    return { text: safeReplacement, overridden: true, reasons };
  }
  return { text, overridden: false, reasons: [] };
}

/**
 * Enforces Medical Safety Engine rules over any AI-generated draft report.
 * Always prioritizes safety classification and prevents unsafe AI recommendations,
 * diagnostic claims, benign/cancer assurances, or invented missing answers.
 */
export function enforceSafetyOnReport(
  aiDraft: SkinAssessmentDraft,
  safety: MedicalSafetyEvaluation,
  observation: SkinAnalysisObservation | null,
  answers: SymptomAnswerRecord[]
): SkinAssessmentReport {
  const overrideNotes: string[] = [];
  let safetyOverrideApplied = false;

  const noteOverride = (reason: string) => {
    safetyOverrideApplied = true;
    if (!overrideNotes.includes(reason)) {
      overrideNotes.push(reason);
    }
  };

  // 1. Protect What Photograph Shows against benign/diagnostic claims
  const safePhotoFallback = observation
    ? `${observation.whatICanObserve} (Apparent area: ${observation.apparentLocation}).`
    : 'No photograph observation was available for this assessment.';
  const photoCheck = sanitizePrescriptiveOrDiagnosticText(
    aiDraft.whatPhotographShows,
    safePhotoFallback
  );
  if (photoCheck.overridden) {
    photoCheck.reasons.forEach(noteOverride);
  }

  // 2. Ensure What Answers Indicate never invents missing info as negative
  let whatAnswersIndicate = aiDraft.whatAnswersIndicate;
  if (safety.missingInformation.length > 0) {
    const missingLower = safety.missingInformation.join(' ').toLowerCase();
    const falselyClaimsNoFever =
      missingLower.includes('fever') &&
      /\b(no fever|without fever|denied fever|reported no systemic)\b/i.test(whatAnswersIndicate);
    const falselyClaimsNoSpreading =
      missingLower.includes('spreading') &&
      /\b(not spreading|no spreading)\b/i.test(whatAnswersIndicate);

    if (falselyClaimsNoFever || falselyClaimsNoSpreading) {
      noteOverride('Prevented fabricating negative answers for unknown or skipped questions');
      const answeredLines = answers
        .filter((a) => a.status === 'answered')
        .map((a) => `${a.questionId.replace(/_/g, ' ')}: "${a.rawAnswer}"`);
      whatAnswersIndicate = `${
        answeredLines.length > 0
          ? `Reported details: ${answeredLines.join('; ')}. `
          : ''
      }Unanswered or unknown details (kept explicitly unknown): ${safety.missingInformation.join('; ')}.`;
    } else if (!/unknown|skipped|not asked|missing/i.test(whatAnswersIndicate)) {
      whatAnswersIndicate = `${whatAnswersIndicate} Note: the following details remain unknown or unanswered: ${safety.missingInformation.join('; ')}.`;
    }
  }

  // 3. Protect Possible Explanations against diagnosis or benign/cancer-rule-out claims
  const safePossibleFallback =
    'Possible non-diagnostic explanations depend on in-person clinical assessment and may include skin irritation, inflammation, infection, or other dermatologic changes. This tool cannot diagnose a condition or rule out serious causes such as skin cancer.';
  const possibleCheck = sanitizePrescriptiveOrDiagnosticText(
    aiDraft.possibleExplanations,
    safePossibleFallback
  );
  if (possibleCheck.overridden) {
    possibleCheck.reasons.forEach(noteOverride);
  }

  // 4. Protect Safe General Care against prescription advice & emergency/urgent delay
  let safeGeneralCare = aiDraft.safeGeneralCare;
  if (safety.urgencyLevel === 'emergency') {
    const emergencyCare =
      'Do not delay emergency care for home remedies. Call emergency services or go to the nearest emergency department immediately.';
    if (
      !/emergency|911|999|112/i.test(safeGeneralCare) ||
      /\b(moisturiz|wash gently|monitor at home|apply cream|ice pack|wait)\b/i.test(safeGeneralCare)
    ) {
      noteOverride(
        'Overrode general care suggestions to prioritize immediate emergency medical care'
      );
      safeGeneralCare = emergencyCare;
    }
  } else {
    const careCheck = sanitizePrescriptiveOrDiagnosticText(
      safeGeneralCare,
      safety.urgencyLevel === 'urgent'
        ? 'Keep the skin clean and uncovered or lightly protected with a clean cloth while seeking prompt same-day medical care.'
        : 'Keep the area clean with lukewarm water and mild, fragrance-free cleansing while avoiding friction or sun exposure.'
    );
    safeGeneralCare = careCheck.text;
    if (careCheck.overridden) {
      careCheck.reasons.forEach(noteOverride);
    }

    if (
      safety.urgencyLevel === 'urgent' &&
      /\b(monitor for a week|wait a few days|watch and wait|manage at home|self-care is enough)\b/i.test(
        safeGeneralCare
      )
    ) {
      noteOverride('Overrode self-care delay conflicting with urgent medical assessment warning');
      safeGeneralCare =
        'Keep the area clean and protected while arranging prompt same-day assessment by a clinician today; do not rely on home care alone.';
    }
  }

  // 5. Ensure What To Avoid explicitly prohibits unsafe actions & stopping prescribed meds
  let whatToAvoid = aiDraft.whatToAvoid;
  const avoidCheck = containsUnsafeClaim(whatToAvoid);
  if (avoidCheck.hasStopMedAdvice || avoidCheck.hasPrescriptionAdvice) {
    noteOverride('Corrected unsafe medication guidance in what-to-avoid section');
    whatToAvoid =
      'Avoid scratching, squeezing, picking, applying unprescribed antibiotics, steroids, or antifungals, or stopping any prescribed medication without medical advice.';
  } else if (!/prescrib|medication/i.test(whatToAvoid)) {
    whatToAvoid = `${whatToAvoid} Do not apply unprescribed medicated creams or stop any currently prescribed medication without consulting your clinician.`;
  }

  // 6. Strictly govern Medical Assessment Recommendation & Escalation Warning Signs
  let medicalAssessmentRecommendation = aiDraft.medicalAssessmentRecommendation;
  const recFlags = containsUnsafeClaim(medicalAssessmentRecommendation);
  const needsUrgencyOverride =
    recFlags.hasMinimizeUrgency ||
    recFlags.hasBenignOrCancerRuleOut ||
    recFlags.hasDiagnosis ||
    recFlags.hasPrescriptionAdvice ||
    (safety.urgencyLevel === 'emergency' &&
      !/emergency|immediately|911|999|112/i.test(medicalAssessmentRecommendation)) ||
    (safety.urgencyLevel === 'urgent' &&
      (!/today|same-day|urgent|prompt/i.test(medicalAssessmentRecommendation) ||
        /\broutine\b|\bno rush\b|\bwait\b/i.test(medicalAssessmentRecommendation))) ||
    (safety.urgencyLevel === 'prompt_review' &&
      (!/doctor|dermatologist|clinician|healthcare professional|medical/i.test(
        medicalAssessmentRecommendation
      ) ||
        /\bno need\b|\bharmless\b|\bbenign\b|\bwait several weeks\b/i.test(
          medicalAssessmentRecommendation
        )));

  if (needsUrgencyOverride) {
    noteOverride(
      `Medical Safety Engine enforced ${safety.urgencyLabel} recommendation over conflicting AI wording`
    );
    medicalAssessmentRecommendation = safety.mandatoryNextSteps;
  }

  let escalationWarningSigns = aiDraft.escalationWarningSigns;
  if (
    safety.urgencyLevel === 'emergency' ||
    containsUnsafeClaim(escalationWarningSigns).hasMinimizeUrgency ||
    !/breath|fever|spread|swelling/i.test(escalationWarningSigns)
  ) {
    if (safety.urgencyLevel === 'emergency') {
      escalationWarningSigns = safety.mandatoryEscalationSigns;
    } else if (!/breath|fever|spread|swelling/i.test(escalationWarningSigns)) {
      noteOverride('Enforced standard escalation red-flag guidance');
      escalationWarningSigns = safety.mandatoryEscalationSigns;
    }
  }

  // 7. Protect Simpler Summary & Why Explanation
  let simplerSummary = aiDraft.simplerSummary;
  const simplerFlags = containsUnsafeClaim(simplerSummary);
  if (
    simplerFlags.hasBenignOrCancerRuleOut ||
    simplerFlags.hasDiagnosis ||
    simplerFlags.hasPrescriptionAdvice ||
    simplerFlags.hasMinimizeUrgency ||
    (safety.urgencyLevel === 'emergency' && !/emergency|immediately/i.test(simplerSummary)) ||
    (safety.urgencyLevel === 'urgent' && !/today|urgent|prompt/i.test(simplerSummary)) ||
    (safety.urgencyLevel === 'prompt_review' &&
      !/doctor|dermatologist|clinician|healthcare|check/i.test(simplerSummary))
  ) {
    noteOverride('Aligned plain-language summary with Medical Safety Engine urgency');
    simplerSummary = `${safety.urgencyLabel}: ${safety.actionHeadline} ${safety.mandatoryNextSteps}`;
  }

  let whyExplanation = aiDraft.whyExplanation;
  const whyFlags = containsUnsafeClaim(whyExplanation);
  if (whyFlags.hasBenignOrCancerRuleOut || whyFlags.hasDiagnosis || whyFlags.hasMinimizeUrgency) {
    noteOverride('Sanitized reasoning explanation to preserve diagnostic uncertainty and safety priority');
    whyExplanation = `${safety.rationale} This assessment weighs both your reported symptoms and any observable image characteristics without making a medical diagnosis.`;
  } else if (safety.triggeredWarningSigns.length > 0) {
    whyExplanation = `${whyExplanation} Safety priority applied for: ${safety.triggeredWarningSigns.join('; ')}.`;
  }

  return {
    urgencyLevel: safety.urgencyLevel,
    urgencyLabel: safety.urgencyLabel,
    actionHeadline: safety.actionHeadline,
    triggeredWarningSigns: safety.triggeredWarningSigns,
    missingInformation: safety.missingInformation,
    safetyOverrideApplied,
    safetyOverrideNotes: overrideNotes,
    whatPhotographShows: photoCheck.text,
    whatAnswersIndicate,
    possibleExplanations: possibleCheck.text,
    safeGeneralCare,
    whatToAvoid,
    medicalAssessmentRecommendation,
    escalationWarningSigns,
    simplerSummary,
    whyExplanation,
    educationalDisclaimer: EDUCATIONAL_DISCLAIMER,
    generatedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
}
