import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  ArrowLeft,
  BookmarkCheck,
  BookmarkPlus,
  CheckCircle2,
  ClipboardCheck,
  HelpCircle,
  Loader2,
  MessageSquarePlus,
  RotateCcw,
  ShieldAlert,
  SkipForward,
  Stethoscope,
  Volume2,
} from 'lucide-react';
import {
  SkinAnalysisObservation,
  SkinAssessmentReport,
  SymptomAnswerRecord,
  SymptomQuestionDefinition,
  TextScale,
  UrgencyLevel,
} from '../types/assistant';
import {
  buildAnswerConfirmation,
  buildAnswerRecord,
  isCorrectionUtterance,
  selectNextSymptomQuestion,
  SYMPTOM_QUESTIONS,
} from '../../shared/symptomQuestionEngine';
import {
  formatAssessmentDoctorSpeech,
  formatAssessmentSimplerSpeech,
  formatAssessmentWhatNowSpeech,
  formatAssessmentWhySpeech,
  formatFullAssessmentSpeech,
  requestSymptomAssessment,
} from '../services/symptomAssessmentClient';
import { playAudioCue, usePrefersReducedMotion } from '../utils/accessibility';

interface SymptomAssessmentPanelProps {
  observation: SkinAnalysisObservation | null;
  textScale: TextScale;
  audioCuesEnabled: boolean;
  startSignal: number;
  answerEvent: { seq: number; transcript: string };
  repeatQuestionSignal: number;
  explainQuestionSignal: number;
  skipQuestionSignal: number;
  dontKnowSignal: number;
  goBackSignal: number;
  finishAssessmentSignal: number;
  reportWhySignal: number;
  reportWhatNowSignal: number;
  reportSeeDoctorSignal: number;
  reportSimplerSignal: number;
  reportRepeatSignal: number;
  reportSaveSignal: number;
  onSpeakFeedback: (
    text: string,
    alsoLog?: boolean,
    options?: { listenAfter?: boolean }
  ) => void;
  onSaveAssessment?: (params: {
    consentGiven: boolean;
    report: SkinAssessmentReport;
    observation: SkinAnalysisObservation | null;
    answers: SymptomAnswerRecord[];
  }) => boolean;
  onAssessmentStateChange?: (state: {
    isQuestioningActive: boolean;
    hasAssessmentReport: boolean;
  }) => void;
  sectionRef?: React.RefObject<HTMLElement | null>;
}

function getUrgencyBannerClasses(level: UrgencyLevel): string {
  switch (level) {
    case 'emergency':
      return 'bg-rose-100 text-rose-950 border-rose-500 dark:bg-rose-950/80 dark:text-rose-100 dark:border-rose-500';
    case 'urgent':
      return 'bg-amber-100 text-amber-950 border-amber-500 dark:bg-amber-950/75 dark:text-amber-100 dark:border-amber-500';
    case 'prompt_review':
      return 'bg-violet-100 text-violet-950 border-violet-400 dark:bg-violet-950/75 dark:text-violet-100 dark:border-violet-500';
    default:
      return 'bg-emerald-50 text-emerald-950 border-emerald-400 dark:bg-emerald-950/60 dark:text-emerald-100 dark:border-emerald-700';
  }
}

