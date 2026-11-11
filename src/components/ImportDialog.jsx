// Import picker: choose Claude Code or Codex sessions on this machine to bring into
// Harbor. Each tab's list loads the first time the tab is shown; long lists
// (Codex can have 1,000+ rollouts) are windowed with fixed-height rows.
//
// Keyboard: ↓ from the search box moves into the list; there ↑↓ move, Space ticks,
// Enter imports (the highlighted row when nothing is ticked), letters go back to
// the search box.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArrowUpRight, Ban, Check, ChevronDown, CircleCheck, LoaderCircle, Minus, RotateCw, Search, SearchX, TriangleAlert, X } from 'lucide-preact';
import { closeDialog, importSessions, loadImportCandidates, selectSession, toast } from '../actions.js';
import { useAppState } from '../state.js';
import { IMPORT_SOURCES, filterCandidates, formatBytes, importTime, importedIds, isSelectable, originatorLabel, projectChoices, sourceLabel, tildePath } from '../lib/imports.js';
import { formatNumber } from '../lib/format.js';
import { KEYS, getItem, setItem } from '../lib/storage.js';
import { Dialog } from './Dialog.jsx';
import './ImportDialog.css';

const EMPTY = Object.freeze([]);
const ROW_HEIGHT = 60;
const OVERSCAN = 8;
// Larger selections ask once before importing (each session is converted in turn).
const CONFIRM_ABOVE = 20;

const NOTES = {
  claude: 'Continues natively on any model, from a copy. The original keeps working in Claude Code.',
  codex: 'Shown as history. Your next message starts a new conversation that carries a summary.',
};
const FOLDERS = { claude: '~/.claude/projects', codex: '~/.codex/sessions' };

const keyOf = (source, id) => `${source}:${id}`;
const finePointer = () => globalThis.matchMedia?.('(hover: hover) and (pointer: fine)').matches;

// Visible slice of a fixed-row-height scroll list. The row height comes from the
// list's `--row-h` (it differs on phones).
function useWindow(listRef, count) {
  const [view, setView] = useState({ top: 0, height: 0, row: ROW_HEIGHT });
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return undefined;
    const measure = () => {
      const row = parseFloat(getComputedStyle(el).getPropertyValue('--row-h')) || ROW_HEIGHT;
      setView({ top: el.scrollTop, height: el.clientHeight, row });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const { top, height, row } = view;
  const start = Math.max(0, Math.floor(top / row) - OVERSCAN);
  const end = Math.min(count, Math.ceil((top + (height || 600)) / row) + OVERSCAN);
  const onScroll = (event) => {
    const scrollTop = event.currentTarget.scrollTop;
    setView((v) => (v.top === scrollTop ? v : { ...v, top: scrollTop }));
  };
  const reveal = (index) => {
    const el = listRef.current;
    if (!el || index < 0) return;
    const y = index * row;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + row > el.scrollTop + el.clientHeight) el.scrollTop = y + row - el.clientHeight;
  };
  const pageRows = Math.max(1, Math.floor((height || 600) / row) - 1);
  return { start, end, row, onScroll, reveal, pageRows };
}

