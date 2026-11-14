import React, { useEffect, useRef, useState } from 'react';
import { RotateCcw, Send, Volume2 } from 'lucide-react';
import { ConversationMessage, TextScale } from '../types/assistant';

interface ConversationAreaProps {
  messages: ConversationMessage[];
  textScale: TextScale;
  onRepeatMessage: (text: string) => void;
  onRepeatLast: () => void;
  onSubmitTextQuery: (text: string) => void;
}

export const ConversationArea: React.FC<ConversationAreaProps> = ({
  messages,
  textScale,
  onRepeatMessage,
  onRepeatLast,
  onSubmitTextQuery,
}) => {
  const [draft, setDraft] = useState('');
  const listEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages.length]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSubmitTextQuery(trimmed);
    setDraft('');
  };

  return (
    <section
      id="conversation-section"
      aria-labelledby="conversation-heading"
      className="flex flex-col rounded-3xl bg-white dark:bg-[#140f24] border border-violet-200/80 dark:border-violet-800/50 shadow-sm overflow-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 sm:px-6 border-b border-violet-100 dark:border-violet-800/50">
        <div>
          <h2
            id="conversation-heading"
            className="text-lg sm:text-xl font-bold text-[#171226] dark:text-white"
          >
            Conversation Log
          </h2>
          <p className="text-sm text-[#534b6d] dark:text-violet-300">
            Every assistant response is read aloud and saved below for replay.
          </p>
        </div>

        <button
          type="button"
          onClick={onRepeatLast}
          className="min-h-[44px] px-4 py-2 rounded-xl bg-violet-50 hover:bg-violet-100 dark:bg-violet-900/50 dark:hover:bg-violet-800/70 text-violet-950 dark:text-violet-100 border border-violet-200 dark:border-violet-700 text-sm font-semibold inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
        >
          <RotateCcw className="w-4 h-4" aria-hidden="true" />
          <span>Repeat Last</span>
        </button>
      </div>

      {/* Accessible conversation log */}
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Conversation history with Glow-A-Eye"
        className="flex-1 max-h-[380px] overflow-y-auto px-5 py-5 sm:px-6 space-y-5"
      >
        {messages.map((msg) => {
          const isAssistant = msg.sender === 'assistant';
          const isSystem = msg.sender === 'system';

          const speakerLabel = isAssistant
            ? 'Glow-A-Eye'
            : isSystem
              ? 'System Notice'
              : 'You';

          return (
            <article
              key={msg.id}
              aria-label={`${speakerLabel} at ${msg.timestamp}`}
              className={`rounded-2xl p-4 sm:p-5 border ${
                isAssistant
                  ? 'bg-[#f6f3ff] dark:bg-[#1c1533] border-violet-200/80 dark:border-violet-700/60'
                  : isSystem
                    ? 'bg-amber-50/90 dark:bg-amber-950/40 border-amber-300 dark:border-amber-700/70'
                    : 'bg-white dark:bg-[#100c1e] border-slate-200 dark:border-violet-800/40'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs sm:text-sm font-semibold text-[#4c3f70] dark:text-violet-300">
                  <span>{speakerLabel}</span>
                  <span aria-hidden="true">·</span>
                  <time className="font-mono tabular-nums font-normal">
                    {msg.timestamp}
                  </time>
                </div>

                {isAssistant && (
                  <button
                    type="button"
                    onClick={() => onRepeatMessage(msg.text)}
                    aria-label={`Speak this response again: ${msg.text.slice(0, 48)}`}
                    className="min-h-[44px] min-w-[44px] px-3 py-1.5 rounded-xl text-xs sm:text-sm font-semibold text-violet-800 dark:text-violet-200 hover:bg-violet-200/60 dark:hover:bg-violet-800/60 inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Volume2 className="w-4 h-4" aria-hidden="true" />
                    <span>Speak</span>
                  </button>
                )}
              </div>

              <p
                className={`mt-2 leading-relaxed text-[#171226] dark:text-violet-50 ${
                  textScale === 'large' ? 'text-lg' : 'text-base'
                }`}
              >
                {msg.text}
              </p>
            </article>
          );
        })}
        <div ref={listEndRef} />
      </div>

      {/* Accessible text fallback input */}
      <form
        onSubmit={handleSubmit}
        className="p-4 sm:px-6 sm:py-4 border-t border-violet-100 dark:border-violet-800/50 bg-[#faf8ff] dark:bg-[#100c1e]"
      >
        <label htmlFor="typed-query-input" className="sr-only">
          Type a message or voice command for Glow-A-Eye
        </label>
        <div className="flex items-center gap-3">
          <input
            id="typed-query-input"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Prefer typing? Ask or say a command like &quot;open camera&quot;..."
            className={`flex-1 min-h-[48px] px-4 py-2.5 rounded-xl bg-white dark:bg-[#19132d] text-[#171226] dark:text-white placeholder-[#6d6488] dark:placeholder-violet-300/60 border border-violet-300 dark:border-violet-700 ${
              textScale === 'large' ? 'text-lg' : 'text-base'
            }`}
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            aria-label="Send message to Glow-A-Eye"
            className="min-h-[48px] px-5 py-2.5 rounded-xl bg-violet-700 hover:bg-violet-800 disabled:opacity-45 disabled:cursor-not-allowed text-white font-semibold text-sm sm:text-base inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <Send className="w-4 h-4" aria-hidden="true" />
            <span>Send</span>
          </button>
        </div>
      </form>
    </section>
  );
};
