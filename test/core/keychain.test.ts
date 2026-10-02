import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Config, type TelegramLink } from '../../src/core/config.js';
import {
  macKeychain,
  type Sealed,
  type SecretStore,
  secretStore,
} from '../../src/core/keychain.js';
import { useTempProject } from '../helpers.js';

/** A secret store in memory, standing in for the OS's. */
function memoryStore(works = true) {
  const kept = new Map<string, string>();
  const store: SecretStore = {
    name: 'the test keychain',
    seal: async (account, secret) => {
      if (!works) return undefined;
      kept.set(account, secret);
      return { keychain: account };
    },
    open: async (sealed: Sealed) => ('keychain' in sealed ? kept.get(sealed.keychain) : undefined),
    discard: async (sealed: Sealed) => {
      if ('keychain' in sealed) kept.delete(sealed.keychain);
    },
  };
  return { store, kept };
}

const TELEGRAM: TelegramLink = {
  botToken: '123456:ABC-secret',
  botUsername: 'dazza_bot',
  chatId: '42',
};

describe('secrets in the OS keychain', () => {
  const project = useTempProject();
  const file = () => readFile(join(project.config.dir, 'telegram.json'), 'utf8');

  it('keeps the token in the keychain, and only a pointer to it in the file', async () => {
    const { store, kept } = memoryStore();
    const config = new Config(project.config.dir, store);
    await config.writeTelegram(TELEGRAM);

    expect(await file()).not.toContain('ABC-secret');
    expect(JSON.parse(await file()).botToken).toHaveProperty('keychain');
    expect([...kept.values()]).toEqual(['123456:ABC-secret']);
    expect(await config.readTelegram()).toEqual(TELEGRAM);
    expect(await config.secretsKeptIn()).toEqual(['the test keychain']);
  });

  it('moves a token saved in the file into the keychain the next time it’s read', async () => {
    await mkdir(project.config.dir, { recursive: true });
    await writeFile(join(project.config.dir, 'telegram.json'), JSON.stringify(TELEGRAM));
    const { store, kept } = memoryStore();
    const config = new Config(project.config.dir, store);

    expect(await config.readTelegram()).toEqual(TELEGRAM);
    expect(await file()).not.toContain('ABC-secret');
    expect(kept.size).toBe(1);
  });

  it('deletes the token from the keychain when you disconnect', async () => {
    const { store, kept } = memoryStore();
    const config = new Config(project.config.dir, store);
    await config.writeTelegram(TELEGRAM);
    await config.clearTelegram();
    expect(kept.size).toBe(0);
    expect(await config.readTelegram()).toBeUndefined();
  });

  it('keeps it in the owner-only file where there’s no keychain to use', async () => {
    const config = new Config(project.config.dir, memoryStore(false).store);
    await config.writeTelegram(TELEGRAM);
    expect(await file()).toContain('ABC-secret');
    expect(await config.readTelegram()).toEqual(TELEGRAM);
    expect(await config.secretsKeptIn()).toEqual(['Dazza’s config folder (owner-only)']);
  });

  it('keeps the Jev key in the keychain too, and says where', async () => {
    const { store, kept } = memoryStore();
    const config = new Config(project.config.dir, store);
    await config.writeJev({ provider: 'openrouter', apiKey: 'sk-or-secret' });
    const raw = await readFile(join(project.config.dir, 'jev.json'), 'utf8');
    expect(raw).not.toContain('sk-or-secret');
    expect([...kept.values()]).toEqual(['sk-or-secret']);
    expect(await config.readJev()).toEqual({ provider: 'openrouter', apiKey: 'sk-or-secret' });
    expect(await config.jevKeyKeptIn()).toBe('the test keychain');
    await config.clearJev();
    expect(kept.size).toBe(0);
    expect(await config.jevKeyKeptIn()).toBeUndefined();
  });

  it('is off when DAZZA_KEYCHAIN=off, as in these tests', () => {
    expect(secretStore('darwin', { DAZZA_KEYCHAIN: 'off' })).toBeUndefined();
    expect(secretStore('darwin', {})).toBeDefined();
    expect(secretStore('win32', {})).toBeDefined();
  });
});

// Windows CI runs this one: DPAPI needs no store, so it's safe to try for real.
describe.runIf(process.platform === 'win32')('Windows DPAPI', () => {
  it('encrypts a secret so only this user can read it back', async () => {
    const store = secretStore('win32', {});
    const sealed = await store?.seal('slack.botToken', 'xoxb-1-2-abc');
    expect(sealed).toHaveProperty('dpapi');
    expect(JSON.stringify(sealed)).not.toContain('xoxb');
    expect(sealed && (await store?.open(sealed))).toBe('xoxb-1-2-abc');
  }, 30_000);
});

// The real thing, on a throwaway keychain: never the user's own.
describe.runIf(process.platform === 'darwin')('the macOS Keychain', () => {
  let dir = '';
  let file = '';
  // In beforeAll: describe bodies run on every platform, even skipped ones.
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dazza-keychain-'));
    file = join(dir, 'test.keychain-db');
    execFileSync('security', ['create-keychain', '-p', 'test', file]);
    execFileSync('security', ['unlock-keychain', '-p', 'test', file]);
  });
  afterAll(() => {
    execFileSync('security', ['delete-keychain', file]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores, reads back, replaces and deletes a secret', async () => {
    const keychain = macKeychain(file);
    expect(await keychain.available()).toBe(true);
    expect(await keychain.set('slack.botToken (test)', 'xoxb-1-2-abc')).toBe(true);
    expect(await keychain.get('slack.botToken (test)')).toBe('xoxb-1-2-abc');
    expect(await keychain.set('slack.botToken (test)', 'xoxb-3-4-def')).toBe(true);
    expect(await keychain.get('slack.botToken (test)')).toBe('xoxb-3-4-def');
    await keychain.delete('slack.botToken (test)');
    expect(await keychain.get('slack.botToken (test)')).toBeUndefined();
  });

  it('won’t store what it can’t pass safely, so it stays in the file', async () => {
    expect(await macKeychain(file).set('acct', 'has "quotes"')).toBe(false);
  });
});
