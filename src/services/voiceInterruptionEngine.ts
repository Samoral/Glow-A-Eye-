import type { AssistantStatus } from '../types/assistant.ts';

export interface QueuedSpeechChunk {
  chunkIndex: number;
  totalChunks: number;
  text: string;
  generationId: number;
}

export interface ActiveSpeechJob {
  generationId: number;
  fullText: string;
  chunks: string[];
  nextChunkIndex: number;
  listenAfter: boolean;
  setSpeakingState: boolean;
  onEnd?: () => void;
}

export interface InterruptedSpeechSnapshot {
  interruptedText: string;
  remainingText: string;
  remainingChunks: string[];
  hadMoreQueued: boolean;
  interruptedAtMs: number;
}

export interface VadConfig {
  /** Minimum RMS threshold in the speech band to treat as potential voice. */
  minSpeechRms: number;
  /** Threshold multiplier above adaptive noise floor while assistant is speaking. */
  speakingThresholdMultiplier: number;
  /** Number of consecutive above-threshold frames required to confirm user speech. */
  requiredConsecutiveFrames: number;
  /** Acoustic speaker onset blanking window after TTS starts speaking (ms). */
  ttsOnsetGraceMs: number;
  /** Cooldown between consecutive VAD interruption triggers (ms). */
  cooldownMs: number;
  /** Minimum ratio of 300-3400Hz band RMS vs full-spectrum RMS (rejects low rumbles). */
  minBandRatio: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  minSpeechRms: 0.032,
  speakingThresholdMultiplier: 2.6,
  requiredConsecutiveFrames: 3,
  ttsOnsetGraceMs: 260,
  cooldownMs: 650,
  minBandRatio: 0.35,
};

export interface VadFrameInput {
  fullRms: number;
  bandRms: number;
  timestampMs: number;
  isAssistantSpeaking: boolean;
}

export interface VadFrameEvaluation {
  shouldInterrupt: boolean;
  isSpeechLikely: boolean;
  effectiveThreshold: number;
  noiseFloor: number;
  consecutiveSpeechFrames: number;
}

/**
 * Adaptive Voice Activity Detector (VAD) with speaker-onset blanking and
 * multi-frame confirmation to distinguish real user speech from background
 * noise or transient speaker echo.
 */
export class VadMonitor {
  private readonly config: VadConfig;
  private noiseFloor = 0.008;
  private consecutiveFrames = 0;
  private speechStartedAtMs = 0;
  private lastTriggerAtMs = 0;

  constructor(config: Partial<VadConfig> = {}) {
    this.config = { ...DEFAULT_VAD_CONFIG, ...config };
  }

  public markAssistantSpeechStarted(timestampMs: number): void {
    this.speechStartedAtMs = timestampMs;
    this.consecutiveFrames = 0;
  }

  public resetFrames(): void {
    this.consecutiveFrames = 0;
  }

  public getNoiseFloor(): number {
    return this.noiseFloor;
  }

