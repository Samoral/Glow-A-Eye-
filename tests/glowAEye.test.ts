import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApp } from '../server.ts';
import {
  analyzeSkinPhotograph,
  validateAnalyzeSkinInput,
} from '../server/analyzeSkin.ts';
import {
  assessSkinSymptoms,
  validateAssessSymptomsInput,
} from '../server/assessSkinSymptoms.ts';
import {
  assessMedicalSafety,
  enforceSafetyOnReport,
} from '../shared/medicalSafetyEngine.ts';
import {
  buildAnswerRecord,
  selectNextSymptomQuestion,
  SYMPTOM_QUESTIONS,
} from '../shared/symptomQuestionEngine.ts';
import { interpretVoiceInput } from '../src/services/voiceAssistantLogic.ts';
import { analyzeImageDataQuality } from '../src/utils/imageQuality.ts';
import {
  clearAssessmentHistory,
  deleteAssessmentRecord,
  formatHistorySummarySpeech,
  loadAssessmentHistory,
  saveAssessmentRecord,
  type StorageLike,
} from '../src/services/assessmentHistory.ts';
import type {
  SkinAnalysisObservation,
  SkinAssessmentDraft,
} from '../src/types/assistant.ts';

function makeImageData(
  width: number,
  height: number,
  fillPixel: (x: number, y: number) => [number, number, number]
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = fillPixel(x, y);
      const p = (y * width + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 255;
    }
  }
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, val) => {
      map.set(key, val);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const SAMPLE_OBSERVATION: SkinAnalysisObservation = {
  imageQualitySufficient: true,
  showsSkin: true,
  qualityAssessment: 'Clear lighting and focus.',
  apparentLocation: 'Forearm',
  observableCharacteristics: ['redness', 'mild raised bumps'],
  whatICanObserve: 'A localized patch of mild redness with small raised bumps on the forearm.',
  whatItMightIndicate: 'Could be consistent with contact irritation, dermatitis, or an insect bite.',
  whatICannotDetermine: 'Cannot determine the underlying cause or establish a medical diagnosis.',
  recommendedNextSteps: 'Monitor closely and consult a healthcare professional if persistent.',
  simplerSummary: 'There is a small red bumpy patch on the forearm. A doctor can confirm the cause.',
  safetyDisclaimer: 'This observation is informational only and not a medical diagnosis.',
  analyzedAt: '09:00 AM',
};

const VALID_FAKE_JPEG_BASE64 = Buffer.alloc(512, 0xaa).toString('base64');

test('1. Complete voice-to-analysis journey intents route accurately across every stage', () => {
  const openCam = interpretVoiceInput('open camera');
  assert.equal(openCam.action.type, 'activate_camera');

  const takePic = interpretVoiceInput('take picture', { isCameraActive: true });
  assert.equal(takePic.action.type, 'capture_photo');

  const analyze = interpretVoiceInput('analyze photo', { hasCapturedPhoto: true });
  assert.equal(analyze.action.type, 'analyze_photo');

  const confirmStart = interpretVoiceInput('yes', { awaitingAssessmentStartConfirm: true });
  assert.equal(confirmStart.action.type, 'start_questions');

  const answerQ = interpretVoiceInput('It started three days ago and itches', {
    isQuestioningActive: true,
  });
  assert.equal(answerQ.action.type, 'symptom_answer');

  const dontKnowQ = interpretVoiceInput("I don't know", { isQuestioningActive: true });
  assert.equal(dontKnowQ.action.type, 'symptom_dont_know');

  const skipQ = interpretVoiceInput('skip this question', { isQuestioningActive: true });
  assert.equal(skipQ.action.type, 'symptom_skip_question');

  const whyReport = interpretVoiceInput('why do you think that', {
    hasAssessmentReport: true,
  });
  assert.equal(whyReport.action.type, 'assessment_why');

  const saveReport = interpretVoiceInput('save this assessment', {
    hasAssessmentReport: true,
  });
  assert.equal(saveReport.action.type, 'save_assessment');

  const readHist = interpretVoiceInput('read saved assessments');
  assert.equal(readHist.action.type, 'read_history');

  const delHist = interpretVoiceInput('delete saved assessments');
  assert.equal(delHist.action.type, 'delete_history');

  const stopSpeech = interpretVoiceInput('stop speaking');
  assert.equal(stopSpeech.action.type, 'stop_speaking');

  const stopListen = interpretVoiceInput('stop listening');
  assert.equal(stopListen.action.type, 'stop_listening');

  const skinExam = interpretVoiceInput('I would like a skin examination');
  assert.equal(skinExam.action.type, 'activate_camera');

  const endConv = interpretVoiceInput('end conversation');
  assert.equal(endConv.action.type, 'end_conversation');

  const restartConv = interpretVoiceInput('start again');
  assert.equal(restartConv.action.type, 'restart_conversation');
});

test('2. Poor-quality photographs are detected cleanly (black, dark, overexposed, blurry, non-skin) vs clear textured skin', () => {
  const blackFrame = makeImageData(120, 90, () => [2, 2, 2]);
  const blackReport = analyzeImageDataQuality(blackFrame);
  assert.equal(blackReport.passed, false);
  assert.ok(blackReport.issues.includes('capture_failed'));

  const darkFrame = makeImageData(120, 90, (x, y) => [28 + (x % 5), 20 + (y % 4), 16]);
  const darkReport = analyzeImageDataQuality(darkFrame);
  assert.equal(darkReport.passed, false);
  assert.ok(darkReport.issues.includes('too_dark'));

  const brightFrame = makeImageData(120, 90, () => [252, 251, 250]);
  const brightReport = analyzeImageDataQuality(brightFrame);
  assert.equal(brightReport.passed, false);
  assert.ok(brightReport.issues.includes('too_bright'));

  const blurrySkinFrame = makeImageData(120, 90, () => [195, 145, 120]);
  const blurryReport = analyzeImageDataQuality(blurrySkinFrame);
  assert.equal(blurryReport.passed, false);
  assert.ok(blurryReport.issues.includes('blurry'));

  const blueWallFrame = makeImageData(120, 90, (x, y) => [
    40 + ((x * 7 + y * 13) % 45),
    105 + ((x + y) % 30),
    210,
  ]);
  const nonSkinReport = analyzeImageDataQuality(blueWallFrame);
  assert.equal(nonSkinReport.passed, false);
  assert.ok(nonSkinReport.issues.includes('insufficient_skin_area'));

  // Textured warm skin tone in center ROI should pass
  const clearSkinFrame = makeImageData(120, 90, (x, y) => {
    const texture = ((x + y) % 2 === 0 ? 8 : -8) + ((x * 3) % 7);
    return [195 + texture, 142 + texture, 118 + texture];
  });
  const clearReport = analyzeImageDataQuality(clearSkinFrame);
  assert.equal(clearReport.passed, true);
  assert.deepEqual(clearReport.issues, []);
  assert.ok(!clearReport.spokenFeedback.includes('not active in this phase'));
});

test('3. Image validation & Gemini API failures return clear, honest error states', async () => {
  const missing = validateAnalyzeSkinInput({});
  assert.equal(missing.valid, false);
  assert.equal(missing.code, 'MISSING_IMAGE');

  const badMime = validateAnalyzeSkinInput({
    imageBase64: VALID_FAKE_JPEG_BASE64,
    mimeType: 'image/gif',
  });
  assert.equal(badMime.valid, false);
  assert.equal(badMime.code, 'UNSUPPORTED_FORMAT');

  const oversized = validateAnalyzeSkinInput({
    imageBase64: Buffer.alloc(5 * 1024 * 1024 + 32, 0xbb).toString('base64'),
    mimeType: 'image/jpeg',
  });
  assert.equal(oversized.valid, false);
  assert.equal(oversized.code, 'IMAGE_TOO_LARGE');

  const timeoutFailure = await analyzeSkinPhotograph(
    { imageBase64: VALID_FAKE_JPEG_BASE64, mimeType: 'image/jpeg' },
    {
      apiKey: 'test-key',
      attemptTimeoutMs: 40,
      generateContentFn: () => new Promise(() => {}),
    }
  );
  assert.equal(timeoutFailure.ok, false);
  if (!timeoutFailure.ok) {
    assert.equal(timeoutFailure.status, 504);
    assert.equal(timeoutFailure.code, 'GATEWAY_TIMEOUT');
  }

  const attemptedModelsWhenRateLimited: string[] = [];
  const rateLimited = await analyzeSkinPhotograph(
    { imageBase64: VALID_FAKE_JPEG_BASE64, mimeType: 'image/jpeg' },
    {
      apiKey: 'test-key',
      generateContentFn: async ({ model }) => {
        attemptedModelsWhenRateLimited.push(model);
        const err = new Error(
          'RESOURCE_EXHAUSTED 429 GenerateRequestsPerDayPerProjectPerModel-FreeTier exceeded your current quota'
        );
        (err as { status?: number }).status = 429;
        throw err;
      },
    }
  );
  assert.equal(rateLimited.ok, false);
  assert.deepEqual(attemptedModelsWhenRateLimited, [
    'gemini-4-hydrogen',
    'gemini-3.1-flash-lite',
  ]);
  if (!rateLimited.ok) {
    assert.equal(rateLimited.status, 429);
    assert.equal(rateLimited.code, 'RATE_LIMITED');
    assert.match(rateLimited.error, /daily free-tier|Settings > Secrets/i);
  }

  const fallbackModelsTried: string[] = [];
  const fallbackSuccess = await analyzeSkinPhotograph(
    { imageBase64: VALID_FAKE_JPEG_BASE64, mimeType: 'image/jpeg' },
    {
      apiKey: 'test-key',
      generateContentFn: async ({ model }) => {
        fallbackModelsTried.push(model);
        if (model === 'gemini-4-hydrogen') {
          const err = new Error(
            'RESOURCE_EXHAUSTED 429 GenerateRequestsPerDayPerProjectPerModel-FreeTier'
          );
          (err as { status?: number }).status = 429;
          throw err;
        }
        return JSON.stringify(SAMPLE_OBSERVATION);
      },
    }
  );
  assert.equal(fallbackSuccess.ok, true);
  assert.deepEqual(fallbackModelsTried, ['gemini-4-hydrogen', 'gemini-3.1-flash-lite']);
  if (fallbackSuccess.ok) {
    assert.equal(fallbackSuccess.diagnostics.model, 'gemini-3.1-flash-lite');
  }

  const malformed = await analyzeSkinPhotograph(
    { imageBase64: VALID_FAKE_JPEG_BASE64, mimeType: 'image/jpeg' },
    {
      apiKey: 'test-key',
      generateContentFn: async () => '{"incomplete": true}',
    }
  );
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.equal(malformed.status, 502);
    assert.equal(malformed.code, 'MALFORMED_RESPONSE');
  }
});

