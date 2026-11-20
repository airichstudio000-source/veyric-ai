import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ThinkingLevel } from '@google/genai';
import type { GoogleGenAI } from '@google/genai';
import {
  ALLOWED_GEMINI_MODELS,
  DEFAULT_GEMINI_MODEL,
  isAllowedGeminiModel,
  parseGeminiModel,
  protectionConfig,
  resolveProtectionConfig,
} from '../server/config.ts';
import {
  decideThinkingLevel,
  generateFollowUpSuggestions,
  resolveConfiguredGeminiModel,
  streamGeminiChat,
  supportsMinimalThinking,
} from '../server/gemini.ts';

test('GEMINI_MODEL defaults safely to gemini-4-hydrogen with no warnings', () => {
  const { config, warnings } = resolveProtectionConfig({});
  assert.equal(config.gemini.model, DEFAULT_GEMINI_MODEL);
  assert.equal(config.gemini.model, 'gemini-4-hydrogen');
  assert.equal(warnings.length, 0);
  assert.equal(Object.isFrozen(protectionConfig.gemini), true);
});

test('GEMINI_MODEL accepts allowed models and trims whitespace', () => {
  assert.equal(ALLOWED_GEMINI_MODELS.has('gemini-3.1-flash-lite'), true);
  assert.equal(ALLOWED_GEMINI_MODELS.has('gemini-4-hydrogen'), true);
  assert.equal(ALLOWED_GEMINI_MODELS.size, 2);

  const lite = resolveProtectionConfig({ GEMINI_MODEL: '  gemini-3.1-flash-lite  ' });
  assert.equal(lite.config.gemini.model, 'gemini-3.1-flash-lite');
  assert.equal(lite.warnings.length, 0);

  const rollback = resolveProtectionConfig({ GEMINI_MODEL: 'gemini-4-hydrogen' });
  assert.equal(rollback.config.gemini.model, 'gemini-4-hydrogen');
  assert.equal(rollback.warnings.length, 0);

  const blank = resolveProtectionConfig({ GEMINI_MODEL: '   ' });
  assert.equal(blank.config.gemini.model, DEFAULT_GEMINI_MODEL);
  assert.equal(blank.warnings.length, 0);
});

test('GEMINI_MODEL strict allowlist rejects unapproved or malformed values', () => {
  const invalidValues = [
    'gemini-4-carbon',
    'gemini-4-neon',
    'gemini-1.5-flash',
    'gemini-2.0-flash',
    'gemini-embedding-2',
    'models/gemini-3.1-flash-lite',
    'GEMINI-3.1-FLASH-LITE',
    'gemini-3.1-flash-lite-preview',
    '../gemini-3.1-flash-lite',
  ];

  for (const raw of invalidValues) {
    assert.equal(isAllowedGeminiModel(raw), false);
    const { config, warnings } = resolveProtectionConfig({ GEMINI_MODEL: raw });
    assert.equal(config.gemini.model, DEFAULT_GEMINI_MODEL);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].variable, 'GEMINI_MODEL');
    assert.equal(warnings[0].fallbackValue, DEFAULT_GEMINI_MODEL);
    assert.equal(parseGeminiModel(raw), DEFAULT_GEMINI_MODEL);
  }
});

test('ThinkingLevel selection uses MINIMAL for simple gemini-3.1-flash-lite and LOW for simple gemini-4-hydrogen', () => {
  assert.equal(supportsMinimalThinking('gemini-3.1-flash-lite'), true);
  assert.equal(supportsMinimalThinking('gemini-4-hydrogen'), false);

  const simplePrompts = ['', 'Hello', 'မင်္ဂလာပါ VEYRIC AI', 'What is 2 + 2?'];

  for (const message of simplePrompts) {
    assert.equal(
      decideThinkingLevel({
        model: 'gemini-3.1-flash-lite',
        message,
        hasFiles: false,
        shouldSearch: false,
      }),
      ThinkingLevel.MINIMAL
    );

    assert.equal(
      decideThinkingLevel({
        model: 'gemini-4-hydrogen',
        message,
        hasFiles: false,
        shouldSearch: false,
      }),
      ThinkingLevel.LOW
    );
  }
});

test('ThinkingLevel selection uses MEDIUM for complex, file, or search requests across both models', () => {
  const complexPrompts = [
    'Please debug this TypeScript exception in my Express route.',
    'Line one\nLine two',
    'a'.repeat(220),
  ];

  for (const model of ['gemini-3.1-flash-lite', 'gemini-4-hydrogen'] as const) {
    assert.equal(
      decideThinkingLevel({ model, message: 'Hello', hasFiles: true, shouldSearch: false }),
      ThinkingLevel.MEDIUM
    );
    assert.equal(
      decideThinkingLevel({ model, message: 'Hello', hasFiles: false, shouldSearch: true }),
      ThinkingLevel.MEDIUM
    );
    for (const message of complexPrompts) {
      assert.equal(
        decideThinkingLevel({ model, message, hasFiles: false, shouldSearch: false }),
        ThinkingLevel.MEDIUM
      );
    }
  }
});

