// Claude Code settings (`/settings`, the sidebar gear, the palette): the permission rules,
// hooks, CLAUDE.md files and auto-memory that Claude Code reads, which used to be edited by
// hand under ~/.claude. The tabs are in settings/registry.js; each edits real files through
// /api/settings and tells how many running sessions will restart to read the change.
import { useCallback, useMemo, useRef, useState } from 'preact/hooks';
import { closeDialog } from '../actions.js';
import { commandCwd } from '../composer.js';
import { basename } from '../lib/format.js';
import { folderClusterId } from '../lib/clusters.js';
import { projectChoices } from '../lib/settings.js';
import { shallowEqual, useAppState } from '../state.js';
import { Dialog } from './Dialog.jsx';
import { SettingsContext } from './settings/hooks.js';
import { Notice, shortPath } from './settings/parts.jsx';
import { SETTINGS_TABS } from './settings/registry.js';
import './SettingsDialog.css';

const OTHER = '\0other';

export function SettingsDialog({ tab }) {
  const { home, defaultProject, sessions, cluster } = useAppState(
    (s) => ({ home: s.info?.root, defaultProject: s.info?.defaultProject, sessions: s.sessions, cluster: folderClusterId(s) }),
    shallowEqual,
  );
  const [tabId, setTabId] = useState(SETTINGS_TABS.some((entry) => entry.id === tab) ? tab : SETTINGS_TABS[0].id);
  const [cwd, setCwd] = useState(() => commandCwd() || defaultProject || '');
  // Editors with unsaved changes (see useDirty); leaving while there are any asks first.
  const dirty = useRef(new Set());
  const [leaving, setLeaving] = useState(null);
  const markDirty = useCallback((id, flag) => {
    if (flag) dirty.current.add(id);
    else dirty.current.delete(id);
  }, []);
  const guard = useCallback((action) => {
    if (dirty.current.size) setLeaving(() => action);
    else action();
  }, []);
  const context = useMemo(() => ({ cwd, cluster, guard, markDirty }), [cwd, cluster, guard, markDirty]);

  const current = SETTINGS_TABS.find((entry) => entry.id === tabId) || SETTINGS_TABS[0];
  const Panel = current.Panel;
  const discard = () => {
    const action = leaving;
    dirty.current.clear();
    setLeaving(null);
    action();
  };
  const onTabKey = (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = SETTINGS_TABS[(SETTINGS_TABS.indexOf(current) + step + SETTINGS_TABS.length) % SETTINGS_TABS.length];
    guard(() => setTabId(next.id));
    event.currentTarget.querySelector(`#settings-tab-${next.id}`)?.focus();
  };

  return (
    <Dialog
      title="Claude Code settings"
      onClose={() => guard(closeDialog)}
      class="settings-dialog"
      footer={
        <>
          <span class="settings-restart-note">Open chats restart when idle to read a change, which rewrites their prompt cache once.</span>
          <span class="spacer" />
          <button type="button" class="btn btn-secondary" onClick={() => guard(closeDialog)}>
            Done
          </button>
        </>
      }
    >
      <SettingsContext.Provider value={context}>
        <div class="settings-tabs" role="tablist" aria-label="Settings sections" onKeyDown={onTabKey}>
          {SETTINGS_TABS.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              id={`settings-tab-${id}`}
              role="tab"
              aria-selected={String(id === current.id)}
              aria-controls="settings-panel"
              tabindex={id === current.id ? 0 : -1}
              onClick={() => id !== current.id && guard(() => setTabId(id))}
            >
              <Icon size={15} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
        <ProjectPicker cwd={cwd} home={home} choices={projectChoices({ cwd: commandCwd(), project: cwd, defaultProject, sessions })} onChange={(next) => guard(() => setCwd(next))} />
        <div class="settings-panel" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${current.id}`}>
          <Panel key={current.id} />
        </div>
        {leaving && (
          <div class="settings-leave">
            <Notice
              tone="warning"
              action={
                <span class="settings-leave-actions">
                  <button type="button" class="btn btn-sm btn-ghost" onClick={() => setLeaving(null)}>
                    Keep editing
                  </button>
                  <button type="button" class="btn btn-sm btn-danger" onClick={discard}>
                    Discard changes
                  </button>
                </span>
              }
            >
              You have unsaved changes.
            </Notice>
          </div>
        )}
      </SettingsContext.Provider>
    </Dialog>
  );
}

/** The project folder whose project, local and memory files the tabs show: this chat's, another known one, or any path. */
function ProjectPicker({ cwd, home, choices, onChange }) {
  const [custom, setCustom] = useState('');
  const [typing, setTyping] = useState(false);
  const known = choices.includes(cwd);
  const showInput = typing || !known;
  return (
    <div class="settings-project">
      <label class="settings-project-label" for="settings-project">
        Project
      </label>
      <select
        id="settings-project"
        class="input"
        value={showInput ? OTHER : cwd}
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === OTHER) {
            setCustom(cwd);
            setTyping(true);
          } else {
            setTyping(false);
            onChange(value);
          }
        }}
      >
        {choices.map((dir) => (
          <option key={dir} value={dir}>
            {basename(dir)} · {shortPath(dir, home)}
          </option>
        ))}
        <option value={OTHER}>{!known && cwd ? `${shortPath(cwd, home)}` : 'Another folder…'}</option>
      </select>
      {showInput && (
        <form
          class="settings-project-other"
          onSubmit={(event) => {
            event.preventDefault();
            const path = custom.trim();
            if (!path) return;
            setTyping(false);
            onChange(path);
          }}
        >
          <input class="input mono" value={custom} onInput={(event) => setCustom(event.currentTarget.value)} placeholder="/home/you/project" aria-label="Project folder path" spellcheck={false} autocomplete="off" autocapitalize="off" />
          <button type="submit" class="btn btn-sm btn-secondary" disabled={!custom.trim() || custom.trim() === cwd}>
            Use
          </button>
        </form>
      )}
    </div>
  );
}
