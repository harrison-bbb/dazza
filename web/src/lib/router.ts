import { useSyncExternalStore } from 'react';

/**
 * Hash routes, so every screen can be linked and the back button works:
 *   #/            dashboard
 *   #/doc         scope document
 *   #/tasks       task list
 *   #/tasks/T3    task (or subtask, e.g. T3.2)
 */
export type Route =
  | { view: 'dashboard' }
  | { view: 'doc' }
  | { view: 'tasks' }
  | { view: 'item'; id: string };

export function useRoute(): Route {
  return parse(useSyncExternalStore(subscribe, () => window.location.hash));
}

export const paths = {
  dashboard: '#/',
  doc: '#/doc',
  tasks: '#/tasks',
  item: (id: string) => `#/tasks/${encodeURIComponent(id)}`,
};

function parse(hash: string): Route {
  const [section, id] = hash.replace(/^#\/?/, '').split('/');
  if (section === 'doc') return { view: 'doc' };
  if (section === 'tasks')
    return id ? { view: 'item', id: decodeURIComponent(id) } : { view: 'tasks' };
  return { view: 'dashboard' };
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}
