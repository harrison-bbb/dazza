import { cn } from '../lib/format';

/** Where the board serves a screenshot from, given its media path ("T3/home-desktop.png"). */
export function mediaUrl(path: string): string {
  return `/api/media/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Screenshots as thumbnails that open full size, one wide or two per row. */
export function Screenshots({ paths, className }: { paths: string[]; className?: string }) {
  if (paths.length === 0) return null;
  return (
    <div className={cn('grid gap-2', paths.length > 1 && 'grid-cols-2', className)}>
      {paths.map((path) => (
        <a
          key={path}
          href={mediaUrl(path)}
          target="_blank"
          rel="noreferrer"
          className="group block"
        >
          <img
            src={mediaUrl(path)}
            alt={`Screenshot: ${path.split('/').at(-1)}`}
            loading="lazy"
            className="max-h-80 w-full rounded-md border border-line object-cover object-top transition group-hover:border-line-strong"
          />
        </a>
      ))}
    </div>
  );
}
