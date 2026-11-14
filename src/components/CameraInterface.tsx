import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CameraOff,
  CheckCircle2,
  Eye,
  FileText,
  Info,
  Loader2,
  MinusCircle,
  RotateCcw,
  ShieldAlert,
  Upload,
  Volume2,
  X,
} from 'lucide-react';
import {
  PermissionState,
  SkinAnalysisObservation,
  TextScale,
} from '../types/assistant';
import {
  formatSpokenTime,
  playAudioCue,
  usePrefersReducedMotion,
} from '../utils/accessibility';
import {
  analyzeImageDataQuality,
  captureAndEvaluateVideoFrame,
  CapturedPhotoResult,
  evaluateLiveVideoFrame,
  ImageQualityReport,
  optimizeImageElementForObservation,
} from '../utils/imageQuality';
import {
  formatCausesSpeech,
  formatFullObservationSpeech,
  formatNextStepsSpeech,
  formatObservationsOnlySpeech,
  formatSimplerSpeech,
  parseAndValidateDataUrl,
  requestSkinObservation,
} from '../services/skinAnalysisClient';

interface CameraInterfaceProps {
  textScale: TextScale;
  audioCuesEnabled: boolean;
  activateSignal: number;
  closeSignal: number;
  captureSignal: number;
  retakeSignal: number;
  cancelSignal: number;
  repeatGuideSignal: number;
  simplifyGuideSignal: number;
  checkFramingSignal: number;
  analyzeSignal: number;
  repeatObsSignal: number;
  explainSimplerSignal: number;
  whatCauseSignal: number;
  whatNextSignal: number;
  onSpeakFeedback: (
    text: string,
    alsoLog?: boolean,
    options?: { listenAfter?: boolean }
  ) => void;
  onCameraStateChange?: (state: {
    isCameraActive: boolean;
    hasCapturedPhoto: boolean;
    hasAnalysis: boolean;
  }) => void;
  onObservationChange?: (observation: SkinAnalysisObservation | null) => void;
  onRequestStartQuestions?: () => void;
  sectionRef?: React.RefObject<HTMLElement | null>;
}

const DETAILED_GUIDE =
  'Camera is active. Hold the rear camera about 15 to 20 centimeters—roughly one hand’s length—away from the skin area. If the area feels too far, move slightly closer; if blurry, pull back a touch and keep your hand steady in bright, even light. Say "Take picture" when ready, "Simplify" for shorter instructions, or "Cancel" to exit.';

const SIMPLIFIED_GUIDE =
  'Hold camera one hand’s length from your skin in even light. Hold steady and say "Take picture".';