test('resolveConfiguredGeminiModel defensively falls back when given an unlisted model', () => {
  assert.equal(resolveConfiguredGeminiModel('gemini-3.1-flash-lite'), 'gemini-3.1-flash-lite');
  assert.equal(resolveConfiguredGeminiModel('gemini-4-hydrogen'), 'gemini-4-hydrogen');
  assert.equal(resolveConfiguredGeminiModel('gemini-4-carbon'), protectionConfig.gemini.model);
  assert.equal(resolveConfiguredGeminiModel(undefined), protectionConfig.gemini.model);
});

test('streamGeminiChat and generateFollowUpSuggestions pass configured model and model-aware ThinkingLevel', async () => {
  const capturedStreamCalls: Array<{ model: string; thinkingLevel?: ThinkingLevel }> = [];
  const capturedFollowupCalls: Array<{ model: string; thinkingLevel?: ThinkingLevel }> = [];

  const mockClient = {
    models: {
      generateContentStream: async (req: {
        model: string;
        config?: { thinkingConfig?: { thinkingLevel?: ThinkingLevel } };
      }) => {
        capturedStreamCalls.push({
          model: req.model,
          thinkingLevel: req.config?.thinkingConfig?.thinkingLevel,
        });
        async function* gen() {
          yield { text: 'Hello from mock' };
        }
        return gen();
      },
      generateContent: async (req: {
        model: string;
        config?: { thinkingConfig?: { thinkingLevel?: ThinkingLevel } };
      }) => {
        capturedFollowupCalls.push({
          model: req.model,
          thinkingLevel: req.config?.thinkingConfig?.thinkingLevel,
        });
        return {
          text: JSON.stringify({ suggestions: ['Explain more', 'Give an example'] }),
        };
      },
    },
    files: {
      delete: async () => {},
    },
  } as unknown as GoogleGenAI;

  let streamed = '';
  await streamGeminiChat({
    history: [],
    message: 'Hi',
    webSearch: false,
    files: [],
    onStatus: () => {},
    onDelta: (delta) => {
      streamed += delta;
    },
    client: mockClient,
    model: 'gemini-3.1-flash-lite',
  });
  assert.equal(streamed, 'Hello from mock');

  await streamGeminiChat({
    history: [],
    message: 'Hi',
    webSearch: false,
    files: [],
    onStatus: () => {},
    onDelta: () => {},
    client: mockClient,
    model: 'gemini-4-hydrogen',
  });

  await streamGeminiChat({
    history: [],
    message: 'Debug this API error',
    webSearch: false,
    files: [],
    onStatus: () => {},
    onDelta: () => {},
    client: mockClient,
    model: 'gemini-3.1-flash-lite',
  });

  assert.deepEqual(capturedStreamCalls, [
    { model: 'gemini-3.1-flash-lite', thinkingLevel: ThinkingLevel.MINIMAL },
    { model: 'gemini-4-hydrogen', thinkingLevel: ThinkingLevel.LOW },
    { model: 'gemini-3.1-flash-lite', thinkingLevel: ThinkingLevel.MEDIUM },
  ]);

  const longAssistant = 'Detailed explanation '.repeat(8);
  const liteFollowups = await generateFollowUpSuggestions({
    userMessage: 'Explain cloud computing',
    assistantMessage: longAssistant,
    client: mockClient,
    model: 'gemini-3.1-flash-lite',
  });
  const hydrogenFollowups = await generateFollowUpSuggestions({
    userMessage: 'Explain cloud computing',
    assistantMessage: longAssistant,
    client: mockClient,
    model: 'gemini-4-hydrogen',
  });

  assert.deepEqual(liteFollowups, ['Explain more', 'Give an example']);
  assert.deepEqual(hydrogenFollowups, ['Explain more', 'Give an example']);
  assert.deepEqual(capturedFollowupCalls, [
    { model: 'gemini-3.1-flash-lite', thinkingLevel: ThinkingLevel.MINIMAL },
    { model: 'gemini-4-hydrogen', thinkingLevel: ThinkingLevel.LOW },
  ]);
});

test('Auto follow-up suggestions remain disabled in client UI', async () => {
  const appSource = await fs.readFile(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');
  assert.match(appSource, /const\s+AUTO_FOLLOWUP_SUGGESTIONS_ENABLED\s*=\s*false\s*;/);
});
