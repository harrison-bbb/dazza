import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  h1: ({ children }) => <h1 className="mt-10 mb-3 text-xl font-semibold">{children}</h1>,
  h2: ({ children }) => (
    <h2 className="mt-10 mb-3 text-[15px] font-semibold text-ink first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => <h3 className="mt-6 mb-2 font-semibold">{children}</h3>,
  p: ({ children }) => <p className="my-3 text-ink-2 leading-7">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-3 list-disc space-y-1 pl-5 marker:text-faint">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-3 list-decimal space-y-1 pl-5 marker:text-faint">{children}</ol>
  ),
  li: ({ children }) => <li className="pl-1 text-ink-2 leading-7">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  a: ({ children, href }) => (
    <a
      href={href}
      className="text-ink underline decoration-faint underline-offset-2 hover:decoration-ink"
    >
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-hover px-1 py-px font-mono text-[0.9em] text-ink">{children}</code>
  ),
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-line py-2 pr-4 text-left font-medium text-muted">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-line py-2 pr-4 text-ink-2">{children}</td>,
  hr: () => <hr className="my-8 border-line" />,
};

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  );
}
