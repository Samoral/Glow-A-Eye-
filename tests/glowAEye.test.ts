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
import {
  interpretVoiceInput,
  stripInterruptionLeadIn,
} from '../src/services/voiceAssistantLogic.ts';
import {
  transcribeInterruptionAudio,
  validateTranscribeInput,
} from '../server/transcribeInterruption.ts';
import {
  downsampleTo16k,
  encodePcmToWavBase64,
  isLikelyEchoTranscript,
  PcmPreRollRecorder,
  splitTextIntoSpeechChunks,
  TARGET_PCM_SAMPLE_RATE,
  UtteranceEndpointer,
  VadMonitor,
  VoiceInterruptionCoordinator,
} from '../src/services/voiceInterruptionEngine.ts';
import { explainSkinObservationTerm } from '../src/services/skinAnalysisClient.ts';
import {
  analyzeImageDataQuality,
  analyzeLiveGuidanceFrame,
  type LiveGuidanceEvaluation,
} from '../src/utils/imageQuality.ts';
import {
  CameraGuidanceController,
  type CameraEngineSnapshot,
} from '../src/services/cameraGuidanceEngine.ts';
import {
  clearAssessmentHistory,
  deleteAssessmentRecord,
  formatHistorySummarySpeech,
  loadAssessmentHistory,
  saveAssessmentRecord,
  type StorageLike,
} from '../src/services/assessmentHistory.ts';
import type {
  AssistantStatus,
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

// Helper to build a realistic textured skin pixel vs cool background wall
function skinPixel(x: number, y: number): [number, number, number] {
  const texture = ((x + y) % 2 === 0 ? 9 : -9) + ((x * 3) % 7);
  return [195 + texture, 142 + texture, 118 + texture];
}

function wallPixel(x: number, y: number): [number, number, number] {
  return [40 + ((x * 7 + y * 13) % 45), 105 + ((x + y) % 30), 210];
}

test('9. Real-time CV guidance covers scenarios 1-7 (away, partial, too far, poor lighting, blurry, moving, framed & stable)', () => {
  // Scenario 1: Camera pointed away from skin
  const awayFrame = makeImageData(120, 90, wallPixel);
  const awayEval = analyzeLiveGuidanceFrame(awayFrame, null);
  assert.equal(awayEval.category, 'no_skin_visible');
  assert.equal(awayEval.condition, 'no_skin');
  assert.match(awayEval.instruction, /can't see the skin/i);

  // Scenario 2: Skin only partially visible (left edge + top edge)
  const leftPartialFrame = makeImageData(120, 90, (x, y) =>
    x < 34 ? skinPixel(x, y) : wallPixel(x, y)
  );
  const leftEval = analyzeLiveGuidanceFrame(leftPartialFrame, null);
  assert.equal(leftEval.category, 'skin_not_framed');
  assert.equal(leftEval.condition, 'move_left');
  assert.match(leftEval.instruction, /left/i);

  const topPartialFrame = makeImageData(120, 90, (x, y) =>
    y < 24 ? skinPixel(x, y) : wallPixel(x, y)
  );
  const topEval = analyzeLiveGuidanceFrame(topPartialFrame, null);
  assert.equal(topEval.category, 'skin_not_framed');
  assert.equal(topEval.condition, 'move_up');
  assert.match(topEval.instruction, /upwards/i);

  // Scenario 3: Skin visible in center but too far away (small 34x26 patch ~ 9% of frame)
  const farFrame = makeImageData(120, 90, (x, y) =>
    x >= 43 && x < 77 && y >= 32 && y < 58 ? skinPixel(x, y) : wallPixel(x, y)
  );
  const farEval = analyzeLiveGuidanceFrame(farFrame, null);
  assert.equal(farEval.category, 'skin_not_framed');
  assert.equal(farEval.condition, 'too_far');
  assert.match(farEval.instruction, /closer/i);

  // Scenario 4: Poor lighting (too dark and too bright/glare)
  const darkFrame = makeImageData(120, 90, (x, y) => [24 + (x % 4), 18 + (y % 3), 15]);
  const darkEval = analyzeLiveGuidanceFrame(darkFrame, null);
  assert.equal(darkEval.category, 'quality_insufficient');
  assert.equal(darkEval.condition, 'too_dark');
  assert.match(darkEval.instruction, /too dark/i);

  const glareFrame = makeImageData(120, 90, () => [252, 251, 249]);
  const glareEval = analyzeLiveGuidanceFrame(glareFrame, null);
  assert.equal(glareEval.category, 'quality_insufficient');
  assert.equal(glareEval.condition, 'too_bright');
  assert.match(glareEval.instruction, /glare/i);

  // Scenario 5: Blurry photograph (uniform smooth skin tone, zero detail)
  const blurryFrame = makeImageData(120, 90, () => [195, 145, 120]);
  const blurryEval = analyzeLiveGuidanceFrame(blurryFrame, null);
  assert.equal(blurryEval.category, 'quality_insufficient');
  assert.equal(blurryEval.condition, 'blurry');
  assert.match(blurryEval.instruction, /blurry/i);

  // Scenario 6: Camera moving continuously across consecutive frames
  const frameA = makeImageData(120, 90, skinPixel);
  const evalA = analyzeLiveGuidanceFrame(frameA, null);
  assert.equal(evalA.isStable, false); // No motion baseline yet

  // Shifted / brightness-modulated frame simulates continuous hand movement
  const frameMoved = makeImageData(120, 90, (x, y) => {
    const [r, g, b] = skinPixel(x, y);
    return x < 60
      ? [Math.max(40, r - 60), Math.max(30, g - 50), Math.max(25, b - 40)]
      : [Math.min(245, r + 40), Math.min(230, g + 35), Math.min(220, b + 30)];
  });
  const evalMoved = analyzeLiveGuidanceFrame(frameMoved, evalA.snapshot);
  assert.equal(evalMoved.category, 'quality_insufficient');
  assert.equal(evalMoved.condition, 'unstable');
  assert.equal(evalMoved.isStable, false);
  assert.match(evalMoved.instruction, /steady/i);

  // Scenario 7: Skin properly framed and stable across consecutive frames
  const frameStable2 = makeImageData(120, 90, skinPixel);
  const evalStable = analyzeLiveGuidanceFrame(frameStable2, evalA.snapshot);
  assert.equal(evalStable.category, 'skin_ready');
  assert.equal(evalStable.condition, 'ready');
  assert.equal(evalStable.isStable, true);
});

test('10. Camera voice intents support examination, stop during camera, and contextual help', () => {
  const examine = interpretVoiceInput('I want to examine my skin');
  assert.equal(examine.action.type, 'activate_camera');

  const stopDuringCountdown = interpretVoiceInput('stop', { isCameraActive: true });
  assert.equal(stopDuringCountdown.action.type, 'cancel_camera');

  const cancelDuringCountdown = interpretVoiceInput('cancel', { isCameraActive: true });
  assert.equal(cancelDuringCountdown.action.type, 'cancel_camera');

  const helpDuringCamera = interpretVoiceInput('help me', { isCameraActive: true });
  assert.equal(helpDuringCamera.action.type, 'camera_help');
});

test('11. Scenarios 8 & 10: Automatic countdown, post-capture validation, stream cleanup, and Gemini analysis', async () => {
  let fakeNow = 1000;
  let nextTimerId = 1;
  const timers = new Map<number, () => void>();
  const spoken: string[] = [];
  const states: string[] = [];
  let stopStreamCalls = 0;
  let geminiCalls = 0;
  let deliveredObservation: SkinAnalysisObservation | null = null;

  const readySkinFrame = makeImageData(120, 90, skinPixel);
  const readyReport = analyzeImageDataQuality(readySkinFrame);
  assert.equal(readyReport.passed, true);

  let prevSnap: Float32Array | null = null;
  const sampleReady = (): LiveGuidanceEvaluation => {
    const res = analyzeLiveGuidanceFrame(readySkinFrame, prevSnap);
    prevSnap = res.snapshot;
    return res;
  };

  const controller = new CameraGuidanceController(
    {
      requestCameraStream: async () => ({ ok: true }),
      stopCameraStream: () => {
        stopStreamCalls += 1;
      },
      sampleFrame: sampleReady,
      captureFrame: () => ({
        dataUrl: `data:image/jpeg;base64,${VALID_FAKE_JPEG_BASE64}`,
        report: readyReport,
      }),
      analyzeCapturedPhoto: async () => {
        geminiCalls += 1;
        return { ok: true, observation: SAMPLE_OBSERVATION };
      },
      speak: (text, opts) => {
        spoken.push(text);
        opts?.onDone?.();
      },
      playCue: () => {},
      isAssistantSpeaking: () => false,
      isUserSpeaking: () => false,
      onStateChange: (snap: CameraEngineSnapshot) => {
        states.push(snap.state);
      },
      onObservationReady: (obs) => {
        deliveredObservation = obs;
      },
      now: () => fakeNow,
      setTimer: (fn) => {
        const id = nextTimerId++;
        timers.set(id, fn);
        return id;
      },
      clearTimer: (id) => {
        timers.delete(id);
      },
    },
    {
      sampleIntervalMs: 400,
      stabilityHoldMs: 800,
      minStableFrames: 3,
      countdownLeadDelayMs: 100,
      countdownBeatMs: 100,
    }
  );

  await controller.start();
  assert.equal(controller.getSnapshot().state, 'initializing_camera');

  const runNextTimer = () => {
    const firstKey = timers.keys().next().value;
    if (firstKey === undefined) return false;
    const fn = timers.get(firstKey)!;
    timers.delete(firstKey);
    fn();
    return true;
  };

  fakeNow += 400;
  assert.equal(runNextTimer(), true); // frame 1 (baseline -> target_detected)
  assert.equal(controller.getSnapshot().state, 'target_detected');

  fakeNow += 400;
  assert.equal(runNextTimer(), true); // frame 2 (stable 1 -> checking_stability)
  assert.equal(controller.getSnapshot().state, 'checking_stability');

  fakeNow += 450;
  assert.equal(runNextTimer(), true); // frame 3 (stable 2 -> checking_stability)

  fakeNow += 450;
  assert.equal(runNextTimer(), true); // frame 4 (stable 3, held 900ms >= 800ms -> countdown!)
  assert.equal(controller.getSnapshot().state, 'countdown');

  // Step through countdown lead + 3 + 2 + 1 -> capture -> validate -> Gemini analysis
  for (let i = 0; i < 6; i += 1) {
    if (!runNextTimer()) break;
  }
  await Promise.resolve();

  assert.equal(geminiCalls, 1);
  assert.ok(stopStreamCalls >= 1);
  assert.deepEqual(deliveredObservation, SAMPLE_OBSERVATION);
  assert.equal(controller.getSnapshot().state, 'inactive');
  assert.equal(controller.getSnapshot().isPreviewVisible, false);
  assert.ok(states.includes('countdown'));
  assert.ok(states.includes('capturing'));
  assert.ok(states.includes('validating_photograph'));
  assert.ok(states.includes('analyzing'));
  assert.ok(spoken.some((s) => /Three\./.test(s)));
  assert.ok(spoken.some((s) => /Two\./.test(s)));
  assert.ok(spoken.some((s) => /One\./.test(s)));
  assert.ok(spoken.some((s) => /Analyzing your photograph/i.test(s)));
  assert.ok(spoken.some((s) => /forearm/i.test(s)));
});

test('12. Scenario 9, 11 & 12: Cancel during countdown aborts capture, permission denied surfaces error, and reopening works without duplicate streams', async () => {
  let fakeNow = 500;
  let nextTimerId = 1;
  const timers = new Map<number, () => void>();
  let streamRequests = 0;
  let stopStreamCalls = 0;
  let geminiCalls = 0;
  let allowPermission = false;

  const readySkinFrame = makeImageData(120, 90, skinPixel);
  const readyReport = analyzeImageDataQuality(readySkinFrame);
  let prevSnap: Float32Array | null = null;

  const controller = new CameraGuidanceController(
    {
      requestCameraStream: async () => {
        streamRequests += 1;
        if (!allowPermission) {
          return {
            ok: false,
            denied: true,
            message: 'Camera permission was denied.',
          };
        }
        return { ok: true };
      },
      stopCameraStream: () => {
        stopStreamCalls += 1;
      },
      sampleFrame: () => {
        const res = analyzeLiveGuidanceFrame(readySkinFrame, prevSnap);
        prevSnap = res.snapshot;
        return res;
      },
      captureFrame: () => ({
        dataUrl: `data:image/jpeg;base64,${VALID_FAKE_JPEG_BASE64}`,
        report: readyReport,
      }),
      analyzeCapturedPhoto: async () => {
        geminiCalls += 1;
        return { ok: true, observation: SAMPLE_OBSERVATION };
      },
      speak: (_text, opts) => {
        opts?.onDone?.();
      },
      playCue: () => {},
      isAssistantSpeaking: () => false,
      isUserSpeaking: () => false,
      onStateChange: () => {},
      now: () => fakeNow,
      setTimer: (fn) => {
        const id = nextTimerId++;
        timers.set(id, fn);
        return id;
      },
      clearTimer: (id) => {
        timers.delete(id);
      },
    },
    {
      sampleIntervalMs: 400,
      stabilityHoldMs: 500,
      minStableFrames: 2,
      countdownLeadDelayMs: 100,
      countdownBeatMs: 100,
    }
  );

  // Scenario 11: Camera permission denied
  await controller.start();
  assert.equal(controller.getSnapshot().state, 'error');
  assert.match(controller.getSnapshot().errorMessage ?? '', /permission was denied/i);
  assert.equal(geminiCalls, 0);

  // Grant permission and open camera
  allowPermission = true;
  await controller.start();
  assert.equal(controller.getSnapshot().state, 'initializing_camera');
  assert.equal(streamRequests, 2);

  // Calling start() again while active must NOT create a duplicate stream
  await controller.start();
  assert.equal(streamRequests, 2);

  // Advance to countdown
  const runNext = () => {
    const k = timers.keys().next().value;
    if (k === undefined) return false;
    const fn = timers.get(k)!;
    timers.delete(k);
    fn();
    return true;
  };
  fakeNow += 400;
  runNext(); // baseline
  fakeNow += 400;
  runNext(); // stable 1
  fakeNow += 600;
  runNext(); // stable 2 -> countdown
  assert.equal(controller.getSnapshot().state, 'countdown');

  // Scenario 9: User cancels during countdown
  controller.cancel('Capture cancelled.');
  assert.equal(controller.getSnapshot().state, 'cancelled');
  assert.equal(controller.getSnapshot().isPreviewVisible, false);
  assert.ok(stopStreamCalls >= 1);
  // Drain any remaining cleared timers -> must NOT capture or call Gemini
  runNext();
  assert.equal(geminiCalls, 0);

  // Scenario 12: User reopens camera after cancellation
  prevSnap = null;
  await controller.start();
  assert.equal(controller.getSnapshot().state, 'initializing_camera');
  assert.equal(controller.getSnapshot().isPreviewVisible, true);
  assert.equal(streamRequests, 3);
  controller.dispose();
});

test('13. Barge-In Scenarios 1, 2, 9 & 10: Interrupting multi-chunk AI speech cancels queued utterances, blocks stale async responses, and deduplicates utterances', () => {
  let fakeNow = 2000;
  let nextTimerId = 1;
  const timers = new Map<number, () => void>();
  const stateHistory: AssistantStatus[] = [];
  const spokenChunks: string[] = [];
  const pendingChunkCompletions: Array<{ genId: number; complete: (genId: number) => void }> = [];
  let cancelCalls = 0;

  const coordinator = new VoiceInterruptionCoordinator(
    {
      cancelSystemSpeech: () => {
        cancelCalls += 1;
      },
      speakChunk: (text, generationId, onChunkComplete) => {
        spokenChunks.push(text);
        pendingChunkCompletions.push({ genId: generationId, complete: onChunkComplete });
      },
      onStateChange: (next) => {
        stateHistory.push(next);
      },
      now: () => fakeNow,
      setTimer: (fn) => {
        const id = nextTimerId++;
        timers.set(id, fn);
        return id;
      },
      clearTimer: (id) => {
        timers.delete(id);
      },
    },
    {
      maxChunkChars: 90,
      interruptedSettleMs: 90,
      resumingHoldMs: 100,
      dedupeWindowMs: 1200,
    }
  );

  // Scenario 1: Long multi-part response split into chunks
  const longResponse =
    'Your photograph appears to show some mild redness around the forearm. There are also small raised bumps visible near the center. I recommend monitoring closely or asking a clinician.';
  const expectedChunks = splitTextIntoSpeechChunks(longResponse, 90);
  assert.ok(expectedChunks.length >= 3);

  const speechRun = coordinator.speak(longResponse);
  assert.equal(speechRun.started, true);
  assert.equal(coordinator.getState(), 'speaking');
  assert.equal(spokenChunks.length, 1);

  // Complete chunk 1 -> chunk 2 starts
  const chunk1 = pendingChunkCompletions.shift()!;
  chunk1.complete(chunk1.genId);
  assert.equal(spokenChunks.length, 2);

  // User interrupts halfway through chunk 2!
  const snap = coordinator.interrupt({ reason: 'recognition' });
  assert.ok(cancelCalls >= 2);
  assert.equal(coordinator.getState(), 'interrupted');
  assert.ok(snap !== null);
  assert.equal(snap.hadMoreQueued, true);
  assert.match(snap.remainingText, /monitoring closely/i);

  // Even if chunk 2's old SpeechSynthesis onend fires later, chunk 3 must NEVER start
  const staleChunk2 = pendingChunkCompletions.shift()!;
  staleChunk2.complete(staleChunk2.genId);
  assert.equal(spokenChunks.length, 2);

  // Timer settles from interrupted -> listening
  const readyTimer = timers.keys().next().value;
  assert.ok(readyTimer !== undefined);
  timers.get(readyTimer)!();
  timers.delete(readyTimer);
  assert.equal(coordinator.getState(), 'listening');

  // Scenario 9: Stale async response from an earlier requestGenerationId is dropped cleanly
  const firstTurn = coordinator.beginProcessing('Tell me about the redness');
  assert.equal(firstTurn.accepted, true);
  assert.equal(coordinator.getState(), 'processing');

  // User interrupts with a newer question before old async response arrives
  coordinator.interrupt({ skipListeningTransition: true });
  if (firstTurn.accepted) {
    const staleSpeak = coordinator.speak('This stale response must never play.', {
      expectedRequestId: firstTurn.requestId,
    });
    assert.equal(staleSpeak.started, false);
    assert.equal(spokenChunks.length, 2);
  }

  // Scenario 10: Duplicate utterance within dedupeWindowMs is rejected
  const secondTurn = coordinator.beginProcessing('Stop. What does redness mean?');
  assert.equal(secondTurn.accepted, true);
  const duplicateTurn = coordinator.beginProcessing('stop.  what does redness mean?');
  assert.equal(duplicateTurn.accepted, false);

  // After dedupe window elapses, repeating an utterance works cleanly
  fakeNow += 1500;
  const repeatTurn = coordinator.beginProcessing('stop. what does redness mean?');
  assert.equal(repeatTurn.accepted, true);

  assert.ok(stateHistory.includes('speaking'));
  assert.ok(stateHistory.includes('interrupted'));
  assert.ok(stateHistory.includes('listening'));
  assert.ok(stateHistory.includes('processing'));
  coordinator.dispose();
});

test('14. Barge-In Scenarios 2, 3, 4 & 6: Natural conversational intents route interruptions without corrupting symptom answers', () => {
  // Compound interruption prefixes
  assert.deepEqual(stripInterruptionLeadIn('Stop. What does redness mean?'), {
    hadPrefix: true,
    remainder: 'What does redness mean?',
  });
  assert.deepEqual(stripInterruptionLeadIn('Wait, I need help.'), {
    hadPrefix: true,
    remainder: 'I need help.',
  });

  // Scenario 2: Stop speaking standalone vs compound
  assert.equal(interpretVoiceInput('Stop speaking.').action.type, 'stop_speaking');
  const rednessQuestion = interpretVoiceInput('Stop. What does redness mean?', {
    hasAnalysis: true,
  });
  assert.equal(rednessQuestion.action.type, 'explain_observation_term');
  assert.equal(rednessQuestion.action.term, 'redness');

  // Verify safe, plain-language explanation using observation context
  const explanation = explainSkinObservationTerm(
    rednessQuestion.action.term ?? '',
    SAMPLE_OBSERVATION
  );
  assert.match(explanation, /pinker or redder/i);
  assert.match(explanation, /forearm/i);
  assert.match(explanation, /not a medical diagnosis/i);

  // Scenario 3: Simple "Why?" uses assessment context
  const whyInterrupted = interpretVoiceInput('Why?', { hasAssessmentReport: true });
  assert.equal(whyInterrupted.action.type, 'assessment_why');

  // Scenario 4: Pausing or correcting during active symptom questioning must NOT record as symptom_answer
  const pauseDuringQuestions = interpretVoiceInput('Wait a minute', {
    isQuestioningActive: true,
  });
  assert.equal(pauseDuringQuestions.action.type, 'pause_for_user');

  const questionPause = interpretVoiceInput('Let me ask something', {
    isQuestioningActive: true,
  });
  assert.equal(questionPause.action.type, 'pause_for_user');

  const correctionOutside = interpretVoiceInput("That's not what I meant", {
    hasAssessmentReport: true,
  });
  assert.equal(correctionOutside.action.type, 'correct_last_statement');

  const correctionDuring = interpretVoiceInput('Wait no, I meant two weeks ago', {
    isQuestioningActive: true,
  });
  assert.equal(correctionDuring.action.type, 'correct_last_statement');
  assert.equal(correctionDuring.action.transcript, 'Wait no, I meant two weeks ago');

  // Scenario 6: Repeat differently & resume
  assert.equal(interpretVoiceInput('Explain that again').action.type, 'repeat_differently');
  assert.equal(interpretVoiceInput('Repeat it differently').action.type, 'repeat_differently');
  assert.equal(
    interpretVoiceInput('Explain that again', { isQuestioningActive: true }).action.type,
    'symptom_explain_question'
  );
  assert.equal(interpretVoiceInput('Continue').action.type, 'resume_conversation');
});

test('15. Barge-In Scenario 5: Interrupting camera positioning or countdown with "Wait, I need help" pauses countdown and explains guidance', async () => {
  const helpIntent = interpretVoiceInput('Wait, I need help.', { isCameraActive: true });
  assert.equal(helpIntent.action.type, 'camera_help');

  let fakeNow = 1000;
  let nextTimerId = 1;
  const timers = new Map<number, () => void>();
  const spoken: string[] = [];
  let captureCount = 0;

  const readySkinFrame = makeImageData(120, 90, skinPixel);
  const readyReport = analyzeImageDataQuality(readySkinFrame);
  let prevSnap: Float32Array | null = null;

  const controller = new CameraGuidanceController(
    {
      requestCameraStream: async () => ({ ok: true }),
      stopCameraStream: () => {},
      sampleFrame: () => {
        const res = analyzeLiveGuidanceFrame(readySkinFrame, prevSnap);
        prevSnap = res.snapshot;
        return res;
      },
      captureFrame: () => {
        captureCount += 1;
        return {
          dataUrl: `data:image/jpeg;base64,${VALID_FAKE_JPEG_BASE64}`,
          report: readyReport,
        };
      },
      analyzeCapturedPhoto: async () => ({ ok: true, observation: SAMPLE_OBSERVATION }),
      speak: (text, opts) => {
        spoken.push(text);
        opts?.onDone?.();
      },
      playCue: () => {},
      isAssistantSpeaking: () => false,
      isUserSpeaking: () => false,
      onStateChange: () => {},
      now: () => fakeNow,
      setTimer: (fn) => {
        const id = nextTimerId++;
        timers.set(id, fn);
        return id;
      },
      clearTimer: (id) => {
        timers.delete(id);
      },
    },
    {
      sampleIntervalMs: 400,
      stabilityHoldMs: 500,
      minStableFrames: 2,
      countdownLeadDelayMs: 100,
      countdownBeatMs: 100,
    }
  );

  await controller.start();
  const runNext = () => {
    const k = timers.keys().next().value;
    if (k === undefined) return false;
    const fn = timers.get(k)!;
    timers.delete(k);
    fn();
    return true;
  };
  fakeNow += 400;
  runNext();
  fakeNow += 400;
  runNext();
  fakeNow += 600;
  runNext();
  assert.equal(controller.getSnapshot().state, 'countdown');

  // User interrupts countdown saying "Wait, I need help."
  controller.speakCameraHelp();
  assert.notEqual(controller.getSnapshot().state, 'countdown');
  assert.equal(controller.getSnapshot().countdownSeconds, null);
  assert.equal(captureCount, 0);
  assert.ok(spoken.some((line) => /one hand’s length away/i.test(line)));
  controller.dispose();
});

test('16. Barge-In Scenarios 7 & 8: VAD rejects background noise & speaker echo, while triggering Android-style suspended-recognition handoff on real voice', () => {
  const vad = new VadMonitor({
    minSpeechRms: 0.032,
    speakingThresholdMultiplier: 2.5,
    requiredConsecutiveFrames: 3,
    ttsOnsetGraceMs: 260,
    cooldownMs: 600,
    minBandRatio: 0.35,
  });

  // Calibrate ambient noise floor (~0.012) while idle
  for (let i = 0; i < 6; i += 1) {
    const res = vad.evaluateFrame({
      fullRms: 0.018,
      bandRms: 0.012,
      timestampMs: 100 + i * 50,
      isAssistantSpeaking: false,
    });
    assert.equal(res.shouldInterrupt, false);
  }

  // AI starts speaking at t=500ms -> onset spike at t=600ms must be blanked by ttsOnsetGraceMs
  vad.markAssistantSpeechStarted(500);
  const onsetSpike = vad.evaluateFrame({
    fullRms: 0.14,
    bandRms: 0.11,
    timestampMs: 600,
    isAssistantSpeaking: true,
  });
  assert.equal(onsetSpike.shouldInterrupt, false);

  // Brief 1-frame transient click/cough after grace period must NOT trigger false interruption
  const clickSpike = vad.evaluateFrame({
    fullRms: 0.12,
    bandRms: 0.09,
    timestampMs: 900,
    isAssistantSpeaking: true,
  });
  assert.equal(clickSpike.shouldInterrupt, false);

  // Low-frequency bump/handling rumble (low speech band ratio) must NOT trigger
  for (let i = 0; i < 4; i += 1) {
    const rumble = vad.evaluateFrame({
      fullRms: 0.25,
      bandRms: 0.02,
      timestampMs: 960 + i * 50,
      isAssistantSpeaking: true,
    });
    assert.equal(rumble.shouldInterrupt, false);
  }

  // Echo transcript filter rejects AI's own words, lets barge-in questions through
  const recentAiSpeech = [
    'Your photograph appears to show some redness around the affected forearm area.',
  ];
  assert.equal(
    isLikelyEchoTranscript('some redness around the affected forearm', recentAiSpeech),
    true
  );
  assert.equal(
    isLikelyEchoTranscript('Stop. What does redness mean?', recentAiSpeech),
    false
  );
  assert.equal(isLikelyEchoTranscript('Why?', recentAiSpeech), false);

  // Scenario 8: Android suspended SpeechRecognition + Web Audio VAD handoff
  let recognitionOpenCalls = 0;
  let canceledSpeech = 0;
  let fakeNow = 1200;
  const timers = new Map<number, () => void>();
  let tid = 1;

  const androidCoord = new VoiceInterruptionCoordinator(
    {
      cancelSystemSpeech: () => {
        canceledSpeech += 1;
      },
      speakChunk: () => {},
      onStateChange: () => {},
      now: () => fakeNow,
      setTimer: (fn) => {
        const id = tid++;
        timers.set(id, fn);
        return id;
      },
      clearTimer: (id) => {
        timers.delete(id);
      },
    },
    { interruptedSettleMs: 80, resumingHoldMs: 100 }
  );

  androidCoord.speak('I recommend seeking prompt professional medical evaluation for safety.');
  assert.equal(androidCoord.getState(), 'speaking');

  // Sustained human speech across 3 consecutive VAD frames (~150ms) triggers immediate barge-in
  let triggered = false;
  for (let frame = 0; frame < 3; frame += 1) {
    const ev = vad.evaluateFrame({
      fullRms: 0.14,
      bandRms: 0.11,
      timestampMs: 1300 + frame * 50,
      isAssistantSpeaking: androidCoord.isSpeaking(),
    });
    if (ev.shouldInterrupt) {
      triggered = true;
      androidCoord.interrupt({
        reason: 'vad',
        onReadyToListen: () => {
          recognitionOpenCalls += 1;
        },
      });
    }
  }

  assert.equal(triggered, true);
  assert.ok(canceledSpeech >= 2);
  assert.equal(androidCoord.getState(), 'interrupted');

  // After settle delay, coordinator transitions into listening and opens recognition cleanly
  const timerKey = timers.keys().next().value;
  assert.ok(timerKey !== undefined);
  timers.get(timerKey)!();
  timers.delete(timerKey);
  assert.equal(androidCoord.getState(), 'listening');
  assert.equal(recognitionOpenCalls, 1);

  // Resume state check
  let resumedExecuted = false;
  androidCoord.transitionToResuming('Resuming...', () => {
    resumedExecuted = true;
  });
  assert.equal(androidCoord.getState(), 'resuming');
  const resumeKey = timers.keys().next().value;
  assert.ok(resumeKey !== undefined);
  timers.get(resumeKey)!();
  assert.equal(resumedExecuted, true);

  androidCoord.dispose();
});

test('17. Buffered interruption recorder preserves 1.5s pre-roll chronologically, encodes 16kHz RIFF/WAVE, and detects trailing silence', () => {
  // Verify downsampling from 48kHz to 16kHz
  const src48k = new Float32Array(4800); // 100ms at 48kHz
  for (let i = 0; i < src48k.length; i += 1) {
    src48k[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.4;
  }
  const down16k = downsampleTo16k(src48k, 48000, TARGET_PCM_SAMPLE_RATE);
  assert.equal(down16k.length, 1600);

  // Feed 2.0s of sequential sentinel frames into a 1.0s circular ring buffer
  // so earlier noise wraps cleanly and the most recent 1.0s pre-roll stays intact in order.
  const recorder = new PcmPreRollRecorder({
    sampleRate: 16000,
    preRollMs: 1000,
    maxCaptureMs: 5000,
  });

  // Push 20 chunks of 1600 samples (0.1s each) with distinct amplitude tags
  for (let chunkIdx = 1; chunkIdx <= 20; chunkIdx += 1) {
    const tag = chunkIdx / 100;
    const frame = new Float32Array(1600).fill(tag);
    recorder.pushAudioFrame(frame, 16000);
  }
  assert.equal(recorder.isCapturing(), false);

  // VAD triggers barge-in: beginCapture() freezes the last 1.0s (chunks 11..20)
  recorder.beginCapture();
  assert.equal(recorder.isCapturing(), true);

  // Push 2 post-trigger chunks (chunks 21..22)
  recorder.pushAudioFrame(new Float32Array(1600).fill(0.21), 16000);
  recorder.pushAudioFrame(new Float32Array(1600).fill(0.22), 16000);

  const finished = recorder.finishCapture();
  assert.equal(finished.sampleRate, 16000);
  assert.equal(finished.samples.length, 12 * 1600); // 1.0s pre-roll + 0.2s post-trigger
  assert.ok(finished.durationMs >= 1190 && finished.durationMs <= 1210);
  // First pre-roll sample corresponds to chunk 11 (~0.11), last corresponds to chunk 22 (~0.22)
  assert.ok(Math.abs(finished.samples[0] - 0.11) < 0.001);
  assert.ok(Math.abs(finished.samples[finished.samples.length - 1] - 0.22) < 0.001);

  // Encode 16-bit mono WAV header cleanly
  const wavBase64 = encodePcmToWavBase64(finished.samples, 16000);
  const wavBuf = Buffer.from(wavBase64, 'base64');
  assert.equal(wavBuf.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wavBuf.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wavBuf.subarray(12, 16).toString('ascii'), 'fmt ');
  assert.equal(wavBuf.readUInt16LE(20), 1); // PCM format
  assert.equal(wavBuf.readUInt16LE(22), 1); // Mono
  assert.equal(wavBuf.readUInt32LE(24), 16000); // Sample rate
  assert.equal(wavBuf.subarray(36, 40).toString('ascii'), 'data');
  assert.equal(wavBuf.byteLength, 44 + finished.samples.length * 2);

  // UtteranceEndpointer waits minCaptureMs + silenceHangoverMs before ending
  const endpointer = new UtteranceEndpointer({
    minCaptureMs: 350,
    silenceHangoverMs: 750,
    maxCaptureMs: 6000,
  });
  endpointer.start(1000);
  assert.equal(endpointer.update(true, 1200), false);
  assert.equal(endpointer.update(false, 1300), false); // below minCaptureMs
  assert.equal(endpointer.update(false, 1600), false); // silence began at 1600
  assert.equal(endpointer.update(false, 2200), false); // 600ms silence < 750ms
  assert.equal(endpointer.update(true, 2250), false); // user spoke again -> resets silence timer
  assert.equal(endpointer.update(false, 2300), false); // silence restarts at 2300
  assert.equal(endpointer.update(false, 3100), true); // 800ms >= 750ms -> submit!
});

test('18. Interruption transcription endpoint validates audio, calls Gemini cleanly, handles errors, and protects active turn generations', async () => {
  assert.equal(validateTranscribeInput({}).code, 'MISSING_AUDIO');
  assert.equal(
    validateTranscribeInput({
      audioBase64: Buffer.alloc(512, 1).toString('base64'),
      mimeType: 'audio/flac',
    }).code,
    'UNSUPPORTED_AUDIO_FORMAT'
  );
  assert.equal(
    validateTranscribeInput({
      audioBase64: Buffer.alloc(64, 1).toString('base64'),
      mimeType: 'audio/wav',
    }).code,
    'AUDIO_TOO_SMALL'
  );

  // Pure silent WAV must short-circuit with empty transcript without calling Gemini
  let geminiCalledOnSilence = false;
  const silentWav = encodePcmToWavBase64(new Float32Array(4000), 16000);
  const silentResult = await transcribeInterruptionAudio(
    { audioBase64: silentWav, mimeType: 'audio/wav' },
    {
      apiKey: 'test-key',
      generateContentFn: async () => {
        geminiCalledOnSilence = true;
        return JSON.stringify({ transcript: 'Wait' });
      },
    }
  );
  assert.equal(silentResult.ok, true);
  assert.equal(geminiCalledOnSilence, false);
  if (silentResult.ok) {
    assert.equal(silentResult.transcript, '');
  }

  // Build valid small WAV
  const pcm = new Float32Array(4000).fill(0.05);
  const validWavBase64 = encodePcmToWavBase64(pcm, 16000);

  // Primary fails -> fallback model succeeds cleanly
  const triedModels: string[] = [];
  const transcribed = await transcribeInterruptionAudio(
    { audioBase64: validWavBase64, mimeType: 'audio/wav' },
    {
      apiKey: 'test-key',
      generateContentFn: async ({ model }) => {
        triedModels.push(model);
        if (model === 'gemini-4-hydrogen') {
          throw new Error('Transient error');
        }
        return JSON.stringify({ transcript: 'Stop. Open camera' });
      },
    }
  );
  assert.equal(transcribed.ok, true);
  assert.deepEqual(triedModels, ['gemini-4-hydrogen', 'gemini-3.1-flash-lite']);
  if (transcribed.ok) {
    assert.equal(transcribed.transcript, 'Stop. Open camera');
  }

  // HTTP POST /api/transcribe-interruption rejects invalid input cleanly
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const badRes = await fetch(`http://127.0.0.1:${port}/api/transcribe-interruption`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: '', mimeType: 'audio/wav' }),
    });
    assert.equal(badRes.status, 400);
    const badJson = (await badRes.json()) as { code: string };
    assert.equal(badJson.code, 'MISSING_AUDIO');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }

  // User commands spoken naturally must NEVER be dropped as speaker echo
  const aiGreeting = [
    'Welcome to Glow-A-Eye. You can say open camera to examine your skin or start questions.',
  ];
  assert.equal(isLikelyEchoTranscript('open camera', aiGreeting), false);
  assert.equal(isLikelyEchoTranscript('start questions', aiGreeting), false);
  assert.equal(isLikelyEchoTranscript('let me ask something', aiGreeting), false);

  // Verify VoiceInterruptionCoordinator.beginAudioTranscription invalidates prior async work
  const coord = new VoiceInterruptionCoordinator({
    cancelSystemSpeech: () => {},
    speakChunk: () => {},
    onStateChange: () => {},
  });
  const req1 = coord.beginAudioTranscription('Understanding interruption...');
  assert.equal(coord.getState(), 'processing');
  assert.equal(coord.isRequestCurrent(req1), true);
  coord.interrupt({ skipListeningTransition: true });
  assert.equal(coord.isRequestCurrent(req1), false);
  coord.dispose();
});