  public evaluateFrame(input: VadFrameInput): VadFrameEvaluation {
    const { fullRms, bandRms, timestampMs, isAssistantSpeaking } = input;
    const bandRatio = fullRms > 0.0005 ? bandRms / fullRms : 1;

    const effectiveThreshold = Math.max(
      this.config.minSpeechRms,
      this.noiseFloor * this.config.speakingThresholdMultiplier
    );

    if (!isAssistantSpeaking) {
      // Gently calibrate ambient noise floor when room is calm
      if (bandRms < effectiveThreshold) {
        this.noiseFloor = Math.max(
          0.003,
          this.noiseFloor * 0.88 + bandRms * 0.12
        );
      }
      this.consecutiveFrames = 0;
      return {
        shouldInterrupt: false,
        isSpeechLikely: false,
        effectiveThreshold,
        noiseFloor: this.noiseFloor,
        consecutiveSpeechFrames: 0,
      };
    }

    // Ignore initial speaker onset transient right after TTS begins
    if (
      this.speechStartedAtMs > 0 &&
      timestampMs - this.speechStartedAtMs < this.config.ttsOnsetGraceMs
    ) {
      this.consecutiveFrames = 0;
      return {
        shouldInterrupt: false,
        isSpeechLikely: false,
        effectiveThreshold,
        noiseFloor: this.noiseFloor,
        consecutiveSpeechFrames: 0,
      };
    }

    const passesEnergy = bandRms >= effectiveThreshold;
    const passesBand = bandRatio >= this.config.minBandRatio;
    const isSpeechLikely = passesEnergy && passesBand;

    if (isSpeechLikely) {
      this.consecutiveFrames += 1;
    } else {
      // Slowly track steady background noise while ignoring single spikes
      if (bandRms < effectiveThreshold * 0.75) {
        this.noiseFloor = Math.max(
          0.003,
          this.noiseFloor * 0.94 + bandRms * 0.06
        );
      }
      this.consecutiveFrames = 0;
    }

    const cooldownElapsed =
      this.lastTriggerAtMs === 0 ||
      timestampMs - this.lastTriggerAtMs >= this.config.cooldownMs;

    const shouldInterrupt =
      isSpeechLikely &&
      this.consecutiveFrames >= this.config.requiredConsecutiveFrames &&
      cooldownElapsed;

    if (shouldInterrupt) {
      this.lastTriggerAtMs = timestampMs;
      this.consecutiveFrames = 0;
    }

    return {
      shouldInterrupt,
      isSpeechLikely,
      effectiveThreshold,
      noiseFloor: this.noiseFloor,
      consecutiveSpeechFrames: this.consecutiveFrames,
    };
  }
}

/**
 * Splits long TTS messages at sentence boundaries so multi-part explanations
 * cancel instantaneously between sentences and do not stall mobile SpeechSynthesis.
 */
export function splitTextIntoSpeechChunks(
  rawText: string,
  maxChars = 210
): string[] {
  const cleaned = rawText.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxChars) return [cleaned];

  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length <= 1) {
    // Hard split on commas/clauses if a single long sentence lacks terminal punctuation
    const parts = cleaned
      .split(/(?<=[,;:])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length <= 1) return [cleaned];
    return packSegments(parts, maxChars);
  }

  return packSegments(sentences, maxChars);
}

function packSegments(segments: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const seg of segments) {
    if (!current) {
      current = seg;
      continue;
    }
    if (current.length + 1 + seg.length <= maxChars) {
      current = `${current} ${seg}`;
    } else {
      chunks.push(current);
      current = seg;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

const EXPLICIT_BARGE_IN_INTENT_REGEX =
  /\b(stop|wait|hold on|hang on|pause|why|help|explain|repeat|what does|what is|what could|what should|cancel|clarify|question|ask|meant|wrong|correction|continue|resume|start|again|open|close|camera|take|capture|retake|analyze|skip|back|yes|no|save|read|delete|end|hello|hi)\b/i;

/**
 * Filters out recognized transcripts that closely mirror the AI's own
 * currently playing or just-played TTS output (acoustic speaker bleed).
 * Explicit user interruption intents always pass through.
 */
export function isLikelyEchoTranscript(
  transcript: string,
  recentSpokenTexts: string[]
): boolean {
  const cleaned = transcript.trim().toLowerCase();
  if (!cleaned) return false;
  if (EXPLICIT_BARGE_IN_INTENT_REGEX.test(cleaned)) {
    return false;
  }

  const candidateWords = cleaned
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);

  if (candidateWords.length < 2) {
    return false;
  }

  const normalizedCorpus = recentSpokenTexts
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalizedCorpus) return false;

  const candidatePhrase = candidateWords.join(' ');
  if (normalizedCorpus.includes(candidatePhrase)) {
    return true;
  }

  const corpusWords = new Set(normalizedCorpus.split(' '));
  let matched = 0;
  for (const w of candidateWords) {
    if (corpusWords.has(w)) {
      matched += 1;
    }
  }

  return matched / candidateWords.length >= 0.78;
}

