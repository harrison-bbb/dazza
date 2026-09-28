import { spawn } from 'node:child_process';

/**
 * The operating system's own store for secrets: the macOS Keychain, the
 * Secret Service on Linux (GNOME Keyring, KWallet) through `secret-tool`, and
 * DPAPI on Windows, which encrypts with the user's Windows sign-in. Dazza keeps
 * API keys and bot tokens there rather than in its config files, so they aren't
 * sitting on disk in plain text.
 *
 * Each goes through the platform's own command-line tool, with the secret on
 * stdin rather than in arguments another process could read. Where there's no
 * such store (a headless Linux box, a container), `available()` says so and
 * Dazza keeps the secret in its owner-only config file, as before.
 * `DAZZA_KEYCHAIN=off` turns it off; the tests do, so they never touch the
 * user's own keychain.
 */
export interface Keychain {
  /** What to call it, for `dazza doctor`. */
  readonly name: string;
  available(): Promise<boolean>;
  get(account: string): Promise<string | undefined>;
  /** False when it couldn't be stored; the caller keeps it in the file instead. */
  set(account: string, secret: string): Promise<boolean>;
  delete(account: string): Promise<void>;
}

const SERVICE = 'dazza';

/** Secrets Dazza handles are tokens and keys: printable, no spaces or quotes. */
const STORABLE = /^[\x21-\x7e]+$/;
const QUOTABLE = /^[^"\\]+$/;

/** What the config file holds in a secret's place. */
export type Sealed = { keychain: string } | { dpapi: string };

export function isSealed(value: unknown): value is Sealed {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.keychain === 'string' || typeof v.dpapi === 'string';
}

/** Puts secrets somewhere safer than the config file, and gets them back. */
export interface SecretStore {
  readonly name: string;
  /** Undefined when it couldn't: the caller keeps the secret in the file. */
  seal(account: string, secret: string): Promise<Sealed | undefined>;
  open(sealed: Sealed): Promise<string | undefined>;
  discard(sealed: Sealed): Promise<void>;
}

/** This machine's store, or undefined where there's none (or `DAZZA_KEYCHAIN=off`). */
export function secretStore(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): SecretStore | undefined {
  if (/^(off|0|false|no)$/i.test(env.DAZZA_KEYCHAIN ?? '')) return undefined;
  if (platform === 'darwin') return fromKeychain(macKeychain());
  if (platform === 'linux') return fromKeychain(secretService());
  if (platform === 'win32') return fromDpapi();
  return undefined;
}

export function fromKeychain(keychain: Keychain): SecretStore {
  return {
    name: keychain.name,
    async seal(account, secret) {
      if (!(await keychain.available())) return undefined;
      return (await keychain.set(account, secret)) ? { keychain: account } : undefined;
    },
    open: async (sealed) => ('keychain' in sealed ? keychain.get(sealed.keychain) : undefined),
    async discard(sealed) {
      if ('keychain' in sealed) await keychain.delete(sealed.keychain);
    },
  };
}

function fromDpapi(): SecretStore {
  return {
    name: windowsDpapi.name,
    async seal(_account, secret) {
      const blob = await windowsDpapi.protect(secret);
      // Only if it comes back out: a secret that can't be read again is lost.
      return blob && (await windowsDpapi.unprotect(blob)) === secret ? { dpapi: blob } : undefined;
    },
    open: async (sealed) => ('dpapi' in sealed ? windowsDpapi.unprotect(sealed.dpapi) : undefined),
    discard: async () => undefined,
  };
}

/** The macOS login keychain, through `security`. `file` is for tests: a throwaway keychain. */
export function macKeychain(file?: string): Keychain {
  const where = file ? [file] : [];
  return {
    name: 'the macOS Keychain',
    available: async () => (await run('security', ['help'])).code !== undefined,
    async get(account) {
      const found = await run('security', [
        'find-generic-password',
        '-s',
        SERVICE,
        '-a',
        account,
        '-w',
        ...where,
      ]);
      return found.code === 0 ? found.stdout.replace(/\n$/, '') || undefined : undefined;
    },
    async set(account, secret) {
      if (!STORABLE.test(secret) || !QUOTABLE.test(account)) return false;
      // `security -i` reads commands from stdin, so the secret never appears in `ps`.
      const command = `add-generic-password -U -s ${SERVICE} -a "${account}" -l "Dazza: ${account}" -w "${secret}"${file ? ` "${file}"` : ''}\n`;
      const stored = await run('security', ['-i'], command);
      return stored.code === 0 && (await this.get(account)) === secret;
    },
    async delete(account) {
      await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account, ...where]);
    },
  };
}

/** GNOME Keyring or KWallet, through `secret-tool` (libsecret). */
export function secretService(): Keychain {
  let usable: Promise<boolean> | undefined;
  return {
    name: 'your system keyring',
    // Installed isn't enough: with no keyring daemon running, it fails.
    available: () => {
      usable ??= run('secret-tool', ['search', 'service', SERVICE, 'account', 'dazza-probe']).then(
        (r) => r.code === 0 || (r.code === 1 && !/error|cannot|failed/i.test(r.stderr)),
      );
      return usable;
    },
    async get(account) {
      const found = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);
      return found.code === 0 ? found.stdout.replace(/\n$/, '') || undefined : undefined;
    },
    async set(account, secret) {
      if (!STORABLE.test(secret)) return false;
      const stored = await run(
        'secret-tool',
        ['store', `--label=Dazza: ${account}`, 'service', SERVICE, 'account', account],
        secret,
      );
      return stored.code === 0 && (await this.get(account)) === secret;
    },
    async delete(account) {
      await run('secret-tool', ['clear', 'service', SERVICE, 'account', account]);
    },
  };
}

/**
 * Windows: DPAPI, through PowerShell. There's no store to put things in, so it
 * encrypts: the result can only be decrypted by the same Windows user, and it
 * goes in the config file in place of the secret.
 */
export const windowsDpapi = {
  name: 'Windows (encrypted with your sign-in)',
  // .NET's ProtectedData rather than ConvertTo-SecureString: that cmdlet's
  // module fails to load in Windows PowerShell when PowerShell 7 is installed too.
  async protect(secret: string): Promise<string | undefined> {
    const out = await powershell(
      `${LOAD}; $b = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser')))`,
      secret,
    );
    return out && BASE64.test(out) ? out : undefined;
  },
  async unprotect(blob: string): Promise<string | undefined> {
    if (!BASE64.test(blob)) return undefined;
    return powershell(
      `${LOAD}; $b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')))`,
      blob,
    );
  },
};

const LOAD = 'Add-Type -AssemblyName System.Security';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

async function powershell(script: string, input: string): Promise<string | undefined> {
  const result = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    input,
    // PowerShell 7's module path confuses Windows PowerShell 5.1.
    { ...process.env, PSModulePath: '' },
  );
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

interface Ran {
  /** Undefined when the tool isn't installed. */
  code: number | undefined;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  input?: string,
  env?: NodeJS.ProcessEnv,
): Promise<Ran> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(env && { env }),
      });
    } catch {
      return resolve({ code: undefined, stdout: '', stderr: '' });
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    // A keyring that pops up an unlock prompt nobody answers mustn't hang Dazza.
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: undefined, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input ?? '');
  });
}
