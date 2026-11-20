const SOUND_PREF_KEY = 'veyric_ai_sound_enabled';

let audioCtx: AudioContext | null = null;
let userHasInteracted = false;

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

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtx =
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;

  if (!audioCtx) {
    try {
      audioCtx = new AudioCtx();
    } catch {
      return null;
    }
  }
  return audioCtx;
}

export function markUserAudioInteraction(): void {
  userHasInteracted = true;
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume().catch(() => {});
  }
}

function canPlaySound(requireDirectGesture: boolean): AudioContext | null {
  if (!getSoundEnabled()) return null;
  if (requireDirectGesture) {
    markUserAudioInteraction();
  } else if (!userHasInteracted) {
    return null;
  }

  const ctx = getAudioContext();
  if (!ctx) return null;
  if (ctx.state === 'suspended') {
    if (!requireDirectGesture) return null;
    void ctx.resume().catch(() => {});
  }
  return ctx;
}

/** Soft water-glass tap / pop for UI buttons and controls */
export function playClickSound(): void {
  const ctx = canPlaySound(true);
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(560, now);
    osc.frequency.exponentialRampToValueAtTime(780, now + 0.036);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.045, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.052);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.055);
  } catch {
    // Audio playback failure should never interrupt UI
  }
}

/** Crisp ascending glass-pop confirmation for sending a message */
export function playSendSound(): void {
  const ctx = canPlaySound(true);
  if (!ctx) return;

  try {
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(460, now);
    osc1.frequency.exponentialRampToValueAtTime(690, now + 0.055);

    gain1.gain.setValueAtTime(0.0001, now);
    gain1.gain.linearRampToValueAtTime(0.055, now + 0.008);
    gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);

    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.08);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(760, now + 0.035);
    osc2.frequency.exponentialRampToValueAtTime(1020, now + 0.095);

    gain2.gain.setValueAtTime(0.0001, now + 0.035);
    gain2.gain.linearRampToValueAtTime(0.038, now + 0.046);
    gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.035);
    osc2.stop(now + 0.125);
  } catch {
    // Audio playback failure should never interrupt UI
  }
}

/** Gentle crystalline chime when an AI response completes (only after user interaction) */
export function playResponseSound(): void {
  const ctx = canPlaySound(false);
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const notes = [
      { freq: 659.25, delay: 0, peak: 0.042, duration: 0.22 },
      { freq: 987.77, delay: 0.055, peak: 0.036, duration: 0.28 },
    ];

    for (const note of notes) {
      const start = now + note.delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(note.freq, start);

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(note.peak, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.duration);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + note.duration + 0.01);
    }
  } catch {
    // Audio playback failure should never interrupt UI
  }
}
