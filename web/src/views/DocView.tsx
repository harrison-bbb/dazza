import { ArrowLeft } from 'lucide-react';
import { Markdown } from '../components/Markdown';
import { paths } from '../lib/router';

export function DocView({ scope }: { scope: string | null }) {
  return (
    <article className="mx-auto w-full max-w-2xl px-5 py-14">
      <a
        href={paths.dashboard}
        className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"
      >
        <ArrowLeft className="size-3.5" />
        Dashboard
      </a>
      <h1 className="mt-6 mb-10 text-2xl font-semibold tracking-tight">Scope of work</h1>
      {scope ? (
        <Markdown>{scope}</Markdown>
      ) : (
        <p className="text-muted">Dazza hasn’t written the scope yet.</p>
      )}
    </article>
  );
}
