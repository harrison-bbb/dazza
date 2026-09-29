import { describe, expect, it } from 'vitest';
import { checkApiKey } from '../../src/setup/apiKeys.js';
import { connect, ensureReady, type SetupDeps, type SetupUI } from '../../src/setup/connect.js';

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
  install: async () => false,
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

  it('stops when Claude Code is missing and they’d rather install it themselves', async () => {
    const { ui, said } = scriptedUI(['Claude subscription', 'Not now']);
    expect(await connect(ui, deps({ detect: async () => ({ installed: false }) }))).toBeUndefined();
    expect(said.at(-1)).toContain('npm install -g @anthropic-ai/claude-code');
  });

  it('installs Claude Code on a yes, then signs in and connects', async () => {
    let installed = false;
    let signedIn = false;
    const installs: string[] = [];
    const { ui, said } = scriptedUI(['Claude subscription', 'Install it', 'Sign in']);
    const result = await connect(
      ui,
      deps({
        detect: async () =>
          installed ? { installed: true, version: '2', loggedIn: signedIn } : { installed: false },
        install: async (id) => {
          installs.push(id);
          installed = true;
          return true;
        },
        signIn: async () => {
          signedIn = true;
        },
      }),
    );
    expect(installs).toEqual(['claude']);
    expect(said).toContain('Claude Code is installed.');
    expect(result).toEqual({ provider: 'claude', method: 'subscription' });
  });

  it('says how to fix a failed install, and doesn’t carry on', async () => {
    const { ui, said } = scriptedUI(['ChatGPT subscription', 'Install it']);
    const result = await connect(
      ui,
      deps({ detect: async () => ({ installed: false }), install: async () => false }),
    );
    expect(result).toBeUndefined();
    expect(said.at(-1)).toContain('EACCES');
  });

  it('checks it really installed, not just that npm said so', async () => {
    const { ui, said } = scriptedUI(['OpenAI API key', 'Install it']);
    const result = await connect(
      ui,
      deps({ detect: async () => ({ installed: false }), install: async () => true }),
    );
    expect(result).toBeUndefined();
    expect(said.at(-1)).toContain('didn’t install');
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
    const { ui, said } = scriptedUI(['Anthropic API key', 'Not now']);
    expect(await connect(ui, deps({ detect: async () => ({ installed: false }) }))).toBeUndefined();
    expect(said.at(-1)).toContain('npm install -g @anthropic-ai/claude-code');
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

describe('ensureReady', () => {
  const subscription = { provider: 'claude', method: 'subscription' } as const;

  it('goes straight ahead when all is well, checking only once', async () => {
    let checks = 0;
    const { ui } = scriptedUI([]);
    const status = await ensureReady(
      ui,
      deps({
        detect: async () => {
          checks++;
          return { installed: true, version: '2', loggedIn: true, plan: 'Claude Max' };
        },
      }),
      subscription,
    );
    expect(status).toMatchObject({ plan: 'Claude Max' });
    expect(checks).toBe(1);
  });

  it('offers to sign back in when the sign-in has expired', async () => {
    let signedIn = false;
    const { ui } = scriptedUI(['Sign in']);
    const status = await ensureReady(
      ui,
      deps({
        detect: async () => ({ installed: true, version: '2', loggedIn: signedIn }),
        signIn: async () => {
          signedIn = true;
        },
      }),
      subscription,
    );
    expect(status).toMatchObject({ loggedIn: true });
  });

  it('says how to sign in later, and doesn’t go ahead, on Not now', async () => {
    const { ui, said } = scriptedUI(['Not now']);
    const status = await ensureReady(
      ui,
      deps({ detect: async () => ({ installed: true, version: '2', loggedIn: false }) }),
      subscription,
    );
    expect(status).toBeUndefined();
    expect(said.at(-1)).toContain('`claude`');
  });

  it('never asks an API key connection to sign in', async () => {
    const { ui } = scriptedUI([]);
    const status = await ensureReady(
      ui,
      deps({ detect: async () => ({ installed: true, version: '2', loggedIn: false }) }),
      { provider: 'codex', method: 'api-key', apiKey: 'sk-x' },
    );
    expect(status?.installed).toBe(true);
  });
});
