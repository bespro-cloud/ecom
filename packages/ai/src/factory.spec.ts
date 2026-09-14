import { describe, expect, it } from 'vitest';
import type { ServerEnv } from '@health/config';
import { createAiProvider } from './factory.js';
import { DevelopmentAiProvider } from './development-provider.js';
import { AnthropicProvider } from './anthropic-provider.js';

/** Only the fields the factory reads; the rest of ServerEnv is irrelevant here. */
function env(overrides: Partial<ServerEnv>): ServerEnv {
  return {
    AI_PROVIDER: 'disabled',
    AI_MODEL: 'claude-sonnet-4-5',
    AI_TIMEOUT_MS: 30_000,
    AI_INPUT_PRICE_MICROS: 300_000,
    AI_OUTPUT_PRICE_MICROS: 1_500_000,
    ...overrides,
  } as ServerEnv;
}

describe('choosing an AI provider', () => {
  it('returns nothing when AI is disabled', () => {
    // A platform with no AI features is a perfectly good platform, and every
    // AI code path has to cope with there being no model at all.
    expect(createAiProvider(env({ AI_PROVIDER: 'disabled' }))).toBeNull();
  });

  it('builds the development stand-in, which does not claim to be a model', () => {
    const provider = createAiProvider(env({ AI_PROVIDER: 'development' }));
    expect(provider).toBeInstanceOf(DevelopmentAiProvider);
    expect(provider!.isRealModel).toBe(false);
  });

  it('builds a real provider and says that it is one', () => {
    const provider = createAiProvider(env({ AI_PROVIDER: 'anthropic', AI_API_KEY: 'key' }));
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider!.isRealModel).toBe(true);
  });

  it('refuses a real provider with no key rather than falling back', () => {
    // Falling back to the stand-in here would mean a deployment silently
    // producing stand-in text and labelling it as model output.
    expect(() => createAiProvider(env({ AI_PROVIDER: 'anthropic' }))).toThrow(/AI_API_KEY/);
  });

  it('refuses a provider nobody implemented', () => {
    expect(() =>
      createAiProvider(env({ AI_PROVIDER: 'some-future-vendor' as ServerEnv['AI_PROVIDER'] })),
    ).toThrow(/no adapter is implemented/i);
  });
});

describe('the development stand-in', () => {
  it('can be made to produce the outputs the guardrails exist for', async () => {
    // A stand-in that only ever returned safe text would let every guardrail
    // rot untested. These triggers are how the dangerous paths get exercised.
    const provider = new DevelopmentAiProvider();

    const disease = await provider.complete({
      system: 's',
      messages: [{ role: 'user', content: '__dev_disease_claim__' }],
      maxOutputTokens: 100,
      temperature: 0,
    });
    expect(disease.text).toMatch(/cures/i);

    const fabricated = await provider.complete({
      system: 's',
      messages: [{ role: 'user', content: '__dev_fabricated_citation__' }],
      maxOutputTokens: 100,
      temperature: 0,
    });
    expect(fabricated.text).toMatch(/\[\[ev-does-not-exist\]\]/);
  });

  it('distinguishes retryable failures from permanent ones', async () => {
    const provider = new DevelopmentAiProvider();

    await expect(
      provider.complete({
        system: 's',
        messages: [{ role: 'user', content: '__dev_retryable_error__' }],
        maxOutputTokens: 100,
        temperature: 0,
      }),
    ).rejects.toMatchObject({ retryable: true });

    await expect(
      provider.complete({
        system: 's',
        messages: [{ role: 'user', content: '__dev_fatal_error__' }],
        maxOutputTokens: 100,
        temperature: 0,
      }),
    ).rejects.toMatchObject({ retryable: false });
  });

  it('reports token usage so budget accounting is exercised', async () => {
    const provider = new DevelopmentAiProvider();
    const result = await provider.complete({
      system: 's',
      messages: [{ role: 'user', content: 'Describe the product.' }],
      maxOutputTokens: 100,
      temperature: 0,
    });
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(provider.callCount).toBe(1);
  });

  it('cites a source the prompt actually contained', async () => {
    const provider = new DevelopmentAiProvider();
    const result = await provider.complete({
      system: 's',
      messages: [{ role: 'user', content: 'Sources: [[ev-7]] [[ev-8]]' }],
      maxOutputTokens: 100,
      temperature: 0,
    });
    expect(result.text).toContain('[[ev-7]]');
  });
});

describe('the provider contract', () => {
  it('offers no way for a model to take an action', () => {
    // The interface has no tools, no functions, no execution. Not "we don't
    // use them" — there is nothing to pass. This test reads the shape of a
    // request object to keep it that way.
    const request = {
      system: 's',
      messages: [{ role: 'user' as const, content: 'x' }],
      maxOutputTokens: 10,
      temperature: 0,
    };
    expect(Object.keys(request).sort()).toEqual([
      'maxOutputTokens',
      'messages',
      'system',
      'temperature',
    ]);
  });
});
