import { useEffect, useState } from 'react';

export type AudioCueKind = 'listen-start' | 'listen-stop' | 'error' | 'camera-ready';

let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioContext) {
    sharedAudioContext = new AudioCtx();
  }
  if (sharedAudioContext.state === 'suspended') {
    void sharedAudioContext.resume().catch(() => {});
  }
  return sharedAudioContext;
}

/**
 * Plays a brief, gentle audio earcon to confirm microphone or camera transitions
 * without relying on visual indicators alone.
 */
export function playAudioCue(kind: AudioCueKind, enabled = true): void {
  if (!enabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.connect(gain);
    gain.connect(ctx.destination);

    if (kind === 'listen-start') {
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(523.25, now); // C5
      oscillator.frequency.exponentialRampToValueAtTime(659.25, now + 0.11); // E5
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.09, now + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      oscillator.start(now);
      oscillator.stop(now + 0.19);
    } else if (kind === 'listen-stop') {
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(587.33, now); // D5
      oscillator.frequency.exponentialRampToValueAtTime(440, now + 0.12); // A4
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
      oscillator.start(now);
      oscillator.stop(now + 0.17);
    } else if (kind === 'camera-ready') {
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(493.88, now); // B4
      oscillator.frequency.exponentialRampToValueAtTime(739.99, now + 0.14); // F#5
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.07, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      oscillator.start(now);
      oscillator.stop(now + 0.21);
    } else {
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(311.13, now); // D#4
      oscillator.frequency.exponentialRampToValueAtTime(246.94, now + 0.16); // B3
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      oscillator.start(now);
      oscillator.stop(now + 0.23);
    }
  } catch {
    // Ignore Web Audio failures cleanly if browser blocks autoplay audio.
  }
}

export function getVoiceStableId(voice: SpeechSynthesisVoice): string {
  return `${voice.voiceURI}::${voice.name}::${voice.lang}`;
}

/**
 * Selects a natural-sounding female English voice where available in browser SpeechSynthesis.
 */
export function selectPreferredFemaleVoice(
  voices: SpeechSynthesisVoice[],
  preferredURI?: string
): SpeechSynthesisVoice | null {
  if (!voices.length) return null;

  if (preferredURI) {
    const exact = voices.find(
      (v) => getVoiceStableId(v) === preferredURI || v.voiceURI === preferredURI
    );
    if (exact) return exact;
  }

  const englishVoices = voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
  const pool = englishVoices.length ? englishVoices : voices;

  const highPriorityFemaleMatchers = [
    /google uk english female/i,
    /microsoft aria/i,
    /microsoft jenny/i,
    /microsoft libby/i,
    /microsoft sonia/i,
    /microsoft zira/i,
    /samantha/i,
    /ava/i,
    /allison/i,
    /karen/i,
    /victoria/i,
    /serena/i,
    /moira/i,
    /fiona/i,
    /tessa/i,
    /susan/i,
    /kate/i,
    /female/i,
    /woman/i,
  ];

  for (const matcher of highPriorityFemaleMatchers) {
    const match = pool.find((v) => matcher.test(v.name));
    if (match) return match;
  }

  // Fallback to Google US English (typically female) or any natural English voice
  const googleUs = pool.find((v) => /google us english/i.test(v.name));
  if (googleUs) return googleUs;

  const defaultEn = pool.find((v) => v.default);
  return defaultEn ?? pool[0] ?? null;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mediaQuery.matches);

    const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
    mediaQuery.addEventListener('change', listener);
    return () => mediaQuery.removeEventListener('change', listener);
  }, []);

  return reduced;
}

export function formatSpokenTime(date = new Date()): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
