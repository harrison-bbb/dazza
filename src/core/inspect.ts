import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

/** A rough picture of the code already in a directory. */
export interface Codebase {
  files: number;
  /** Most common languages, most used first. */
  languages: string[];
  /** From package.json, pyproject.toml or Cargo.toml, when there is one. */
  name?: string;
}

const MAX_FILES = 5000;
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'target',
  'venv',
  '__pycache__',
]);
const LANGUAGES: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.rb': 'Ruby',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.swift': 'Swift',
  '.php': 'PHP',
  '.cs': 'C#',
  '.cpp': 'C++',
  '.c': 'C',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.dart': 'Dart',
  '.ex': 'Elixir',
};

/**
 * Look at what's in a project directory, skipping dependencies, build output and
 * hidden folders. Returns undefined when there's no source code to speak of.
 */
export async function inspectCodebase(root: string): Promise<Codebase | undefined> {
  const counts = new Map<string, number>();
  let files = 0;

  const walk = async (dir: string): Promise<void> => {
    if (files >= MAX_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        files++;
        const language = LANGUAGES[extname(entry.name).toLowerCase()];
        if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
      }
    }
  };
  await walk(root);

  // Files but no code (a package.json, a README): not empty, and worth saying so.
  if (files === 0) return undefined;
  const languages = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([language]) => language);
  const name = await projectName(root);
  return { files, languages, ...(name && { name }) };
}

export function describeCodebase(codebase: Codebase): string {
  const size = codebase.files >= MAX_FILES ? `${MAX_FILES}+ files` : `${codebase.files} files`;
  if (codebase.languages.length === 0) {
    const files = codebase.files === 1 ? '1 file' : size;
    return `a folder with ${files} and no code yet${codebase.name ? ` (${codebase.name})` : ''}`;
  }
  const what = `${codebase.languages.join(' and ')} project`;
  return codebase.name ? `a ${what} (${codebase.name}, ${size})` : `a ${what} (${size})`;
}

async function projectName(root: string): Promise<string | undefined> {
  const pkg = await readFile(join(root, 'package.json'), 'utf8').catch(() => undefined);
  if (pkg) {
    try {
      const name: unknown = JSON.parse(pkg).name;
      if (typeof name === 'string' && name) return name;
    } catch {
      // Not valid JSON; fall through to the other manifests.
    }
  }
  for (const manifest of ['pyproject.toml', 'Cargo.toml']) {
    const text = await readFile(join(root, manifest), 'utf8').catch(() => undefined);
    const match = text?.match(/^name\s*=\s*"([^"]+)"/m);
    if (match?.[1]) return match[1];
  }
  return undefined;
}
