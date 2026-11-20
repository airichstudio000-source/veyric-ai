const SOUND_PREF_KEY = 'veyric_ai_sound_enabled';

type BrowserWindowWithWebkitAudio = Window & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};

let audioCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let bufferPrimedCtx: AudioContext | null = null;
let pendingResumePromise: Promise<void> | null = null;
let userHasInteracted = false;
let unlockListenersInstalled = false;

export function getSoundEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const stored = window.localStorage.getItem(SOUND_PREF_KEY);
    if (stored === 'false') return false;
    if (stored === 'true') return true;
    return true;
  } catch {
    return true;
  }
}

export function setSoundEnabledPref(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SOUND_PREF_KEY, enabled ? 'true' : 'false');
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const win = window as BrowserWindowWithWebkitAudio;
  return win.AudioContext || win.webkitAudioContext || null;
}

function ensureAudioContext(): { ctx: AudioContext; dest: AudioNode } | null {
  const AudioCtx = getAudioContextConstructor();
  if (!AudioCtx) return null;

  if (audioCtx && audioCtx.state === 'closed') {
    audioCtx = null;
    masterGain = null;
    bufferPrimedCtx = null;
    pendingResumePromise = null;
  }

  if (!audioCtx) {
    try {
      audioCtx = new AudioCtx();
    } catch {
      return null;
    }
  }

  if (!masterGain) {
    try {
      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0.9, audioCtx.currentTime);
      gain.connect(audioCtx.destination);
      masterGain = gain;
    } catch {
      return { ctx: audioCtx, dest: audioCtx.destination };
    }
  }

  return { ctx: audioCtx, dest: masterGain };
}

/**
 * Prime mobile hardware audio output (Android Chrome / iOS WebKit) by routing
 * a silent 1-sample buffer to destination during a valid user activation.
 */
function primeAudioOutput(ctx: AudioContext): void {
  if (bufferPrimedCtx === ctx) return;
  try {
    if (typeof ctx.createBuffer !== 'function' || typeof ctx.createBufferSource !== 'function') {
      bufferPrimedCtx = ctx;
      return;
    }
    const sampleRate = ctx.sampleRate && ctx.sampleRate > 0 ? ctx.sampleRate : 22050;
    const silentBuffer = ctx.createBuffer(1, 1, sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = silentBuffer;
    source.connect(ctx.destination);
    source.onended = () => {
      try {
        source.disconnect();
      } catch {
        // Ignore cleanup errors
      }
    };
    source.start(0);
    bufferPrimedCtx = ctx;
  } catch {
    // Ignore priming failures
  }
}

function resumeAudioContext(ctx: AudioContext): Promise<void> {
  if (ctx.state === 'running') {
    return Promise.resolve();
  }
  if (pendingResumePromise) {
    return pendingResumePromise;
  }
  try {
    const resumeResult = ctx.resume();
    pendingResumePromise = Promise.resolve(resumeResult)
      .catch(() => {})
      .finally(() => {
        pendingResumePromise = null;
      });
    return pendingResumePromise;
  } catch {
    pendingResumePromise = null;
    return Promise.resolve();
  }
}

export function markUserAudioInteraction(): void {
  userHasInteracted = true;
  if (!getSoundEnabled()) return;

  const nodes = ensureAudioContext();
  if (!nodes) return;

  primeAudioOutput(nodes.ctx);
  if (nodes.ctx.state !== 'running') {
    void resumeAudioContext(nodes.ctx);
  }
}

/**
 * Attach capture-phase listeners for Chrome-valid user activation events
 * (`pointerup`, `touchend`, `click`, `keydown`) so Android Chrome unlocks Web Audio
 * as soon as the user interacts with the page, without ever autoplaying sound.
 */
export function installAudioUnlockListeners(): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }
  if (unlockListenersInstalled) {
    return () => {};
  }

  const onUserGesture = () => {
    markUserAudioInteraction();
  };

  const events = ['pointerup', 'touchend', 'click', 'keydown'] as const;
  const options: AddEventListenerOptions = { capture: true, passive: true };

  for (const evt of events) {
    window.addEventListener(evt, onUserGesture, options);
  }
  unlockListenersInstalled = true;

  return () => {
    for (const evt of events) {
      window.removeEventListener(evt, onUserGesture, options);
    }
    unlockListenersInstalled = false;
  };
}

