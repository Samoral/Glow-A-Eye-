import { useCallback, useEffect, useRef, useState } from 'react';
import type { SkinAnalysisObservation } from '../types/assistant.ts';
import { formatSpokenTime, playAudioCue } from '../utils/accessibility.ts';
import {
  captureAndEvaluateVideoFrame,
  type CapturedPhotoResult,
  evaluateLiveVideoFrame,
} from '../utils/imageQuality.ts';
import {
  formatCausesSpeech,
  formatFullObservationSpeech,
  formatNextStepsSpeech,
  formatObservationsOnlySpeech,
  formatSimplerSpeech,
  requestSkinObservation,
} from '../services/skinAnalysisClient.ts';

const DETAILED_GUIDE =
  'Camera is active. Hold the rear camera about 15 to 20 centimeters—roughly one hand’s length—away from the skin area. If the area feels too far, move slightly closer; if blurry, pull back a touch and keep your hand steady in bright, even light. Say "Take picture" when ready, "Simplify" for shorter instructions, or "Cancel" to exit.';

const SIMPLIFIED_GUIDE =
  'Hold camera one hand’s length from your skin in even light. Hold steady and say "Take picture".';

interface UseCameraSkinAnalysisOptions {
  audioCuesEnabled: boolean;
  onSpeakFeedback: (
    text: string,
    alsoLog?: boolean,
    options?: { listenAfter?: boolean }
  ) => void;
}

