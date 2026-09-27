import type { AgentEvent } from '../providers/types.js';
import type { Config } from './config.js';
import type { Store } from './store.js';

/** Keep usage totals and the latest rate-limit reading current as an agent runs. */
export async function trackUsage(store: Store, config: Config, event: AgentEvent): Promise<void> {
  if (event.type === 'finished' && event.usage) await store.recordUsage(event.usage);
  if (event.type === 'limits') {
    await config.writeLimits({ checkedAt: new Date().toISOString(), windows: event.windows });
  }
}
