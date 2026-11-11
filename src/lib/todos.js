// The session checklist (TodoWrite / Task tools): progress and when to show it.

const TODO_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);
// Queued and mid-turn ('sent') messages show in the bar above the composer until they
// run or Claude reads them; cancelled ones never show.
const HIDDEN_DELIVERY = new Set(['queued', 'sent', 'cancelled']);

// { total, completed, active, current } where `current` is the text to show next to
// the progress: the in-progress item's activeForm (or content), else the next
// pending item, else the last item.
export function todoProgress(todos) {
  const list = Array.isArray(todos) ? todos.filter((t) => t && typeof t.content === 'string') : [];
  const completed = list.filter((t) => t.status === 'completed').length;
  const active = list.find((t) => t.status === 'in_progress') || null;
  const next = list.find((t) => t.status === 'pending') || null;
  const current = active ? active.activeForm || active.content : next ? next.content : list.at(-1)?.content || '';
  return { total: list.length, completed, active, current };
}

// Show the strip while there is open work. A fully completed list stays visible
// through the turn that completed it and hides once a later turn starts. A copy holding
// only the end of the session (a tail) whose list was completed before it: visible
// while no turn starts in the part held.
export function todosVisible(session) {
  const { total, completed } = todoProgress(session?.todos);
  if (!total) return false;
  if (completed < total) return true;
  const messages = session.messages || [];
  let lastUpdate = -1;
  messages.forEach((m, i) => {
    if (m.role === 'tool' && TODO_TOOLS.has(m.tool) && !m.parentToolId) lastUpdate = i;
  });
  if (lastUpdate < 0 && !(session.messagesFrom > 0)) return false;
  return !messages.slice(lastUpdate + 1).some((m) => m.role === 'user' && !m.parentToolId && !HIDDEN_DELIVERY.has(m.delivery));
}