test('19. Camera cancellation voice commands (Cancel/Close/Stop/Exit camera and Go back) route cleanly across contexts', () => {
  for (const phrase of [
    'Cancel camera.',
    'Close camera.',
    'Stop camera.',
    'Exit camera.',
    'Go back.',
  ]) {
    const res = interpretVoiceInput(phrase, { isCameraActive: true });
    assert.equal(res.action.type, 'cancel_camera', `Expected cancel_camera for "${phrase}"`);
    assert.equal(res.handledByAction, true);
  }

  // Even during questioning or if preview already closed, explicit camera cancel/close phrases still route cleanly
  for (const phrase of ['Cancel camera', 'Close camera', 'Stop camera', 'Exit camera']) {
    const idleRes = interpretVoiceInput(phrase, { isCameraActive: false });
    assert.equal(idleRes.action.type, 'cancel_camera');
    const qRes = interpretVoiceInput(phrase, { isQuestioningActive: true });
    assert.equal(qRes.action.type, 'cancel_camera');
  }

  // "Go back." outside camera returns cleanly to focus_assistant
  const outsideGoBack = interpretVoiceInput('Go back.', { isCameraActive: false });
  assert.equal(outsideGoBack.action.type, 'focus_assistant');
});

test('20. stopCameraSession releases active tracks, clears timers/countdown, restores listening, prevents stale async reopen/analysis, and supports fresh reopening', async () => {
  let fakeNow = 1000;
  let nextTimerId = 1;
  const timers = new Map<number, () => void>();

  // Simulate genuine MediaStreamTrack instances with .stop() tracking
  let activeTracks: Array<{ readyState: 'live' | 'ended'; stopCalls: number; stop: () => void }> = [];
  let stopStreamCalls = 0;
  let requestStreamCalls = 0;
  let captureCount = 0;
  let deliveredObservations = 0;
  const spokenEvents: Array<{ text: string; listenAfter?: boolean }> = [];

  let resolveDeferredStream: ((res: { ok: true }) => void) | null = null;
  let deferNextStream = false;

  let resolveDeferredAnalysis: ((res: { ok: true; observation: SkinAnalysisObservation }) => void) | null = null;
  let deferAnalysis = false;

  const readySkinFrame = makeImageData(120, 90, skinPixel);
  const readyReport = analyzeImageDataQuality(readySkinFrame);
  let prevSnap: Float32Array | null = null;

  const controller = new CameraGuidanceController(
    {
      requestCameraStream: async () => {
        requestStreamCalls += 1;
        const track = {
          readyState: 'live' as 'live' | 'ended',
          stopCalls: 0,
          stop() {
            this.readyState = 'ended';
            this.stopCalls += 1;
          },
        };
        if (deferNextStream) {
          deferNextStream = false;
          return new Promise((resolve) => {
            resolveDeferredStream = (val) => {
              activeTracks.push(track);
              resolve(val);
            };
          });
        }
        activeTracks.push(track);
        return { ok: true };
      },
      stopCameraStream: () => {
        stopStreamCalls += 1;
        for (const t of activeTracks) {
          t.stop();
        }
        activeTracks = [];
      },
      sampleFrame: () => {
        const res = analyzeLiveGuidanceFrame(readySkinFrame, prevSnap);
        prevSnap = res.snapshot;
        return res;
      },
      captureFrame: () => {
        captureCount += 1;
        return {
          dataUrl: `data:image/jpeg;base64,${VALID_FAKE_JPEG_BASE64}`,
          report: readyReport,
        };
      },
      analyzeCapturedPhoto: async () => {
        if (deferAnalysis) {
          return new Promise((resolve) => {
            resolveDeferredAnalysis = resolve;
          });
        }
        return { ok: true, observation: SAMPLE_OBSERVATION };
      },
      speak: (text, opts) => {
        spokenEvents.push({ text, listenAfter: opts?.listenAfter });
        opts?.onDone?.();
      },
      playCue: () => {},
      isAssistantSpeaking: () => false,
      isUserSpeaking: () => false,
      onStateChange: () => {},
      onObservationReady: () => {
        deliveredObservations += 1;
      },
      now: () => fakeNow,
      setTimer: (fn) => {
        const id = nextTimerId++;
        timers.set(id, fn);
        return id;
      },
      clearTimer: (id) => {
        timers.delete(id);
      },
    },
    {
      sampleIntervalMs: 400,
      stabilityHoldMs: 500,
      minStableFrames: 2,
      countdownLeadDelayMs: 100,
      countdownBeatMs: 100,
    }
  );

  // Step 1-7: Open camera -> preview visible -> cancel -> preview gone, tracks stopped, listening restored
  await controller.start();
  assert.equal(controller.getSnapshot().isPreviewVisible, true);
  assert.equal(controller.getSnapshot().isActiveSession, true);
  assert.equal(activeTracks.length, 1);
  assert.equal(activeTracks[0].readyState, 'live');
  const firstTrack = activeTracks[0];

  controller.stopCameraSession({
    announcement: 'Camera cancelled. Listening for your next request.',
    listenAfter: true,
  });
  assert.equal(controller.getSnapshot().isPreviewVisible, false);
  assert.equal(controller.getSnapshot().isActiveSession, false);
  assert.equal(controller.getSnapshot().state, 'cancelled');
  assert.equal(timers.size, 0);
  assert.equal(firstTrack.readyState, 'ended');
  assert.equal(firstTrack.stopCalls, 1);
  assert.equal(spokenEvents[spokenEvents.length - 1]?.listenAfter, true);

  // Repeated cancellation must not error and keeps preview closed
  controller.stopCameraSession({
    announcement: 'Camera cancelled.',
    listenAfter: true,
  });
  assert.equal(controller.getSnapshot().isPreviewVisible, false);
  assert.equal(controller.getSnapshot().state, 'inactive');

  // Step 8 & stale async initialization race: Cancel while getUserMedia is still resolving
  deferNextStream = true;
  const pendingOpenPromise = controller.start();
  assert.equal(controller.getSnapshot().state, 'requesting_permission');
  controller.stopCameraSession({ announcement: 'Cancelled during init.', listenAfter: true });
  assert.equal(controller.getSnapshot().isPreviewVisible, false);

  // Late getUserMedia resolution must immediately stop its own tracks and NEVER reopen preview
  resolveDeferredStream!({ ok: true });
  await pendingOpenPromise;
  assert.equal(controller.getSnapshot().isPreviewVisible, false);
  assert.equal(controller.getSnapshot().isActiveSession, false);
  assert.equal(activeTracks.length, 0);
  assert.ok(stopStreamCalls >= 3);

  // Step 9 & 10: Reopen fresh session -> reach countdown -> verify cancel aborts capture, and cancel during analysis blocks stale result
  prevSnap = null;
  await controller.start();
  assert.equal(controller.getSnapshot().isPreviewVisible, true);
  assert.equal(activeTracks.length, 1);
  const runNext = () => {
    const k = timers.keys().next().value;
    if (k === undefined) return false;
    const fn = timers.get(k)!;
    timers.delete(k);
    fn();
    return true;
  };
  fakeNow += 400;
  runNext();
  fakeNow += 400;
  runNext();
  fakeNow += 600;
  runNext();
  assert.equal(controller.getSnapshot().state, 'countdown');

  // Cancel during countdown -> no photo captured
  controller.stopCameraSession({ announcement: 'Cancelled countdown.', listenAfter: true });
  assert.equal(captureCount, 0);
  assert.equal(controller.getSnapshot().isPreviewVisible, false);
  assert.equal(timers.size, 0);

  // Reopen again, trigger manual capture -> defer Gemini analysis -> cancel mid-analysis -> late response must not deliver or reopen
  prevSnap = null;
  deferAnalysis = true;
  await controller.start();
  await controller.triggerManualCapture();
  assert.equal(captureCount, 1);
  assert.equal(controller.getSnapshot().state, 'analyzing');
  assert.equal(controller.getSnapshot().isPreviewVisible, false);

  controller.stopCameraSession({ announcement: 'Cancelled analysis.', listenAfter: true });
  assert.equal(controller.getSnapshot().state, 'cancelled');
  assert.equal(controller.getSnapshot().isPreviewVisible, false);

  resolveDeferredAnalysis!({ ok: true, observation: SAMPLE_OBSERVATION });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(deliveredObservations, 0);
  assert.equal(controller.getSnapshot().isPreviewVisible, false);
  assert.equal(controller.getSnapshot().observation, null);
  assert.equal(requestStreamCalls, 4);
  controller.dispose();
});




