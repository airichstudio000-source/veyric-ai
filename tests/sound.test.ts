import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import {
  __resetSoundStateForTesting,
  getSoundEnabled,
  installAudioUnlockListeners,
  markUserAudioInteraction,
  playClickSound,
  playResponseSound,
  playSendSound,
  playTestSound,
  setSoundEnabledPref,
} from '../src/lib/sound.ts';

interface MockOscillatorRecord {
  type: OscillatorType;
  startedAt: number | null;
  stoppedAt: number | null;
  connectedToGain: boolean;
}

class MockGainNode {
  gain = {
    value: 1,
    setValueAtTime: (_val: number, _time: number) => {},
    linearRampToValueAtTime: (_val: number, _time: number) => {},
    exponentialRampToValueAtTime: (_val: number, _time: number) => {},
  };
  connectedTo: unknown[] = [];

  connect(target: unknown): unknown {
    this.connectedTo.push(target);
    return target;
  }

  disconnect(): void {}
}

class MockOscillatorNode {
  type: OscillatorType = 'sine';
  frequency = {
    setValueAtTime: (_val: number, _time: number) => {},
    exponentialRampToValueAtTime: (_val: number, _time: number) => {},
  };
  onended: (() => void) | null = null;
  record: MockOscillatorRecord;

  constructor(record: MockOscillatorRecord) {
    this.record = record;
  }

  connect(target: unknown): unknown {
    if (target instanceof MockGainNode) {
      this.record.connectedToGain = true;
    }
    return target;
  }

  disconnect(): void {}

  start(when = 0): void {
    this.record.startedAt = when;
  }

  stop(when = 0): void {
    this.record.stoppedAt = when;
  }
}

class MockAudioBufferSourceNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = false;
  connectedToDestination = false;

  constructor(private readonly destination: unknown) {}

  connect(target: unknown): unknown {
    if (target === this.destination) {
      this.connectedToDestination = true;
    }
    return target;
  }

  disconnect(): void {}

  start(): void {
    this.started = true;
  }
}

function installMockBrowserEnv(options?: {
  initialState?: AudioContextState;
  resumeRejects?: boolean;
  throwOnCreate?: boolean;
}) {
  const storage = new Map<string, string>();
  const listeners = new Map<string, Set<EventListener>>();
  const createdContexts: Array<{
    state: AudioContextState;
    currentTime: number;
    resumeCalls: number;
    destination: { kind: string };
    gainNodes: MockGainNode[];
    oscillators: MockOscillatorRecord[];
    bufferSources: MockAudioBufferSourceNode[];
  }> = [];

  class MockAudioContext {
    state: AudioContextState;
    currentTime = 0;
    sampleRate = 48000;
    destination = { kind: 'destination' };
    resumeCalls = 0;
    gainNodes: MockGainNode[] = [];
    oscillators: MockOscillatorRecord[] = [];
    bufferSources: MockAudioBufferSourceNode[] = [];

    constructor() {
      if (options?.throwOnCreate) {
        throw new Error('AudioContext blocked');
      }
      this.state = options?.initialState ?? 'suspended';
      createdContexts.push(this);
    }

    createGain(): MockGainNode {
      const node = new MockGainNode();
      this.gainNodes.push(node);
      return node;
    }

    createOscillator(): MockOscillatorNode {
      const record: MockOscillatorRecord = {
        type: 'sine',
        startedAt: null,
        stoppedAt: null,
        connectedToGain: false,
      };
      this.oscillators.push(record);
      return new MockOscillatorNode(record);
    }

    createBuffer(_channels: number, _length: number, _rate: number) {
      return { silent: true };
    }

    createBufferSource(): MockAudioBufferSourceNode {
      const node = new MockAudioBufferSourceNode(this.destination);
      this.bufferSources.push(node);
      return node;
    }

    async resume(): Promise<void> {
      this.resumeCalls += 1;
      if (options?.resumeRejects) {
        throw new Error('NotAllowedError');
      }
      await Promise.resolve();
      this.state = 'running';
      this.currentTime = 1.25;
    }
  }

  const mockWindow = {
    AudioContext: MockAudioContext,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, val: string) => {
        storage.set(key, val);
      },
    },
    addEventListener: (type: string, fn: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: EventListener) => {
      listeners.get(type)?.delete(fn);
    },
    dispatch: (type: string) => {
      for (const fn of listeners.get(type) ?? []) {
        fn(new Event(type));
      }
    },
  };

  (globalThis as Record<string, unknown>).window = mockWindow;

  return { mockWindow, storage, createdContexts };
}

