import { useEffect } from 'react';

/**
 * While there are unsaved edits, warn before the tab is closed or reloaded.
 * Returns a check for Cancel: true when it's fine to throw the edits away.
 */
export function useUnsaved(changed: boolean): () => boolean {
  useEffect(() => {
    if (!changed) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [changed]);
  return () => !changed || window.confirm('Discard your changes?');
}
