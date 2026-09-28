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

  it('says when a folder has files but no code yet, rather than calling it empty', async () => {
    expect(await inspectCodebase(project.root)).toBeUndefined();
    await file('README.md', '# idea');
    await file('package.json', JSON.stringify({ name: 'recipes' }));
    const found = await inspectCodebase(project.root);
    expect(found?.languages).toEqual([]);
    expect(describeCodebase(found as NonNullable<typeof found>)).toBe(
      'a folder with 2 files and no code yet (recipes)',
    );
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
