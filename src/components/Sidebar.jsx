import { useEffect, useState } from 'preact/hooks';
import { Bell, Ellipsis, Gauge, Import, Keyboard, Monitor, Moon, PanelLeftClose, Pin, PinOff, Plus, Search, Settings, SlidersHorizontal, Sun, Trash2, X } from 'lucide-preact';
import { closeDrawer, emptyTrash, hoverSession, leaveSession, newSession, openDialog, prefetchSession, selectSession, setFilter, setGroupBy, setSearch, setTheme, toast, togglePinned, toggleSidebar } from '../actions.js';
import { setNotificationsEnabled } from '../attention.js';
import { shallowEqual, useAppState } from '../state.js';
import { relativeTime } from '../lib/format.js';
import { clusterLabel } from '../lib/clusters.js';
import { FILTERS, GROUP_BYS, countForFilter, groupSessions, sessionDot, sortTime } from '../lib/sessions.js';
import { SHORTCUTS, isApple, shortcutText } from '../lib/shortcuts.js';
import { BrandMark } from './BrandMark.jsx';
import { ClusterBadge } from './ClusterBadge.jsx';
import { Keys } from './Keys.jsx';
import { Popover } from './Popover.jsx';
import './Sidebar.css';

const DOT_LABELS = { running: 'Working', 'needs-you': 'Needs you', error: 'Error', unread: 'Unread' };
const CONNECTION_LABELS = { live: 'Connected', polling: 'Syncing', offline: 'Reconnecting…', connecting: 'Connecting…' };

// Re-renders every minute so relative times stay fresh.
function useMinuteTick() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function Sidebar() {
  const { sessions, filter, search, currentId, loadingId, booting, isV2, clusters, groupBy } = useAppState(
    (s) => ({
      sessions: s.sessions,
      filter: s.filter,
      search: s.search,
      currentId: s.current?.id,
      loadingId: s.loadingSessionId,
      booting: s.booting,
      isV2: s.isV2,
      clusters: s.clusters,
      groupBy: s.groupBy,
    }),
    shallowEqual,
  );
  const now = useMinuteTick();
  // Grouping by device only means something when there is more than one.
  const by = clusters.length > 1 ? groupBy : 'date';
  const groups = groupSessions(sessions, { filter, query: search, now, by, clusters });
  const firstLoad = booting && !sessions.length;

  return (
    <aside class="sidebar" aria-label="Sessions">
      <div class="sidebar-head">
        <a
          class="brand"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            newSession();
          }}
        >
          <BrandMark size={24} />
          <span class="brand-word">Harbor</span>
        </a>
        <button type="button" class="icon-btn" onClick={toggleSidebar} aria-label="Hide sidebar" title={`Hide sidebar (${shortcutText(SHORTCUTS.sidebar.keys)})`}>
          <PanelLeftClose />
        </button>
      </div>

      <div class="new-session-row">
        <button type="button" class="new-session" onClick={newSession} title={`New session (${shortcutText(SHORTCUTS.newSession.keys)})`}>
          <span class="new-session-icon" aria-hidden="true">
            <Plus size={15} strokeWidth={2.25} />
          </span>
          <span>New session</span>
          {/* "Ctrl Shift O" does not fit beside the import button; the tooltip has it. */}
          {isApple() && <Keys keys={SHORTCUTS.newSession.keys} class="new-session-keys" />}
        </button>
        <button type="button" class="import-sessions" onClick={openImport} aria-label="Import sessions" title="Import Claude Code or Codex sessions">
          <Import />
        </button>
      </div>

      <label class="sidebar-search">
        <Search size={15} />
        <input
          type="search"
          value={search}
          placeholder="Search sessions"
          aria-label="Search sessions"
          onInput={(event) => setSearch(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && search) {
              event.stopPropagation();
              setSearch('');
            }
          }}
        />
        {search && (
          <button type="button" class="icon-btn icon-btn-sm" onClick={() => setSearch('')} aria-label="Clear search">
            <X size={14} />
          </button>
        )}
      </label>

      <div class="segmented sidebar-filters" role="group" aria-label="Filter sessions">
        {FILTERS.map((f) => (
          <button type="button" key={f.id} aria-pressed={String(filter === f.id)} onClick={() => setFilter(f.id)}>
            {f.label}
            {f.id !== 'active' && countForFilter(sessions, f.id) > 0 && <span class="filter-count">{countForFilter(sessions, f.id)}</span>}
          </button>
        ))}
      </div>

      <nav class="session-list">
        {filter === 'trash' && !search && countForFilter(sessions, 'trash') > 0 && <EmptyTrash count={countForFilter(sessions, 'trash')} />}
        {groups.map((group) => (
          <section class="session-group" key={group.label}>
            <h3 class="session-group-label">
              {group.label === 'Pinned' && <Pin size={12} />}
              {group.label}
            </h3>
            {group.sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                clusters={clusters}
                showCluster={!group.cluster}
                active={session.id === (loadingId || currentId)}
                loading={session.id === loadingId}
                canPin={(isV2 || 'pinned' in session) && !session.removed}
                now={now}
              />
            ))}
          </section>
        ))}
        {firstLoad && <SessionSkeleton />}
        {!groups.length && !firstLoad && (
          <div class="session-empty">
            <p>{emptyText({ search, filter })}</p>
            {!search && filter === 'active' && (
              <button type="button" class="session-empty-action" onClick={openImport}>
                <Import size={14} />
                Import from Claude Code or Codex
              </button>
            )}
          </div>
        )}
      </nav>

      <SidebarFooter />
    </aside>
  );
}