test('4. Incomplete symptom answers trigger cautious prompt review and stay explicitly unknown', async () => {
  const answers = [
    buildAnswerRecord(SYMPTOM_QUESTIONS.onset_duration, 'unknown', "I don't know"),
    buildAnswerRecord(SYMPTOM_QUESTIONS.sensory_symptoms, 'skipped', 'Skipped'),
  ];

  const safety = assessMedicalSafety(SAMPLE_OBSERVATION, answers);
  assert.equal(safety.uncertainSafety, true);
  assert.equal(safety.urgencyLevel, 'prompt_review');
  assert.ok(safety.missingInformation.length >= 2);

  // Simulate Gemini draft generator throwing an error; deterministic fallback must still produce a safe report
  const result = await assessSkinSymptoms(
    { observation: SAMPLE_OBSERVATION, answers },
    {
      apiKey: 'test-key',
      generateDraftFn: async () => {
        throw new Error('Upstream Gemini failure');
      },
    }
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.meta.usedFallbackDraft, true);
    assert.equal(result.report.urgencyLevel, 'prompt_review');
    assert.match(result.report.whatAnswersIndicate, /unknown|skipped/i);
  }
});

test('5. Emergency warning signs stop further questioning immediately and force emergency urgency even on mild photo', () => {
  const mildObservation: SkinAnalysisObservation = {
    ...SAMPLE_OBSERVATION,
    observableCharacteristics: ['mild redness'],
    whatICanObserve: 'Very faint redness on the wrist.',
  };

  const emergencyAnswer = buildAnswerRecord(
    SYMPTOM_QUESTIONS.onset_duration,
    'answered',
    'Started an hour ago, my lips are swollen and I am having trouble breathing'
  );
  assert.equal(emergencyAnswer.extractedFacts.hasEmergencyAirwayOrAnaphylaxis, true);

  // Must not ask additional questions once emergency airway/anaphylaxis sign is detected
  const nextQ = selectNextSymptomQuestion(mildObservation, [emergencyAnswer]);
  assert.equal(nextQ, null);

  const safety = assessMedicalSafety(mildObservation, [emergencyAnswer]);
  assert.equal(safety.urgencyLevel, 'emergency');
  assert.ok(safety.triggeredWarningSigns.length >= 1);
  assert.match(safety.actionHeadline, /emergency/i);
});

