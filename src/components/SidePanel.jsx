// Right-hand panel: Changes (git diff), Files (browser + viewer), Plan, and in place of
// those an agent's transcript while one is shown (AgentPanel.jsx).
// Resizable on desktop; an overlay sheet on tablets and a bottom sheet on phones.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ClipboardList,
  File,
  FileCode,
  FileImage,
  FileLock,
  FileQuestion,
  FileText,
  FileX,
  Folder,
  FolderLock,
  GitBranch,
  Info,
  RefreshCw,
  WrapText,
  X,
} from 'lucide-preact';
import { api } from '../api.js';
import { browseTo, chooseMode, closePanel, setPanelTab, shownAgent, toggleAgentWide } from '../actions.js';
import { shallowEqual, useAppState } from '../state.js';
import { parseDiff, statusLetter } from '../lib/diff.js';
import { basename, dirname, relativeTime } from '../lib/format.js';
import { languageForPath } from '../lib/highlight.js';
import { KEYS, getItem, setItem } from '../lib/storage.js';
import { todoProgress } from '../lib/todos.js';
import { AgentPanel } from './AgentPanel.jsx';
import { BackgroundView } from './BackgroundPanel.jsx';
import { CodeView, DiffView } from './Code.jsx';
import { DiffStats } from './DiffStats.jsx';
import { Markdown } from './Markdown.jsx';
import { ProgressRing, TodoList } from './TodoList.jsx';
import { CopyButton } from './tools/shared.jsx';
import './SidePanel.css';

const MIN_WIDTH = 360;
const MAX_WIDTH = 960;
const DEFAULT_WIDTH = 520;
// Changes refresh this long after the last edit or command finishes.
const REFRESH_DELAY = 1500;
// Diffs longer than this start collapsed.
const LARGE_DIFF_ROWS = 400;

const clampWidth = (w) => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));

const TABS = [
  ['changes', 'Changes'],
  ['files', 'Files'],
  ['plan', 'Plan'],
  ['background', 'Background'],
];

// Tools whose completion can change the working tree.
const CHANGING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash']);
const signalCache = new WeakMap();

// Count of finished tool calls that may have changed files; it grows when one
// completes, which schedules a refresh of the Changes tab.
export function changeSignal(messages) {
  if (!Array.isArray(messages)) return 0;
  if (signalCache.has(messages)) return signalCache.get(messages);
  let count = 0;
  for (const m of messages) if (m.role === 'tool' && CHANGING_TOOLS.has(m.tool) && m.state && m.state !== 'running') count += 1;
  signalCache.set(messages, count);
  return count;
}

