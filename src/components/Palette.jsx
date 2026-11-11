// Command palette (⌘K): jump to a session or run a command. Model, mode, effort,
// theme and project choices open inline sub-pages. Focus stays in the search box;
// the list follows the combobox pattern (aria-activedescendant).
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bell,
  BellOff,
  Bot,
  Check,
  ChevronRight,
  ClipboardList,
  FilePen,
  Folder,
  FolderPlus,
  FolderSearch,
  FolderTree,
  GitBranch,
  GitCompare,
  Hand,
  Import,
  Keyboard,
  Link,
  MessageSquare,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Plug,
  RotateCcw,
  Search,
  SearchX,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquarePen,
  SquareTerminal,
  Sun,
  SunMoon,
  Trash2,
  Zap,
} from 'lucide-preact';
import {
  chooseEffort,
  chooseMode,
  chooseModel,
  chooseProject,
  closeDialog,
  copySessionLink,
  forkSession,
  newSession,
  openDialog,
  openPanel,
  selectSession,
  setTheme,
  stopSession,
  toggleArchived,
  togglePanel,
  togglePinned,
  toggleRemoved,
  toggleSidebar,
} from '../actions.js';
import { setNotificationsEnabled } from '../attention.js';
import { shallowEqual, useAppState } from '../state.js';
import { basename, relativeTime } from '../lib/format.js';
import { availableModes, canonicalMode, modeLabel } from '../lib/modes.js';
import { EFFORT_DESCRIPTIONS, EFFORT_LEVEL, effectiveEffort, effortName, effortOptions, findModel, groupModels, providerNote, shortModelName } from '../lib/models.js';
import { highlightRuns, rankCommands, rankSessions } from '../lib/palette.js';
import { recentProjects, sessionDot, sortTime } from '../lib/sessions.js';
import { SHORTCUTS } from '../lib/shortcuts.js';
import { Keys } from './Keys.jsx';
import { ModelIcon } from './ModelIcon.jsx';
import { SourceBadge } from './SourceBadge.jsx';
import './Palette.css';

const PAGES = {
  model: { title: 'Model', placeholder: 'Choose a model…', opener: 'model' },
  mode: { title: 'Mode', placeholder: 'Choose a permission mode…', opener: 'mode' },
  effort: { title: 'Effort', placeholder: 'Choose a reasoning effort…', opener: 'effort' },
  theme: { title: 'Theme', placeholder: 'Choose a theme…', opener: 'theme' },
  project: { title: 'New session in', placeholder: 'Choose a project…', opener: 'new-in' },
};

const THEMES = [
  { id: 'system', label: 'System', description: 'Follow the operating system', icon: Monitor },
  { id: 'dark', label: 'Dark', description: 'Easy on the eyes at night', icon: Moon },
  { id: 'light', label: 'Light', description: 'Bright rooms and sunlight', icon: Sun },
];

const MODE_ICONS = { default: Hand, acceptEdits: FilePen, plan: ClipboardList, auto: Sparkles, bypassPermissions: Zap };

function EffortGlyph({ level }) {
  return (
    <span class="palette-bars" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((n) => (
        <i key={n} class={n <= level ? 'lit' : ''} />
      ))}
    </span>
  );
}

function usePaletteContext() {
  const state = useAppState(
    (s) => {
      const c = s.current;
      return {
        sessions: s.sessions,
        info: s.info,
        isV2: s.isV2,
        theme: s.theme,
        project: s.project,
        draftModel: s.model,
        draftMode: s.mode,
        draftEfforts: s.efforts,
        notifications: s.notifications,
        permission: s.notificationPermission,
        panelOpen: s.panel.open,
        currentId: c?.id || null,
        model: c?.model,
        mode: c?.mode,
        efforts: c?.efforts,
        status: c?.status,
        pinned: !!c?.pinned,
        hasPinned: !!c && 'pinned' in c,
        archived: !!c?.archived,
        removed: !!c?.removed,
      };
    },
    shallowEqual,
  );
  const inSession = !!state.currentId;
  const modelId = inSession ? state.model : state.draftModel;
  const model = findModel(state.info, modelId);
  const chosenEffort = (inSession ? state.efforts?.[modelId] : state.draftEfforts?.[modelId]) || 'default';
  const busy = state.status === 'running' || state.status === 'waiting';
  return {
    ...state,
    inSession,
    modelId,
    modelInfo: model,
    currentMode: canonicalMode(inSession ? state.mode : state.draftMode),
    chosenEffort,
    busy,
    // A v1 server refuses model and mode switches during a turn.
    locked: busy && !state.isV2,
  };
}

