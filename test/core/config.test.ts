import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempProject } from '../helpers.js';

describe('Config', () => {
  const project = useTempProject();

  it('starts empty and merges setting updates', async () => {
    expect(await project.config.readSettings()).toEqual({});
    await project.config.updateSettings({ model: 'sonnet' });
    expect(await project.config.readSettings()).toEqual({ model: 'sonnet' });
  });

  it('keeps files private to the user', async () => {
    await project.config.updateSettings({ model: 'opus' });
    const mode = (await stat(join(project.config.dir, 'settings.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('round-trips the latest limits', async () => {
    const limits = {
      checkedAt: '2026-09-27T10:00:00.000Z',
      windows: [{ id: 'seven_day', utilization: 0.1, resetsAt: '2026-10-01T00:00:00.000Z' }],
    };
    await project.config.writeLimits(limits);
    expect(await project.config.readLimits()).toEqual(limits);
  });
});