export interface VoiceCoordinatorAdapter {
  cancelSystemSpeech: () => void;
  speakChunk: (
    text: string,
    generationId: number,
    onChunkComplete: (completedGenerationId: number) => void
  ) => void;
  onStateChange: (state: AssistantStatus, detail?: string) => void;
  onSpeechInterrupted?: (snapshot: InterruptedSpeechSnapshot) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

export interface VoiceCoordinatorConfig {
  dedupeWindowMs: number;
  interruptedSettleMs: number;
  resumingHoldMs: number;
  maxChunkChars: number;
}

export const DEFAULT_VOICE_COORDINATOR_CONFIG: VoiceCoordinatorConfig = {
  dedupeWindowMs: 1400,
  interruptedSettleMs: 90,
  resumingHoldMs: 120,
  maxChunkChars: 210,
};

/**
 * Coordinates turn generations, queued TTS chunks, barge-in interruption,
 * stale async response suppression, and resumption states.
 */
export class VoiceInterruptionCoordinator {
  private readonly adapter: VoiceCoordinatorAdapter;
  private readonly config: VoiceCoordinatorConfig;

  private state: AssistantStatus = 'idle';
  private speechGenerationId = 0;
  private requestGenerationId = 0;
  private activeJob: ActiveSpeechJob | null = null;
  private recentSpokenTexts: string[] = [];
  private lastInterruptedSnapshot: InterruptedSpeechSnapshot | null = null;

  private lastProcessedTranscriptNormalized = '';
  private lastProcessedAtMs = 0;

  private transitionTimerId: number | null = null;

  constructor(
    adapter: VoiceCoordinatorAdapter,
    config: Partial<VoiceCoordinatorConfig> = {}
  ) {
    this.adapter = adapter;
    this.config = { ...DEFAULT_VOICE_COORDINATOR_CONFIG, ...config };
  }

  private now(): number {
    return this.adapter.now ? this.adapter.now() : Date.now();
  }

  private setTimer(fn: () => void, ms: number): number {
    if (this.adapter.setTimer) {
      return this.adapter.setTimer(fn, ms);
    }
    return globalThis.setTimeout(fn, ms) as unknown as number;
  }

  private clearTimer(id: number | null): void {
    if (id === null) return;
    if (this.adapter.clearTimer) {
      this.adapter.clearTimer(id);
      return;
    }
    globalThis.clearTimeout(id);
  }

  private clearTransitionTimer(): void {
    this.clearTimer(this.transitionTimerId);
    this.transitionTimerId = null;
  }

  private setState(next: AssistantStatus, detail?: string): void {
    this.state = next;
    this.adapter.onStateChange(next, detail);
  }

  public getState(): AssistantStatus {
    return this.state;
  }

  public getSpeechGenerationId(): number {
    return this.speechGenerationId;
  }

  public getRequestGenerationId(): number {
    return this.requestGenerationId;
  }

  public isSpeechCurrent(generationId: number): boolean {
    return generationId === this.speechGenerationId;
  }

  public isRequestCurrent(requestId: number): boolean {
    return requestId === this.requestGenerationId;
  }

  public isSpeaking(): boolean {
    return this.activeJob !== null && this.state === 'speaking';
  }

  public getRecentSpokenTexts(): string[] {
    return [...this.recentSpokenTexts];
  }

  public getLastInterruptedSnapshot(): InterruptedSpeechSnapshot | null {
    return this.lastInterruptedSnapshot;
  }

  public clearInterruptedSnapshot(): void {
    this.lastInterruptedSnapshot = null;
  }

  public isLikelyEcho(transcript: string): boolean {
    return isLikelyEchoTranscript(transcript, this.recentSpokenTexts);
  }

  public transitionToListening(detail = 'Listening...'): void {
    this.clearTransitionTimer();
    this.setState('listening', detail);
  }