/* Items */

// Choices for a sub-page, as sections: [{ title, items }].
function pageSections(page, ctx) {
  if (page === 'model') {
    return groupModels(ctx.info?.models).map((group) => ({
      title: group.name,
      note: providerNote(group.models[0]) !== group.name ? providerNote(group.models[0]) : '',
      items: group.models.map((m) => ({
        id: m.id,
        label: m.name,
        description: m.description,
        keywords: `${group.name} ${m.id}`,
        icon: <ModelIcon model={m} size={16} />,
        selected: m.id === ctx.modelId,
        disabled: ctx.locked,
        run: () => m.id !== ctx.modelId && chooseModel(m.id),
      })),
    }));
  }
  if (page === 'mode') {
    return [
      {
        title: 'Permission mode',
        items: availableModes(ctx.info, ctx.modelInfo).map((m) => {
          const Icon = MODE_ICONS[m.id] || Hand;
          return {
            id: m.id,
            label: m.label,
            description: m.description,
            icon: <Icon />,
            tone: m.tone,
            selected: m.id === ctx.currentMode,
            disabled: ctx.locked,
            run: () => m.id !== ctx.currentMode && chooseMode(m.id),
          };
        }),
      },
    ];
  }
  if (page === 'effort') {
    const model = ctx.modelInfo;
    const options = effortOptions(model);
    if (options.length <= 1) return [];
    return [
      {
        title: `Effort · ${model.name}`,
        items: options.map((effort) => ({
          id: effort,
          label: effortName(effort),
          keywords: effort,
          description: effort === 'default' ? `Model default · ${effortName(model.defaultEffort)}` : EFFORT_DESCRIPTIONS[effort],
          icon: <EffortGlyph level={EFFORT_LEVEL[effort === 'default' ? model.defaultEffort : effort] || 2} />,
          selected: effort === ctx.chosenEffort,
          run: () => effort !== ctx.chosenEffort && chooseEffort(effort),
        })),
      },
    ];
  }
  if (page === 'theme') {
    return [
      {
        title: 'Theme',
        items: THEMES.map((t) => ({
          id: t.id,
          label: t.label,
          description: t.description,
          keywords: 'appearance',
          icon: <t.icon />,
          selected: t.id === ctx.theme,
          run: () => setTheme(t.id),
        })),
      },
    ];
  }
  if (page === 'project') {
    const projects = recentProjects(ctx.sessions, 8);
    if (ctx.project && !projects.includes(ctx.project)) projects.unshift(ctx.project);
    return [
      {
        title: 'Recent projects',
        items: projects.map((path) => ({
          id: path,
          label: basename(path),
          description: path,
          icon: <Folder />,
          selected: !ctx.inSession && path === ctx.project,
          run: () => {
            chooseProject(path);
            newSession();
          },
        })),
      },
      {
        title: '',
        items: [
          {
            id: 'browse',
            label: 'Browse folders…',
            description: 'Pick any folder in the workspace',
            keywords: 'directory open',
            icon: <FolderSearch />,
            run: () => {
              newSession();
              openDialog('project');
            },
          },
        ],
      },
    ];
  }
  return [];
}

function pageNote(page, ctx) {
  if ((page === 'model' || page === 'mode') && ctx.locked) return 'Available after the current turn.';
  if ((page === 'model' || page === 'effort') && ctx.inSession && ctx.busy) return 'Applies from the next turn.';
  return '';
}

