import { describe, expect, it } from 'vitest';
import { resolveCommand } from '../../src/util/command.js';
import { shellCommand } from '../../src/util/process.js';

/** What npm's cmd-shim writes for a global install, e.g. claude.cmd. */
const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`;

const NPM_BIN = 'C:\\Users\\dad\\AppData\\Roaming\\npm';
const LOCAL_BIN = 'C:\\Users\\dad\\.local\\bin';

/** A Windows machine with these files. */
const windows = (files: Record<string, string>) => ({
  platform: 'win32' as const,
  // A copied environment keeps Windows' own spelling: Path, not PATH.
  env: { Path: `C:\\Windows\\system32;${NPM_BIN};${LOCAL_BIN}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
  isFile: (path: string) => path in files,
  readText: (path: string) => files[path],
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
});

describe('resolveCommand', () => {
  it('leaves commands alone on macOS and Linux', () => {
    expect(resolveCommand('claude', ['-p'], { platform: 'darwin' })).toEqual({
      command: 'claude',
      args: ['-p'],
    });
  });

  it('runs the script behind an npm wrapper with Node, so arguments pass through intact', () => {
    const launch = resolveCommand(
      'claude',
      ['--append-system-prompt', 'line one\nline "two"'],
      windows({ [`${NPM_BIN}\\claude.cmd`]: NPM_SHIM, [`${NPM_BIN}\\claude`]: '#!/bin/sh' }),
    );
    expect(launch).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: [
        `${NPM_BIN}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`,
        '--append-system-prompt',
        'line one\nline "two"',
      ],
    });
  });

  it('runs the program behind an npm wrapper for a native binary (how Claude Code ships today)', () => {
    const shim = `@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\n`;
    expect(
      resolveCommand('claude', ['auth', 'status'], windows({ [`${NPM_BIN}\\claude.cmd`]: shim })),
    ).toEqual({
      command: `${NPM_BIN}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`,
      args: ['auth', 'status'],
    });
  });

  it('runs a native install directly', () => {
    expect(
      resolveCommand('claude', ['--version'], windows({ [`${LOCAL_BIN}\\claude.exe`]: '' })),
    ).toEqual({ command: `${LOCAL_BIN}\\claude.exe`, args: ['--version'] });
  });

  it('falls back to the shell for scripts it can’t unwrap, like npm itself', () => {
    const launch = resolveCommand(
      'npm',
      ['install'],
      windows({ [`${NPM_BIN}\\npm.cmd`]: '@ECHO off\nSET "NPM_CLI_JS=..."\n"%NODE_EXE%" %*' }),
    );
    expect(launch).toEqual({ command: `${NPM_BIN}\\npm.cmd`, args: ['install'], shell: true });
  });

  it('leaves a missing program as it is, so it reads as not installed', () => {
    expect(resolveCommand('codex', ['--version'], windows({}))).toEqual({
      command: 'codex',
      args: ['--version'],
    });
  });
});

describe('shellCommand', () => {
  it('quotes paths with spaces the way each platform’s shell reads them', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    expect(shellCommand(node, ['cli.js', 'guard'], 'win32')).toBe(`"${node}" cli.js guard`);
    expect(shellCommand('/opt/my node', ['guard'], 'darwin')).toBe(`'/opt/my node' guard`);
  });
});
