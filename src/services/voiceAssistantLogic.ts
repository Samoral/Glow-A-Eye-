import type { VoiceCommandAction } from '../types/assistant.ts';

export interface AssistantTurnResult {
  reply: string;
  action: VoiceCommandAction;
  /** When true, the action handler speaks and logs the exact outcome itself. */
  handledByAction?: boolean;
}

export interface VoiceCommandContext {
  isCameraActive?: boolean;
  hasCapturedPhoto?: boolean;
  hasAnalysis?: boolean;
  isQuestioningActive?: boolean;
  hasAssessmentReport?: boolean;
  awaitingAssessmentStartConfirm?: boolean;
}

export const WELCOME_GREETING =
  'Hello, I am Glow-A-Eye, your voice-first skin health companion. Your skin, your voice, your confidence. Tell me when you are ready for a skin examination, ask any question, or say help for commands.';

export const ABOUT_SPOKEN_SUMMARY =
  'Glow-A-Eye is a voice-first skin health companion built for blind and visually impaired users. It combines guided camera positioning, pixel-level photo quality checks, cautious visual observations, adaptive symptom questions, and a dedicated Medical Safety Engine. Glow-A-Eye provides informational observations only, never a medical diagnosis, cancer screening, or prescription. Your photographs stay in temporary browser memory until you explicitly ask to analyze them, are sent securely without exposing keys, and are never saved unless you choose to save a text-only summary on your device.';

export interface StrippedLeadInResult {
  hadPrefix: boolean;
  remainder: string;
}

/**
 * Strips leading conversational barge-in prefixes (e.g. "Stop. ", "Wait, ",
 * "Hold on, ") ONLY when followed by a substantive question or command,
 * preserving standalone stop/wait/camera/listening commands intact.
 */
export function stripInterruptionLeadIn(rawInput: string): StrippedLeadInResult {
  const trimmed = rawInput.trim();
  if (!trimmed) return { hadPrefix: false, remainder: '' };

  const prefixRegex =
    /^(?:(?:please\s+)?(?:stop speaking|stop talking|stop reading|wait a minute|wait a second|hold on|hang on|excuse me|pardon me|one moment|one second|listen)\b[\s,.:;!?-]+|(?:stop|wait)(?:[,.;:!?]+\s+|\s+(?=(?:what|why|how|where|when|who|explain|repeat|rephrase|i\b|can|could|would|tell|start|open|close|help|that|this|actually|sorry)\b))[\s,.:;!?-]*)+/i;

  const match = prefixRegex.exec(trimmed);
  if (!match) {
    return { hadPrefix: false, remainder: trimmed };
  }

  const remainder = trimmed.slice(match[0].length).trim();
  if (!remainder) {
    return { hadPrefix: false, remainder: trimmed };
  }

  return { hadPrefix: true, remainder };
}

/**
 * Interprets spoken or typed user input.
 * Strictly avoids diagnosing skin diseases, prescribing medications,
 * or fabricating AI skin analysis results.
 */