// Every root command, in display order. `group` is 'session' (about the open
// session) or 'general'. Sub-page choices are added as search-only commands so
// "sonnet" or "dark" work straight from the root.
function rootCommands(ctx) {
  const commands = [];
  const add = (group, command) => commands.push({ group, ...command });
  const id = ctx.currentId;

  if (id) {
    if (ctx.busy) add('session', { id: 'stop', label: 'Stop turn', icon: <Square />, keywords: 'interrupt cancel halt', run: stopSession });
    add('session', { id: 'rename', label: 'Rename session', icon: <Pencil />, keywords: 'title name', run: () => openDialog('rename', { id }) });
    if ((ctx.isV2 || ctx.hasPinned) && !ctx.removed) {
      add('session', {
        id: 'pin',
        label: ctx.pinned ? 'Unpin session' : 'Pin session',
        icon: ctx.pinned ? <PinOff /> : <Pin />,
        keywords: 'favorite top keep',
        run: () => togglePinned(id),
      });
    }
    add('session', { id: 'link', label: 'Copy session link', icon: <Link />, keywords: 'share url phone device', run: () => copySessionLink(id) });
    if (!ctx.removed) {
      add('session', {
        id: 'fork',
        label: 'Fork session',
        icon: <GitBranch />,
        keywords: 'branch duplicate copy clone',
        note: ctx.busy ? 'Wait for the turn to end' : '',
        disabled: ctx.busy,
        run: () => forkSession(id),
      });
    }
    add('session', {
      id: 'panel',
      label: ctx.panelOpen ? 'Hide side panel' : 'Show side panel',
      icon: <PanelRight />,
      shortcut: SHORTCUTS.panel.keys,
      keywords: 'toggle right files changes',
      run: togglePanel,
    });
    add('session', { id: 'changes', label: 'Open Changes', icon: <GitCompare />, keywords: 'diff git side panel tab', run: () => openPanel('changes') });
    add('session', { id: 'files', label: 'Open Files', icon: <FolderTree />, keywords: 'browse tree side panel tab', run: () => openPanel('files') });
    add('session', { id: 'plan', label: 'Open Plan', icon: <ClipboardList />, keywords: 'side panel tab', run: () => openPanel('plan') });
    if (!ctx.removed) {
      add('session', {
        id: 'archive',
        label: ctx.archived ? 'Unarchive session' : 'Archive session',
        icon: ctx.archived ? <ArchiveRestore /> : <Archive />,
        note: ctx.busy ? 'Stop the session first' : '',
        disabled: ctx.busy,
        run: () => toggleArchived(id),
      });
      add('session', {
        id: 'trash',
        label: 'Move to Trash',
        icon: <Trash2 />,
        keywords: 'delete remove',
        note: ctx.busy ? 'Stop the session first' : '',
        disabled: ctx.busy,
        danger: true,
        run: () => toggleRemoved(id),
      });
    } else {
      add('session', { id: 'restore', label: 'Restore from Trash', icon: <RotateCcw />, keywords: 'undelete', run: () => toggleRemoved(id) });
    }
  }

  add('general', { id: 'new', label: 'New session', icon: <SquarePen />, shortcut: SHORTCUTS.newSession.keys, keywords: 'create start chat', run: newSession });
  add('general', { id: 'new-in', label: 'New session in project…', icon: <FolderPlus />, keywords: 'folder directory cwd', page: 'project' });
  add('general', {
    id: 'import',
    label: 'Import sessions…',
    icon: <Import />,
    keywords: 'claude code codex history transcript resume continue',
    run: () => openDialog('import'),
  });
  add('general', {
    id: 'agents',
    label: 'Show agents',
    icon: <Bot />,
    keywords: 'subagents model agents workers delegate parallel gpt sol luna',
    run: () => openDialog('agents'),
  });
  add('general', {
    id: 'background',
    label: 'Show background tasks',
    icon: <SquareTerminal />,
    keywords: 'tasks shell bash commands monitor cron scheduled jobs wakeup loop running output',
    run: () => openPanel('background'),
  });
  add('general', {
    id: 'claude-settings',
    label: 'Claude Code settings…',
    icon: <SlidersHorizontal />,
    keywords: 'permissions rules allow deny hooks claude.md instructions memory config',
    run: () => openDialog('settings'),
  });
  add('general', {
    id: 'mcp',
    label: 'MCP servers…',
    icon: <Plug />,
    keywords: 'tools connectors slack plugins sign in reconnect model context protocol',
    run: () => openDialog('mcp', { sessionId: ctx.currentId || null }),
  });
  const ModeIcon = MODE_ICONS[ctx.currentMode] || Hand;
  add('general', {
    id: 'model',
    label: 'Switch model…',
    icon: <ModelIcon model={ctx.modelInfo} size={16} />,
    value: shortModelName(ctx.modelInfo),
    keywords: 'llm provider',
    page: 'model',
  });
  add('general', { id: 'mode', label: 'Switch mode…', icon: <ModeIcon />, value: modeLabel(ctx.currentMode), keywords: 'permission approvals', page: 'mode' });
  if (effortOptions(ctx.modelInfo).length > 1) {
    const effective = effectiveEffort(ctx.modelInfo, ctx.chosenEffort);
    add('general', {
      id: 'effort',
      label: 'Change effort…',
      icon: <EffortGlyph level={EFFORT_LEVEL[effective] || 2} />,
      value: effortName(effective),
      keywords: 'reasoning thinking',
      page: 'effort',
    });
  }
  add('general', { id: 'sidebar', label: 'Toggle sidebar', icon: <PanelLeft />, shortcut: SHORTCUTS.sidebar.keys, keywords: 'hide show left', run: toggleSidebar });
  add('general', {
    id: 'theme',
    label: 'Change theme…',
    icon: <SunMoon />,
    value: THEMES.find((t) => t.id === ctx.theme)?.label,
    keywords: 'appearance dark light system color',
    page: 'theme',
  });
  if (ctx.permission !== 'unsupported') {
    add('general', {
      id: 'notifications',
      label: ctx.notifications ? 'Turn off desktop notifications' : 'Turn on desktop notifications',
      icon: ctx.notifications ? <BellOff /> : <Bell />,
      keywords: 'alerts notify',
      run: () => setNotificationsEnabled(!ctx.notifications),
    });
  }
  add('general', { id: 'help', label: 'Keyboard shortcuts', icon: <Keyboard />, shortcut: SHORTCUTS.help.keys, keywords: 'help keys hotkeys', run: () => openDialog('shortcuts') });

  for (const page of ['model', 'mode', 'effort', 'theme']) {
    for (const section of pageSections(page, ctx)) {
      for (const item of section.items) {
        // Matched on the choice itself; the page name only counts as a keyword, so
        // "effort" still finds "Change effort…" first.
        add('general', {
          ...item,
          id: `${page}:${item.id}`,
          prefix: PAGES[page].title,
          description: '',
          keywords: `${PAGES[page].title} ${item.keywords || ''}`,
          searchOnly: true,
        });
      }
    }
  }
  return commands;
}

