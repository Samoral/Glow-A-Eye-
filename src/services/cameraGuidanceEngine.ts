import type {
  CameraSessionState,
  SkinAnalysisObservation,
} from '../types/assistant.ts';
import { formatSpokenTime } from '../utils/accessibility.ts';
import type {
  CapturedPhotoResult,
  GuidanceCondition,
  ImageQualityReport,
  LiveGuidanceEvaluation,
} from '../utils/imageQuality.ts';
import {
  formatFullObservationSpeech,
  type SkinAnalysisClientResult,
} from './skinAnalysisClient.ts';

export interface CameraGuidanceConfig {
  sampleIntervalMs: number;
  stabilityHoldMs: number;
  minStableFrames: number;
  instructionSettleMs: number;
  sameInstructionCooldownMs: number;
  uncertainAssistanceMs: number;
  countdownLeadDelayMs: number;
  countdownBeatMs: number;
}

export const DEFAULT_CAMERA_GUIDANCE_CONFIG: CameraGuidanceConfig = {
  sampleIntervalMs: 420,
  stabilityHoldMs: 1200,
  minStableFrames: 3,
  instructionSettleMs: 1900,
  sameInstructionCooldownMs: 6500,
  uncertainAssistanceMs: 20000,
  countdownLeadDelayMs: 280,
  countdownBeatMs: 950,
};

export interface CameraEngineSnapshot {
  state: CameraSessionState;
  stateLabel: string;
  guidanceText: string;
  countdownSeconds: number | null;
  lastEvaluation: LiveGuidanceEvaluation | null;
  capturedPhoto: CapturedPhotoResult | null;
  observation: SkinAnalysisObservation | null;
  errorMessage: string | null;
  isPreviewVisible: boolean;
  isActiveSession: boolean;
}

export interface CameraGuidanceAdapter {
  requestCameraStream: () => Promise<
    | { ok: true }
    | { ok: false; denied: boolean; unsupported?: boolean; message: string }
  >;
  stopCameraStream: () => void;
  sampleFrame: (previousSnapshot: Float32Array | null) => LiveGuidanceEvaluation;
  captureFrame: () => { dataUrl: string | null; report: ImageQualityReport };
  analyzeCapturedPhoto: (dataUrl: string) => Promise<SkinAnalysisClientResult>;
  speak: (
    text: string,
    options?: {
      alsoLog?: boolean;
      listenAfter?: boolean;
      onDone?: () => void;
    }
  ) => void;
  playCue: (kind: 'listen-start' | 'listen-stop' | 'error' | 'camera-ready') => void;
  isAssistantSpeaking: () => boolean;
  isUserSpeaking: () => boolean;
  onStateChange: (snapshot: CameraEngineSnapshot) => void;
  onObservationReady?: (observation: SkinAnalysisObservation) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

export function getCameraStateLabel(state: CameraSessionState): string {
  switch (state) {
    case 'inactive':
      return 'Camera Inactive';
    case 'requesting_permission':
      return 'Requesting Permission';
    case 'initializing_camera':
      return 'Initialising Camera';
    case 'searching_for_skin':
      return 'Searching for Skin';
    case 'guiding_positioning':
      return 'Guiding Positioning';
    case 'target_detected':
      return 'Target Detected';
    case 'checking_stability':
      return 'Checking Stability';
    case 'countdown':
      return 'Countdown';
    case 'capturing':
      return 'Capturing';
    case 'validating_photograph':
      return 'Validating Photograph';
    case 'analyzing':
      return 'Analysing';
    case 'error':
      return 'Camera Error';
    case 'cancelled':
      return 'Cancelled';
  }
}

export function isPreviewVisibleState(state: CameraSessionState): boolean {
  return (
    state === 'requesting_permission' ||
    state === 'initializing_camera' ||
    state === 'searching_for_skin' ||
    state === 'guiding_positioning' ||
    state === 'target_detected' ||
    state === 'checking_stability' ||
    state === 'countdown' ||
    state === 'capturing' ||
    state === 'validating_photograph'
  );
}

const ACTIVE_SESSION_STATES = new Set<CameraSessionState>([
  'requesting_permission',
  'initializing_camera',
  'searching_for_skin',
  'guiding_positioning',
  'target_detected',
  'checking_stability',
  'countdown',
  'capturing',
  'validating_photograph',
  'analyzing',
]);

export class CameraGuidanceController {
  private readonly adapter: CameraGuidanceAdapter;
  private readonly config: CameraGuidanceConfig;

