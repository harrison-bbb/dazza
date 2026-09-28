import { describe, expect, it } from 'vitest';
import { checkApiKey } from '../../src/setup/apiKeys.js';
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
  detect: async (id) => ({
    installed: true,
    version: '2',
    loggedIn: true,
    plan: id === 'codex' ? 'ChatGPT Plus' : 'Claude Max',
  }),
  signIn: async () => {},
  checkApiKey: async (_id, key) => (key === 'sk-good' ? 'valid' : 'invalid'),
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
        detect: async () => ({ installed: true, version: '2', loggedIn: signedIn }),
        signIn: async () => {
          signedIn = true;
        },
      }),
    );
    expect(result).toEqual({ provider: 'claude', method: 'subscription' });
  });

  it('stops when Claude Code is missing', async () => {
    const { ui, said } = scriptedUI(['Claude subscription']);
    expect(await connect(ui, deps({ detect: async () => ({ installed: false }) }))).toBeUndefined();
    expect(said.at(-1)).toContain('isn’t installed');
  });

  it('checks API keys and lets the user retry', async () => {
    const { ui, said } = scriptedUI(['Anthropic API key', 'sk-bad', 'sk-good']);
    expect(await connect(ui, deps())).toEqual({
      provider: 'claude',
      method: 'api-key',
      apiKey: 'sk-good',
    });
    expect(said.some((s) => s.includes('wasn’t accepted'))).toBe(true);
  });

  it('checks Claude Code is installed before asking for an Anthropic key', async () => {
    const { ui, said } = scriptedUI(['Anthropic API key', 'sk-good']);
    expect(await connect(ui, deps({ detect: async () => ({ installed: false }) }))).toBeUndefined();
    expect(said.at(-1)).toContain('Claude Code, which isn’t installed yet');
    expect(said.some((s) => s.includes('Paste an Anthropic API key'))).toBe(false);
  });

  it('gives up after repeated bad keys', async () => {
    const { ui } = scriptedUI(['Anthropic API key', 'a', 'b', 'c']);
    expect(await connect(ui, deps())).toBeUndefined();
  });

  it('connects Codex through a ChatGPT sign-in', async () => {
    const { ui, said } = scriptedUI(['ChatGPT subscription']);
    expect(await connect(ui, deps())).toEqual({ provider: 'codex', method: 'subscription' });
    expect(said.at(-1)).toContain('ChatGPT Plus');
  });

  it('connects Codex with an OpenAI key, checked with OpenAI', async () => {
    const checked: string[] = [];
    const { ui } = scriptedUI(['OpenAI API key', 'sk-good']);
    const result = await connect(
      ui,
      deps({
        checkApiKey: async (id, key) => {
          checked.push(id);
          return key === 'sk-good' ? 'valid' : 'invalid';
        },
      }),
    );
    expect(result).toEqual({ provider: 'codex', method: 'api-key', apiKey: 'sk-good' });
    expect(checked).toEqual(['codex']);
  });

  it('says how to install Codex when it is missing', async () => {
    const { ui, said } = scriptedUI(['ChatGPT subscription']);
    expect(await connect(ui, deps({ detect: async () => ({ installed: false }) }))).toBeUndefined();
    expect(said.at(-1)).toContain('npm install -g @openai/codex');
  });
});

describe('checkApiKey', () => {
  const respond = (status: number, seen?: string[]) =>
    (async (url: string) => {
      seen?.push(String(url));
      return new Response('{}', { status });
    }) as typeof fetch;

  it('maps responses to a verdict, asking the right provider', async () => {
    const seen: string[] = [];
    expect(await checkApiKey('claude', 'k', respond(200, seen))).toBe('valid');
    expect(await checkApiKey('codex', 'k', respond(401, seen))).toBe('invalid');
    expect(await checkApiKey('claude', 'k', respond(529))).toBe('unreachable');
    expect(seen[0]).toContain('api.anthropic.com');
    expect(seen[1]).toContain('api.openai.com');
    const offline = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    expect(await checkApiKey('codex', 'k', offline)).toBe('unreachable');
  });
});
