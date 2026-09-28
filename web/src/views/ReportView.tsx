import { ArrowLeft } from 'lucide-react';
import { Markdown } from '../components/Markdown';
import { paths } from '../lib/router';

/** Dazza's close-out (or progress) report: what was built, what changed, what's next. */
export function ReportView({ report }: { report: string | null }) {
  return (
    <article className="mx-auto w-full max-w-2xl px-5 py-14">
      <a
        href={paths.dashboard}
        className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"
      >
        <ArrowLeft className="size-3.5" />
        Dashboard
      </a>
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">Report</h1>
      <div className="mt-10">
        {report ? (
          <Markdown>{report}</Markdown>
        ) : (
          <p className="text-muted">
            No report yet. Dazza writes one when every task is closed, or run /report in your
            terminal for a progress report.
          </p>
        )}
      </div>
    </article>
  );
}