  public transitionToIdle(detail = 'Tap anywhere to speak.'): void {
    this.clearTransitionTimer();
    this.setState('idle', detail);
  }

  public transitionToError(detail: string): void {
    this.clearTransitionTimer();
    this.setState('error', detail);
  }

  public transitionToResuming(
    detail = 'Resuming...',
    onReady?: () => void
  ): void {
    this.clearTransitionTimer();
    this.setState('resuming', detail);
    if (onReady) {
      const token = this.requestGenerationId;
      this.transitionTimerId = this.setTimer(() => {
        if (token === this.requestGenerationId) {
          onReady();
        }
      }, this.config.resumingHoldMs);
    }
  }

  /**
   * Marks the turn as processing an asynchronous audio interruption clip and
   * returns a monotonically increasing requestId to prevent stale responses.
   */
  public beginAudioTranscription(detail = 'Understanding what you said...'): number {
    this.cancelSpeechWithoutStateChange();
    this.clearTransitionTimer();
    this.requestGenerationId += 1;
    this.setState('processing', detail);
    return this.requestGenerationId;
  }

  /**
   * Begins processing a new user utterance while invalidating any older in-flight
   * async request or pending TTS speech, and preventing duplicate utterance execution.
   */
  public beginProcessing(
    rawTranscript: string
  ): { accepted: true; requestId: number; speechGenerationId: number } | { accepted: false } {
    const normalized = rawTranscript.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!normalized) {
      return { accepted: false };
    }

    const currentTime = this.now();
    if (
      normalized === this.lastProcessedTranscriptNormalized &&
      currentTime - this.lastProcessedAtMs < this.config.dedupeWindowMs
    ) {
      return { accepted: false };
    }

    this.lastProcessedTranscriptNormalized = normalized;
    this.lastProcessedAtMs = currentTime;

    // Cancel any residual speech before entering processing state
    this.cancelSpeechWithoutStateChange();
    this.clearTransitionTimer();

    this.requestGenerationId += 1;
    this.setState('processing', 'Thinking through your request...');

    return {
      accepted: true,
      requestId: this.requestGenerationId,
      speechGenerationId: this.speechGenerationId,
    };
  }

  /**
   * Immediately interrupts active speech, clears all queued utterances,
   * invalidates pending async requests from older turns, and transitions
   * through 'interrupted' -> 'listening' (unless skipListeningTransition).
   */
  public interrupt(options?: {
    reason?: 'vad' | 'recognition' | 'manual' | 'command';
    skipListeningTransition?: boolean;
    onReadyToListen?: (speechGenAtInterrupt: number) => void;
  }): InterruptedSpeechSnapshot | null {
    this.clearTransitionTimer();

    let snapshot: InterruptedSpeechSnapshot | null = null;
    if (this.activeJob) {
      const spokenIndex = Math.max(0, this.activeJob.nextChunkIndex - 1);
      const remainingChunks = this.activeJob.chunks.slice(spokenIndex + 1);
      snapshot = {
        interruptedText: this.activeJob.fullText,
        remainingText: remainingChunks.join(' '),
        remainingChunks,
        hadMoreQueued: remainingChunks.length > 0,
        interruptedAtMs: this.now(),
      };
      this.lastInterruptedSnapshot = snapshot;
    }

    // Bump both generation IDs so queued chunks AND stale async AI responses cannot play
    this.speechGenerationId += 1;
    this.requestGenerationId += 1;
    this.activeJob = null;

    this.adapter.cancelSystemSpeech();

    if (snapshot) {
      this.adapter.onSpeechInterrupted?.(snapshot);
    }

    this.setState('interrupted', 'Interrupted — listening to you...');

    const genAtInterrupt = this.speechGenerationId;
    if (!options?.skipListeningTransition) {
      if (this.config.interruptedSettleMs <= 0) {
        if (this.speechGenerationId === genAtInterrupt) {
          this.setState('listening', 'Listening...');
          options?.onReadyToListen?.(genAtInterrupt);
        }
      } else {
        this.transitionTimerId = this.setTimer(() => {
          if (this.speechGenerationId === genAtInterrupt && this.state === 'interrupted') {
            this.setState('listening', 'Listening...');
            options?.onReadyToListen?.(genAtInterrupt);
          }
        }, this.config.interruptedSettleMs);
      }
    }

    return snapshot;
  }

