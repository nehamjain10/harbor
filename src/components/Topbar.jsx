import { Bot, ChevronRight, Ellipsis, Target, PanelLeftOpen, PanelRightClose, PanelRightOpen, Repeat, Search, SquareTerminal } from 'lucide-preact';
import { closePanel, openDialog, openPanel, shownAgent, togglePanel, toggleSidebar } from '../actions.js';
import { togglePalette } from '../hotkeys.js';
import { ClusterBadge } from './ClusterBadge.jsx';
import { McpChip } from './McpChip.jsx';
import { shallowEqual, useAppState } from '../state.js';
import { isStopping } from '../store.js';
import { basename } from '../lib/format.js';
import { statusLabel } from '../lib/sessions.js';
import { SHORTCUTS, shortcutText } from '../lib/shortcuts.js';
import './Topbar.css';

export function Topbar() {
  const { id, title, cwd, status, stopping, backgroundAgents, project, panelOpen, collapsed, clusters, cluster, goal } = useAppState(
    (s) => {
      // While another session loads, its list entry already names it.
      const shown = (s.loadingSessionId && s.loadingSessionId !== s.current?.id && s.sessions.find((x) => x.id === s.loadingSessionId)) || s.current;
      return {
        id: shown?.id,
        title: shown?.title,
        cwd: shown?.cwd,
        status: shown?.status,
        stopping: isStopping(s),
        backgroundAgents: shown?.backgroundAgents || 0,
        goal: shown?.goal || null,
        project: s.project,
        // The cluster the shown session runs on (the session's own; a new chat's choice).
        clusters: s.clusters,
        cluster: shown ? shown.cluster || 'local' : s.cluster,
        // An agent's transcript fills the panel too (togglePanel then closes it).
        panelOpen: s.panel.open || !!shownAgent(s),
        collapsed: s.sidebarCollapsed,
      };
    },
    shallowEqual,
  );

  return (
    <header class={`topbar ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <button type="button" class="icon-btn topbar-sidebar-toggle" onClick={toggleSidebar} aria-label="Show sidebar" title="Show sidebar">
        <PanelLeftOpen />
      </button>

      <div class="crumbs">
        <button
          type="button"
          class="crumb-project"
          onClick={() => !id && openDialog('project')}
          disabled={!!id}
          title={id ? cwd : 'Choose a project'}
        >
          {basename(cwd || project)}
        </button>
        <ClusterBadge clusters={clusters} cluster={cluster} />
        <ChevronRight size={14} class="crumb-sep" />
        <button
          type="button"
          class="crumb-title"
          onClick={() => (id ? openDialog('rename', { id }) : openDialog('project'))}
          title={id ? 'Rename session' : 'Choose a project'}
        >
          {id ? title || 'New session' : 'New session'}
        </button>
        {id && <StatusPill status={status} backgroundAgents={backgroundAgents} stopping={stopping} />}
        {id && goal && <GoalBadge goal={goal} />}
      </div>

      <div class="topbar-actions">
        <button
          type="button"
          class="icon-btn"
          onClick={() => togglePalette()}
          aria-label="Search sessions and commands"
          title={`Search and commands (${shortcutText(SHORTCUTS.palette.keys)})`}
        >
          <Search />
          <span class="topbar-label">
            Search <kbd class="topbar-kbd">{shortcutText(SHORTCUTS.palette.keys)}</kbd>
          </span>
        </button>
        <button type="button" class="icon-btn topbar-agents" onClick={() => openDialog('agents')} aria-label="Agents" title="Agents: model agents and subagents (/agents)">
          <Bot />
          <span class="topbar-label">Agents</span>
        </button>
        <McpChip sessionId={id} />
        {id && <BackgroundButton />}
        <button
          type="button"
          class="icon-btn"
          onClick={togglePanel}
          disabled={!id}
          aria-pressed={String(panelOpen)}
          aria-label={panelOpen ? 'Hide files and changes' : 'Show files and changes'}
          title={`Files & changes (${shortcutText(SHORTCUTS.panel.keys)})`}
        >
          {panelOpen ? <PanelRightClose /> : <PanelRightOpen />}
          <span class="topbar-label">Files</span>
        </button>
        {id && (
          <button type="button" class="icon-btn" onClick={() => openDialog('options', { id })} aria-label="Session options" title="Session options">
            <Ellipsis />
          </button>
        )}
      </div>
    </header>
  );
}

export function StatusPill({ status, backgroundAgents = 0, stopping = false }) {
  let tone = status === 'running' ? 'running' : status === 'waiting' ? 'waiting' : status === 'error' ? 'error' : status === 'interrupted' ? 'muted' : 'idle';
  // Idle between turns, but subagents are still working in the background.
  if (tone === 'idle' && backgroundAgents > 0) tone = 'running';
  if (stopping) tone = 'muted';
  return (
    <span class={`status-pill pill-${tone}`}>
      <span class="pill-dot" />
      {stopping ? 'Stopping…' : statusLabel(status, backgroundAgents)}
    </span>
  );
}

/**
 * Shown while the session has background commands or Monitors running (with their
 * count) or jobs scheduled: opens the side panel's Background tab, or closes it.
 */
function BackgroundButton() {
  const { running, scheduled, showing } = useAppState(
    (s) => ({
      running: s.current?.liveTasks?.length || 0,
      scheduled: s.current?.crons?.length || 0,
      showing: s.panel.open && s.panel.tab === 'background' && !shownAgent(s),
    }),
    shallowEqual,
  );
  if (!running && !scheduled) return null;
  const parts = [running && `${running} running in the background`, scheduled && `${scheduled} scheduled`].filter(Boolean);
  const label = parts.join(', ');
  return (
    <button
      type="button"
      class={`icon-btn topbar-background ${running ? 'is-running' : ''}`}
      onClick={() => (showing ? closePanel() : openPanel('background'))}
      aria-pressed={String(showing)}
      aria-label={`Background tasks: ${label}`}
      title={`Background tasks: ${label} (/tasks)`}
    >
      {running ? <SquareTerminal /> : <Repeat />}
      <span class="topbar-label">Tasks</span>
      {running > 0 && <span class="topbar-badge">{running}</span>}
    </button>
  );
}

// The /goal Claude Code keeps working towards; the tooltip has it whole, with the last check.
function GoalBadge({ goal }) {
  const checks = goal.iterations === 1 ? '1 check' : `${goal.iterations} checks`;
  const tip = [`Goal: ${goal.condition}`, goal.iterations ? `Not met yet after ${checks}.` : 'Set; checked when a turn ends.', goal.lastReason ? `Last check: ${goal.lastReason}` : '', 'Clear it with /goal clear.'].filter(Boolean).join('\n\n');
  return (
    <span class="goal-badge" title={tip} aria-label={`Goal: ${goal.condition}`}>
      <Target size={12} />
      <span class="goal-text">Goal</span>
      {goal.iterations > 0 && <span class="goal-count">{goal.iterations}</span>}
    </span>
  );
}
