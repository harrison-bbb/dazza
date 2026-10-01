import { describe, expect, it } from 'vitest';
import { checkJev } from '../../src/cli/doctor.js';
import { useTempProject } from '../helpers.js';

describe('dazza doctor: Jev', () => {
  const project = useTempProject();

  it('is fine without Jev: it’s optional', async () => {
    expect(await checkJev(project.config, async () => 'valid')).toEqual({
      label: 'Jev',
      ok: true,
      detail: 'not connected (optional; /jev in the chat)',
    });
  });

  it('says where Jev is called and what it’s doing', async () => {
    await project.config.writeJev({ provider: 'openrouter', apiKey: 'k' });
    await project.config.updateSettings({ jev: { scopeCheck: false } });
    expect((await checkJev(project.config, async () => 'valid')).detail).toBe(
      'through OpenRouter · model routing',
    );
  });

  it('fails on a key that no longer works, and says how to fix it', async () => {
    await project.config.writeJev({ provider: 'vercel', apiKey: 'k' });
    const check = await checkJev(project.config, async () => 'invalid');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('Vercel AI Gateway doesn’t accept the key');
  });

  it('doesn’t fail when the provider can’t be reached', async () => {
    await project.config.writeJev({ provider: 'typesafe', apiKey: 'k' });
    expect(await checkJev(project.config, async () => 'unreachable')).toMatchObject({ ok: true });
  });
});