beforeEach(() => {
  __resetSoundStateForTesting();
});

afterEach(() => {
  __resetSoundStateForTesting();
  delete (globalThis as Record<string, unknown>).window;
});

test('sound preference defaults to true and persists in localStorage', () => {
  const { storage } = installMockBrowserEnv();

  assert.equal(getSoundEnabled(), true);
  setSoundEnabledPref(false);
  assert.equal(storage.get('veyric_ai_sound_enabled'), 'false');
  assert.equal(getSoundEnabled(), false);

  setSoundEnabledPref(true);
  assert.equal(storage.get('veyric_ai_sound_enabled'), 'true');
  assert.equal(getSoundEnabled(), true);
});

test('does not autoplay response sound before user interaction', () => {
  const { createdContexts } = installMockBrowserEnv({ initialState: 'running' });

  playResponseSound();
  assert.equal(createdContexts.length, 0);
});

test('waits for suspended AudioContext resume before scheduling click sound on Android', async () => {
  const { createdContexts } = installMockBrowserEnv({ initialState: 'suspended' });

  playClickSound();
  assert.equal(createdContexts.length, 1);
  const ctx = createdContexts[0];
  assert.equal(ctx.resumeCalls, 1);
  // Silent hardware unlock buffer is primed immediately during user gesture
  assert.equal(ctx.bufferSources.length, 1);
  assert.equal(ctx.bufferSources[0].started, true);
  assert.equal(ctx.bufferSources[0].connectedToDestination, true);

  // Oscillator must NOT be scheduled synchronously while suspended at t=0
  assert.equal(ctx.oscillators.length, 0);

  // Wait for resume() promise microtasks to flush
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(ctx.state, 'running');
  assert.equal(ctx.oscillators.length, 1);
  assert.equal(ctx.oscillators[0].connectedToGain, true);
  assert.ok((ctx.oscillators[0].startedAt ?? 0) > 1.25);
  assert.ok((ctx.oscillators[0].stoppedAt ?? 0) > (ctx.oscillators[0].startedAt ?? 0));

  // Master gain connects cleanly to destination
  assert.equal(ctx.gainNodes[0].connectedTo.includes(ctx.destination), true);
  assert.equal(ctx.gainNodes[1].connectedTo.includes(ctx.gainNodes[0]), true);
});

test('send, response completion, and user-triggered test sounds play cleanly after gesture unlock', async () => {
  const { createdContexts } = installMockBrowserEnv({ initialState: 'suspended' });

  const cleanup = installAudioUnlockListeners();
  markUserAudioInteraction();
  await new Promise((r) => setTimeout(r, 10));

  const ctx = createdContexts[0];
  assert.equal(ctx.state, 'running');

  playSendSound();
  assert.equal(ctx.oscillators.length, 2);

  playResponseSound();
  assert.equal(ctx.oscillators.length, 4);

  playTestSound();
  assert.equal(ctx.oscillators.length, 6);

  cleanup();
});

test('Sound Off toggle prevents click, send, response, and test sounds', async () => {
  const { createdContexts } = installMockBrowserEnv({ initialState: 'running' });
  markUserAudioInteraction();
  await new Promise((r) => setTimeout(r, 5));

  setSoundEnabledPref(false);
  playClickSound();
  playSendSound();
  playResponseSound();
  playTestSound();

  assert.equal(createdContexts[0].oscillators.length, 0);

  // Also verify no AudioContext is even created when starting muted
  __resetSoundStateForTesting();
  const mutedEnv = installMockBrowserEnv({ initialState: 'running' });
  setSoundEnabledPref(false);
  markUserAudioInteraction();
  playClickSound();
  playSendSound();
  playResponseSound();
  playTestSound();

  assert.equal(mutedEnv.createdContexts.length, 0);
});

test('handles AudioContext errors and rejected resume promises without throwing', async () => {
  installMockBrowserEnv({ throwOnCreate: true });
  assert.doesNotThrow(() => {
    playClickSound();
    playSendSound();
    playResponseSound();
    playTestSound();
  });

  __resetSoundStateForTesting();
  installMockBrowserEnv({ initialState: 'suspended', resumeRejects: true });
  assert.doesNotThrow(() => {
    playClickSound();
    playSendSound();
    playTestSound();
  });
  await new Promise((r) => setTimeout(r, 10));
});
