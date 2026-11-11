// The app's single store instance and the hook components use to read it.
import { useLayoutEffect, useReducer, useRef } from 'preact/hooks';
import { createStore, shallowEqual } from './store.js';
import { readTheme } from './theme.js';
import { KEYS, getItem } from './lib/storage.js';
import { readGroupBy } from './lib/sessions.js';

export const initialState = () => ({
  info: null,
  isV2: false,
  booting: true,
  bootError: null,
  sessions: [],
  // True once a session list has arrived from the server (notifications baseline).
  sessionsLoaded: false,
  current: null,
  loadingSessionId: null,
  filter: 'active',
  search: '',
  // Preferences for the next new session (the open session carries its own).
  model: 'opus',
  mode: 'bypassPermissions',
  efforts: {},
  project: '',
  // Clusters a new session can run on (GET /api/info; just this server without the
  // field) and the one chosen for the next new session (lib/clusters.js).
  clusters: [],
  cluster: 'local',
  connection: 'connecting',
  sending: false,
  sidebarCollapsed: false,
  drawerOpen: false,
  panel: { open: false, tab: 'changes', filePath: '', fileLine: null, nonce: 0, taskId: null },
  // The agent shown in the side panel (AgentPanel.jsx): its session, the agents from the
  // top-level one down to it (none: no agent shown), and whether the panel is widened.
  agent: { sessionId: null, path: [], wide: false },
  // Claude Code's own transcripts of the open session's agents, by agent call id:
  // { loading, data, error, shown } (see loadAgentFiles).
  agentFiles: {},
  // MCP servers per session or project folder: the last list, sign-ins waiting (src/mcp.js).
  mcp: {},
  dialog: null,
  toast: null,
  theme: readTheme(),
  // Sidebar grouping: 'date' or 'cluster' (lib/sessions.js groupSessions).
  groupBy: readGroupBy(getItem(KEYS.groupBy)),
  // Desktop notifications: the user's choice (src/attention.js) and the browser permission.
  notifications: false,
  notificationPermission: 'default',
  composerPreset: null,
  // Messages being sent, in order ({key, id: clientId once known, sessionId, text,
  // queue}), shown until the server's copy arrives; the Stop just pressed ({id, turn},
  // see isStopping); and "Interrupt and send now" ({id, turn}, see isInterrupting).
  outgoing: [],
  // Messages being sent to model agents from the agent panel ({key, clientId, sessionId,
  // toolId, text, at}), shown in the agent's transcript until the server's copy arrives.
  agentOutgoing: [],
  stopping: null,
  interrupting: null,
  focusNonce: 0,
  scrollNonce: 0,
});

export const store = createStore(initialState());

// Re-renders the calling component only when `selector(state)` changes according to
// `equal` (Object.is by default; pass shallowEqual for selectors returning objects).
export function useAppState(selector = (s) => s, equal = Object.is) {
  const [, rerender] = useReducer((n) => n + 1, 0);
  const selected = selector(store.get());
  const latest = useRef(null);
  latest.current = { selector, selected, equal };
  useLayoutEffect(() => {
    const check = (state) => {
      const { selector: select, selected: previous, equal: same } = latest.current;
      if (!same(select(state), previous)) rerender();
    };
    const unsubscribe = store.subscribe(check);
    check(store.get());
    return unsubscribe;
  }, []);
  return selected;
}

export { shallowEqual };
