import type { Settings } from '../core/config.js';

/** What Jev can do for Dazza, each switched on or off by itself in `/jev`. */

export type JevSettings = NonNullable<Settings['jev']>;

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