export function SidePanel() {
  const { open, tab, sessionId, agents, wide, running } = useAppState((s) => {
    const agents = shownAgent(s);
    return {
      open: (s.panel.open || !!agents) && !!s.current,
      tab: s.panel.tab,
      sessionId: s.current?.id,
      agents,
      wide: !!agents && s.agent.wide,
      running: s.current?.liveTasks?.length || 0,
    };
  }, shallowEqual);
  const [width, setWidth] = useState(() => clampWidth(Number(getItem(KEYS.panelWidth)) || DEFAULT_WIDTH));
  const [wrap, setWrap] = useState(() => getItem(KEYS.wrap) !== 'false');
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const sheet = useRef(null);

  if (!open) return null;
  const activeTab = TABS.some(([id]) => id === tab) ? tab : 'changes';

  const startResize = (event) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    // Resizing a widened panel starts from where it is.
    if (wide) {
      setWidth(clampWidth(sheet.current?.getBoundingClientRect().width || width));
      toggleAgentWide();
    }
    const onMove = (e) => setWidth(clampWidth(window.innerWidth - e.clientX));
    const onUp = (e) => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      setWidth((w) => {
        setItem(KEYS.panelWidth, String(w));
        return w;
      });
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  };

  // Phone bottom sheet: drag the handle down to dismiss, tap to close.
  const startDrag = (event) => {
    const panel = sheet.current;
    if (!panel) return;
    const handle = event.currentTarget;
    const startY = event.clientY;
    let delta = 0;
    handle.setPointerCapture(event.pointerId);
    // Follow the finger without the open/close transition lagging behind.
    panel.style.transition = 'none';
    const onMove = (e) => {
      delta = Math.max(0, e.clientY - startY);
      panel.style.transform = `translateY(${delta}px)`;
    };
    const onUp = (e) => {
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      panel.style.transition = '';
      panel.style.transform = '';
      if (e.type === 'pointerup' && (delta > 90 || delta < 4)) closePanel();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  const toggleWrap = () => {
    setWrap(!wrap);
    setItem(KEYS.wrap, String(!wrap));
  };

  return (
    <>
      <div class="panel-scrim" onClick={closePanel} />
      <aside
        ref={sheet}
        class={`side-panel ${wrap ? 'wrap-lines' : ''} ${agents ? 'is-agent' : ''} ${wide ? 'is-wide' : ''}`}
        style={{ '--panel-width': width + 'px' }}
        aria-label={agents ? 'Agent transcript' : 'Changes, files and plan'}
      >
        <div class="panel-resize" onPointerDown={startResize} role="separator" aria-orientation="vertical" aria-label="Resize panel" />
        <div class="panel-grab" onPointerDown={startDrag} aria-hidden="true">
          <span />
        </div>
        {agents ? (
          <AgentPanel path={agents} wide={wide} />
        ) : (
          <>
            <header class="panel-head">
              <div class="segmented panel-tabs" role="tablist">
                {TABS.map(([id, label]) => (
                  <button type="button" key={id} role="tab" aria-selected={String(activeTab === id)} aria-pressed={String(activeTab === id)} onClick={() => setPanelTab(id)}>
                    {label}
                    {id === 'background' && running > 0 && <span class="panel-tab-count">{running}</span>}
                  </button>
                ))}
              </div>
              <div class="panel-actions">
                {activeTab === 'changes' && (
                  <button type="button" class="icon-btn" onClick={() => setRefreshNonce(refreshNonce + 1)} aria-label="Refresh changes" title="Refresh">
                    <RefreshCw size={15} class={refreshing ? 'spin' : ''} />
                  </button>
                )}
                {activeTab !== 'plan' && activeTab !== 'background' && (
                  <button type="button" class="icon-btn" onClick={toggleWrap} aria-pressed={String(wrap)} aria-label="Wrap long lines" title="Wrap long lines">
                    <WrapText size={16} />
                  </button>
                )}
                <button type="button" class="icon-btn" onClick={closePanel} aria-label="Close panel" title="Close">
                  <X />
                </button>
              </div>
            </header>
            <div class="panel-body">
              {activeTab === 'changes' && <ChangesView key={sessionId} sessionId={sessionId} refreshNonce={refreshNonce} onRefreshing={setRefreshing} />}
              {activeTab === 'files' && <FilesView key={sessionId} sessionId={sessionId} />}
              {activeTab === 'plan' && <PlanView />}
              {activeTab === 'background' && <BackgroundView key={sessionId} sessionId={sessionId} />}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

// Loads `load()` whenever `deps` change, keeping the last data while reloading.
function useRequest(load, deps) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    load()
      .then((data) => !cancelled && setState({ loading: false, data, error: null }))
      .catch((error) => !cancelled && setState({ loading: false, data: null, error: { message: error.message, status: error.status || 0 } }));
    return () => {
      cancelled = true;
    };
  }, deps);
  return state;
}

function PanelMessage({ icon: Icon, title, children, action }) {
  return (
    <div class="panel-message">
      {Icon && (
        <span class="panel-message-icon">
          <Icon size={20} />
        </span>
      )}
      {title && <b>{title}</b>}
      {children && <span>{children}</span>}
      {action}
    </div>
  );
}

/* Changes */

function ChangesView({ sessionId, refreshNonce, onRefreshing }) {
  const signal = useAppState((s) => changeSignal(s.current?.messages));
  const [reloadKey, setReloadKey] = useState(0);
  // Opening the panel or a session may reuse a result a few seconds old (sessions in one
  // folder share it); a refresh or a reload after an edit asks for a fresh one.
  const loaded = useRef(false);
  const { loading, data, error } = useRequest(() => {
    const fresh = loaded.current ? '?fresh=1' : '';
    loaded.current = true;
    return api.get(`sessions/${encodeURIComponent(sessionId)}/changes${fresh}`, { timeout: 90_000 });
  }, [sessionId, refreshNonce, reloadKey]);
  const [collapsed, setCollapsed] = useState(() => new Map());
  const fileRefs = useRef(new Map());

  useEffect(() => onRefreshing(loading), [loading]);
  useEffect(() => () => onRefreshing(false), []);

  // Refresh after an edit or command finishes (debounced: bursts refresh once).
  const firstSignal = useRef(signal);
  useEffect(() => {
    if (signal === firstSignal.current) return undefined;
    const timer = setTimeout(() => setReloadKey((k) => k + 1), REFRESH_DELAY);
    return () => clearTimeout(timer);
  }, [signal]);

  const diffs = useMemo(() => parseDiff(data?.diff || ''), [data?.diff]);
  const files = useMemo(() => {
    const byPath = new Map(diffs.map((d) => [d.path, d]));
    if (Array.isArray(data?.files) && data.files.length) {
      return data.files.map((f) => ({ path: f.path, letter: statusLetter(f.status), adds: f.adds ?? byPath.get(f.path)?.adds ?? 0, dels: f.dels ?? byPath.get(f.path)?.dels ?? 0, diff: byPath.get(f.path) || null }));
    }
    return diffs.map((d) => ({ path: d.path, letter: d.status === 'added' ? 'A' : d.status === 'deleted' ? 'D' : 'M', adds: d.adds, dels: d.dels, diff: d }));
  }, [data, diffs]);

  if (loading && !data && !error) return <PanelMessage title="Loading changes…" />;
  if (error && !data) {
    return (
      <PanelMessage icon={FileX} title="Could not load changes" action={<RetryButton onClick={() => setReloadKey((k) => k + 1)} />}>
        {error.message}
      </PanelMessage>
    );
  }
  if (data?.error) {
    const noRepository = /not a git repository/i.test(data.error);
    return (
      <PanelMessage
        icon={noRepository ? GitBranch : FileX}
        title={noRepository ? 'No Git repository' : 'Changes unavailable'}
        action={noRepository ? null : <RetryButton onClick={() => setReloadKey((k) => k + 1)} />}
      >
        {data.error}
      </PanelMessage>
    );
  }

  const isCollapsed = (file) => collapsed.get(file.path) ?? (file.diff?.rows.length || 0) > LARGE_DIFF_ROWS;
  const setAll = (value) => setCollapsed(new Map(files.map((f) => [f.path, value])));
  const toggle = (file) => setCollapsed(new Map(collapsed).set(file.path, !isCollapsed(file)));
  const reveal = (file) => {
    if (isCollapsed(file)) setCollapsed(new Map(collapsed).set(file.path, false));
    requestAnimationFrame(() => fileRefs.current.get(file.path)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };
  const adds = files.reduce((n, f) => n + f.adds, 0);
  const dels = files.reduce((n, f) => n + f.dels, 0);
  const anyOpen = files.some((f) => f.diff && !isCollapsed(f));

  return (
    <div class="changes">
      <div class="changes-summary">
        <GitBranch size={14} />
        <span class="changes-branch">{data?.branch || 'Working tree'}</span>
        {files.length > 0 && (
          <span class="changes-stats">
            {files.length} {files.length === 1 ? 'file' : 'files'}
            {(adds > 0 || dels > 0) && ' · '}
            <DiffStats adds={adds} dels={dels} class="changes-counts" />
          </span>
        )}
        {files.length > 0 && (
          <button type="button" class="icon-btn icon-btn-sm" onClick={() => setAll(anyOpen)} aria-label={anyOpen ? 'Collapse all' : 'Expand all'} title={anyOpen ? 'Collapse all' : 'Expand all'}>
            {anyOpen ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
          </button>
        )}
      </div>
      {data?.notice && (
        <p class="changes-notice" role="note">
          <Info size={13} />
          <span>{data.notice}</span>
        </p>
      )}
      {files.length === 0 ? (
        <PanelMessage icon={GitBranch} title="No changes">
          {data?.notice ? 'No tracked file differs from the last commit.' : 'The working tree matches the last commit.'}
        </PanelMessage>
      ) : (
        <>
          <ul class="changes-list">
            {files.map((file) => (
              <li key={file.path}>
                <button type="button" class="changes-item" onClick={() => reveal(file)} disabled={!file.diff} title={file.path}>
                  <span class={`status-letter status-${file.letter}`}>{file.letter}</span>
                  <span class="changes-path">
                    <span class="changes-name">{basename(file.path, file.path)}</span>
                    {dirname(file.path) && <span class="changes-dir">{dirname(file.path)}</span>}
                  </span>
                  <DiffStats adds={file.adds} dels={file.dels} class="diff-count" />
                </button>
              </li>
            ))}
          </ul>
          {files
            .filter((file) => file.diff)
            .map((file) => (
              <DiffFile
                key={file.path}
                file={file}
                open={!isCollapsed(file)}
                onToggle={() => toggle(file)}
                sectionRef={(el) => (el ? fileRefs.current.set(file.path, el) : fileRefs.current.delete(file.path))}
              />
            ))}
        </>
      )}
    </div>
  );
}

function RetryButton({ onClick }) {
  return (
    <button type="button" class="btn btn-sm btn-secondary" onClick={onClick}>
      <RefreshCw size={14} />
      Try again
    </button>
  );
}

function DiffFile({ file, open, onToggle, sectionRef }) {
  const { diff } = file;
  return (
    <section class="diff-file" ref={sectionRef}>
      <button type="button" class={`diff-file-head ${open ? 'is-open' : ''}`} onClick={onToggle} aria-expanded={String(open)}>
        <ChevronRight size={14} class="chevron" />
        <span class={`status-letter status-${file.letter}`}>{file.letter}</span>
        <span class="diff-path" title={file.path}>
          <span>
            <span class="diff-dir">{dirname(file.path) ? dirname(file.path) + '/' : ''}</span>
            {basename(file.path, file.path)}
          </span>
        </span>
        <DiffStats adds={file.adds} dels={file.dels} class="diff-count" />
      </button>
      {open && (diff.rows.length ? <DiffView rows={diff.rows} language={languageForPath(file.path)} class="diff-body" /> : <p class="diff-empty">No text changes (mode change or empty file).</p>)}
    </section>
  );
}

/* Files */

const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i;
const TEXT = /\.(md|markdown|txt|rst|log|csv|tsv)$/i;

function FileIcon({ item }) {
  if (item.directory) return <Folder size={15} class="file-icon is-dir" />;
  if (IMAGE.test(item.name)) return <FileImage size={15} class="file-icon" />;
  if (TEXT.test(item.name)) return <FileText size={15} class="file-icon" />;
  if (languageForPath(item.name)) return <FileCode size={15} class="file-icon" />;
  return <File size={15} class="file-icon" />;
}

// A friendly explanation for file preview errors (status from the server).
function previewProblem(error) {
  const message = error?.message || '';
  if (error?.status === 413 || /too large/i.test(message)) return { icon: FileX, title: 'Too large to preview', text: 'Files over 350 kB are not shown here. Open it in your editor instead.' };
  if (error?.status === 415 || /binary/i.test(message)) return { icon: FileLock, title: 'Binary file', text: 'This file is not text, so there is nothing to preview.' };
  if (error?.status === 403 || /outside/i.test(message)) return { icon: FolderLock, title: 'Outside this project', text: 'Only files inside the project folder can be shown here.', outside: true };
  if (error?.status === 404 || /ENOENT|no such file|not found/i.test(message)) return { icon: FileQuestion, title: 'File not found', text: 'It may have been moved or deleted.' };
  return { icon: FileX, title: 'Cannot open this file', text: message };
}

function Breadcrumbs({ path, cwd }) {
  // An absolute path here lies outside the project: show it whole, not as crumbs.
  const outside = String(path || '').startsWith('/');
  const parts = outside ? [path] : String(path || '').split('/').filter(Boolean);
  const nav = useRef(null);
  // Deep paths scroll sideways; keep the current file or folder in view.
  useLayoutEffect(() => {
    if (nav.current) nav.current.scrollLeft = nav.current.scrollWidth;
  }, [path]);
  return (
    <nav class="crumbs-path" aria-label="Folder path" ref={nav}>
      <button type="button" class="crumb" onClick={() => browseTo('')} title={cwd}>
        <Folder size={13} />
        {basename(cwd, 'Project')}
      </button>
      {parts.map((part, i) => {
        const target = parts.slice(0, i + 1).join('/');
        const last = i === parts.length - 1;
        return (
          <span class="crumb-step" key={target}>
            <ChevronRight size={12} class="crumb-sep" />
            {last ? (
              <span class="crumb is-current">{part}</span>
            ) : (
              <button type="button" class="crumb" onClick={() => browseTo(target)}>
                {part}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function FilesView({ sessionId }) {
  const { filePath, fileLine, nonce, cwd } = useAppState(
    (s) => ({ filePath: s.panel.filePath, fileLine: s.panel.fileLine, nonce: s.panel.nonce, cwd: s.current?.cwd }),
    shallowEqual,
  );
  const { loading, data, error } = useRequest(
    () => api.get(`sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(filePath || '')}`, { timeout: 30_000 }),
    [sessionId, filePath, nonce],
  );
  const shownPath = data?.path ?? relativeTo(filePath, cwd);
  const problem = error ? previewProblem(error) : null;
  const items = useMemo(
    () => (data?.directory ? [...data.items].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) : []),
    [data],
  );
  const lineCount = useMemo(() => (data && !data.directory ? data.content.split('\n').length - (data.content.endsWith('\n') ? 1 : 0) : 0), [data]);
  const absolute = shownPath ? (shownPath.startsWith('/') ? shownPath : `${cwd}/${shownPath}`) : cwd;

  return (
    <div class="files">
      <div class="files-path">
        <Breadcrumbs path={shownPath} cwd={cwd} />
        <CopyButton text={absolute} label="Copy path" />
      </div>
      {loading && !data && !error && <PanelMessage title="Loading…" />}
      {problem && (
        <PanelMessage
          icon={problem.icon}
          title={problem.title}
          action={
            problem.outside || String(shownPath || '').startsWith('/') ? (
              <button type="button" class="btn btn-sm btn-secondary" onClick={() => browseTo('')}>
                Back to project
              </button>
            ) : (
              <button type="button" class="btn btn-sm btn-secondary" onClick={() => browseTo(dirname(relativeTo(filePath, cwd)))}>
                Back to folder
              </button>
            )
          }
        >
          {problem.text}
        </PanelMessage>
      )}
      {!error && data?.directory && (
        <div class="file-list">
          {items.map((item) => (
            <button type="button" class="file-item" key={item.path} onClick={() => browseTo(item.path)}>
              <FileIcon item={item} />
              <span class="file-name">{item.name}</span>
              {item.directory && <ChevronRight size={14} class="file-chevron" />}
            </button>
          ))}
          {!items.length && <PanelMessage title="This folder is empty." />}
        </div>
      )}
      {!error && data && !data.directory && (
        <div class="file-view">
          <div class="file-meta">
            <span>{lineCount.toLocaleString('en-US')} {lineCount === 1 ? 'line' : 'lines'}</span>
            {languageForPath(data.path) && <span>· {languageForPath(data.path)}</span>}
            {fileLine && <span class="file-meta-target">· line {fileLine}</span>}
          </div>
          {data.content ? (
            <CodeView
              code={data.content}
              language={languageForPath(data.path)}
              target={fileLine}
              onTarget={(row) => row.scrollIntoView({ block: 'center' })}
              class="file-code"
            />
          ) : (
            <PanelMessage title="Empty file" />
          )}
        </div>
      )}
    </div>
  );
}

function relativeTo(value, cwd) {
  const path = String(value || '');
  const root = String(cwd || '').replace(/\/$/, '');
  if (root && path.startsWith(root + '/')) return path.slice(root.length + 1);
  return path === root ? '' : path;
}

/* Plan */

function proposedAt(at) {
  const text = relativeTime(at);
  return text === 'Just now' ? 'just now' : /ago$/.test(text) ? text : 'on ' + text;
}

function PlanView() {
  const { plan, todos, mode } = useAppState((s) => ({ plan: s.current?.plan || null, todos: s.current?.todos || null, mode: s.current?.mode }), shallowEqual);
  const progress = todoProgress(todos);
  if (!plan?.text && !progress.total) {
    return (
      <PanelMessage
        icon={ClipboardList}
        title="No plan yet"
        action={
          mode !== 'plan' && (
            <button type="button" class="btn btn-sm btn-secondary" onClick={() => chooseMode('plan')}>
              Switch to Plan mode
            </button>
          )
        }
      >
        In Plan mode Claude explores the code first and proposes a plan here before changing anything. Task lists show up here too.
      </PanelMessage>
    );
  }
  return (
    <div class="plan-view">
      {progress.total > 0 && (
        <section class="plan-section">
          <div class="plan-section-head">
            <ProgressRing value={progress.completed / progress.total} />
            <span class="plan-section-title">Tasks</span>
            <span class="plan-section-meta">
              {progress.completed} of {progress.total} done
            </span>
          </div>
          <TodoList todos={todos} />
        </section>
      )}
      {plan?.text && (
        <section class="plan-section">
          <div class="plan-section-head">
            <ClipboardList size={15} class="plan-icon" />
            <span class="plan-section-title">Plan</span>
            {plan.at && (
              <span class="plan-section-meta" title={new Date(plan.at).toLocaleString()}>
                Proposed {proposedAt(plan.at)}
              </span>
            )}
          </div>
          <Markdown text={plan.text} class="plan-markdown" />
        </section>
      )}
    </div>
  );
}
