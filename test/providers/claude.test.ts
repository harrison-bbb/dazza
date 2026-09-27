import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildClaudeArgs, ClaudeProvider, parseClaudeLine } from '../../src/providers/claude.js';
import type { AgentEvent } from '../../src/providers/types.js';
import { CommandError } from '../../src/util/process.js';

const fixture = (path: string) => fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url));
const fakeClaude = new ClaudeProvider({ bin: fixture('bin/fake-claude.mjs') });

const expectedEvents: AgentEvent[] = [
  {
    type: 'started',
    sessionId: 'a8d5b882-70c9-4d36-84a8-00382f526314',
    model: 'claude-haiku-4-5-20251001',
  },
  {
    type: 'tool_use',
    id: 'toolu_016oeAo52zwhuAxEeMU74ArB',
    tool: 'Read',
    input: { file_path: '/project/note.txt' },
  },
  {
    type: 'limits',
    windows: [
      { id: 'five_hour', utilization: 0.04, resetsAt: '2026-09-27T07:40:00.000Z' },
      { id: 'seven_day', utilization: 0.07, resetsAt: '2026-10-03T00:00:00.000Z' },
    ],
  },
  { type: 'tool_result', id: 'toolu_016oeAo52zwhuAxEeMU74ArB', ok: true },
  { type: 'text', text: 'DONE' },
  {
    type: 'limits',
    windows: [
      { id: 'five_hour', utilization: 0.04, resetsAt: '2026-09-27T07:40:00.000Z' },
      { id: 'seven_day', utilization: 0.08, resetsAt: '2026-10-03T00:00:00.000Z' },
    ],
  },
  {
    type: 'finished',
    ok: true,
    output: 'DONE',
    sessionId: 'a8d5b882-70c9-4d36-84a8-00382f526314',
    durationMs: 4397,
    usage: { tokens: 18 + 212 + 39263 + 13892, costUsd: 0.0327883 },
  },
];

describe('parseClaudeLine', () => {
  it('translates a recorded session into Dazza events', () => {
    const lines = readFileSync(fixture('claude/read-file.jsonl'), 'utf8').split('\n');
    expect(lines.flatMap(parseClaudeLine)).toEqual(expectedEvents);
  });

  it('reports error results as not ok', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      session_id: 's1',
      duration_ms: 10,
    });
    expect(parseClaudeLine(line)).toEqual([
      { type: 'finished', ok: false, output: '', sessionId: 's1', durationMs: 10 },
    ]);
  });

  it('ignores malformed and unknown lines', () => {
    expect(parseClaudeLine('not json')).toEqual([]);
    expect(parseClaudeLine('{"type":"rate_limit_event"}')).toEqual([]);
    expect(parseClaudeLine('{"type":"system","subtype":"thinking_tokens"}')).toEqual([]);
  });
});

describe('buildClaudeArgs', () => {
  it('runs headless with streaming JSON output', () => {
    expect(buildClaudeArgs({ cwd: '/p' })).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
  });

  it('passes optional settings through', () => {
    const args = buildClaudeArgs({
      cwd: '/p',
      resumeSessionId: 's1',
      systemPrompt: 'Be brief.',
      model: 'haiku',
      allowedTools: ['Read', 'mcp__dazza__save_plan'],
      mcpServers: { dazza: { command: 'node', args: ['mcp'] } },
    });
    expect(args).toEqual(
      expect.arrayContaining([
        '--resume',
        's1',
        '--append-system-prompt',
        'Be brief.',
        '--model',
        'haiku',
        '--allowedTools',
        'Read,mcp__dazza__save_plan',
        '--mcp-config',
        '{"mcpServers":{"dazza":{"command":"node","args":["mcp"]}}}',
        '--strict-mcp-config',
      ]),
    );
  });
});

describe('ClaudeProvider', () => {
  const collect = async (prompt: string) => {
    const events: AgentEvent[] = [];
    for await (const event of fakeClaude.run({ prompt, cwd: process.cwd() })) events.push(event);
    return events;
  };

  it('streams events from the CLI', async () => {
    expect(await collect('Read note.txt')).toEqual(expectedEvents);
  });

  it('surfaces a crashing CLI as a CommandError with stderr', async () => {
    await expect(collect('CRASH')).rejects.toThrow(CommandError);
    await expect(collect('CRASH')).rejects.toThrow('something went wrong');
  });

  it('fails if the CLI exits without a result', async () => {
    await expect(collect('SILENT')).rejects.toThrow('without reporting a result');
  });

  it('detects version, login state and plan', async () => {
    expect(await fakeClaude.detect()).toEqual({
      installed: true,
      version: '2.1.283',
      loggedIn: true,
      authMethod: 'claude.ai',
      plan: 'Claude Max',
    });
  });

  it('lists the models the account can use, without sending a prompt', async () => {
    expect(await fakeClaude.listModels()).toEqual([
      { id: 'default', name: 'Default (recommended)', description: 'Opus 5.5', autonomous: true },
      { id: 'sonnet', name: 'Sonnet 5', description: 'Everyday tasks', autonomous: false },
    ]);
  });

  describe('billing mode', () => {
    const keyUsed = async (provider: ClaudeProvider) => {
      for await (const event of provider.run({ prompt: 'ENV', cwd: process.cwd() })) {
        if (event.type === 'finished') return event.output;
      }
    };
    const original = process.env.ANTHROPIC_API_KEY;
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = 'stray-key-from-shell';
    });
    afterEach(() => {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original;
    });

    it('never passes a stray shell API key on a subscription', async () => {
      const provider = new ClaudeProvider({
        bin: fixture('bin/fake-claude.mjs'),
        connection: { provider: 'claude', method: 'subscription' },
      });
      expect(await keyUsed(provider)).toBe('none');
    });

    it('passes the connected API key', async () => {
      const provider = new ClaudeProvider({
        bin: fixture('bin/fake-claude.mjs'),
        connection: { provider: 'claude', method: 'api-key', apiKey: 'sk-dazza' },
      });
      expect(await keyUsed(provider)).toBe('sk-dazza');
    });
  });

  it('detects a missing CLI', async () => {
    expect(await new ClaudeProvider({ bin: 'dazza-no-such-binary' }).detect()).toEqual({
      installed: false,
    });
  });
});
