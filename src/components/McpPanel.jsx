// MCP servers of a session (or, without one, of a project folder): what Claude Code has
// connected, a switch to leave a server out of this session, Reconnect, and signing in to
// the servers that need it. Opens from the topbar chip, the palette and `/mcp`.
//
// Switching a server off hides its tools from Claude in this session only. Signing in
// to a claude.ai connector happens on claude.ai (a link, then Reconnect); other OAuth
// servers (Slack's plugin) give an authorization link, and the browser ends on a
// localhost address that cannot load on the user's own machine: they paste it back here.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ChevronRight, CircleAlert, CircleCheck, Copy, ExternalLink, Info, LoaderCircle, Lock, RefreshCw, Search } from 'lucide-preact';
import { closeDialog, toast } from '../actions.js';
import { cancelSignIn, entryFor, finishSignIn, loadMcp, projectKey, reconnectServer, setServerEnabled, signOutServer, startSignIn, syncDisabled } from '../mcp.js';
import { shallowEqual, useAppState } from '../state.js';
import { basename } from '../lib/format.js';
import { ago, displayName, filterServers, groupServers, looksLikeCallback, statusLabel, statusTone, toolLabel } from '../lib/mcp.js';
import { findModel } from '../lib/models.js';
import { Dialog } from './Dialog.jsx';
import './McpPanel.css';

const SEARCH_FROM = 8; // a filter box once the list is this long
const FOLD_FROM = 5; // connectors that are not set up fold away beyond this many
const MAX_TOOLS = 40;

function routeNote(route, readOnly) {
  if (route === 'gateway') {
    return 'This chat runs through the model gateway, so claude.ai connectors do not apply. The servers of Claude Code’s own configuration and its plugins are listed, and you sign in to them here.';
  }
  if (readOnly) return 'New chats on Claude use your Claude login, so your claude.ai connectors are listed too.';
  return 'This chat runs on Claude, so your claude.ai connectors are available. Connect a connector on claude.ai, then press Reconnect here.';
}

export function McpDialog({ sessionId }) {
  const { title, cwd } = useAppState((s) => {
    const session = sessionId ? (s.current?.id === sessionId ? s.current : s.sessions.find((x) => x.id === sessionId)) : null;
    return { title: session?.title, cwd: session?.cwd || s.project };
  }, shallowEqual);
  return (
    <Dialog
      title="MCP servers"
      eyebrow={sessionId ? 'This session' : 'No session open'}
      subtitle={sessionId ? title : basename(cwd || '')}
      onClose={closeDialog}
      class="mcp-dialog"
      initialFocus=".dialog-header .icon-btn"
    >
      <McpPanel sessionId={sessionId} />
    </Dialog>
  );
}

