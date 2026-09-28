import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileMenu, listProjectFiles, pointedAt } from '../../src/chat/attachments.js';
import { initialState, reduce } from '../../src/chat/editor.js';
import { useTempProject } from '../helpers.js';

describe('pointing Dazza at things', () => {
  const project = useTempProject();
  const file = async (path: string) => {
    await mkdir(join(project.root, path, '..'), { recursive: true });
    await writeFile(join(project.root, path), 'x');
  };

  it('offers the project’s files after @, best matches first, and completes without sending', async () => {
    await file('src/app.ts');
    await file('src/lib/apply.ts');
    await file('node_modules/pkg/app.js');
    const files = await listProjectFiles(project.root);
    expect(files).toEqual(['src/app.ts', 'src/lib/apply.ts']);

    const menu = fileMenu(() => files);
    expect(menu('look at @ap').map((m) => m.label)).toEqual(['@src/app.ts', '@src/lib/apply.ts']);
    expect(menu('no mention here')).toEqual([]);

    const state = { ...initialState(), text: 'look at @ap', cursor: 11 };
    expect(reduce(state, { name: 'return' }, menu)).toMatchObject({
      type: 'edit',
      state: { text: 'look at @src/app.ts ' },
    });
  });

  it('names what the message points at: @ files, and dragged-in paths', async () => {
    await file('src/app.ts');
    await file('shot.png');
    const shot = join(project.root, 'shot.png');
    const note = pointedAt(`why is @src/app.ts broken? ${shot}`, project.root);
    expect(note).toContain(`The user pointed at: src/app.ts, ${shot}.`);
    expect(note).toContain('Look at the images');
    expect(pointedAt('nothing to see', project.root)).toBeUndefined();
  });
});