test('6. Medical Safety Engine overrides unsafe diagnostic, cancer-rule-out, prescription, stop-med, and fabricated AI claims', () => {
  const answers = [
    buildAnswerRecord(
      SYMPTOM_QUESTIONS.systemic_symptoms,
      'unknown',
      "I don't know"
    ),
    buildAnswerRecord(
      SYMPTOM_QUESTIONS.progression_spreading,
      'answered',
      'Yes it is spreading fast and I have a fever and severe pain'
    ),
  ];
  const safety = assessMedicalSafety(SAMPLE_OBSERVATION, answers);
  assert.equal(safety.urgencyLevel, 'urgent');

  const unsafeDraft: SkinAssessmentDraft = {
    whatPhotographShows: 'This is definitely eczema and completely benign.',
    whatAnswersIndicate: 'Patient has no fever and is not spreading.',
    possibleExplanations: 'Not cancer, ruled out melanoma, you definitely have contact dermatitis.',
    safeGeneralCare: 'Monitor for a week and apply hydrocortisone or take amoxicillin.',
    whatToAvoid: 'Stop taking your prescribed medication right away.',
    medicalAssessmentRecommendation: 'No need to see a doctor, wait a few weeks before seeing anyone.',
    escalationWarningSigns: 'Nothing serious to worry about.',
    simplerSummary: 'Totally harmless rash, no rush.',
    whyExplanation: 'Image looks normal so you are fine.',
  };

  const enforced = enforceSafetyOnReport(unsafeDraft, safety, SAMPLE_OBSERVATION, answers);
  assert.equal(enforced.safetyOverrideApplied, true);
  assert.ok(enforced.safetyOverrideNotes.length >= 4);
  assert.equal(enforced.urgencyLevel, 'urgent');
  assert.ok(!/definitely eczema|not melanoma|completely benign/i.test(enforced.whatPhotographShows));
  assert.ok(!/amoxicillin|hydrocortisone/i.test(enforced.safeGeneralCare));
  assert.ok(!/stop taking your prescribed medication/i.test(enforced.whatToAvoid));
  assert.match(enforced.medicalAssessmentRecommendation, /today|urgent/i);
  assert.match(enforced.whatAnswersIndicate, /unknown/i);
});

