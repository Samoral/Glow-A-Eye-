import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SavedAssessmentRecord,
  SkinAnalysisObservation,
  SkinAssessmentReport,
  SymptomAnswerRecord,
  SymptomQuestionDefinition,
} from '../types/assistant.ts';
import {
  buildAnswerConfirmation,
  buildAnswerRecord,
  isCorrectionUtterance,
  selectNextSymptomQuestion,
  SYMPTOM_QUESTIONS,
} from '../../shared/symptomQuestionEngine.ts';
import {
  formatAssessmentDoctorSpeech,
  formatAssessmentSimplerSpeech,
  formatAssessmentWhatNowSpeech,
  formatAssessmentWhySpeech,
  formatFullAssessmentSpeech,
  requestSymptomAssessment,
} from '../services/symptomAssessmentClient.ts';
import { explainSkinObservationTerm } from '../services/skinAnalysisClient.ts';
import {
  clearAssessmentHistory,
  formatHistorySummarySpeech,
  loadAssessmentHistory,
  saveAssessmentRecord,
} from '../services/assessmentHistory.ts';
import { playAudioCue } from '../utils/accessibility.ts';

interface UseSymptomAssessmentOptions {
  observation: SkinAnalysisObservation | null;
  audioCuesEnabled: boolean;
  onSpeakFeedback: (
    text: string,
    alsoLog?: boolean,
    options?: { listenAfter?: boolean }
  ) => void;
}

