import { homedir } from 'node:os';
import { basename } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { startBoard } from '../board/server.js';
import { type ActionResult, approvePlan, closeTask, requestChanges } from '../core/actions.js';
import { recoverAbandonedBuild } from '../core/builder.js';
import { Config, type Connection } from '../core/config.js';
import { describeCodebase, inspectCodebase } from '../core/inspect.js';
import { Manager } from '../core/manager.js';
import { Store } from '../core/store.js';
import {
  type Channel,
  type ChannelId,
  isRemoteCommand,
  type Remote,
  type RemoteCommand,
} from '../notify/channel.js';
import { info, type Notification, notificationFor } from '../notify/notification.js';
import { createProvider, PROVIDER_HELP, providerFor } from '../providers/index.js';
import type { AgentProvider } from '../providers/types.js';
import { checkApiKey } from '../setup/apiKeys.js';
import { connect } from '../setup/connect.js';
import { connectSlack } from '../setup/slack.js';
import { connectTelegram } from '../setup/telegram.js';
import { SlackBridge } from '../slack/bridge.js';
import { TelegramBridge } from '../telegram/bridge.js';
import { BRAND, logo, sessionInfo } from './banner.js';
import { type CommandContext, commandMenu, parseCommand, suggest } from './commands.js';
import { greeting } from './describe.js';
import { ChatSession } from './session.js';
import { paint, stripAnsi } from './style.js';
import { Terminal } from './terminal.js';

const PROMPT = `${paint.hex(BRAND, '›')} `;

/** `dazza`: the conversation with your developer. */
export async function startChat(projectRoot: string): Promise<void> {
  const terminal = new Terminal();
  try {
    await chat(projectRoot, terminal);
  } finally {
    terminal.close();
  }
}