test('7. Assessment history enforces explicit consent, stores no photographs, and supports voice retrieval and deletion', () => {
  const storage = createMemoryStorage();
  const answers = [
    buildAnswerRecord(SYMPTOM_QUESTIONS.onset_duration, 'answered', '2 days ago'),
  ];
  const safety = assessMedicalSafety(SAMPLE_OBSERVATION, answers);
  const report = enforceSafetyOnReport(
    {
      whatPhotographShows: SAMPLE_OBSERVATION.whatICanObserve,
      whatAnswersIndicate: 'Started 2 days ago.',
      possibleExplanations: 'Possible skin irritation.',
      safeGeneralCare: 'Keep clean with lukewarm water.',
      whatToAvoid: 'Avoid scratching or unprescribed creams.',
      medicalAssessmentRecommendation: safety.mandatoryNextSteps,
      escalationWarningSigns: safety.mandatoryEscalationSigns,
      simplerSummary: 'Gentle care and monitor.',
      whyExplanation: safety.rationale,
    },
    safety,
    SAMPLE_OBSERVATION,
    answers
  );

  // Refuses without explicit consent
  const denied = saveAssessmentRecord(
    { consentGiven: false, report, observation: SAMPLE_OBSERVATION, answers },
    storage
  );
  assert.equal(denied.ok, false);
  assert.equal(loadAssessmentHistory(storage).length, 0);

  // Saves with explicit consent and excludes any image payload
  const saved = saveAssessmentRecord(
    { consentGiven: true, report, observation: SAMPLE_OBSERVATION, answers },
    storage
  );
  assert.equal(saved.ok, true);
  const loaded = loadAssessmentHistory(storage);
  assert.equal(loaded.length, 1);
  assert.equal('imageBase64' in loaded[0], false);
  assert.equal('dataUrl' in loaded[0], false);

  const speech = formatHistorySummarySpeech(loaded);
  assert.match(speech, /1 saved assessment/i);
  assert.match(speech, /Forearm/i);

  const afterSingleDelete = deleteAssessmentRecord(loaded[0].id, storage);
  assert.equal(afterSingleDelete.length, 0);

  // Save again then clear all
  saveAssessmentRecord(
    { consentGiven: true, report, observation: SAMPLE_OBSERVATION, answers },
    storage
  );
  assert.equal(loadAssessmentHistory(storage).length, 1);
  clearAssessmentHistory(storage);
  assert.equal(loadAssessmentHistory(storage).length, 0);
});

