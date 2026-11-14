import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActiveSection,
  AssistantSettings,
  AssistantStatus,
  ConversationMessage,
  PermissionState,
  VoiceCommandAction,
} from '../types/assistant';
import {
  interpretVoiceInput,
  VoiceCommandContext,
  WELCOME_GREETING,
} from '../services/voiceAssistantLogic';
import {
  encodePcmToWavBase64,
  InterruptedSpeechSnapshot,
  PcmPreRollRecorder,
  requestInterruptionTranscription,
  TARGET_PCM_SAMPLE_RATE,
  UtteranceEndpointer,
  VadMonitor,
  VoiceInterruptionCoordinator,
} from '../services/voiceInterruptionEngine';
import {
  formatSpokenTime,
  playAudioCue,
  selectPreferredFemaleVoice,
} from '../utils/accessibility';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: ((ev: Event) => void) | null;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((ev: Event) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

const ANDROID_AUDIO_RELEASE_SETTLE_MS = 75;
const VAD_SAMPLE_INTERVAL_MS = 48;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

function getAudioContextCtor(): (new () => AudioContext) | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  return win.AudioContext || win.webkitAudioContext || null;
}

function computeTimeDomainRms(
  analyser: AnalyserNode,
  buffer: Float32Array<ArrayBuffer>
): number {
  analyser.getFloatTimeDomainData(buffer);
  let sumSq = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const sample = buffer[i];
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / buffer.length);
}

interface UseVoiceAssistantOptions {
  settings: AssistantSettings;
  cameraContext?: VoiceCommandContext;
  onAction: (action: VoiceCommandAction) => void;
  onSectionRequest?: (section: ActiveSection) => void;
  onSpeechInterrupted?: (snapshot: InterruptedSpeechSnapshot) => void;
}

