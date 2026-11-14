import React from 'react';
import { Eye, Lock, ShieldAlert, Volume2 } from 'lucide-react';
import { TextScale } from '../types/assistant';

interface AboutPrivacyPanelProps {
  textScale: TextScale;
  onSpeakFeedback: (text: string, alsoLog?: boolean) => void;
  sectionRef?: React.RefObject<HTMLElement | null>;
}

export const ABOUT_SPOKEN_SUMMARY =
  'Glow-A-Eye is a voice-first skin health companion built for blind and visually impaired users. It combines guided camera positioning, pixel-level photo quality checks, cautious Gemini visual observations, adaptive symptom questions, and a dedicated Medical Safety Engine. Glow-A-Eye provides informational observations only—never a medical diagnosis, cancer screening, or prescription. Your photographs stay in temporary browser memory until you explicitly ask to analyze them, are sent securely to the server without exposing API keys, and are never permanently saved unless you choose to save a text-only assessment summary on your device.';

export const AboutPrivacyPanel: React.FC<AboutPrivacyPanelProps> = ({
  textScale,
  onSpeakFeedback,
  sectionRef,
}) => {
  const isLarge = textScale === 'large';

  return (
    <section
      id="about-section"
      ref={sectionRef}
      tabIndex={-1}
      aria-labelledby="about-heading"
      className="rounded-3xl bg-white dark:bg-[#140f24] border border-violet-200/80 dark:border-violet-800/50 shadow-sm p-5 sm:p-6 space-y-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2
            id="about-heading"
            className="text-lg sm:text-xl font-bold text-[#171226] dark:text-white"
          >
            About Glow-A-Eye &amp; Privacy
          </h2>
          <p className={`mt-1 text-[#534b6d] dark:text-violet-300 ${isLarge ? 'text-base' : 'text-sm'}`}>
            Designed for independent, dignified skin health support by voice.
          </p>
        </div>

        <button
          type="button"
          onClick={() => onSpeakFeedback(ABOUT_SPOKEN_SUMMARY, false)}
          className="min-h-[44px] px-4 py-2 rounded-xl bg-violet-100 hover:bg-violet-200 dark:bg-violet-900/60 dark:hover:bg-violet-800/70 text-violet-950 dark:text-violet-100 border border-violet-300 dark:border-violet-700 text-xs sm:text-sm font-semibold inline-flex items-center gap-2 cursor-pointer whitespace-nowrap shrink-0"
        >
          <Volume2 className="w-4 h-4" aria-hidden="true" />
          <span>Read About &amp; Privacy Aloud</span>
        </button>
      </div>

      <div className={`grid grid-cols-1 md:grid-cols-3 gap-4 ${isLarge ? 'text-base' : 'text-sm'}`}>
        <div className="rounded-2xl bg-[#f7f4ff] dark:bg-[#1b1430] border border-violet-200/80 dark:border-violet-800/60 p-4 space-y-2">
          <h3 className="font-bold text-[#171226] dark:text-white inline-flex items-center gap-2">
            <Eye className="w-4 h-4 text-violet-700 dark:text-violet-300 shrink-0" aria-hidden="true" />
            <span>Who It Serves</span>
          </h3>
          <p className="text-[#3d3556] dark:text-violet-200 leading-relaxed">
            Built for blind and low-vision users who want hands-free voice guidance to frame skin photographs, hear plain-language visual descriptions, and screen symptoms independently.
          </p>
        </div>

        <div className="rounded-2xl bg-[#f7f4ff] dark:bg-[#1b1430] border border-violet-200/80 dark:border-violet-800/60 p-4 space-y-2">
          <h3 className="font-bold text-[#171226] dark:text-white inline-flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-violet-700 dark:text-violet-300 shrink-0" aria-hidden="true" />
            <span>Observations, Not Diagnoses</span>
          </h3>
          <p className="text-[#3d3556] dark:text-violet-200 leading-relaxed">
            Glow-A-Eye provides AI-assisted observations paired with a deterministic Medical Safety Engine. It cannot diagnose conditions, rule out skin cancer, or prescribe treatment.
          </p>
        </div>

        <div className="rounded-2xl bg-[#f7f4ff] dark:bg-[#1b1430] border border-violet-200/80 dark:border-violet-800/60 p-4 space-y-2">
          <h3 className="font-bold text-[#171226] dark:text-white inline-flex items-center gap-2">
            <Lock className="w-4 h-4 text-violet-700 dark:text-violet-300 shrink-0" aria-hidden="true" />
            <span>Privacy &amp; Data Control</span>
          </h3>
          <p className="text-[#3d3556] dark:text-violet-200 leading-relaxed">
            Photos are kept only in temporary memory until you request analysis, sent through a secure server endpoint with credentials never exposed, and never permanently stored. Optional history saves text summaries on your device only with consent.
          </p>
        </div>
      </div>
    </section>
  );
};
