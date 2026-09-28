import { useSyncExternalStore } from 'react';

/**
 * Hash routes, so every screen can be linked and the back button works:
 *   #/            dashboard
 *   #/doc         scope document
 *   #/tasks       task list
 *   #/report      close-out or progress report
 *   #/tasks/T3    task (or subtask, e.g. T3.2); `?unblock` opens its reply box to answer
 */
export type Route =
  | { view: 'dashboard' }
  | { view: 'doc' }
  | { view: 'report' }
  | { view: 'tasks' }
  | { view: 'item'; id: string; focus?: 'unblock' };

export function useRoute(): Route {
  return parse(useSyncExternalStore(subscribe, () => window.location.hash));
}

export const paths = {
  dashboard: '#/',
  doc: '#/doc',
  report: '#/report',
  tasks: '#/tasks',
  item: (id: string, focus?: 'unblock') =>
    `#/tasks/${encodeURIComponent(id)}${focus ? `?${focus}` : ''}`,
};

function parse(hash: string): Route {
  const [section, id] = hash.replace(/^#\/?/, '').split('/');
  if (section === 'doc') return { view: 'doc' };
  if (section === 'report') return { view: 'report' };
  if (section === 'tasks') {
    if (!id) return { view: 'tasks' };
    const [item = '', focus] = id.split('?');
    return {
      view: 'item',
      id: decodeURIComponent(item),
      ...(focus === 'unblock' && { focus }),
    };
  }
  return { view: 'dashboard' };
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}
