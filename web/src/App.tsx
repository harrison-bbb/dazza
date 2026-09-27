import { useEffect } from 'react';
import { EmptyState } from './components/EmptyState';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { TaskDrawer } from './components/TaskDrawer';
import { titleCase } from './lib/format';
import { useRoute } from './lib/router';
import { useProject } from './lib/useProject';
import { BoardView } from './views/BoardView';
import { Docs } from './views/Docs';
import { ListView } from './views/ListView';
import { Overview } from './views/Overview';

export function App() {
  const { project, error, live, refresh } = useProject();
  const { view, taskId } = useRoute();
  const name = project ? titleCase(project.name) : 'Dazza';

  useEffect(() => {
    document.title = project ? `${name} · Dazza` : 'Dazza';
  }, [project, name]);

  if (!project) {
    return (
      <div className="grid h-dvh place-items-center text-sm text-muted">
        {error ? `Can't reach Dazza: ${error}` : 'Loading…'}
      </div>
    );
  }

  const { plan } = project;
  const task = plan?.tasks.find((t) => t.id === taskId);

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar name={name} plan={plan} view={view} />
      <main className="flex min-w-0 flex-1 flex-col">
        <Header name={name} plan={plan} view={view} live={live} onChange={refresh} />
        <div className="flex-1 overflow-auto">
          {!plan ? (
            <EmptyState />
          ) : view === 'docs' ? (
            <Docs scope={project.scope ?? ''} events={project.events} />
          ) : view === 'list' ? (
            <ListView tasks={plan.tasks} />
          ) : view === 'board' ? (
            <BoardView tasks={plan.tasks} />
          ) : (
            <Overview project={{ ...project, plan }} onChange={refresh} />
          )}
        </div>
      </main>
      {plan && task && (
        <TaskDrawer task={task} tasks={plan.tasks} events={project.events} onChange={refresh} />
      )}
    </div>
  );
}
