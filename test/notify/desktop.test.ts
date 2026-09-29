import { describe, expect, it } from 'vitest';
import { DesktopNotifier } from '../../src/notify/desktop.js';

describe('desktop notifications', () => {
  it('say what needs the user, in a line, titled with the project', async () => {
    const shown: string[][] = [];
    const notifier = new DesktopNotifier('/work/notes-app', async (title, body) => {
      shown.push([title, body]);
    });
    await notifier.notify({
      kind: 'review',
      howToTry: [],
      taskId: 'T3',
      title: 'Editor',
      facts: [],
      images: [],
    });
    await notifier.notify({
      kind: 'blocked',
      taskId: 'T5',
      title: 'Payments',
      question: 'Which Stripe account?',
      images: [],
    });
    await notifier.notify({
      kind: 'milestone',
      id: 'M1',
      title: 'Write',
      goal: 'x',
      tasks: [],
      images: [],
    });
    expect(shown).toEqual([
      ['Dazza · notes-app', 'T3 is ready for your review: Editor'],
      ['Dazza · notes-app', 'T5 needs you: Which Stripe account?'],
      ['Dazza · notes-app', 'M1 reached: Write'],
    ]);
  });

  it('never lets a failed notification get in the way', async () => {
    const notifier = new DesktopNotifier('/p', async () => {
      throw new Error('no display');
    });
    await expect(
      notifier.notify({ kind: 'info', text: 'hi', images: [] }),
    ).resolves.toBeUndefined();
  });
});