test('8. Express HTTP API routes validate inputs and execute safety assessment cleanly', async () => {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as { ok: boolean; service: string };
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.service, 'glow-a-eye');

    const badImgRes = await fetch(`${baseUrl}/api/analyze-skin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: VALID_FAKE_JPEG_BASE64, mimeType: 'image/svg+xml' }),
    });
    assert.equal(badImgRes.status, 400);

    const badAssessRes = await fetch(`${baseUrl}/api/assess-symptoms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: 'not-an-array' }),
    });
    assert.equal(badAssessRes.status, 400);
    assert.equal(validateAssessSymptomsInput({ answers: 'not-an-array' }).valid, false);

    const emergencyAssessRes = await fetch(`${baseUrl}/api/assess-symptoms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        observation: SAMPLE_OBSERVATION,
        answers: [
          buildAnswerRecord(
            SYMPTOM_QUESTIONS.airway_allergy_check,
            'answered',
            'Yes, my throat feels tight and lips are swollen'
          ),
        ],
      }),
    });
    assert.equal(emergencyAssessRes.status, 200);
    const assessJson = (await emergencyAssessRes.json()) as {
      report: { urgencyLevel: string; triggeredWarningSigns: string[] };
    };
    assert.equal(assessJson.report.urgencyLevel, 'emergency');
    assert.ok(assessJson.report.triggeredWarningSigns.length >= 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
});
