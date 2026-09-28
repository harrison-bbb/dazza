import { type KeyboardEvent, useState } from 'react';
import { editTask, type Task } from '../lib/api';
import { useUnsaved } from '../lib/useUnsaved';
import { Button } from './ui';

/**
 * Change a task's title, size, description and acceptance criteria. The same
 * edit Dazza makes when asked in the chat; it's recorded on the task.
 */
export function TaskEditor({ task, onDone }: { task: Task; onDone(saved: boolean): void }) {
  const [title, setTitle] = useState(task.title);
  const [size, setSize] = useState(task.size ?? '');
  const [description, setDescription] = useState(task.description);
  const [criteria, setCriteria] = useState(task.acceptanceCriteria.join('\n'));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const lines = criteria
    .split('\n')
    .map((line) => line.replace(/^\s*[-•*]\s*/, '').trim())
    .filter(Boolean);
  const changed =
    title !== task.title ||
    size !== (task.size ?? '') ||
    description !== task.description ||
    lines.join('\n') !== task.acceptanceCriteria.join('\n');
  const discard = useUnsaved(changed);

  const save = async () => {
    if (!changed || busy) return;
    if (!title.trim() || !description.trim() || lines.length === 0) {
      setError('A task needs a title, a description and at least one acceptance criterion.');
      return;
    }
    setBusy(true);
    const result = await editTask(task.id, {
      ...(title !== task.title && { title: title.trim() }),
      ...(description !== task.description && { description }),
      ...(lines.join('\n') !== task.acceptanceCriteria.join('\n') && { acceptanceCriteria: lines }),
      ...(size && size !== task.size && { size: size as 'S' | 'M' | 'L' }),
    });
    setBusy(false);
    if (result.ok) onDone(true);
    else setError(result.message);
  };
  const keys = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      void save();
    }
    if (e.key === 'Escape' && !changed) onDone(false);
  };

  const field =
    'w-full rounded-md border border-line bg-transparent px-3 py-2 outline-none focus:border-line-strong';
  return (
    <div className="mt-4 space-y-5">
      <label className="block">
        <span className="mb-1 block text-[12px] text-muted">Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={keys}
          className={`${field} text-lg font-semibold`}
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-[12px] text-muted">Size</span>
        <select
          value={size}
          onChange={(e) => setSize(e.target.value)}
          className={`${field} w-auto`}
        >
          {!task.size && <option value="">Not sized</option>}
          <option value="S">Small · about 10 minutes</option>
          <option value="M">Medium · about 20 minutes</option>
          <option value="L">Large · about 40 minutes</option>
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-[12px] text-muted">Description (Markdown)</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={keys}
          className={`${field} h-72 resize-y font-mono text-[13px] leading-6`}
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-[12px] text-muted">
          Done when (one criterion per line)
        </span>
        <textarea
          value={criteria}
          onChange={(e) => setCriteria(e.target.value)}
          onKeyDown={keys}
          className={`${field} h-40 resize-y text-[13px] leading-6`}
        />
      </label>
      {error && <p className="text-[13px] text-red">{error}</p>}
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={save} disabled={!changed || busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="quiet" onClick={() => discard() && onDone(false)} disabled={busy}>
          Cancel
        </Button>
        <span className="ml-auto text-[12px] text-faint">⌘S to save</span>
      </div>
    </div>
  );
}