  private cancelSpeechWithoutStateChange(): void {
    this.speechGenerationId += 1;
    this.activeJob = null;
    this.adapter.cancelSystemSpeech();
  }

  public stopSpeechToIdle(): void {
    this.clearTransitionTimer();
    this.cancelSpeechWithoutStateChange();
    this.setState('idle', 'Tap anywhere to speak.');
  }

  /**
   * Queues a response (split into sentence-safe chunks) and speaks it sequentially.
   * Passing an outdated expectedRequestId silently drops stale async responses.
   */
  public speak(
    text: string,
    options?: {
      expectedRequestId?: number;
      setSpeakingState?: boolean;
      listenAfter?: boolean;
      onEnd?: () => void;
    }
  ): { started: boolean; generationId: number } {
    if (
      options?.expectedRequestId !== undefined &&
      options.expectedRequestId !== this.requestGenerationId
    ) {
      return { started: false, generationId: this.speechGenerationId };
    }

    this.clearTransitionTimer();
    this.speechGenerationId += 1;
    const generationId = this.speechGenerationId;
    this.activeJob = null;
    this.adapter.cancelSystemSpeech();

    const chunks = splitTextIntoSpeechChunks(text, this.config.maxChunkChars);
    const shouldSetSpeaking = options?.setSpeakingState ?? true;

    if (chunks.length === 0) {
      if (shouldSetSpeaking) {
        this.setState('idle', 'Tap anywhere to speak.');
      }
      options?.onEnd?.();
      return { started: true, generationId };
    }

    this.activeJob = {
      generationId,
      fullText: text,
      chunks,
      nextChunkIndex: 0,
      listenAfter: Boolean(options?.listenAfter),
      setSpeakingState: shouldSetSpeaking,
      onEnd: options?.onEnd,
    };

    // Remember spoken chunks for acoustic echo suppression
    this.recentSpokenTexts = [...this.recentSpokenTexts.slice(-6), text];

    if (shouldSetSpeaking) {
      this.setState('speaking', 'Glow-A-Eye is speaking...');
    }

    this.dispatchNextChunk(generationId);
    return { started: true, generationId };
  }

  private dispatchNextChunk(expectedGenerationId: number): void {
    if (expectedGenerationId !== this.speechGenerationId || !this.activeJob) {
      return;
    }
    if (this.activeJob.generationId !== expectedGenerationId) {
      return;
    }

    const idx = this.activeJob.nextChunkIndex;
    if (idx >= this.activeJob.chunks.length) {
      const completedJob = this.activeJob;
      this.activeJob = null;
      if (completedJob.setSpeakingState && this.state === 'speaking') {
        this.setState('idle', 'Tap anywhere to speak.');
      }
      completedJob.onEnd?.();
      return;
    }

    const chunkText = this.activeJob.chunks[idx];
    this.activeJob.nextChunkIndex = idx + 1;

    this.adapter.speakChunk(chunkText, expectedGenerationId, (completedGenId) => {
      if (completedGenId !== this.speechGenerationId) {
        // Interrupted before chunk finished — do NOT advance remaining queue
        return;
      }
      this.dispatchNextChunk(completedGenId);
    });
  }

  public dispose(): void {
    this.clearTransitionTimer();
    this.speechGenerationId += 1;
    this.requestGenerationId += 1;
    this.activeJob = null;
    this.adapter.cancelSystemSpeech();
  }
}

export const TARGET_PCM_SAMPLE_RATE = 16000;

/**
 * Downsamples mono Float32 PCM audio from sourceSampleRate to targetSampleRate (16kHz).
 */
