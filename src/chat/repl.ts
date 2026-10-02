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
import { mergeAtTheComputer, phoneMayMerge } from '../core/phoneMerge.js';
import { reportRequest } from '../core/report.js';
import { StateError, Store } from '../core/store.js';
import { newerDazza, updateNotice } from '../core/updates.js';
import { gitInstall, hasGit } from '../git/install.js';
import { checkJevKey } from '../jev/providers.js';
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
import type { AgentProvider, ProviderStatus } from '../providers/types.js';
import { checkApiKey } from '../setup/apiKeys.js';
import {
  connect,
  ensureReady,
  INSTALL_PACKAGES,
  type SetupDeps,
  type SetupUI,
} from '../setup/connect.js';
import { connectSlack } from '../setup/slack.js';
import { connectTelegram } from '../setup/telegram.js';
import { SlackBridge } from '../slack/bridge.js';
import { TelegramBridge } from '../telegram/bridge.js';
import { debounce } from '../util/debounce.js';
import { shownPath } from '../util/paths.js';
import { runInteractive } from '../util/process.js';
import { errorMessage } from '../util/text.js';
import { fileMenu, listProjectFiles, pasteClipboardImage, pointedAt } from './attachments.js';
import {
  markRunning,
  startInBackground,
  stopInBackground,
  waitInBackground,
} from './background.js';
import { BRAND, logo, sessionInfo } from './banner.js';
import { type CommandContext, commandMenu, parseCommand, suggest } from './commands.js';
import { greeting, NO_PLAN } from './describe.js';
import { offerJev } from './jev.js';
import { projectEstimate } from './progress.js';
import { ChatSession } from './session.js';
import { runShell } from './shell.js';
import { paint, stripAnsi } from './style.js';
import { Terminal } from './terminal.js';

/** Messages with more lines than this (big pastes, usually) aren't kept for ↑. */
const MAX_RECALLED_LINES = 20;
/** How often the @ menu's file list is refreshed. */
const FILE_LIST_REFRESH_MS = 3 * 60_000;
const PROMPT = `${paint.hex(BRAND, '›')} `;
/** How often to look for plan changes made elsewhere (the board, the build). */
const PLAN_POLL_MS = 500;
/** Let a burst of plan writes settle before reacting to them. */
const PLAN_SETTLE_MS = 300;

/** `dazza`: the conversation with your developer. */
export interface ChatOptions {
  /** Pick up the last conversation (`dazza --continue`), instead of starting a new one. */
  continue?: boolean;
  /** Run as the background build a closed terminal handed over to (`/background on`). */
  background?: boolean;
}

export async function startChat(projectRoot: string, options: ChatOptions = {}): Promise<void> {
  const terminal = new Terminal();
  // A long-running chat shouldn't die over one failed background task: say so and carry on.
  const onRejection = (error: unknown) =>
    say(paint.red(`Something went wrong: ${errorMessage(error)}`));
  process.on('unhandledRejection', onRejection);
  try {
    await chat(projectRoot, terminal, options);
  } catch (error) {
    if (!(error instanceof StateError)) throw error;
    say(paint.red(error.message));
    process.exitCode = 1;
  } finally {
    process.off('unhandledRejection', onRejection);
    terminal.close();
  }
}

