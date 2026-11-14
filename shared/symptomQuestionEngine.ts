import type {
  ExtractedSymptomFacts,
  MedicalSafetyEvaluation,
  SkinAnalysisObservation,
  SkinAssessmentDraft,
  SymptomAnswerRecord,
  SymptomQuestionDefinition,
  SymptomQuestionId,
} from '../src/types/assistant.ts';

export const SYMPTOM_QUESTIONS: Record<SymptomQuestionId, SymptomQuestionDefinition> = {
  onset_duration: {
    id: 'onset_duration',
    topicLabel: 'When it started & duration',
    spokenQuestion: 'When did this skin problem begin, and did it appear suddenly or gradually?',
    plainExplanation:
      'I am asking roughly how many hours, days, weeks, or months ago you first noticed this spot or rash, and whether it started all at once or slowly.',
  },
  sensory_symptoms: {
    id: 'sensory_symptoms',
    topicLabel: 'Itching, pain, burning, or tenderness',
    spokenQuestion: 'Is the area itchy, painful, burning, warm, or tender to the touch?',
    plainExplanation:
      'Let me know how the skin feels—for example, whether it itches, stings, burns, feels hot, or hurts when lightly touched or pressed.',
  },
  progression_spreading: {
    id: 'progression_spreading',
    topicLabel: 'Spreading or changing',
    spokenQuestion: 'Is the redness, rash, or spot spreading to nearby skin or getting worse?',
    plainExplanation:
      'I want to know if the affected area is growing larger, moving to other parts of your body, or worsening over the past hours or days.',
  },
  surface_discharge: {
    id: 'surface_discharge',
    topicLabel: 'Swelling, discharge, bleeding, or blistering',
    spokenQuestion:
      'Have you noticed any swelling, pus, oozing, unexplained bleeding, peeling, or blistering?',
    plainExplanation:
      'For instance, does the skin feel puffy or tight, have fluid-filled blisters, peel, weep clear or cloudy pus, or bleed easily without injury?',
  },
  lesion_changes: {
    id: 'lesion_changes',
    topicLabel: 'Mole or lesion changes',
    spokenQuestion:
      'Is this an existing mole or dark spot, and has it changed in size, shape, border, colour, or stayed unhealed?',
    plainExplanation:
      'I am checking whether a mole or skin mark looks different than it used to—such as growing wider, developing uneven edges or mixed colours, or remaining as a sore that does not heal.',
  },
  systemic_symptoms: {
    id: 'systemic_symptoms',
    topicLabel: 'Fever or whole-body symptoms',
    spokenQuestion:
      'Have you experienced a fever, chills, feeling generally unwell, or any difficulty breathing or swelling of your lips, tongue, or throat?',
    plainExplanation:
      'Please tell me if you feel hot or shivery like you have a fever, feel sick overall, or have any trouble breathing, swallowing, or tightness in your throat.',
  },
  airway_allergy_check: {
    id: 'airway_allergy_check',
    topicLabel: 'Breathing or severe allergic reaction signs',
    spokenQuestion:
      'Just to be safe, are you having any trouble breathing, dizziness, or swelling of your face, lips, tongue, or throat?',
    plainExplanation:
      'Because skin rashes and swelling can sometimes happen with allergic reactions, I need to check right away for breathing trouble, wheezing, or lip, tongue, or throat swelling.',
  },
  new_exposures: {
    id: 'new_exposures',
    topicLabel: 'New products, soaps, or medications',
    spokenQuestion:
      'Have you recently used any new skincare products, soaps, detergents, cosmetics, or started any new medications?',
    plainExplanation:
      'Think about anything new that touched your skin or any new pills, creams, or foods you started in the past few days or weeks.',
  },
  recurrence_history: {
    id: 'recurrence_history',
    topicLabel: 'Previous episodes',
    spokenQuestion:
      'Has something like this happened to you before, or does it keep coming back in the same area?',
    plainExplanation:
      'I am asking whether you have had similar breakouts, rashes, or skin reactions in the past.',
  },
};

export interface ImageClinicalProfile {
  isMoleOrPigmented: boolean;
  isPossibleInfection: boolean;
  isRashOrAllergy: boolean;
  isAcneLike: boolean;
  isUnclearOrNoSkin: boolean;
}

