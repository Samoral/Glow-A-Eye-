import React from 'react';
import { History, ShieldCheck, Trash2, Volume2 } from 'lucide-react';
import { SavedAssessmentRecord, TextScale } from '../types/assistant';
import { formatRecordAloud } from '../services/assessmentHistory';

interface AssessmentHistoryPanelProps {
  records: SavedAssessmentRecord[];
  textScale: TextScale;
  onSpeakFeedback: (text: string, alsoLog?: boolean) => void;
  onDeleteRecord: (id: string) => void;
  onClearAll: () => void;
  sectionRef?: React.RefObject<HTMLElement | null>;
}

export const AssessmentHistoryPanel: React.FC<AssessmentHistoryPanelProps> = ({
  records,
  textScale,
  onSpeakFeedback,
  onDeleteRecord,
  onClearAll,
  sectionRef,
}) => {
  const isLarge = textScale === 'large';

  return (
    <section
      id="history-section"
      ref={sectionRef}
      tabIndex={-1}
      aria-labelledby="history-heading"
      className="rounded-3xl bg-white dark:bg-[#140f24] border border-violet-200/80 dark:border-violet-800/50 shadow-sm p-5 sm:p-6 space-y-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2
            id="history-heading"
            className="text-lg sm:text-xl font-bold text-[#171226] dark:text-white inline-flex items-center gap-2"
          >
            <History className="w-5 h-5 text-violet-700 dark:text-violet-300" aria-hidden="true" />
            <span>Saved Assessment History</span>
          </h2>
          <p className={`mt-1 text-[#534b6d] dark:text-violet-300 ${isLarge ? 'text-base' : 'text-sm'}`}>
            On-device text summaries saved only with your explicit consent. No photographs are stored.
          </p>
        </div>

        {records.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                onSpeakFeedback(formatRecordAloud(records[0], 'Most recent saved assessment'), false)
              }
              className="min-h-[44px] px-4 py-2 rounded-xl bg-violet-100 hover:bg-violet-200 dark:bg-violet-900/60 dark:hover:bg-violet-800/70 text-violet-950 dark:text-violet-100 border border-violet-300 dark:border-violet-700 text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Volume2 className="w-4 h-4" aria-hidden="true" />
              <span>Read Latest</span>
            </button>

            <button
              type="button"
              onClick={onClearAll}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-white hover:bg-rose-50 dark:bg-[#140f24] dark:hover:bg-rose-950/40 text-rose-800 dark:text-rose-200 border border-rose-300 dark:border-rose-700 text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Trash2 className="w-4 h-4" aria-hidden="true" />
              <span>Delete All</span>
            </button>
          </div>
        )}
      </div>

      {/* Explicit local-storage & zero-photo transparency notice */}
      <div className="flex items-start gap-2.5 rounded-2xl bg-[#f7f4ff] dark:bg-[#1b1430] border border-violet-200/80 dark:border-violet-800/60 p-3.5 text-xs sm:text-sm text-[#3d3556] dark:text-violet-200">
        <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-violet-700 dark:text-violet-300" aria-hidden="true" />
        <p>
          Saved records stay strictly on this device in browser storage (not synced to an external database) and contain only the date, reported symptoms, text observations, and recommendations. Say &ldquo;Read saved assessments&rdquo; or &ldquo;Delete saved assessments&rdquo; anytime.
        </p>
      </div>

      {records.length === 0 ? (
        <p className={`text-[#534b6d] dark:text-violet-300 ${isLarge ? 'text-base' : 'text-sm'}`}>
          No saved assessments yet. After completing a symptom assessment, choose &ldquo;Save Assessment Locally&rdquo; if you want to keep a text record on this device.
        </p>
      ) : (
        <ul className="space-y-3" aria-label="Saved skin assessment summaries">
          {records.map((rec, index) => (
            <li
              key={rec.id}
              className="rounded-2xl bg-[#faf8ff] dark:bg-[#1b1430] border border-violet-200 dark:border-violet-800 p-4 space-y-2.5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-mono tabular-nums text-[#534b6d] dark:text-violet-300">
                    {rec.savedDateLabel} · Area: {rec.apparentLocation}
                  </p>
                  <h3 className="text-sm sm:text-base font-bold text-[#171226] dark:text-white mt-0.5">
                    {rec.urgencyLabel}
                  </h3>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      onSpeakFeedback(
                        formatRecordAloud(rec, `Saved assessment ${index + 1}`),
                        false
                      )
                    }
                    aria-label={`Read saved assessment from ${rec.savedDateLabel} aloud`}
                    className="min-h-[44px] px-3.5 py-2 rounded-xl bg-violet-700 hover:bg-violet-800 text-white text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Volume2 className="w-4 h-4" aria-hidden="true" />
                    <span>Read Aloud</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => onDeleteRecord(rec.id)}
                    aria-label={`Delete saved assessment from ${rec.savedDateLabel}`}
                    className="min-h-[44px] px-3.5 py-2 rounded-xl bg-white hover:bg-rose-50 dark:bg-[#140f24] dark:hover:bg-rose-950/40 text-rose-800 dark:text-rose-200 border border-rose-300 dark:border-rose-700 text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                    <span>Delete</span>
                  </button>
                </div>
              </div>

              <div className={`space-y-1.5 text-[#2e2745] dark:text-violet-100 ${isLarge ? 'text-base' : 'text-sm'}`}>
                <p>
                  <span className="font-semibold">Observations:</span> {rec.visualObservationsSummary}
                </p>
                <p>
                  <span className="font-semibold">Reported symptoms:</span>{' '}
                  {rec.reportedSymptoms.join('; ')}
                </p>
                <p>
                  <span className="font-semibold">Recommendations:</span>{' '}
                  {rec.recommendations.medicalAssessmentRecommendation}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
