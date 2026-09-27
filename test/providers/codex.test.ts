import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildCodexArgs, CodexProvider, CodexStream } from '../../src/providers/codex.js';
import type { AgentEvent } from '../../src/providers/types.js';

const fixture = (path: string) => fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url));
const codex = new CodexProvider({ bin: fixture('bin/fake-codex.mjs') });
const parse = (file: string) => {
  const stream = new CodexStream('gpt-6-astra');
  return {
    stream,
    events: readFileSync(fixture(`codex/${file}`), 'utf8')
      .split('\n')
      .flatMap((l) => stream.parse(l)),
  };
};

describe('CodexStream', () => {
  it('maps a build turn onto the same events Claude produces', () => {
    const { events } = parse('build-turn.jsonl');
    expect(events.map((e) => (e.type === 'tool_use' ? `tool_use:${e.tool}` : e.type))).toEqual([
      'started',
      'text',
      'tool_use:Bash',
      'tool_result',
      'tool_use:Write',
      'tool_use:Edit',
      'tool_use:mcp__dazza__update_subtask',
      'tool_result',
      'text',
      'finished',
    ]);
    expect(events[0]).toEqual({
      type: 'started',
      sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53',
      model: 'gpt-6-astra',
    });
    expect(events[4]).toMatchObject({ input: { file_path: '/project/greet.js' } });
    expect(events[6]).toMatchObject({ input: { id: 'T1.1', status: 'closed' } });
    expect(events.at(-1)).toMatchObject({ type: 'finished', ok: true, usage: { tokens: 2750 } });
  });

  it('reads the real stream from a rejected sign-in: retries, then a classified failure', () => {
    const { events } = parse('unauthorized.jsonl');
    expect(events[1]).toMatchObject({ type: 'retry', attempt: 2, maxRetries: 5 });
    expect(events.at(-1)).toMatchObject({ type: 'finished', ok: false, error: { kind: 'auth' } });
  });
});

describe('buildCodexArgs', () => {
  it('builds read-only for conversation, with instructions and Dazza’s tools pre-approved', () => {
    const args = buildCodexArgs({
      cwd: '/p',
      systemPrompt: 'Be "Dazza".',
      mcpServers: { dazza: { command: '/usr/bin/node', args: ['cli.js', 'mcp'] } },
    });
    expect(args.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check']);
    expect(args).toEqual(
      expect.arrayContaining(['-s', 'read-only', '-c', 'approval_policy="never"']),
    );
    expect(args).toContain('developer_instructions="Be \\"Dazza\\"."');
    expect(args).toContain('mcp_servers.dazza.args=["cli.js","mcp"]');
    expect(args).toContain('mcp_servers.dazza.default_tools_approval_mode="approve"');
    expect(args.at(-1)).toBe('-');
  });

  it('builds with write access, network and automatic approval review, resuming a session', () => {
    const args = buildCodexArgs({
      cwd: '/p',
      autonomous: true,
      model: 'gpt-6-sol',
      resumeSessionId: 'abc',
    });
    expect(args).toEqual(
      expect.arrayContaining(['-m', 'gpt-6-sol', '-s', 'workspace-write', '--approve-for-me']),
    );
    expect(args).toContain('sandbox_workspace_write.network_access=true');
    expect(args.slice(-3)).toEqual(['resume', 'abc', '-']);
  });
});

describe('CodexProvider', () => {
  const collect = async (prompt: string) => {
    const events: AgentEvent[] = [];
    for await (const e of codex.run({ prompt, cwd: process.cwd() })) events.push(e);
    return events;
  };

  it('runs and streams a turn', async () => {
    expect((await collect('build it')).at(-1)).toMatchObject({ type: 'finished', ok: true });
  });

  it('stops retrying a rejected key straight away', async () => {
    const started = Date.now();
    const events = await collect('BADKEY');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(events.at(-1)).toMatchObject({ type: 'finished', ok: false, error: { kind: 'auth' } });
  });

  it('surfaces a crash', async () => {
    await expect(collect('CRASH')).rejects.toThrow('thread panicked');
  });

  it('reads account, models and live limits from the app-server', async () => {
    expect(await codex.detect()).toMatchObject({
      installed: true,
      version: '0.157.1',
      loggedIn: true,
      authMethod: 'ChatGPT',
      plan: 'ChatGPT Plus',
    });
    expect((await codex.listModels()).map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-6-sol']);
    expect(await codex.readLimits()).toEqual([
      { id: 'five_hour', utilization: 0.42, resetsAt: '2026-09-27T07:40:00.000Z' },
      { id: 'seven_day', utilization: 0.09, resetsAt: '2026-10-03T00:00:00.000Z' },
    ]);
  });
});