export function profileObservation(observation: SkinAnalysisObservation | null): ImageClinicalProfile {
  if (!observation) {
    return {
      isMoleOrPigmented: false,
      isPossibleInfection: false,
      isRashOrAllergy: false,
      isAcneLike: false,
      isUnclearOrNoSkin: true,
    };
  }

  const combined = [
    observation.whatICanObserve,
    observation.whatItMightIndicate,
    observation.qualityAssessment,
    ...(observation.observableCharacteristics || []),
  ]
    .join(' ')
    .toLowerCase();

  const isUnclearOrNoSkin = !observation.showsSkin || !observation.imageQualitySufficient;
  const isMoleOrPigmented = /\b(mole|nevus|naevus|lesion|pigment|dark spot|brown spot|black spot|irregular border|asymmetr|melan|freckle|non-healing|ulcer)\b/.test(
    combined
  );
  const isPossibleInfection = /\b(pus|purulent|ooz|crust|honey|cellulitis|abscess|boil|infect|swollen|swelling|warmth|erysipelas|folliculitis|impetigo)\b/.test(
    combined
  );
  const isAcneLike = /\b(acne|pimple|comedon|blackhead|whitehead|pustule|breakout|clogged pore|blemish)\b/.test(
    combined
  );
  const isRashOrAllergy =
    /\b(rash|redness|erythema|eczema|dermatitis|hives|urticaria|wheal|scaly|scaling|dry patch|flaky|allergic|irritation|blister)\b/.test(
      combined
    ) && !isAcneLike;

  return {
    isMoleOrPigmented,
    isPossibleInfection,
    isRashOrAllergy,
    isAcneLike,
    isUnclearOrNoSkin,
  };
}