export function interpretVoiceInput(
  rawInput: string,
  context: VoiceCommandContext = {}
): AssistantTurnResult {
  const originalTrimmed = rawInput.trim();
  const normalizedOriginal = originalTrimmed.toLowerCase();

  if (!normalizedOriginal) {
    return {
      reply:
        'I did not catch any words. Tap anywhere or press Space to speak again.',
      action: { type: 'none' },
    };
  }

  const { remainder } = stripInterruptionLeadIn(originalTrimmed);
  const effectiveRaw = remainder || originalTrimmed;
  const normalized = effectiveRaw.toLowerCase();

  // 1. Real-time barge-in & turn control (always active across every mode)
  if (
    /\b(stop speaking|stop talking|be quiet|quiet|silence|mute speech|stop reading)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'stop_speaking' },
      handledByAction: true,
    };
  }

  if (
    /^(?:wait|wait a minute|wait a second|hold on|hang on|one moment|one second|excuse me|pause|just a moment|just a second|let me ask something|let me ask a question|i have a question|can i ask something|can i ask a question)[.!?]*$/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'pause_for_user', transcript: effectiveRaw },
      handledByAction: true,
    };
  }

  if (
    /^(?:continue|go ahead|keep going|resume|keep speaking|where were we|carry on|please continue)[.!?]*$/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'resume_conversation' },
      handledByAction: true,
    };
  }

  if (
    /\b(that's not what i meant|that is not what i meant|not what i meant|you misunderstood|that's wrong|that is wrong|no that's not right|i didn't say that)\b/.test(
      normalized
    ) ||
    /^(?:actually|correction|wait no|no wait|sorry i meant|no i meant|i meant|change my last answer|change that|fix that|let me correct)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'correct_last_statement', transcript: effectiveRaw },
      handledByAction: true,
    };
  }

  if (
    normalized === 'stop' &&
    (context.isCameraActive || context.hasCapturedPhoto)
  ) {
    return {
      reply: '',
      action: { type: 'cancel_camera' },
      handledByAction: true,
    };
  }

  if (
    /\b(stop listening|stop mic|turn off microphone|mute|pause listening|cancel listening)\b/.test(
      normalized
    ) ||
    normalized === 'stop'
  ) {
    return {
      reply: 'Microphone stopped. Tap anywhere or say start again whenever you are ready.',
      action: { type: 'stop_listening' },
    };
  }

  if (
    /\b(end conversation|end the conversation|stop conversation|close conversation|goodbye|bye bye|that is all|that's all|i am done|i'm done|finish conversation)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'end_conversation' },
      handledByAction: true,
    };
  }

  if (
    /\b(start again|start over|restart conversation|new conversation|begin again|reset conversation)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'restart_conversation' },
      handledByAction: true,
    };
  }

  // 2. Active symptom questioning controls & natural spoken answers
  if (context.isQuestioningActive) {
    if (
      /\b(repeat the question|repeat question|say the question again|what was the question|repeat|say that again|pardon)\b/.test(
        normalized
      )
    ) {
      return {
        reply: '',
        action: { type: 'symptom_repeat_question' },
        handledByAction: true,
      };
    }

    if (
      /\b(explain what you mean|what do you mean|explain the question|explain that again|repeat differently|repeat it differently|say that differently|rephrase|clarify|i don't understand)\b/.test(
        normalized
      )
    ) {
      return {
        reply: '',
        action: { type: 'symptom_explain_question' },
        handledByAction: true,
      };
    }

    if (/\b(skip this question|skip question|skip this|pass|next question)\b/.test(normalized) || normalized === 'skip') {
      return {
        reply: '',
        action: { type: 'symptom_skip_question' },
        handledByAction: true,
      };
    }

    if (/\b(i don't know|don't know|do not know|not sure|unsure|i am not sure|no idea)\b/.test(normalized)) {
      return {
        reply: '',
        action: { type: 'symptom_dont_know' },
        handledByAction: true,
      };
    }

    if (/\b(go back|previous question|last question|back one question)\b/.test(normalized)) {
      return {
        reply: '',
        action: { type: 'symptom_go_back' },
        handledByAction: true,
      };
    }

    if (
      /\b(finish assessment|end assessment|finish questions|stop questions|stop assessment|cancel assessment|done answering|generate assessment|generate report)\b/.test(
        normalized
      )
    ) {
      return {
        reply: '',
        action: { type: 'symptom_finish_assessment' },
        handledByAction: true,
      };
    }

    const isMetaQuestionDuringAssessment =
      /^what does .+ mean\??$/.test(normalized) ||
      /^why\??$/.test(normalized) ||
      /\b(help me|need help)\b/.test(normalized);

    // Allow explicit utility commands, camera exit & meta-questions even during questioning
    if (
      !isMetaQuestionDuringAssessment &&
      !/\b(open settings|cancel camera|close camera|stop camera|exit camera|turn off camera|cancel capture|speak slower|speak faster|dark mode|light mode)\b/.test(
        normalized
      )
    ) {
      return {
        reply: '',
        action: { type: 'symptom_answer', transcript: effectiveRaw },
        handledByAction: true,
      };
    }
  }

  // 3. Confirm or decline starting follow-up symptom questions right after image observation
  if (
    context.awaitingAssessmentStartConfirm &&
    /^(yes|yeah|yep|sure|okay|ok|please|yes please|let's do that|go ahead|start|ask me)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'start_questions' },
      handledByAction: true,
    };
  }

  if (
    context.awaitingAssessmentStartConfirm &&
    /^(no|no thanks|not now|not right now|maybe later|skip questions)\b/.test(normalized)
  ) {
    return {
      reply:
        'Okay, I will not start symptom questions right now. Your visual observations remain available, and you can say "Start questions" anytime.',
      action: { type: 'decline_questions' },
    };
  }

  // 4. Final assessment report & explanation follow-up questions
  if (
    /\b(why do you think that|why do you say that|why that|why do you recommend|why should i see|how did you decide)\b/.test(
      normalized
    ) ||
    /^(?:why|why is that|why though|and why)[.?!]*$/.test(normalized)
  ) {
    return {
      reply: '',
      action: { type: 'assessment_why' },
      handledByAction: true,
    };
  }

  if (/\b(should i see a doctor|do i need a doctor|see a clinician|go to the doctor|urgent care|emergency room|see a dermatologist)\b/.test(normalized)) {
    return {
      reply: '',
      action: { type: 'assessment_see_doctor' },
      handledByAction: true,
    };
  }

  if (/\b(repeat my assessment|repeat the assessment|repeat assessment|read my assessment)\b/.test(normalized)) {
    return {
      reply: '',
      action: { type: 'assessment_repeat' },
      handledByAction: true,
    };
  }

  if (
    /\b(explain that again|explain again|repeat differently|repeat it differently|say that differently|say it differently|say it in a different way|explain another way|rephrase that|rephrase|what did you mean by that)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'repeat_differently' },
      handledByAction: true,
    };
  }

  if (
    /\b(explain it more simply|explain more simply|explain assessment simply|simpler assessment)\b/.test(
      normalized
    ) ||
    (context.hasAssessmentReport &&
      /\b(explain that in simpler terms|explain in simpler terms|simpler terms|explain simpler|plain language|plain english)\b/.test(
        normalized
      ))
  ) {
    return {
      reply: '',
      action: { type: 'assessment_explain_simpler' },
      handledByAction: true,
    };
  }

  if (
    /\b(what should i do now)\b/.test(normalized) ||
    (context.hasAssessmentReport &&
      /\b(what should i do next|what do i do next|recommended next steps|next steps|what now)\b/.test(
        normalized
      ))
  ) {
    return {
      reply: '',
      action: { type: 'assessment_what_now' },
      handledByAction: true,
    };
  }

  // 4b. Consent-based assessment history & about/privacy commands
  if (
    /\b(save this assessment|save assessment|save my assessment|save the assessment|save report|save to history)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'save_assessment' },
      handledByAction: true,
    };
  }

  if (
    /\b(delete saved assessments|delete assessment history|clear assessment history|delete my history|clear my history|clear history|delete history|delete all assessments)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'delete_history' },
      handledByAction: true,
    };
  }

  if (
    /\b(read saved assessments|read my history|assessment history|saved assessments|previous assessments|past assessments|read last assessment|my last assessment|history)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'read_history' },
      handledByAction: true,
    };
  }

  if (
    /\b(about glow|about this app|who does glow|privacy policy|privacy notice|privacy|how do you protect my privacy)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'open_about' },
      handledByAction: true,
    };
  }

  // 5. Analysis observation follow-up commands (check before generic repeat/simplify!)
  if (
    /\b(repeat the observations|repeat observations|repeat observation|repeat findings|what did you observe)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'repeat_observations' },
      handledByAction: true,
    };
  }

  if (
    /\b(explain that in simpler terms|explain in simpler terms|simpler terms|explain simpler|plain language|plain english)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'explain_simpler' },
      handledByAction: true,
    };
  }

  if (
    /\b(what could be causing this|what could cause this|what is causing this|possible causes|what might it indicate|what could this be)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'what_could_cause' },
      handledByAction: true,
    };
  }

  if (
    /\b(what should i do next|what do i do next|recommended next steps|next steps|what now)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'what_next' },
      handledByAction: true,
    };
  }

  const termQuestionMatch =
    /^(?:what does|what is|what's|explain|tell me what)\s+(?:the\s+(?:word|term)\s+)?([a-z\s-]{2,45}?)\s+(?:mean|means)[.?!]*$/i.exec(
      normalized
    ) ||
    /^(?:explain|what is)\s+(?:the\s+(?:word|term)\s+)?(redness|erythema|bumps?|raised bumps|scaling|flaking|swelling|blisters?|blistering|oozing|crusting|pigmentation|irregular borders?|asymmetry|inflammation|prompt review)[.?!]*$/i.exec(
      normalized
    );

  if (termQuestionMatch?.[1]) {
    return {
      reply: '',
      action: {
        type: 'explain_observation_term',
        term: termQuestionMatch[1].trim(),
        transcript: effectiveRaw,
      },
      handledByAction: true,
    };
  }

  if (
    /\b(i want to answer some questions|answer some questions|answer questions|ask me questions|symptom questions|start questions|start symptom assessment|symptom assessment|symptom check|follow-up questions|follow up questions)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'start_questions' },
      handledByAction: true,
    };
  }

  if (
    /\b(analyze|analyse|analyze photo|analyze picture|analyze image|examine photo|examine picture|examine image|check this photo|describe what you see|what do you see)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'analyze_photo' },
      handledByAction: true,
    };
  }

  // 6. Camera guidance & repeat instructions
  if (
    /\b(repeat guide|repeat instructions|repeat camera guide|positioning help|how do i hold|camera distance|closer|farther)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'repeat_camera_guide' },
      handledByAction: true,
    };
  }

  if (
    /\b(simplify|simpler|simple guide|simple instructions|shorter instructions|short guide)\b/.test(
      normalized
    )
  ) {
    if (context.hasAssessmentReport && !context.isCameraActive) {
      return {
        reply: '',
        action: { type: 'assessment_explain_simpler' },
        handledByAction: true,
      };
    }
    if (context.hasAnalysis && !context.isCameraActive) {
      return {
        reply: '',
        action: { type: 'explain_simpler' },
        handledByAction: true,
      };
    }
    return {
      reply: '',
      action: { type: 'simplify_camera_guide' },
      handledByAction: true,
    };
  }

  if (
    /\b(check lighting|check framing|check focus|check quality|is this clear|how is the lighting)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'check_camera_framing' },
      handledByAction: true,
    };
  }

  // 7. Repeat last assistant message
  if (/\b(repeat|say that again|say again|pardon|what did you say)\b/.test(normalized)) {
    return {
      reply: '',
      action: { type: 'repeat' },
    };
  }

  // 5. Camera capture lifecycle: Capture / Retake / Cancel / Close / Open
  if (/\b(retake|take another|try again|shoot again|capture again|re-take)\b/.test(normalized)) {
    return {
      reply: '',
      action: { type: 'retake_photo' },
      handledByAction: true,
    };
  }

  if (
    /\b(take picture|take a picture|take photo|take a photo|capture|snap photo|snap picture|shoot)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'capture_photo' },
      handledByAction: true,
    };
  }

  if (
    /\b(cancel camera|cancel capture|close camera|stop camera|exit camera|turn off camera|discard photo|discard image|discard picture)\b/.test(
      normalized
    )
  ) {
    return {
      reply: '',
      action: { type: 'cancel_camera' },
      handledByAction: true,
    };
  }

  if (normalized === 'cancel' || /\bcancel\b/.test(normalized)) {
    if (context.isCameraActive || context.hasCapturedPhoto) {
      return {
        reply: '',
        action: { type: 'cancel_camera' },
        handledByAction: true,
      };
    }
    return {
      reply: 'Nothing active to cancel. Say "open camera" to begin guided camera capture, or "help" for commands.',
      action: { type: 'none' },
    };
  }

  if (
    /\b(go back|exit)\b/.test(normalized) &&
    (context.isCameraActive || context.hasCapturedPhoto)
  ) {
    return {
      reply: '',
      action: { type: 'cancel_camera' },
      handledByAction: true,
    };
  }

  if (
    /\b(open camera|activate camera|start camera|turn on camera|enable camera|allow camera|use camera|scan my skin|check my skin|skin scan|skin examination|skin exam|examine my skin|start skin check|skin check|check a spot|look at my skin|check my rash|check my mole)\b/.test(
      normalized
    ) ||
    normalized === 'camera' ||
    normalized === 'scan'
  ) {
    return {
      reply: '',
      action: { type: 'activate_camera' },
      handledByAction: true,
    };
  }

  if (/\b(camera section|camera entrance|show camera)\b/.test(normalized)) {
    return {
      reply: '',
      action: { type: 'activate_camera' },
      handledByAction: true,
    };
  }

  // 6. Voice-controlled accessibility settings
  if (/\b(speak slower|slower|slow down)\b/.test(normalized)) {
    return {
      reply: 'Speech rate set to slower for clearer listening.',
      action: { type: 'set_rate_slow' },
    };
  }

  if (/\b(speak faster|faster|speed up)\b/.test(normalized)) {
    return {
      reply: 'Speech rate set to brisk.',
      action: { type: 'set_rate_fast' },
    };
  }

  if (/\b(normal speed|reset speed|standard speed)\b/.test(normalized)) {
    return {
      reply: 'Speech rate set back to normal speed.',
      action: { type: 'set_rate_normal' },
    };
  }

  if (/\b(dark mode|high contrast|dark theme)\b/.test(normalized)) {
    return {
      reply: 'Switched to deep obsidian high-contrast theme.',
      action: { type: 'enable_dark_theme' },
    };
  }

  if (/\b(light mode|lavender mode|light theme)\b/.test(normalized)) {
    return {
      reply: 'Switched to soft lavender light theme.',
      action: { type: 'enable_light_theme' },
    };
  }

  if (/\b(large text|bigger text|larger font|large print)\b/.test(normalized)) {
    return {
      reply: 'Enabled large print text sizing across the interface.',
      action: { type: 'enable_large_text' },
    };
  }

  if (/\b(open settings|settings|preferences|options)\b/.test(normalized)) {
    return {
      reply:
        'You can adjust preferences anytime by voice. Say "speak slower", "speak faster", "normal speed", "dark mode", "light mode", or "large text".',
      action: { type: 'open_settings' },
    };
  }

  if (/\b(home|assistant|main screen|go back)\b/.test(normalized)) {
    if (context.isCameraActive || context.hasCapturedPhoto) {
      return {
        reply: '',
        action: { type: 'cancel_camera' },
        handledByAction: true,
      };
    }
    return {
      reply: 'You are on the main Glow-A-Eye voice assistant. Say "open camera" or "skin examination" to begin, or say "help".',
      action: { type: 'focus_assistant' },
    };
  }

  // 7. Help & Capabilities
  if (/\b(help me|help|commands|what can you do|how does this work|guide)\b/.test(normalized)) {
    if (context.isCameraActive) {
      return {
        reply: '',
        action: { type: 'camera_help' },
        handledByAction: true,
      };
    }
    return {
      reply:
        'You can say: "Skin examination" or "Open camera", "Take picture", "Analyze photo", "Start questions" for symptom assessment, "Save this assessment", "Read saved assessments", "Delete saved assessments", "Speak slower", "Dark mode", "Stop speaking", "Stop listening", "Start again", or "End conversation". During questions, say "I don\'t know", "Skip this question", "Repeat the question", "Explain what you mean", "Go back", or "Finish assessment".',
      action: { type: 'none' },
    };
  }

  // 8. Greetings & Identity
  if (/\b(hello|hi|hey|good morning|good afternoon|good evening|who are you)\b/.test(normalized)) {
    return {
      reply:
        'Hello! I am Glow-A-Eye, built to help blind and visually impaired users capture skin photographs and hear cautious, understandable observations by voice. Say "open camera" to begin, or say "help" for voice commands.',
      action: { type: 'none' },
    };
  }

  // 9. Medical / Symptom safety guardrail (no diagnosis, no prescriptions)
  if (
    /\b(rash|mole|spot|bump|itch|itching|pain|redness|skin|lesion|acne|eczema|psoriasis|melanoma|cancer|infection|cream|ointment|medicine|medication|diagnose|diagnosis|treatment|prescribe)\b/.test(
      normalized
    )
  ) {
    return {
      reply:
        'Thank you for sharing that. Glow-A-Eye cannot diagnose skin conditions, prescribe medications, or detect or rule out cancer. If you would like, say "Open camera" to take a clear photograph for cautious visual observations, and please consult a doctor or dermatologist for medical advice.',
      action: { type: 'none' },
    };
  }

  // 10. General conversational acknowledgement
  return {
    reply: `I heard: "${rawInput.trim()}". I can guide you by voice to open the camera, capture and examine a photograph for cautious observations, adjust speech and contrast settings, or repeat any message. Say "help" anytime to hear all voice commands.`,
    action: { type: 'none' },
  };
}
