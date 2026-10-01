import type { Config, JevLink, Settings } from '../core/config.js';
import {
  JEV_PROVIDER_IDS,
  JEV_PROVIDERS,
  type JevKeyCheck,
  type JevProviderId,
} from '../jev/providers.js';

/**
 * `/jev`: what Jev does for Dazza, each switched on or off by itself, and the
 * key it uses. Jev is a fast classifier: it makes the small decisions (which
 * model a task needs, whether a handoff holds up) so the coding agent doesn't
 * spend its own time and limits on them.
 */

type JevSettings = NonNullable<Settings['jev']>;

export interface JevFeature {
  key: keyof JevSettings;
  label: string;
  /** What it does, in a line. */
  about: string;
}

export const JEV_FEATURES: JevFeature[] = [
  {
    key: 'modelRouting',
    label: 'Model routing',
    about: 'Each task gets the model it needs, never above the one you chose with /model',
  },
  {
    key: 'scopeCheck',
    label: 'Scope check',
    about: 'Sends work back to its builder when the evidence doesn’t show it’s done',
  },
];

/** Whether a feature is on. Connecting Jev was the choice to use it, so unset means on. */
export function jevOn(settings: Settings, key: keyof JevSettings): boolean {
  return settings.jev?.[key] !== false;
}

export interface JevUI {
  say(text: string): void;
  select<T>(
    question: string,
    choices: { label: string; hint?: string; value: T }[],
  ): Promise<T | undefined>;
  readLine(options: { prompt: string; mask?: boolean }): Promise<string | undefined>;
}

const KEY_ATTEMPTS = 3;

/** Pick where to call Jev and paste a key for it, checked. Undefined if they back out. */
export async function connectJev(
  ui: JevUI,
  checkKey: (link: JevLink) => Promise<JevKeyCheck>,
): Promise<JevLink | undefined> {
  const provider = await ui.select<JevProviderId>(
    'Where should Dazza call Jev?',
    JEV_PROVIDER_IDS.map((id) => ({
      label: JEV_PROVIDERS[id].name,
      hint: JEV_PROVIDERS[id].hint,
      value: id,
    })),
  );
  if (!provider) return undefined;
  const { name, keyName, keyUrl } = JEV_PROVIDERS[provider];
  ui.say(`Paste ${keyName}. Make one at ${keyUrl}`);
  for (let attempt = 1; attempt <= KEY_ATTEMPTS; attempt++) {
    const apiKey = (await ui.readLine({ prompt: 'API key: ', mask: true }))?.trim();
    if (!apiKey) return undefined;
    const link = { provider, apiKey };
    const check = await checkKey(link);
    if (check === 'valid') return link;
    ui.say(
      check === 'invalid'
        ? `${name} didn’t accept that key. Check it and try again.`
        : `Couldn’t reach ${name} to check the key. Check your connection and try again.`,
    );
  }
  return undefined;
}

type Row = { feature: JevFeature } | 'key' | 'forget';

/**
 * The `/jev` list: pick a feature to switch it on or off, or change or forget
 * the key, until Esc. Asks for a key first if there isn't one. Resolves what
 * changed, in words.
 */
export async function editJev(
  config: Config,
  ui: JevUI,
  checkKey: (link: JevLink) => Promise<JevKeyCheck>,
): Promise<string[]> {
  const changed: string[] = [];
  let link = await config.readJev();
  if (!link) {
    ui.say(
      'Jev is a fast classifier from TypeSafe. Dazza uses it for small decisions: which model ' +
        'each task needs, and whether finished work holds up, for a fraction of a cent each.\n' +
        'Dazza sends it task descriptions and builders’ reports, never your code.',
    );
    link = await connectJev(ui, checkKey);
    if (!link) return changed;
    await config.writeJev(link);
    changed.push(`Jev: through ${JEV_PROVIDERS[link.provider].name}`);
  }

  for (;;) {
    const settings = await config.readSettings();
    const width = Math.max(...JEV_FEATURES.map((f) => f.label.length), 'Key'.length);
    const where = (await config.jevKeyKeptIn()) ?? 'Dazza’s config folder (owner-only)';
    const row = await ui.select<Row>('Jev: pick one to switch it, Esc when you’re done', [
      ...JEV_FEATURES.map((feature) => ({
        label: `${feature.label.padEnd(width)}  ${jevOn(settings, feature.key) ? 'On' : 'Off'}`,
        hint: feature.about,
        value: { feature },
      })),
      {
        label: `${'Key'.padEnd(width)}  ${JEV_PROVIDERS[link.provider].name}`,
        hint: `Kept in ${where}. Pick to change where Dazza calls Jev`,
        value: 'key' as const,
      },
      {
        label: 'Forget the key',
        hint: 'Jev stops; Dazza works as it did without it',
        value: 'forget' as const,
      },
    ]);
    if (!row) return changed;

    if (row === 'forget') {
      await config.clearJev();
      changed.push('Jev: key forgotten');
      return changed;
    }
    if (row === 'key') {
      const next = await connectJev(ui, checkKey);
      if (next) {
        await config.writeJev(next);
        link = next;
        changed.push(`Jev: through ${JEV_PROVIDERS[next.provider].name}`);
      }
      continue;
    }
    const { key, label } = row.feature;
    const on = !jevOn(settings, key);
    await config.updateSettings({ jev: { ...settings.jev, [key]: on } });
    changed.push(`${label}: ${on ? 'On' : 'Off'}`);
  }
}
