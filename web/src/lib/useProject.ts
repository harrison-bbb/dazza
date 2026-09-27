import { useCallback, useEffect, useState } from 'react';
import { fetchProject, type ProjectSnapshot } from './api';

export interface ProjectState {
  project: ProjectSnapshot | undefined;
  error: string | undefined;
  /** Whether the live-update stream is connected. */
  live: boolean;
  refresh(): Promise<void>;
}

/** The project snapshot, refetched whenever the server reports a change. */
export function useProject(): ProjectState {
  const [project, setProject] = useState<ProjectSnapshot>();
  const [error, setError] = useState<string>();
  const [live, setLive] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setProject(await fetchProject());
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const stream = new EventSource('/api/stream');
    stream.addEventListener('open', () => {
      setLive(true);
      void refresh(); // catch anything missed while disconnected
    });
    stream.addEventListener('error', () => setLive(false));
    stream.addEventListener('change', () => void refresh());
    return () => stream.close();
  }, [refresh]);

  return { project, error, live, refresh };
}