async function chat(projectRoot: string, terminal: Terminal, options: ChatOptions): Promise<void> {
  write = (text) => terminal.print(text);
  console.log(`\n${logo()}\n`);
  const config = new Config();
  // Asked now, shown with the banner: it runs alongside the checks below.
  const update = newerDazza(config);
  const connection =
    (await config.readConnection()) ??
    (options.background ? undefined : await firstConnect(terminal, config));
  if (!connection) {
    say('Not connected yet. Run `dazza` again whenever you’re ready.');
    return;
  }

  const provider = createProvider(connection);
  // Nobody to answer (the background build, or input that isn't a terminal): say what's wrong.
  const status =
    options.background || !process.stdin.isTTY
      ? await readyInBackground(provider, connection)
      : await ensureReady(setupUI(terminal), setupDeps(terminal), connection);
  if (!status?.installed) {
    process.exitCode = 1;
    return;
  }

  if (!options.background) await offerGit(terminal, process.stdin.isTTY === true);

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
  const newer = await update;
  if (newer) console.log(paint.amber(updateNotice(newer)));
  // Taking the build back from the background: stop it there first.
  const tookOver = !options.background && (await stopInBackground(store));
  // A new conversation each time, as in Claude Code; --continue picks up the last one.
  // The background build keeps the conversation it was handed.
  if (options.background) {
    // (no new conversation)
  } else if (!options.continue) await store.newConversation();
  else if (!(await store.readManagerSession(provider.id)))
    await store.continueConversation(provider.id);
  const hasConversation = (await store.readManagerSession(provider.id)) !== undefined;
  const canContinue = !hasConversation && (await store.hasPreviousConversation(provider.id));
  say(
    greeting(await store.readPlan(), {
      ...(await projectEstimate(store, config)),
      hasConversation,
      canContinue,
      // A folder with no code yet gets the new-project greeting.
      ...(codebase && found?.languages.length && { codebase }),
    }),
  );

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
      draft: (text) => terminal.setDraft(text),
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
      config
        .readSettings()
        .then((settings) => notificationFor(event, store, settings.parallelTasks))
        .then((note) => note && notify(note))
        .catch(() => {}); // a notification is a nicety; the terminal shows the event anyway
    },
    onStartBuild: () => void startBuild(session, provider, config, store),
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
        return stripAnsi(
          greeting(await store.readPlan(), {
            ...(await projectEstimate(store, config)),
            remote: true,
          }),
        );
      case 'build':
        return stripAnsi(await startBuild(session, provider, config, store));
      case 'stop':
        if (!session.isOnTheJob) return 'Not building right now.';
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
    onApprove: async (taskId) =>
      fromPhone(where)(
        (await phoneMayMerge(config)) ? await closeTask(store, taskId) : mergeAtTheComputer(taskId),
      ),
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
    startBuild: async () => {
      await startBuild(session, provider, config, store);
    },
    requestReport,
    building: () => session.isOnTheJob,
    compact: () => session.compact(),
    chatting: () => session.isChatting,
    context: () => session.context,
    resetContext: () => session.resetContext(),
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
    select: (question, choices) => terminal.select(question, choices),
    readLine: (options) => terminal.readLine(options),
    checkJevKey: (link) => checkJevKey(link),
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

  // @ offers the project's files; listed once now, and again every few minutes.
  let files: string[] = await listProjectFiles(projectRoot);
  const refreshFiles = setInterval(() => {
    void listProjectFiles(projectRoot).then((found) => {
      files = found;
    });
  }, FILE_LIST_REFRESH_MS);
  refreshFiles.unref();
  const mentionMenu = fileMenu(() => files);
  // ↑ reaches what was typed in earlier sessions too, as in Claude Code.
  const history: string[] = await store.readHistory();

  if (options.background) {
    // The background build: no terminal, just the work, until there's a reason to stop.
    const done = await markRunning(store);
    await startBuild(session, provider, config, store);
    const reason = await waitInBackground({
      onTheJob: () => session.isOnTheJob,
      allDone: async () => {
        const plan = await store.readPlan();
        return Boolean(plan?.tasks.every((t) => t.status === 'closed' || t.status === 'cancelled'));
      },
      lastActivity: async () =>
        Date.parse((await store.readEvents()).at(-1)?.at ?? '') || Date.now(),
    });
    notify(info(`⏹ Stopped building in the background: ${reason}.`));
    say(`Stopped building in the background: ${reason}.`);
    await done();
    exiting = true;
  } else if (tookOver) {
    say('Took the build back from the background. It carries on here; /stop stops it.');
    await startBuild(session, provider, config, store);
  }

  // Closing the terminal window: leave as /exit would, handing the build to the
  // background if that's switched on.
  let hungUp = false;
  const onHangup = () => {
    hungUp = true;
    exiting = true;
    terminal.cancelRead();
  };
  process.once('SIGHUP', onHangup);

  while (!exiting) {
    const input = await terminal.readLine({
      prompt: PROMPT,
      menu: (text) => (text.startsWith('/') ? commandMenu(text) : mentionMenu(text)),
      history,
      pasteImage: async () => {
        const saved = await pasteClipboardImage(join(store.dir, 'media', 'pasted'));
        return saved && `${shownPath(projectRoot, saved)} `;
      },
      // Esc stops Dazza's reply (not the build), as it does in Claude Code.
      onInterrupt: () => {
        if (session.isChatting) void session.stopChat();
      },
    });
    if (input === undefined) {
      if (hungUp) break;
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
    // Pastes expand to many lines; long ones aren't worth recalling whole.
    if (line && line.split('\n').length <= MAX_RECALLED_LINES && line !== history.at(-1)) {
      history.push(line);
      await store.appendHistory(line).catch(() => {});
    }

    if (line.startsWith('!') && line.length > 1) {
      // `!` mode: the user's own command, in their own shell; Dazza hears about it next time.
      commandRunning = true;
      const stop = new AbortController();
      terminal.cancelBusy = () => stop.abort();
      const run = await runShell(
        line.slice(1).trim(),
        projectRoot,
        (out) => terminal.print(`  ${out}`),
        stop.signal,
      );
      terminal.cancelBusy = undefined;
      if (run.exitCode !== 0) say(paint.dim(`Exited with ${run.exitCode ?? 'Ctrl-C'}.`));
      session.noteShell(run);
      commandRunning = false;
      await resumeIfReady();
    } else if (isCommand(line)) {
      commandRunning = true;
      await runCommand(line, context);
      commandRunning = false;
      await resumeIfReady();
    } else if (line) {
      // Files it was pointed at (@mentions, dragged-in screenshots) go along named.
      const note = pointedAt(line, projectRoot);
      session.send(note ? `${line}\n\n(${note})` : line);
    }
  }

  process.off('SIGHUP', onHangup);
  // Leaving with work under way and /background on: hand it over rather than stop it.
  const wasOnTheJob = session.isOnTheJob;
  const handOff =
    !options.background && wasOnTheJob && (await config.readSettings()).backgroundBuild === true;
  await session.stopBuild();
  await session.stopChat();
  unwatchFile(planFile);
  await closeChannels();
  board.close();
  if (handOff) {
    startInBackground(projectRoot, store, cliPath());
    if (!hungUp) {
      say(
        'Still building, in the background. `dazza stop` (or "stop" from your phone) stops it; opening `dazza` here takes it back.',
      );
    }
  } else if (
    wasOnTheJob &&
    !options.background &&
    !hungUp &&
    (await config.firstTime('background'))
  ) {
    // The moment the setting matters: say it exists, once, as they leave.
    say(
      paint.dim(
        'To keep building after you close Dazza next time, turn it on in /settings (Keep building after you close Dazza).',
      ),
    );
  }
}

