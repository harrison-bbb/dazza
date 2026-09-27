import type { TaskStatus } from './api';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  planned: 'Planned',
  building: 'Building',
  review: 'In review',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
  closed: 'Closed',
};

/** List order: what's moving first, finished work last. */
export const STATUS_ORDER: readonly TaskStatus[] = [
  'building',
  'review',
  'blocked',
  'planned',
  'backlog',
  'closed',
  'cancelled',
];
