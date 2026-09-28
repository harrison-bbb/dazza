import type { TaskStatus } from './api';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  planned: 'Planned',
  building: 'Building',
  review: 'Ready for review',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
  closed: 'Closed',
};

/** List order: what needs the user first, then what's moving, finished work last. */
export const STATUS_ORDER: readonly TaskStatus[] = [
  'review',
  'blocked',
  'building',
  'planned',
  'backlog',
  'closed',
  'cancelled',
];
