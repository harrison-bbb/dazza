import type { TelegramLink } from '../core/config.js';
import { TelegramApi, TelegramError } from '../telegram/api.js';
import { errorMessage } from '../util/text.js';
import type { SetupUI } from './connect.js';

const ATTEMPTS = 3;

export interface TelegramSetupOptions {
  /** Offer "Skip for now" (onboarding); otherwise the user asked to connect. */
  optional: boolean;
  /** Makes the API client; swapped out in tests. */
  api?: (token: string) => Pick<TelegramApi, 'getMe' | 'getUpdates' | 'sendMessage'>;
}

/**
 * Link a Telegram bot so Dazza can message the user and take replies from their
 * phone. Walks through BotFather, finds the user's chat by waiting for them to
 * message the bot (or takes a chat ID), and confirms with a test message.
 * Resolves undefined if skipped or not completed.
 */
export async function connectTelegram(
  ui: SetupUI,
  options: TelegramSetupOptions,
): Promise<TelegramLink | undefined> {
  const makeApi = options.api ?? ((token: string) => new TelegramApi(token));

  ui.say(
    'Dazza can message you on Telegram when a task is ready for review or needs you, ' +
      'and you can reply from your phone.',
  );
  if (options.optional) {
    const go = await ui.select('Connect Telegram?', [
      { label: 'Connect Telegram', hint: 'takes about a minute', value: true },
      { label: 'Skip for now', hint: 'run /telegram any time', value: false },
    ]);
    if (!go) return undefined;
  }

  // 1. The bot token.
  ui.say(
    [
      'First, create a bot for Dazza to message you from:',
      '1. In Telegram, open @BotFather (https://t.me/BotFather)',
      '2. Send /newbot, then choose a name and a username ending in "bot"',
      '3. BotFather replies with a token like 123456789:AAH4k…. Paste it here.',
    ].join('\n'),
  );
  let bot: { token: string; username: string } | undefined;
  for (let attempt = 1; attempt <= ATTEMPTS && !bot; attempt++) {
    const token = (await ui.readLine({ prompt: 'Bot token: ', mask: true }))?.trim();
    if (!token) return undefined;
    try {
      const me = await makeApi(token).getMe();
      bot = { token, username: me.username };
      ui.say(`Found your bot, @${me.username}.`);
    } catch (error) {
      ui.say(
        error instanceof TelegramError && error.code === 401
          ? 'Telegram didn’t accept that token. Copy the whole thing from BotFather and try again.'
          : `Couldn’t reach Telegram (${errorMessage(error)}). Check your connection and try again.`,
      );
    }
  }
  if (!bot) return undefined;
  const api = makeApi(bot.token);

  // 2. The user's chat.
  ui.say(
    [
      `Now open https://t.me/${bot.username} and press Start, or send it any message.`,
      'Then press Enter here. (If you already know your chat ID, type it instead.)',
    ].join('\n'),
  );
  let chat: { id: string; name?: string } | undefined;
  for (let attempt = 1; attempt <= ATTEMPTS && !chat; attempt++) {
    const answer = (await ui.readLine({ prompt: 'Press Enter when done: ' }))?.trim();
    if (answer === undefined) return undefined;
    if (/^-?\d+$/.test(answer)) {
      chat = { id: answer };
      break;
    }
    chat = await findChat(api);
    if (!chat) {
      ui.say(
        `I don’t see a message to @${bot.username} yet. Send it one and press Enter again. ` +
          'Or message @userinfobot to get your chat ID, and paste the number here.',
      );
    }
  }
  if (!chat) return undefined;

  // 3. Prove it works.
  try {
    await api.sendMessage(
      chat.id,
      'Dazza is connected. I’ll message you here when a task is ready for review or I need something. ' +
        'You can reply to me here, just like in the terminal.',
    );
  } catch (error) {
    ui.say(`Couldn’t message that chat (${errorMessage(error)}). Run /telegram to try again.`);
    return undefined;
  }
  ui.say(
    `Connected. I just sent ${chat.name ? `${chat.name} ` : 'you '}a test message on Telegram.${PHONE_MERGE_TIP}`,
  );
  return { botToken: bot.token, botUsername: bot.username, chatId: chat.id };
}

/** Said once, at the moment approving from the phone becomes possible. */
const PHONE_MERGE_TIP =
  ' Approve there merges the work; to keep merging to this computer, turn off Approving from your phone merges in /settings.';

/**
 * The private chat that most recently messaged the bot. Reading updates also
 * clears them, so the "/start" doesn't later arrive as a chat message.
 */
async function findChat(
  api: Pick<TelegramApi, 'getUpdates'>,
): Promise<{ id: string; name?: string } | undefined> {
  const updates = await api.getUpdates(undefined, 0).catch(() => []);
  const last = updates.at(-1);
  if (last) await api.getUpdates(last.update_id + 1, 0).catch(() => []);
  const chat = [...updates].reverse().find((u) => u.message?.chat.type === 'private')
    ?.message?.chat;
  return chat
    ? { id: String(chat.id), ...(chat.first_name && { name: chat.first_name }) }
    : undefined;
}
