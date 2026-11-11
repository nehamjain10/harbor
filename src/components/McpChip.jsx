// The topbar's MCP button: a plug, how many servers are connected, and a dot when one
// needs a look (see summarize in lib/mcp.js). It reads the last list fetched for the
// session; a fetch that never starts a process (`cached`) fills it when the session
// opens and when its Claude Code process restarts. Opens the MCP panel (/mcp).
import { useEffect } from 'preact/hooks';
import { Plug } from 'lucide-preact';
import { openDialog } from '../actions.js';
import { loadMcp } from '../mcp.js';
import { shallowEqual, useAppState } from '../state.js';
import { chipServers, chipTitle, summarize } from '../lib/mcp.js';
import './McpPanel.css';

export function McpChip({ sessionId }) {
  const { connected, attention, total, started } = useAppState((s) => {
    const session = sessionId ? (s.current?.id === sessionId ? s.current : s.sessions.find((x) => x.id === sessionId)) : null;
    return {
      ...summarize(chipServers(session, s.mcp[sessionId]?.servers)),
      // What the session's process reported when it started: a new one may have other servers.
      started: JSON.stringify(session?.mcp || []),
    };
  }, shallowEqual);

  useEffect(() => {
    if (sessionId) loadMcp({ sessionId }, { cached: true });
  }, [sessionId, started]);

  return (
    <button
      type="button"
      class={`icon-btn mcp-chip-btn ${connected ? 'has-count' : ''}`}
      onClick={() => openDialog('mcp', { sessionId: sessionId || null })}
      aria-label={attention ? `MCP servers, ${attention} need attention` : 'MCP servers'}
      title={chipTitle({ connected, attention, total }, !sessionId)}
    >
      <Plug />
      <span class="topbar-label">Tools</span>
      {connected > 0 && <span class="mcp-chip-count">{connected}</span>}
      {attention > 0 && <span class="mcp-chip-dot" aria-hidden="true" />}
    </button>
  );
}