async function chat(projectRoot: string, terminal: Terminal): Promise<void> {
  write = (text) => terminal.print(text);
  console.log(`\n${logo()}\n`);
  const config = new Config();
  const connection = (await config.readConnection()) ?? (await firstConnect(terminal, config));
  if (!connection) return;

  const provider = createProvider(connection);
  const status = await provider.detect();
  if (!status.installed || (connection.method === 'subscription' && !status.loggedIn)) {
    const help = PROVIDER_HELP[provider.id];
    say(
      paint.red(
        status.installed
          ? `Your ${provider.name} sign-in has expired. Run ${help.signIn} to sign in, then start Dazza again.`
          : `Dazza needs ${provider.name} installed (${help.install}). Run \`dazza doctor\` for details.`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const store = new Store(projectRoot);
  // So the greeting doesn't claim a build is running when the Dazza running it died.
  await recoverAbandonedBuild(store);
  const found = await inspectCodebase(projectRoot);
  const codebase = found && describeCodebase(found);
  const board = await startBoard(store, projectRoot);
  const manager = new Manager({
    store,
    config,
    provider,
    projectRoot,
    mcpServer: { command: process.execPath, args: [cliPath(), 'mcp', '--root', projectRoot] },
    ...(codebase && { codebase }),
  });

  const { model } = await config.readSettings();
  const plan = connection.method === 'api-key' ? 'API key' : status.plan;
  console.log(
    `${sessionInfo({
      version: pkg.version,
      agent: [provider.name, plan, model && `model: ${model}`].filter(Boolean).join(' · '),
      cwd: projectRoot.replace(homedir(), '~'),
      board: board.url,
    })}`,
  );
  const hasConversation = (await store.readManagerSession()) !== undefined;
  say(greeting(await store.readPlan(), { hasConversation, ...(codebase && { codebase }) }));

  // Slack and Telegram: notifications out, the user's messages in, same conversation.
  const channels = new Map<ChannelId, Channel>();
  const notify = (note: Notification) => {
    for (const channel of channels.values()) void channel.notify(note);
  };
  const refresh = () => {
    for (const channel of channels.values()) channel.refresh();
  };
  let waitingForLimit = false;
  const session: ChatSession = new ChatSession({
    store,
    config,
    provider,
    manager,
    workerMcp: {
      command: process.execPath,
      args: [cliPath(), 'mcp', '--root', projectRoot, '--role', 'worker'],
    },
    boardUrl: board.url,
    output: {
      say,
      print: (text) => terminal.print(text),
      status: (key, text) => terminal.setStatus(key, text),
    },
    onReply: (reply, origin) => {
      if (origin !== 'terminal') void channels.get(origin.channel)?.reply(reply, origin);
    },
    onBuildEvent: (event) => {
      if (event.type === 'task_started') refresh();
      // After waiting out a limit, say when work starts again.
      if (event.type === 'waiting' && event.reason === 'usage_limit') waitingForLimit = true;
      if (event.type === 'task_started' && waitingForLimit) {
        waitingForLimit = false;
        notify(info(`▶ Your limit has reset. Back on ${event.task.id}: ${event.task.title}.`));
      }
      void notificationFor(event, store).then((note) => note && notify(note));
    },
    onBuildEnd: refresh,
    onShare: ({ taskId, text, images }) => {
      notify(
        info(
          `📸 ${taskId ? `${taskId}: ` : ''}${text}`,
          images.map((path) => store.mediaFile(path)),
          taskId,
        ),
      );
    },
  });

  /** Status, build and stop work from a phone too. */
  const remoteCommand = async (command: RemoteCommand): Promise<string> => {
    switch (command) {
      case 'status':
        return stripAnsi(greeting(await store.readPlan(), { hasConversation: true }));
      case 'build':
        await startBuild(session, provider, config);
        return session.isBuilding
          ? 'Building. I’ll message you as tasks are ready.'
          : 'I couldn’t start the build; check the terminal.';
      case 'stop':
        if (!session.isBuilding) return 'Not building right now.';
        await session.stopBuild();
        return 'Stopped the build. The current task picks up where it left off next time.';
    }
  };
  /** A message from the user's phone: shown in the terminal, answered where it came from. */
  const fromRemote = (text: string, from: Remote) => {
    const where = from.channel === 'slack' ? 'Slack' : 'Telegram';
    terminal.print(`\n${paint.dim(`📱 You, on ${where}: ${text}`)}`);
    session.send(text, from);
  };
  /** Something the user did on Slack, echoed in the terminal. */
  const fromSlack = (result: ActionResult): ActionResult => {
    say(paint.dim(`📱 From Slack: ${result.message}`));
    return result;
  };

  const openChannels = async () => {
    const telegram = await config.readTelegram();
    if (telegram) {
      const bridge: TelegramBridge = new TelegramBridge(telegram, {
        onMessage: (text) => {
          const command = text.trim().toLowerCase().replace(/^\//, '');
          if (text.trim().startsWith('/') && isRemoteCommand(command)) {
            void remoteCommand(command).then((reply) => bridge.send(reply));
          } else {
            fromRemote(text, { channel: 'telegram' });
          }
        },
        onProblem: (text) => say(paint.dim(text)),
      });
      channels.set('telegram', bridge);
    }
    const slack = await config.readSlack();
    if (slack) {
      channels.set(
        'slack',
        new SlackBridge(
          slack,
          {
            onMessage: fromRemote,
            onCommand: remoteCommand,
            onApprove: async (taskId) => fromSlack(await closeTask(store, taskId)),
            onRequestChanges: async (taskId, note) =>
              fromSlack(await requestChanges(store, taskId, note)),
            onApprovePlan: async () => fromSlack(await approvePlan(store)),
            home: async () => ({
              project: basename(projectRoot),
              plan: await store.readPlan(),
              building: session.isBuilding,
              boardUrl: board.url,
            }),
            onProblem: (text) => say(paint.dim(text)),
          },
          { lockFile: config.slackLockFile },
        ),
      );
    }
    for (const channel of channels.values()) channel.start();
  };
  const closeChannels = async () => {
    await Promise.all([...channels.values()].map((channel) => channel.stop()));
    channels.clear();
  };
  await openChannels();

  let exiting = false;
  const context: CommandContext = {
    store,
    config,
    provider,
    connection,
    session: session.usage,
    boardUrl: board.url,
    startBuild: () => startBuild(session, provider, config),
    status: (text) => terminal.setStatus('chat', text),
    link: async (channel) => {
      if (await setUpChannel(channel, terminal, config)) {
        await closeChannels();
        await openChannels();
      }
    },
    unlink: async (channel) => {
      await closeChannels();
      await (channel === 'slack' ? config.clearSlack() : config.clearTelegram());
      await openChannels();
    },
    say,
    exit: () => {
      exiting = true;
    },
  };

  const history: string[] = [];
  while (!exiting) {
    const input = await terminal.readLine({ prompt: PROMPT, menu: commandMenu, history });
    if (input === undefined) {
      // Piped input ran out: let queued work finish. In a terminal, Ctrl-C stops
      // whatever is running first, and only exits once nothing is.
      if (!terminal.interactive) await session.idle();
      else if (session.isBuilding) {
        await session.stopBuild();
        continue;
      } else if (session.isChatting) {
        await session.stopChat();
        continue;
      }
      break;
    }
    const line = input.trim();
    if (line && line !== history.at(-1)) history.push(line);

    if (line.startsWith('/')) await runCommand(line, context);
    else if (line) session.send(line);
  }

  await session.stopBuild();
  await session.stopChat();
  await closeChannels();
  board.close();
}

/** /build: check the model can work on its own, then build in the background. */
async function startBuild(
  session: ChatSession,
  provider: AgentProvider,
  config: Config,
): Promise<void> {
  if (session.isBuilding) {
    say('Already building. Keep talking to me, or Ctrl-C to stop the build.');
    return;
  }
  const models = await provider.listModels();
  const chosen = (await config.readSettings()).model;
  const model = models.find((m) => m.id === chosen) ?? models[0];
  if (model && !model.autonomous) {
    say(
      `${model.name} can’t build on its own: it doesn’t support ${provider.name}’s auto mode. ` +
        'Switch to one that does, like Opus or Sonnet, with /model.',
    );
    return;
  }
  session.startBuild();
  say(
    paint.dim(
      'Building in the background. Keep talking to me while I work; Ctrl-C stops the build.',
    ),
  );
}

/** First launch, or after /logout: pick how Dazza connects, and remember it. */
async function firstConnect(terminal: Terminal, config: Config): Promise<Connection | undefined> {
  const connection = await connect(
    {
      say,
      select: (question, choices) => terminal.select(question, choices),
      readLine: (options) => terminal.readLine(options),
    },
    {
      detect: (id) => providerFor(id).detect(),
      signIn: (id) => terminal.handOver(() => providerFor(id).signIn()),
      checkApiKey: (id, key) => checkApiKey(id, key),
    },
  );
  if (connection) {
    await config.writeConnection(connection);
    // First run: offer a way to hear from Dazza when away, once.
    const { messagingSkipped } = await config.readSettings();
    const linked = (await config.readSlack()) || (await config.readTelegram());
    if (!messagingSkipped && !linked) {
      say(
        'Dazza can message you when a task is ready for review or it needs you, ' +
          'and you can answer from your phone.',
      );
      const channel = await terminal.select<ChannelId | undefined>('Where should I message you?', [
        { label: 'Slack', hint: 'a DM from Dazza, with buttons to approve work', value: 'slack' },
        { label: 'Telegram', hint: 'a bot of your own', value: 'telegram' },
        { label: 'Skip for now', hint: 'run /slack or /telegram any time', value: undefined },
      ]);
      if (!channel || !(await setUpChannel(channel, terminal, config))) {
        await config.updateSettings({ messagingSkipped: true });
      }
    }
  }
  return connection;
}

/** Link Slack or a Telegram bot through the terminal, and save it. Resolves whether it worked. */
async function setUpChannel(
  channel: ChannelId,
  terminal: Terminal,
  config: Config,
): Promise<boolean> {
  const ui = {
    say,
    select: <T>(question: string, choices: { label: string; hint?: string; value: T }[]) =>
      terminal.select(question, choices),
    readLine: (options: { prompt: string; mask?: boolean }) => terminal.readLine(options),
  };
  if (channel === 'slack') {
    const link = await connectSlack(ui);
    if (link) await config.writeSlack(link);
    return Boolean(link);
  }
  const link = await connectTelegram(ui, { optional: false });
  if (link) await config.writeTelegram(link);
  return Boolean(link);
}

async function runCommand(line: string, context: CommandContext): Promise<void> {
  const { command, name, args } = parseCommand(line);
  if (!command) {
    const hint = suggest(name);
    say(paint.dim(`No command /${name}.${hint ? ` Did you mean /${hint.name}?` : ''} Try /help.`));
    return;
  }
  try {
    await command.run(context, args);
  } catch (error) {
    say(paint.red(`/${command.name} failed: ${errorMessage(error)}`));
  }
}

/** Where Dazza's words go: the terminal once the chat starts, so they print around the input. */
let write: (text: string) => void = (text) => console.log(text);

/** Print Dazza's words with a little breathing room, indented under a marker. */
function say(text: string): void {
  const [first = '', ...rest] = text.trim().split('\n');
  const body = rest.map((line) => (line.trim() ? `\n  ${line}` : '\n')).join('');
  write(`\n${paint.hex(BRAND, '●')} ${first}${body}\n`);
}

/** Path of the running CLI, so the agent can launch our MCP server with the same build. */
function cliPath(): string {
  const path = process.argv[1];
  if (!path) throw new Error('Cannot determine the dazza executable path');
  return path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