function hasPositiveMention(text: string, termRegex: RegExp): boolean {
  const clauses = text
    .toLowerCase()
    .split(/[.;,!?]+|\b(?:and|but|however|though)\b/)
    .map((c) => c.trim())
    .filter(Boolean);

  for (const clause of clauses) {
    if (!termRegex.test(clause)) continue;

    // Check if the clause starts with or contains explicit negation targeting the term
    const negatedClause =
      /\b(no|not|none|never|without|neither|nor|haven't|hasn't|hadn't|don't|doesn't|didn't|isn't|aren't|nothing)\b/.test(
        clause
      ) && !/\b(not only|no longer mild|not improving|not healing|doesn't heal|won't heal|hasn't healed|not going away)\b/.test(clause);

    if (!negatedClause) {
      return true;
    }
  }
  return false;
}

function isSimpleYes(text: string): boolean {
  return /^(yes|yeah|yep|yup|uh huh|definitely|sure|it is|i have|i do|correct|right|sometimes|a little|mildly|slightly|very|definitely yes)\b/i.test(
    text.trim()
  );
}

function isSimpleNo(text: string): boolean {
  return /^(no|nope|nah|not really|negative|none|never|nothing like that|i don't think so)\b/i.test(
    text.trim()
  );
}

export function isCorrectionUtterance(rawText: string): boolean {
  const lower = rawText.trim().toLowerCase();
  return /^(actually|correction|wait no|sorry i meant|i meant|change that|change my last answer|fix that|let me correct)\b/.test(
    lower
  );
}

export function extractSymptomFacts(
  rawText: string,
  questionId: SymptomQuestionId
): ExtractedSymptomFacts {
  const lower = rawText.trim().toLowerCase();
  const facts: ExtractedSymptomFacts = {};

  // 1. Emergency airway / anaphylaxis signs
  const airwayRegex =
    /\b(difficulty breathing|trouble breathing|hard to breathe|can't breathe|cannot breathe|short of breath|shortness of breath|wheezing|swollen tongue|tongue swelling|tongue is swollen|tongue feels swollen|lips swelling|lips are swollen|swollen lips|lip swelling|face swelling|face is swollen|swollen face|throat swelling|throat is closing|throat closing|throat tight|throat feels tight|tightness in my throat|trouble swallowing|difficulty swallowing|hard to swallow|can't swallow|anaphylaxis|dizzy|fainting|passing out)\b/;
  if (hasPositiveMention(lower, airwayRegex)) {
    facts.hasEmergencyAirwayOrAnaphylaxis = true;
  } else if (
    questionId === 'airway_allergy_check' &&
    isSimpleYes(lower) &&
    !isSimpleNo(lower)
  ) {
    facts.hasEmergencyAirwayOrAnaphylaxis = true;
  }

  // 2. Fever / systemic illness
  const feverRegex = /\b(fever|chills|high temperature|feverish|shivering|flu-like|feeling very unwell|sick all over)\b/;
  if (hasPositiveMention(lower, feverRegex)) {
    facts.hasFeverOrSystemicIllness = true;
  } else if (questionId === 'systemic_symptoms' && isSimpleYes(lower)) {
    // Generic "yes" to systemic question without negating fever
    facts.hasFeverOrSystemicIllness = true;
  } else if (
    (questionId === 'systemic_symptoms' && isSimpleNo(lower)) ||
    (feverRegex.test(lower) && /\b(no|not|without|never|don't have|do not have|denied)\b/.test(lower))
  ) {
    if (facts.hasFeverOrSystemicIllness === undefined) {
      facts.hasFeverOrSystemicIllness = false;
    }
    if (facts.hasEmergencyAirwayOrAnaphylaxis === undefined && isSimpleNo(lower)) {
      facts.hasEmergencyAirwayOrAnaphylaxis = false;
    }
  }

  // 3. Spreading redness / progression
  const spreadingRegex = /\b(spreading|spread|getting bigger|growing|expanding|moving|red streaks|streaking|getting worse|worsening)\b/;
  if (hasPositiveMention(lower, spreadingRegex)) {
    facts.hasSpreadingRedness = true;
    facts.isPersistentOrWorsening = true;
  } else if (questionId === 'progression_spreading' && isSimpleYes(lower)) {
    facts.hasSpreadingRedness = true;
    facts.isPersistentOrWorsening = true;
  } else if (questionId === 'progression_spreading' && isSimpleNo(lower)) {
    facts.hasSpreadingRedness = false;
  }

  // 4. Rapid worsening swelling
  const rapidSwellingRegex = /\b(rapidly worsening swelling|fast swelling|swelling fast|swelling up quickly|very swollen|increasingly swollen|puffy face|face swelling|eye swelling)\b/;
  if (hasPositiveMention(lower, rapidSwellingRegex)) {
    facts.hasRapidWorseningSwelling = true;
  } else if (
    questionId === 'surface_discharge' &&
    hasPositiveMention(lower, /\b(swelling|swollen)\b/) &&
    /\b(worse|rapid|fast|a lot|severe|big)\b/.test(lower)
  ) {
    facts.hasRapidWorseningSwelling = true;
  }

  // 5. Severe pain
  const severePainRegex = /\b(severe pain|excruciating|throbbing pain|very painful|hurts badly|unbearable pain|intense pain)\b/;
  if (hasPositiveMention(lower, severePainRegex)) {
    facts.hasSeverePain = true;
    facts.hasBurningOrTenderness = true;
  }

  // 6. Significant blistering or peeling
  const blisteringRegex = /\b(blister|blistering|blisters|peeling|skin peeling|skin sloughing|raw skin|open raw|burst blisters)\b/;
  if (hasPositiveMention(lower, blisteringRegex)) {
    facts.hasSignificantBlisteringOrPeeling = true;
  }

  // 7. Pus / discharge
  const pusRegex = /\b(pus|oozing|weeping|cloudy fluid|yellow fluid|discharge|draining|crusting)\b/;
  if (hasPositiveMention(lower, pusRegex)) {
    facts.hasPusOrDischarge = true;
  }

  // 8. Unexplained bleeding or non-healing
  const bleedingRegex = /\b(bleeding|bleeds|blood|won't heal|not healing|doesn't heal|hasn't healed|non-healing|open sore)\b/;
  if (hasPositiveMention(lower, bleedingRegex)) {
    facts.hasUnexplainedBleedingOrNonHealing = true;
  }

  // 9. Changing mole / lesion
  const moleChangeRegex = /\b(changed|changing|bigger|grew|darker|colour changed|color changed|irregular|uneven border|different shape|new mole)\b/;
  if (
    questionId === 'lesion_changes' &&
    (isSimpleYes(lower) || hasPositiveMention(lower, moleChangeRegex))
  ) {
    facts.hasChangingMoleOrLesion = true;
  } else if (
    /\b(mole|spot|lesion)\b/.test(lower) &&
    hasPositiveMention(lower, moleChangeRegex)
  ) {
    facts.hasChangingMoleOrLesion = true;
  } else if (questionId === 'lesion_changes' && isSimpleNo(lower)) {
    facts.hasChangingMoleOrLesion = false;
  }

  // 10. Itching / burning / tenderness
  if (hasPositiveMention(lower, /\b(itch|itchy|itching|pruritic)\b/)) {
    facts.hasItching = true;
  }
  if (hasPositiveMention(lower, /\b(pain|painful|burning|burn|stinging|sting|tender|sore|warm|hot)\b/)) {
    facts.hasBurningOrTenderness = true;
  }

  // 11. New skincare / soaps / meds
  const productRegex =
    /\b(new soap|new lotion|new cream|new skincare|new cleanser|new detergent|new shampoo|new product|new medication|new medicine|antibiotic|cream|cosmetic|perfume|started using|changed soap|changed detergent)\b/;
  if (
    hasPositiveMention(lower, productRegex) ||
    (questionId === 'new_exposures' && isSimpleYes(lower))
  ) {
    facts.hasNewProductOrMedExposure = true;
  } else if (questionId === 'new_exposures' && isSimpleNo(lower)) {
    facts.hasNewProductOrMedExposure = false;
  }

  // 12. Recurrence
  const recurRegex = /\b(before|again|comes back|keeps returning|history of|chronic|happened previously|used to have)\b/;
  if (
    (questionId === 'recurrence_history' && isSimpleYes(lower)) ||
    hasPositiveMention(lower, recurRegex)
  ) {
    facts.isRecurrent = true;
  } else if (questionId === 'recurrence_history' && isSimpleNo(lower)) {
    facts.isRecurrent = false;
  }

  // 13. Duration parsing
  const durationMatch =
    /\b((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|a couple of|several|a few)\s+(?:minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)|today|this morning|yesterday|last night|since [a-z]+)\b/.exec(
      lower
    );
  if (durationMatch) {
    facts.durationSummary = durationMatch[0];
    if (/\b(week|weeks|month|months|year|years)\b/.test(durationMatch[0])) {
      facts.isPersistentOrWorsening = true;
    }
  } else if (questionId === 'onset_duration') {
    facts.durationSummary = rawText.trim();
  }

  return facts;
}

export function mergeAllExtractedFacts(answers: SymptomAnswerRecord[]): ExtractedSymptomFacts {
  const merged: ExtractedSymptomFacts = {};
  for (const ans of answers) {
    if (ans.status !== 'answered') continue;
    Object.assign(merged, ans.extractedFacts);
  }
  return merged;
}

export function buildAnswerRecord(
  question: SymptomQuestionDefinition,
  status: 'answered' | 'unknown' | 'skipped',
  rawAnswer: string
): SymptomAnswerRecord {
  const cleaned = rawAnswer.trim();
  if (status === 'unknown') {
    return {
      questionId: question.id,
      questionPrompt: question.spokenQuestion,
      status: 'unknown',
      rawAnswer: cleaned || "I don't know",
      normalizedSummary: `${question.topicLabel}: Unknown (user unsure).`,
      extractedFacts: {},
      answeredAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
  }
  if (status === 'skipped') {
    return {
      questionId: question.id,
      questionPrompt: question.spokenQuestion,
      status: 'skipped',
      rawAnswer: cleaned || 'Skipped',
      normalizedSummary: `${question.topicLabel}: Skipped by user.`,
      extractedFacts: {},
      answeredAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
  }

  const extractedFacts = extractSymptomFacts(cleaned, question.id);
  return {
    questionId: question.id,
    questionPrompt: question.spokenQuestion,
    status: 'answered',
    rawAnswer: cleaned,
    normalizedSummary: `${question.topicLabel}: ${cleaned}`,
    extractedFacts,
    answeredAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
}

/**
 * Selects the single next most clinically relevant question based on Gemini image observations
 * and the answers collected so far. Returns null when enough context is gathered or an emergency
 * warning sign requires immediate action without delay.
 */
export function selectNextSymptomQuestion(
  observation: SkinAnalysisObservation | null,
  answers: SymptomAnswerRecord[]
): SymptomQuestionDefinition | null {
  const askedIds = new Set(answers.map((a) => a.questionId));
  const facts = mergeAllExtractedFacts(answers);

  // Never delay emergency medical advice with extra questioning
  if (facts.hasEmergencyAirwayOrAnaphylaxis) {
    return null;
  }

  const profile = profileObservation(observation);

  // Build an ordered, adaptive priority queue tailored to image & symptom findings
  const candidates: SymptomQuestionId[] = [];

  // Immediate airway / severe allergic check if swelling/hives/rash/blistering emerged
  const needsAllergyCheck =
    (facts.hasRapidWorseningSwelling ||
      facts.hasSignificantBlisteringOrPeeling ||
      facts.hasNewProductOrMedExposure ||
      (profile.isRashOrAllergy && facts.hasSpreadingRedness)) &&
    !askedIds.has('systemic_symptoms') &&
    !askedIds.has('airway_allergy_check');

  if (needsAllergyCheck) {
    candidates.push('airway_allergy_check');
  }

  if (profile.isMoleOrPigmented || facts.hasChangingMoleOrLesion) {
    candidates.push(
      'lesion_changes',
      'onset_duration',
      'surface_discharge',
      'progression_spreading',
      'sensory_symptoms'
    );
  } else if (profile.isPossibleInfection || facts.hasPusOrDischarge || facts.hasFeverOrSystemicIllness) {
    candidates.push(
      'onset_duration',
      'sensory_symptoms',
      'progression_spreading',
      'surface_discharge',
      'systemic_symptoms'
    );
  } else if (profile.isRashOrAllergy) {
    candidates.push(
      'onset_duration',
      'sensory_symptoms',
      'new_exposures',
      'progression_spreading',
      'systemic_symptoms',
      'surface_discharge',
      'recurrence_history'
    );
  } else if (profile.isAcneLike) {
    candidates.push(
      'onset_duration',
      'sensory_symptoms',
      'new_exposures',
      'recurrence_history'
    );
    // Escalate into infection/discharge check only if severe pain/spreading emerged
    if (facts.hasSeverePain || facts.hasSpreadingRedness) {
      candidates.push('surface_discharge', 'systemic_symptoms');
    }
  } else {
    // Unclear image, non-skin photo, or general skin concern
    candidates.push(
      'onset_duration',
      'sensory_symptoms',
      'progression_spreading',
      'surface_discharge',
      'systemic_symptoms',
      'new_exposures',
      'lesion_changes',
      'recurrence_history'
    );
  }

  // Deduplicate and enforce a reasonable voice-first cap (max 5 questions unless acute red flags)
  const maxQuestions =
    facts.hasFeverOrSystemicIllness ||
    facts.hasSpreadingRedness ||
    facts.hasRapidWorseningSwelling ||
    facts.hasSignificantBlisteringOrPeeling
      ? 6
      : profile.isAcneLike && !facts.hasSeverePain
        ? 4
        : 5;

  if (answers.length >= maxQuestions) {
    return null;
  }

  // Skip topics already clearly provided in multi-fact answers
  const alreadyCoveredByFacts = new Set<SymptomQuestionId>();
  if (facts.durationSummary && askedIds.size > 0) {
    alreadyCoveredByFacts.add('onset_duration');
  }
  if (
    (facts.hasItching || facts.hasBurningOrTenderness) &&
    answers.some((a) => a.questionId !== 'sensory_symptoms' && (a.extractedFacts.hasItching || a.extractedFacts.hasBurningOrTenderness))
  ) {
    alreadyCoveredByFacts.add('sensory_symptoms');
  }
  if (facts.hasNewProductOrMedExposure === true) {
    alreadyCoveredByFacts.add('new_exposures');
  }
  if (
    facts.hasFeverOrSystemicIllness !== undefined &&
    askedIds.has('systemic_symptoms')
  ) {
    alreadyCoveredByFacts.add('airway_allergy_check');
  }

  for (const id of candidates) {
    if (!askedIds.has(id) && !alreadyCoveredByFacts.has(id)) {
      return SYMPTOM_QUESTIONS[id];
    }
  }

  return null;
}

export function buildAnswerConfirmation(record: SymptomAnswerRecord): string {
  if (record.status === 'unknown') {
    return 'Understood. I have recorded that as unknown and will not guess.';
  }
  if (record.status === 'skipped') {
    return 'Okay, skipped this question.';
  }

  const f = record.extractedFacts;
  const highlights: string[] = [];
  if (f.hasEmergencyAirwayOrAnaphylaxis) highlights.push('breathing or throat/tongue swelling symptoms');
  if (f.hasFeverOrSystemicIllness) highlights.push('fever or systemic symptoms');
  if (f.hasSpreadingRedness) highlights.push('spreading redness or worsening');
  if (f.hasRapidWorseningSwelling) highlights.push('worsening swelling');
  if (f.hasSeverePain) highlights.push('severe pain');
  if (f.hasSignificantBlisteringOrPeeling) highlights.push('blistering or peeling');
  if (f.hasPusOrDischarge) highlights.push('discharge or pus');
  if (f.hasChangingMoleOrLesion) highlights.push('changes to a mole or spot');
  if (f.hasUnexplainedBleedingOrNonHealing) highlights.push('bleeding or non-healing sore');
  if (f.hasNewProductOrMedExposure) highlights.push('recent product or medication exposure');
  if (f.hasItching) highlights.push('itching');
  if (f.hasBurningOrTenderness && !f.hasSeverePain) highlights.push('burning or tenderness');
  if (f.durationSummary) highlights.push(`timing (${f.durationSummary})`);

  if (highlights.length > 0) {
    return `Noted: ${highlights.join(', ')}.`;
  }
  return `Noted: "${record.rawAnswer}".`;
}

export function buildFallbackStructuredDraft(
  observation: SkinAnalysisObservation | null,
  answers: SymptomAnswerRecord[],
  safety: MedicalSafetyEvaluation
): SkinAssessmentDraft {
  const whatPhotographShows = observation
    ? observation.showsSkin && observation.imageQualitySufficient
      ? `${observation.whatICanObserve}${
          observation.observableCharacteristics.length > 0
            ? ` Visible features noted: ${observation.observableCharacteristics.join(', ')}.`
            : ''
        } Apparent area: ${observation.apparentLocation}.`
      : `The photograph could not provide clear skin details (${observation.qualityAssessment}), so this assessment relies primarily on your spoken symptom answers.`
    : 'No photograph observation was included, so this guidance is based on your spoken answers and safety screening.';

  const answeredLines = answers
    .filter((a) => a.status === 'answered')
    .map((a) => `${a.questionId.replace(/_/g, ' ')}: "${a.rawAnswer}"`);
  const missingLine =
    safety.missingInformation.length > 0
      ? ` Missing or unknown details that were not assumed: ${safety.missingInformation.join('; ')}.`
      : '';

  const whatAnswersIndicate =
    answeredLines.length > 0
      ? `Based on what you shared: ${answeredLines.join('; ')}.${missingLine}`
      : `No specific symptom answers were confirmed yet.${missingLine}`;

  const possibleExplanations = observation?.whatItMightIndicate
    ? `${observation.whatItMightIndicate} Because a photograph and brief questions cannot confirm an internal or tissue-level cause, these remain possibilities rather than a medical diagnosis.`
    : 'Skin symptoms can have several possible non-diagnostic explanations—such as irritation, allergic reaction, inflammation, infection, or benign or concerning skin changes—that require an in-person clinician exam to distinguish.';

  const safeGeneralCare =
    safety.urgencyLevel === 'emergency'
      ? 'Do not try to treat this at home or wait to see if it improves. Focus on getting emergency medical help immediately and keep your airway clear.'
      : safety.urgencyLevel === 'urgent'
        ? 'Keep the area clean, dry, and uncovered or lightly covered with a clean cloth while arranging prompt same-day medical care today.'
        : 'Keep the skin clean with gentle, lukewarm water, avoid harsh scrubbing or fragranced products, and protect the area from friction or sun exposure until evaluated.';

  const whatToAvoid =
    'Avoid scratching, squeezing, picking, or popping the skin, applying unprescribed antibiotic, steroid, or antifungal creams, or stopping any currently prescribed medication without checking with your doctor.';

  return {
    whatPhotographShows,
    whatAnswersIndicate,
    possibleExplanations,
    safeGeneralCare,
    whatToAvoid,
    medicalAssessmentRecommendation: safety.mandatoryNextSteps,
    escalationWarningSigns: safety.mandatoryEscalationSigns,
    simplerSummary: `${safety.urgencyLabel}: ${safety.actionHeadline} ${safety.mandatoryNextSteps}`,
    whyExplanation: `${safety.rationale} This guidance combines what could be seen in the photograph, the symptoms you reported, and any unanswered safety questions.`,
  };
}