/** /build: check the model can work on its own, then build in the background. */
async function startBuild(
  session: ChatSession,
  provider: AgentProvider,
  config: Config,
  store: Store,
): Promise<string> {
  /** Say it here, and hand it back for a phone that asked. */
  const tell = (text: string) => {
    say(text);
    return text;
  };
  if (session.isBuilding) return tell('Already building. Keep talking to me; /stop stops it.');
  // Say what's missing before announcing a build that can't happen.
  const plan = await store.readPlan();
  if (!plan) return tell(NO_PLAN);
  if (!plan.approvedAt) {
    return tell('The plan needs your OK first: look it over with /scope, then /approve.');
  }
  const models = await provider.listModels();
  const chosen = (await config.readSettings()).model;
  const model = models.find((m) => m.id === chosen) ?? models[0];
  if (model && !model.autonomous) {
    return tell(
      `${model.name} can’t build on its own: it doesn’t support ${provider.name}’s auto mode. ` +
        'Switch to one that does, like Opus or Sonnet, with /model.',
    );
  }
  session.startBuild();
  say(paint.dim('Building. Keep talking to me while I work; /stop stops it.'));
  return 'Building. I’ll message you as tasks are ready.';
}

/** The terminal, as setup needs it. */
function setupUI(terminal: Terminal): SetupUI {
  return {
    say,
    select: (question, choices) => terminal.select(question, choices),
    readLine: (options) => terminal.readLine(options),
  };
}

/** What setup does on this machine: detect, sign in, install, check keys. */
function setupDeps(terminal: Terminal): SetupDeps {
  return {
    detect: (id) => providerFor(id).detect(),
    signIn: (id) => terminal.handOver(() => providerFor(id).signIn()),
    install: (id) =>
      terminal.handOver(async () => {
        const code = await runInteractive('npm', ['install', '-g', INSTALL_PACKAGES[id]]).catch(
          () => 1,
        );
        return code === 0;
      }),
    checkApiKey: (id, key) => checkApiKey(id, key),
  };
}

/**
 * Building needs git. Planning doesn't, so a missing git is said up front,
 * with the install offered where one command does it, and Dazza carries on.
 */
async function offerGit(terminal: Terminal, canAsk: boolean): Promise<void> {
  if (await hasGit()) return;
  const { how, run } = gitInstall();
  if (!run || !canAsk) {
    say(`Heads up: building needs git, which isn’t installed. ${how} Planning works without it.`);
    return;
  }
  const install = await terminal.select(
    'Heads up: building needs git, which isn’t installed. Install it now?',
    [
      { label: 'Install it', hint: run.label, value: true },
      { label: 'Later', hint: 'planning works without it', value: false },
    ],
  );
  if (!install) {
    say(paint.dim(how));
    return;
  }
  const code = await terminal
    .handOver(() => runInteractive(run.command, run.args))
    .catch(() => undefined);
  say(
    code === 0 && (await hasGit())
      ? 'git is installed.'
      : paint.dim(`When git’s installed, restart Dazza to build. ${how}`),
  );
}

/** In the background nobody can answer a question: say what's wrong, and stop. */
async function readyInBackground(
  provider: AgentProvider,
  connection: Connection,
): Promise<ProviderStatus | undefined> {
  const status = await provider.detect();
  if (status.installed && (connection.method !== 'subscription' || status.loggedIn)) return status;
  const help = PROVIDER_HELP[provider.id];
  say(
    status.installed
      ? `Your ${provider.name} sign-in has expired. Run ${help.signIn} to sign in, then start Dazza again.`
      : `Dazza needs ${provider.name} installed (${help.install}).`,
  );
  return undefined;
}

/** First launch, or after /logout: pick how Dazza connects, and remember it. */
async function firstConnect(terminal: Terminal, config: Config): Promise<Connection | undefined> {
  const connection = await connect(setupUI(terminal), setupDeps(terminal));
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
    // Then Jev, also optional and also asked once.
    await offerJev(
      config,
      {
        say,
        select: (question, choices) => terminal.select(question, choices),
        readLine: (options) => terminal.readLine(options),
      },
      (link) => checkJevKey(link),
    );
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
