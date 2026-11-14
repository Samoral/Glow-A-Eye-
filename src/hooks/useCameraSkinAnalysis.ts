import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CameraSessionState,
  SkinAnalysisObservation,
} from '../types/assistant.ts';
import { playAudioCue } from '../utils/accessibility.ts';
import {
  captureAndEvaluateVideoFrame,
  evaluateLiveGuidanceFromVideo,
} from '../utils/imageQuality.ts';
import {
  explainSkinObservationTerm,
  formatCausesSpeech,
  formatNextStepsSpeech,
  formatObservationsOnlySpeech,
  formatSimplerSpeech,
  requestSkinObservation,
} from '../services/skinAnalysisClient.ts';
import {
  CameraGuidanceController,
  type CameraEngineSnapshot,
} from '../services/cameraGuidanceEngine.ts';

interface UseCameraSkinAnalysisOptions {
  audioCuesEnabled: boolean;
  onSpeakFeedback: (
    text: string,
    alsoLog?: boolean,
    options?: { listenAfter?: boolean; onDone?: () => void }
  ) => void;
  isAssistantSpeaking?: () => boolean;
  isUserSpeaking?: () => boolean;
}

const INITIAL_SNAPSHOT: CameraEngineSnapshot = {
  state: 'inactive',
  stateLabel: 'Camera Inactive',
  guidanceText: '',
  countdownSeconds: null,
  lastEvaluation: null,
  capturedPhoto: null,
  observation: null,
  errorMessage: null,
  isPreviewVisible: false,
  isActiveSession: false,
};

