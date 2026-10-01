import { describe, expect, it } from 'vitest';
import { connectJev, editJev, type JevUI, jevOn } from '../../src/chat/jev.js';
import type { JevLink } from '../../src/core/config.js';
import { useTempProject } from '../helpers.js';

/** A terminal that picks and types from scripts: undefined is Esc. */
function scripted(picks: (string | undefined)[], lines: (string | undefined)[] = []) {
  const said: string[] = [];
  const menus: string[][] = [];
  const ui: JevUI = {
    say: (text) => said.push(text),
    select: async (_question, choices) => {
      menus.push(choices.map((c) => c.label));
      const label = picks.shift();
      return label === undefined
        ? undefined
        : choices.find((c) => c.label.startsWith(label))?.value;
    },
    readLine: async () => lines.shift(),
  };
  return { ui, said, menus };
}

const goodKey = async (link: JevLink) => (link.apiKey === 'good-key' ? 'valid' : 'invalid');

describe('connectJev', () => {
  it('says where to make a key for the chosen provider, and keeps one that works', async () => {
    const { ui, said } = scripted(['Vercel AI Gateway'], ['  good-key  ']);
    expect(await connectJev(ui, goodKey)).toEqual({ provider: 'vercel', apiKey: 'good-key' });
    expect(said[0]).toContain('AI Gateway API key');
  });

  it('gives three tries, then stops', async () => {
    const { ui, said } = scripted(['TypeSafe'], ['a', 'b', 'c', 'good-key']);
    expect(await connectJev(ui, goodKey)).toBeUndefined();
    expect(said.filter((s) => s.includes('didn’t accept'))).toHaveLength(3);
  });

  it('says when it couldn’t check, rather than blaming the key', async () => {
    const { ui, said } = scripted(['TypeSafe'], ['x', undefined]);
    expect(await connectJev(ui, async () => 'unreachable')).toBeUndefined();
    expect(said.at(-1)).toContain('Couldn’t reach TypeSafe');
  });

  it('backs out on Esc', async () => {
    expect(await connectJev(scripted([undefined]).ui, goodKey)).toBeUndefined();
  });
});

describe('editJev', () => {
  const project = useTempProject();

  it('has every feature on once Jev is connected, until switched off', () => {
    expect(jevOn({}, 'modelRouting')).toBe(true);
    expect(jevOn({ jev: { scopeCheck: false } }, 'scopeCheck')).toBe(false);
  });

  it('changes nothing if the key isn’t given', async () => {
    const { ui } = scripted([undefined]);
    expect(await editJev(project.config, ui, goodKey)).toEqual([]);
    expect(await project.config.readJev()).toBeUndefined();
  });

  it('lists each feature with its state, and switches them back and forth', async () => {
    await project.config.writeJev({ provider: 'typesafe', apiKey: 'good-key' });
    const { ui, menus } = scripted(['Scope check', 'Scope check', 'Model routing', undefined]);
    const changed = await editJev(project.config, ui, goodKey);
    expect(changed).toEqual(['Scope check: Off', 'Scope check: On', 'Model routing: Off']);
    expect(menus[0]?.join('\n')).toMatch(/Model routing\s+On\nScope check\s+On\nKey\s+TypeSafe/);
    expect((await project.config.readSettings()).jev).toEqual({
      scopeCheck: true,
      modelRouting: false,
    });
  });

  it('changes where Jev is called', async () => {
    await project.config.writeJev({ provider: 'typesafe', apiKey: 'good-key' });
    const { ui } = scripted(['Key', 'OpenRouter', undefined], ['good-key']);
    expect(await editJev(project.config, ui, goodKey)).toEqual(['Jev: through OpenRouter']);
    expect((await project.config.readJev())?.provider).toBe('openrouter');
  });

  it('forgets the key and leaves the features as they were', async () => {
    await project.config.writeJev({ provider: 'typesafe', apiKey: 'good-key' });
    await project.config.updateSettings({ jev: { modelRouting: false } });
    const { ui } = scripted(['Forget']);
    expect(await editJev(project.config, ui, goodKey)).toEqual(['Jev: key forgotten']);
    expect(await project.config.readJev()).toBeUndefined();
    expect((await project.config.readSettings()).jev).toEqual({ modelRouting: false });
  });
});