export function useCameraSkinAnalysis({
  audioCuesEnabled,
  onSpeakFeedback,
}: UseCameraSkinAnalysisOptions) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const [simplifiedGuide, setSimplifiedGuide] = useState(false);
  const [capturedPhoto, setCapturedPhoto] = useState<CapturedPhotoResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [observation, setObservation] = useState<SkinAnalysisObservation | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isAnalyzingRef = useRef(false);
  const slowAnalysisTimerRef = useRef<number | null>(null);

  const clearSlowAnalysisTimer = useCallback(() => {
    if (slowAnalysisTimerRef.current !== null) {
      window.clearTimeout(slowAnalysisTimerRef.current);
      slowAnalysisTimerRef.current = null;
    }
  }, []);

  const stopStreamTracks = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const stopCamera = useCallback(
    (announcement?: string, listenAfter = false) => {
      const hadAnything =
        isStreaming ||
        streamRef.current !== null ||
        capturedPhoto !== null ||
        observation !== null;

      clearSlowAnalysisTimer();
      isAnalyzingRef.current = false;
      stopStreamTracks();
      setIsStreaming(false);
      setIsRequesting(false);
      setCapturedPhoto(null);
      setIsAnalyzing(false);
      setObservation(null);

      if (hadAnything && announcement) {
        playAudioCue('listen-stop', audioCuesEnabled);
        onSpeakFeedback(announcement, true, { listenAfter });
      }
    },
    [
      audioCuesEnabled,
      capturedPhoto,
      clearSlowAnalysisTimer,
      isStreaming,
      observation,
      onSpeakFeedback,
      stopStreamTracks,
    ]
  );

  // Attach MediaStream whenever video element and stream are ready
  useEffect(() => {
    if (isStreaming && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      void videoRef.current.play().catch(() => {});
    }
  }, [isStreaming]);

  const startCamera = useCallback(
    async (customPostStartSpeech?: string) => {
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia
      ) {
        const msg =
          'Camera access is not supported in this browser or device environment.';
        playAudioCue('error', audioCuesEnabled);
        onSpeakFeedback(msg, true, { listenAfter: true });
        return;
      }

      if (isStreaming && streamRef.current) {
        setCapturedPhoto(null);
        setObservation(null);
        const guideText =
          customPostStartSpeech ?? (simplifiedGuide ? SIMPLIFIED_GUIDE : DETAILED_GUIDE);
        onSpeakFeedback(guideText, false, { listenAfter: true });
        return;
      }

      setIsRequesting(true);
      setCapturedPhoto(null);
      setObservation(null);

      onSpeakFeedback(
        'Requesting camera access, preferring the rear-facing camera. Please allow camera permission if prompted.',
        false
      );

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 960 },
          },
          audio: false,
        });

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
        setIsStreaming(true);
        setIsRequesting(false);

        playAudioCue('camera-ready', audioCuesEnabled);
        const guideText =
          customPostStartSpeech ?? (simplifiedGuide ? SIMPLIFIED_GUIDE : DETAILED_GUIDE);
        onSpeakFeedback(guideText, true, { listenAfter: true });
      } catch (err) {
        setIsRequesting(false);
        setIsStreaming(false);
        const name = err instanceof Error ? err.name : '';
        const isDenied =
          name === 'NotAllowedError' || name === 'PermissionDeniedError';

        const msg = isDenied
          ? 'Camera permission was denied. Please allow camera access in your browser settings if you wish to use guided camera capture.'
          : 'No active camera could be opened right now. Ensure a camera is connected and not in use by another app.';
        playAudioCue('error', audioCuesEnabled);
        onSpeakFeedback(msg, true, { listenAfter: true });
      }
    },
    [audioCuesEnabled, isStreaming, onSpeakFeedback, simplifiedGuide]
  );

  const handleRetake = useCallback(() => {
    clearSlowAnalysisTimer();
    isAnalyzingRef.current = false;
    setCapturedPhoto(null);
    setObservation(null);
    setIsAnalyzing(false);

    if (isStreaming && streamRef.current) {
      playAudioCue('listen-start', audioCuesEnabled);
      onSpeakFeedback(
        'Ready to retake. Hold your camera steady 15 to 20 centimeters from the skin area in even light, then say "Take picture".',
        true,
        { listenAfter: true }
      );
    } else {
      void startCamera(
        'Camera reopened for retake. Hold steady one hand’s length from the skin area and say "Take picture".'
      );
    }
  }, [audioCuesEnabled, clearSlowAnalysisTimer, isStreaming, onSpeakFeedback, startCamera]);

  const handleCapture = useCallback(() => {
    if (capturedPhoto) {
      handleRetake();
      return;
    }

    if (!isStreaming || !streamRef.current) {
      void startCamera(
        'Camera is now active. Hold one hand’s length from the skin area in even light, then say "Take picture".'
      );
      return;
    }

    const { dataUrl, report } = captureAndEvaluateVideoFrame(videoRef.current);

    if (!dataUrl || !report.checkPerformed) {
      playAudioCue('error', audioCuesEnabled);
      onSpeakFeedback(report.spokenFeedback, true, { listenAfter: true });
      return;
    }

    setCapturedPhoto({
      dataUrl,
      report,
      capturedAt: formatSpokenTime(),
    });
    setObservation(null);

    if (report.passed) {
      playAudioCue('camera-ready', audioCuesEnabled);
      onSpeakFeedback(
        'Image quality check passed. Lighting, focus, and skin framing look clear. Your photo stays in temporary memory only. Say "Analyze photo" to hear cautious observations, or say "Retake" or "Cancel".',
        true,
        { listenAfter: true }
      );
    } else {
      playAudioCue('error', audioCuesEnabled);
      onSpeakFeedback(
        `${report.spokenFeedback} You can say "Retake", or say "Analyze photo" if you still want Glow-A-Eye to inspect this image.`,
        true,
        { listenAfter: true }
      );
    }
  }, [
    audioCuesEnabled,
    capturedPhoto,
    handleRetake,
    isStreaming,
    onSpeakFeedback,
    startCamera,
  ]);

  const handleCancel = useCallback(() => {
    if (!isStreaming && !capturedPhoto && !observation) {
      onSpeakFeedback('Camera is already closed and no photo is stored.', false, {
        listenAfter: true,
      });
      return;
    }
    stopCamera('Camera capture cancelled and temporary image discarded.', true);
  }, [capturedPhoto, isStreaming, observation, onSpeakFeedback, stopCamera]);

  const handleCheckLiveFraming = useCallback(() => {
    if (!isStreaming || capturedPhoto) {
      onSpeakFeedback(
        'Say "Open camera" first so I can check lighting and framing.',
        false,
        { listenAfter: true }
      );
      return;
    }

    const report = evaluateLiveVideoFrame(videoRef.current);
    if (!report.checkPerformed) {
      playAudioCue('error', audioCuesEnabled);
      onSpeakFeedback(report.spokenFeedback, false, { listenAfter: true });
      return;
    }

    if (report.passed) {
      playAudioCue('camera-ready', audioCuesEnabled);
      onSpeakFeedback(
        'Live check looks good. Lighting, focus, and skin framing look clear. Hold steady and say "Take picture".',
        false,
        { listenAfter: true }
      );
    } else {
      playAudioCue('error', audioCuesEnabled);
      onSpeakFeedback(
        report.spokenFeedback.replace('say Retake', 'adjust before taking your picture'),
        false,
        { listenAfter: true }
      );
    }
  }, [audioCuesEnabled, capturedPhoto, isStreaming, onSpeakFeedback]);

  const handleAnalyzePhoto = useCallback(async () => {
    if (isAnalyzingRef.current || isAnalyzing) {
      onSpeakFeedback('Analysis is already in progress. Please wait a moment.', false);
      return;
    }

    if (!capturedPhoto) {
      onSpeakFeedback(
        'No captured photograph is ready yet. Say "Open camera" and "Take picture" first.',
        true,
        { listenAfter: true }
      );
      return;
    }

    isAnalyzingRef.current = true;
    setIsAnalyzing(true);
    setObservation(null);
    playAudioCue('listen-start', audioCuesEnabled);
    onSpeakFeedback('Analyzing your photograph now. Please wait a moment.', false);

    clearSlowAnalysisTimer();
    slowAnalysisTimerRef.current = window.setTimeout(() => {
      if (isAnalyzingRef.current) {
        onSpeakFeedback(
          'Still examining your photograph carefully. Please hold on a moment.',
          false
        );
      }
    }, 9000);

    try {
      const result = await requestSkinObservation(capturedPhoto.dataUrl);

      if (!result.ok) {
        playAudioCue('error', audioCuesEnabled);
        onSpeakFeedback(
          `${result.error} You can say "Analyze photo" to try again, "Retake", or "Cancel".`,
          true,
          { listenAfter: true }
        );
        return;
      }

      setObservation(result.observation);
      playAudioCue('camera-ready', audioCuesEnabled);
      onSpeakFeedback(
        `${formatFullObservationSpeech(result.observation)} Would you like to answer a few tailored follow-up symptom questions so I can run a safety check and give more helpful guidance? Say "Yes" or "Start questions".`,
        true,
        { listenAfter: true }
      );
    } finally {
      clearSlowAnalysisTimer();
      isAnalyzingRef.current = false;
      setIsAnalyzing(false);
    }
  }, [audioCuesEnabled, capturedPhoto, clearSlowAnalysisTimer, isAnalyzing, onSpeakFeedback]);

  const speakGuide = useCallback(
    (useSimple: boolean) => {
      if (useSimple) setSimplifiedGuide(true);
      onSpeakFeedback(useSimple ? SIMPLIFIED_GUIDE : DETAILED_GUIDE, false, {
        listenAfter: true,
      });
    },
    [onSpeakFeedback]
  );

  const speakObservationRepeat = useCallback(() => {
    if (!observation) {
      onSpeakFeedback(
        'No skin observations are available yet. Say "Open camera" and "Take picture" first.',
        false,
        { listenAfter: true }
      );
      return;
    }
    onSpeakFeedback(formatObservationsOnlySpeech(observation), false, {
      listenAfter: true,
    });
  }, [observation, onSpeakFeedback]);

  const speakObservationSimpler = useCallback(() => {
    if (!observation) {
      onSpeakFeedback(
        'No skin observations are available to simplify yet.',
        false,
        { listenAfter: true }
      );
      return;
    }
    onSpeakFeedback(formatSimplerSpeech(observation), true, { listenAfter: true });
  }, [observation, onSpeakFeedback]);

  const speakObservationCauses = useCallback(() => {
    if (!observation) {
      onSpeakFeedback(
        'Please capture and analyze a photograph first so I can share cautious possibilities.',
        false,
        { listenAfter: true }
      );
      return;
    }
    onSpeakFeedback(formatCausesSpeech(observation), true, { listenAfter: true });
  }, [observation, onSpeakFeedback]);

  const speakObservationNextSteps = useCallback(() => {
    if (!observation) {
      onSpeakFeedback(
        'Please capture and analyze a photograph first, or consult a doctor or dermatologist directly for any concerning skin symptom.',
        false,
        { listenAfter: true }
      );
      return;
    }
    onSpeakFeedback(formatNextStepsSpeech(observation), true, { listenAfter: true });
  }, [observation, onSpeakFeedback]);

  useEffect(() => {
    return () => {
      clearSlowAnalysisTimer();
      isAnalyzingRef.current = false;
      stopStreamTracks();
    };
  }, [clearSlowAnalysisTimer, stopStreamTracks]);

  return {
    videoRef,
    isStreaming,
    isRequesting,
    isAnalyzing,
    capturedPhoto,
    hasCapturedPhoto: capturedPhoto !== null,
    observation,
    hasAnalysis: observation !== null,
    simplifiedGuide,
    startCamera,
    stopCamera,
    handleCapture,
    handleRetake,
    handleCancel,
    handleCheckLiveFraming,
    handleAnalyzePhoto,
    speakGuide,
    speakObservationRepeat,
    speakObservationSimpler,
    speakObservationCauses,
    speakObservationNextSteps,
  };
}
