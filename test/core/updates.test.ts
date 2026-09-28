import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isNewer, newerDazza } from '../../src/core/updates.js';
import { useTempProject } from '../helpers.js';

describe('newerDazza', () => {
  const project = useTempProject();
  beforeEach(() => {
    delete process.env.DAZZA_NO_UPDATE_CHECK;
  });
  afterEach(() => {
    process.env.DAZZA_NO_UPDATE_CHECK = '1';
  });

  it('says when a newer version is out, asking npm at most once a day', async () => {
    let asked = 0;
    const fetchLatest = async () => {
      asked++;
      return '0.2.0';
    };
    const now = new Date('2026-09-28T10:00:00Z');
    const check = (at: Date) =>
      newerDazza(project.config, { now: at, current: '0.1.2', fetchLatest });
    expect(await check(now)).toBe('0.2.0');
    expect(await check(new Date(now.getTime() + 60 * 60_000))).toBe('0.2.0');
    expect(asked).toBe(1);
    await check(new Date(now.getTime() + 25 * 60 * 60_000));
    expect(asked).toBe(2);
  });

  it('stays quiet when up to date, offline, or turned off', async () => {
    const current = { current: '0.2.0' };
    expect(await newerDazza(project.config, { ...current, fetchLatest: async () => '0.2.0' })).toBe(
      undefined,
    );
    const offline = async () => {
      throw new Error('offline');
    };
    expect(
      await newerDazza(project.config, {
        current: '0.1.0',
        now: new Date('2030-01-01'),
        fetchLatest: offline,
      }),
    ).toBe('0.2.0'); // the last answer it had
    process.env.DAZZA_NO_UPDATE_CHECK = '1';
    expect(await newerDazza(project.config, { current: '0.0.1' })).toBeUndefined();
  });

  it('compares versions as numbers, and skips prereleases', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('0.1.2', '0.1.2')).toBe(false);
    expect(isNewer('0.3.0-beta.1', '0.2.0')).toBe(false);
  });
});