export function McpPanel({ sessionId }) {
  const { found, title, cwd, route, cluster, disabled, entry } = useAppState((s) => {
    const session = sessionId ? (s.current?.id === sessionId ? s.current : s.sessions.find((x) => x.id === sessionId)) : null;
    const model = findModel(s.info, session?.model || s.model);
    const route = model.provider === 'Claude' ? 'claude' : 'gateway';
    const cwd = session?.cwd || s.project || '';
    // Without a session this is the new chat's folder, on the cluster chosen for its chat.
    const cluster = session?.cluster || s.cluster || 'local';
    return {
      found: Boolean(session),
      title: session?.title,
      cwd,
      route,
      cluster,
      // The session's own list, as a key (rows follow it when another tab changes it).
      disabled: JSON.stringify(session?.mcpDisabled || []),
      entry: entryFor(s, sessionId || projectKey(cwd, route, cluster)),
    };
  }, shallowEqual);
  const readOnly = !sessionId || !found;
  const key = readOnly ? projectKey(cwd, route, cluster) : sessionId;
  const target = useMemo(() => (readOnly ? { cwd, route, cluster } : { sessionId }), [readOnly, cwd, route, cluster, sessionId]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [showAll, setShowAll] = useState(false);
  // Re-renders while a sign-in waits (its link expires) and keeps the "ago" fresh.
  const [, tick] = useState(0);

  useEffect(() => {
    loadMcp(target);
  }, [target]);
  // Only when the session's list changes (another tab); an answer of our own toggle comes first.
  useEffect(() => {
    if (!readOnly) syncDisabled(key, JSON.parse(disabled));
  }, [disabled, key, readOnly]);
  const waiting = Object.keys(entry.signIn).length > 0;
  useEffect(() => {
    const timer = setInterval(
      () => {
        tick((n) => n + 1);
        // A sign-in finished in the browser on the same machine connects by itself.
        if (waiting && !entry.loading) loadMcp(target, { cached: true });
      },
      waiting ? 3000 : 30_000,
    );
    return () => clearInterval(timer);
  }, [waiting, target, entry.loading]);

  const servers = entry.servers;
  const visible = useMemo(() => (servers ? filterServers(servers, query) : []), [servers, query]);
  const groups = useMemo(() => groupServers(visible), [visible]);
  const toggleOpen = (name) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  return (
    <div class="mcp-panel">
      <div class="mcp-meta">
        <span class="mcp-meta-text">
          {servers
            ? `${entry.live ? 'Live from this session’s Claude Code' : `Checked in ${basename(cwd) || 'the project folder'}, no process running`} · ${ago(entry.at)}`
            : entry.loading
              ? 'Asking Claude Code…'
              : ''}
        </span>
        <button type="button" class="icon-btn icon-btn-sm" onClick={() => loadMcp(target, { fresh: true })} disabled={entry.loading} aria-label="Refresh" title="Ask Claude Code again">
          <RefreshCw size={14} class={entry.loading ? 'spin' : ''} />
        </button>
      </div>
      <p class="mcp-note">{routeNote(route, readOnly)}</p>
      {cluster !== 'local' && <p class="mcp-note">This folder is on another cluster: the servers Claude Code has there are listed on that machine, not here.</p>}
      {readOnly && <p class="mcp-note mcp-note-warn">No session is open, so this is a read-only look. Open or start a session to switch servers or sign in.</p>}
      {entry.notice && !readOnly && <p class="mcp-note mcp-note-info">{entry.notice}</p>}

      {entry.error && (
        <p class="mcp-error" role="alert">
          <CircleAlert size={14} /> {servers ? 'Could not refresh: ' : 'Could not list the servers: '}
          {entry.error}
        </p>
      )}
      {!servers && entry.loading && (
        <p class="mcp-status-line">
          <LoaderCircle size={14} class="spin" /> Starting Claude Code to list the servers. This can take several seconds.
        </p>
      )}

      {servers && servers.length > SEARCH_FROM && (
        <label class="mcp-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            class="mcp-search-input"
            value={query}
            placeholder="Filter servers and tools"
            aria-label="Filter servers and tools"
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      )}

      {servers && groups.length === 0 && <p class="mcp-status-line">{query ? 'No server matches.' : 'No MCP servers are configured here.'}</p>}

      {groups.map((group) => {
        // Most of an account's connectors are not set up: fold those away unless asked for.
        const idle = group.id === 'claudeai' && !query ? group.servers.filter((server) => server.status === 'needs-auth' && !entry.signIn[server.name]) : [];
        const folded = idle.length > FOLD_FROM && !showAll;
        const rows = folded ? group.servers.filter((server) => !idle.includes(server)) : group.servers;
        return (
          <section class="mcp-group" key={group.id} aria-label={group.label}>
            <div class="eyebrow mcp-group-head">
              {group.label}
              <span class="mcp-count">{group.servers.length}</span>
            </div>
            <ul class="mcp-list">
              {rows.map((server) => (
                <ServerRow
                  key={server.name}
                  server={server}
                  sessionId={readOnly ? null : sessionId}
                  busy={entry.busy[server.name]}
                  note={entry.notes[server.name]}
                  signIn={entry.signIn[server.name]}
                  open={open.has(server.name)}
                  onOpen={() => toggleOpen(server.name)}
                />
              ))}
            </ul>
            {idle.length > FOLD_FROM && (
              <button type="button" class="btn btn-sm btn-ghost mcp-fold" onClick={() => setShowAll(!showAll)}>
                {showAll ? 'Hide connectors that are not set up' : `Show ${idle.length} connectors that are not set up`}
              </button>
            )}
          </section>
        );
      })}

      {servers && entry.hidden.length > 0 && !query && (
        <section class="mcp-group" aria-label="Left out by Claude Code">
          <div class="eyebrow mcp-group-head">
            Left out by Claude Code<span class="mcp-count">{entry.hidden.length}</span>
          </div>
          <ul class="mcp-hidden">
            {entry.hidden.map((item) => (
              <li key={item.name}>
                <code>{item.name}</code> <span>{item.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ServerRow({ server, sessionId, busy, note, signIn, open, onOpen }) {
  const { title, context } = displayName(server);
  const tone = statusTone(server);
  const interactive = Boolean(sessionId);
  const detail = server.status === 'failed' && server.error ? server.error : [server.toolCount ? `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}` : null, server.url || (server.type === 'stdio' ? 'local command' : null)].filter(Boolean).join(' · ');
  // Off for this session, or off in Claude Code's own settings for the project (turning that one on writes them).
  const off = Boolean(server.disabledInSession) || server.status === 'disabled';
  const canSignIn = interactive && server.auth && server.status === 'needs-auth';
  const canSignOut = interactive && server.auth === 'oauth' && server.status === 'connected';
  // A connector that needs a sign-in may have been connected on claude.ai since; a server that
  // needs OAuth only gets better by signing in.
  const canReconnect = interactive && !server.builtin && !signIn && (server.status === 'failed' || (server.status === 'needs-auth' && server.auth === 'claudeai'));
  const tools = server.tools || [];
  const expandable = tools.length > 0;

  return (
    <li class={`mcp-row tone-${tone} ${server.disabledInSession ? 'is-off' : ''}`}>
      <div class="mcp-row-main">
        {expandable ? (
          <button type="button" class="mcp-row-head" aria-expanded={String(open)} onClick={onOpen} title={open ? 'Hide tools' : 'Show tools'}>
            <RowHead title={title} context={context} server={server} chevron />
          </button>
        ) : (
          <div class="mcp-row-head">
            <RowHead title={title} context={context} server={server} />
          </div>
        )}
        {server.builtin ? (
          <span class="mcp-always" title="Harbor’s own server cannot be switched off">
            <Lock size={12} aria-hidden="true" /> Always on
          </span>
        ) : (
          <button
            type="button"
            role="switch"
            class="mcp-switch"
            aria-checked={String(!off)}
            aria-label={`Use ${title} in this session`}
            title={switchTitle(title, server, interactive)}
            disabled={!interactive || busy === 'toggle'}
            onClick={() => setServerEnabled(sessionId, server.name, off)}
          >
            <span class="switch" aria-hidden="true" />
          </button>
        )}
      </div>

      {detail && <div class={`mcp-detail ${server.status === 'failed' ? 'is-error' : ''}`}>{detail}</div>}

      {(canSignIn || canSignOut || canReconnect) && !signIn && (
        <div class="mcp-actions">
          {canSignIn && (
            <button type="button" class="btn btn-sm btn-primary" disabled={Boolean(busy)} onClick={() => startSignIn(sessionId, server.name)}>
              {busy === 'auth' ? <LoaderCircle size={14} class="spin" /> : null}
              {server.auth === 'claudeai' ? 'Connect…' : 'Sign in…'}
            </button>
          )}
          {canReconnect && (
            <button type="button" class="btn btn-sm btn-secondary" disabled={Boolean(busy)} onClick={() => reconnectServer(sessionId, server.name)}>
              {busy === 'reconnect' ? <LoaderCircle size={14} class="spin" /> : null}
              Reconnect
            </button>
          )}
          {canSignOut && (
            <button type="button" class="btn btn-sm btn-ghost" disabled={Boolean(busy)} onClick={() => signOutServer(sessionId, server.name)}>
              {busy === 'clear' ? <LoaderCircle size={14} class="spin" /> : null}
              Sign out
            </button>
          )}
        </div>
      )}

      {note && (
        <p class={`mcp-row-note is-${note.tone}`} role={note.tone === 'error' ? 'alert' : 'status'}>
          {note.tone === 'ok' ? <CircleCheck size={14} /> : note.tone === 'info' ? <Info size={14} /> : <CircleAlert size={14} />} {note.text}
        </p>
      )}

      {signIn && <SignIn server={server} sessionId={sessionId} signIn={signIn} busy={busy} />}

      {open && expandable && (
        <ul class="mcp-tools" aria-label={`${title} tools`}>
          {tools.slice(0, MAX_TOOLS).map((tool) => (
            <li key={tool.name} class="mcp-tool" title={tool.description || undefined}>
              <span class="mcp-tool-name">{toolLabel(tool.name)}</span>
              {tool.destructive && <span class="mcp-tool-flag is-destructive">changes things</span>}
              {tool.readOnly && <span class="mcp-tool-flag">read only</span>}
            </li>
          ))}
          {tools.length > MAX_TOOLS && <li class="mcp-tool mcp-tool-more">+{tools.length - MAX_TOOLS} more</li>}
        </ul>
      )}
    </li>
  );
}

function switchTitle(title, server, interactive) {
  if (!interactive) return 'Open a session to switch servers';
  if (server.status === 'disabled') return `${title} is off in Claude Code for this project. Turning it on changes that setting too.`;
  return server.disabledInSession ? `Allow ${title} in this session` : `Leave ${title} out of this session`;
}

function RowHead({ title, context, server, chevron = false }) {
  return (
    <>
      <span class="mcp-dot" aria-hidden="true" />
      <span class="mcp-name">{title}</span>
      {context && <span class="mcp-chip">{context}</span>}
      <span class="mcp-status">{statusLabel(server)}</span>
      {chevron ? <ChevronRight size={14} class="mcp-chevron" aria-hidden="true" /> : <span class="mcp-chevron-slot" aria-hidden="true" />}
    </>
  );
}

// Seconds left until `at` (a time in ms), counted down every second; null without a deadline.
function useCountdown(at) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!at) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [at]);
  return at ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}

const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

// The steps of a sign-in in progress. An OAuth server also gets the paste field.
function SignIn({ server, sessionId, signIn, busy }) {
  const [text, setText] = useState('');
  const input = useRef(null);
  const claudeai = signIn.kind === 'claudeai';
  const left = useCountdown(signIn.expiresAt);
  const expired = left !== null && left <= 0;
  const typed = text.trim();
  const valid = looksLikeCallback(typed);
  const submit = () => valid && !busy && finishSignIn(sessionId, server.name, typed);
  const copyLink = () => {
    navigator.clipboard?.writeText(signIn.authUrl).then(
      () => toast('Link copied.'),
      () => toast('Could not copy the link.'),
    );
  };

  if (expired) {
    return (
      <div class="mcp-signin">
        <p class="mcp-signin-text">This sign-in link expired. Links last about five minutes.</p>
        <div class="mcp-actions">
          <button type="button" class="btn btn-sm btn-primary" disabled={Boolean(busy)} onClick={() => startSignIn(sessionId, server.name)}>
            {busy === 'auth' ? <LoaderCircle size={14} class="spin" /> : null}
            Get a new link
          </button>
          <button type="button" class="btn btn-sm btn-ghost" onClick={() => cancelSignIn(sessionId, server.name)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="mcp-signin">
      <ol class="mcp-steps">
        {signIn.instructions.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <div class="mcp-actions">
        <a class="btn btn-sm btn-primary" href={signIn.authUrl} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={14} /> {claudeai ? 'Open claude.ai' : 'Open sign-in page'}
        </a>
        <button type="button" class="btn btn-sm btn-ghost" onClick={copyLink}>
          <Copy size={14} /> Copy link
        </button>
        {!claudeai && (
          <button type="button" class="btn btn-sm btn-ghost" disabled={Boolean(busy)} onClick={() => startSignIn(sessionId, server.name)} title="Start the sign-in again">
            {busy === 'auth' ? <LoaderCircle size={14} class="spin" /> : null}
            Get a new link
          </button>
        )}
        {claudeai && (
          <button type="button" class="btn btn-sm btn-secondary" disabled={Boolean(busy)} onClick={() => reconnectServer(sessionId, server.name)}>
            {busy === 'reconnect' ? <LoaderCircle size={14} class="spin" /> : null}
            Reconnect
          </button>
        )}
        <button type="button" class="btn btn-sm btn-ghost mcp-cancel" onClick={() => cancelSignIn(sessionId, server.name)}>
          Cancel
        </button>
      </div>
      {!claudeai && (
        <div class="mcp-paste">
          <input
            ref={input}
            type="text"
            class="input mcp-paste-input"
            value={text}
            placeholder={`http://localhost:${signIn.callbackPort || 3118}/callback?code=…`}
            aria-label="Address copied from the browser"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            onInput={(event) => setText(event.currentTarget.value)}
            onKeyDown={(event) => event.key === 'Enter' && submit()}
          />
          <button type="button" class="btn btn-primary mcp-paste-button" disabled={!valid || Boolean(busy)} onClick={submit}>
            {busy === 'callback' ? <LoaderCircle size={14} class="spin" /> : null}
            Finish sign-in
          </button>
        </div>
      )}
      {left !== null && (
        <p class={`mcp-countdown ${left < 60 ? 'is-soon' : ''}`} role="timer" aria-live="off">
          Link expires in {clock(left)}
        </p>
      )}
      {!claudeai && typed && !valid && <p class="mcp-signin-hint">That is not the address yet. It starts with http://localhost and has code= in it.</p>}
    </div>
  );
}
