import { useSyncExternalStore } from 'react';

export type View = 'overview' | 'docs' | 'list' | 'board';
export const VIEWS: readonly View[] = ['overview', 'docs', 'list', 'board'];

export interface Route {
  view: View;
  /** The task open in the drawer, if any. */
  taskId: string | undefined;
}

/** Hash routing (`#/list?task=T3`) so any view or task can be linked and bookmarked. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parse(hash);
}

export function navigate(route: Partial<Route>): void {
  const current = parse(window.location.hash);
  const view = route.view ?? current.view;
  const taskId = 'taskId' in route ? route.taskId : current.taskId;
  window.location.hash = `/${view}${taskId ? `?task=${encodeURIComponent(taskId)}` : ''}`;
}

export function href(view: View, taskId?: string): string {
  return `#/${view}${taskId ? `?task=${encodeURIComponent(taskId)}` : ''}`;
}

function parse(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const view = VIEWS.find((v) => v === path) ?? 'overview';
  const taskId = new URLSearchParams(query).get('task') ?? undefined;
  return { view, taskId };
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}