function sessionItem(result, ctx, now) {
  const { session, matches } = result;
  const project = basename(session.cwd);
  const model = shortModelName(findModel(ctx.info, session.model));
  return {
    id: 'session:' + session.id,
    label: session.title || 'New session',
    matches: matches.title,
    description: [
      { text: project, indices: matches.project },
      { text: model, indices: matches.model },
    ],
    icon: <MessageSquare />,
    dot: sessionDot(session),
    meta: session.archived ? 'Archived' : relativeTime(sortTime(session), now),
    source: session.source,
    run: () => selectSession(session.id),
  };
}

// The root page: recent sessions + commands, or ranked matches for a query.
function rootSections(query, ctx) {
  const now = Date.now();
  const modelName = (modelId) => findModel(ctx.info, modelId).name;
  const commands = rootCommands(ctx);
  const sessions = rankSessions(ctx.sessions, query, { currentId: ctx.currentId, modelName, now, limit: query.trim() ? 8 : 5 });

  if (!query.trim()) {
    return [
      { title: 'Recent sessions', items: sessions.map((r) => sessionItem(r, ctx, now)) },
      { title: 'This session', items: commands.filter((c) => c.group === 'session') },
      { title: 'General', items: commands.filter((c) => c.group === 'general' && !c.searchOnly) },
    ].filter((section) => section.items.length);
  }
  const ranked = rankCommands(commands, query).slice(0, 10);
  const commandSection = { title: 'Commands', items: ranked.map((r) => ({ ...r.command, matches: r.matches.label })), best: ranked[0]?.score ?? -Infinity };
  const sessionSection = { title: 'Sessions', items: sessions.map((r) => sessionItem(r, ctx, now)), best: sessions[0]?.score ?? -Infinity };
  const sections = commandSection.best >= sessionSection.best ? [commandSection, sessionSection] : [sessionSection, commandSection];
  return sections.filter((section) => section.items.length);
}

