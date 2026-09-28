import { unwatchFile, watchFile } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { startBoard } from '../board/server.js';
import { type ActionResult, approvePlan, closeTask, requestChanges } from '../core/actions.js';
import { recoverAbandonedBuild } from '../core/builder.js';
import { Config, type Connection } from '../core/config.js';
import { describeCodebase, inspectCodebase } from '../core/inspect.js';
import { Manager } from '../core/manager.js';
import { isComplete, recordMilestones } from '../core/milestones.js';
import { answerPermission } from '../core/permissions.js';
import { reportRequest } from '../core/report.js';
import { StateError, Store } from '../core/store.js';
import type {
  Channel,
  ChannelHandlers,
  ChannelId,
  Remote,
  RemoteCommand,
} from '../notify/channel.js';
import { DesktopNotifier } from '../notify/desktop.js';
import {
  info,
  milestoneNotification,
  type Notification,
  notificationFor,
} from '../notify/notification.js';
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
/** How often to look for plan changes made elsewhere (the board, the build). */
const PLAN_POLL_MS = 500;
/** Let a burst of plan writes settle before reacting to them. */
const PLAN_SETTLE_MS = 300;

/** `dazza`: the conversation with your developer. */
export async function startChat(projectRoot: string): Promise<void> {
  const terminal = new Terminal();
  // A long-running chat shouldn't die over one failed background task: say so and carry on.
  const onRejection = (error: unknown) =>
    say(paint.red(`Something went wrong: ${errorMessage(error)}`));
  process.on('unhandledRejection', onRejection);
  try {
    await chat(projectRoot, terminal);
  } catch (error) {
    if (!(error instanceof StateError)) throw error;
    say(paint.red(error.message));
    process.exitCode = 1;
  } finally {
    process.off('unhandledRejection', onRejection);
    terminal.close();
  }
}

