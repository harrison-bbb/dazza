import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  Eye,
  type LucideIcon,
  OctagonAlert,
  RotateCcw,
} from 'lucide-react';
import type { Task, TaskStatus } from './api';

export interface StatusMeta {
  label: string;
  icon: LucideIcon;
  /** Tailwind classes for the status colour, as text and as a fill. */
  text: string;
  fill: string;
  /** CSS colour, for SVG. */
  color: string;
}

export const STATUS: Record<TaskStatus, StatusMeta> = {
  todo: {
    label: 'To do',
    icon: CircleDashed,
    text: 'text-st-todo',
    fill: 'bg-st-todo',
    color: 'var(--st-todo)',
  },
  in_progress: {
    label: 'In progress',
    icon: CircleDot,
    text: 'text-st-progress',
    fill: 'bg-st-progress',
    color: 'var(--st-progress)',
  },
  blocked: {
    label: 'Blocked',
    icon: OctagonAlert,
    text: 'text-st-blocked',
    fill: 'bg-st-blocked',
    color: 'var(--st-blocked)',
  },
  review: {
    label: 'In review',
    icon: Eye,
    text: 'text-st-review',
    fill: 'bg-st-review',
    color: 'var(--st-review)',
  },
  done: {
    label: 'Done',
    icon: CircleCheck,
    text: 'text-st-done',
    fill: 'bg-st-done',
    color: 'var(--st-done)',
  },
  rejected: {
    label: 'Changes requested',
    icon: RotateCcw,
    text: 'text-st-blocked',
    fill: 'bg-st-blocked',
    color: 'var(--st-blocked)',
  },
};

/** Columns and list groups, in workflow order. Rejected work goes back into To do. */
export const LANES: readonly { status: TaskStatus; includes: readonly TaskStatus[] }[] = [
  { status: 'todo', includes: ['todo', 'rejected'] },
  { status: 'in_progress', includes: ['in_progress'] },
  { status: 'blocked', includes: ['blocked'] },
  { status: 'review', includes: ['review'] },
  { status: 'done', includes: ['done'] },
];

/**
 * Donut order. Adjacent colours were validated for colour-blind separation;
 * keep green away from amber.
 */
export const CHART_ORDER: readonly TaskStatus[] = [
  'done',
  'in_progress',
  'review',
  'blocked',
  'todo',
];

export function laneOf(task: Task): TaskStatus {
  return LANES.find((lane) => lane.includes.includes(task.status))?.status ?? 'todo';
}