export const CameraInterface: React.FC<CameraInterfaceProps> = ({
  textScale,
  audioCuesEnabled,
  activateSignal,
  closeSignal,
  captureSignal,
  retakeSignal,
  cancelSignal,
  repeatGuideSignal,
  simplifyGuideSignal,
  checkFramingSignal,
  analyzeSignal,
  repeatObsSignal,
  explainSimplerSignal,
  whatCauseSignal,
  whatNextSignal,
  onSpeakFeedback,
  onCameraStateChange,
  onObservationChange,
  onRequestStartQuestions,
  sectionRef,
}) => {
  const [cameraPermission, setCameraPermission] = useState<PermissionState>('prompt');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [simplifiedGuide, setSimplifiedGuide] = useState(false);
  const [capturedPhoto, setCapturedPhoto] = useState<CapturedPhotoResult | null>(null);
  const [liveCheckReport, setLiveCheckReport] = useState<ImageQualityReport | null>(null);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [observation, setObservation] = useState<SkinAnalysisObservation | null>(null);

  const reducedMotion = usePrefersReducedMotion();
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isAnalyzingRef = useRef(false);
  const slowAnalysisTimerRef = useRef<number | null>(null);

  const clearSlowAnalysisTimer = useCallback(() => {
    if (slowAnalysisTimerRef.current !== null) {
      window.clearTimeout(slowAnalysisTimerRef.current);
      slowAnalysisTimerRef.current = null;
    }
  }, []);

  // Sync camera, capture, and observation state upward for voice context awareness
  useEffect(() => {
    onCameraStateChange?.({
      isCameraActive: isStreaming,
      hasCapturedPhoto: capturedPhoto !== null,
      hasAnalysis: observation !== null,
    });
  }, [capturedPhoto, isStreaming, observation, onCameraStateChange]);

  useEffect(() => {
    onObservationChange?.(observation);
  }, [observation, onObservationChange]);

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
    (announcement?: string) => {
      const hadStream = isStreaming || streamRef.current !== null;
      const hadPhoto = capturedPhoto !== null;
      const hadObs = observation !== null;
      clearSlowAnalysisTimer();
      isAnalyzingRef.current = false;
      stopStreamTracks();
      setIsStreaming(false);
      setCapturedPhoto(null);
      setLiveCheckReport(null);
      setIsAnalyzing(false);
      setAnalysisError(null);
      setObservation(null);

      if (hadStream || hadPhoto || hadObs) {
        playAudioCue('listen-stop', audioCuesEnabled);
        if (announcement) {
          onSpeakFeedback(announcement, true);
        }
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

  const startCamera = useCallback(
    async (customPostStartSpeech?: string) => {
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia
      ) {
        setCameraPermission('unsupported');
        const msg =
          'Camera access is not supported in this browser or device environment. You can still choose an image file from your device if needed.';
        setErrorMessage(msg);
        playAudioCue('error', audioCuesEnabled);
        onSpeakFeedback(msg, true);
        return;
      }

      if (isStreaming && streamRef.current) {
        setCapturedPhoto(null);
        setObservation(null);
        setAnalysisError(null);
        const guideText =
          customPostStartSpeech ?? (simplifiedGuide ? SIMPLIFIED_GUIDE : DETAILED_GUIDE);
        onSpeakFeedback(guideText, false);
        return;
      }

      setIsRequesting(true);
      setErrorMessage(null);
      setCapturedPhoto(null);
      setLiveCheckReport(null);
      setObservation(null);
      setAnalysisError(null);

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
        setCameraPermission('granted');
        setIsStreaming(true);
        setIsRequesting(false);

        playAudioCue('camera-ready', audioCuesEnabled);
        const guideText =
          customPostStartSpeech ?? (simplifiedGuide ? SIMPLIFIED_GUIDE : DETAILED_GUIDE);
        onSpeakFeedback(guideText, true);
      } catch (err) {
        setIsRequesting(false);
        setIsStreaming(false);
        const name = err instanceof Error ? err.name : '';
        const isDenied =
          name === 'NotAllowedError' || name === 'PermissionDeniedError';
        setCameraPermission(isDenied ? 'denied' : 'prompt');

        const msg = isDenied
          ? 'Camera permission was denied. Please allow camera access in your browser settings if you wish to use guided camera capture.'
          : 'No active camera could be opened right now. Ensure a camera is connected and not in use by another app.';
        setErrorMessage(msg);
        playAudioCue('error', audioCuesEnabled);
        onSpeakFeedback(msg, true);
      }
    },
    [audioCuesEnabled, isStreaming, onSpeakFeedback, simplifiedGuide]
  );

  // Attach active MediaStream whenever live viewfinder is visible
  useEffect(() => {
    if (isStreaming && !capturedPhoto && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [capturedPhoto, isStreaming]);

  const handleRetake = useCallback(() => {
    clearSlowAnalysisTimer();
    isAnalyzingRef.current = false;
    setCapturedPhoto(null);
    setLiveCheckReport(null);
    setObservation(null);
    setAnalysisError(null);
    setIsAnalyzing(false);

    if (isStreaming && streamRef.current) {
      playAudioCue('listen-start', audioCuesEnabled);
      onSpeakFeedback(
        'Ready to retake. Hold your camera steady 15 to 20 centimeters from the skin area in even light, then say "Take picture".',
        true
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
      onSpeakFeedback(report.spokenFeedback, true);
      return;
    }

    setCapturedPhoto({
      dataUrl,
      report,
      capturedAt: formatSpokenTime(),
    });
    setLiveCheckReport(null);
    setObservation(null);
    setAnalysisError(null);

    if (report.passed) {
      playAudioCue('camera-ready', audioCuesEnabled);
      onSpeakFeedback(
        'Image quality check passed. Lighting, focus, and skin framing look clear. When you are ready, say "Analyze photo" or tap Analyze Photo to hear cautious observations, or say "Retake" or "Cancel".',
        true
      );
    } else {
      playAudioCue('error', audioCuesEnabled);
      onSpeakFeedback(
        `${report.spokenFeedback} You can say "Retake", or say "Analyze photo" if you still want Glow-A-Eye to inspect this image.`,
        true
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
      onSpeakFeedback('Camera is already closed and no photo is stored.', false);
      return;
    }
    stopCamera('Camera capture cancelled and temporary image discarded.');
  }, [capturedPhoto, isStreaming, observation, onSpeakFeedback, stopCamera]);

  const handleCheckLiveFraming = useCallback(() => {
    if (!isStreaming || capturedPhoto) {
      onSpeakFeedback(
        'Activate the live camera preview first so I can check lighting and framing.',
        false
      );
      return;
    }

    const report = evaluateLiveVideoFrame(videoRef.current);
    setLiveCheckReport(report);

    if (!report.checkPerformed) {
      playAudioCue('error', audioCuesEnabled);
      onSpeakFeedback(report.spokenFeedback, false);
      return;
    }

    if (report.passed) {
      playAudioCue('camera-ready', audioCuesEnabled);
      onSpeakFeedback(
        'Live check looks good. Lighting, focus, and skin framing look clear. Hold steady and say "Take picture".',
        false
      );
    } else {
      playAudioCue('error', audioCuesEnabled);
      onSpeakFeedback(
        report.spokenFeedback.replace('say Retake', 'adjust before taking your picture'),
        false
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
        true
      );
      return;
    }

    isAnalyzingRef.current = true;
    setIsAnalyzing(true);
    setAnalysisError(null);
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
        setAnalysisError(result.error);
        playAudioCue('error', audioCuesEnabled);
        onSpeakFeedback(
          `${result.error} You can say "Analyze photo" or tap Retry Analysis to try again.`,
          true
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

  const handleFileUpload = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;

      const allowedTypes = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
      if (!allowedTypes.has(file.type.toLowerCase())) {
        const msg =
          'Unsupported file format. Please choose a JPEG, PNG, or WebP photograph.';
        setErrorMessage(msg);
        playAudioCue('error', audioCuesEnabled);
        onSpeakFeedback(msg, true);
        return;
      }

      if (file.size > 5 * 1024 * 1024) {
        const msg =
          'That image file exceeds the 5 megabyte limit. Please choose a smaller photograph.';
        setErrorMessage(msg);
        playAudioCue('error', audioCuesEnabled);
        onSpeakFeedback(msg, true);
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        const validation = parseAndValidateDataUrl(dataUrl);
        if (!validation.valid) {
          setErrorMessage(validation.error);
          playAudioCue('error', audioCuesEnabled);
          onSpeakFeedback(validation.error, true);
          return;
        }

        // Run local pixel check on an offscreen image
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 240;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          let report: ImageQualityReport;
          if (ctx) {
            ctx.drawImage(img, 0, 0, 320, 240);
            const imgData = ctx.getImageData(0, 0, 320, 240);
            report = analyzeImageDataQuality(imgData);
          } else {
            report = {
              checkPerformed: false,
              passed: false,
              issues: ['capture_failed'],
              checks: [],
              metrics: null,
              spokenFeedback: 'Local pixel quality check could not be run in this browser.',
            };
          }

          const optimizedDataUrl = optimizeImageElementForObservation(
            img,
            dataUrl,
            validation.mimeType,
            validation.byteLength
          );

          setErrorMessage(null);
          setObservation(null);
          setAnalysisError(null);
          setCapturedPhoto({
            dataUrl: optimizedDataUrl,
            report,
            capturedAt: formatSpokenTime(),
          });

          playAudioCue('camera-ready', audioCuesEnabled);
          onSpeakFeedback(
            report.passed
              ? 'Photo loaded and local lighting and focus checks passed. Say "Analyze photo" or tap Analyze Photo when ready.'
              : `Photo loaded. ${report.spokenFeedback} You can still tap or say "Analyze photo" to inspect it.`,
            true
          );
        };
        img.onerror = () => {
          const msg = 'Could not decode that image file. Please select another JPEG, PNG, or WebP photo.';
          setErrorMessage(msg);
          onSpeakFeedback(msg, true);
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    },
    [audioCuesEnabled, onSpeakFeedback]
  );

  const speakGuide = useCallback(
    (useSimple: boolean) => {
      onSpeakFeedback(useSimple ? SIMPLIFIED_GUIDE : DETAILED_GUIDE, false);
    },
    [onSpeakFeedback]
  );

  // Voice command signal listeners
  const prevSignalsRef = useRef({
    activate: activateSignal,
    close: closeSignal,
    capture: captureSignal,
    retake: retakeSignal,
    cancel: cancelSignal,
    repeatGuide: repeatGuideSignal,
    simplifyGuide: simplifyGuideSignal,
    checkFraming: checkFramingSignal,
    analyze: analyzeSignal,
    repeatObs: repeatObsSignal,
    explainSimpler: explainSimplerSignal,
    whatCause: whatCauseSignal,
    whatNext: whatNextSignal,
  });

  useEffect(() => {
    if (activateSignal !== prevSignalsRef.current.activate) {
      prevSignalsRef.current.activate = activateSignal;
      void startCamera();
    }
  }, [activateSignal, startCamera]);

  useEffect(() => {
    if (closeSignal !== prevSignalsRef.current.close) {
      prevSignalsRef.current.close = closeSignal;
      stopCamera('Camera closed.');
    }
  }, [closeSignal, stopCamera]);

  useEffect(() => {
    if (captureSignal !== prevSignalsRef.current.capture) {
      prevSignalsRef.current.capture = captureSignal;
      handleCapture();
    }
  }, [captureSignal, handleCapture]);

  useEffect(() => {
    if (retakeSignal !== prevSignalsRef.current.retake) {
      prevSignalsRef.current.retake = retakeSignal;
      handleRetake();
    }
  }, [handleRetake, retakeSignal]);

  useEffect(() => {
    if (cancelSignal !== prevSignalsRef.current.cancel) {
      prevSignalsRef.current.cancel = cancelSignal;
      handleCancel();
    }
  }, [cancelSignal, handleCancel]);

  useEffect(() => {
    if (repeatGuideSignal !== prevSignalsRef.current.repeatGuide) {
      prevSignalsRef.current.repeatGuide = repeatGuideSignal;
      speakGuide(simplifiedGuide);
    }
  }, [repeatGuideSignal, simplifiedGuide, speakGuide]);

  useEffect(() => {
    if (simplifyGuideSignal !== prevSignalsRef.current.simplifyGuide) {
      prevSignalsRef.current.simplifyGuide = simplifyGuideSignal;
      setSimplifiedGuide(true);
      speakGuide(true);
    }
  }, [simplifyGuideSignal, speakGuide]);

  useEffect(() => {
    if (checkFramingSignal !== prevSignalsRef.current.checkFraming) {
      prevSignalsRef.current.checkFraming = checkFramingSignal;
      handleCheckLiveFraming();
    }
  }, [checkFramingSignal, handleCheckLiveFraming]);

  useEffect(() => {
    if (analyzeSignal !== prevSignalsRef.current.analyze) {
      prevSignalsRef.current.analyze = analyzeSignal;
      void handleAnalyzePhoto();
    }
  }, [analyzeSignal, handleAnalyzePhoto]);

  useEffect(() => {
    if (repeatObsSignal !== prevSignalsRef.current.repeatObs) {
      prevSignalsRef.current.repeatObs = repeatObsSignal;
      if (!observation) {
        onSpeakFeedback(
          'No skin observations are available yet. Capture a photo and say "Analyze photo" first.',
          false
        );
      } else {
        onSpeakFeedback(formatObservationsOnlySpeech(observation), false);
      }
    }
  }, [observation, onSpeakFeedback, repeatObsSignal]);

  useEffect(() => {
    if (explainSimplerSignal !== prevSignalsRef.current.explainSimpler) {
      prevSignalsRef.current.explainSimpler = explainSimplerSignal;
      if (!observation) {
        onSpeakFeedback(
          'No skin observations are available to simplify yet. Capture a photo and say "Analyze photo" first.',
          false
        );
      } else {
        onSpeakFeedback(formatSimplerSpeech(observation), true);
      }
    }
  }, [explainSimplerSignal, observation, onSpeakFeedback]);

  useEffect(() => {
    if (whatCauseSignal !== prevSignalsRef.current.whatCause) {
      prevSignalsRef.current.whatCause = whatCauseSignal;
      if (!observation) {
        onSpeakFeedback(
          'Please capture and analyze a photograph first so I can share cautious possibilities.',
          false
        );
      } else {
        onSpeakFeedback(formatCausesSpeech(observation), true);
      }
    }
  }, [observation, onSpeakFeedback, whatCauseSignal]);

  useEffect(() => {
    if (whatNextSignal !== prevSignalsRef.current.whatNext) {
      prevSignalsRef.current.whatNext = whatNextSignal;
      if (!observation) {
        onSpeakFeedback(
          'Please capture and analyze a photograph first, or consult a doctor or dermatologist directly for any concerning skin symptom.',
          false
        );
      } else {
        onSpeakFeedback(formatNextStepsSpeech(observation), true);
      }
    }
  }, [observation, onSpeakFeedback, whatNextSignal]);

  // Cleanup camera stream and timers on unmount
  useEffect(() => {
    return () => {
      clearSlowAnalysisTimer();
      isAnalyzingRef.current = false;
      stopStreamTracks();
    };
  }, [clearSlowAnalysisTimer, stopStreamTracks]);

  const renderCheckIcon = (status: 'passed' | 'failed' | 'not_performed') => {
    if (status === 'passed') {
      return (
        <CheckCircle2
          className="w-4 h-4 shrink-0 text-emerald-700 dark:text-emerald-400"
          aria-hidden="true"
        />
      );
    }
    if (status === 'failed') {
      return (
        <AlertTriangle
          className="w-4 h-4 shrink-0 text-amber-700 dark:text-amber-300"
          aria-hidden="true"
        />
      );
    }
    return (
      <MinusCircle
        className="w-4 h-4 shrink-0 text-[#6d6488] dark:text-violet-300"
        aria-hidden="true"
      />
    );
  };

  return (
    <section
      id="camera-section"
      ref={sectionRef}
      tabIndex={-1}
      aria-labelledby="camera-heading"
      className="rounded-3xl bg-white dark:bg-[#140f24] border border-violet-200/80 dark:border-violet-800/50 shadow-sm p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2
            id="camera-heading"
            className="text-lg sm:text-xl font-bold text-[#171226] dark:text-white"
          >
            Camera Capture &amp; Observations
          </h2>
          <p
            className={`mt-1 text-[#534b6d] dark:text-violet-300 ${
              textScale === 'large' ? 'text-base' : 'text-sm'
            }`}
          >
            Voice-guided skin capture with quality checks and cautious Gemini AI visual observations.
          </p>
        </div>

        {/* Non-hue-only camera/analysis state label */}
        <div
          role="status"
          aria-live="polite"
          className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs sm:text-sm font-semibold ${
            isAnalyzing
              ? 'bg-indigo-100 text-indigo-950 border-indigo-300 dark:bg-indigo-950/90 dark:text-indigo-100 dark:border-indigo-700'
              : observation
                ? observation.showsSkin && observation.imageQualitySufficient
                  ? 'bg-emerald-50 text-emerald-950 border-emerald-400 dark:bg-emerald-950/60 dark:text-emerald-100 dark:border-emerald-700'
                  : 'bg-amber-100 text-amber-950 border-amber-400 dark:bg-amber-950/70 dark:text-amber-100 dark:border-amber-600'
                : capturedPhoto
                  ? capturedPhoto.report.passed
                    ? 'bg-emerald-50 text-emerald-950 border-emerald-400 dark:bg-emerald-950/60 dark:text-emerald-100 dark:border-emerald-700'
                    : 'bg-amber-100 text-amber-950 border-amber-400 dark:bg-amber-950/70 dark:text-amber-100 dark:border-amber-600'
                  : isStreaming
                    ? 'bg-violet-700 text-white border-violet-500'
                    : cameraPermission === 'denied' || cameraPermission === 'unsupported'
                      ? 'bg-amber-100 text-amber-950 border-amber-400 dark:bg-amber-950/70 dark:text-amber-100 dark:border-amber-600'
                      : 'bg-violet-50 text-violet-950 border-violet-200 dark:bg-violet-950/60 dark:text-violet-100 dark:border-violet-800'
          }`}
        >
          {isAnalyzing ? (
            <Loader2
              className={`w-4 h-4 shrink-0 ${!reducedMotion ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
          ) : isStreaming || capturedPhoto ? (
            <Camera className="w-4 h-4 shrink-0" aria-hidden="true" />
          ) : (
            <CameraOff className="w-4 h-4 shrink-0" aria-hidden="true" />
          )}
          <span>
            {isAnalyzing
              ? 'Analyzing Photo'
              : observation
                ? observation.showsSkin && observation.imageQualitySufficient
                  ? 'Observations Ready'
                  : 'Clearer Photo Needed'
                : capturedPhoto
                  ? capturedPhoto.report.passed
                    ? 'Photo Ready'
                    : 'Retake Recommended'
                  : isStreaming
                    ? 'Camera Active'
                    : isRequesting
                      ? 'Requesting Access'
                      : cameraPermission === 'denied'
                        ? 'Permission Denied'
                        : cameraPermission === 'unsupported'
                          ? 'Unavailable'
                          : 'Camera Off'}
          </span>
        </div>
      </div>

      {/* Hidden accessible file input for selecting JPEG/PNG/WebP photos */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={handleFileUpload}
        className="sr-only"
        aria-label="Choose a JPEG, PNG, or WebP photograph for skin observation"
      />

      <div className="mt-5">
        {capturedPhoto ? (
          <div className="space-y-4">
            {/* Captured Photo Preview */}
            <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl bg-[#0b0814] border border-violet-300 dark:border-violet-700">
              <img
                src={capturedPhoto.dataUrl}
                alt="Captured skin photograph preview"
                className="w-full h-full object-cover"
              />
            </div>

            {/* Explicit Consent & Analyze Trigger */}
            {!observation && (
              <div className="rounded-2xl bg-[#f6f3ff] dark:bg-[#1b1430] border border-violet-200 dark:border-violet-800 p-4 space-y-3">
                <p
                  className={`text-[#2e2745] dark:text-violet-100 ${
                    textScale === 'large' ? 'text-base' : 'text-sm'
                  }`}
                >
                  Your photograph stays only in temporary memory until you choose to analyze it. Glow-A-Eye never saves photos permanently and never provides a medical diagnosis.
                </p>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void handleAnalyzePhoto()}
                    disabled={isAnalyzing}
                    className="min-h-[48px] px-5 py-2.5 rounded-xl bg-violet-700 hover:bg-violet-800 disabled:opacity-60 text-white font-semibold text-sm sm:text-base inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    {isAnalyzing ? (
                      <>
                        <Loader2
                          className={`w-5 h-5 ${!reducedMotion ? 'animate-spin' : ''}`}
                          aria-hidden="true"
                        />
                        <span>Analyzing Photograph...</span>
                      </>
                    ) : (
                      <>
                        <Eye className="w-5 h-5" aria-hidden="true" />
                        <span>Analyze Photo</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={handleRetake}
                    disabled={isAnalyzing}
                    className="min-h-[48px] px-4 py-2.5 rounded-xl bg-white hover:bg-violet-50 disabled:opacity-50 dark:bg-[#140f24] dark:hover:bg-violet-900/50 text-[#171226] dark:text-violet-100 border border-violet-300 dark:border-violet-700 font-semibold text-sm inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <RotateCcw className="w-4 h-4" aria-hidden="true" />
                    <span>Retake</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleCancel}
                    disabled={isAnalyzing}
                    className="min-h-[48px] px-4 py-2.5 rounded-xl bg-[#171226] text-white dark:bg-white dark:text-[#171226] disabled:opacity-50 font-semibold text-sm inline-flex items-center gap-2 hover:opacity-90 transition-opacity cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                    <span>Cancel &amp; Discard</span>
                  </button>
                </div>
              </div>
            )}

            {/* Honest API / Validation Error State (never fabricated) */}
            {analysisError && (
              <div
                role="alert"
                className="rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-700 p-4 space-y-3"
              >
                <div className="flex items-start gap-2.5 text-amber-950 dark:text-amber-100">
                  <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-amber-700 dark:text-amber-300" aria-hidden="true" />
                  <div className="space-y-1">
                    <h3 className="text-sm font-bold">Observation Could Not Be Completed</h3>
                    <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
                      {analysisError}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => void handleAnalyzePhoto()}
                    disabled={isAnalyzing}
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-amber-900 hover:bg-amber-950 disabled:opacity-60 dark:bg-amber-300 dark:hover:bg-amber-200 text-white dark:text-amber-950 font-semibold text-xs sm:text-sm inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <RotateCcw className="w-4 h-4" aria-hidden="true" />
                    <span>Retry Analysis</span>
                  </button>
                </div>
              </div>
            )}

            {/* Structured Gemini Accessible Observations */}
            {observation && (
              <div
                role="region"
                aria-label="Gemini skin observation results"
                className="rounded-2xl bg-[#f7f4ff] dark:bg-[#1b1430] border border-violet-300 dark:border-violet-700 p-4 sm:p-5 space-y-4"
              >
                {/* Mandatory Medical Disclaimer Banner */}
                <div className="flex items-start gap-2.5 rounded-xl bg-white dark:bg-[#140f24] border border-violet-200 dark:border-violet-800 p-3.5 text-[#171226] dark:text-violet-100">
                  <ShieldAlert
                    className="w-5 h-5 shrink-0 mt-0.5 text-violet-700 dark:text-violet-300"
                    aria-hidden="true"
                  />
                  <div className="space-y-0.5">
                    <p className="text-xs font-bold tracking-wide text-violet-800 dark:text-violet-300">
                      Not a Medical Diagnosis
                    </p>
                    <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
                      {observation.safetyDisclaimer}
                    </p>
                  </div>
                </div>

                {/* Unclear or Non-Skin Warning when applicable */}
                {(!observation.showsSkin || !observation.imageQualitySufficient) && (
                  <div className="flex items-start gap-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-700 p-3.5 text-amber-950 dark:text-amber-100">
                    <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-amber-700 dark:text-amber-300" aria-hidden="true" />
                    <div className="space-y-1">
                      <p className="text-sm font-bold">
                        {!observation.showsSkin
                          ? 'Skin Area Not Clearly Visible'
                          : 'Photograph Clarity Is Limited'}
                      </p>
                      <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
                        {observation.qualityAssessment}
                      </p>
                    </div>
                  </div>
                )}

                {/* 1. What I can observe */}
                <div className="space-y-1.5">
                  <h3 className="text-sm font-bold text-violet-900 dark:text-violet-200">
                    What I can observe
                  </h3>
                  <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
                    {observation.whatICanObserve}
                  </p>
                  <p className="text-xs sm:text-sm text-[#473f61] dark:text-violet-300">
                    <span className="font-semibold">Apparent location:</span>{' '}
                    {observation.apparentLocation}
                  </p>
                  {observation.observableCharacteristics.length > 0 && (
                    <ul className="list-disc list-inside text-xs sm:text-sm text-[#3d3556] dark:text-violet-200 pt-1 space-y-0.5">
                      {observation.observableCharacteristics.map((trait, idx) => (
                        <li key={`${trait}-${idx}`}>{trait}</li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* 2. What it might indicate */}
                <div className="space-y-1.5 pt-3 border-t border-violet-200/80 dark:border-violet-800/60">
                  <h3 className="text-sm font-bold text-violet-900 dark:text-violet-200">
                    What it might indicate (Possibilities, Not a Diagnosis)
                  </h3>
                  <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
                    {observation.whatItMightIndicate}
                  </p>
                </div>

                {/* 3. What I cannot determine */}
                <div className="space-y-1.5 pt-3 border-t border-violet-200/80 dark:border-violet-800/60">
                  <h3 className="text-sm font-bold text-violet-900 dark:text-violet-200">
                    What I cannot determine
                  </h3>
                  <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
                    {observation.whatICannotDetermine}
                  </p>
                </div>

                {/* 4. Recommended next steps */}
                <div className="space-y-1.5 pt-3 border-t border-violet-200/80 dark:border-violet-800/60">
                  <h3 className="text-sm font-bold text-violet-900 dark:text-violet-200">
                    Recommended next steps
                  </h3>
                  <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
                    {observation.recommendedNextSteps}
                  </p>
                </div>

                {/* Accessible Spoken & Follow-up Buttons */}
                <div className="flex flex-wrap items-center gap-2.5 pt-3 border-t border-violet-200/80 dark:border-violet-800/60">
                  <button
                    type="button"
                    onClick={() =>
                      onSpeakFeedback(formatFullObservationSpeech(observation), false)
                    }
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-violet-700 hover:bg-violet-800 text-white font-semibold text-xs sm:text-sm inline-flex items-center gap-2 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Volume2 className="w-4 h-4" aria-hidden="true" />
                    <span>Read All Aloud</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => onRequestStartQuestions?.()}
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-violet-700 hover:bg-violet-800 text-white font-semibold text-xs sm:text-sm inline-flex items-center gap-2 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Eye className="w-4 h-4" aria-hidden="true" />
                    <span>Answer Symptom Questions</span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      onSpeakFeedback(formatSimplerSpeech(observation), true)
                    }
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-violet-100 hover:bg-violet-200 dark:bg-violet-900/60 dark:hover:bg-violet-800/70 text-violet-950 dark:text-violet-100 border border-violet-300 dark:border-violet-700 font-semibold text-xs sm:text-sm inline-flex items-center gap-2 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <FileText className="w-4 h-4" aria-hidden="true" />
                    <span>Simpler Terms</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleRetake}
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-white hover:bg-violet-50 dark:bg-[#140f24] dark:hover:bg-violet-900/50 text-[#171226] dark:text-violet-100 border border-violet-300 dark:border-violet-700 font-semibold text-xs sm:text-sm inline-flex items-center gap-2 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <RotateCcw className="w-4 h-4" aria-hidden="true" />
                    <span>Retake</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleCancel}
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-[#171226] text-white dark:bg-white dark:text-[#171226] font-semibold text-xs sm:text-sm inline-flex items-center gap-2 hover:opacity-90 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                    <span>Discard &amp; Close</span>
                  </button>
                </div>
              </div>
            )}

            {/* Local Pixel Pre-Check Summary */}
            {capturedPhoto.report.checks.length > 0 && (
              <div
                role="region"
                aria-label="Local photograph quality pre-checks"
                className={`rounded-2xl p-4 border space-y-2.5 ${
                  capturedPhoto.report.passed
                    ? 'bg-emerald-50/60 dark:bg-emerald-950/25 border-emerald-300 dark:border-emerald-800'
                    : 'bg-amber-50/70 dark:bg-amber-950/25 border-amber-300 dark:border-amber-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs sm:text-sm font-bold text-[#171226] dark:text-white">
                    {capturedPhoto.report.passed
                      ? 'Local Quality Checks Passed'
                      : 'Local Quality Pre-Check Notice'}
                  </h3>
                  <span className="text-xs font-mono tabular-nums text-[#534b6d] dark:text-violet-300">
                    {capturedPhoto.capturedAt}
                  </span>
                </div>

                <ul className="space-y-1.5">
                  {capturedPhoto.report.checks.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-start gap-2 text-xs sm:text-sm text-[#171226] dark:text-violet-100"
                    >
                      <span className="mt-0.5">{renderCheckIcon(item.status)}</span>
                      <span>
                        <strong className="font-semibold">{item.label}:</strong>{' '}
                        {item.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : isStreaming ? (
          /* Live Camera Preview & Voice-Operated Controls */
          <div className="space-y-4">
            <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl bg-[#0b0814] border border-violet-300 dark:border-violet-700">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                aria-label="Live camera preview for skin capture"
                className="w-full h-full object-cover"
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-6 sm:inset-10 rounded-2xl border-2 border-dashed border-violet-300/80"
              />
            </div>

            <div className="rounded-2xl bg-[#f7f4ff] dark:bg-[#1b1430] border border-violet-200/80 dark:border-violet-800/60 p-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold tracking-wide text-violet-800 dark:text-violet-300">
                  {simplifiedGuide ? 'Simplified Positioning Guide' : 'Positioning Guide'}
                </span>
                <button
                  type="button"
                  aria-pressed={simplifiedGuide}
                  onClick={() => {
                    const next = !simplifiedGuide;
                    setSimplifiedGuide(next);
                    speakGuide(next);
                  }}
                  className="min-h-[36px] px-3 py-1 rounded-lg bg-white dark:bg-[#140f24] border border-violet-300 dark:border-violet-700 text-xs font-semibold text-violet-900 dark:text-violet-100 hover:bg-violet-50 dark:hover:bg-violet-900/50 cursor-pointer whitespace-nowrap"
                >
                  {simplifiedGuide ? 'Switch to Detailed Guide' : 'Simplify Instructions'}
                </button>
              </div>
              <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
                {simplifiedGuide ? SIMPLIFIED_GUIDE : DETAILED_GUIDE}
              </p>

              {liveCheckReport && (
                <p
                  role="status"
                  aria-live="polite"
                  className="pt-2 border-t border-violet-200 dark:border-violet-800 text-xs sm:text-sm font-medium text-violet-950 dark:text-violet-100"
                >
                  Live check: {liveCheckReport.spokenFeedback}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleCapture}
                className="min-h-[48px] px-5 py-2.5 rounded-xl bg-violet-700 hover:bg-violet-800 text-white font-semibold text-sm sm:text-base inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Camera className="w-5 h-5" aria-hidden="true" />
                <span>Take Picture</span>
              </button>

              <button
                type="button"
                onClick={handleCheckLiveFraming}
                className="min-h-[48px] px-4 py-2.5 rounded-xl bg-violet-100 hover:bg-violet-200 dark:bg-violet-900/60 dark:hover:bg-violet-800/70 text-violet-950 dark:text-violet-100 border border-violet-300 dark:border-violet-700 font-semibold text-sm inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Eye className="w-4 h-4" aria-hidden="true" />
                <span>Check Lighting &amp; Framing</span>
              </button>

              <button
                type="button"
                onClick={() => speakGuide(simplifiedGuide)}
                className="min-h-[48px] px-4 py-2.5 rounded-xl bg-white hover:bg-violet-50 dark:bg-[#140f24] dark:hover:bg-violet-900/50 text-[#171226] dark:text-violet-100 border border-violet-300 dark:border-violet-700 font-semibold text-sm inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Volume2 className="w-4 h-4" aria-hidden="true" />
                <span>Repeat Guide</span>
              </button>

              <button
                type="button"
                onClick={handleCancel}
                className="min-h-[48px] px-4 py-2.5 rounded-xl bg-[#171226] text-white dark:bg-white dark:text-[#171226] font-semibold text-sm inline-flex items-center gap-2 hover:opacity-90 transition-opacity cursor-pointer whitespace-nowrap shrink-0"
              >
                <X className="w-4 h-4" aria-hidden="true" />
                <span>Cancel</span>
              </button>
            </div>
          </div>
        ) : (
          /* Inactive / Permission Error State */
          <div className="rounded-2xl bg-[#f7f4ff] dark:bg-[#1b1430] border border-violet-200/80 dark:border-violet-800/60 p-5 space-y-4">
            {errorMessage ? (
              <div className="flex items-start gap-3 text-amber-950 dark:text-amber-100">
                <ShieldAlert
                  className="w-5 h-5 shrink-0 mt-0.5 text-amber-700 dark:text-amber-300"
                  aria-hidden="true"
                />
                <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
                  {errorMessage}
                </p>
              </div>
            ) : (
              <div className="flex items-start gap-3 text-[#3d3556] dark:text-violet-200">
                <Info
                  className="w-5 h-5 shrink-0 mt-0.5 text-violet-700 dark:text-violet-300"
                  aria-hidden="true"
                />
                <p className={textScale === 'large' ? 'text-base' : 'text-sm'}>
                  Your camera remains off until you allow access. Say &ldquo;Open camera&rdquo; or activate below to capture a skin photograph. Images are only analyzed when you explicitly request it and are never permanently saved.
                </p>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void startCamera()}
                disabled={isRequesting}
                className="min-h-[48px] px-5 py-2.5 rounded-xl bg-violet-700 hover:bg-violet-800 disabled:opacity-50 text-white font-semibold text-sm sm:text-base inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Camera className="w-5 h-5" aria-hidden="true" />
                <span>{isRequesting ? 'Requesting Camera...' : 'Activate Camera'}</span>
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="min-h-[48px] px-4 py-2.5 rounded-xl bg-violet-100 hover:bg-violet-200 dark:bg-violet-900/60 dark:hover:bg-violet-800/70 text-violet-950 dark:text-violet-100 border border-violet-300 dark:border-violet-700 font-semibold text-sm inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Upload className="w-4 h-4" aria-hidden="true" />
                <span>Choose Image File</span>
              </button>

              <button
                type="button"
                onClick={() => speakGuide(simplifiedGuide)}
                className="min-h-[48px] px-4 py-2.5 rounded-xl bg-white hover:bg-violet-50 dark:bg-[#140f24] dark:hover:bg-violet-900/50 text-[#171226] dark:text-violet-100 border border-violet-300 dark:border-violet-700 font-semibold text-sm inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Volume2 className="w-4 h-4" aria-hidden="true" />
                <span>Hear Positioning Guide</span>
              </button>

              <button
                type="button"
                aria-pressed={simplifiedGuide}
                onClick={() => {
                  const next = !simplifiedGuide;
                  setSimplifiedGuide(next);
                  speakGuide(next);
                }}
                className="min-h-[48px] px-4 py-2.5 rounded-xl bg-white hover:bg-violet-50 dark:bg-[#140f24] dark:hover:bg-violet-900/50 text-[#171226] dark:text-violet-100 border border-violet-300 dark:border-violet-700 font-semibold text-sm inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <FileText className="w-4 h-4" aria-hidden="true" />
                <span>{simplifiedGuide ? 'Detailed Guide' : 'Simple Guide'}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