export function downsampleTo16k(
  input: Float32Array,
  sourceSampleRate: number,
  targetSampleRate = TARGET_PCM_SAMPLE_RATE
): Float32Array {
  if (sourceSampleRate <= 0 || input.length === 0) {
    return new Float32Array(0);
  }
  if (Math.round(sourceSampleRate) === targetSampleRate) {
    return new Float32Array(input);
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s0 = input[Math.min(idx, input.length - 1)];
    const s1 = input[Math.min(idx + 1, input.length - 1)];
    output[i] = s0 + (s1 - s0) * frac;
  }

  return output;
}

/**
 * Circular PCM pre-roll buffer + post-VAD utterance recorder.
 * Preserves up to 1.5s of audio BEFORE barge-in triggers so the first
 * syllable of interruptions like "Stop", "Why?", or "Wait" is never lost.
 */
export class PcmPreRollRecorder {
  private readonly sampleRate: number;
  private readonly ringCapacity: number;
  private readonly maxCaptureSamples: number;
  private ringBuffer: Float32Array;
  private ringWritePos = 0;
  private ringFilled = false;

  private capturing = false;
  private capturedChunks: Float32Array[] = [];
  private capturedSampleCount = 0;

  constructor(options?: {
    sampleRate?: number;
    preRollMs?: number;
    maxCaptureMs?: number;
  }) {
    this.sampleRate = options?.sampleRate ?? TARGET_PCM_SAMPLE_RATE;
    const preRollMs = options?.preRollMs ?? 1500;
    const maxCaptureMs = options?.maxCaptureMs ?? 7000;
    this.ringCapacity = Math.max(
      1600,
      Math.floor((this.sampleRate * preRollMs) / 1000)
    );
    this.maxCaptureSamples = Math.max(
      this.ringCapacity,
      Math.floor((this.sampleRate * maxCaptureMs) / 1000)
    );
    this.ringBuffer = new Float32Array(this.ringCapacity);
  }

  public isCapturing(): boolean {
    return this.capturing;
  }

  public getSampleRate(): number {
    return this.sampleRate;
  }

  public getCapturedDurationMs(): number {
    return Math.round((this.capturedSampleCount / this.sampleRate) * 1000);
  }

  public isMaxDurationReached(): boolean {
    return this.capturing && this.capturedSampleCount >= this.maxCaptureSamples;
  }

  public pushAudioFrame(samples: Float32Array, sourceSampleRate: number): void {
    const mono16k = downsampleTo16k(samples, sourceSampleRate, this.sampleRate);
    if (mono16k.length === 0) return;

    if (this.capturing) {
      const remainingCapacity = this.maxCaptureSamples - this.capturedSampleCount;
      if (remainingCapacity <= 0) return;
      const slice =
        mono16k.length <= remainingCapacity
          ? mono16k
          : mono16k.subarray(0, remainingCapacity);
      this.capturedChunks.push(slice);
      this.capturedSampleCount += slice.length;
      return;
    }

    for (let i = 0; i < mono16k.length; i += 1) {
      this.ringBuffer[this.ringWritePos] = mono16k[i];
      this.ringWritePos += 1;
      if (this.ringWritePos >= this.ringCapacity) {
        this.ringWritePos = 0;
        this.ringFilled = true;
      }
    }
  }

  /**
   * Locks the current circular pre-roll into active utterance capture
   * so all audio preceding + following the barge-in trigger is preserved.
   */
  public beginCapture(): void {
    if (this.capturing) return;

    const preRoll = this.readPreRollChronological();
    this.capturedChunks = preRoll.length > 0 ? [preRoll] : [];
    this.capturedSampleCount = preRoll.length;
    this.capturing = true;
    this.resetRing();
  }

  private readPreRollChronological(): Float32Array {
    if (!this.ringFilled) {
      return new Float32Array(this.ringBuffer.subarray(0, this.ringWritePos));
    }
    const ordered = new Float32Array(this.ringCapacity);
    const tailLen = this.ringCapacity - this.ringWritePos;
    ordered.set(this.ringBuffer.subarray(this.ringWritePos), 0);
    ordered.set(this.ringBuffer.subarray(0, this.ringWritePos), tailLen);
    return ordered;
  }

