// The session checklist: used by the tasks strip, the Plan tab and TodoWrite cards.
import { Check, Circle, LoaderCircle } from 'lucide-preact';
import './TodoList.css';

function TodoIcon({ status }) {
  if (status === 'completed') return <Check size={14} strokeWidth={2.25} class="todo-icon done" aria-label="Done" />;
  if (status === 'in_progress') return <LoaderCircle size={14} class="todo-icon active spin" aria-label="In progress" />;
  return <Circle size={14} class="todo-icon pending" aria-label="Pending" />;
}

export function TodoList({ todos, class: className = '' }) {
  return (
    <ul class={`todo-list ${className}`}>
      {(todos || []).map((todo, i) => (
        <li key={i} class={`todo todo-${todo.status || 'pending'}`}>
          <TodoIcon status={todo.status} />
          <span class="todo-text">{todo.status === 'in_progress' ? todo.activeForm || todo.content : todo.content}</span>
        </li>
      ))}
    </ul>
  );
}

// A small ring filled to `value` (0–1).
export function ProgressRing({ value, size = 18 }) {
  const radius = size / 2 - 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = Math.min(1, Math.max(0, value || 0));
  const center = size / 2;
  return (
    <svg class="progress-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={center} cy={center} r={radius} class="progress-track" />
      <circle
        cx={center}
        cy={center}
        r={radius}
        class="progress-value"
        stroke-dasharray={`${circumference * ratio} ${circumference}`}
        transform={`rotate(-90 ${center} ${center})`}
      />
    </svg>
  );
}