function filterSections(sections, query) {
  if (!query.trim()) return sections;
  const all = sections.flatMap((section) => section.items);
  const ranked = rankCommands(all, query);
  if (!ranked.length) return [];
  return [{ title: 'Matches', items: ranked.map((r) => ({ ...r.command, matches: r.matches.label })) }];
}

/* Rendering */

function Highlight({ text, indices }) {
  return highlightRuns(text, indices).map((run, i) => (run.match ? <mark key={i}>{run.text}</mark> : run.text));
}

function Row({ item, index, active, onHover, onRun }) {
  const classes = ['palette-row', active && 'is-active', item.selected && 'is-selected', item.danger && 'is-danger', item.disabled && 'is-disabled', item.tone && `tone-${item.tone}`];
  return (
    <div
      id={`palette-option-${index}`}
      role="option"
      aria-selected={String(active)}
      aria-disabled={item.disabled ? 'true' : undefined}
      class={classes.filter(Boolean).join(' ')}
      onMouseMove={onHover}
      onClick={onRun}
    >
      <span class="palette-icon">
        {item.icon}
        {item.dot && <span class={`palette-dot dot-${item.dot}`} />}
      </span>
      <span class="palette-text">
        <span class="palette-label">
          {item.prefix && <span class="palette-prefix">{item.prefix}: </span>}
          <Highlight text={item.label} indices={item.matches} />
        </span>
        {Array.isArray(item.description) ? (
          <span class="palette-description">
            {item.description.map((part, i) => (
              <span key={i}>
                {i > 0 && ' · '}
                <Highlight text={part.text} indices={part.indices} />
              </span>
            ))}
          </span>
        ) : (
          item.description && <span class="palette-description">{item.description}</span>
        )}
      </span>
      <span class="palette-trail">
        {item.note && <span class="palette-row-note">{item.note}</span>}
        {item.value && <span class="palette-value">{item.value}</span>}
        {item.source && <SourceBadge source={item.source} />}
        {item.meta && <span class="palette-meta">{item.meta}</span>}
        {item.shortcut && <Keys keys={item.shortcut} />}
        {item.page && <ChevronRight size={15} class="palette-chevron" />}
        {item.selected && <Check size={15} class="palette-check" />}
      </span>
    </div>
  );
}

