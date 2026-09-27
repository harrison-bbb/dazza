import { describe, expect, it } from 'vitest';
import { checkApiKey } from '../../src/setup/anthropic.js';
import { connect, type SetupDeps, type SetupUI } from '../../src/setup/connect.js';

/** Scripted answers, in order: select() consumes choice labels, readLine() consumes text. */
function scriptedUI(answers: string[]) {
  const said: string[] = [];
  const ui: SetupUI = {
    say: (text) => said.push(text),
    async select(_question, choices) {
      const answer = answers.shift();
      return choices.find((c) => c.label === answer && !c.disabled)?.value;
    },
    async readLine() {
      return answers.shift();
    },
  };
  return { ui, said };
}

const deps = (overrides: Partial<SetupDeps> = {}): SetupDeps => ({
  detectClaude: async () => ({ installed: true, version: '2', loggedIn: true, plan: 'Claude Max' }),
  signInToClaude: async () => {},
  checkApiKey: async (key) => (key === 'sk-good' ? 'valid' : 'invalid'),
  ...overrides,
});

describe('connect', () => {
  it('connects a signed-in subscription', async () => {
    const { ui, said } = scriptedUI(['Claude subscription']);
    expect(await connect(ui, deps())).toEqual({ provider: 'claude', method: 'subscription' });
    expect(said.at(-1)).toContain('Claude Max');
  });

  it('offers to sign in to Claude Code, then connects', async () => {
    let signedIn = false;
    const { ui } = scriptedUI(['Claude subscription', 'Sign in']);
    const result = await connect(
      ui,
      deps({
        detectClaude: async () => ({ installed: true, version: '2', loggedIn: signedIn }),
        signInToClaude: async () => {
          signedIn = true;
        },
      }),
    );
    expect(result).toEqual({ provider: 'claude', method: 'subscription' });
  });

  it('stops when Claude Code is missing', async () => {
    const { ui, said } = scriptedUI(['Claude subscription']);
    expect(
      await connect(ui, deps({ detectClaude: async () => ({ installed: false }) })),
    ).toBeUndefined();
    expect(said.at(-1)).toContain('isn’t installed');
  });

  it('checks API keys and lets the user retry', async () => {
    const { ui, said } = scriptedUI(['Anthropic API key', 'sk-bad', 'sk-good']);
    expect(await connect(ui, deps())).toEqual({
      provider: 'claude',
      method: 'api-key',
      apiKey: 'sk-good',
    });
    expect(said.some((s) => s.includes('didn’t accept'))).toBe(true);
  });

  it('gives up after repeated bad keys', async () => {
    const { ui } = scriptedUI(['Anthropic API key', 'a', 'b', 'c']);
    expect(await connect(ui, deps())).toBeUndefined();
  });

  it("doesn't let Codex be picked yet", async () => {
    const { ui } = scriptedUI(['Codex']);
    expect(await connect(ui, deps())).toBeUndefined();
  });
});

describe('checkApiKey', () => {
  const respond = (status: number) => (async () => new Response('{}', { status })) as typeof fetch;

  it('maps responses to a verdict', async () => {
    expect(await checkApiKey('k', respond(200))).toBe('valid');
    expect(await checkApiKey('k', respond(401))).toBe('invalid');
    expect(await checkApiKey('k', respond(529))).toBe('unreachable');
    const offline = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    expect(await checkApiKey('k', offline)).toBe('unreachable');
  });
});