export function ImportDialog() {
  const home = useAppState((s) => s.info?.root || '');
  const [tab, setTab] = useState(() => (getItem(KEYS.importTab) === 'codex' ? 'codex' : 'claude'));
  const [lists, setLists] = useState({});
  const [query, setQuery] = useState('');
  const [projects, setProjects] = useState({});
  const [selected, setSelected] = useState(() => new Set());
  const [activeId, setActiveId] = useState(null);
  const [keyNav, setKeyNav] = useState(false);
  const [progress, setProgress] = useState(null);
  const [report, setReport] = useState(null);
  // Selection size that was asked to confirm (large imports take minutes).
  const [confirming, setConfirming] = useState(0);
  const alive = useRef(true);
  const listRef = useRef(null);
  const searchRef = useRef(null);
  const importing = !!progress;

  useEffect(() => () => (alive.current = false), []);

  const load = async (source) => {
    setLists((all) => ({ ...all, [source]: { items: EMPTY, ...all[source], status: 'loading', error: '' } }));
    try {
      const data = await loadImportCandidates(source);
      const items = Array.isArray(data?.items) ? data.items : [];
      if (alive.current) setLists((all) => ({ ...all, [source]: { status: 'ready', items, total: data?.total ?? items.length } }));
    } catch (error) {
      if (alive.current) setLists((all) => ({ ...all, [source]: { items: EMPTY, ...all[source], status: 'error', error: error.message } }));
    }
  };

  useEffect(() => {
    if (!lists[tab]) load(tab);
  }, [tab]);

  const chooseTab = (id) => {
    setTab(id);
    setItem(KEYS.importTab, id);
  };

  const list = lists[tab];
  const items = list?.items || EMPTY;
  const choices = useMemo(() => projectChoices(items), [items]);
  const project = choices.some((c) => c.cwd === projects[tab]) ? projects[tab] : '';
  const visible = useMemo(() => filterCandidates(items, { query, project, home }), [items, query, project, home]);
  const selectable = useMemo(() => visible.filter(isSelectable), [visible]);
  const tickedHere = selectable.filter((item) => selected.has(keyOf(tab, item.id))).length;
  const win = useWindow(listRef, visible.length);

  let activeIndex = activeId == null ? -1 : visible.findIndex((item) => item.id === activeId);
  if (activeIndex < 0 && keyNav && visible.length) activeIndex = 0;
  const active = activeIndex >= 0 ? visible[activeIndex] : null;

  // A new tab, search or folder starts at the top.
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
    setActiveId(null);
  }, [tab, query, project]);

  const toggle = (item) => {
    if (!isSelectable(item) || importing) return;
    const key = keyOf(tab, item.id);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    const all = tickedHere === selectable.length;
    setSelected((current) => {
      const next = new Set(current);
      for (const item of selectable) {
        if (all) next.delete(keyOf(tab, item.id));
        else next.add(keyOf(tab, item.id));
      }
      return next;
    });
  };

  const openImported = (sessionId) => {
    closeDialog();
    selectSession(sessionId);
  };

  const titleOf = (source, id) => lists[source]?.items?.find((item) => item.id === id)?.title || id;

  // Imports [{ source, ids }] in order, then opens the first imported session, or
  // stays open to list what failed. Closing the dialog meanwhile lets the import
  // finish in the background (reported with a toast).
  const run = async (jobs) => {
    const total = jobs.reduce((n, job) => n + job.ids.length, 0);
    if (!total || importing) return;
    setReport(null);
    setProgress({ done: 0, total });
    const imported = [];
    const failures = [];
    let base = 0;
    for (const job of jobs) {
      const result = await importSessions(job.source, job.ids, {
        onBatch: ({ done }) => alive.current && setProgress({ done: base + done, total }),
      });
      base += job.ids.length;
      const pairs = importedIds(job.ids, result.sessions, result.errors);
      imported.push(...result.sessions);
      failures.push(...result.errors.map((e) => ({ source: job.source, id: e.id, title: titleOf(job.source, e.id), error: e.error || 'Import failed.' })));
      if (!alive.current) continue;
      // Imported rows turn into "Imported" links; failed ones stay ticked for a retry.
      const importedAs = new Map(pairs.filter((p) => p.id && p.sessionId).map((p) => [p.id, p.sessionId]));
      setLists((all) => {
        const current = all[job.source];
        if (!current?.items) return all;
        return { ...all, [job.source]: { ...current, items: current.items.map((item) => (importedAs.has(item.id) ? { ...item, importedAs: importedAs.get(item.id) } : item)) } };
      });
      setSelected((current) => {
        const next = new Set(current);
        for (const id of importedAs.keys()) next.delete(keyOf(job.source, id));
        return next;
      });
    }
    if (!failures.length) {
      if (!imported.length) toast('Nothing was imported.');
      else toast(imported.length === 1 ? `Imported “${imported[0].title || 'session'}”.` : `Imported ${formatNumber(imported.length)} sessions.`);
      if (alive.current) {
        closeDialog();
        if (imported[0]) selectSession(imported[0].id);
      }
      return;
    }
    if (!alive.current) {
      const [first] = failures;
      toast(`Imported ${imported.length} of ${total}. ${failures.length === 1 ? `“${first.title}” failed` : `${failures.length} failed, e.g. “${first.title}”`}: ${first.error}`);
      return;
    }
    setProgress(null);
    setReport({ imported: imported.length, failures });
  };

  const importSelected = () => {
    if (selected.size > CONFIRM_ABOVE && confirming !== selected.size) return setConfirming(selected.size);
    setConfirming(0);
    const order = [tab, ...IMPORT_SOURCES.map((s) => s.id).filter((id) => id !== tab)];
    const jobs = order.map((source) => ({
      source,
      ids: [...selected].filter((key) => key.startsWith(source + ':')).map((key) => key.slice(source.length + 1)),
    }));
    run(jobs.filter((job) => job.ids.length));
  };

  // Enter: the ticked rows, else the highlighted one (opened when already imported).
  const submit = () => {
    if (importing) return;
    if (selected.size) importSelected();
    else if (active?.importedAs) openImported(active.importedAs);
    else if (isSelectable(active)) run([{ source: tab, ids: [active.id] }]);
  };

  const moveTo = (index) => {
    if (!visible.length) return;
    const next = Math.max(0, Math.min(visible.length - 1, index));
    setKeyNav(true);
    setActiveId(visible[next].id);
    win.reveal(next);
  };

  const onSearchKey = (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' && visible.length) {
      event.preventDefault();
      listRef.current?.focus();
      moveTo(activeIndex < 0 ? 0 : activeIndex);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape' && query) {
      event.preventDefault();
      event.stopPropagation();
      setQuery('');
    }
  };

  const onListKey = (event) => {
    if (event.isComposing || event.keyCode === 229 || importing) return;
    const keys = {
      ArrowDown: () => moveTo(activeIndex + 1),
      ArrowUp: () => (activeIndex <= 0 ? searchRef.current?.focus() : moveTo(activeIndex - 1)),
      Home: () => moveTo(0),
      End: () => moveTo(visible.length - 1),
      PageDown: () => moveTo(activeIndex + win.pageRows),
      PageUp: () => moveTo(Math.max(0, activeIndex - win.pageRows)),
      ' ': () => {
        if (!active) return moveTo(0);
        setKeyNav(true);
        toggle(active);
      },
      Enter: submit,
    };
    if (keys[event.key]) {
      event.preventDefault();
      keys[event.key]();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Typing goes to the search box (the key lands there).
      searchRef.current?.focus();
    }
  };

  const close = () => {
    if (importing) toast('The import continues in the background.');
    closeDialog();
  };

  const counts = IMPORT_SOURCES.map((source) => ({
    ...source,
    total: lists[source.id]?.status === 'ready' ? lists[source.id].total : null,
    ticked: [...selected].filter((key) => key.startsWith(source.id + ':')).length,
  }));
  const status = list?.status || 'loading';
  const now = Date.now();
  const allTicked = selectable.length > 0 && tickedHere === selectable.length;

  return (
    <Dialog
      title="Import sessions"
      subtitle={NOTES[tab]}
      onClose={close}
      class={`import-dialog ${importing ? 'is-importing' : ''}`}
      initialFocus={finePointer() ? '.import-search input' : null}
      footer={
        <ImportFooter
          count={selected.size}
          confirming={confirming === selected.size && confirming > 0}
          progress={progress}
          onClear={() => setSelected(new Set())}
          onCancel={confirming === selected.size && confirming > 0 ? () => setConfirming(0) : close}
          onImport={importSelected}
        />
      }
    >
      <fieldset class="import-controls" disabled={importing}>
        <div class="segmented import-tabs" role="tablist" aria-label="Import from">
          {counts.map((source) => (
            <button
              type="button"
              role="tab"
              key={source.id}
              id={`import-tab-${source.id}`}
              aria-selected={String(tab === source.id)}
              aria-controls="import-list"
              onClick={() => chooseTab(source.id)}
            >
              <span>{source.label}</span>
              {source.total != null && <span class="import-tab-count">{formatNumber(source.total)}</span>}
              {source.ticked > 0 && tab !== source.id && <span class="import-tab-ticked" title={`${source.ticked} selected`} />}
            </button>
          ))}
        </div>

        <div class="import-filters">
          <label class="import-search">
            <Search size={15} />
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder="Search titles and folders"
              aria-label="Search sessions to import"
              aria-controls="import-list"
              autocomplete="off"
              spellcheck={false}
              enterkeyhint="go"
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={onSearchKey}
            />
            {query && (
              <button type="button" class="icon-btn icon-btn-sm" onClick={() => setQuery('')} aria-label="Clear search">
                <X size={14} />
              </button>
            )}
          </label>
          <span class="import-project">
            <select
              value={project}
              aria-label="Filter by project folder"
              disabled={!choices.length}
              onChange={(event) => setProjects({ ...projects, [tab]: event.currentTarget.value })}
            >
              <option value="">All folders</option>
              {choices.map((choice) => (
                <option value={choice.cwd} key={choice.cwd}>
                  {tildePath(choice.cwd, home)} ({formatNumber(choice.count)})
                </option>
              ))}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </span>
        </div>

        <div class="import-list-head">
          <button
            type="button"
            role="checkbox"
            class="import-select-all"
            aria-checked={allTicked ? 'true' : tickedHere ? 'mixed' : 'false'}
            disabled={!selectable.length}
            onClick={toggleAll}
          >
            <span class="import-box" aria-hidden="true">
              {allTicked ? <Check size={12} strokeWidth={3} /> : tickedHere ? <Minus size={12} strokeWidth={3} /> : null}
            </span>
            Select all
          </button>
          <span class="import-shown">
            {status === 'ready' && (visible.length === items.length ? `${formatNumber(items.length)} ${items.length === 1 ? 'session' : 'sessions'}` : `${formatNumber(visible.length)} of ${formatNumber(items.length)}`)}
          </span>
        </div>
      </fieldset>

      <div
        id="import-list"
        class={`import-list ${keyNav ? 'is-keyboard' : ''}`}
        role="listbox"
        aria-multiselectable="true"
        aria-labelledby={`import-tab-${tab}`}
        aria-activedescendant={active && keyNav ? `import-option-${activeIndex}` : undefined}
        aria-busy={status === 'loading' ? 'true' : undefined}
        tabIndex={visible.length ? 0 : -1}
        ref={listRef}
        onScroll={win.onScroll}
        onKeyDown={onListKey}
        onMouseMove={() => keyNav && setKeyNav(false)}
      >
        {status === 'ready' && visible.length > 0 && (
          <div class="import-rows" style={{ height: visible.length * win.row + 'px' }}>
            <div style={{ transform: `translateY(${win.start * win.row}px)` }}>
              {visible.slice(win.start, win.end).map((item, i) => {
                const index = win.start + i;
                return (
                  <ImportRow
                    key={item.id}
                    item={item}
                    index={index}
                    count={visible.length}
                    source={tab}
                    home={home}
                    now={now}
                    checked={selected.has(keyOf(tab, item.id))}
                    active={keyNav && index === activeIndex}
                    disabled={importing}
                    onClick={() => {
                      setActiveId(item.id);
                      if (item.importedAs) openImported(item.importedAs);
                      else toggle(item);
                    }}
                  />
                );
              })}
            </div>
          </div>
        )}
        {status === 'loading' && <LoadingRows source={tab} />}
        {status === 'error' && (
          <div class="import-state" role="alert">
            <TriangleAlert size={20} class="import-state-icon is-error" />
            <p class="import-state-title">Couldn’t load {sourceLabel(tab)} sessions</p>
            <p class="import-state-note">{list.error}</p>
            <button type="button" class="btn btn-sm btn-secondary" onClick={() => load(tab)}>
              <RotateCw size={14} />
              Try again
            </button>
          </div>
        )}
        {status === 'ready' && !items.length && (
          <div class="import-state">
            <p class="import-state-title">No {sourceLabel(tab)} sessions found</p>
            <p class="import-state-note">Sessions under {FOLDERS[tab]} appear here.</p>
          </div>
        )}
        {status === 'ready' && items.length > 0 && !visible.length && (
          <div class="import-state">
            <SearchX size={20} class="import-state-icon" />
            <p class="import-state-title">No sessions match</p>
            <button
              type="button"
              class="btn btn-sm btn-secondary"
              onClick={() => {
                setQuery('');
                setProjects({ ...projects, [tab]: '' });
              }}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>

      {report && <ImportReport report={report} onDismiss={() => setReport(null)} />}
    </Dialog>
  );
}

function ImportRow({ item, index, count, source, home, now, checked, active, disabled, onClick }) {
  const imported = !!item.importedAs;
  const blocked = !imported && item.importable === false;
  const chip = source === 'codex' ? originatorLabel(item.originator) : '';
  const size = formatBytes(item.size);
  const folder = tildePath(item.cwd, home) || 'Unknown folder';
  const title = item.title || 'Untitled session';
  const tooltip = [
    title,
    item.cwd,
    item.gitBranch ? `Branch: ${item.gitBranch}` : '',
    blocked ? item.reason : '',
  ]
    .filter(Boolean)
    .join('\n');
  const classes = ['import-row', checked && 'is-checked', active && 'is-active', imported && 'is-imported', blocked && 'is-blocked'];
  return (
    <div
      id={`import-option-${index}`}
      role="option"
      aria-selected={String(checked)}
      aria-disabled={blocked || disabled ? 'true' : undefined}
      aria-posinset={index + 1}
      aria-setsize={count}
      class={classes.filter(Boolean).join(' ')}
      title={tooltip}
      onClick={disabled ? undefined : onClick}
    >
      <span class="import-check" aria-hidden="true">
        {imported ? <CircleCheck size={16} class="import-done" /> : blocked ? <Ban size={15} class="import-ban" /> : <span class="import-box">{checked && <Check size={12} strokeWidth={3} />}</span>}
      </span>
      <span class="import-title">{title}</span>
      <span class="import-time">{importTime(item.updatedAt || item.createdAt, now)}</span>
      <span class="import-meta">
        <span class={folder.length <= 5 ? 'import-folder is-short' : 'import-folder'}>
          <bdi>{folder}</bdi>
        </span>
        {blocked ? (
          <span class="import-reason">{item.reason || 'Can’t be imported'}</span>
        ) : (
          <>
            {size && <span class="import-size">{size}</span>}
            {chip && <span class="import-chip">{chip}</span>}
          </>
        )}
      </span>
      {imported && (
        <span class="import-status">
          Imported
          <ArrowUpRight size={12} />
        </span>
      )}
    </div>
  );
}

function LoadingRows({ source }) {
  return (
    <div class="import-loading">
      <p class="import-loading-note" role="status">
        <LoaderCircle size={14} class="spin" />
        Looking for {sourceLabel(source)} sessions… the first scan can take a few seconds.
      </p>
      {[78, 54, 88, 64, 72, 48, 82, 60].map((width, i) => (
        <div class="import-skeleton" key={i} style={{ '--w': width + '%', '--delay': i * 70 + 'ms' }} aria-hidden="true">
          <span class="skeleton-bar import-skeleton-box" />
          <span class="import-skeleton-lines">
            <span class="skeleton-bar skeleton-title" />
            <span class="skeleton-bar skeleton-meta" />
          </span>
        </div>
      ))}
    </div>
  );
}

function ImportReport({ report, onDismiss }) {
  const { imported, failures } = report;
  return (
    <div class="import-report" role="alert">
      <div class="import-report-head">
        <TriangleAlert size={15} />
        <span>
          {imported > 0 ? `Imported ${imported}. ` : ''}
          {failures.length === 1 ? '1 session couldn’t be imported:' : `${failures.length} sessions couldn’t be imported:`}
        </span>
        <button type="button" class="icon-btn icon-btn-sm" onClick={onDismiss} aria-label="Dismiss">
          <X size={14} />
        </button>
      </div>
      <ul class="import-report-list">
        {failures.map((failure) => (
          <li key={failure.source + failure.id}>
            <span class="import-report-title">{failure.title}</span>
            <span class="import-report-error">{failure.error}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ImportFooter({ count, confirming, progress, onClear, onCancel, onImport }) {
  if (progress) {
    const { done, total } = progress;
    const label = done ? `Imported ${formatNumber(done)} of ${formatNumber(total)}…` : `Importing ${total === 1 ? '1 session' : formatNumber(total) + ' sessions'}…`;
    return (
      <>
        <span class="import-progress" style={{ '--done': done / total }} aria-hidden="true" />
        <span class="import-summary" role="status">
          <LoaderCircle size={14} class="spin" />
          {label}
        </span>
        <span class="spacer" />
        <button type="button" class="btn btn-primary" disabled>
          Importing…
        </button>
      </>
    );
  }
  if (confirming) {
    return (
      <>
        <span class="import-summary import-confirm" role="status">
          Import {formatNumber(count)} sessions? Each one is converted in turn, so this can take a few minutes.
        </span>
        <span class="spacer" />
        <button type="button" class="btn btn-ghost import-cancel" onClick={onCancel}>
          Back
        </button>
        <button type="button" class="btn btn-primary" onClick={onImport}>
          Import all {formatNumber(count)}
        </button>
      </>
    );
  }
  return (
    <>
      <span class="import-summary">
        {count > 0 ? (
          <>
            {formatNumber(count)} selected
            <button type="button" class="import-clear" onClick={onClear}>
              Clear
            </button>
          </>
        ) : (
          <span class="import-hint">
            <kbd>↓</kbd> to the list, <kbd>Space</kbd> selects, <kbd>↵</kbd> imports
          </span>
        )}
      </span>
      <span class="spacer" />
      <button type="button" class="btn btn-ghost import-cancel" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" class="btn btn-primary" onClick={onImport} disabled={!count}>
        {count ? `Import ${formatNumber(count)}` : 'Import'}
      </button>
    </>
  );
}