  private state: CameraSessionState = 'inactive';
  private guidanceText = '';
  private lastSpokenGuidance = '';
  private countdownSeconds: number | null = null;
  private lastEvaluation: LiveGuidanceEvaluation | null = null;
  private capturedPhoto: CapturedPhotoResult | null = null;
  private observation: SkinAnalysisObservation | null = null;
  private errorMessage: string | null = null;

  private sessionToken = 0;
  private previousSnapshot: Float32Array | null = null;
  private readySinceMs: number | null = null;
  private consecutiveReadyCount = 0;
  private lastSpokenCondition: GuidanceCondition | null = null;
  private lastSpokenAtMs = 0;
  private lastSpeechEndedAtMs = 0;
  private searchStartedAtMs = 0;
  private assistanceSuggested = false;

  private sampleTimerId: number | null = null;
  private countdownTimerId: number | null = null;
  private slowAnalysisTimerId: number | null = null;
  private isAnalyzingInFlight = false;

  constructor(
    adapter: CameraGuidanceAdapter,
    config: Partial<CameraGuidanceConfig> = {}
  ) {
    this.adapter = adapter;
    this.config = { ...DEFAULT_CAMERA_GUIDANCE_CONFIG, ...config };
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

  private clearAllTimers(): void {
    this.clearTimer(this.sampleTimerId);
    this.sampleTimerId = null;
    this.clearTimer(this.countdownTimerId);
    this.countdownTimerId = null;
    this.clearTimer(this.slowAnalysisTimerId);
    this.slowAnalysisTimerId = null;
  }

  public getSnapshot(): CameraEngineSnapshot {
    return {
      state: this.state,
      stateLabel: getCameraStateLabel(this.state),
      guidanceText: this.guidanceText,
      countdownSeconds: this.countdownSeconds,
      lastEvaluation: this.lastEvaluation,
      capturedPhoto: this.capturedPhoto,
      observation: this.observation,
      errorMessage: this.errorMessage,
      isPreviewVisible: isPreviewVisibleState(this.state),
      isActiveSession: ACTIVE_SESSION_STATES.has(this.state),
    };
  }

  private emit(): void {
    this.adapter.onStateChange(this.getSnapshot());
  }

  private speakGuidance(
    text: string,
    options?: {
      alsoLog?: boolean;
      listenAfter?: boolean;
      onDone?: () => void;
    }
  ): void {
    this.lastSpokenGuidance = text;
    this.guidanceText = text;
    this.lastSpokenAtMs = this.now();
    this.emit();

    const tokenAtSpeak = this.sessionToken;
    this.adapter.speak(text, {
      alsoLog: options?.alsoLog ?? false,
      listenAfter: options?.listenAfter ?? true,
      onDone: () => {
        this.lastSpeechEndedAtMs = this.now();
        if (tokenAtSpeak === this.sessionToken) {
          options?.onDone?.();
        }
      },
    });
  }

  public async start(): Promise<void> {
    if (ACTIVE_SESSION_STATES.has(this.state)) {
      if (this.state === 'countdown') {
        return;
      }
      if (this.state === 'analyzing') {
        this.adapter.speak('Skin photograph analysis is already in progress. Please wait.', {
          listenAfter: false,
        });
        return;
      }
      // Prevent duplicate streams when camera is already active/requesting
      this.repeatLastGuidance();
      return;
    }

    this.clearAllTimers();
    this.sessionToken += 1;
    const token = this.sessionToken;

    this.capturedPhoto = null;
    this.observation = null;
    this.errorMessage = null;
    this.countdownSeconds = null;
    this.lastEvaluation = null;
    this.previousSnapshot = null;
    this.readySinceMs = null;
    this.consecutiveReadyCount = 0;
    this.lastSpokenCondition = null;
    this.assistanceSuggested = false;

    this.state = 'requesting_permission';
    this.guidanceText =
      'Requesting camera permission, preferring the rear-facing camera.';
    this.emit();

    this.adapter.speak(
      'Opening camera, preferring the rear-facing camera. Please allow camera permission if prompted.',
      { alsoLog: false, listenAfter: false }
    );

    const streamResult = await this.adapter.requestCameraStream();
    if (token !== this.sessionToken) {
      // Session was cancelled while waiting for permission
      this.adapter.stopCameraStream();
      return;
    }

    if (!streamResult.ok) {
      this.adapter.stopCameraStream();
      this.state = 'error';
      this.errorMessage = streamResult.message;
      this.guidanceText = streamResult.message;
      this.lastSpokenGuidance = streamResult.message;
      this.emit();
      this.adapter.playCue('error');
      this.adapter.speak(streamResult.message, {
        alsoLog: true,
        listenAfter: true,
      });
      return;
    }

    this.state = 'initializing_camera';
    this.searchStartedAtMs = this.now();
    this.guidanceText =
      'Camera is active. Hold your phone about one hand’s length from your skin. I will guide you automatically.';
    this.emit();

    this.adapter.playCue('camera-ready');
    this.speakGuidance(
      'Camera is active. Point the rear camera toward the skin area about one hand’s length away. I will guide your positioning automatically. Say Cancel or Stop anytime.',
      {
        alsoLog: true,
        listenAfter: true,
      }
    );

    this.scheduleNextSample(token, this.config.sampleIntervalMs);
  }

  private scheduleNextSample(token: number, delayMs: number): void {
    this.clearTimer(this.sampleTimerId);
    this.sampleTimerId = this.setTimer(() => {
      if (token !== this.sessionToken) return;
      this.stepGuidanceLoop(token);
    }, delayMs);
  }

  /**
   * Executes one real-time frame evaluation tick. Exposed as public for deterministic testing.
   */
  public stepGuidanceLoop(expectedToken = this.sessionToken): void {
    if (expectedToken !== this.sessionToken) return;
    if (
      this.state !== 'initializing_camera' &&
      this.state !== 'searching_for_skin' &&
      this.state !== 'guiding_positioning' &&
      this.state !== 'target_detected' &&
      this.state !== 'checking_stability'
    ) {
      return;
    }

    const evaluation = this.adapter.sampleFrame(this.previousSnapshot);
    this.lastEvaluation = evaluation;
    if (evaluation.snapshot) {
      this.previousSnapshot = evaluation.snapshot;
    }

    const currentTime = this.now();

    if (!evaluation.checkPerformed) {
      this.guidanceText = evaluation.instruction;
      this.emit();
      this.scheduleNextSample(expectedToken, this.config.sampleIntervalMs);
      return;
    }

    if (evaluation.category === 'no_skin_visible') {
      this.state = 'searching_for_skin';
      this.readySinceMs = null;
      this.consecutiveReadyCount = 0;
    } else if (
      evaluation.category === 'skin_not_framed' ||
      evaluation.category === 'quality_insufficient' ||
      evaluation.category === 'uncertain'
    ) {
      this.state = 'guiding_positioning';
      this.readySinceMs = null;
      this.consecutiveReadyCount = 0;
    } else if (evaluation.category === 'skin_ready') {
      this.assistanceSuggested = false;
      this.searchStartedAtMs = currentTime;

      if (!evaluation.isStable) {
        this.state = 'target_detected';
        this.readySinceMs = null;
        this.consecutiveReadyCount = 0;
      } else {
        this.state = 'checking_stability';
        this.consecutiveReadyCount += 1;
        if (this.readySinceMs === null) {
          this.readySinceMs = currentTime;
        }

        const stableDuration = currentTime - this.readySinceMs;
        if (
          this.consecutiveReadyCount >= this.config.minStableFrames &&
          stableDuration >= this.config.stabilityHoldMs
        ) {
          this.beginCountdown(expectedToken);
          return;
        }
      }
    }

    this.guidanceText = evaluation.instruction;
    this.emit();

    this.maybeSpeakGuidanceUpdate(evaluation, currentTime);
    this.scheduleNextSample(expectedToken, this.config.sampleIntervalMs);
  }

  private maybeSpeakGuidanceUpdate(
    evaluation: LiveGuidanceEvaluation,
    currentTime: number
  ): void {
    // Never talk over the assistant or the user
    if (this.adapter.isAssistantSpeaking() || this.adapter.isUserSpeaking()) {
      return;
    }

    if (
      this.lastSpeechEndedAtMs > 0 &&
      currentTime - this.lastSpeechEndedAtMs < this.config.instructionSettleMs
    ) {
      return;
    }

    // Also avoid speaking immediately before the intro speech ends
    if (
      this.lastSpokenAtMs > 0 &&
      this.lastSpeechEndedAtMs < this.lastSpokenAtMs &&
      currentTime - this.lastSpokenAtMs < this.config.sameInstructionCooldownMs
    ) {
      return;
    }

    // If unable to lock on for an extended period, politely suggest adjusting or asking someone nearby
    if (
      evaluation.category !== 'skin_ready' &&
      !this.assistanceSuggested &&
      this.searchStartedAtMs > 0 &&
      currentTime - this.searchStartedAtMs >= this.config.uncertainAssistanceMs
    ) {
      this.assistanceSuggested = true;
      this.lastSpokenCondition = evaluation.condition;
      this.speakGuidance(
        `${evaluation.instruction} If it is hard to align, try moving into brighter even light or ask someone nearby for assistance if available.`,
        { alsoLog: false, listenAfter: true }
      );
      return;
    }

    const isSameCondition = evaluation.condition === this.lastSpokenCondition;
    if (
      isSameCondition &&
      currentTime - this.lastSpokenAtMs < this.config.sameInstructionCooldownMs
    ) {
      return;
    }

    this.lastSpokenCondition = evaluation.condition;
    this.speakGuidance(evaluation.instruction, {
      alsoLog: false,
      listenAfter: true,
    });
  }

  private beginCountdown(expectedToken: number): void {
    if (expectedToken !== this.sessionToken) return;

    this.clearTimer(this.sampleTimerId);
    this.sampleTimerId = null;

    this.state = 'countdown';
    this.countdownSeconds = 3;
    this.guidanceText =
      'Perfect. I can see the skin area clearly. Hold still. Taking your picture in three seconds.';
    this.emit();
    this.adapter.playCue('camera-ready');

    this.speakGuidance(
      'Perfect. I can see the skin area clearly. Hold still. Taking your picture in three seconds.',
      {
        alsoLog: true,
        listenAfter: false,
        onDone: () => {
          if (expectedToken !== this.sessionToken || this.state !== 'countdown') {
            return;
          }
          this.countdownTimerId = this.setTimer(() => {
            this.runCountdownBeat(expectedToken, 3);
          }, this.config.countdownLeadDelayMs);
        },
      }
    );
  }

  private runCountdownBeat(expectedToken: number, secondsLeft: number): void {
    if (expectedToken !== this.sessionToken || this.state !== 'countdown') {
      return;
    }

    this.countdownSeconds = secondsLeft;
    const word = secondsLeft === 3 ? 'Three.' : secondsLeft === 2 ? 'Two.' : 'One.';
    this.guidanceText = `Taking photo in ${secondsLeft}... Hold still.`;
    this.emit();

    this.adapter.speak(word, {
      alsoLog: false,
      listenAfter: secondsLeft > 1,
      onDone: () => {
        if (expectedToken !== this.sessionToken || this.state !== 'countdown') {
          return;
        }
        this.countdownTimerId = this.setTimer(() => {
          if (expectedToken !== this.sessionToken || this.state !== 'countdown') {
            return;
          }
          if (secondsLeft > 1) {
            this.runCountdownBeat(expectedToken, secondsLeft - 1);
          } else {
            this.performCaptureAndValidate(expectedToken);
          }
        }, this.config.countdownBeatMs);
      },
    });
  }

  private performCaptureAndValidate(expectedToken: number): void {
    if (expectedToken !== this.sessionToken) return;

    this.clearTimer(this.sampleTimerId);
    this.sampleTimerId = null;
    this.clearTimer(this.countdownTimerId);
    this.countdownTimerId = null;

    this.state = 'capturing';
    this.countdownSeconds = null;
    this.guidanceText = 'Capturing photograph...';
    this.emit();

    const { dataUrl, report } = this.adapter.captureFrame();

    this.state = 'validating_photograph';
    this.guidanceText = 'Checking photograph clarity...';
    this.emit();

    if (!dataUrl || !report.checkPerformed || !report.passed) {
      // Captured image was inadequate (e.g., user moved during countdown) -> resume guidance
      const cleanFeedback = report.spokenFeedback
        .replace(/Please adjust and say Retake, or say Cancel to stop\./gi, '')
        .replace(/and say Retake\./gi, '')
        .trim();
      const retakeGuidance = `${cleanFeedback} Returning to camera guidance so we can capture a clearer photo.`;

      this.adapter.playCue('error');
      this.previousSnapshot = null;
      this.readySinceMs = null;
      this.consecutiveReadyCount = 0;
      this.lastSpokenCondition = null;
      this.state = 'guiding_positioning';
      this.speakGuidance(retakeGuidance, {
        alsoLog: true,
        listenAfter: true,
      });
      this.scheduleNextSample(
        expectedToken,
        this.config.sampleIntervalMs + this.config.instructionSettleMs
      );
      return;
    }

    const captured: CapturedPhotoResult = {
      dataUrl,
      report,
      capturedAt: formatSpokenTime(),
    };
    this.capturedPhoto = captured;

    // Stop camera stream & guidance loop immediately after valid capture
    this.adapter.stopCameraStream();
    void this.runGeminiAnalysis(captured.dataUrl, expectedToken);
  }

  public async triggerManualCapture(): Promise<void> {
    if (this.state === 'countdown') {
      this.performCaptureAndValidate(this.sessionToken);
      return;
    }

    if (
      this.state === 'inactive' ||
      this.state === 'error' ||
      this.state === 'cancelled'
    ) {
      await this.start();
      return;
    }

    if (this.state === 'analyzing' || this.state === 'capturing' || this.state === 'validating_photograph') {
      return;
    }

    // Evaluate live frame first; never capture an unusable blank/unseen photo blindly
    const check = this.adapter.sampleFrame(this.previousSnapshot);
    if (!check.checkPerformed || check.category === 'uncertain') {
      this.adapter.playCue('error');
      this.speakGuidance(check.instruction, { alsoLog: false, listenAfter: true });
      return;
    }

    this.performCaptureAndValidate(this.sessionToken);
  }

  private async runGeminiAnalysis(
    dataUrl: string,
    expectedToken: number
  ): Promise<void> {
    if (this.isAnalyzingInFlight) {
      this.adapter.speak('Analysis is already in progress. Please wait a moment.', {
        listenAfter: false,
      });
      return;
    }

    this.isAnalyzingInFlight = true;
    this.state = 'analyzing';
    this.errorMessage = null;
    this.guidanceText = 'Analyzing your photograph now. Please wait a moment.';
    this.emit();

    this.adapter.playCue('listen-start');
    this.adapter.speak(
      'Photo captured clearly. Analyzing your photograph now. Please wait a moment.',
      { alsoLog: false, listenAfter: false }
    );

    this.clearTimer(this.slowAnalysisTimerId);
    this.slowAnalysisTimerId = this.setTimer(() => {
      if (this.isAnalyzingInFlight && expectedToken === this.sessionToken) {
        this.adapter.speak(
          'Still examining your photograph carefully. Please hold on a moment.',
          { listenAfter: false }
        );
      }
    }, 9000);

    try {
      const result = await this.adapter.analyzeCapturedPhoto(dataUrl);
      if (expectedToken !== this.sessionToken) {
        return;
      }

      if (!result.ok) {
        this.state = 'error';
        this.errorMessage = result.error;
        this.guidanceText = result.error;
        this.emit();
        this.adapter.playCue('error');
        this.adapter.speak(
          `${result.error} You can say "Analyze photo" to try again, "Open camera" to retake, or "Cancel".`,
          { alsoLog: true, listenAfter: true }
        );
        return;
      }

      this.observation = result.observation;
      this.state = 'inactive';
      this.guidanceText = '';
      this.emit();

      this.adapter.onObservationReady?.(result.observation);
      this.adapter.playCue('camera-ready');
      this.adapter.speak(
        `${formatFullObservationSpeech(result.observation)} Would you like to answer a few tailored follow-up symptom questions so I can run a safety check and give more helpful guidance? Say "Yes" or "Start questions".`,
        { alsoLog: true, listenAfter: true }
      );
    } finally {
      if (expectedToken === this.sessionToken) {
        this.clearTimer(this.slowAnalysisTimerId);
        this.slowAnalysisTimerId = null;
        this.isAnalyzingInFlight = false;
      }
    }
  }

  public async retryAnalysis(): Promise<void> {
    if (this.isAnalyzingInFlight) {
      this.adapter.speak('Analysis is already in progress. Please wait a moment.', {
        listenAfter: false,
      });
      return;
    }
    if (!this.capturedPhoto) {
      this.adapter.speak(
        'No captured photograph is ready yet. Say "Open camera" to begin.',
        { alsoLog: true, listenAfter: true }
      );
      return;
    }
    this.sessionToken += 1;
    await this.runGeminiAnalysis(this.capturedPhoto.dataUrl, this.sessionToken);
  }

  public async retake(): Promise<void> {
    this.cancel('Restarting camera for a fresh photograph.', false);
    await this.start();
  }

  /**
   * Canonical cleanup entry point for every camera cancellation / close path.
   * Increments sessionToken, cancels all timers/loops/countdowns/analysis,
   * releases every MediaStream track via stopCameraStream(), and resets
   * camera mode out of preview into cancelled/inactive immediately.
   */
  public stopCameraSession(options?: {
    announcement?: string;
    listenAfter?: boolean;
    silent?: boolean;
    clearObservation?: boolean;
  }): void {
    const wasActive =
      ACTIVE_SESSION_STATES.has(this.state) ||
      this.capturedPhoto !== null ||
      this.state === 'error' ||
      this.isAnalyzingInFlight;

    this.sessionToken += 1;
    this.clearAllTimers();
    this.isAnalyzingInFlight = false;
    this.adapter.stopCameraStream();

    this.countdownSeconds = null;
    this.capturedPhoto = null;
    this.lastEvaluation = null;
    this.previousSnapshot = null;
    this.readySinceMs = null;
    this.consecutiveReadyCount = 0;
    this.lastSpokenCondition = null;
    this.assistanceSuggested = false;
    this.errorMessage = null;
    this.guidanceText = '';
    if (options?.clearObservation) {
      this.observation = null;
    }

    if (options?.silent) {
      this.state = 'inactive';
      this.emit();
      return;
    }

    const listenAfter = options?.listenAfter ?? true;
    const announcement =
      options?.announcement ?? 'Camera cancelled and temporary image discarded.';

    if (!wasActive) {
      this.state = 'inactive';
      this.emit();
      if (announcement) {
        this.adapter.speak(
          'Camera is already closed and no photo is stored. How can I help you?',
          { listenAfter }
        );
      }
      return;
    }

    this.state = 'cancelled';
    this.emit();

    if (announcement) {
      this.adapter.playCue('listen-stop');
      this.adapter.speak(announcement, {
        alsoLog: true,
        listenAfter,
      });
    }
  }

  public cancel(
    announcement = 'Camera cancelled and temporary image discarded.',
    listenAfter = true
  ): void {
    this.stopCameraSession({
      announcement,
      listenAfter,
      silent: false,
      clearObservation: false,
    });
  }

  public stopSilently(): void {
    this.stopCameraSession({
      silent: true,
      clearObservation: true,
    });
  }

  public checkFramingNow(): void {
    if (!isPreviewVisibleState(this.state)) {
      this.adapter.speak(
        'Say "Open camera" first so I can check lighting and framing.',
        { listenAfter: true }
      );
      return;
    }

    const evaluation = this.adapter.sampleFrame(this.previousSnapshot);
    this.lastEvaluation = evaluation;
    if (evaluation.snapshot) {
      this.previousSnapshot = evaluation.snapshot;
    }
    this.guidanceText = evaluation.instruction;
    this.emit();

    this.speakGuidance(evaluation.instruction, {
      alsoLog: false,
      listenAfter: true,
    });
  }

  public repeatLastGuidance(): void {
    const text =
      this.lastSpokenGuidance ||
      this.guidanceText ||
      'Hold the rear camera about one hand’s length from the skin area in even light. I will guide you automatically, or say Cancel to exit.';
    this.speakGuidance(text, { alsoLog: false, listenAfter: true });
  }

  public pauseGuidanceForUser(): void {
    if (!isPreviewVisibleState(this.state)) {
      return;
    }
    this.clearTimer(this.countdownTimerId);
    this.countdownTimerId = null;
    this.clearTimer(this.sampleTimerId);
    this.sampleTimerId = null;
    this.readySinceMs = null;
    this.consecutiveReadyCount = 0;
    this.lastSpokenAtMs = this.now();

    if (this.state === 'countdown') {
      this.state = 'guiding_positioning';
      this.countdownSeconds = null;
    }
    this.guidanceText = 'Paused while listening to you. Say Resume or Help when ready.';
    this.emit();
  }

  public resumeGuidanceLoop(): void {
    if (!isPreviewVisibleState(this.state)) {
      return;
    }
    this.lastSpeechEndedAtMs = this.now();
    this.lastSpokenCondition = null;
    if (this.state === 'countdown') {
      this.state = 'guiding_positioning';
      this.countdownSeconds = null;
      this.emit();
    }
    this.scheduleNextSample(this.sessionToken, this.config.sampleIntervalMs);
  }

  public speakCameraHelp(): void {
    const wasPreview = isPreviewVisibleState(this.state);
    if (this.state === 'countdown') {
      this.clearTimer(this.countdownTimerId);
      this.countdownTimerId = null;
      this.state = 'guiding_positioning';
      this.countdownSeconds = null;
      this.readySinceMs = null;
      this.consecutiveReadyCount = 0;
    }
    if (wasPreview) {
      this.clearTimer(this.sampleTimerId);
      this.sampleTimerId = null;
    }

    const helpMsg =
      'Hold the rear camera about one hand’s length away from your skin in bright, even light. Move slowly as I guide you left, right, closer, or farther. Once clear and steady, I will count down three seconds and take the photo automatically. You can say Repeat, Check framing, Cancel, or Stop camera anytime. If aligning is difficult, asking someone nearby for a hand can also help.';
    const token = this.sessionToken;
    this.speakGuidance(helpMsg, {
      alsoLog: true,
      listenAfter: true,
      onDone: () => {
        if (wasPreview && token === this.sessionToken && isPreviewVisibleState(this.state)) {
          this.scheduleNextSample(
            token,
            this.config.sampleIntervalMs + this.config.instructionSettleMs
          );
        }
      },
    });
  }

  public dispose(): void {
    this.sessionToken += 1;
    this.clearAllTimers();
    this.isAnalyzingInFlight = false;
    this.adapter.stopCameraStream();
  }
}
