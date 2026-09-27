import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { SlackLink } from '../core/config.js';
import { SlackApi, SlackError } from '../slack/api.js';
import { welcomeMessage } from '../slack/blocks.js';
import { createAppUrl } from '../slack/manifest.js';
import { type Envelope, SocketMode } from '../slack/socket.js';
import { openInBrowser } from '../util/open.js';
import type { SetupUI } from './connect.js';

const ATTEMPTS = 3;
/** How long to wait for the user's first message after they press Enter. */
const MESSAGE_WAIT_MS = 8_000;

/** Someone messaging the bot in a DM. */
export interface DirectMessage {
  user: string;
  channel: string;
}

export interface SlackSetupDeps {
  api(token: string): Pick<SlackApi, 'authTest' | 'appIdOf' | 'openConnection' | 'postMessage'>;
  /** Listen for DMs to the bot over Socket Mode, until stopped. */
  listen(appToken: string, onMessage: (message: DirectMessage) => void): { stop(): Promise<void> };
  openUrl(url: string): void;
}

const defaultDeps: SlackSetupDeps = {
  api: (token) => new SlackApi(token),
  listen: (appToken, onMessage) => {
    const socket = new SocketMode({
      open: () => new SlackApi(appToken).openConnection(),
      onEnvelope: (envelope) => {
        const message = directMessage(envelope);
        if (message) onMessage(message);
      },
      onFatal: () => {},
    });
    socket.start();
    return socket;
  },
  openUrl: openInBrowser,
};

/**
 * Link Dazza's Slack app: create it from a prefilled manifest, install it, take
 * its two tokens, then find the user by waiting for their first DM to the bot.
 * Ends with a welcome message in that DM. Resolves undefined if abandoned.
 */
export async function connectSlack(
  ui: SetupUI,
  deps: SlackSetupDeps = defaultDeps,
): Promise<SlackLink | undefined> {
  // 1. Create and install the app; take the bot token.
  const createUrl = createAppUrl();
  ui.say(
    [
      'First, create Dazza’s Slack app. I’ve opened Slack with everything it needs filled in:',
      '1. Pick your workspace, press Next, then Create',
      '2. Press Install to Workspace, then Allow',
      '3. Copy the Bot User OAuth Token it shows you (it starts with xoxb-) and paste it here.',
      `If the page didn’t open: ${createUrl}`,
    ].join('\n'),
  );
  deps.openUrl(createUrl);

  let bot: { token: string; teamId: string; team: string; appId: string } | undefined;
  for (let attempt = 1; attempt <= ATTEMPTS && !bot; attempt++) {
    const token = (await ui.readLine({ prompt: 'Bot token: ', mask: true }))?.trim();
    if (!token) return undefined;
    if (!token.startsWith('xoxb-')) {
      ui.say(
        token.startsWith('xapp-')
          ? 'That’s the app-level token, which comes next. First I need the Bot User OAuth Token, which starts with xoxb-.'
          : 'Bot tokens start with xoxb-. Find it under OAuth & Permissions in the app’s settings.',
      );
      continue;
    }
    try {
      const api = deps.api(token);
      const who = await api.authTest();
      if (!who.botId) throw new SlackError('not_allowed_token_type');
      bot = { token, teamId: who.teamId, team: who.team, appId: await api.appIdOf(who.botId) };
      ui.say(`Found Dazza in ${who.team}.`);
    } catch (error) {
      ui.say(`That didn’t work: ${errorMessage(error)}. Copy the whole token and try again.`);
    }
  }
  if (!bot) return undefined;

  // 2. The app-level token, for Socket Mode.
  const settingsUrl = `https://api.slack.com/apps/${bot.appId}/general`;
  ui.say(
    [
      'Next, a token that lets Dazza hear from you without a public server. I’ve opened the app’s settings:',
      '1. Scroll to App-Level Tokens and press Generate Token and Scopes',
      '2. Name it "dazza", add the connections:write scope, and press Generate',
      '3. Copy the token (it starts with xapp-) and paste it here.',
      `If the page didn’t open: ${settingsUrl}`,
    ].join('\n'),
  );
  deps.openUrl(settingsUrl);

  let appToken: string | undefined;
  for (let attempt = 1; attempt <= ATTEMPTS && !appToken; attempt++) {
    const token = (await ui.readLine({ prompt: 'App-level token: ', mask: true }))?.trim();
    if (!token) return undefined;
    if (!token.startsWith('xapp-')) {
      ui.say('App-level tokens start with xapp-. It’s under Basic Information → App-Level Tokens.');
      continue;
    }
    try {
      await deps.api(token).openConnection();
      appToken = token;
    } catch (error) {
      ui.say(
        error instanceof SlackError && error.code === 'missing_scope'
          ? 'That token is missing the connections:write scope. Generate one with it, and paste that.'
          : `That didn’t work: ${errorMessage(error)}. Copy the whole token and try again.`,
      );
    }
  }
  if (!appToken) return undefined;

  // 3. Find the user: the first person to DM the bot is who Dazza works for.
  let found: DirectMessage | undefined;
  const listener = deps.listen(appToken, (message) => {
    found ??= message;
  });
  try {
    const dmUrl = `https://slack.com/app_redirect?app=${bot.appId}&team=${bot.teamId}`;
    ui.say(
      [
        'Last step. I’ve opened Dazza in Slack: send it any message, like "hi".',
        'Then press Enter here.',
        `If it didn’t open: ${dmUrl}`,
      ].join('\n'),
    );
    deps.openUrl(dmUrl);
    for (let attempt = 1; attempt <= ATTEMPTS && !found; attempt++) {
      if ((await ui.readLine({ prompt: 'Press Enter when done: ' })) === undefined)
        return undefined;
      for (let waited = 0; !found && waited < MESSAGE_WAIT_MS; waited += 250) await sleep(250);
      if (!found) {
        ui.say(
          'I haven’t seen your message yet. Send one in Dazza’s Messages tab and press Enter again. ' +
            'If Slack says you can’t message the app, reload Slack (Cmd-R or Ctrl-R) and try again.',
        );
      }
    }
  } finally {
    await listener.stop();
  }
  if (!found) return undefined;

  // 4. Say hello where the user will hear from Dazza.
  try {
    await deps.api(bot.token).postMessage({ channel: found.channel, ...welcomeMessage() });
  } catch (error) {
    ui.say(`Couldn’t message you in Slack (${errorMessage(error)}). Run /slack to try again.`);
    return undefined;
  }
  ui.say(`Connected to ${bot.team}. I just said hello in Slack.`);
  return {
    botToken: bot.token,
    appToken,
    appId: bot.appId,
    teamId: bot.teamId,
    teamName: bot.team,
    userId: found.user,
    channelId: found.channel,
  };
}

/** A person's message in a DM with the bot, from a Socket Mode delivery. */
export function directMessage(envelope: Envelope): DirectMessage | undefined {
  if (envelope.type !== 'events_api') return undefined;
  const parsed = DmPayload.safeParse(envelope.payload);
  if (!parsed.success) return undefined;
  const { event } = parsed.data;
  // Edits, joins and the bot's own posts aren't someone saying hello.
  if (event.subtype || event.bot_id) return undefined;
  return { user: event.user, channel: event.channel };
}

const DmPayload = z.object({
  event: z.object({
    type: z.literal('message'),
    channel_type: z.literal('im'),
    user: z.string(),
    channel: z.string(),
    subtype: z.string().optional(),
    bot_id: z.string().optional(),
  }),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