export const SymptomAssessmentPanel: React.FC<SymptomAssessmentPanelProps> = ({
  observation,
  textScale,
  audioCuesEnabled,
  startSignal,
  answerEvent,
  repeatQuestionSignal,
  explainQuestionSignal,
  skipQuestionSignal,
  dontKnowSignal,
  goBackSignal,
  finishAssessmentSignal,
  reportWhySignal,
  reportWhatNowSignal,
  reportSeeDoctorSignal,
  reportSimplerSignal,
  reportRepeatSignal,
  reportSaveSignal,
  onSpeakFeedback,
  onSaveAssessment,
  onAssessmentStateChange,
  sectionRef,
}) => {
  const [isQuestioning, setIsQuestioning] = useState(false);
  const [currentQuestion, setCurrentQuestion] =
    useState<SymptomQuestionDefinition | null>(null);
  const [answers, setAnswers] = useState<SymptomAnswerRecord[]>([]);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [report, setReport] = useState<SkinAssessmentReport | null>(null);
  const [autoListenHandsFree, setAutoListenHandsFree] = useState(true);
  const [localAnswerInput, setLocalAnswerInput] = useState('');
  const [saveConsentChecked, setSaveConsentChecked] = useState(false);
  const [savedCurrentReport, setSavedCurrentReport] = useState(false);

  const reducedMotion = usePrefersReducedMotion();
  const lastObservationTimeRef = useRef<string | null>(null);

  // Sync questioning and report flags upward for voice intent awareness
  useEffect(() => {
    onAssessmentStateChange?.({
      isQuestioningActive: isQuestioning,
      hasAssessmentReport: report !== null,
    });
  }, [isQuestioning, onAssessmentStateChange, report]);

  // Reset active assessment when a brand new image observation arrives
  useEffect(() => {
    const obsKey = observation ? observation.analyzedAt : null;
    if (obsKey !== lastObservationTimeRef.current) {
      lastObservationTimeRef.current = obsKey;
      setIsQuestioning(false);
      setCurrentQuestion(null);
      setAnswers([]);
      setReport(null);
      setIsGeneratingReport(false);
      setSaveConsentChecked(false);
      setSavedCurrentReport(false);
    }
  }, [observation]);

  const finalizeAssessment = useCallback(
    async (collectedAnswers: SymptomAnswerRecord[], leadConfirmation?: string) => {
      setIsQuestioning(false);
      setCurrentQuestion(null);
      setIsGeneratingReport(true);
      setSaveConsentChecked(false);
      setSavedCurrentReport(false);

      const waitingText = leadConfirmation
        ? `${leadConfirmation} Checking your answers with the Glow-A-Eye medical safety engine now. Please wait a moment.`
        : 'Checking your answers and image observations with the medical safety engine now. Please wait a moment.';
      onSpeakFeedback(waitingText, false);

      const { report: generated } = await requestSymptomAssessment({
        observation,
        answers: collectedAnswers,
      });

      setIsGeneratingReport(false);
      setReport(generated);

      if (generated.urgencyLevel === 'emergency' || generated.urgencyLevel === 'urgent') {
        playAudioCue('error', audioCuesEnabled);
      } else {
        playAudioCue('camera-ready', audioCuesEnabled);
      }

      onSpeakFeedback(
        `${formatFullAssessmentSpeech(generated)} If you wish to save this text summary on your device without saving any photograph, say "Save this assessment".`,
        true
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
    setCurrentQuestion(firstQuestion);
    setIsQuestioning(true);
    playAudioCue('listen-start', audioCuesEnabled);

    const intro = observation
      ? 'Starting tailored follow-up symptom questions based on your image observation.'
      : 'Starting guided symptom assessment questions.';
    onSpeakFeedback(
      `${intro} You can say "I don't know", "Skip this question", "Repeat the question", "Explain what you mean", "Go back", or "Finish assessment" anytime. Question 1: ${firstQuestion.spokenQuestion}`,
      true,
      { listenAfter: autoListenHandsFree }
    );
  }, [
    audioCuesEnabled,
    autoListenHandsFree,
    finalizeAssessment,
    isGeneratingReport,
    observation,
    onSpeakFeedback,
  ]);

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
        { listenAfter: autoListenHandsFree }
      );
    },
    [
      audioCuesEnabled,
      autoListenHandsFree,
      finalizeAssessment,
      observation,
      onSpeakFeedback,
    ]
  );

  const handleSpokenOrTypedAnswer = useCallback(
    (rawTranscript: string) => {
      const cleaned = rawTranscript.trim();
      if (!cleaned) return;

      if (!isQuestioning || !currentQuestion) {
        return;
      }

      // Support natural mid-flow correction of the immediately preceding answer
      if (isCorrectionUtterance(cleaned) && answers.length > 0) {
        const prev = answers[answers.length - 1];
        const prevDef = SYMPTOM_QUESTIONS[prev.questionId];
        const correctedRecord = buildAnswerRecord(prevDef, 'answered', cleaned);
        const updatedAnswers = [...answers.slice(0, -1), correctedRecord];
        setAnswers(updatedAnswers);

        const nextAfterCorrection = selectNextSymptomQuestion(observation, updatedAnswers);
        const confirm = buildAnswerConfirmation(correctedRecord);

        if (!nextAfterCorrection) {
          void finalizeAssessment(
            updatedAnswers,
            `Updated your previous answer. ${confirm}`
          );
          return;
        }

        setCurrentQuestion(nextAfterCorrection);
        playAudioCue('listen-start', audioCuesEnabled);
        onSpeakFeedback(
          `Updated your previous answer. ${confirm} Continuing with Question ${updatedAnswers.length + 1}: ${nextAfterCorrection.spokenQuestion}`,
          true,
          { listenAfter: autoListenHandsFree }
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
      autoListenHandsFree,
      currentQuestion,
      finalizeAssessment,
      isQuestioning,
      observation,
      onSpeakFeedback,
    ]
  );

  const handleDontKnow = useCallback(() => {
    if (!isQuestioning || !currentQuestion) {
      onSpeakFeedback('No symptom question is currently active.', false);
      return;
    }
    const record = buildAnswerRecord(currentQuestion, 'unknown', "I don't know");
    advanceWithRecord(record, [...answers, record]);
  }, [advanceWithRecord, answers, currentQuestion, isQuestioning, onSpeakFeedback]);

  const handleSkipQuestion = useCallback(() => {
    if (!isQuestioning || !currentQuestion) {
      onSpeakFeedback('No symptom question is currently active.', false);
      return;
    }
    const record = buildAnswerRecord(currentQuestion, 'skipped', 'Skipped');
    advanceWithRecord(record, [...answers, record]);
  }, [advanceWithRecord, answers, currentQuestion, isQuestioning, onSpeakFeedback]);

  const handleRepeatQuestion = useCallback(() => {
    if (!isQuestioning || !currentQuestion) {
      onSpeakFeedback('No symptom question is currently active right now.', false);
      return;
    }
    onSpeakFeedback(
      `Question ${answers.length + 1}: ${currentQuestion.spokenQuestion}`,
      false,
      { listenAfter: autoListenHandsFree }
    );
  }, [
    answers.length,
    autoListenHandsFree,
    currentQuestion,
    isQuestioning,
    onSpeakFeedback,
  ]);

  const handleExplainQuestion = useCallback(() => {
    if (!isQuestioning || !currentQuestion) {
      onSpeakFeedback('No symptom question is currently active to explain.', false);
      return;
    }
    onSpeakFeedback(
      `${currentQuestion.plainExplanation} ${currentQuestion.spokenQuestion}`,
      true,
      { listenAfter: autoListenHandsFree }
    );
  }, [autoListenHandsFree, currentQuestion, isQuestioning, onSpeakFeedback]);

  const handleGoBack = useCallback(() => {
    if (!isQuestioning) {
      onSpeakFeedback('Symptom questioning is not currently active.', false);
      return;
    }
    if (answers.length === 0) {
      onSpeakFeedback(
        `This is already the first question. ${currentQuestion?.spokenQuestion ?? ''}`,
        false,
        { listenAfter: autoListenHandsFree }
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
      { listenAfter: autoListenHandsFree }
    );
  }, [
    answers,
    autoListenHandsFree,
    currentQuestion?.spokenQuestion,
    isQuestioning,
    onSpeakFeedback,
  ]);

  const handleFinishNow = useCallback(() => {
    if (!isQuestioning && !isGeneratingReport) {
      onSpeakFeedback(
        'No symptom questioning session is active right now. Say "Start questions" to begin.',
        false
      );
      return;
    }
    if (isQuestioning) {
      void finalizeAssessment(answers, 'Ending questions here as requested.');
    }
  }, [answers, finalizeAssessment, isGeneratingReport, isQuestioning, onSpeakFeedback]);

  // Voice signal subscriptions from MainDashboard
  const prevSignalsRef = useRef({
    start: startSignal,
    answerSeq: answerEvent.seq,
    repeatQ: repeatQuestionSignal,
    explainQ: explainQuestionSignal,
    skipQ: skipQuestionSignal,
    dontKnow: dontKnowSignal,
    goBack: goBackSignal,
    finish: finishAssessmentSignal,
    why: reportWhySignal,
    whatNow: reportWhatNowSignal,
    seeDoctor: reportSeeDoctorSignal,
    simpler: reportSimplerSignal,
    repeatReport: reportRepeatSignal,
    saveReport: reportSaveSignal,
  });

  useEffect(() => {
    if (startSignal !== prevSignalsRef.current.start) {
      prevSignalsRef.current.start = startSignal;
      startQuestioning();
    }
  }, [startQuestioning, startSignal]);

  useEffect(() => {
    if (answerEvent.seq !== prevSignalsRef.current.answerSeq) {
      prevSignalsRef.current.answerSeq = answerEvent.seq;
      handleSpokenOrTypedAnswer(answerEvent.transcript);
    }
  }, [answerEvent, handleSpokenOrTypedAnswer]);

  useEffect(() => {
    if (repeatQuestionSignal !== prevSignalsRef.current.repeatQ) {
      prevSignalsRef.current.repeatQ = repeatQuestionSignal;
      handleRepeatQuestion();
    }
  }, [handleRepeatQuestion, repeatQuestionSignal]);

  useEffect(() => {
    if (explainQuestionSignal !== prevSignalsRef.current.explainQ) {
      prevSignalsRef.current.explainQ = explainQuestionSignal;
      handleExplainQuestion();
    }
  }, [explainQuestionSignal, handleExplainQuestion]);

  useEffect(() => {
    if (skipQuestionSignal !== prevSignalsRef.current.skipQ) {
      prevSignalsRef.current.skipQ = skipQuestionSignal;
      handleSkipQuestion();
    }
  }, [handleSkipQuestion, skipQuestionSignal]);

  useEffect(() => {
    if (dontKnowSignal !== prevSignalsRef.current.dontKnow) {
      prevSignalsRef.current.dontKnow = dontKnowSignal;
      handleDontKnow();
    }
  }, [dontKnowSignal, handleDontKnow]);

  useEffect(() => {
    if (goBackSignal !== prevSignalsRef.current.goBack) {
      prevSignalsRef.current.goBack = goBackSignal;
      handleGoBack();
    }
  }, [goBackSignal, handleGoBack]);

  useEffect(() => {
    if (finishAssessmentSignal !== prevSignalsRef.current.finish) {
      prevSignalsRef.current.finish = finishAssessmentSignal;
      handleFinishNow();
    }
  }, [finishAssessmentSignal, handleFinishNow]);

  useEffect(() => {
    if (reportWhySignal !== prevSignalsRef.current.why) {
      prevSignalsRef.current.why = reportWhySignal;
      if (!report) {
        onSpeakFeedback(
          'No symptom assessment report is ready yet. Say "Start questions" first.',
          false
        );
      } else {
        onSpeakFeedback(formatAssessmentWhySpeech(report), true);
      }
    }
  }, [onSpeakFeedback, report, reportWhySignal]);

  useEffect(() => {
    if (reportWhatNowSignal !== prevSignalsRef.current.whatNow) {
      prevSignalsRef.current.whatNow = reportWhatNowSignal;
      if (!report) {
        onSpeakFeedback(
          'No symptom assessment report is ready yet. Say "Start questions" first.',
          false
        );
      } else {
        onSpeakFeedback(formatAssessmentWhatNowSpeech(report), true);
      }
    }
  }, [onSpeakFeedback, report, reportWhatNowSignal]);

  useEffect(() => {
    if (reportSeeDoctorSignal !== prevSignalsRef.current.seeDoctor) {
      prevSignalsRef.current.seeDoctor = reportSeeDoctorSignal;
      if (!report) {
        onSpeakFeedback(
          'Complete the symptom questions first, or seek immediate medical care right away if you have any severe or concerning symptoms.',
          false
        );
      } else {
        onSpeakFeedback(formatAssessmentDoctorSpeech(report), true);
      }
    }
  }, [onSpeakFeedback, report, reportSeeDoctorSignal]);

  useEffect(() => {
    if (reportSimplerSignal !== prevSignalsRef.current.simpler) {
      prevSignalsRef.current.simpler = reportSimplerSignal;
      if (!report) {
        onSpeakFeedback(
          'No symptom assessment report is ready to simplify yet. Say "Start questions" first.',
          false
        );
      } else {
        onSpeakFeedback(formatAssessmentSimplerSpeech(report), true);
      }
    }
  }, [onSpeakFeedback, report, reportSimplerSignal]);

  useEffect(() => {
    if (reportRepeatSignal !== prevSignalsRef.current.repeatReport) {
      prevSignalsRef.current.repeatReport = reportRepeatSignal;
      if (!report) {
        onSpeakFeedback(
          'No symptom assessment report is ready yet. Say "Start questions" first.',
          false
        );
      } else {
        onSpeakFeedback(formatFullAssessmentSpeech(report), false);
      }
    }
  }, [onSpeakFeedback, report, reportRepeatSignal]);

  useEffect(() => {
    if (reportSaveSignal !== prevSignalsRef.current.saveReport) {
      prevSignalsRef.current.saveReport = reportSaveSignal;
      if (!report) {
        onSpeakFeedback(
          'No completed assessment report is ready to save yet. Complete symptom questions first.',
          false
        );
        return;
      }
      if (savedCurrentReport) {
        onSpeakFeedback('This assessment summary is already saved on your device.', false);
        return;
      }
      const savedOk = onSaveAssessment?.({
        consentGiven: true,
        report,
        observation,
        answers,
      });
      if (savedOk) {
        setSaveConsentChecked(true);
        setSavedCurrentReport(true);
      }
    }
  }, [
    answers,
    observation,
    onSaveAssessment,
    onSpeakFeedback,
    report,
    reportSaveSignal,
    savedCurrentReport,
  ]);

  const handleSubmitTypedAnswer = (event: React.FormEvent) => {
    event.preventDefault();
    if (!localAnswerInput.trim()) return;
    const text = localAnswerInput.trim();
    setLocalAnswerInput('');
    handleSpokenOrTypedAnswer(text);
  };

  const renderUrgencyIcon = (level: UrgencyLevel) => {
    if (level === 'emergency') {
      return <AlertOctagon className="w-5 h-5 shrink-0" aria-hidden="true" />;
    }
    if (level === 'urgent') {
      return <AlertTriangle className="w-5 h-5 shrink-0" aria-hidden="true" />;
    }
    if (level === 'prompt_review') {
      return <Stethoscope className="w-5 h-5 shrink-0" aria-hidden="true" />;
    }
    return <CheckCircle2 className="w-5 h-5 shrink-0" aria-hidden="true" />;
  };

  return (
    <section
      id="assessment-section"
      ref={sectionRef}
      tabIndex={-1}
      aria-labelledby="assessment-heading"
      className="rounded-3xl bg-white dark:bg-[#140f24] border border-violet-200/80 dark:border-violet-800/50 shadow-sm p-5 sm:p-6 space-y-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2
            id="assessment-heading"
            className="text-lg sm:text-xl font-bold text-[#171226] dark:text-white"
          >
            Voice Symptom Assessment &amp; Safety Guidance
          </h2>
          <p
            className={`mt-1 text-[#534b6d] dark:text-violet-300 ${
              textScale === 'large' ? 'text-base' : 'text-sm'
            }`}
          >
            Adaptive follow-up questions paired with a dedicated medical safety check.
          </p>
        </div>

        {/* Unboxed plain-text status metadata */}
        <div
          role="status"
          aria-live="polite"
          className="text-xs sm:text-sm font-semibold text-violet-900 dark:text-violet-200 tabular-nums"
        >
          {isGeneratingReport
            ? 'Safety check in progress'
            : isQuestioning
              ? `Questioning active · Answered ${answers.length}`
              : report
                ? `${report.urgencyLabel} · ${report.generatedAt}`
                : observation
                  ? 'Observation ready · Follow-up available'
                  : 'Ready anytime by voice'}
        </div>
      </div>

      {/* Idle / Ready to start callout */}
      {!isQuestioning && !isGeneratingReport && !report && (
        <div className="rounded-2xl bg-[#f7f4ff] dark:bg-[#1b1430] border border-violet-200/80 dark:border-violet-800/60 p-4 space-y-3">
          <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
            {observation
              ? 'Your image observation is ready. Start tailored follow-up questions so Glow-A-Eye can check for safety warning signs and give structured guidance.'
              : 'For the clearest guidance, analyze a photograph first—or say "Start questions" anytime to answer symptom and safety questions by voice.'}
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={startQuestioning}
              className="min-h-[48px] px-5 py-2.5 rounded-xl bg-violet-700 hover:bg-violet-800 text-white font-semibold text-sm sm:text-base inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <MessageSquarePlus className="w-5 h-5" aria-hidden="true" />
              <span>Start Symptom Questions</span>
            </button>

            <label className="min-h-[44px] inline-flex items-center gap-2 text-xs sm:text-sm font-medium text-[#2e2745] dark:text-violet-100 cursor-pointer">
              <input
                type="checkbox"
                checked={autoListenHandsFree}
                onChange={(e) => setAutoListenHandsFree(e.target.checked)}
                className="w-4 h-4 accent-violet-700"
              />
              <span>Auto-listen after each question</span>
            </label>
          </div>
        </div>
      )}

      {/* Active Voice-First Questioning View */}
      {isQuestioning && currentQuestion && (
        <div className="rounded-2xl bg-[#f7f4ff] dark:bg-[#1b1430] border border-violet-300 dark:border-violet-700 p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm text-[#534b6d] dark:text-violet-300 tabular-nums">
            <span className="font-semibold text-violet-900 dark:text-violet-200">
              Question {answers.length + 1} · {currentQuestion.topicLabel}
            </span>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoListenHandsFree}
                onChange={(e) => setAutoListenHandsFree(e.target.checked)}
                className="w-4 h-4 accent-violet-700"
              />
              <span>Auto-listen</span>
            </label>
          </div>

          <p
            className={`font-bold text-[#171226] dark:text-white ${
              textScale === 'large' ? 'text-xl' : 'text-base sm:text-lg'
            }`}
          >
            {currentQuestion.spokenQuestion}
          </p>

          <p className="text-xs sm:text-sm text-[#473f61] dark:text-violet-200">
            Voice commands: &ldquo;I don&rsquo;t know&rdquo;, &ldquo;Skip this question&rdquo;,
            &ldquo;Repeat the question&rdquo;, &ldquo;Explain what you mean&rdquo;, &ldquo;Go
            back&rdquo;, or &ldquo;Finish assessment&rdquo;.
          </p>

          {/* Accessible fallback text/button controls (voice remains primary) */}
          <form onSubmit={handleSubmitTypedAnswer} className="flex flex-col sm:flex-row gap-2.5">
            <label htmlFor="symptom-answer-input" className="sr-only">
              Type your answer to the current symptom question
            </label>
            <input
              id="symptom-answer-input"
              type="text"
              value={localAnswerInput}
              onChange={(e) => setLocalAnswerInput(e.target.value)}
              placeholder="Speak or type your answer here..."
              className="flex-1 min-h-[44px] px-4 py-2 rounded-xl bg-white dark:bg-[#140f24] border border-violet-300 dark:border-violet-700 text-sm text-[#171226] dark:text-white placeholder:text-[#6d6488] dark:placeholder:text-violet-400"
            />
            <button
              type="submit"
              className="min-h-[44px] px-4 py-2 rounded-xl bg-violet-700 hover:bg-violet-800 text-white font-semibold text-sm cursor-pointer whitespace-nowrap shrink-0"
            >
              Submit Answer
            </button>
          </form>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleRepeatQuestion}
              className="min-h-[44px] px-3.5 py-2 rounded-xl bg-white hover:bg-violet-50 dark:bg-[#140f24] dark:hover:bg-violet-900/50 border border-violet-300 dark:border-violet-700 text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Volume2 className="w-4 h-4" aria-hidden="true" />
              <span>Repeat Question</span>
            </button>

            <button
              type="button"
              onClick={handleExplainQuestion}
              className="min-h-[44px] px-3.5 py-2 rounded-xl bg-white hover:bg-violet-50 dark:bg-[#140f24] dark:hover:bg-violet-900/50 border border-violet-300 dark:border-violet-700 text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              <HelpCircle className="w-4 h-4" aria-hidden="true" />
              <span>Explain Meanings</span>
            </button>

            <button
              type="button"
              onClick={handleDontKnow}
              className="min-h-[44px] px-3.5 py-2 rounded-xl bg-white hover:bg-violet-50 dark:bg-[#140f24] dark:hover:bg-violet-900/50 border border-violet-300 dark:border-violet-700 text-xs sm:text-sm font-semibold cursor-pointer whitespace-nowrap shrink-0"
            >
              I Don&rsquo;t Know
            </button>

            <button
              type="button"
              onClick={handleSkipQuestion}
              className="min-h-[44px] px-3.5 py-2 rounded-xl bg-white hover:bg-violet-50 dark:bg-[#140f24] dark:hover:bg-violet-900/50 border border-violet-300 dark:border-violet-700 text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              <SkipForward className="w-4 h-4" aria-hidden="true" />
              <span>Skip</span>
            </button>

            <button
              type="button"
              onClick={handleGoBack}
              disabled={answers.length === 0}
              className="min-h-[44px] px-3.5 py-2 rounded-xl bg-white hover:bg-violet-50 disabled:opacity-50 dark:bg-[#140f24] dark:hover:bg-violet-900/50 border border-violet-300 dark:border-violet-700 text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
              <span>Go Back</span>
            </button>

            <button
              type="button"
              onClick={handleFinishNow}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-[#171226] text-white dark:bg-white dark:text-[#171226] text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 hover:opacity-90 cursor-pointer whitespace-nowrap shrink-0"
            >
              <ClipboardCheck className="w-4 h-4" aria-hidden="true" />
              <span>Finish Assessment</span>
            </button>
          </div>

          {answers.length > 0 && (
            <div className="pt-3 border-t border-violet-200/80 dark:border-violet-800/60 space-y-1">
              <h3 className="text-xs font-bold text-violet-900 dark:text-violet-200">
                Answers Recorded So Far
              </h3>
              <ul className="space-y-1 text-xs sm:text-sm text-[#3d3556] dark:text-violet-200">
                {answers.map((ans) => (
                  <li key={`${ans.questionId}-${ans.answeredAt}`}>{ans.normalizedSummary}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Report Generation Loading State */}
      {isGeneratingReport && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-2xl bg-[#f7f4ff] dark:bg-[#1b1430] border border-violet-300 dark:border-violet-700 p-5 flex items-center gap-3 text-violet-950 dark:text-violet-100"
        >
          <Loader2
            className={`w-5 h-5 shrink-0 ${!reducedMotion ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
            Combining image observations, your answers, and Medical Safety Engine checks...
          </p>
        </div>
      )}

      {/* Structured Safety-Enforced Final Report */}
      {report && !isQuestioning && !isGeneratingReport && (
        <div
          role="region"
          aria-label="Safety-checked skin symptom assessment report"
          className="space-y-4"
        >
          {/* Non-Hue-Only Medical Safety Engine Urgency Banner */}
          <div
            role="alert"
            className={`rounded-2xl border p-4 space-y-2 ${getUrgencyBannerClasses(
              report.urgencyLevel
            )}`}
          >
            <div className="flex items-start gap-2.5">
              {renderUrgencyIcon(report.urgencyLevel)}
              <div className="space-y-1">
                <h3 className="text-sm sm:text-base font-bold">{report.urgencyLabel}</h3>
                <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
                  {report.actionHeadline}
                </p>
              </div>
            </div>

            {report.triggeredWarningSigns.length > 0 && (
              <ul className="list-disc list-inside text-xs sm:text-sm space-y-0.5 pt-1">
                {report.triggeredWarningSigns.map((sign, i) => (
                  <li key={`${sign}-${i}`}>{sign}</li>
                ))}
              </ul>
            )}
          </div>

          {/* 7 Required Structured Report Sections */}
          <div className="rounded-2xl bg-[#f7f4ff] dark:bg-[#1b1430] border border-violet-200 dark:border-violet-800 p-4 sm:p-5 space-y-4">
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-violet-900 dark:text-violet-200">
                1. What the photograph appears to show
              </h3>
              <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
                {report.whatPhotographShows}
              </p>
            </div>

            <div className="space-y-1 pt-3 border-t border-violet-200/80 dark:border-violet-800/60">
              <h3 className="text-sm font-bold text-violet-900 dark:text-violet-200">
                2. What your answers indicate
              </h3>
              <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
                {report.whatAnswersIndicate}
              </p>
            </div>

            <div className="space-y-1 pt-3 border-t border-violet-200/80 dark:border-violet-800/60">
              <h3 className="text-sm font-bold text-violet-900 dark:text-violet-200">
                3. Possible explanations (with uncertainty stated)
              </h3>
              <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
                {report.possibleExplanations}
              </p>
            </div>

            <div className="space-y-1 pt-3 border-t border-violet-200/80 dark:border-violet-800/60">
              <h3 className="text-sm font-bold text-violet-900 dark:text-violet-200">
                4. Safe general care suggestions
              </h3>
              <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
                {report.safeGeneralCare}
              </p>
            </div>

            <div className="space-y-1 pt-3 border-t border-violet-200/80 dark:border-violet-800/60">
              <h3 className="text-sm font-bold text-violet-900 dark:text-violet-200">
                5. What you should avoid
              </h3>
              <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
                {report.whatToAvoid}
              </p>
            </div>

            <div className="space-y-1 pt-3 border-t border-violet-200/80 dark:border-violet-800/60">
              <h3 className="text-sm font-bold text-violet-900 dark:text-violet-200">
                6. Professional medical assessment recommendation
              </h3>
              <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
                {report.medicalAssessmentRecommendation}
              </p>
            </div>

            <div className="space-y-1 pt-3 border-t border-violet-200/80 dark:border-violet-800/60">
              <h3 className="text-sm font-bold text-violet-900 dark:text-violet-200">
                7. Warning signs that require escalation
              </h3>
              <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
                {report.escalationWarningSigns}
              </p>
            </div>

            {/* Educational Notice */}
            <div className="flex items-start gap-2.5 pt-3 border-t border-violet-200/80 dark:border-violet-800/60 text-[#2e2745] dark:text-violet-200">
              <ShieldAlert
                className="w-4 h-4 shrink-0 mt-0.5 text-violet-700 dark:text-violet-300"
                aria-hidden="true"
              />
              <p className="text-xs sm:text-sm font-medium">{report.educationalDisclaimer}</p>
            </div>

            {/* Voice-Mirrored Follow-up Action Controls */}
            <div className="flex flex-wrap items-center gap-2.5 pt-3 border-t border-violet-200/80 dark:border-violet-800/60">
              <button
                type="button"
                onClick={() => onSpeakFeedback(formatFullAssessmentSpeech(report), false)}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-violet-700 hover:bg-violet-800 text-white font-semibold text-xs sm:text-sm inline-flex items-center gap-2 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Volume2 className="w-4 h-4" aria-hidden="true" />
                <span>Repeat My Assessment</span>
              </button>

              <button
                type="button"
                onClick={() => onSpeakFeedback(formatAssessmentWhySpeech(report), true)}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-violet-100 hover:bg-violet-200 dark:bg-violet-900/60 dark:hover:bg-violet-800/70 text-violet-950 dark:text-violet-100 border border-violet-300 dark:border-violet-700 font-semibold text-xs sm:text-sm cursor-pointer whitespace-nowrap shrink-0"
              >
                Why Do You Think That?
              </button>

              <button
                type="button"
                onClick={() => onSpeakFeedback(formatAssessmentWhatNowSpeech(report), true)}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-violet-100 hover:bg-violet-200 dark:bg-violet-900/60 dark:hover:bg-violet-800/70 text-violet-950 dark:text-violet-100 border border-violet-300 dark:border-violet-700 font-semibold text-xs sm:text-sm cursor-pointer whitespace-nowrap shrink-0"
              >
                What Should I Do Now?
              </button>

              <button
                type="button"
                onClick={() => onSpeakFeedback(formatAssessmentDoctorSpeech(report), true)}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-white hover:bg-violet-50 dark:bg-[#140f24] dark:hover:bg-violet-900/50 text-[#171226] dark:text-violet-100 border border-violet-300 dark:border-violet-700 font-semibold text-xs sm:text-sm cursor-pointer whitespace-nowrap shrink-0"
              >
                Should I See a Doctor?
              </button>

              <button
                type="button"
                onClick={() => onSpeakFeedback(formatAssessmentSimplerSpeech(report), true)}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-white hover:bg-violet-50 dark:bg-[#140f24] dark:hover:bg-violet-900/50 text-[#171226] dark:text-violet-100 border border-violet-300 dark:border-violet-700 font-semibold text-xs sm:text-sm cursor-pointer whitespace-nowrap shrink-0"
              >
                Explain Simply
              </button>

              <button
                type="button"
                onClick={startQuestioning}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-[#171226] text-white dark:bg-white dark:text-[#171226] font-semibold text-xs sm:text-sm inline-flex items-center gap-1.5 hover:opacity-90 cursor-pointer whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-4 h-4" aria-hidden="true" />
                <span>Restart Questions</span>
              </button>
            </div>

            {/* Explicit Consent Save to On-Device History */}
            <div className="pt-3 border-t border-violet-200/80 dark:border-violet-800/60 space-y-3">
              <label className="flex items-start gap-2.5 text-xs sm:text-sm text-[#2e2745] dark:text-violet-100 cursor-pointer">
                <input
                  type="checkbox"
                  checked={saveConsentChecked}
                  disabled={savedCurrentReport}
                  onChange={(e) => setSaveConsentChecked(e.target.checked)}
                  className="w-4 h-4 mt-0.5 accent-violet-700 shrink-0"
                />
                <span>
                  I consent to save this assessment summary locally on this device (date, symptom answers, text observations, and recommendations only—no photograph is saved).
                </span>
              </label>

              <div>
                <button
                  type="button"
                  disabled={!saveConsentChecked || savedCurrentReport}
                  onClick={() => {
                    if (!report) return;
                    const savedOk = onSaveAssessment?.({
                      consentGiven: saveConsentChecked,
                      report,
                      observation,
                      answers,
                    });
                    if (savedOk) {
                      setSavedCurrentReport(true);
                    }
                  }}
                  className="min-h-[44px] px-4 py-2 rounded-xl bg-violet-700 hover:bg-violet-800 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold text-xs sm:text-sm inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  {savedCurrentReport ? (
                    <>
                      <BookmarkCheck className="w-4 h-4" aria-hidden="true" />
                      <span>Saved Locally (No Photo Stored)</span>
                    </>
                  ) : (
                    <>
                      <BookmarkPlus className="w-4 h-4" aria-hidden="true" />
                      <span>Save Assessment Locally</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