export function useCameraSkinAnalysis({
  audioCuesEnabled,
  onSpeakFeedback,
  isAssistantSpeaking,
  isUserSpeaking,
}: UseCameraSkinAnalysisOptions) {
  const [snapshot, setSnapshot] = useState<CameraEngineSnapshot>(INITIAL_SNAPSHOT);

  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRequestIdRef = useRef<number>(0);
  const audioCuesRef = useRef(audioCuesEnabled);
  const speakRef = useRef(onSpeakFeedback);
  const isAssistantSpeakingRef = useRef(isAssistantSpeaking);
  const isUserSpeakingRef = useRef(isUserSpeaking);

  useEffect(() => {
    audioCuesRef.current = audioCuesEnabled;
  }, [audioCuesEnabled]);

  useEffect(() => {
    speakRef.current = onSpeakFeedback;
  }, [onSpeakFeedback]);

  useEffect(() => {
    isAssistantSpeakingRef.current = isAssistantSpeaking;
  }, [isAssistantSpeaking]);

  useEffect(() => {
    isUserSpeakingRef.current = isUserSpeaking;
  }, [isUserSpeaking]);

  const stopStreamTracks = useCallback(() => {
    // Invalidate any in-flight getUserMedia request so late resolutions stop immediately
    streamRequestIdRef.current += 1;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (videoRef.current) {
      const attached = videoRef.current.srcObject as MediaStream | null;
      if (attached && typeof attached.getTracks === 'function') {
        attached.getTracks().forEach((track) => track.stop());
      }
      try {
        videoRef.current.pause();
      } catch {
        // ignore pause errors during teardown
      }
      videoRef.current.srcObject = null;
    }
  }, []);

  const controller = useMemo(
    () =>
      new CameraGuidanceController({
        requestCameraStream: async () => {
          if (
            typeof navigator === 'undefined' ||
            !navigator.mediaDevices ||
            !navigator.mediaDevices.getUserMedia
          ) {
            return {
              ok: false,
              denied: false,
              unsupported: true,
              message:
                'Camera access is not supported in this browser or device environment.',
            };
          }

          // Guard against duplicate streams and track this specific request ID
          stopStreamTracks();
          const reqId = ++streamRequestIdRef.current;

          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1280 },
                height: { ideal: 960 },
              },
              audio: false,
            });

            // If cancelled or superseded while awaiting getUserMedia, release hardware immediately
            if (reqId !== streamRequestIdRef.current) {
              stream.getTracks().forEach((track) => track.stop());
              return {
                ok: false,
                denied: false,
                message: 'Camera session was cancelled before initialization completed.',
              };
            }

            streamRef.current = stream;
            if (videoRef.current) {
              videoRef.current.srcObject = stream;
              void videoRef.current.play().catch(() => {});
            }
            return { ok: true };
          } catch (err) {
            if (reqId !== streamRequestIdRef.current) {
              return {
                ok: false,
                denied: false,
                message: 'Camera session was cancelled.',
              };
            }
            const name = err instanceof Error ? err.name : '';
            const denied =
              name === 'NotAllowedError' || name === 'PermissionDeniedError';
            return {
              ok: false,
              denied,
              message: denied
                ? 'Camera permission was denied. Please allow camera access in your browser settings, then say "Open camera" to try again.'
                : 'No active camera could be opened right now. Ensure a camera is connected and not in use by another app.',
            };
          }
        },
        stopCameraStream: () => {
          stopStreamTracks();
        },
        sampleFrame: (previousSnapshot) =>
          evaluateLiveGuidanceFromVideo(videoRef.current, previousSnapshot),
        captureFrame: () => captureAndEvaluateVideoFrame(videoRef.current),
        analyzeCapturedPhoto: (dataUrl) => requestSkinObservation(dataUrl),
        speak: (text, options) => {
          speakRef.current(text, options?.alsoLog, {
            listenAfter: options?.listenAfter,
            onDone: options?.onDone,
          });
        },
        playCue: (kind) => {
          playAudioCue(kind, audioCuesRef.current);
        },
        isAssistantSpeaking: () =>
          isAssistantSpeakingRef.current ? isAssistantSpeakingRef.current() : false,
        isUserSpeaking: () =>
          isUserSpeakingRef.current ? isUserSpeakingRef.current() : false,
        onStateChange: (next) => {
          setSnapshot(next);
        },
      }),
    [stopStreamTracks]
  );

  // Keep <video> bound only while preview is visible; release immediately when hidden
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (snapshot.isPreviewVisible && streamRef.current) {
      if (video.srcObject !== streamRef.current) {
        video.srcObject = streamRef.current;
      }
      void video.play().catch(() => {});
    } else if (!snapshot.isPreviewVisible) {
      const attached = video.srcObject as MediaStream | null;
      if (attached && typeof attached.getTracks === 'function') {
        attached.getTracks().forEach((track) => track.stop());
      }
      try {
        video.pause();
      } catch {
        // ignore
      }
      video.srcObject = null;
    }
  }, [snapshot.isPreviewVisible, snapshot.state]);

  // Dispose camera stream and timers on unmount
  useEffect(() => {
    return () => {
      controller.dispose();
    };
  }, [controller]);

  const startCamera = useCallback(async () => {
    await controller.start();
  }, [controller]);

  const stopCameraSession = useCallback(
    (announcement?: string, listenAfter = true, silent = false) => {
      stopStreamTracks();
      if (silent) {
        controller.stopSilently();
        return;
      }
      controller.stopCameraSession({
        announcement:
          announcement ?? 'Camera cancelled and temporary image discarded.',
        listenAfter,
        silent: false,
        clearObservation: false,
      });
    },
    [controller, stopStreamTracks]
  );

  const stopCamera = useCallback(
    (announcement?: string, listenAfter = false) => {
      if (!announcement) {
        stopCameraSession(undefined, false, true);
        return;
      }
      stopCameraSession(announcement, listenAfter, false);
    },
    [stopCameraSession]
  );

  const handleCapture = useCallback(() => {
    void controller.triggerManualCapture();
  }, [controller]);

  const handleRetake = useCallback(() => {
    void controller.retake();
  }, [controller]);

  const handleCancel = useCallback(() => {
    stopCameraSession('Camera cancelled and temporary image discarded.', true, false);
  }, [stopCameraSession]);

  const handleCheckLiveFraming = useCallback(() => {
    controller.checkFramingNow();
  }, [controller]);

  const handleAnalyzePhoto = useCallback(async () => {
    await controller.retryAnalysis();
  }, [controller]);

  const repeatLastGuidance = useCallback(() => {
    controller.repeatLastGuidance();
  }, [controller]);

  const speakGuide = useCallback(
    (useSimple: boolean) => {
      if (useSimple) {
        onSpeakFeedback(
          'Hold the rear camera one hand’s length from your skin in even light. I will guide you and take the photo automatically when steady.',
          false,
          { listenAfter: true }
        );
        return;
      }
      controller.repeatLastGuidance();
    },
    [controller, onSpeakFeedback]
  );

  const speakCameraHelp = useCallback(() => {
    controller.speakCameraHelp();
  }, [controller]);

  const pauseGuidance = useCallback(() => {
    controller.pauseGuidanceForUser();
  }, [controller]);

  const resumeGuidance = useCallback(() => {
    controller.resumeGuidanceLoop();
  }, [controller]);

  const speakTermExplanation = useCallback(
    (term: string) => {
      onSpeakFeedback(
        explainSkinObservationTerm(term, snapshot.observation, null),
        true,
        { listenAfter: true }
      );
    },
    [onSpeakFeedback, snapshot.observation]
  );

  const speakObservationRepeat = useCallback(() => {
    if (!snapshot.observation) {
      onSpeakFeedback(
        'No skin observations are available yet. Say "Open camera" to examine your skin first.',
        false,
        { listenAfter: true }
      );
      return;
    }
    onSpeakFeedback(formatObservationsOnlySpeech(snapshot.observation), false, {
      listenAfter: true,
    });
  }, [onSpeakFeedback, snapshot.observation]);

  const speakObservationSimpler = useCallback(() => {
    if (!snapshot.observation) {
      onSpeakFeedback(
        'No skin observations are available to simplify yet.',
        false,
        { listenAfter: true }
      );
      return;
    }
    onSpeakFeedback(formatSimplerSpeech(snapshot.observation), true, {
      listenAfter: true,
    });
  }, [onSpeakFeedback, snapshot.observation]);

  const speakObservationCauses = useCallback(() => {
    if (!snapshot.observation) {
      onSpeakFeedback(
        'Please capture and analyze a photograph first so I can share cautious possibilities.',
        false,
        { listenAfter: true }
      );
      return;
    }
    onSpeakFeedback(formatCausesSpeech(snapshot.observation), true, {
      listenAfter: true,
    });
  }, [onSpeakFeedback, snapshot.observation]);

  const speakObservationNextSteps = useCallback(() => {
    if (!snapshot.observation) {
      onSpeakFeedback(
        'Please capture and analyze a photograph first, or consult a doctor or dermatologist directly for any concerning skin symptom.',
        false,
        { listenAfter: true }
      );
      return;
    }
    onSpeakFeedback(formatNextStepsSpeech(snapshot.observation), true, {
      listenAfter: true,
    });
  }, [onSpeakFeedback, snapshot.observation]);

  const cameraState: CameraSessionState = snapshot.state;
  const isStreaming = snapshot.isPreviewVisible;
  const isRequesting = snapshot.state === 'requesting_permission';
  const isAnalyzing = snapshot.state === 'analyzing';
  const observation: SkinAnalysisObservation | null = snapshot.observation;

  return {
    videoRef,
    cameraState,
    cameraStateLabel: snapshot.stateLabel,
    guidanceText: snapshot.guidanceText,
    countdownSeconds: snapshot.countdownSeconds,
    lastEvaluation: snapshot.lastEvaluation,
    errorMessage: snapshot.errorMessage,
    isPreviewVisible: snapshot.isPreviewVisible,
    isActiveSession: snapshot.isActiveSession,
    isStreaming,
    isRequesting,
    isAnalyzing,
    capturedPhoto: snapshot.capturedPhoto,
    hasCapturedPhoto: snapshot.capturedPhoto !== null,
    observation,
    hasAnalysis: observation !== null,
    startCamera,
    stopCameraSession,
    stopCamera,
    handleCapture,
    handleRetake,
    handleCancel,
    handleCheckLiveFraming,
    handleAnalyzePhoto,
    repeatLastGuidance,
    speakGuide,
    speakCameraHelp,
    pauseGuidance,
    resumeGuidance,
    speakTermExplanation,
    speakObservationRepeat,
    speakObservationSimpler,
    speakObservationCauses,
    speakObservationNextSteps,
  };
}