export function useVoiceAssistant({
  settings,
  cameraContext,
  onAction,
  onSpeechInterrupted,
}: UseVoiceAssistantOptions) {
  const [status, setStatus] = useState<AssistantStatus>('idle');
  const [statusDetail, setStatusDetail] = useState<string>(
    'Tap anywhere to begin.'
  );
  const [liveAnnouncement, setLiveAnnouncement] = useState<string>('');
  const [interimTranscript, setInterimTranscript] = useState<string>('');
  const [micPermission, setMicPermission] = useState<PermissionState>('prompt');
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speechRecognitionSupported, setSpeechRecognitionSupported] =
    useState<boolean>(true);
  const [speechSynthesisSupported, setSpeechSynthesisSupported] =
    useState<boolean>(true);
  const [messages, setMessages] = useState<ConversationMessage[]>([
    {
      id: 'welcome-1',
      sender: 'assistant',
      text: WELCOME_GREETING,
      timestamp: formatSpokenTime(),
    },
  ]);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const isRecognitionStartedRef = useRef<boolean>(false);
  const isListeningIntentRef = useRef<boolean>(false);
  const settingsRef = useRef<AssistantSettings>(settings);
  const cameraContextRef = useRef<VoiceCommandContext>(cameraContext ?? {});
  const lastAssistantMessageRef = useRef<string>(WELCOME_GREETING);
  const lastInterruptedRef = useRef<InterruptedSpeechSnapshot | null>(null);
  const thinkingTimerRef = useRef<number | null>(null);
  const listenRestartTimerRef = useRef<number | null>(null);
  const micAnnounceTimerRef = useRef<number | null>(null);
  const hasAttemptedAutoGreetRef = useRef<boolean>(false);
  const micPermissionRef = useRef<PermissionState>('prompt');
  const speechRecognitionSupportedRef = useRef<boolean>(true);
  const manualStopRef = useRef<boolean>(false);
  const speechFallbackTimerRef = useRef<number | null>(null);
  const startListeningRef = useRef<
    ((opts?: { skipMicAnnouncement?: boolean; fromInterruption?: boolean }) => Promise<void>) | null
  >(null);
  const isSpeakingRef = useRef<boolean>(false);
  const isUserSpeakingRef = useRef<boolean>(false);
  const onActionRef = useRef(onAction);
  const onSpeechInterruptedRef = useRef(onSpeechInterrupted);
  const processUserQueryRef = useRef<((rawText: string) => void) | null>(null);

  // Single-owner Web Audio VAD + Pre-Roll Recorder resources (ONLY active during AI speaking / interruption capture)
  const vadStreamRef = useRef<MediaStream | null>(null);
  const vadStartingRef = useRef<boolean>(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const scriptNodeRef = useRef<ScriptProcessorNode | null>(null);
  const zeroGainNodeRef = useRef<GainNode | null>(null);
  const vadIntervalRef = useRef<number | null>(null);
  const vadCapturingRef = useRef<boolean>(false);
  const vadMonitorRef = useRef<VadMonitor>(new VadMonitor());
  const pcmRecorderRef = useRef<PcmPreRollRecorder>(
    new PcmPreRollRecorder({
      sampleRate: TARGET_PCM_SAMPLE_RATE,
      preRollMs: 1500,
      maxCaptureMs: 7000,
    })
  );
  const endpointerRef = useRef<UtteranceEndpointer>(
    new UtteranceEndpointer({
      minCaptureMs: 380,
      silenceHangoverMs: 780,
      maxCaptureMs: 7000,
    })
  );

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    cameraContextRef.current = cameraContext ?? {};
  }, [cameraContext]);

  useEffect(() => {
    micPermissionRef.current = micPermission;
  }, [micPermission]);

  useEffect(() => {
    speechRecognitionSupportedRef.current = speechRecognitionSupported;
  }, [speechRecognitionSupported]);

  useEffect(() => {
    onActionRef.current = onAction;
  }, [onAction]);

  useEffect(() => {
    onSpeechInterruptedRef.current = onSpeechInterrupted;
  }, [onSpeechInterrupted]);

  useEffect(() => {
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.sender === 'assistant');
    if (lastAssistant) {
      lastAssistantMessageRef.current = lastAssistant.text;
    }
  }, [messages]);

  const announce = useCallback((text: string) => {
    setLiveAnnouncement('');
    window.requestAnimationFrame(() => {
      setLiveAnnouncement(text);
    });
  }, []);

  const appendMessage = useCallback(
    (sender: ConversationMessage['sender'], text: string) => {
      const msg: ConversationMessage = {
        id: `${sender}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        sender,
        text,
        timestamp: formatSpokenTime(),
      };
      setMessages((prev) => [...prev, msg]);
      return msg;
    },
    []
  );

  /**
   * Synchronously tears down any open Web Audio VAD stream, ScriptProcessor,
   * and AudioContext. Returns true if hardware tracks were closed.
   */
  const stopVadAudioMonitor = useCallback((): boolean => {
    let closedHardware = false;
    vadStartingRef.current = false;
    vadCapturingRef.current = false;
    isUserSpeakingRef.current = false;

    if (vadIntervalRef.current !== null) {
      window.clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }

    if (scriptNodeRef.current) {
      try {
        scriptNodeRef.current.onaudioprocess = null;
        scriptNodeRef.current.disconnect();
      } catch {
        // ignore
      }
      scriptNodeRef.current = null;
    }

    if (zeroGainNodeRef.current) {
      try {
        zeroGainNodeRef.current.disconnect();
      } catch {
        // ignore
      }
      zeroGainNodeRef.current = null;
    }

    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.disconnect();
      } catch {
        // ignore
      }
      sourceNodeRef.current = null;
    }

    if (audioContextRef.current) {
      closedHardware = true;
      try {
        void audioContextRef.current.close();
      } catch {
        // ignore
      }
      audioContextRef.current = null;
    }

    if (vadStreamRef.current) {
      closedHardware = true;
      vadStreamRef.current.getTracks().forEach((track) => track.stop());
      vadStreamRef.current = null;
    }

    vadMonitorRef.current.resetFrames();
    pcmRecorderRef.current.reset();
    return closedHardware;
  }, []);

  const clearTimers = useCallback(() => {
    if (thinkingTimerRef.current !== null) {
      window.clearTimeout(thinkingTimerRef.current);
      thinkingTimerRef.current = null;
    }
    if (listenRestartTimerRef.current !== null) {
      window.clearTimeout(listenRestartTimerRef.current);
      listenRestartTimerRef.current = null;
    }
    if (micAnnounceTimerRef.current !== null) {
      window.clearTimeout(micAnnounceTimerRef.current);
      micAnnounceTimerRef.current = null;
    }
    if (speechFallbackTimerRef.current !== null) {
      window.clearTimeout(speechFallbackTimerRef.current);
      speechFallbackTimerRef.current = null;
    }
  }, []);

  const cancelBrowserSpeech = useCallback(() => {
    isSpeakingRef.current = false;
    if (speechFallbackTimerRef.current !== null) {
      window.clearTimeout(speechFallbackTimerRef.current);
      speechFallbackTimerRef.current = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  // Coordinated voice turn & barge-in state machine
  const coordinator = useMemo(
    () =>
      new VoiceInterruptionCoordinator(
        {
          cancelSystemSpeech: () => {
            cancelBrowserSpeech();
          },
          speakChunk: (chunkText, generationId, onChunkComplete) => {
            if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
              onChunkComplete(generationId);
              return;
            }

            if (speechFallbackTimerRef.current !== null) {
              window.clearTimeout(speechFallbackTimerRef.current);
              speechFallbackTimerRef.current = null;
            }

            const utterance = new SpeechSynthesisUtterance(chunkText);
            const voices = window.speechSynthesis.getVoices();
            const chosenVoice = selectPreferredFemaleVoice(
              voices,
              settingsRef.current.selectedVoiceURI
            );
            if (chosenVoice) {
              utterance.voice = chosenVoice;
            }
            utterance.rate = settingsRef.current.speechRate;
            utterance.pitch = 1.03;
            utterance.volume = 1;

            let finished = false;
            const completeChunk = () => {
              if (finished) return;
              finished = true;
              if (speechFallbackTimerRef.current !== null) {
                window.clearTimeout(speechFallbackTimerRef.current);
                speechFallbackTimerRef.current = null;
              }
              onChunkComplete(generationId);
            };

            utterance.onstart = () => {
              isSpeakingRef.current = true;
              vadMonitorRef.current.markAssistantSpeechStarted(
                typeof performance !== 'undefined' ? performance.now() : Date.now()
              );
            };

            utterance.onend = completeChunk;
            utterance.onerror = completeChunk;

            isSpeakingRef.current = true;
            vadMonitorRef.current.markAssistantSpeechStarted(
              typeof performance !== 'undefined' ? performance.now() : Date.now()
            );

            window.speechSynthesis.speak(utterance);

            // Safety fallback in case mobile SpeechSynthesis stalls silently
            const minFallback = chunkText.length < 18 ? 1400 : 2500;
            const estimatedMs = Math.max(
              minFallback,
              Math.min(22000, chunkText.length * 90)
            );
            speechFallbackTimerRef.current = window.setTimeout(() => {
              if (!finished && !window.speechSynthesis.speaking) {
                completeChunk();
              }
            }, estimatedMs);
          },
          onStateChange: (nextState, detail) => {
            isSpeakingRef.current = nextState === 'speaking';
            setStatus(nextState);
            if (detail) {
              setStatusDetail(detail);
            }
          },
          onSpeechInterrupted: (snapshot) => {
            lastInterruptedRef.current = snapshot;
            onSpeechInterruptedRef.current?.(snapshot);
          },
        },
        {
          dedupeWindowMs: 1400,
          interruptedSettleMs: 90,
          resumingHoldMs: 140,
          maxChunkChars: 210,
        }
      ),
    [cancelBrowserSpeech]
  );

  const abortRecognitionSilently = useCallback(() => {
    isListeningIntentRef.current = false;
    isUserSpeakingRef.current = false;
    isRecognitionStartedRef.current = false;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.onstart = null;
        recognitionRef.current.onresult = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onend = null;
        recognitionRef.current.abort();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    }
    setInterimTranscript('');
  }, []);

  /**
   * Finishes active buffered VAD capture (either on trailing silence or manual tap),
   * releases the microphone hardware cleanly, and sends the preserved pre-roll + utterance WAV
   * to `/api/transcribe-interruption`.
   */
  const finalizeVadCapturedUtterance = useCallback(async () => {
    if (!vadCapturingRef.current) return;

    vadCapturingRef.current = false;
    isUserSpeakingRef.current = false;
    const clip = pcmRecorderRef.current.finishCapture();
    stopVadAudioMonitor();

    if (manualStopRef.current) return;

    const minUsefulSamples = Math.floor(TARGET_PCM_SAMPLE_RATE * 0.2);
    if (clip.samples.length < minUsefulSamples) {
      if (speechRecognitionSupportedRef.current && startListeningRef.current) {
        listenRestartTimerRef.current = window.setTimeout(() => {
          if (!manualStopRef.current && !recognitionRef.current) {
            void startListeningRef.current?.({
              skipMicAnnouncement: true,
              fromInterruption: true,
            });
          }
        }, ANDROID_AUDIO_RELEASE_SETTLE_MS);
      } else {
        coordinator.transitionToIdle('Tap anywhere to speak.');
      }
      return;
    }

    const transcribeReqId = coordinator.beginAudioTranscription(
      'Understanding your interruption...'
    );
    announce('Understanding what you said.');

    const wavBase64 = encodePcmToWavBase64(clip.samples, clip.sampleRate);
    const result = await requestInterruptionTranscription(wavBase64, 'audio/wav');

    if (manualStopRef.current || !coordinator.isRequestCurrent(transcribeReqId)) {
      return;
    }

    if (!result.ok || !result.transcript) {
      // Fallback cleanly to live SpeechRecognition so user is never left stranded
      if (speechRecognitionSupportedRef.current && startListeningRef.current) {
        announce('Go ahead, listening now.');
        void startListeningRef.current({
          skipMicAnnouncement: true,
          fromInterruption: true,
        });
      } else {
        coordinator.transitionToIdle('Tap anywhere to speak.');
      }
      return;
    }

    const cleaned = result.transcript.trim();
    const wordCount = cleaned.split(/\s+/).filter(Boolean).length;

    // Conservative echo check ONLY on pre-roll buffer recorded while AI speakers were active
    if (wordCount >= 3 && coordinator.isLikelyEcho(cleaned)) {
      if (speechRecognitionSupportedRef.current && startListeningRef.current) {
        void startListeningRef.current({
          skipMicAnnouncement: true,
          fromInterruption: true,
        });
      } else {
        coordinator.transitionToIdle('Tap anywhere to speak.');
      }
      return;
    }

    processUserQueryRef.current?.(cleaned);
  }, [announce, coordinator, stopVadAudioMonitor]);

  /**
   * Acquires ONE echo-cancelled MediaStream (or reuses a preacquired stream from user gesture)
   * exclusively during AI speech playback for Web Audio VAD + continuous 1.5s PCM pre-roll buffering.
   * Never runs concurrently with SpeechRecognition.
   */
  const startVadAudioMonitor = useCallback(
    async (preacquiredStream?: MediaStream | null) => {
      if (manualStopRef.current || vadIntervalRef.current !== null || vadStartingRef.current) {
        if (preacquiredStream && vadStreamRef.current !== preacquiredStream) {
          preacquiredStream.getTracks().forEach((t) => t.stop());
        }
        return;
      }

      if (
        !preacquiredStream &&
        (typeof navigator === 'undefined' ||
          !navigator.mediaDevices ||
          !navigator.mediaDevices.getUserMedia)
      ) {
        return;
      }

      const AudioCtx = getAudioContextCtor();
      if (!AudioCtx) {
        preacquiredStream?.getTracks().forEach((t) => t.stop());
        return;
      }

      // Single-owner guarantee: SpeechRecognition MUST be closed before opening MediaStream
      if (recognitionRef.current) {
        abortRecognitionSilently();
      }

      vadStartingRef.current = true;

      try {
        const stream =
          preacquiredStream ??
          (await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          }));

        vadStartingRef.current = false;

        // Abort safely if state changed (cancelled or finished speaking while awaiting permission)
        if (
          manualStopRef.current ||
          (!coordinator.isSpeaking() && !isSpeakingRef.current)
        ) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        setMicPermission('granted');
        micPermissionRef.current = 'granted';
        vadStreamRef.current = stream;

        const audioCtx = new AudioCtx();
        if (audioCtx.state === 'suspended') {
          void audioCtx.resume().catch(() => {});
        }
        audioContextRef.current = audioCtx;

        const sourceNode = audioCtx.createMediaStreamSource(stream);
        sourceNodeRef.current = sourceNode;

        const bandFilter = audioCtx.createBiquadFilter();
        bandFilter.type = 'bandpass';
        bandFilter.frequency.value = 1100;
        bandFilter.Q.value = 0.7;

        const fullAnalyser = audioCtx.createAnalyser();
        fullAnalyser.fftSize = 1024;

        const bandAnalyser = audioCtx.createAnalyser();
        bandAnalyser.fftSize = 1024;

        sourceNode.connect(fullAnalyser);
        sourceNode.connect(bandFilter);
        bandFilter.connect(bandAnalyser);

        // Zero-gain destination link is mandatory on Android Chromium for onaudioprocess to fire
        const scriptNode = audioCtx.createScriptProcessor(2048, 1, 1);
        const zeroGain = audioCtx.createGain();
        zeroGain.gain.value = 0;

        sourceNode.connect(scriptNode);
        scriptNode.connect(zeroGain);
        zeroGain.connect(audioCtx.destination);

        scriptNodeRef.current = scriptNode;
        zeroGainNodeRef.current = zeroGain;

        pcmRecorderRef.current.reset();
        vadCapturingRef.current = false;

        scriptNode.onaudioprocess = (event: AudioProcessingEvent) => {
          if (manualStopRef.current || !vadStreamRef.current) return;
          const channel = event.inputBuffer.getChannelData(0);
          pcmRecorderRef.current.pushAudioFrame(channel, audioCtx.sampleRate);
        };

        const fullBuffer = new Float32Array(new ArrayBuffer(fullAnalyser.fftSize * 4));
        const bandBuffer = new Float32Array(new ArrayBuffer(bandAnalyser.fftSize * 4));

        vadIntervalRef.current = window.setInterval(() => {
          if (!vadStreamRef.current || manualStopRef.current) return;

          const fullRms = computeTimeDomainRms(fullAnalyser, fullBuffer);
          const bandRms = computeTimeDomainRms(bandAnalyser, bandBuffer);
          const ts = typeof performance !== 'undefined' ? performance.now() : Date.now();

          if (vadCapturingRef.current) {
            const speechThreshold = Math.max(
              0.022,
              vadMonitorRef.current.getNoiseFloor() * 2.1
            );
            const bandRatio = fullRms > 0.0005 ? bandRms / fullRms : 1;
            const userStillSpeaking = bandRms >= speechThreshold && bandRatio >= 0.32;
            const shouldFinish =
              endpointerRef.current.update(userStillSpeaking, ts) ||
              pcmRecorderRef.current.isMaxDurationReached();

            if (shouldFinish) {
              void finalizeVadCapturedUtterance();
            }
            return;
          }

          const assistantSpeaking =
            coordinator.isSpeaking() ||
            isSpeakingRef.current ||
            (typeof window !== 'undefined' &&
              'speechSynthesis' in window &&
              window.speechSynthesis.speaking);

          const evalResult = vadMonitorRef.current.evaluateFrame({
            fullRms,
            bandRms,
            timestampMs: ts,
            isAssistantSpeaking: assistantSpeaking,
          });

          if (evalResult.shouldInterrupt) {
            if (thinkingTimerRef.current !== null) {
              window.clearTimeout(thinkingTimerRef.current);
              thinkingTimerRef.current = null;
            }
            if (listenRestartTimerRef.current !== null) {
              window.clearTimeout(listenRestartTimerRef.current);
              listenRestartTimerRef.current = null;
            }

            cancelBrowserSpeech();
            coordinator.interrupt({
              reason: 'vad',
              skipListeningTransition: true,
            });
            pcmRecorderRef.current.beginCapture();
            vadCapturingRef.current = true;
            isUserSpeakingRef.current = true;
            endpointerRef.current.start(ts);
            announce('Speech interrupted. Listening.');
            coordinator.transitionToListening('Interrupted — speak your question...');
          }
        }, VAD_SAMPLE_INTERVAL_MS);
      } catch (err) {
        vadStartingRef.current = false;
        const errorName = err instanceof Error ? err.name : '';
        if (errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError') {
          setMicPermission('denied');
          micPermissionRef.current = 'denied';
        }
      }
    },
    [
      abortRecognitionSilently,
      announce,
      cancelBrowserSpeech,
      coordinator,
      finalizeVadCapturedUtterance,
    ]
  );

  // Detect browser SpeechRecognition & SpeechSynthesis support + load voices
  useEffect(() => {
    const ctor = getSpeechRecognitionCtor();
    setSpeechRecognitionSupported(Boolean(ctor));
    if (!ctor) {
      setMicPermission('unsupported');
    }

    const hasSynth =
      typeof window !== 'undefined' && 'speechSynthesis' in window;
    setSpeechSynthesisSupported(hasSynth);

    if (!hasSynth) return;

    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        setAvailableVoices(voices);
      }
    };

    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', loadVoices);
    };
  }, []);

  // Check microphone permission status passively
  useEffect(() => {
    if (
      typeof navigator === 'undefined' ||
      !navigator.permissions ||
      !getSpeechRecognitionCtor()
    ) {
      return;
    }
    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((permStatus) => {
        if (permStatus.state === 'granted') {
          setMicPermission('granted');
          micPermissionRef.current = 'granted';
        } else if (permStatus.state === 'denied') {
          setMicPermission('denied');
          micPermissionRef.current = 'denied';
        } else {
          setMicPermission('prompt');
          micPermissionRef.current = 'prompt';
        }

        permStatus.onchange = () => {
          if (permStatus.state === 'granted') {
            setMicPermission('granted');
            micPermissionRef.current = 'granted';
          } else if (permStatus.state === 'denied') {
            setMicPermission('denied');
            micPermissionRef.current = 'denied';
          } else {
            setMicPermission('prompt');
            micPermissionRef.current = 'prompt';
          }
        };
      })
      .catch(() => {});
  }, []);

  const stopSpeaking = useCallback(() => {
    manualStopRef.current = true;
    stopVadAudioMonitor();
    coordinator.stopSpeechToIdle();
  }, [coordinator, stopVadAudioMonitor]);

  const speakText = useCallback(
    (
      text: string,
      options?: {
        expectedRequestId?: number;
        onEnd?: () => void;
        setSpeakingState?: boolean;
        listenAfter?: boolean;
        preacquiredStream?: MediaStream | null;
      }
    ) => {
      const shouldSetSpeaking = options?.setSpeakingState ?? true;

      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        options?.preacquiredStream?.getTracks().forEach((t) => t.stop());
        if (shouldSetSpeaking) {
          coordinator.transitionToIdle(
            'Response ready in text log. Speech synthesis is unavailable in this browser.'
          );
        }
        options?.onEnd?.();
        return;
      }

      if (shouldSetSpeaking) {
        // Ensure SpeechRecognition never competes with TTS + VAD mic monitor
        abortRecognitionSilently();
        if (micPermissionRef.current === 'granted' && !manualStopRef.current) {
          void startVadAudioMonitor(options?.preacquiredStream);
        } else if (options?.preacquiredStream) {
          void startVadAudioMonitor(options.preacquiredStream);
        }
      } else if (options?.preacquiredStream) {
        options.preacquiredStream.getTracks().forEach((t) => t.stop());
      }

      coordinator.speak(text, {
        expectedRequestId: options?.expectedRequestId,
        setSpeakingState: shouldSetSpeaking,
        listenAfter: options?.listenAfter,
        onEnd: () => {
          if (shouldSetSpeaking && !vadCapturingRef.current) {
            stopVadAudioMonitor();
          }
          options?.onEnd?.();
        },
      });
    },
    [abortRecognitionSilently, coordinator, startVadAudioMonitor, stopVadAudioMonitor]
  );

  const playWelcomeGreeting = useCallback(() => {
    manualStopRef.current = false;
    announce(WELCOME_GREETING);
    speakText(WELCOME_GREETING);
  }, [announce, speakText]);

  useEffect(() => {
    if (hasAttemptedAutoGreetRef.current) return;
    hasAttemptedAutoGreetRef.current = true;
    announce('Glow-A-Eye loaded. Tap anywhere to begin.');
  }, [announce]);

  const stopListening = useCallback(
    (announceStop = true) => {
      manualStopRef.current = true;
      clearTimers();
      abortRecognitionSilently();
      stopVadAudioMonitor();

      if (
        coordinator.getState() === 'listening' ||
        coordinator.getState() === 'interrupted' ||
        coordinator.getState() === 'processing'
      ) {
        coordinator.transitionToIdle(
          'Microphone is off. Activate listening whenever you are ready.'
        );
      } else {
        setStatusDetail('Microphone is off. Activate listening whenever you are ready.');
      }

      if (announceStop) {
        playAudioCue('listen-stop', settingsRef.current.audioCuesEnabled);
        announce('Microphone stopped. No longer listening.');
        if (settingsRef.current.autoAnnounceMic) {
          speakText('Microphone stopped.', { setSpeakingState: false });
        }
      }
    },
    [
      abortRecognitionSilently,
      announce,
      clearTimers,
      coordinator,
      speakText,
      stopVadAudioMonitor,
    ]
  );

  const speakWithListeningFollowUp = useCallback(
    (
      text: string,
      options?: {
        expectedRequestId?: number;
        alsoLog?: boolean;
        listenAfter?: boolean;
        onDone?: () => void;
        preacquiredStream?: MediaStream | null;
      }
    ) => {
      manualStopRef.current = false;
      if (options?.alsoLog) {
        appendMessage('assistant', text);
      }
      announce(text);

      const shouldAutoListen =
        (options?.listenAfter ?? true) &&
        speechRecognitionSupportedRef.current &&
        (micPermissionRef.current === 'granted' || Boolean(options?.preacquiredStream));

      speakText(text, {
        expectedRequestId: options?.expectedRequestId,
        listenAfter: shouldAutoListen,
        preacquiredStream: options?.preacquiredStream,
        onEnd: () => {
          options?.onDone?.();
          if (shouldAutoListen && !manualStopRef.current && !vadCapturingRef.current) {
            if (listenRestartTimerRef.current !== null) {
              window.clearTimeout(listenRestartTimerRef.current);
            }
            const genAtEnd = coordinator.getSpeechGenerationId();
            listenRestartTimerRef.current = window.setTimeout(() => {
              if (
                !manualStopRef.current &&
                !vadCapturingRef.current &&
                coordinator.isSpeechCurrent(genAtEnd) &&
                !recognitionRef.current &&
                startListeningRef.current
              ) {
                void startListeningRef.current({ skipMicAnnouncement: true });
              }
            }, ANDROID_AUDIO_RELEASE_SETTLE_MS + 15);
          }
        },
      });
    },
    [announce, appendMessage, coordinator, speakText]
  );

  const processUserQuery = useCallback(
    (rawText: string) => {
      const cleaned = rawText.trim();
      if (!cleaned) return;

      const turn = coordinator.beginProcessing(cleaned);
      if (!turn.accepted) {
        return;
      }

      const { requestId } = turn;
      appendMessage('user', cleaned);
      announce('Processing.');

      if (thinkingTimerRef.current !== null) {
        window.clearTimeout(thinkingTimerRef.current);
      }

      thinkingTimerRef.current = window.setTimeout(() => {
        if (!coordinator.isRequestCurrent(requestId)) {
          return;
        }

        const result = interpretVoiceInput(cleaned, cameraContextRef.current);

        if (result.action.type === 'stop_speaking') {
          cancelBrowserSpeech();
          const closedVad = stopVadAudioMonitor();
          coordinator.transitionToListening('Speech stopped — listening...');
          announce('Speech stopped. Listening.');
          if (
            !manualStopRef.current &&
            micPermissionRef.current === 'granted' &&
            !recognitionRef.current &&
            startListeningRef.current
          ) {
            listenRestartTimerRef.current = window.setTimeout(() => {
              if (!manualStopRef.current && !recognitionRef.current) {
                void startListeningRef.current?.({
                  skipMicAnnouncement: true,
                  fromInterruption: true,
                });
              }
            }, closedVad ? ANDROID_AUDIO_RELEASE_SETTLE_MS : 20);
          }
          return;
        }

        if (result.action.type === 'repeat') {
          if (cameraContextRef.current.isCameraActive) {
            onActionRef.current(result.action);
            return;
          }
          const repeated = lastAssistantMessageRef.current;
          announce(`Repeating: ${repeated}`);
          speakWithListeningFollowUp(repeated, {
            expectedRequestId: requestId,
            alsoLog: true,
            listenAfter: true,
          });
          return;
        }

        if (result.action.type !== 'none') {
          onActionRef.current(result.action);
        }

        if (result.action.type === 'stop_listening') {
          stopListening(false);
          appendMessage('assistant', result.reply);
          announce(result.reply);
          speakText(result.reply, { setSpeakingState: false });
          return;
        }

        if (result.handledByAction || !result.reply) {
          return;
        }

        speakWithListeningFollowUp(result.reply, {
          expectedRequestId: requestId,
          alsoLog: true,
          listenAfter: true,
        });
      }, 180);
    },
    [
      announce,
      appendMessage,
      cancelBrowserSpeech,
      coordinator,
      speakText,
      speakWithListeningFollowUp,
      stopListening,
      stopVadAudioMonitor,
    ]
  );

  useEffect(() => {
    processUserQueryRef.current = processUserQuery;
  }, [processUserQuery]);

  const startListening = useCallback(
    async (opts?: { skipMicAnnouncement?: boolean; fromInterruption?: boolean }) => {
      manualStopRef.current = false;

      if (listenRestartTimerRef.current !== null) {
        window.clearTimeout(listenRestartTimerRef.current);
        listenRestartTimerRef.current = null;
      }
      if (micAnnounceTimerRef.current !== null) {
        window.clearTimeout(micAnnounceTimerRef.current);
        micAnnounceTimerRef.current = null;
      }

      const RecognitionCtor = getSpeechRecognitionCtor();
      if (!RecognitionCtor) {
        setSpeechRecognitionSupported(false);
        setMicPermission('unsupported');
        const msg =
          'Voice recognition is not supported in this browser. Please open Glow-A-Eye in Chrome, Edge, or Safari to speak.';
        coordinator.transitionToError(msg);
        playAudioCue('error', settingsRef.current.audioCuesEnabled);
        appendMessage('system', msg);
        announce(msg);
        speakText(msg, { setSpeakingState: false });
        return;
      }

      // Halt active TTS immediately before activating listening
      if (coordinator.isSpeaking() || isSpeakingRef.current) {
        coordinator.interrupt({ skipListeningTransition: true });
      }

      // Single-owner microphone rule: release any open Web Audio VAD stream BEFORE starting SpeechRecognition
      let closedHardware = stopVadAudioMonitor();

      // Request microphone permission cleanly once if still 'prompt' or 'denied'
      if (
        micPermissionRef.current !== 'granted' &&
        navigator.mediaDevices &&
        navigator.mediaDevices.getUserMedia
      ) {
        try {
          setStatusDetail('Requesting microphone access...');
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
          stream.getTracks().forEach((track) => track.stop());
          closedHardware = true;
          setMicPermission('granted');
          micPermissionRef.current = 'granted';
        } catch (err) {
          const errorName = err instanceof Error ? err.name : '';
          const denied =
            errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError';
          setMicPermission(denied ? 'denied' : 'prompt');
          micPermissionRef.current = denied ? 'denied' : 'prompt';
          const msg = denied
            ? 'Microphone permission was denied. Please allow microphone access in your browser settings, then tap anywhere to try again.'
            : 'No active microphone was detected. Please connect a microphone and tap anywhere to try again.';
          coordinator.transitionToError(msg);
          playAudioCue('error', settingsRef.current.audioCuesEnabled);
          appendMessage('system', msg);
          announce(msg);
          speakText(msg, { setSpeakingState: false });
          return;
        }
      }

      if (manualStopRef.current) return;

      if (recognitionRef.current) {
        coordinator.transitionToListening(
          opts?.fromInterruption ? 'Interrupted — listening...' : 'Listening...'
        );
        return;
      }

      let retriedAfterAudioCapture = false;

      const beginRecognitionSession = () => {
        if (manualStopRef.current || recognitionRef.current) return;

        // Extra safety check: ensure VAD stream is still closed
        stopVadAudioMonitor();

        try {
          const recognition = new RecognitionCtor();
          recognition.continuous = false;
          recognition.interimResults = true;
          recognition.lang = 'en-US';
          recognition.maxAlternatives = 1;

          let finalTranscript = '';

          recognition.onstart = () => {
            isRecognitionStartedRef.current = true;
            isListeningIntentRef.current = true;
            isUserSpeakingRef.current = false;
            coordinator.transitionToListening(
              opts?.fromInterruption ? 'Interrupted — listening...' : 'Listening...'
            );
            playAudioCue('listen-start', settingsRef.current.audioCuesEnabled);
            announce('Listening now.');
          };

          recognition.onresult = (event: SpeechRecognitionEventLike) => {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; i += 1) {
              const segment = event.results[i][0]?.transcript ?? '';
              if (event.results[i].isFinal) {
                finalTranscript += `${segment} `;
              } else {
                interim += segment;
              }
            }
            const activeText = interim.trim() || finalTranscript.trim();
            isUserSpeakingRef.current = activeText.length > 0;
            setInterimTranscript(activeText);
          };

          recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
            isListeningIntentRef.current = false;
            isUserSpeakingRef.current = false;
            isRecognitionStartedRef.current = false;
            recognitionRef.current = null;
            setInterimTranscript('');

            // Transient audio-capture race on mobile hardware: settle briefly and retry once
            if (event.error === 'audio-capture' && !retriedAfterAudioCapture) {
              retriedAfterAudioCapture = true;
              stopVadAudioMonitor();
              listenRestartTimerRef.current = window.setTimeout(() => {
                if (!manualStopRef.current && !recognitionRef.current) {
                  beginRecognitionSession();
                }
              }, 140);
              return;
            }

            if (event.error === 'aborted') {
              if (!coordinator.isSpeaking()) {
                coordinator.transitionToIdle('Tap anywhere to speak.');
              }
              return;
            }

            if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
              setMicPermission('denied');
              micPermissionRef.current = 'denied';
              const deniedMsg =
                'Microphone permission was not granted. Please enable microphone access in your browser and tap anywhere to try again.';
              coordinator.transitionToError(deniedMsg);
              playAudioCue('error', settingsRef.current.audioCuesEnabled);
              appendMessage('system', deniedMsg);
              announce(deniedMsg);
              speakText(deniedMsg, { setSpeakingState: false });
              return;
            }

            if (event.error === 'no-speech') {
              if (opts?.fromInterruption) {
                coordinator.transitionToIdle('Go ahead when ready — tap to speak.');
                return;
              }
              coordinator.transitionToIdle('Tap anywhere to speak.');
              const noSpeechMsg =
                'I did not hear any speech. Tap anywhere whenever you are ready to speak.';
              playAudioCue('listen-stop', settingsRef.current.audioCuesEnabled);
              announce(noSpeechMsg);
              speakText(noSpeechMsg, { setSpeakingState: false });
              return;
            }

            const genericMsg =
              'Microphone listening was interrupted. Tap anywhere to try again.';
            coordinator.transitionToError(genericMsg);
            playAudioCue('error', settingsRef.current.audioCuesEnabled);
            appendMessage('system', genericMsg);
            announce(genericMsg);
            speakText(genericMsg, { setSpeakingState: false });
          };

          recognition.onend = () => {
            recognitionRef.current = null;
            isRecognitionStartedRef.current = false;
            isUserSpeakingRef.current = false;
            const captured = finalTranscript.trim();
            setInterimTranscript('');

            // Do NOT apply echo filtering during normal SpeechRecognition listening
            if (captured) {
              isListeningIntentRef.current = false;
              processUserQuery(captured);
            } else if (isListeningIntentRef.current) {
              isListeningIntentRef.current = false;
              if (
                coordinator.getState() === 'listening' ||
                coordinator.getState() === 'interrupted'
              ) {
                coordinator.transitionToIdle('Tap anywhere to speak.');
              }
            }
          };

          recognitionRef.current = recognition;
          recognition.start();
        } catch {
          recognitionRef.current = null;
          isRecognitionStartedRef.current = false;
          const failMsg =
            'Unable to start speech recognition right now. Tap anywhere to try again.';
          coordinator.transitionToError(failMsg);
          playAudioCue('error', settingsRef.current.audioCuesEnabled);
          announce(failMsg);
        }
      };

      const scheduleBeginRecognition = (extraDelayMs = 0) => {
        const delayMs = Math.max(
          closedHardware ? ANDROID_AUDIO_RELEASE_SETTLE_MS : 0,
          extraDelayMs
        );
        if (delayMs <= 0) {
          beginRecognitionSession();
        } else {
          listenRestartTimerRef.current = window.setTimeout(() => {
            if (!manualStopRef.current && !recognitionRef.current) {
              beginRecognitionSession();
            }
          }, delayMs);
        }
      };

      if (
        !opts?.skipMicAnnouncement &&
        settingsRef.current.autoAnnounceMic &&
        speechSynthesisSupported
      ) {
        coordinator.transitionToListening('Activating microphone...');
        announce('Activating microphone.');
        let started = false;
        const startAfterCue = () => {
          if (started || manualStopRef.current) return;
          started = true;
          if (micAnnounceTimerRef.current !== null) {
            window.clearTimeout(micAnnounceTimerRef.current);
            micAnnounceTimerRef.current = null;
          }
          scheduleBeginRecognition(110);
        };

        speakText('Microphone active. Listening.', {
          setSpeakingState: false,
          onEnd: startAfterCue,
        });

        // Safety timeout only if browser TTS stalls completely
        micAnnounceTimerRef.current = window.setTimeout(() => {
          if (!started && !manualStopRef.current) {
            cancelBrowserSpeech();
            startAfterCue();
          }
        }, 4200);
      } else {
        scheduleBeginRecognition(0);
      }
    },
    [
      announce,
      appendMessage,
      cancelBrowserSpeech,
      coordinator,
      processUserQuery,
      speakText,
      speechSynthesisSupported,
      stopVadAudioMonitor,
    ]
  );

  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  const beginConversation = useCallback(
    async (customGreeting?: string) => {
      const greeting = customGreeting ?? WELCOME_GREETING;
      manualStopRef.current = false;
      clearTimers();
      abortRecognitionSilently();
      stopVadAudioMonitor();

      let preacquiredStream: MediaStream | null = null;
      if (
        typeof navigator !== 'undefined' &&
        navigator.mediaDevices &&
        navigator.mediaDevices.getUserMedia
      ) {
        try {
          setStatusDetail('Requesting microphone access...');
          preacquiredStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
          if (manualStopRef.current) {
            preacquiredStream.getTracks().forEach((t) => t.stop());
            return;
          }
          setMicPermission('granted');
          micPermissionRef.current = 'granted';
        } catch (err) {
          const errorName = err instanceof Error ? err.name : '';
          const denied =
            errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError';
          setMicPermission(denied ? 'denied' : 'prompt');
          micPermissionRef.current = denied ? 'denied' : 'prompt';
          const msg = denied
            ? 'Microphone permission was denied. Please allow microphone access in your browser settings, then tap anywhere to try again.'
            : 'No active microphone was detected. Please connect a microphone and tap anywhere to try again.';
          coordinator.transitionToError(msg);
          playAudioCue('error', settingsRef.current.audioCuesEnabled);
          appendMessage('system', msg);
          announce(msg);
          speakText(msg, { setSpeakingState: false });
          return;
        }
      }

      playAudioCue('listen-start', settingsRef.current.audioCuesEnabled);
      announce(greeting);
      speakWithListeningFollowUp(greeting, {
        alsoLog: false,
        listenAfter: true,
        preacquiredStream,
      });
    },
    [
      abortRecognitionSilently,
      announce,
      appendMessage,
      clearTimers,
      coordinator,
      speakText,
      speakWithListeningFollowUp,
      stopVadAudioMonitor,
    ]
  );

  const endConversation = useCallback(
    (closingText = 'Conversation ended. Tap anywhere whenever you want to begin again.') => {
      manualStopRef.current = true;
      clearTimers();
      abortRecognitionSilently();
      stopVadAudioMonitor();
      coordinator.stopSpeechToIdle();
      playAudioCue('listen-stop', settingsRef.current.audioCuesEnabled);
      appendMessage('assistant', closingText);
      announce(closingText);
      speakText(closingText, { setSpeakingState: false });
      setStatusDetail('Tap anywhere to begin.');
    },
    [
      abortRecognitionSilently,
      announce,
      appendMessage,
      clearTimers,
      coordinator,
      speakText,
      stopVadAudioMonitor,
    ]
  );

  const repeatLastResponse = useCallback(() => {
    const text = lastAssistantMessageRef.current;
    announce(`Repeating last response: ${text}`);
    speakWithListeningFollowUp(text, { alsoLog: false, listenAfter: true });
  }, [announce, speakWithListeningFollowUp]);

  const rephraseLastResponse = useCallback(() => {
    const base = lastAssistantMessageRef.current;
    const sentences = base
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const condensed =
      sentences.length > 2
        ? `${sentences[0]} ${sentences[sentences.length - 1]}`
        : base;
    const msg = `Let me put that more simply: ${condensed}`;
    speakWithListeningFollowUp(msg, { alsoLog: true, listenAfter: true });
  }, [speakWithListeningFollowUp]);

  const pauseForUserSpeech = useCallback(() => {
    manualStopRef.current = false;
    cancelBrowserSpeech();
    const closedVad = stopVadAudioMonitor();
    coordinator.transitionToListening('Paused for your question — listening...');
    announce('Go ahead, I am listening.');
    if (
      !recognitionRef.current &&
      micPermissionRef.current === 'granted' &&
      startListeningRef.current
    ) {
      listenRestartTimerRef.current = window.setTimeout(() => {
        if (!manualStopRef.current && !recognitionRef.current) {
          void startListeningRef.current?.({
            skipMicAnnouncement: true,
            fromInterruption: true,
          });
        }
      }, closedVad ? ANDROID_AUDIO_RELEASE_SETTLE_MS : 20);
    }
  }, [announce, cancelBrowserSpeech, coordinator, stopVadAudioMonitor]);

  const resumeInterruptedSpeech = useCallback(
    (fallbackResumeText?: string) => {
      const snap = coordinator.getLastInterruptedSnapshot() ?? lastInterruptedRef.current;
      const resumeText =
        (snap?.remainingText && snap.remainingText.trim()) ||
        fallbackResumeText ||
        lastAssistantMessageRef.current;

      coordinator.transitionToResuming('Resuming where we left off...', () => {
        coordinator.clearInterruptedSnapshot();
        lastInterruptedRef.current = null;
        speakWithListeningFollowUp(`Continuing from earlier: ${resumeText}`, {
          alsoLog: true,
          listenAfter: true,
        });
      });
    },
    [coordinator, speakWithListeningFollowUp]
  );

  const speakCustomFeedback = useCallback(
    (
      text: string,
      alsoLog = false,
      options?: { listenAfter?: boolean; onDone?: () => void }
    ) => {
      manualStopRef.current = false;
      abortRecognitionSilently();

      if (alsoLog) {
        appendMessage('assistant', text);
      }
      announce(text);

      const shouldAutoListen =
        Boolean(options?.listenAfter) &&
        speechRecognitionSupportedRef.current &&
        micPermissionRef.current === 'granted';

      speakText(text, {
        listenAfter: shouldAutoListen,
        onEnd: () => {
          options?.onDone?.();
          if (shouldAutoListen && !manualStopRef.current && !vadCapturingRef.current) {
            if (listenRestartTimerRef.current !== null) {
              window.clearTimeout(listenRestartTimerRef.current);
            }
            const genAtEnd = coordinator.getSpeechGenerationId();
            listenRestartTimerRef.current = window.setTimeout(() => {
              if (
                !manualStopRef.current &&
                !vadCapturingRef.current &&
                coordinator.isSpeechCurrent(genAtEnd) &&
                !recognitionRef.current &&
                startListeningRef.current
              ) {
                void startListeningRef.current({ skipMicAnnouncement: true });
              }
            }, ANDROID_AUDIO_RELEASE_SETTLE_MS + 15);
          }
        },
      });
    },
    [abortRecognitionSilently, announce, appendMessage, coordinator, speakText]
  );

  const interruptNow = useCallback(() => {
    if (!coordinator.isSpeaking() && !isSpeakingRef.current) {
      return;
    }

    clearTimers();
    cancelBrowserSpeech();
    const closedVad = stopVadAudioMonitor();
    coordinator.interrupt({
      reason: 'manual',
      skipListeningTransition: true,
    });
    announce('Speech interrupted. Listening.');

    if (!manualStopRef.current && startListeningRef.current) {
      listenRestartTimerRef.current = window.setTimeout(() => {
        if (!manualStopRef.current && !recognitionRef.current) {
          void startListeningRef.current?.({
            skipMicAnnouncement: true,
            fromInterruption: true,
          });
        }
      }, closedVad ? ANDROID_AUDIO_RELEASE_SETTLE_MS : 25);
    }
  }, [announce, cancelBrowserSpeech, clearTimers, coordinator, stopVadAudioMonitor]);

  const finishInterruptionCaptureIfActive = useCallback((): boolean => {
    if (!vadCapturingRef.current) return false;
    void finalizeVadCapturedUtterance();
    return true;
  }, [finalizeVadCapturedUtterance]);

  const isCapturingInterruption = useCallback(() => vadCapturingRef.current, []);

  const isAssistantSpeaking = useCallback(
    () => coordinator.isSpeaking() || isSpeakingRef.current,
    [coordinator]
  );
  const isUserSpeaking = useCallback(
    () => isUserSpeakingRef.current || vadCapturingRef.current,
    []
  );

  // Cleanup on unmount: guarantee all MediaStream tracks, AudioContext & SpeechRecognition stop
  useEffect(() => {
    return () => {
      clearTimers();
      abortRecognitionSilently();
      stopVadAudioMonitor();
      coordinator.dispose();
    };
  }, [abortRecognitionSilently, clearTimers, coordinator, stopVadAudioMonitor]);

  return {
    status,
    statusDetail,
    liveAnnouncement,
    interimTranscript,
    micPermission,
    availableVoices,
    speechRecognitionSupported,
    speechSynthesisSupported,
    messages,
    startListening,
    stopListening,
    stopSpeaking,
    interruptNow,
    finishInterruptionCaptureIfActive,
    isCapturingInterruption,
    pauseForUserSpeech,
    resumeInterruptedSpeech,
    rephraseLastResponse,
    beginConversation,
    endConversation,
    repeatLastResponse,
    playWelcomeGreeting,
    processUserQuery,
    speakCustomFeedback,
    announce,
    isAssistantSpeaking,
    isUserSpeaking,
  };
}
