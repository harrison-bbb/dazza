import { type FormEvent, useEffect, useRef, useState } from 'react';
import { addComment, type Event, requestChanges } from '../lib/api';
import { cn, timeAgo } from '../lib/format';
import { Button, InlineText } from './ui';

export type ComposerMode = 'comment' | 'changes';

interface ActivityProps {
  itemId: string;
  events: Event[];
  mode: ComposerMode;
  onModeChange(mode: ComposerMode): void;
  onChange(): void;
}

/** The right-hand column: the item's thread with you and Dazza, plus a composer. */
export function Activity({ itemId, events, mode, onModeChange, onChange }: ActivityProps) {
  const thread = useRef<HTMLDivElement>(null);

  // Keep the newest message in view as the thread grows.
  const count = events.length;
  useEffect(() => {
    // Scroll the thread itself, never the page (on mobile the thread isn't a scroll box).
    const el = thread.current;
    if (count > 0 && el) el.scrollTop = el.scrollHeight;
  }, [count]);

  return (
    <aside className="flex flex-col border-t border-line bg-panel lg:h-full lg:min-h-0 lg:border-t-0 lg:border-l">
      <div className="flex h-11 shrink-0 items-center border-b border-line px-5 text-[13px] font-medium">
        Activity
      </div>
      <div ref={thread} className="flex-1 overflow-y-auto px-5 py-4">
        {events.length === 0 ? (
          <p className="text-[13px] text-faint">No activity yet.</p>
        ) : (
          <ol className="space-y-4">
            {events.map((event) => (
              <li key={`${event.at}-${event.type}-${event.message}`}>
                {event.type === 'comment' ? (
                  <Comment event={event} />
                ) : (
                  <SystemLine event={event} />
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
      <Composer itemId={itemId} mode={mode} onModeChange={onModeChange} onSent={onChange} />
    </aside>
  );
}

function Comment({ event }: { event: Event }) {
  const dazza = event.actor === 'dazza';
  return (
    <div className="flex gap-2.5">
      <Avatar dazza={dazza} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[13px]">
          <span className="font-medium">{dazza ? 'Dazza' : 'You'}</span>
          <time className="text-[12px] text-faint" dateTime={event.at}>
            {timeAgo(event.at)}
          </time>
        </div>
        <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-6 text-ink-2">
          <InlineText>{event.message}</InlineText>
        </p>
      </div>
    </div>
  );
}

function SystemLine({ event }: { event: Event }) {
  return (
    <div className="flex items-baseline gap-2.5 pl-[3px] text-[12px] text-muted">
      <span className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-line-strong" />
      <span>
        <span className="text-ink-2">{event.actor === 'dazza' ? 'Dazza' : 'You'}</span> ·{' '}
        {event.message} · <time dateTime={event.at}>{timeAgo(event.at)}</time>
      </span>
    </div>
  );
}

function Avatar({ dazza }: { dazza: boolean }) {
  return dazza ? (
    <svg viewBox="0 0 32 32" className="mt-0.5 size-6 shrink-0" aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-accent" />
      <path d="M10 9h7a7 7 0 0 1 0 14h-7z" className="fill-panel" />
    </svg>
  ) : (
    <span
      className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-hover text-[11px] font-medium text-ink-2"
      aria-hidden
    >
      Y
    </span>
  );
}

interface ComposerProps {
  itemId: string;
  mode: ComposerMode;
  onModeChange(mode: ComposerMode): void;
  onSent(): void;
}

function Composer({ itemId, mode, onModeChange, onSent }: ComposerProps) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const changes = mode === 'changes';

  useEffect(() => {
    if (changes) input.current?.focus();
  }, [changes]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    const result = changes ? await requestChanges(itemId, body) : await addComment(itemId, body);
    setBusy(false);
    if (!result.ok) return setError(result.message);
    setBody('');
    setError(undefined);
    onModeChange('comment');
    onSent();
  };

  return (
    <form onSubmit={submit} className="shrink-0 border-t border-line p-3">
      {changes && (
        <div className="mb-2 flex items-center justify-between px-1 text-[12px] text-amber">
          Requesting changes: this goes back to Dazza
          <button
            type="button"
            onClick={() => onModeChange('comment')}
            className="text-muted hover:text-ink"
          >
            Cancel
          </button>
        </div>
      )}
      <div
        className={cn(
          'rounded-lg border bg-bg transition-colors focus-within:border-line-strong',
          changes ? 'border-amber/50' : 'border-line',
        )}
      >
        <textarea
          ref={input}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          }}
          rows={3}
          placeholder={changes ? 'What should change?' : 'Comment…'}
          aria-label={changes ? 'Requested changes' : 'Comment'}
          className="block w-full resize-none bg-transparent px-3 pt-2.5 text-[13px] leading-6 outline-none placeholder:text-faint"
        />
        <div className="flex items-center justify-between px-2 pb-2">
          <span className="px-1 text-[11px] text-faint">{error ?? '⌘ Enter'}</span>
          <Button
            type="submit"
            variant={changes ? 'secondary' : 'primary'}
            disabled={!body.trim() || busy}
            className="h-7"
          >
            {changes ? 'Send back' : 'Comment'}
          </Button>
        </div>
      </div>
    </form>
  );
}
