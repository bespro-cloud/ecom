import { describe, expect, it, vi } from 'vitest';
import { ConsoleEmailProvider, ConsoleSmsProvider } from './console-provider.js';

describe('ConsoleEmailProvider', () => {
  it('writes the message to the sink instead of sending it', async () => {
    const sink = vi.fn();
    const provider = new ConsoleEmailProvider(sink);

    const result = await provider.send({
      to: { email: 'ada@example.test' },
      subject: 'Hello',
      text: 'Body text',
      idempotencyKey: 'key-1',
    });

    expect(sink).toHaveBeenCalledOnce();
    const output = sink.mock.calls[0]![0] as string;
    expect(output).toContain('ada@example.test');
    expect(output).toContain('Body text');
    expect(output).toContain('not sent');
    expect(result.provider).toBe('console');
    expect(result.providerMessageId).toBeNull();
  });
});

describe('ConsoleSmsProvider', () => {
  it('writes the message to the sink', async () => {
    const sink = vi.fn();
    await new ConsoleSmsProvider(sink).send({ to: '+12125550123', body: 'Hi' });
    expect(sink.mock.calls[0]![0]).toContain('+12125550123');
  });
});