export function useSymptomAssessment({
  observation,
  audioCuesEnabled,
  onSpeakFeedback,
}: UseSymptomAssessmentOptions) {
  const [isQuestioning, setIsQuestioning] = useState(false);
  const [currentQuestion, setCurrentQuestion] =
    useState<SymptomQuestionDefinition | null>(null);
  const [answers, setAnswers] = useState<SymptomAnswerRecord[]>([]);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [report, setReport] = useState<SkinAssessmentReport | null>(null);
  const [savedCurrentReport, setSavedCurrentReport] = useState(false);
  const [savedHistory, setSavedHistory] = useState<SavedAssessmentRecord[]>(() =>
    loadAssessmentHistory()
  );

  const lastObservationTimeRef = useRef<string | null>(null);
  const assessmentTokenRef = useRef<number>(0);

  useEffect(() => {
    const obsKey = observation ? observation.analyzedAt : null;
    if (obsKey !== lastObservationTimeRef.current) {
      lastObservationTimeRef.current = obsKey;
      assessmentTokenRef.current += 1;
      setIsQuestioning(false);
      setCurrentQuestion(null);
      setAnswers([]);
      setReport(null);
      setIsGeneratingReport(false);
      setSavedCurrentReport(false);
    }
  }, [observation]);

  const resetAssessment = useCallback(() => {
    assessmentTokenRef.current += 1;
    setIsQuestioning(false);
    setCurrentQuestion(null);
    setAnswers([]);
    setReport(null);
    setIsGeneratingReport(false);
    setSavedCurrentReport(false);
  }, []);

  const finalizeAssessment = useCallback(
    async (collectedAnswers: SymptomAnswerRecord[], leadConfirmation?: string) => {
      assessmentTokenRef.current += 1;
      const token = assessmentTokenRef.current;

      setIsQuestioning(false);
      setCurrentQuestion(null);
      setIsGeneratingReport(true);
      setSavedCurrentReport(false);

      const waitingText = leadConfirmation
        ? `${leadConfirmation} Checking your answers with the Glow-A-Eye medical safety engine now. Please wait a moment.`
        : 'Checking your answers and image observations with the medical safety engine now. Please wait a moment.';
      onSpeakFeedback(waitingText, false);

      const { report: generated } = await requestSymptomAssessment({
        observation,
        answers: collectedAnswers,
      });

      if (token !== assessmentTokenRef.current) {
        // Stale async response discarded cleanly after reset or new correction
        return;
      }

      setIsGeneratingReport(false);
      setReport(generated);

      if (generated.urgencyLevel === 'emergency' || generated.urgencyLevel === 'urgent') {
        playAudioCue('error', audioCuesEnabled);
      } else {
        playAudioCue('camera-ready', audioCuesEnabled);
      }

      onSpeakFeedback(
        `${formatFullAssessmentSpeech(generated)} Say "Save this assessment" to store a text summary on your device without any photo, or say "End conversation" when finished.`,
        true,
        { listenAfter: true }
      );
    },
    [audioCuesEnabled, observation, onSpeakFeedback]
  );

  const startQuestioning = useCallback(() => {
    if (isGeneratingReport) {
      onSpeakFeedback('Your assessment report is being prepared. Please wait a moment.', false);
      return;
    }

    const firstQuestion = selectNextSymptomQuestion(observation, []);
    if (!firstQuestion) {
      void finalizeAssessment([]);
      return;
    }

    setReport(null);
    setAnswers([]);
    setSavedCurrentReport(false);
    setCurrentQuestion(firstQuestion);
    setIsQuestioning(true);
    playAudioCue('listen-start', audioCuesEnabled);

    const intro = observation
      ? 'Starting tailored follow-up symptom questions based on your image observation.'
      : 'Starting guided symptom assessment questions.';
    onSpeakFeedback(
      `${intro} You can say "I don't know", "Skip this question", "Repeat the question", "Explain what you mean", "Go back", or "Finish assessment" anytime. Question 1: ${firstQuestion.spokenQuestion}`,
      true,
      { listenAfter: true }
    );
  }, [audioCuesEnabled, finalizeAssessment, isGeneratingReport, observation, onSpeakFeedback]);

  const advanceWithRecord = useCallback(
    (record: SymptomAnswerRecord, updatedAnswers: SymptomAnswerRecord[]) => {
      setAnswers(updatedAnswers);
      const confirmation = buildAnswerConfirmation(record);
      const nextQuestion = selectNextSymptomQuestion(observation, updatedAnswers);

      if (!nextQuestion) {
        void finalizeAssessment(updatedAnswers, confirmation);
        return;
      }

      setCurrentQuestion(nextQuestion);
      playAudioCue('listen-start', audioCuesEnabled);
      onSpeakFeedback(
        `${confirmation} Question ${updatedAnswers.length + 1}: ${nextQuestion.spokenQuestion}`,
        true,
        { listenAfter: true }
      );
    },
    [audioCuesEnabled, finalizeAssessment, observation, onSpeakFeedback]
  );

  const handleSpokenAnswer = useCallback(
    (rawTranscript: string) => {
      const cleaned = rawTranscript.trim();
      if (!cleaned || !isQuestioning || !currentQuestion) return;

      if (isCorrectionUtterance(cleaned) && answers.length > 0) {
        const prev = answers[answers.length - 1];
        const prevDef = SYMPTOM_QUESTIONS[prev.questionId];
        const correctedRecord = buildAnswerRecord(prevDef, 'answered', cleaned);
        const updatedAnswers = [...answers.slice(0, -1), correctedRecord];
        setAnswers(updatedAnswers);

        const nextAfterCorrection = selectNextSymptomQuestion(observation, updatedAnswers);
        const confirm = buildAnswerConfirmation(correctedRecord);

        if (!nextAfterCorrection) {
          void finalizeAssessment(updatedAnswers, `Updated your previous answer. ${confirm}`);
          return;
        }

        setCurrentQuestion(nextAfterCorrection);
        playAudioCue('listen-start', audioCuesEnabled);
        onSpeakFeedback(
          `Updated your previous answer. ${confirm} Continuing with Question ${updatedAnswers.length + 1}: ${nextAfterCorrection.spokenQuestion}`,
          true,
          { listenAfter: true }
        );
        return;
      }

      const record = buildAnswerRecord(currentQuestion, 'answered', cleaned);
      advanceWithRecord(record, [...answers, record]);
    },
    [
      advanceWithRecord,
      answers,
      audioCuesEnabled,
      currentQuestion,
      finalizeAssessment,
      isQuestioning,
      observation,
      onSpeakFeedback,
    ]
  );

  const handleCorrectionByVoice = useCallback(
    (rawTranscript?: string) => {
      const trimmed = (rawTranscript ?? '').trim();
      const strippedCorrection = trimmed
        .replace(
          /^(?:that's not what i meant|that is not what i meant|not what i meant|you misunderstood|that's wrong|that is wrong|no that's not right|i didn't say that|actually|correction|wait no|no wait|sorry i meant|no i meant|i meant|change my last answer|change that|fix that|let me correct)\b[\s,.:;!?-]*/i,
          ''
        )
        .trim();

      if (!strippedCorrection) {
        onSpeakFeedback(
          'Sorry about that. Tell me what you meant, and I will update your answer.',
          true,
          { listenAfter: true }
        );
        return;
      }

      if (answers.length > 0 && (isQuestioning || report !== null)) {
        const prev = answers[answers.length - 1];
        const prevDef = SYMPTOM_QUESTIONS[prev.questionId];
        const correctedRecord = buildAnswerRecord(prevDef, 'answered', strippedCorrection);
        const updatedAnswers = [...answers.slice(0, -1), correctedRecord];
        setAnswers(updatedAnswers);

        const confirm = buildAnswerConfirmation(correctedRecord);

        if (isQuestioning) {
          const nextAfterCorrection = selectNextSymptomQuestion(observation, updatedAnswers);
          if (!nextAfterCorrection) {
            void finalizeAssessment(updatedAnswers, `Updated your previous answer. ${confirm}`);
            return;
          }
          setCurrentQuestion(nextAfterCorrection);
          playAudioCue('listen-start', audioCuesEnabled);
          onSpeakFeedback(
            `Updated your previous answer. ${confirm} Continuing with Question ${updatedAnswers.length + 1}: ${nextAfterCorrection.spokenQuestion}`,
            true,
            { listenAfter: true }
          );
          return;
        }

        // Report already generated — recalculate report safely with corrected answer
        void finalizeAssessment(updatedAnswers, `Updated your answer. ${confirm}`);
        return;
      }

      if (isQuestioning && currentQuestion) {
        const record = buildAnswerRecord(currentQuestion, 'answered', strippedCorrection);
        advanceWithRecord(record, [...answers, record]);
        return;
      }

      onSpeakFeedback(
        `Got it — I noted your clarification: "${strippedCorrection}". How would you like to continue?`,
        true,
        { listenAfter: true }
      );
    },
    [
      advanceWithRecord,
      answers,
      audioCuesEnabled,
      currentQuestion,
      finalizeAssessment,
      isQuestioning,
      observation,
      onSpeakFeedback,
      report,
    ]
  );

  const speakTermWithContext = useCallback(
    (term: string) => {
      onSpeakFeedback(explainSkinObservationTerm(term, observation, report), true, {
        listenAfter: true,
      });
    },
    [observation, onSpeakFeedback, report]
  );

  const handleDontKnow = useCallback(() => {
    if (!isQuestioning || !currentQuestion) {
      onSpeakFeedback('No symptom question is currently active.', false, { listenAfter: true });
      return;
    }
    const record = buildAnswerRecord(currentQuestion, 'unknown', "I don't know");
    advanceWithRecord(record, [...answers, record]);
  }, [advanceWithRecord, answers, currentQuestion, isQuestioning, onSpeakFeedback]);

  const handleSkipQuestion = useCallback(() => {
    if (!isQuestioning || !currentQuestion) {
      onSpeakFeedback('No symptom question is currently active.', false, { listenAfter: true });
      return;
    }
    const record = buildAnswerRecord(currentQuestion, 'skipped', 'Skipped');
    advanceWithRecord(record, [...answers, record]);
  }, [advanceWithRecord, answers, currentQuestion, isQuestioning, onSpeakFeedback]);

  const handleRepeatQuestion = useCallback(() => {
    if (!isQuestioning || !currentQuestion) {
      onSpeakFeedback('No symptom question is currently active right now.', false, {
        listenAfter: true,
      });
      return;
    }
    onSpeakFeedback(
      `Question ${answers.length + 1}: ${currentQuestion.spokenQuestion}`,
      false,
      { listenAfter: true }
    );
  }, [answers.length, currentQuestion, isQuestioning, onSpeakFeedback]);

  const handleExplainQuestion = useCallback(() => {
    if (!isQuestioning || !currentQuestion) {
      onSpeakFeedback('No symptom question is currently active to explain.', false, {
        listenAfter: true,
      });
      return;
    }
    onSpeakFeedback(
      `${currentQuestion.plainExplanation} ${currentQuestion.spokenQuestion}`,
      true,
      { listenAfter: true }
    );
  }, [currentQuestion, isQuestioning, onSpeakFeedback]);

  const handleGoBack = useCallback(() => {
    if (!isQuestioning) {
      onSpeakFeedback('Symptom questioning is not currently active.', false, {
        listenAfter: true,
      });
      return;
    }
    if (answers.length === 0) {
      onSpeakFeedback(
        `This is already the first question. ${currentQuestion?.spokenQuestion ?? ''}`,
        false,
        { listenAfter: true }
      );
      return;
    }

    const previousRecord = answers[answers.length - 1];
    const previousDef = SYMPTOM_QUESTIONS[previousRecord.questionId];
    const trimmedAnswers = answers.slice(0, -1);
    setAnswers(trimmedAnswers);
    setCurrentQuestion(previousDef);

    onSpeakFeedback(
      `Going back to Question ${trimmedAnswers.length + 1}. Please give your updated answer: ${previousDef.spokenQuestion}`,
      true,
      { listenAfter: true }
    );
  }, [answers, currentQuestion?.spokenQuestion, isQuestioning, onSpeakFeedback]);

  const handleFinishNow = useCallback(() => {
    if (!isQuestioning && !isGeneratingReport) {
      onSpeakFeedback(
        'No symptom questioning session is active right now. Say "Start questions" to begin.',
        false,
        { listenAfter: true }
      );
      return;
    }
    if (isQuestioning) {
      void finalizeAssessment(answers, 'Ending questions here as requested.');
    }
  }, [answers, finalizeAssessment, isGeneratingReport, isQuestioning, onSpeakFeedback]);

  const speakReportWhy = useCallback(() => {
    if (!report) {
      onSpeakFeedback('No symptom assessment report is ready yet. Say "Start questions" first.', false, {
        listenAfter: true,
      });
      return;
    }
    onSpeakFeedback(formatAssessmentWhySpeech(report), true, { listenAfter: true });
  }, [onSpeakFeedback, report]);

  const speakReportWhatNow = useCallback(() => {
    if (!report) {
      onSpeakFeedback('No symptom assessment report is ready yet. Say "Start questions" first.', false, {
        listenAfter: true,
      });
      return;
    }
    onSpeakFeedback(formatAssessmentWhatNowSpeech(report), true, { listenAfter: true });
  }, [onSpeakFeedback, report]);

  const speakReportDoctor = useCallback(() => {
    if (!report) {
      onSpeakFeedback(
        'Complete the symptom questions first, or seek immediate medical care right away if you have any severe or concerning symptoms.',
        false,
        { listenAfter: true }
      );
      return;
    }
    onSpeakFeedback(formatAssessmentDoctorSpeech(report), true, { listenAfter: true });
  }, [onSpeakFeedback, report]);

  const speakReportSimpler = useCallback(() => {
    if (!report) {
      onSpeakFeedback(
        'No symptom assessment report is ready to simplify yet. Say "Start questions" first.',
        false,
        { listenAfter: true }
      );
      return;
    }
    onSpeakFeedback(formatAssessmentSimplerSpeech(report), true, { listenAfter: true });
  }, [onSpeakFeedback, report]);

  const speakReportRepeat = useCallback(() => {
    if (!report) {
      onSpeakFeedback('No symptom assessment report is ready yet. Say "Start questions" first.', false, {
        listenAfter: true,
      });
      return;
    }
    onSpeakFeedback(formatFullAssessmentSpeech(report), false, { listenAfter: true });
  }, [onSpeakFeedback, report]);

  const saveCurrentReportByVoice = useCallback(() => {
    if (!report) {
      onSpeakFeedback(
        'No completed assessment report is ready to save yet. Complete symptom questions first.',
        false,
        { listenAfter: true }
      );
      return;
    }
    if (savedCurrentReport) {
      onSpeakFeedback('This assessment summary is already saved on your device.', false, {
        listenAfter: true,
      });
      return;
    }
    const res = saveAssessmentRecord({
      consentGiven: true,
      report,
      observation,
      answers,
    });
    if (!res.ok) {
      onSpeakFeedback(res.error, true, { listenAfter: true });
      return;
    }
    setSavedHistory(res.records);
    setSavedCurrentReport(true);
    onSpeakFeedback(
      'Saved this assessment summary locally on your device with today’s date, your reported symptoms, text observations, and recommendations. No photograph was saved.',
      true,
      { listenAfter: true }
    );
  }, [answers, observation, onSpeakFeedback, report, savedCurrentReport]);

  const readSavedHistory = useCallback(() => {
    onSpeakFeedback(formatHistorySummarySpeech(savedHistory), true, { listenAfter: true });
  }, [onSpeakFeedback, savedHistory]);

  const deleteSavedHistory = useCallback(() => {
    const hadRecords = savedHistory.length > 0;
    const next = clearAssessmentHistory();
    setSavedHistory(next);
    onSpeakFeedback(
      hadRecords
        ? 'All saved assessment summaries on this device have been deleted.'
        : 'There were no saved assessments on this device to delete.',
      true,
      { listenAfter: true }
    );
  }, [onSpeakFeedback, savedHistory.length]);

  return {
    isQuestioning,
    currentQuestion,
    isGeneratingReport,
    hasAssessmentReport: report !== null,
    report,
    startQuestioning,
    resetAssessment,
    handleSpokenAnswer,
    handleCorrectionByVoice,
    speakTermWithContext,
    handleDontKnow,
    handleSkipQuestion,
    handleRepeatQuestion,
    handleExplainQuestion,
    handleGoBack,
    handleFinishNow,
    speakReportWhy,
    speakReportWhatNow,
    speakReportDoctor,
    speakReportSimpler,
    speakReportRepeat,
    saveCurrentReportByVoice,
    readSavedHistory,
    deleteSavedHistory,
  };
}
