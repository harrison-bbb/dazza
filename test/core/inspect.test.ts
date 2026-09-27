import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeCodebase, inspectCodebase } from '../../src/core/inspect.js';
import { useTempProject } from '../helpers.js';

describe('inspectCodebase', () => {
  const project = useTempProject();
  const file = async (path: string, contents = '') => {
    await mkdir(join(project.root, path, '..'), { recursive: true });
    await writeFile(join(project.root, path), contents);
  };

  it('treats a folder without source code as new', async () => {
    await file('README.md', '# idea');
    expect(await inspectCodebase(project.root)).toBeUndefined();
  });

  it('counts source files and ignores dependencies and hidden folders', async () => {
    await file('package.json', JSON.stringify({ name: 'shop' }));
    await file('src/a.ts');
    await file('src/b.ts');
    await file('scripts/c.js');
    await file('node_modules/x/index.js');
    await file('.git/HEAD');
    const codebase = await inspectCodebase(project.root);
    expect(codebase).toEqual({ files: 4, languages: ['TypeScript', 'JavaScript'], name: 'shop' });
    if (codebase)
      expect(describeCodebase(codebase)).toBe(
        'a TypeScript and JavaScript project (shop, 4 files)',
      );
  });

  it('reads the name from pyproject.toml', async () => {
    await file('pyproject.toml', '[project]\nname = "api"\n');
    await file('app/main.py');
    expect((await inspectCodebase(project.root))?.name).toBe('api');
  });
});