export function Palette({ page: initialPage = 'root' }) {
  const ctx = usePaletteContext();
  const [page, setPage] = useState(PAGES[initialPage] ? initialPage : 'root');
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState(null);
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const sections = page === 'root' ? rootSections(query, ctx) : filterSections(pageSections(page, ctx), query);
  const items = sections.flatMap((section) => section.items);
  const enabled = items.filter((item) => !item.disabled);
  const active =
    enabled.find((item) => item.id === activeId) || (page !== 'root' && !query && enabled.find((item) => item.selected)) || enabled[0] || null;
  const note = page === 'root' ? '' : pageNote(page, ctx);
  const narrow = globalThis.matchMedia?.('(max-width: 759px)').matches;

  // Open as a modal (focus trap, top layer); give focus back on close.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement;
    if (!dialog.open) dialog.showModal();
    inputRef.current?.focus();
    return () => {
      const focused = document.activeElement;
      const focusInside = !focused || focused === document.body || dialog.contains(focused);
      if (dialog.open) dialog.close();
      if (focusInside && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, [page]);

  // Keep the highlighted row visible (and the first section's title with it).
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (!active || active === enabled[0]) list.scrollTop = 0;
    else list.querySelector('.palette-row.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active?.id, page, query]);

  const go = (next, focusId = null) => {
    setPage(next);
    setQuery('');
    setActiveId(focusId);
  };
  const back = () => go('root', PAGES[page]?.opener || null);

  const run = (item) => {
    if (!item || item.disabled) return;
    if (item.page) {
      go(item.page);
      return;
    }
    closeDialog();
    item.run?.();
  };

  const move = (delta) => {
    if (!enabled.length) return;
    const index = enabled.indexOf(active);
    const next = enabled[(index + delta + enabled.length) % enabled.length];
    setActiveId(next.id);
  };

  const onKeyDown = (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')) {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(active);
    } else if (event.key === 'Escape') {
      // Keep the app's own Esc handling (drawer, side panel) out of it.
      event.stopPropagation();
      if (page !== 'root') {
        event.preventDefault();
        back();
      }
    } else if (event.key === 'Backspace' && !query && page !== 'root') {
      event.preventDefault();
      back();
    }
  };

  const onCancel = (event) => {
    event.preventDefault();
    if (page !== 'root') back();
    else closeDialog();
  };

  let index = -1;
  return (
    <dialog
      ref={dialogRef}
      class="palette"
      aria-label="Command palette"
      onCancel={onCancel}
      onClick={(event) => event.target === dialogRef.current && closeDialog()}
    >
      <div class="palette-panel">
        <div class="palette-search">
          {page === 'root' ? (
            <Search size={18} class="palette-search-icon" />
          ) : (
            <button type="button" class="icon-btn icon-btn-sm palette-back" onClick={back} aria-label="Back" title="Back">
              <ArrowLeft />
            </button>
          )}
          {page !== 'root' && <span class="palette-crumb">{PAGES[page].title}</span>}
          <input
            ref={inputRef}
            class="palette-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={active ? `palette-option-${items.indexOf(active)}` : undefined}
            aria-label={page === 'root' ? 'Search sessions and commands' : PAGES[page].placeholder}
            placeholder={page !== 'root' ? PAGES[page].placeholder : narrow ? 'Search…' : 'Search sessions and commands…'}
            value={query}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            enterkeyhint="go"
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setActiveId(null);
            }}
            onKeyDown={onKeyDown}
          />
          <button type="button" class="palette-esc" onClick={closeDialog} aria-label="Close">
            <span class="palette-esc-key">esc</span>
            <span class="palette-esc-touch">Cancel</span>
          </button>
        </div>

        <div class="palette-list" id="palette-list" role="listbox" aria-label="Results" hidden={!items.length} ref={listRef} onMouseDown={(event) => event.preventDefault()}>
          {sections.map((section, s) => (
            <div class="palette-section" role="group" aria-label={section.title || undefined} key={section.title || s}>
              {section.title && (
                // The group's aria-label already names it.
                <div class="palette-section-title" aria-hidden="true">
                  {section.title}
                  {section.note && <span class="palette-section-note">{section.note}</span>}
                </div>
              )}
              {section.items.map((item) => {
                index += 1;
                const isActive = item === active;
                return (
                  <Row
                    key={item.id}
                    item={item}
                    index={index}
                    active={isActive}
                    onHover={() => !isActive && !item.disabled && setActiveId(item.id)}
                    onRun={() => run(item)}
                  />
                );
              })}
            </div>
          ))}
        </div>
        {/* Always present, so screen readers announce "No results" when it appears. */}
        <div class={items.length ? 'palette-status' : 'palette-status palette-empty'} role="status">
          {!items.length && (
            <>
              <SearchX size={20} aria-hidden="true" />
              <p>
                No results for <strong>“{query.trim()}”</strong>
              </p>
              <span>{page === 'root' ? 'Try a session title, a project, a model or a command.' : 'Try another name.'}</span>
            </>
          )}
        </div>

        {note && <div class="palette-page-note">{note}</div>}

        <footer class="palette-foot" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            Navigate
          </span>
          <span>
            <kbd>↵</kbd>
            {active?.page ? 'Open' : active?.id?.startsWith('session:') ? 'Go to session' : page === 'root' ? 'Run' : 'Choose'}
          </span>
          {page !== 'root' && (
            <span>
              <kbd>⌫</kbd>
              Back
            </span>
          )}
          <span class="palette-foot-spacer" />
          <span>
            <Keys keys={SHORTCUTS.help.keys} />
            Shortcuts
          </span>
        </footer>
      </div>
    </dialog>
  );
}