async function chat(projectRoot: string, terminal: Terminal): Promise<void> {
  write = (text) => terminal.print(text);
  console.log(`\n${logo()}\n`);
  const config = new Config();
  const connection = (await config.readConnection()) ?? (await firstConnect(terminal, config));
  if (!connection) {
    say('No problem. Run `dazza` again whenever you’re ready to connect.');
    return;
  }

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
    guard: guardFor(projectRoot, 'manager'),
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
  const hasConversation = (await store.readManagerSession(provider.id)) !== undefined;
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
    workerGuard: guardFor(projectRoot, 'worker'),
    boardUrl: board.url,
    output: {
      say,
      print: (text) => terminal.print(text),
      status: (key, text) => terminal.setStatus(key, text),
    },
    onReply: (reply, origin) => {
      if (origin !== 'terminal') void channels.get(origin.channel)?.reply(reply, origin);
    },
    onChatDone: () => void resumeIfReady(),
    onBuildEvent: (event) => {
      if (event.type === 'task_started') refresh();
      // After waiting out a limit, say when work starts again.
      if (event.type === 'waiting' && event.reason === 'usage_limit') waitingForLimit = true;
      if (event.type === 'task_started' && waitingForLimit) {
        waitingForLimit = false;
        notify(info(`▶ Your limit has reset. Back on ${event.task.id}: ${event.task.title}.`));
      }
      notificationFor(event, store)
        .then((note) => note && notify(note))
        .catch(() => {}); // a notification is a nicety; the terminal shows the event anyway
    },
    onStartBuild: () => void startBuild(session, provider, config),
    onBuildEnd: () => {
      refresh();
      void resumeIfReady();
    },
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
  /** What the user did from their phone, echoed in the terminal. */
  const fromPhone =
    (where: string) =>
    (result: ActionResult): ActionResult => {
      say(paint.dim(`📱 From ${where}: ${result.message}`));
      return result;
    };
  /** Everything a channel can do for the user: the same actions as the terminal and board. */
  const handlersFor = (where: string): ChannelHandlers => ({
    onMessage: fromRemote,
    onCommand: remoteCommand,
    onApprove: async (taskId) => fromPhone(where)(await closeTask(store, taskId)),
    onRequestChanges: async (taskId, note) =>
      fromPhone(where)(await requestChanges(store, taskId, note)),
    onPermission: async (taskId, allow) =>
      fromPhone(where)(await answerPermission(store, taskId, allow)),
    onProblem: (text) => say(paint.dim(text)),
  });

  const openChannels = async () => {
    const telegram = await config.readTelegram();
    if (telegram) channels.set('telegram', new TelegramBridge(telegram, handlersFor('Telegram')));
    const slack = await config.readSlack();
    if (slack) {
      channels.set(
        'slack',
        new SlackBridge(
          slack,
          {
            ...handlersFor('Slack'),
            onApprovePlan: async () => fromPhone('Slack')(await approvePlan(store)),
            home: async () => ({
              project: basename(projectRoot),
              plan: await store.readPlan(),
              building: session.isBuilding,
              boardUrl: board.url,
            }),
          },
          { lockFile: config.slackLockFile },
        ),
      );
    }
    if ((await config.readSettings()).desktopNotifications !== false) {
      channels.set('desktop', new DesktopNotifier(projectRoot));
    }
    for (const channel of channels.values()) channel.start();
  };
  const closeChannels = async () => {
    await Promise.all([...channels.values()].map((channel) => channel.stop()));
    channels.clear();
  };
  await openChannels();

  /**
   * Pick the build back up when a task becomes ready (say, the user answered a
   * blocked task, here or on the board or their phone), if they'd been building.
   */
  /** A slash command is running: auto-resume waits for it to finish. */
  let commandRunning = false;
  const resumeIfReady = async () => {
    // Mid-command (say, /accept merging) or mid-reply, wait: their words come first.
    if (commandRunning || session.isChatting) return;
    const taskId = await session.resumeIfReady().catch(() => undefined);
    if (!taskId) return;
    const text = `▶ ${taskId} is ready, so I’ve picked the build back up.`;
    say(paint.dim(text));
    notify(info(text, [], taskId));
  };
  /** Ask Dazza to write the report, with the facts it needs. */
  const requestReport = async () => {
    const plan = await store.readPlan();
    if (!plan) return;
    session.send(reportRequest(plan, await store.readEvents(), await store.readScope()));
  };

  // The plan changes from everywhere: this chat, the board, Slack, the build itself.
  const startPlan = await store.readPlan();
  let approved = Boolean(startPlan?.approvedAt);
  let complete = Boolean(startPlan && isComplete(startPlan));
  // Milestones reached before this session were announced then.
  const announced = new Set(
    (await store.readEvents()).filter((e) => e.type === 'milestone_reached').map((e) => e.message),
  );
  const onPlanChange = debounce(async () => {
    const plan = await store.readPlan().catch(() => undefined);
    if (!plan) return;
    // Approved in the chat: Dazza's reply already says what's next.
    if (plan.approvedAt && !approved && !session.isBuilding && !session.isChatting) {
      say(`Plan approved. Run ${paint.bold('/build')} when you want me to start.`);
    }
    approved = Boolean(plan.approvedAt);

    // Closing a task (here, on the board or from a phone) can complete a milestone.
    await recordMilestones(store).catch(() => []);
    for (const event of await store.readEvents()) {
      if (event.type !== 'milestone_reached' || announced.has(event.message)) continue;
      announced.add(event.message);
      const milestone = plan.milestones.find((m) => event.message.startsWith(`${m.id}:`));
      if (!milestone) continue;
      const note = milestoneNotification(plan, milestone, store);
      say(`${paint.bold(`🏁 ${milestone.id} reached: ${milestone.title}`)}\n${milestone.goal}`);
      notify(note);
    }

    // The last task closed: wrap the project up.
    if (!complete && isComplete(plan)) {
      complete = true;
      say(`All done. Writing up the close-out report…`);
      notify(
        info(
          '🎉 Every task is closed. I’m writing up the close-out report; it’ll be on the board shortly.',
        ),
      );
      await requestReport();
    }
    await resumeIfReady();
  }, PLAN_SETTLE_MS);
  const planFile = join(store.dir, 'tasks.json');
  watchFile(planFile, { interval: PLAN_POLL_MS }, () => void onPlanChange());

  let exiting = false;
  const context: CommandContext = {
    store,
    config,
    provider,
    connection,
    session: session.usage,
    boardUrl: board.url,
    startBuild: () => startBuild(session, provider, config),
    requestReport,
    stopBuild: async () => {
      if (!session.isBuilding) return say('Not building right now.');
      // A paused task reports itself; only say so when nothing was underway.
      if (!(await session.stopBuild())) say('Stopped.');
    },
    confirm: async (question) =>
      (await terminal.select(question, [
        { label: 'Yes', value: true },
        { label: 'No', value: false },
      ])) === true,
    status: (text) => terminal.setStatus('chat', text),
    link: async (channel) => {
      if (await setUpChannel(channel, terminal, config)) {
        await closeChannels();
        await openChannels();
      }
    },
    reconnect: async () => {
      await closeChannels();
      await openChannels();
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
    // Pastes expand to many lines; the one-line editor can't show those again.
    if (line && !line.includes('\n') && line !== history.at(-1)) history.push(line);

    if (isCommand(line)) {
      commandRunning = true;
      await runCommand(line, context);
      commandRunning = false;
      await resumeIfReady();
    } else if (line) session.send(line);
  }

  await session.stopBuild();
  await session.stopChat();
  unwatchFile(planFile);
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
  say(paint.dim('Building in the background. Keep talking to me while I work; /stop stops it.'));
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

/** "/model sonnet" is a command; "/Users/sam/app is broken" is a message. */
function isCommand(line: string): boolean {
  return /^\/[\w-]+(\s|$)/.test(line);
}

/** Where Dazza's words go: the terminal once the chat starts, so they print around the input. */
let write: (text: string) => void = (text) => console.log(text);

/** Print Dazza's words with a little breathing room, indented under a marker. */
function say(text: string): void {
  const [first = '', ...rest] = text.trim().split('\n');
  const body = rest.map((line) => (line.trim() ? `\n  ${line}` : '\n')).join('');
  write(`\n${paint.hex(BRAND, '●')} ${first}${body}\n`);
}

/** How an agent runs Dazza's guard before each tool call. */
function guardFor(projectRoot: string, role: 'manager' | 'worker') {
  return {
    command: process.execPath,
    args: [cliPath(), 'guard', '--root', projectRoot, '--role', role],
  };
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

function debounce(fn: () => Promise<void>, ms: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => void fn(), ms);
  };
}