function withReadyAudioContext(
  requireDirectGesture: boolean,
  schedule: (ctx: AudioContext, dest: AudioNode) => void
): void {
  if (!getSoundEnabled()) return;

  if (requireDirectGesture) {
    markUserAudioInteraction();
  } else if (!userHasInteracted) {
    return;
  }

  const nodes = ensureAudioContext();
  if (!nodes) return;

  const { ctx, dest } = nodes;

  if (ctx.state === 'running') {
    try {
      schedule(ctx, dest);
    } catch {
      // Audio playback failure should never interrupt UI
    }
    return;
  }

  // On Android Chrome, schedule tones ONLY after AudioContext.resume() resolves
  // and `ctx.state` transitions to `'running'` so `ctx.currentTime` is live.
  void resumeAudioContext(ctx).then(() => {
    if (!getSoundEnabled() || ctx.state !== 'running') return;
    try {
      schedule(ctx, dest);
    } catch {
      // Audio playback failure should never interrupt UI
    }
  });
}

interface ToneOptions {
  type: OscillatorType;
  startFreq: number;
  endFreq?: number;
  delay?: number;
  duration: number;
  peakGain: number;
}

function playTone(ctx: AudioContext, dest: AudioNode, opts: ToneOptions): void {
  const delay = opts.delay ?? 0;
  // Small lookahead prevents Chrome Blink from clipping automation at t=0
  const startTime = ctx.currentTime + 0.008 + delay;
  const stopTime = startTime + opts.duration;
  const attackTime = startTime + Math.min(0.012, opts.duration * 0.25);

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = opts.type;
  osc.frequency.setValueAtTime(opts.startFreq, startTime);
  if (typeof opts.endFreq === 'number' && opts.endFreq > 0) {
    osc.frequency.exponentialRampToValueAtTime(
      opts.endFreq,
      startTime + Math.max(0.015, opts.duration * 0.72)
    );
  }

  gain.gain.setValueAtTime(0.0008, startTime);
  gain.gain.linearRampToValueAtTime(opts.peakGain, attackTime);
  gain.gain.exponentialRampToValueAtTime(0.0008, stopTime);

  osc.connect(gain);
  gain.connect(dest);

  osc.onended = () => {
    try {
      osc.disconnect();
      gain.disconnect();
    } catch {
      // Ignore disconnect errors
    }
  };

  osc.start(startTime);
  osc.stop(stopTime + 0.008);
}

/** Soft water-glass tap / pop for UI buttons and controls */
export function playClickSound(): void {
  withReadyAudioContext(true, (ctx, dest) => {
    playTone(ctx, dest, {
      type: 'sine',
      startFreq: 620,
      endFreq: 940,
      duration: 0.075,
      peakGain: 0.20,
    });
  });
}

/** Crisp ascending glass-pop confirmation for sending a message */
export function playSendSound(): void {
  withReadyAudioContext(true, (ctx, dest) => {
    playTone(ctx, dest, {
      type: 'sine',
      startFreq: 523.25,
      endFreq: 783.99,
      delay: 0,
      duration: 0.085,
      peakGain: 0.22,
    });
    playTone(ctx, dest, {
      type: 'triangle',
      startFreq: 880,
      endFreq: 1174.66,
      delay: 0.04,
      duration: 0.11,
      peakGain: 0.16,
    });
  });
}

/** Gentle crystalline chime when an AI response completes (only after user interaction) */
export function playResponseSound(): void {
  withReadyAudioContext(false, (ctx, dest) => {
    playTone(ctx, dest, {
      type: 'sine',
      startFreq: 659.25,
      delay: 0,
      duration: 0.24,
      peakGain: 0.20,
    });
    playTone(ctx, dest, {
      type: 'sine',
      startFreq: 987.77,
      delay: 0.065,
      duration: 0.30,
      peakGain: 0.18,
    });
  });
}

/** User-triggered sound preview to verify playback on mobile & desktop devices */
export function playTestSound(): void {
  withReadyAudioContext(true, (ctx, dest) => {
    playTone(ctx, dest, {
      type: 'sine',
      startFreq: 587.33,
      delay: 0,
      duration: 0.14,
      peakGain: 0.22,
    });
    playTone(ctx, dest, {
      type: 'sine',
      startFreq: 880,
      delay: 0.07,
      duration: 0.24,
      peakGain: 0.20,
    });
  });
}

export function __resetSoundStateForTesting(): void {
  audioCtx = null;
  masterGain = null;
  bufferPrimedCtx = null;
  pendingResumePromise = null;
  userHasInteracted = false;
  unlockListenersInstalled = false;
}
