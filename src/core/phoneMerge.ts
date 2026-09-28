import type { ActionResult } from './actions.js';
import { Config } from './config.js';

/**
 * Whether approving work from Slack or Telegram may merge it. On unless the
 * user ran `/phone-merge off`: then anyone who gets into their Slack or
 * Telegram can't merge code, and approving from the phone points them at the
 * terminal or the board instead.
 */
export async function phoneMayMerge(config = new Config()): Promise<boolean> {
  return (await config.readSettings()).phoneMerge !== false;
}

/** The answer to approving from the phone while merging from there is off. */
export function mergeAtTheComputer(taskId: string): ActionResult {
  return {
    ok: false,
    message: `Merging from your phone is switched off. To merge ${taskId}, approve it at your computer: /accept ${taskId} in the terminal, or on the board.`,
  };
}
