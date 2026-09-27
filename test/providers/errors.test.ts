import { describe, expect, it } from 'vitest';
import { parseClaudeLine } from '../../src/providers/claude.js';
import { classifyError } from '../../src/providers/errors.js';

describe('classifyError', () => {
  it('recognises Claude Code’s own messages', () => {
    expect(classifyError('Claude AI usage limit reached|1790494800').kind).toBe('usage_limit');
    expect(classifyError('You have reached your weekly usage limit').kind).toBe('usage_limit');
    expect(classifyError('Credit balance is too low').kind).toBe('credits');
    expect(classifyError('usage credit limit reached').kind).toBe('credits');
    expect(classifyError('API Error: 401 Invalid API key · Please run /login').kind).toBe('auth');
    expect(classifyError('API Error: 529 Overloaded').kind).toBe('overloaded');
  });

  it('prefers the status code when there is one', () => {
    expect(classifyError('Too many requests', 429).kind).toBe('usage_limit');
    expect(classifyError('Something', 401).kind).toBe('auth');
    expect(classifyError('Something', 500).kind).toBe('overloaded');
  });

  it('does not mistake other limits for usage limits', () => {
    expect(classifyError('Context limit reached').kind).toBe('failed');
    expect(classifyError('Budget limit reached ($5)').kind).toBe('failed');
  });

  it('carries the reset time for usage limits', () => {
    expect(classifyError('usage limit reached', null, '2026-09-27T17:40:00.000Z')).toMatchObject({
      resetsAt: '2026-09-27T17:40:00.000Z',
    });
  });
});

describe('parsing failures from the stream', () => {
  const line = (value: object) => JSON.stringify(value);

  it('marks a refused rate-limit reading with when it lifts', () => {
    const [event] = parseClaudeLine(
      line({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1790494800 },
      }),
    );
    expect(event).toMatchObject({
      type: 'limits',
      windows: [],
      limitedUntil: '2026-09-27T07:40:00.000Z',
    });
  });

  it('attaches a classified error to a failed result', () => {
    const [event] = parseClaudeLine(
      line({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Credit balance is too low',
        session_id: 's',
        duration_ms: 1,
        api_error_status: 400,
      }),
    );
    expect(event).toMatchObject({ type: 'finished', ok: false, error: { kind: 'credits' } });
  });

  it('leaves successful results alone', () => {
    const [event] = parseClaudeLine(
      line({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        session_id: 's',
        duration_ms: 1,
      }),
    );
    expect(event).not.toHaveProperty('error');
  });
});
