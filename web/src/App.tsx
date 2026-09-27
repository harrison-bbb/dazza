import { useEffect } from 'react';
import type { Crumb } from './components/TopBar';
import { TopBar } from './components/TopBar';
import type { Plan } from './lib/api';
import { titleCase } from './lib/format';
import { paths, type Route, useRoute } from './lib/router';
import { useProject } from './lib/useProject';
import { Dashboard } from './views/Dashboard';
import { DocView } from './views/DocView';
import { ItemView } from './views/ItemView';
import { TaskList } from './views/TaskList';

export function App() {
  const { project, error, live, refresh } = useProject();
  const route = useRoute();

  const name = project ? titleCase(project.name) : 'Dazza';
  useEffect(() => {
    document.title = `${name} · Dazza`;
  }, [name]);

  if (!project) {
    return (
      <div className="grid h-dvh place-items-center text-[13px] text-muted">
        {error ? `Can’t reach Dazza: ${error}` : 'Loading…'}
      </div>
    );
  }

  const { plan, events } = project;
  const found = route.view === 'item' && plan ? findItem(plan, route.id) : undefined;

  return (
    <div className="flex h-dvh flex-col">
      <TopBar crumbs={crumbs(name, route, found)} live={live} />
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {route.view === 'doc' ? (
          <DocView scope={project.scope} events={events} />
        ) : route.view === 'tasks' ? (
          plan ? (
            <TaskList plan={plan} events={events} />
          ) : (
            <p className="p-10 text-center text-muted">No plan yet.</p>
          )
        ) : route.view === 'item' && found && plan ? (
          <ItemView
            task={found.task}
            subtask={found.subtask}
            tasks={plan.tasks}
            events={events}
            onChange={refresh}
          />
        ) : route.view === 'item' ? (
          <p className="p-10 text-center text-muted">No task {route.id}.</p>
        ) : (
          <Dashboard project={{ ...project, name }} onChange={refresh} />
        )}
      </main>
    </div>
  );
}

type Found = {
  task: Plan['tasks'][number];
  subtask: Plan['tasks'][number]['subtasks'][number] | undefined;
};

function findItem(plan: Plan, id: string): Found | undefined {
  for (const task of plan.tasks) {
    if (task.id === id) return { task, subtask: undefined };
    const subtask = task.subtasks.find((s) => s.id === id);
    if (subtask) return { task, subtask };
  }
  return undefined;
}

function crumbs(project: string, route: Route, found: Found | undefined): Crumb[] {
  const root = { label: project, href: paths.dashboard };
  switch (route.view) {
    case 'dashboard':
      return [{ label: project }];
    case 'doc':
      return [root, { label: 'Scope of work' }];
    case 'tasks':
      return [root, { label: 'Tasks' }];
    case 'item': {
      const trail = [root, { label: 'Tasks', href: paths.tasks }];
      if (!found) return [...trail, { label: route.id }];
      if (!found.subtask) return [...trail, { label: found.task.id }];
      return [
        ...trail,
        { label: found.task.id, href: paths.item(found.task.id) },
        { label: found.subtask.id },
      ];
    }
  }
}
