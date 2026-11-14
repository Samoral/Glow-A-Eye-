import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, AudioLines, Mic, Volume2 } from 'lucide-react';
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
  thinking: { label: 'Thinking', Icon: AudioLines },
  speaking: { label: 'Speaking', Icon: Volume2 },
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
    (text: string, alsoLog?: boolean, options?: { listenAfter?: boolean }) => void
  >(() => {});

  const handleSpeakFeedback = useCallback(
    (text: string, alsoLog?: boolean, options?: { listenAfter?: boolean }) => {
      speakFeedbackImplRef.current(text, alsoLog, options);
    },
    []
  );

  const camera = useCameraSkinAnalysis({
    audioCuesEnabled: settings.audioCuesEnabled,
    onSpeakFeedback: handleSpeakFeedback,
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
        cameraRef.current.stopCamera('Camera closed. What would you like to do next?', true);
        break;
      case 'capture_photo':
        cameraRef.current.handleCapture();
        break;
      case 'retake_photo':
        cameraRef.current.handleRetake();
        break;
      case 'cancel_camera':
        cameraRef.current.handleCancel();
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
        assessmentRef.current.speakReportWhy();
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
        cameraRef.current.stopCamera();
        assessmentRef.current.resetAssessment();
        voiceRef.current?.endConversation();
        setHasStarted(false);
        break;
      case 'restart_conversation':
        cameraRef.current.stopCamera();
        assessmentRef.current.resetAssessment();
        setHasStarted(true);
        voiceRef.current?.beginConversation(
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

  const voice = useVoiceAssistant({
    settings,
    cameraContext: {
      isCameraActive: camera.isStreaming,
      hasCapturedPhoto: camera.hasCapturedPhoto,
      hasAnalysis: camera.hasAnalysis,
      isQuestioningActive: assessment.isQuestioning,
      hasAssessmentReport: assessment.hasAssessmentReport,
      awaitingAssessmentStartConfirm,
    },
    onAction: handleVoiceAction,
  });

  voiceRef.current = voice;
  speakFeedbackImplRef.current = voice.speakCustomFeedback;

  const effectiveStatus: AssistantStatus =
    camera.isAnalyzing || assessment.isGeneratingReport || voice.status === 'thinking'
      ? 'thinking'
      : voice.status;

  const isAssessmentProtected =
    camera.isStreaming ||
    camera.hasCapturedPhoto ||
    camera.isAnalyzing ||
    assessment.isQuestioning ||
    assessment.isGeneratingReport;

  const handleSurfaceActivate = useCallback(() => {
    if (!hasStarted) {
      setHasStarted(true);
      voice.beginConversation();
      return;
    }

    if (effectiveStatus === 'thinking') {
      return;
    }

    // Protect active camera capture and symptom questioning against accidental taps
    if (isAssessmentProtected) {
      if (effectiveStatus === 'idle' || effectiveStatus === 'error') {
        void voice.startListening();
      }
      return;
    }

    if (effectiveStatus === 'listening') {
      voice.stopListening(true);
    } else if (effectiveStatus === 'speaking') {
      voice.stopSpeaking();
      void voice.startListening({ skipMicAnnouncement: true });
    } else {
      void voice.startListening();
    }
  }, [effectiveStatus, hasStarted, isAssessmentProtected, voice]);

  // Keyboard accessibility: Escape cancels active speaking or listening
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (voice.status === 'listening') {
          event.preventDefault();
          voice.stopListening(true);
        } else if (voice.status === 'speaking') {
          event.preventDefault();
          voice.stopSpeaking();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [voice]);

  const { label: statusLabel, Icon: StatusIcon } = STATUS_DISPLAY[effectiveStatus];

  const subtleInstruction = !hasStarted
    ? 'Tap anywhere to begin.'
    : effectiveStatus === 'listening'
      ? voice.interimTranscript
        ? `“${voice.interimTranscript}”`
        : 'Listening — speak naturally.'
      : effectiveStatus === 'thinking'
        ? camera.isAnalyzing
          ? 'Examining photograph...'
          : assessment.isGeneratingReport
            ? 'Evaluating safety...'
            : 'Thinking...'
        : effectiveStatus === 'speaking'
          ? isAssessmentProtected
            ? 'Speaking — say "Stop speaking" to interrupt.'
            : 'Speaking — tap or say "Stop speaking".'
          : effectiveStatus === 'error'
            ? voice.statusDetail
            : isAssessmentProtected
              ? 'Assessment active. Tap to resume listening.'
              : 'Tap anywhere to speak.';

  const surfaceAriaLabel = !hasStarted
    ? 'Glow-A-Eye voice companion. Tap anywhere to begin.'
    : effectiveStatus === 'listening'
      ? isAssessmentProtected
        ? 'Glow-A-Eye is listening during your skin assessment.'
        : 'Glow-A-Eye is listening. Tap anywhere to stop listening.'
      : effectiveStatus === 'thinking'
        ? 'Glow-A-Eye is processing your request. Please wait.'
        : effectiveStatus === 'speaking'
          ? isAssessmentProtected
            ? 'Glow-A-Eye is speaking assessment guidance.'
            : 'Glow-A-Eye is speaking. Tap anywhere to interrupt and speak.'
          : effectiveStatus === 'error'
            ? `${voice.statusDetail} Tap anywhere to try again.`
            : 'Glow-A-Eye standby. Tap anywhere to speak.';

  const isLargeText = settings.textScale === 'large';

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

      {/* Off-screen camera video element outside button so mobile browsers decode frames reliably */}
      <video
        ref={camera.videoRef}
        autoPlay
        playsInline
        muted
        aria-hidden="true"
        tabIndex={-1}
        className="fixed bottom-0 right-0 w-1 h-1 opacity-0 pointer-events-none"
      />

      <main className="min-h-[100dvh] w-full flex">
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
      </main>
    </div>
  );
};
