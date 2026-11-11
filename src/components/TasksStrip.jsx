// Collapsible checklist bar above the composer, from the session's todos.
import { useState } from 'preact/hooks';
import { ChevronUp } from 'lucide-preact';
import { shallowEqual, useAppState } from '../state.js';
import { todoProgress, todosVisible } from '../lib/todos.js';
import { ProgressRing, TodoList } from './TodoList.jsx';
import './TasksStrip.css';

export function TasksStrip() {
  const { todos, visible } = useAppState((s) => ({ todos: s.current?.todos || null, visible: todosVisible(s.current) }), shallowEqual);
  const [open, setOpen] = useState(false);
  if (!visible) return null;
  const { total, completed, current } = todoProgress(todos);
  const finished = completed === total;
  return (
    <div class={`tasks-strip ${open ? 'is-open' : ''}`}>
      <button type="button" class="tasks-head" onClick={() => setOpen(!open)} aria-expanded={String(open)} aria-label={`Tasks: ${completed} of ${total} done`}>
        <ProgressRing value={total ? completed / total : 0} />
        <span class="tasks-count">
          {completed} of {total}
        </span>
        <span class="tasks-current">{finished ? 'All tasks done' : current}</span>
        <ChevronUp size={14} class="tasks-chevron" />
      </button>
      {open && (
        <div class="tasks-body">
          <TodoList todos={todos} />
        </div>
      )}
    </div>
  );
}
