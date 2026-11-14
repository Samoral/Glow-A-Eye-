import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, AudioLines, Mic, PauseCircle, RotateCw, Volume2 } from 'lucide-react';
import {
  AssistantSettings,
  AssistantStatus,
  VoiceCommandAction,
} from '../types/assistant';
import { useVoiceAssistant } from '../hooks/useVoiceAssistant';
import { useCameraSkinAnalysis } from '../hooks/useCameraSkinAnalysis';
import { useSymptomAssessment } from '../hooks/useSymptomAssessment';
import { ABOUT_SPOKEN_SUMMARY } from '../services/voiceAssistantLogic';
import { VoiceOrb } from './VoiceOrb';

const DEFAULT_SETTINGS: AssistantSettings = {
  speechRate: 1,
  selectedVoiceURI: '',
  autoAnnounceMic: true,
  audioCuesEnabled: true,
  theme: 'light',
  textScale: 'standard',
};

const STATUS_DISPLAY: Record<
  AssistantStatus,
  { label: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  idle: { label: 'Standby', Icon: Mic },
  listening: { label: 'Listening', Icon: Mic },
  processing: { label: 'Processing', Icon: AudioLines },
  speaking: { label: 'Speaking', Icon: Volume2 },
  interrupted: { label: 'Interrupted', Icon: PauseCircle },
  resuming: { label: 'Resuming', Icon: RotateCw },
  error: { label: 'Attention Needed', Icon: AlertCircle },
};