  private resetRing(): void {
    this.ringBuffer.fill(0);
    this.ringWritePos = 0;
    this.ringFilled = false;
  }

  public finishCapture(): {
    samples: Float32Array;
    sampleRate: number;
    durationMs: number;
  } {
    const merged = new Float32Array(this.capturedSampleCount);
    let offset = 0;
    for (const chunk of this.capturedChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    const durationMs = Math.round((merged.length / this.sampleRate) * 1000);
    this.capturing = false;
    this.capturedChunks = [];
    this.capturedSampleCount = 0;
    this.resetRing();

    return {
      samples: merged,
      sampleRate: this.sampleRate,
      durationMs,
    };
  }

  public reset(): void {
    this.capturing = false;
    this.capturedChunks = [];
    this.capturedSampleCount = 0;
    this.resetRing();
  }
}

/**
 * Encodes Float32 mono PCM [-1, 1] into a standard 16-bit PCM WAV base64 string.
 */
export function encodePcmToWavBase64(
  samples: Float32Array,
  sampleRate = TARGET_PCM_SAMPLE_RATE
): string {
  const numSamples = samples.length;
  const dataByteLength = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataByteLength, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, Math.round(int16), true);
    offset += 2;
  }

  const bytes = new Uint8Array(buffer);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Tracks post-barge-in user speech frames vs trailing silence so interrupted
 * utterances finish promptly once the user completes their thought.
 */
export class UtteranceEndpointer {
  private captureStartedAtMs = 0;
  private silenceSinceMs: number | null = null;
  private readonly minCaptureMs: number;
  private readonly silenceHangoverMs: number;
  private readonly maxCaptureMs: number;

  constructor(options?: {
    minCaptureMs?: number;
    silenceHangoverMs?: number;
    maxCaptureMs?: number;
  }) {
    this.minCaptureMs = options?.minCaptureMs ?? 380;
    this.silenceHangoverMs = options?.silenceHangoverMs ?? 780;
    this.maxCaptureMs = options?.maxCaptureMs ?? 7000;
  }

  public start(timestampMs: number): void {
    this.captureStartedAtMs = timestampMs;
    this.silenceSinceMs = null;
  }

  public update(isSpeechLikely: boolean, timestampMs: number): boolean {
    if (this.captureStartedAtMs === 0) {
      this.captureStartedAtMs = timestampMs;
    }
    const elapsed = timestampMs - this.captureStartedAtMs;
    if (elapsed >= this.maxCaptureMs) {
      return true;
    }
    if (isSpeechLikely) {
      this.silenceSinceMs = null;
      return false;
    }
    if (elapsed < this.minCaptureMs) {
      return false;
    }
    if (this.silenceSinceMs === null) {
      this.silenceSinceMs = timestampMs;
      return false;
    }
    return timestampMs - this.silenceSinceMs >= this.silenceHangoverMs;
  }
}

export async function requestInterruptionTranscription(
  wavBase64: string,
  mimeType = 'audio/wav'
): Promise<{ ok: true; transcript: string } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timerId = globalThis.setTimeout(() => controller.abort(), 16500);
  try {
    const response = await fetch('/api/transcribe-interruption', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audioBase64: wavBase64,
        mimeType,
      }),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => null)) as {
      transcript?: string;
      error?: string;
    } | null;

    if (!response.ok || typeof payload?.transcript !== 'string') {
      return {
        ok: false,
        error:
          payload?.error ||
          'Voice interruption could not be transcribed right now.',
      };
    }

    return {
      ok: true,
      transcript: payload.transcript.trim(),
    };
  } catch {
    return {
      ok: false,
      error: 'Could not reach the interruption transcription service.',
    };
  } finally {
    globalThis.clearTimeout(timerId);
  }
}

