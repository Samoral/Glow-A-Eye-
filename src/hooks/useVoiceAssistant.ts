import { useCallback, useEffect, useRef, useState } from 'react';
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

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

interface UseVoiceAssistantOptions {
  settings: AssistantSettings;
  cameraContext?: VoiceCommandContext;
  onAction: (action: VoiceCommandAction) => void;
  onSectionRequest?: (section: ActiveSection) => void;
}

export function useVoiceAssistant({
  settings,
  cameraContext,
  onAction,
}: UseVoiceAssistantOptions) {
  const [status, setStatus] = useState<AssistantStatus>('idle');
  const [statusDetail, setStatusDetail] = useState<string>(
    'Tap anywhere to begin.'
  );
  const [liveAnnouncement, setLiveAnnouncement] = useState<string>('');
  const [interimTranscript, setInterimTranscript] = useState<string>('');
  const [micPermission, setMicPermission] = useState<PermissionState>('prompt');
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speechRecognitionSupported, setSpeechRecognitionSupported] = useState<boolean>(true);
  const [speechSynthesisSupported, setSpeechSynthesisSupported] = useState<boolean>(true);
  const [messages, setMessages] = useState<ConversationMessage[]>([
    {
      id: 'welcome-1',
      sender: 'assistant',
      text: WELCOME_GREETING,
      timestamp: formatSpokenTime(),
    },
  ]);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const isListeningIntentRef = useRef<boolean>(false);
  const settingsRef = useRef<AssistantSettings>(settings);
  const cameraContextRef = useRef<VoiceCommandContext>(cameraContext ?? {});
  const lastAssistantMessageRef = useRef<string>(WELCOME_GREETING);
  const thinkingTimerRef = useRef<number | null>(null);
  const hasAttemptedAutoGreetRef = useRef<boolean>(false);
  const micPermissionRef = useRef<PermissionState>('prompt');
  const speechRecognitionSupportedRef = useRef<boolean>(true);
  const manualStopRef = useRef<boolean>(false);
  const speechFallbackTimerRef = useRef<number | null>(null);
  const startListeningRef = useRef<((opts?: { skipMicAnnouncement?: boolean }) => Promise<void>) | null>(null);

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

  // Keep track of latest assistant message
  useEffect(() => {
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.sender === 'assistant');
    if (lastAssistant) {
      lastAssistantMessageRef.current = lastAssistant.text;
    }
  }, [messages]);

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

  // Check microphone permission status passively if Permissions API supports it
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
        if (permStatus.state === 'granted') setMicPermission('granted');
        else if (permStatus.state === 'denied') setMicPermission('denied');
        else setMicPermission('prompt');

        permStatus.onchange = () => {
          if (permStatus.state === 'granted') setMicPermission('granted');
          else if (permStatus.state === 'denied') setMicPermission('denied');
          else setMicPermission('prompt');
        };
      })
      .catch(() => {
        // Permissions API for microphone is not supported in all browsers; ignore cleanly.
      });
  }, []);

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

  const stopSpeaking = useCallback(() => {
    manualStopRef.current = true;
    if (speechFallbackTimerRef.current !== null) {
      window.clearTimeout(speechFallbackTimerRef.current);
      speechFallbackTimerRef.current = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setStatus((prev) => (prev === 'speaking' ? 'idle' : prev));
  }, []);

  const speakText = useCallback(
    (
      text: string,
      options?: {
        onEnd?: () => void;
        setSpeakingState?: boolean;
      }
    ) => {
      const shouldSetSpeaking = options?.setSpeakingState ?? true;

      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        if (shouldSetSpeaking) {
          setStatus('idle');
          setStatusDetail('Response ready in text log. Speech synthesis is unavailable in this browser.');
        }
        options?.onEnd?.();
        return;
      }

      if (speechFallbackTimerRef.current !== null) {
        window.clearTimeout(speechFallbackTimerRef.current);
        speechFallbackTimerRef.current = null;
      }
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
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
      const complete = () => {
        if (finished) return;
        finished = true;
        if (speechFallbackTimerRef.current !== null) {
          window.clearTimeout(speechFallbackTimerRef.current);
          speechFallbackTimerRef.current = null;
        }
        if (shouldSetSpeaking) {
          setStatus((current) => (current === 'speaking' ? 'idle' : current));
          setStatusDetail('Tap anywhere to speak.');
        }
        options?.onEnd?.();
      };

      utterance.onstart = () => {
        if (shouldSetSpeaking) {
          setStatus('speaking');
          setStatusDetail('Glow-A-Eye is speaking...');
        }
      };

      utterance.onend = complete;
      utterance.onerror = complete;

      if (shouldSetSpeaking) {
        setStatus('speaking');
        setStatusDetail('Glow-A-Eye is speaking...');
      }

      window.speechSynthesis.speak(utterance);

      // Safety fallback in case browser speech engine stalls without firing onend
      const estimatedMs = Math.max(2500, Math.min(26000, text.length * 85));
      speechFallbackTimerRef.current = window.setTimeout(() => {
        if (!finished && !window.speechSynthesis.speaking) {
          complete();
        }
      }, estimatedMs);
    },
    []
  );

  // Attempt subtle welcome greeting once if voices are ready; many browsers block TTS pre-gesture
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
      isListeningIntentRef.current = false;
      if (thinkingTimerRef.current !== null) {
        window.clearTimeout(thinkingTimerRef.current);
        thinkingTimerRef.current = null;
      }
      if (recognitionRef.current) {
        try {
          recognitionRef.current.onresult = null;
          recognitionRef.current.onerror = null;
          recognitionRef.current.onend = null;
          recognitionRef.current.stop();
        } catch {
          try {
            recognitionRef.current.abort();
          } catch {
            // ignore
          }
        }
        recognitionRef.current = null;
      }
      setInterimTranscript('');
      setStatus((prev) => (prev === 'listening' ? 'idle' : prev));
      setStatusDetail('Microphone is off. Activate listening whenever you are ready.');

      if (announceStop) {
        playAudioCue('listen-stop', settingsRef.current.audioCuesEnabled);
        announce('Microphone stopped. No longer listening.');
        if (settingsRef.current.autoAnnounceMic) {
          speakText('Microphone stopped.');
        }
      }
    },
    [announce, speakText]
  );

  const processUserQuery = useCallback(
    (rawText: string) => {
      const cleaned = rawText.trim();
      if (!cleaned) return;

      appendMessage('user', cleaned);
      setStatus('thinking');
      setStatusDetail('Thinking through your request...');
      announce('Thinking.');

      if (thinkingTimerRef.current !== null) {
        window.clearTimeout(thinkingTimerRef.current);
      }

      thinkingTimerRef.current = window.setTimeout(() => {
        const result = interpretVoiceInput(cleaned, cameraContextRef.current);

        if (result.action.type === 'stop_speaking') {
          stopSpeaking();
          announce('Speech stopped.');
          return;
        }

        if (result.action.type === 'repeat') {
          const repeated = lastAssistantMessageRef.current;
          appendMessage('assistant', repeated);
          announce(`Repeating: ${repeated}`);
          speakText(repeated);
          return;
        }

        if (result.action.type !== 'none') {
          onAction(result.action);
        }

        if (result.action.type === 'stop_listening') {
          stopListening(false);
          appendMessage('assistant', result.reply);
          announce(result.reply);
          speakText(result.reply);
          return;
        }

        if (result.handledByAction || !result.reply) {
          return;
        }

        appendMessage('assistant', result.reply);
        announce(result.reply);

        const shouldAutoListen =
          speechRecognitionSupportedRef.current &&
          micPermissionRef.current === 'granted';

        speakText(result.reply, {
          onEnd: shouldAutoListen
            ? () => {
                if (manualStopRef.current) return;
                window.setTimeout(() => {
                  if (!manualStopRef.current && startListeningRef.current) {
                    void startListeningRef.current({ skipMicAnnouncement: true });
                  }
                }, 220);
              }
            : undefined,
        });
      }, 320);
    },
    [announce, appendMessage, onAction, speakText, stopListening, stopSpeaking]
  );

  const startListening = useCallback(
    async (opts?: { skipMicAnnouncement?: boolean }) => {
      manualStopRef.current = false;
      const RecognitionCtor = getSpeechRecognitionCtor();
      if (!RecognitionCtor) {
        setSpeechRecognitionSupported(false);
        setMicPermission('unsupported');
        setStatus('error');
        const msg =
          'Voice recognition is not supported in this browser. Please open Glow-A-Eye in Chrome, Edge, or Safari to speak.';
        setStatusDetail(msg);
        playAudioCue('error', settingsRef.current.audioCuesEnabled);
        appendMessage('system', msg);
        announce(msg);
        speakText(msg, { setSpeakingState: false });
        return;
      }

      // Stop any ongoing speech before opening microphone
      stopSpeaking();
      manualStopRef.current = false;

      // Verify real microphone hardware & permission before claiming mic is active
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
          setStatusDetail('Requesting microphone access...');
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((track) => track.stop());
          setMicPermission('granted');
        } catch (err) {
          const errorName = err instanceof Error ? err.name : '';
          const denied =
            errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError';
          setMicPermission(denied ? 'denied' : 'prompt');
          setStatus('error');
          const msg = denied
            ? 'Microphone permission was denied. Please allow microphone access in your browser settings, then tap anywhere to try again.'
            : 'No active microphone was detected. Please connect a microphone and tap anywhere to try again.';
          setStatusDetail(msg);
          playAudioCue('error', settingsRef.current.audioCuesEnabled);
          appendMessage('system', msg);
          announce(msg);
          speakText(msg, { setSpeakingState: false });
          return;
        }
      }

      const beginRecognitionSession = () => {
        try {
          const recognition = new RecognitionCtor();
          recognition.continuous = false;
          recognition.interimResults = true;
          recognition.lang = 'en-US';
          recognition.maxAlternatives = 1;

          let finalTranscript = '';

          recognition.onstart = () => {
            isListeningIntentRef.current = true;
            setStatus('listening');
            setStatusDetail('Listening...');
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
            setInterimTranscript(interim.trim() || finalTranscript.trim());
          };

          recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
            isListeningIntentRef.current = false;
            recognitionRef.current = null;
            setInterimTranscript('');

            if (event.error === 'aborted') {
              setStatus('idle');
              return;
            }

            if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
              setMicPermission('denied');
              setStatus('error');
              const deniedMsg =
                'Microphone permission was not granted. Please enable microphone access in your browser and tap anywhere to try again.';
              setStatusDetail(deniedMsg);
              playAudioCue('error', settingsRef.current.audioCuesEnabled);
              appendMessage('system', deniedMsg);
              announce(deniedMsg);
              speakText(deniedMsg, { setSpeakingState: false });
              return;
            }

            if (event.error === 'no-speech') {
              setStatus('idle');
              const noSpeechMsg =
                'I did not hear any speech. Tap anywhere whenever you are ready to speak.';
              setStatusDetail('Tap anywhere to speak.');
              playAudioCue('listen-stop', settingsRef.current.audioCuesEnabled);
              announce(noSpeechMsg);
              speakText(noSpeechMsg);
              return;
            }

            setStatus('error');
            const genericMsg =
              'Microphone listening was interrupted. Tap anywhere to try again.';
            setStatusDetail(genericMsg);
            playAudioCue('error', settingsRef.current.audioCuesEnabled);
            appendMessage('system', genericMsg);
            announce(genericMsg);
            speakText(genericMsg, { setSpeakingState: false });
          };

          recognition.onend = () => {
            recognitionRef.current = null;
            const captured = finalTranscript.trim();
            setInterimTranscript('');

            if (captured) {
              isListeningIntentRef.current = false;
              processUserQuery(captured);
            } else if (isListeningIntentRef.current) {
              isListeningIntentRef.current = false;
              setStatus('idle');
              setStatusDetail('Tap anywhere to speak.');
            }
          };

          recognitionRef.current = recognition;
          recognition.start();
        } catch {
          setStatus('error');
          const failMsg =
            'Unable to start speech recognition right now. Tap anywhere to try again.';
          setStatusDetail(failMsg);
          playAudioCue('error', settingsRef.current.audioCuesEnabled);
          announce(failMsg);
        }
      };

      if (
        !opts?.skipMicAnnouncement &&
        settingsRef.current.autoAnnounceMic &&
        speechSynthesisSupported
      ) {
        setStatus('listening');
        setStatusDetail('Activating microphone...');
        announce('Activating microphone.');
        let started = false;
        const startOnce = () => {
          if (started) return;
          started = true;
          beginRecognitionSession();
        };
        speakText('Microphone active. Listening.', {
          setSpeakingState: false,
          onEnd: startOnce,
        });
        window.setTimeout(startOnce, 2000);
      } else {
        beginRecognitionSession();
      }
    },
    [
      announce,
      appendMessage,
      processUserQuery,
      speechSynthesisSupported,
      speakText,
      stopSpeaking,
    ]
  );

  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  const beginConversation = useCallback(
    (customGreeting?: string) => {
      const greeting = customGreeting ?? WELCOME_GREETING;
      manualStopRef.current = false;
      playAudioCue('listen-start', settingsRef.current.audioCuesEnabled);
      announce(greeting);
      speakText(greeting, {
        onEnd: () => {
          if (manualStopRef.current) return;
          if (startListeningRef.current) {
            void startListeningRef.current({ skipMicAnnouncement: true });
          }
        },
      });
    },
    [announce, speakText]
  );

  const endConversation = useCallback(
    (closingText = 'Conversation ended. Tap anywhere whenever you want to begin again.') => {
      stopListening(false);
      stopSpeaking();
      manualStopRef.current = true;
      playAudioCue('listen-stop', settingsRef.current.audioCuesEnabled);
      appendMessage('assistant', closingText);
      announce(closingText);
      speakText(closingText);
      setStatusDetail('Tap anywhere to begin.');
    },
    [announce, appendMessage, speakText, stopListening, stopSpeaking]
  );

  const repeatLastResponse = useCallback(() => {
    const text = lastAssistantMessageRef.current;
    announce(`Repeating last response: ${text}`);
    speakText(text);
  }, [announce, speakText]);

  const speakCustomFeedback = useCallback(
    (text: string, alsoLog = false, options?: { listenAfter?: boolean }) => {
      manualStopRef.current = false;
      if (alsoLog) {
        appendMessage('assistant', text);
      }
      announce(text);

      const shouldAutoListen =
        Boolean(options?.listenAfter) &&
        speechRecognitionSupportedRef.current &&
        micPermissionRef.current === 'granted';

      speakText(text, {
        onEnd: shouldAutoListen
          ? () => {
              if (manualStopRef.current) return;
              window.setTimeout(() => {
                if (!manualStopRef.current && startListeningRef.current) {
                  void startListeningRef.current({ skipMicAnnouncement: true });
                }
              }, 220);
            }
          : undefined,
      });
    },
    [announce, appendMessage, speakText]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // ignore
        }
      }
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

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
    beginConversation,
    endConversation,
    repeatLastResponse,
    playWelcomeGreeting,
    processUserQuery,
    speakCustomFeedback,
    announce,
  };
}