export const MainDashboard: React.FC = () => {
  const [hasStarted, setHasStarted] = useState(false);
  const [settings, setSettings] = useState<AssistantSettings>(() => {
    if (typeof window === 'undefined') return DEFAULT_SETTINGS;
    try {
      const saved = window.localStorage.getItem('glow_a_eye_settings');
      if (saved) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
      }
    } catch {
      // Ignore storage read errors
    }
    return DEFAULT_SETTINGS;
  });

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', settings.theme === 'dark');
    }
    try {
      window.localStorage.setItem('glow_a_eye_settings', JSON.stringify(settings));
    } catch {
      // Ignore storage write errors
    }
  }, [settings]);

  const speakFeedbackImplRef = useRef<
    (
      text: string,
      alsoLog?: boolean,
      options?: { listenAfter?: boolean; onDone?: () => void }
    ) => void
  >(() => {});
  const isAssistantSpeakingImplRef = useRef<() => boolean>(() => false);
  const isUserSpeakingImplRef = useRef<() => boolean>(() => false);

  const handleSpeakFeedback = useCallback(
    (
      text: string,
      alsoLog?: boolean,
      options?: { listenAfter?: boolean; onDone?: () => void }
    ) => {
      speakFeedbackImplRef.current(text, alsoLog, options);
    },
    []
  );

  const handleIsAssistantSpeaking = useCallback(
    () => isAssistantSpeakingImplRef.current(),
    []
  );

  const handleIsUserSpeaking = useCallback(
    () => isUserSpeakingImplRef.current(),
    []
  );

  const camera = useCameraSkinAnalysis({
    audioCuesEnabled: settings.audioCuesEnabled,
    onSpeakFeedback: handleSpeakFeedback,
    isAssistantSpeaking: handleIsAssistantSpeaking,
    isUserSpeaking: handleIsUserSpeaking,
  });

  const assessment = useSymptomAssessment({
    observation: camera.observation,
    audioCuesEnabled: settings.audioCuesEnabled,
    onSpeakFeedback: handleSpeakFeedback,
  });

  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const assessmentRef = useRef(assessment);
  assessmentRef.current = assessment;
  const voiceRef = useRef<ReturnType<typeof useVoiceAssistant> | null>(null);

  const handleVoiceAction = useCallback((action: VoiceCommandAction) => {
    switch (action.type) {
      case 'open_camera':
      case 'activate_camera':
        void cameraRef.current.startCamera();
        break;
      case 'close_camera':
      case 'cancel_camera':
        cameraRef.current.stopCameraSession(
          'Camera cancelled and temporary image discarded. I am listening whenever you are ready.',
          true
        );
        break;
      case 'capture_photo':
        cameraRef.current.handleCapture();
        break;
      case 'retake_photo':
        cameraRef.current.handleRetake();
        break;
      case 'repeat':
        if (cameraRef.current.isPreviewVisible) {
          cameraRef.current.repeatLastGuidance();
        }
        break;
      case 'pause_for_user':
        if (cameraRef.current.isPreviewVisible) {
          cameraRef.current.pauseGuidance();
        }
        voiceRef.current?.pauseForUserSpeech();
        break;
      case 'resume_conversation':
        if (cameraRef.current.isPreviewVisible) {
          cameraRef.current.resumeGuidance();
          voiceRef.current?.speakCustomFeedback('Resuming camera guidance.', false, {
            listenAfter: true,
          });
        } else if (assessmentRef.current.isQuestioning) {
          assessmentRef.current.handleRepeatQuestion();
        } else {
          voiceRef.current?.resumeInterruptedSpeech();
        }
        break;
      case 'correct_last_statement':
        assessmentRef.current.handleCorrectionByVoice(action.transcript);
        break;
      case 'explain_observation_term':
        assessmentRef.current.speakTermWithContext(action.term || action.transcript || '');
        break;
      case 'repeat_differently':
        if (assessmentRef.current.isQuestioning) {
          assessmentRef.current.handleExplainQuestion();
        } else if (assessmentRef.current.hasAssessmentReport) {
          assessmentRef.current.speakReportSimpler();
        } else if (cameraRef.current.hasAnalysis) {
          cameraRef.current.speakObservationSimpler();
        } else if (cameraRef.current.isPreviewVisible) {
          cameraRef.current.speakGuide(true);
        } else {
          voiceRef.current?.rephraseLastResponse();
        }
        break;
      case 'repeat_camera_guide':
        cameraRef.current.speakGuide(false);
        break;
      case 'simplify_camera_guide':
        cameraRef.current.speakGuide(true);
        break;
      case 'check_camera_framing':
        cameraRef.current.handleCheckLiveFraming();
        break;
      case 'camera_help':
        cameraRef.current.speakCameraHelp();
        break;
      case 'analyze_photo':
        void cameraRef.current.handleAnalyzePhoto();
        break;
      case 'repeat_observations':
        cameraRef.current.speakObservationRepeat();
        break;
      case 'explain_simpler':
        cameraRef.current.speakObservationSimpler();
        break;
      case 'what_could_cause':
        cameraRef.current.speakObservationCauses();
        break;
      case 'what_next':
        cameraRef.current.speakObservationNextSteps();
        break;
      case 'start_questions':
        assessmentRef.current.startQuestioning();
        break;
      case 'symptom_answer':
        if (action.transcript) {
          assessmentRef.current.handleSpokenAnswer(action.transcript);
        }
        break;
      case 'symptom_repeat_question':
        assessmentRef.current.handleRepeatQuestion();
        break;
      case 'symptom_explain_question':
        assessmentRef.current.handleExplainQuestion();
        break;
      case 'symptom_skip_question':
        assessmentRef.current.handleSkipQuestion();
        break;
      case 'symptom_dont_know':
        assessmentRef.current.handleDontKnow();
        break;
      case 'symptom_go_back':
        assessmentRef.current.handleGoBack();
        break;
      case 'symptom_finish_assessment':
        assessmentRef.current.handleFinishNow();
        break;
      case 'assessment_why':
        if (assessmentRef.current.hasAssessmentReport) {
          assessmentRef.current.speakReportWhy();
        } else if (cameraRef.current.hasAnalysis) {
          cameraRef.current.speakObservationCauses();
        } else {
          assessmentRef.current.speakReportWhy();
        }
        break;
      case 'assessment_what_now':
        assessmentRef.current.speakReportWhatNow();
        break;
      case 'assessment_see_doctor':
        assessmentRef.current.speakReportDoctor();
        break;
      case 'assessment_explain_simpler':
        assessmentRef.current.speakReportSimpler();
        break;
      case 'assessment_repeat':
        assessmentRef.current.speakReportRepeat();
        break;
      case 'save_assessment':
        assessmentRef.current.saveCurrentReportByVoice();
        break;
      case 'read_history':
        assessmentRef.current.readSavedHistory();
        break;
      case 'delete_history':
        assessmentRef.current.deleteSavedHistory();
        break;
      case 'open_about':
        voiceRef.current?.speakCustomFeedback(ABOUT_SPOKEN_SUMMARY, true, {
          listenAfter: true,
        });
        break;
      case 'set_rate_slow':
        setSettings((prev) => ({ ...prev, speechRate: 0.85 }));
        break;
      case 'set_rate_normal':
        setSettings((prev) => ({ ...prev, speechRate: 1 }));
        break;
      case 'set_rate_fast':
        setSettings((prev) => ({ ...prev, speechRate: 1.15 }));
        break;
      case 'enable_dark_theme':
        setSettings((prev) => ({ ...prev, theme: 'dark' }));
        break;
      case 'enable_light_theme':
        setSettings((prev) => ({ ...prev, theme: 'light' }));
        break;
      case 'enable_large_text':
        setSettings((prev) => ({ ...prev, textScale: 'large' }));
        break;
      case 'end_conversation':
        cameraRef.current.stopCameraSession(undefined, false, true);
        assessmentRef.current.resetAssessment();
        voiceRef.current?.endConversation();
        setHasStarted(false);
        break;
      case 'restart_conversation':
        cameraRef.current.stopCameraSession(undefined, false, true);
        assessmentRef.current.resetAssessment();
        setHasStarted(true);
        void voiceRef.current?.beginConversation(
          'Starting a fresh conversation with Glow-A-Eye. Tell me when you are ready for a skin examination, or say help.'
        );
        break;
      default:
        break;
    }
  }, []);

  const awaitingAssessmentStartConfirm =
    camera.observation !== null &&
    !assessment.isQuestioning &&
    !assessment.hasAssessmentReport;

  const handleSpeechInterrupted = useCallback(() => {
    if (cameraRef.current.cameraState === 'countdown') {
      cameraRef.current.pauseGuidance();
    }
  }, []);

  const voice = useVoiceAssistant({
    settings,
    cameraContext: {
      isCameraActive: camera.isPreviewVisible || camera.isActiveSession,
      hasCapturedPhoto: camera.hasCapturedPhoto,
      hasAnalysis: camera.hasAnalysis,
      isQuestioningActive: assessment.isQuestioning,
      hasAssessmentReport: assessment.hasAssessmentReport,
      awaitingAssessmentStartConfirm,
    },
    onAction: handleVoiceAction,
    onSpeechInterrupted: handleSpeechInterrupted,
  });

  voiceRef.current = voice;
  speakFeedbackImplRef.current = voice.speakCustomFeedback;
  isAssistantSpeakingImplRef.current = voice.isAssistantSpeaking;
  isUserSpeakingImplRef.current = voice.isUserSpeaking;

  const effectiveStatus: AssistantStatus =
    camera.isAnalyzing || assessment.isGeneratingReport || voice.status === 'processing'
      ? 'processing'
      : voice.status;

  const isAssessmentProtected =
    camera.isPreviewVisible ||
    camera.isActiveSession ||
    camera.hasCapturedPhoto ||
    camera.isAnalyzing ||
    assessment.isQuestioning ||
    assessment.isGeneratingReport;

  const handleSurfaceActivate = useCallback(() => {
    if (!hasStarted) {
      setHasStarted(true);
      void voice.beginConversation();
      return;
    }

    if (effectiveStatus === 'processing') {
      return;
    }

    if (voice.isCapturingInterruption()) {
      voice.finishInterruptionCaptureIfActive();
      return;
    }

    // Protect active camera capture and symptom questioning against accidental taps
    if (isAssessmentProtected) {
      if (effectiveStatus === 'speaking') {
        voice.interruptNow();
      } else if (effectiveStatus === 'idle' || effectiveStatus === 'error') {
        void voice.startListening();
      }
      return;
    }

    if (effectiveStatus === 'listening') {
      voice.stopListening(true);
    } else if (effectiveStatus === 'speaking') {
      voice.interruptNow();
    } else {
      void voice.startListening();
    }
  }, [effectiveStatus, hasStarted, isAssessmentProtected, voice]);

  // Keyboard accessibility: Escape cancels active countdown, speaking, or listening
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (cameraRef.current.isPreviewVisible || cameraRef.current.isActiveSession) {
          event.preventDefault();
          cameraRef.current.stopCameraSession();
        } else if (voice.status === 'listening') {
          event.preventDefault();
          voice.stopListening(true);
        } else if (voice.status === 'speaking') {
          event.preventDefault();
          voice.interruptNow();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [voice]);

  const { label: statusLabel, Icon: StatusIcon } = STATUS_DISPLAY[effectiveStatus];

  const subtleInstruction = !hasStarted
    ? 'Tap anywhere to begin.'
    : effectiveStatus === 'interrupted'
      ? 'Interrupted — go ahead, I am listening.'
      : effectiveStatus === 'resuming'
        ? 'Resuming conversation...'
        : effectiveStatus === 'listening'
          ? voice.interimTranscript
            ? `“${voice.interimTranscript}”`
            : 'Listening — speak naturally.'
          : effectiveStatus === 'processing'
            ? camera.isAnalyzing
              ? 'Examining photograph...'
              : assessment.isGeneratingReport
                ? 'Evaluating safety...'
                : 'Processing...'
            : effectiveStatus === 'speaking'
              ? isAssessmentProtected
                ? 'Speaking — speak anytime to interrupt.'
                : 'Speaking — speak or tap anytime to interrupt.'
              : effectiveStatus === 'error'
                ? voice.statusDetail
                : isAssessmentProtected
                  ? 'Assessment active. Tap to resume listening.'
                  : 'Tap anywhere to speak.';

  const surfaceAriaLabel = !hasStarted
    ? 'Glow-A-Eye voice companion. Tap anywhere to begin.'
    : effectiveStatus === 'interrupted'
      ? 'Glow-A-Eye speech interrupted. Listening for your question.'
      : effectiveStatus === 'resuming'
        ? 'Glow-A-Eye is resuming your previous topic.'
        : effectiveStatus === 'listening'
          ? isAssessmentProtected
            ? 'Glow-A-Eye is listening during your skin assessment.'
            : 'Glow-A-Eye is listening. Tap anywhere to stop listening.'
          : effectiveStatus === 'processing'
            ? 'Glow-A-Eye is processing your request. Please wait.'
            : effectiveStatus === 'speaking'
              ? isAssessmentProtected
                ? 'Glow-A-Eye is speaking assessment guidance. Speak anytime to interrupt.'
                : 'Glow-A-Eye is speaking. Speak or tap anywhere to interrupt and speak.'
              : effectiveStatus === 'error'
                ? `${voice.statusDetail} Tap anywhere to try again.`
                : 'Glow-A-Eye standby. Tap anywhere to speak.';

  const isLargeText = settings.textScale === 'large';
  const isReadyFrame =
    camera.cameraState === 'target_detected' ||
    camera.cameraState === 'checking_stability' ||
    camera.cameraState === 'countdown';

  return (
    <div className="min-h-[100dvh] w-full bg-gradient-to-b from-[#faf8ff] via-[#f5f0ff] to-[#ede5ff] dark:from-[#0b0814] dark:via-[#110c21] dark:to-[#080510] text-[#171226] dark:text-[#f5f2ff] transition-colors duration-300">
      {/* Assertive live region for TalkBack / screen-reader spoken state announcements */}
      <div
        role="status"
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
      >
        {voice.liveAnnouncement}
      </div>

      <main className="min-h-[100dvh] w-full flex flex-col">
        {/* Live skin examination preview: mounted only while camera preview is active */}
        {camera.isPreviewVisible && (
          <section
            aria-label="Live skin examination camera preview"
            className="flex-1 w-full max-w-2xl mx-auto flex flex-col items-center justify-between px-5 py-6 sm:py-10 gap-5"
          >
            <div className="w-full flex items-center justify-between gap-3">
              <span className="text-sm sm:text-base font-semibold tracking-wider uppercase text-violet-900/85 dark:text-violet-200/90">
                Glow-A-Eye
              </span>

              <div
                role="status"
                aria-live="polite"
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-violet-900/90 text-white dark:bg-violet-800/90 text-xs sm:text-sm font-semibold shadow-sm"
              >
                <span
                  aria-hidden="true"
                  className="w-2 h-2 rounded-full bg-emerald-400 motion-safe:animate-pulse"
                />
                <span>Camera Active · {camera.cameraStateLabel}</span>
              </div>
            </div>

            <div
              className={`relative w-full aspect-[4/3] rounded-3xl overflow-hidden bg-[#0b0814] shadow-xl border-2 transition-colors ${
                isReadyFrame
                  ? 'border-emerald-400 dark:border-emerald-400'
                  : 'border-violet-300/80 dark:border-violet-700/80'
              }`}
            >
              <video
                ref={camera.videoRef}
                autoPlay
                playsInline
                muted
                tabIndex={-1}
                aria-label="Live camera preview for voice-guided skin photography"
                className="w-full h-full object-cover"
              />

              {/* Visual framing zone indicator (matches inner 55% analysis ROI) */}
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-[22%] rounded-2xl border-2 border-dashed transition-colors ${
                  isReadyFrame
                    ? 'border-emerald-300/95 bg-emerald-500/5'
                    : 'border-white/75'
                }`}
              />

              {/* Initializing / Permission overlay */}
              {(camera.cameraState === 'requesting_permission' ||
                camera.cameraState === 'initializing_camera') && (
                <div className="absolute inset-0 flex items-center justify-center bg-[#0b0814]/60 backdrop-blur-[2px] px-6 text-center">
                  <p className="text-sm sm:text-base font-medium text-white">
                    {camera.cameraState === 'requesting_permission'
                      ? 'Requesting camera permission...'
                      : 'Initialising rear camera...'}
                  </p>
                </div>
              )}

              {/* Countdown visual overlay */}
              {camera.cameraState === 'countdown' &&
                camera.countdownSeconds !== null && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0b0814]/35 pointer-events-none">
                    <div className="w-24 h-24 rounded-full bg-violet-900/90 border-2 border-emerald-300 flex items-center justify-center shadow-2xl">
                      <span className="text-4xl font-bold tabular-nums text-white">
                        {camera.countdownSeconds}
                      </span>
                    </div>
                    <span className="mt-3 px-3 py-1 rounded-full bg-[#0b0814]/75 text-white text-xs sm:text-sm font-semibold">
                      Hold still — capturing automatically
                    </span>
                  </div>
                )}

              {/* Live CV condition pill for sighted judges & low-vision users */}
              {camera.lastEvaluation?.checkPerformed &&
                camera.cameraState !== 'countdown' && (
                  <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2 pointer-events-none">
                    <span className="px-3 py-1 rounded-full bg-[#0b0814]/75 text-white text-xs font-medium backdrop-blur-xs">
                      {camera.lastEvaluation.statusLabel}
                    </span>
                    <span className="px-2.5 py-1 rounded-full bg-[#0b0814]/65 text-violet-200 text-xs font-mono tabular-nums">
                      {camera.lastEvaluation.category === 'skin_ready'
                        ? 'Framing OK'
                        : camera.lastEvaluation.category === 'no_skin_visible'
                          ? 'No Skin'
                          : 'Adjust'}
                    </span>
                  </div>
                )}
            </div>

            <div className="w-full flex flex-col items-center text-center gap-3">
              <p
                className={`max-w-lg leading-relaxed font-medium text-[#171226] dark:text-violet-100 ${
                  isLargeText ? 'text-lg' : 'text-sm sm:text-base'
                }`}
              >
                {camera.guidanceText || 'Hold camera one hand’s length from your skin.'}
              </p>

              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => void voice.startListening()}
                  disabled={effectiveStatus === 'listening' || effectiveStatus === 'processing'}
                  className="min-h-[44px] px-4 py-2 rounded-full bg-violet-700 hover:bg-violet-800 disabled:opacity-60 text-white text-sm font-semibold inline-flex items-center gap-2 cursor-pointer transition-colors"
                >
                  <StatusIcon className="w-4 h-4 shrink-0" />
                  <span>
                    {effectiveStatus === 'listening'
                      ? voice.interimTranscript
                        ? `“${voice.interimTranscript}”`
                        : 'Listening...'
                      : 'Speak Command'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={camera.handleCancel}
                  className="min-h-[44px] px-4 py-2 rounded-full bg-white/90 hover:bg-white dark:bg-[#1a1330] dark:hover:bg-[#231a40] text-[#171226] dark:text-violet-100 border border-violet-300 dark:border-violet-700 text-sm font-semibold cursor-pointer transition-colors"
                >
                  Cancel Camera
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Minimalist main voice-first interface when camera preview is closed */}
        {!camera.isPreviewVisible && (
          <button
            type="button"
            onClick={handleSurfaceActivate}
            aria-label={surfaceAriaLabel}
            className="w-full min-h-[100dvh] flex flex-col items-center justify-between px-6 py-10 sm:py-14 text-center cursor-pointer select-none focus-visible:outline-offset-[-6px]"
          >
            {/* 1. Small Glow-A-Eye branding */}
            <span
              aria-hidden="true"
              className="text-sm sm:text-base font-semibold tracking-wider uppercase text-violet-900/80 dark:text-violet-200/85"
            >
              Glow-A-Eye
            </span>

            {/* 2. Central animated voice-assistant orb */}
            <div aria-hidden="true" className="my-auto flex flex-col items-center">
              <VoiceOrb status={effectiveStatus} />
            </div>

            {/* 3 & 4. Minimal status indicator + subtle instruction */}
            <div aria-hidden="true" className="flex flex-col items-center gap-2.5 max-w-xs sm:max-w-sm">
              <div
                className={`inline-flex items-center gap-2 font-semibold ${
                  isLargeText ? 'text-lg' : 'text-sm sm:text-base'
                } ${
                  effectiveStatus === 'error'
                    ? 'text-amber-800 dark:text-amber-300'
                    : effectiveStatus === 'listening'
                      ? 'text-violet-800 dark:text-violet-200'
                      : 'text-[#2b2244] dark:text-violet-100'
                }`}
              >
                <StatusIcon className="w-4 h-4 shrink-0" />
                <span>{statusLabel}</span>
              </div>

              <p
                className={`leading-relaxed ${
                  isLargeText ? 'text-base sm:text-lg' : 'text-sm sm:text-base'
                } text-[#534b6d] dark:text-violet-300/90`}
              >
                {subtleInstruction}
              </p>
            </div>
          </button>
        )}
      </main>
    </div>
  );
};
