import React from 'react';
import { Contrast, Type, Volume2 } from 'lucide-react';
import {
  AssistantSettings,
  SpeechRatePreset,
} from '../types/assistant';
import {
  getVoiceStableId,
  selectPreferredFemaleVoice,
} from '../utils/accessibility';

interface SettingsPanelProps {
  settings: AssistantSettings;
  availableVoices: SpeechSynthesisVoice[];
  speechSynthesisSupported: boolean;
  onUpdateSettings: (partial: Partial<AssistantSettings>, announcement?: string) => void;
  onTestVoice: () => void;
  sectionRef?: React.RefObject<HTMLElement | null>;
}

const SPEED_OPTIONS: { label: string; value: SpeechRatePreset }[] = [
  { label: 'Slow (0.85x)', value: 0.85 },
  { label: 'Normal (1.0x)', value: 1 },
  { label: 'Brisk (1.15x)', value: 1.15 },
];

const VOICE_COMMANDS = [
  { phrase: '"Help"', effect: 'Lists available voice actions aloud' },
  { phrase: '"Open camera"', effect: 'Starts rear camera with positioning guide' },
  { phrase: '"Take picture" / "Capture"', effect: 'Captures photo and checks lighting & focus' },
  { phrase: '"Analyze photo"', effect: 'Requests cautious AI observations of captured photo' },
  { phrase: '"Start questions"', effect: 'Starts adaptive symptom and safety questions' },
  { phrase: '"Save this assessment"', effect: 'Saves text summary locally with your consent (no photo)' },
  { phrase: '"Read saved assessments"', effect: 'Reads previous saved summaries aloud' },
  { phrase: '"Delete saved assessments"', effect: 'Clears saved assessment history on this device' },
  { phrase: '"Explain that in simpler terms"', effect: 'Speaks a shorter plain-language summary' },
  { phrase: '"About Glow-A-Eye"', effect: 'Reads mission and privacy details aloud' },
  { phrase: '"Retake" / "Cancel"', effect: 'Retakes photo or discards temporary image' },
  { phrase: '"Speak slower" / "High contrast"', effect: 'Adjusts speech speed or obsidian contrast' },
  { phrase: '"Repeat" / "Stop speaking"', effect: 'Replays last response or stops speech immediately' },
  { phrase: '"Stop listening"', effect: 'Immediately turns off the microphone' },
];

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  settings,
  availableVoices,
  speechSynthesisSupported,
  onUpdateSettings,
  onTestVoice,
  sectionRef,
}) => {
  const effectiveVoice = selectPreferredFemaleVoice(
    availableVoices,
    settings.selectedVoiceURI
  );
  const selectedVoiceIndex = effectiveVoice
    ? availableVoices.indexOf(effectiveVoice)
    : -1;

  const isLarge = settings.textScale === 'large';

  return (
    <section
      id="settings-section"
      ref={sectionRef}
      tabIndex={-1}
      aria-labelledby="settings-heading"
      className="rounded-3xl bg-white dark:bg-[#140f24] border border-violet-200/80 dark:border-violet-800/50 shadow-sm p-5 sm:p-6 space-y-6"
    >
      <div>
        <h2
          id="settings-heading"
          className="text-lg sm:text-xl font-bold text-[#171226] dark:text-white"
        >
          Accessible Settings
        </h2>
        <p className={`mt-1 text-[#534b6d] dark:text-violet-300 ${isLarge ? 'text-base' : 'text-sm'}`}>
          Customize spoken voice output, microphone announcements, contrast, and text size.
        </p>
      </div>

      {/* Speech Rate Control */}
      <fieldset className="space-y-2.5">
        <legend className="text-sm font-semibold text-[#171226] dark:text-violet-100">
          Speech Speed
        </legend>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {SPEED_OPTIONS.map((option) => {
            const active = settings.speechRate === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  onUpdateSettings(
                    { speechRate: option.value },
                    `Speech speed set to ${option.label}.`
                  )
                }
                className={`min-h-[48px] px-4 py-2.5 rounded-xl text-sm font-semibold border transition-colors cursor-pointer whitespace-nowrap ${
                  active
                    ? 'bg-violet-700 text-white border-violet-700 dark:bg-violet-600 dark:border-violet-500'
                    : 'bg-[#faf8ff] text-[#171226] border-violet-200 hover:bg-violet-50 dark:bg-[#1b1430] dark:text-violet-100 dark:border-violet-800 dark:hover:bg-violet-900/50'
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* Preferred Voice Selection */}
      <div className="space-y-2">
        <label
          htmlFor="voice-select"
          className="block text-sm font-semibold text-[#171226] dark:text-violet-100"
        >
          Assistant Voice (Female Voice Prioritized)
        </label>
        <div className="flex flex-col sm:flex-row gap-3">
          <select
            id="voice-select"
            disabled={!speechSynthesisSupported || availableVoices.length === 0}
            value={selectedVoiceIndex >= 0 ? String(selectedVoiceIndex) : ''}
            onChange={(e) => {
              const idx = Number(e.target.value);
              const chosen = Number.isInteger(idx) ? availableVoices[idx] : undefined;
              onUpdateSettings(
                { selectedVoiceURI: chosen ? getVoiceStableId(chosen) : '' },
                chosen ? `Voice changed to ${chosen.name}.` : 'Voice updated.'
              );
            }}
            className="flex-1 min-h-[48px] px-3.5 py-2 rounded-xl bg-[#faf8ff] dark:bg-[#1b1430] text-[#171226] dark:text-white border border-violet-300 dark:border-violet-700 text-sm font-medium"
          >
            {availableVoices.length === 0 ? (
              <option value="">
                {speechSynthesisSupported
                  ? 'Default system female voice'
                  : 'Speech synthesis unsupported'}
              </option>
            ) : (
              availableVoices.map((voice, index) => (
                <option
                  key={`${voice.voiceURI}::${voice.name}::${voice.lang}::${index}`}
                  value={String(index)}
                >
                  {voice.name} ({voice.lang})
                </option>
              ))
            )}
          </select>

          <button
            type="button"
            onClick={onTestVoice}
            disabled={!speechSynthesisSupported}
            className="min-h-[48px] px-4 py-2.5 rounded-xl bg-violet-100 hover:bg-violet-200 disabled:opacity-50 dark:bg-violet-900/60 dark:hover:bg-violet-800/70 text-violet-950 dark:text-violet-100 border border-violet-300 dark:border-violet-700 text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <Volume2 className="w-4 h-4" aria-hidden="true" />
            <span>Test Voice</span>
          </button>
        </div>
      </div>

      {/* Display Contrast & Text Size */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
        <button
          type="button"
          aria-pressed={settings.theme === 'dark'}
          onClick={() => {
            const nextTheme = settings.theme === 'dark' ? 'light' : 'dark';
            onUpdateSettings(
              { theme: nextTheme },
              nextTheme === 'dark'
                ? 'Switched to Deep Obsidian high-contrast dark theme.'
                : 'Switched to Soft Lavender light theme.'
            );
          }}
          className="min-h-[52px] px-4 py-3 rounded-xl border border-violet-200 dark:border-violet-700 bg-[#faf8ff] dark:bg-[#1b1430] hover:bg-violet-50 dark:hover:bg-violet-900/50 text-left flex items-center justify-between gap-3 transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-2.5 text-sm font-semibold text-[#171226] dark:text-white">
            <Contrast className="w-4 h-4 text-violet-700 dark:text-violet-300" aria-hidden="true" />
            <span>Contrast Theme</span>
          </span>
          <span className="text-xs font-semibold text-violet-800 dark:text-violet-300 whitespace-nowrap">
            {settings.theme === 'dark' ? 'High Contrast Dark' : 'Soft Lavender Light'}
          </span>
        </button>

        <button
          type="button"
          aria-pressed={settings.textScale === 'large'}
          onClick={() => {
            const nextScale = settings.textScale === 'large' ? 'standard' : 'large';
            onUpdateSettings(
              { textScale: nextScale },
              nextScale === 'large'
                ? 'Large print text size enabled.'
                : 'Standard text size enabled.'
            );
          }}
          className="min-h-[52px] px-4 py-3 rounded-xl border border-violet-200 dark:border-violet-700 bg-[#faf8ff] dark:bg-[#1b1430] hover:bg-violet-50 dark:hover:bg-violet-900/50 text-left flex items-center justify-between gap-3 transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-2.5 text-sm font-semibold text-[#171226] dark:text-white">
            <Type className="w-4 h-4 text-violet-700 dark:text-violet-300" aria-hidden="true" />
            <span>Text Scale</span>
          </span>
          <span className="text-xs font-semibold text-violet-800 dark:text-violet-300 whitespace-nowrap">
            {settings.textScale === 'large' ? 'Large Print' : 'Standard'}
          </span>
        </button>
      </div>

      {/* Spoken Announcements & Audio Cues */}
      <div className="space-y-3 pt-1 border-t border-violet-100 dark:border-violet-800/50">
        <label className="flex items-center justify-between gap-4 min-h-[48px] pt-3 cursor-pointer">
          <span className="text-sm font-medium text-[#171226] dark:text-violet-100">
            Speak aloud when microphone turns on or off
          </span>
          <input
            type="checkbox"
            checked={settings.autoAnnounceMic}
            onChange={(e) =>
              onUpdateSettings(
                { autoAnnounceMic: e.target.checked },
                e.target.checked
                  ? 'Microphone spoken announcements enabled.'
                  : 'Microphone spoken announcements muted. Screen reader updates remain active.'
              )
            }
            className="w-5 h-5 accent-violet-700 rounded cursor-pointer shrink-0"
          />
        </label>

        <label className="flex items-center justify-between gap-4 min-h-[48px] cursor-pointer">
          <span className="text-sm font-medium text-[#171226] dark:text-violet-100">
            Play gentle audio chimes for listening &amp; camera transitions
          </span>
          <input
            type="checkbox"
            checked={settings.audioCuesEnabled}
            onChange={(e) =>
              onUpdateSettings(
                { audioCuesEnabled: e.target.checked },
                e.target.checked
                  ? 'Audio transition chimes enabled.'
                  : 'Audio transition chimes disabled.'
              )
            }
            className="w-5 h-5 accent-violet-700 rounded cursor-pointer shrink-0"
          />
        </label>
      </div>

      {/* Voice Commands Directory */}
      <div className="pt-4 border-t border-violet-100 dark:border-violet-800/50">
        <h3 className="text-sm font-bold text-[#171226] dark:text-white">
          Voice Commands You Can Say
        </h3>
        <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5">
          {VOICE_COMMANDS.map((cmd) => (
            <div key={cmd.phrase} className="text-sm">
              <dt className="font-semibold text-violet-800 dark:text-violet-300 inline">
                {cmd.phrase}
              </dt>{' '}
              <span aria-hidden="true" className="text-violet-400">
                —
              </span>{' '}
              <dd className="inline text-[#473f61] dark:text-violet-200/90">
                {cmd.effect}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
};