// Deletes everything in Trash for good, after a second click to confirm.
function EmptyTrash({ count }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  const run = async () => {
    if (!armed) return setArmed(true);
    setBusy(true);
    try {
      const { deleted, kept } = await emptyTrash();
      toast(`Deleted ${deleted} ${deleted === 1 ? 'chat' : 'chats'} for good.${kept ? ` ${kept} still running ${kept === 1 ? 'was' : 'were'} kept.` : ''}`);
    } catch (error) {
      toast(error.message);
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };
  return (
    <button type="button" class={`empty-trash${armed ? ' is-armed' : ''}`} onClick={run} disabled={busy}>
      <Trash2 size={14} />
      {busy ? 'Deleting…' : armed ? `Delete ${count} forever? Click again` : 'Empty Trash'}
    </button>
  );
}

// On a phone the drawer gives way to the import sheet.
function openImport() {
  closeDrawer();
  openDialog('import');
}

function emptyText({ search, filter }) {
  if (search) return 'No matching sessions.';
  if (filter === 'trash') return 'Trash is empty.';
  if (filter === 'archived') return 'No archived sessions.';
  return 'Your conversations will appear here.';
}

// Placeholder rows while the first session list loads.
function SessionSkeleton() {
  return (
    <div class="session-skeleton">
      <p class="sr-only" role="status">
        Loading your sessions…
      </p>
      <span class="skeleton-bar skeleton-label" aria-hidden="true" />
      {[74, 56, 88, 62, 80, 48, 68].map((width, i) => (
        <div class="skeleton-row" key={i} style={{ '--w': width + '%', '--delay': i * 70 + 'ms' }} aria-hidden="true">
          <span class="skeleton-bar skeleton-title" />
          <span class="skeleton-bar skeleton-meta" />
        </div>
      ))}
    </div>
  );
}

function SessionRow({ session, clusters, showCluster = true, active, loading, canPin, now }) {
  const dot = sessionDot(session, { current: active });
  const title = session.title || 'New session';
  const cluster = clusterLabel(clusters, session.cluster);
  // Native tooltip: the full title when it is cut off, and always the full path.
  const describe = (event) => {
    // Resting on the row starts loading it (see hoverSession).
    if (event.pointerType === 'mouse' && !active) hoverSession(session.id);
    const button = event.currentTarget;
    const titleEl = button.querySelector('.session-title');
    const truncated = titleEl && titleEl.scrollWidth > titleEl.clientWidth;
    button.title = [truncated ? title : '', `${session.cwd} · ${relativeTime(sortTime(session), now)}`, cluster ? `Runs on ${cluster}` : '', session.source ? `Imported from ${session.source.kind === 'codex' ? 'Codex' : 'Claude Code'}` : ''].filter(Boolean).join('\n');
  };
  const classes = ['session-row', active && 'is-active', loading && 'is-loading', dot === 'unread' && 'is-unread', canPin && 'can-pin'];
  return (
    <div class={classes.filter(Boolean).join(' ')}>
      <button
        type="button"
        class="session-main"
        onPointerDown={(event) => event.button === 0 && event.pointerType === 'mouse' && prefetchSession(session.id)}
        onClick={() => selectSession(session.id)}
        onPointerEnter={describe}
        onPointerLeave={leaveSession}
        aria-current={active ? 'page' : undefined}
      >
        {showCluster && <ClusterBadge clusters={clusters} cluster={session.cluster} />}
        <span class="session-title">{title}</span>
      </button>
      {dot && <span class={`status-dot dot-${dot}`} title={DOT_LABELS[dot]} aria-label={DOT_LABELS[dot]} />}
      <div class="session-actions">
        {canPin && (
          <button
            type="button"
            class="icon-btn icon-btn-sm session-pin"
            onClick={() => togglePinned(session.id)}
            aria-label={`${session.pinned ? 'Unpin' : 'Pin'} ${title}`}
            title={session.pinned ? 'Unpin' : 'Pin to top'}
          >
            {session.pinned ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
        )}
        <button type="button" class="icon-btn icon-btn-sm session-more" onClick={() => openDialog('options', { id: session.id })} aria-label={`Options for ${title}`} title="Options">
          <Ellipsis />
        </button>
      </div>
    </div>
  );
}

function SidebarFooter() {
  const { connection, dashboard, theme, notifications, permission, groupBy, manyClusters } = useAppState(
    (s) => ({ connection: s.connection, dashboard: s.info?.dashboard, theme: s.theme, notifications: s.notifications, permission: s.notificationPermission, groupBy: s.groupBy, manyClusters: s.clusters.length > 1 }),
    shallowEqual,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <footer class="sidebar-foot">
      <div class={`connection conn-${connection}`} role="status">
        <span class="conn-dot" />
        <span>{CONNECTION_LABELS[connection] || 'Connecting…'}</span>
      </div>
      {dashboard && (
        <a class="icon-btn" href={dashboard} target="_blank" rel="noopener noreferrer" aria-label="Usage dashboard" title="Usage dashboard">
          <Gauge />
        </a>
      )}
      <button type="button" class="icon-btn" aria-expanded={String(settingsOpen)} aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(!settingsOpen)}>
        <Settings />
      </button>
      {settingsOpen && (
        <Popover onClose={() => setSettingsOpen(false)} placement="above" label="Settings" class="settings-popover">
          <div class="popover-group">Theme</div>
          <div class="segmented theme-switch" role="radiogroup" aria-label="Theme">
            {[
              ['system', 'System', <Monitor size={14} />],
              ['dark', 'Dark', <Moon size={14} />],
              ['light', 'Light', <Sun size={14} />],
            ].map(([id, label, icon]) => (
              <button type="button" key={id} role="radio" aria-checked={String(theme === id)} aria-pressed={String(theme === id)} onClick={() => setTheme(id)}>
                {icon}
                {label}
              </button>
            ))}
          </div>
          {manyClusters && (
            <>
              <div class="popover-group">Group sessions by</div>
              <div class="segmented theme-switch" role="radiogroup" aria-label="Group sessions by">
                {GROUP_BYS.map((g) => (
                  <button type="button" key={g.id} role="radio" aria-checked={String(groupBy === g.id)} aria-pressed={String(groupBy === g.id)} onClick={() => setGroupBy(g.id)}>
                    {g.label}
                  </button>
                ))}
              </div>
            </>
          )}
          <div class="popover-group">Notifications</div>
          <button
            type="button"
            role="switch"
            class="setting-row"
            aria-checked={String(notifications)}
            disabled={permission === 'unsupported'}
            onClick={() => setNotificationsEnabled(!notifications)}
          >
            <span class="setting-icon">
              <Bell size={15} />
            </span>
            <span class="setting-text">
              <span class="setting-label">Desktop notifications</span>
              <span class="setting-note">{notificationNote(permission, notifications)}</span>
            </span>
            <span class="switch" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="setting-row"
            onClick={() => {
              setSettingsOpen(false);
              openDialog('shortcuts');
            }}
          >
            <span class="setting-icon">
              <Keyboard size={15} />
            </span>
            <span class="setting-text">
              <span class="setting-label">Keyboard shortcuts</span>
            </span>
            <Keys keys={SHORTCUTS.help.keys} />
          </button>
          <div class="popover-group">Claude Code</div>
          <button
            type="button"
            class="setting-row"
            onClick={() => {
              setSettingsOpen(false);
              closeDrawer();
              openDialog('settings');
            }}
          >
            <span class="setting-icon">
              <SlidersHorizontal size={15} />
            </span>
            <span class="setting-text">
              <span class="setting-label">Claude Code settings…</span>
              <span class="setting-note">Permissions, hooks, CLAUDE.md, memory</span>
            </span>
          </button>
        </Popover>
      )}
    </footer>
  );
}

function notificationNote(permission, enabled) {
  if (permission === 'unsupported') return 'Not supported in this browser';
  if (permission === 'denied') return 'Blocked in this site’s browser settings';
  return enabled ? 'When a session finishes or needs you' : 'Get told when a session finishes or needs you';
}
