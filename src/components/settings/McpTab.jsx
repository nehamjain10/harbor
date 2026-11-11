// The MCP servers tab: the current session's servers (the same panel as the topbar chip
// and `/mcp`), or the project's when no session is open.
import { useAppState } from '../../state.js';
import { McpPanel } from '../McpPanel.jsx';

export function McpTab() {
  const sessionId = useAppState((s) => s.current?.id || null);
  return <McpPanel sessionId={sessionId} />;
}
