import React from 'react';
import { AlertCircle, AudioLines, Mic, PauseCircle, RotateCw, Volume2 } from 'lucide-react';
import { AssistantStatus } from '../types/assistant';
import { usePrefersReducedMotion } from '../utils/accessibility';

interface VoiceOrbProps {
  status: AssistantStatus;
}

export const VoiceOrb: React.FC<VoiceOrbProps> = ({ status }) => {
  const reducedMotion = usePrefersReducedMotion();

  const isListening = status === 'listening';
  const isSpeaking = status === 'speaking';
  const isProcessing = status === 'processing';
  const isInterrupted = status === 'interrupted';
  const isResuming = status === 'resuming';
  const isError = status === 'error';

  const orbAnimationClass = reducedMotion
    ? ''
    : isListening || isInterrupted
      ? 'animate-orb-listen'
      : isProcessing || isResuming
        ? 'animate-orb-think'
        : isSpeaking
          ? 'animate-orb-speak'
          : isError
            ? ''
            : 'animate-orb-breathe';

  const coreBackground = isError
    ? 'radial-gradient(circle at 34% 28%, #ddd6fe 0%, #6d28d9 52%, #2e1065 100%)'
    : isInterrupted
      ? 'radial-gradient(circle at 32% 26%, #e0f2fe 0%, #7c3aed 44%, #312e81 100%)'
      : isResuming
        ? 'radial-gradient(circle at 34% 28%, #ede9fe 0%, #7c3aed 48%, #4c1d95 100%)'
        : isListening
          ? 'radial-gradient(circle at 32% 26%, #ede9fe 0%, #8b5cf6 42%, #4c1d95 100%)'
          : isProcessing
            ? 'radial-gradient(circle at 36% 30%, #c4b5fd 0%, #6d28d9 52%, #3b0764 100%)'
            : isSpeaking
              ? 'radial-gradient(circle at 32% 28%, #f3e8ff 0%, #9333ea 46%, #4c1d95 100%)'
              : 'radial-gradient(circle at 32% 28%, #ddd6fe 0%, #6d28d9 54%, #2e1065 100%)';

  const coreShadow = isInterrupted
    ? '0 22px 60px -8px rgba(56, 189, 248, 0.5), inset 0 2px 16px rgba(255, 255, 255, 0.45)'
    : isListening
      ? '0 22px 60px -10px rgba(124, 58, 237, 0.58), inset 0 2px 16px rgba(255, 255, 255, 0.4)'
      : isSpeaking
        ? '0 24px 64px -10px rgba(139, 92, 246, 0.55), inset 0 2px 14px rgba(255, 255, 255, 0.35)'
        : isProcessing || isResuming
          ? '0 20px 52px -12px rgba(91, 33, 182, 0.52), inset 0 2px 12px rgba(255, 255, 255, 0.3)'
          : isError
            ? '0 18px 46px -12px rgba(217, 119, 6, 0.4), inset 0 2px 10px rgba(255, 255, 255, 0.25)'
            : '0 18px 44px -14px rgba(109, 40, 217, 0.38), inset 0 2px 12px rgba(255, 255, 255, 0.28)';

  const rimGradient = isError
    ? 'conic-gradient(from 0deg, #d97706, #fbbf24, #7c3aed, #d97706)'
    : isInterrupted
      ? 'conic-gradient(from 0deg, #38bdf8, #ede9fe, #7c3aed, #38bdf8)'
      : isListening
        ? 'conic-gradient(from 0deg, #6d28d9, #ddd6fe, #ffffff, #8b5cf6, #6d28d9)'
        : isProcessing || isResuming
          ? 'conic-gradient(from 0deg, #4c1d95, #a78bfa, #f5f3ff, #6d28d9, #4c1d95)'
          : isSpeaking
            ? 'conic-gradient(from 0deg, #7c3aed, #f3e8ff, #c084fc, #6d28d9)'
            : 'conic-gradient(from 0deg, #8b5cf6, #e9d5ff, #a78bfa, #6d28d9)';

  return (
    <div className="relative flex items-center justify-center w-64 h-64 sm:w-72 sm:h-72 select-none">
      {/* Subtle outer listening pulse halo */}
      <div
        className={`absolute inset-0 rounded-full pointer-events-none transition-opacity duration-300 ${
          isInterrupted
            ? 'opacity-100 bg-sky-400/20 dark:bg-sky-400/20 border border-sky-400/60'
            : isListening
              ? 'opacity-100 bg-violet-500/15 dark:bg-violet-400/15 border border-violet-400/45'
              : isSpeaking
                ? 'opacity-80 bg-purple-400/12 dark:bg-purple-400/15 border border-purple-400/35'
                : isProcessing || isResuming
                  ? 'opacity-70 bg-indigo-400/10 dark:bg-indigo-400/12 border border-violet-400/30'
                  : 'opacity-35 bg-violet-200/25 dark:bg-violet-900/20 border border-violet-300/30 dark:border-violet-700/25'
        } ${!reducedMotion && (isListening || isInterrupted) ? 'animate-orb-ring' : ''}`}
      />

      {/* Secondary staggered listening ring */}
      <div
        className={`absolute inset-4 rounded-full pointer-events-none transition-opacity duration-300 ${
          isListening || isInterrupted ? 'opacity-100 border border-violet-500/40' : 'opacity-0'
        } ${!reducedMotion && (isListening || isInterrupted) ? 'animate-orb-ring-delayed' : ''}`}
      />

      {/* Rotating luminous rim */}
      <div
        className={`absolute w-52 h-52 sm:w-56 sm:h-56 rounded-full pointer-events-none p-[2px] transition-opacity duration-300 ${
          !reducedMotion && (isListening || isProcessing || isSpeaking || isInterrupted || isResuming)
            ? 'animate-orb-rotate'
            : ''
        }`}
        style={{
          background: rimGradient,
          opacity: status === 'idle' ? 0.5 : 0.95,
        }}
      >
        <div className="w-full h-full rounded-full bg-[#faf8ff] dark:bg-[#0b0814]" />
      </div>

      {/* Central orb core */}
      <div
        className={`relative z-10 w-44 h-44 sm:w-48 sm:h-48 rounded-full flex items-center justify-center text-white transition-transform duration-200 ${orbAnimationClass}`}
        style={{
          background: coreBackground,
          boxShadow: coreShadow,
        }}
      >
        <div className="absolute inset-2 rounded-full bg-gradient-to-b from-white/20 via-transparent to-transparent pointer-events-none" />

        {isInterrupted ? (
          <PauseCircle className="w-11 h-11 sm:w-12 sm:h-12 text-white drop-shadow-sm" />
        ) : isResuming ? (
          <RotateCw className="w-11 h-11 sm:w-12 sm:h-12 text-white drop-shadow-sm" />
        ) : isListening ? (
          <Mic className="w-11 h-11 sm:w-12 sm:h-12 text-white drop-shadow-sm" />
        ) : isProcessing ? (
          <AudioLines className="w-11 h-11 sm:w-12 sm:h-12 text-white/95 drop-shadow-sm" />
        ) : isSpeaking ? (
          <Volume2 className="w-11 h-11 sm:w-12 sm:h-12 text-white drop-shadow-sm" />
        ) : isError ? (
          <AlertCircle className="w-11 h-11 sm:w-12 sm:h-12 text-amber-200 drop-shadow-sm" />
        ) : (
          <Mic className="w-10 h-10 sm:w-11 sm:h-11 text-white/90 drop-shadow-sm" />
        )}
      </div>
    </div>
  );
};
