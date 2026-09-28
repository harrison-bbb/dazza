import { useCallback, useEffect, useState } from 'react';
import { BoardKeyMissing, fetchProject, type ProjectSnapshot } from './api';

export interface ProjectState {
  project: ProjectSnapshot | undefined;
  error: string | undefined;
  /** Whether the live-update stream is connected. */
  live: boolean;
  /** The connection dropped: Dazza has probably been closed. Not set while first connecting. */
  offline: boolean;
  refresh(): Promise<void>;
}

/** The project snapshot, refetched whenever the server reports a change. */
export function useProject(): ProjectState {
  const [project, setProject] = useState<ProjectSnapshot>();
  const [error, setError] = useState<string>();
  const [live, setLive] = useState(false);
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setProject(await fetchProject());
      setError(undefined);
    } catch (err) {
      setError(
        err instanceof BoardKeyMissing ? 'key' : err instanceof Error ? err.message : String(err),
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
    const stream = new EventSource('/api/stream');
    stream.addEventListener('open', () => {
      setLive(true);
      setOffline(false);
      void refresh(); // catch anything missed while disconnected
    });
    stream.addEventListener('error', () => {
      setLive(false);
      setOffline(true);
    });
    stream.addEventListener('change', () => void refresh());
    return () => stream.close();
  }, [refresh]);

  return { project, error, live, offline, refresh };
}
