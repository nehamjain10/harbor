// Permissions tab: the allow / ask / deny rules, default mode and extra directories of
// Claude Code's user, project and local settings files, and this session's "Always allow"
// grants. Rules are edited as a draft and saved with PATCH, which changes only
// `permissions` in the file.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Pencil, Plus, ShieldCheck, Trash2, X } from 'lucide-preact';
import { patchSession, toast } from '../../actions.js';
import { allowRuleTexts } from '../../lib/approvals.js';
import { duplicateProblem, permissionsPatch, permissionsText } from '../../lib/settings.js';
import { settingsApi } from '../../lib/settingsApi.js';
import { useAppState } from '../../state.js';
import { PERMISSION_MODES, ruleProblem } from '../../../server/settings-schema.mjs';
import { modeLabel } from '../../lib/modes.js';
import { useRemote, useSettings } from './hooks.js';
import { EditorShell, Loading, LoadFailed, Notice, shortPath } from './parts.jsx';
import { ScopeSwitch } from './ScopeSwitch.jsx';

const SCOPES = [
  { id: 'user', label: 'User', note: 'Every project, in your Claude config folder.' },
  { id: 'project', label: 'Project', note: "This project's .claude/settings.json, shared with the team when committed. Allow rules apply only once Claude Code trusts the folder." },
  { id: 'local', label: 'Local', note: 'Only on this machine: .claude/settings.local.json, not committed. Allow rules apply only once Claude Code trusts the folder.' },
  { id: 'session', label: 'Session', note: 'What “Always allow” granted in the open chat. It ends with the chat.' },
];

const LISTS = [
  { key: 'allow', title: 'Allow', note: 'Runs without asking.' },
  { key: 'ask', title: 'Ask', note: 'Always asks first, even where Allow matches.' },
  { key: 'deny', title: 'Deny', note: 'Never runs. Wins over Allow and Ask.' },
];

const RULE_HINT = 'Bash(npm run test:*)  ·  Read(~/secrets/**)  ·  mcp__server__tool';

const directoryProblem = (value) => (!value.trim() ? 'Enter a folder.' : /[\n\r]/.test(value) ? 'A folder is a single line.' : null);

export function PermissionsTab() {
  const { guard } = useSettings();
  const [scope, setScope] = useState('user');
  const current = SCOPES.find((entry) => entry.id === scope);
  return (
    <div class="settings-pane">
      <ScopeSwitch scopes={SCOPES} value={scope} onChange={(next) => guard(() => setScope(next))} label="Permissions scope" />
      <p class="settings-note">{current.note}</p>
      {scope === 'session' ? <SessionGrants /> : <FilePermissions key={scope} scope={scope} />}
    </div>
  );
}

function FilePermissions({ scope }) {
  const { cwd, cluster } = useSettings();
  const home = useAppState((s) => s.info?.root);
  const remote = useRemote(() => settingsApi.file(scope, 'settings', cwd, cluster), [cluster, scope, scope === 'user' ? '' : cwd]);
  const file = remote.data;
  if (scope !== 'user' && !cwd) return <Notice>Open a chat or choose a project folder above to edit its settings.</Notice>;
  if (remote.error) return <LoadFailed message={remote.error} onRetry={remote.reload} />;
  if (!file) return <Loading />;
  return (
    <>
      <p class="settings-path">
        <code title={file.path}>{shortPath(file.path, home)}</code>
        {!file.exists && <span class="settings-chip">Not created yet</span>}
      </p>
      {file.parsed.valid === false ? (
        <Notice tone="error">
          This file is not valid JSON ({file.parsed.error}). Harbor does not change a file it cannot read; fix it by hand first.
        </Notice>
      ) : (
        <>
          {file.parsed.warning && <Notice tone="warning">{file.parsed.warning}</Notice>}
          <PermissionsEditor key={`${file.scope}:${file.version}`} file={file} cwd={cwd} onSaved={remote.set} onReload={remote.set} />
        </>
      )}
    </>
  );
}

function PermissionsEditor({ file, cwd, onSaved, onReload }) {
  const base = file.parsed.permissions;
  const [draft, setDraft] = useState(base);
  const patch = permissionsPatch(base, draft);
  const dirty = Object.keys(patch).length > 0;
  const set = (key, value) => setDraft((previous) => ({ ...previous, [key]: value }));

  return (
    <EditorShell
      file={file}
      textOf={(view) => permissionsText(view.parsed?.permissions)}
      text={permissionsText(draft)}
      dirty={dirty}
      review={false}
      save={(version) => settingsApi.patchFile(file.scope, file.id, { cwd, version, permissions: patch }, cluster)}
      onSaved={onSaved}
      onReload={onReload}
      onRevert={() => setDraft(base)}
    >
      <div class="perm-sections">
        {LISTS.map(({ key, title, note }) => (
          <RuleList key={key} title={title} note={note} items={draft[key]} base={base[key]} onChange={(items) => set(key, items)} check={ruleProblem} placeholder="Bash(npm run test:*)" hint={RULE_HINT} />
        ))}
        <section class="perm-section">
          <h3 class="perm-title">Default mode</h3>
          <p class="settings-note">
            Harbor picks the permission mode for every chat, so this default applies to Claude Code in your terminal; the mode picker wins here.
          </p>
          <select
            class="input perm-mode"
            aria-label="Default mode"
            value={draft.defaultMode || ''}
            onChange={(event) => set('defaultMode', event.currentTarget.value || null)}
          >
            <option value="">Not set</option>
            {[...new Set([...PERMISSION_MODES, draft.defaultMode].filter(Boolean))].map((mode) => (
              <option key={mode} value={mode}>
                {modeLabel(mode) === mode ? mode : `${mode} (${modeLabel(mode)})`}
              </option>
            ))}
          </select>
        </section>
        <RuleList
          title="Additional directories"
          note="Claude can read and edit in these folders besides the project."
          items={draft.additionalDirectories}
          base={base.additionalDirectories}
          onChange={(items) => set('additionalDirectories', items)}
          check={directoryProblem}
          placeholder="/home/you/shared-assets"
          addLabel="Add folder"
        />
      </div>
    </EditorShell>
  );
}

/** One list of rules (or folders): rows with edit and remove, and an inline add field. */
function RuleList({ title, note, items, base, onChange, check, placeholder, hint, addLabel = 'Add rule' }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(-1);
  const added = (item) => !base.includes(item);
  const id = title.toLowerCase().replace(/\s+/g, '-');

  const submit = (index, value) => {
    const next = index < 0 ? [...items, value] : items.map((item, i) => (i === index ? value : item));
    onChange(next);
    setAdding(false);
    setEditing(-1);
  };
  const problemOf = (except) => (value) => check(value) || duplicateProblem(items, value, except);

  return (
    <section class="perm-section" aria-labelledby={`perm-${id}`}>
      <div class="perm-head">
        <h3 class="perm-title" id={`perm-${id}`}>
          {title}
          <span class="perm-count">{items.length}</span>
        </h3>
        {!adding && (
          <button type="button" class="btn btn-sm btn-ghost" onClick={() => { setEditing(-1); setAdding(true); }}>
            <Plus size={14} />
            {addLabel}
          </button>
        )}
      </div>
      <p class="settings-note">{note}</p>
      <ul class="rule-list">
        {items.map((item, index) =>
          editing === index ? (
            <li class="rule-row is-editing" key={item}>
              <RuleInput initial={item} check={problemOf(index)} placeholder={placeholder} submitLabel="Save" onSubmit={(value) => submit(index, value)} onCancel={() => setEditing(-1)} />
            </li>
          ) : (
            <li class={`rule-row ${added(item) ? 'is-new' : ''}`} key={item}>
              <code class="rule-text">{item}</code>
              {added(item) && <span class="settings-chip is-new">New</span>}
              <button type="button" class="icon-btn icon-btn-sm" onClick={() => { setAdding(false); setEditing(index); }} aria-label={`Edit ${item}`} title="Edit">
                <Pencil size={14} />
              </button>
              <button type="button" class="icon-btn icon-btn-sm" onClick={() => onChange(items.filter((_, i) => i !== index))} aria-label={`Remove ${item}`} title="Remove">
                <Trash2 size={14} />
              </button>
            </li>
          ),
        )}
        {adding && (
          <li class="rule-row is-editing">
            <RuleInput check={problemOf(-1)} placeholder={placeholder} submitLabel="Add" onSubmit={(value) => submit(-1, value)} onCancel={() => setAdding(false)} />
          </li>
        )}
      </ul>
      {!items.length && !adding && <p class="rule-empty">None.</p>}
      {adding && hint && <p class="rule-hint">{hint}</p>}
    </section>
  );
}

/** A one-line field with Enter to submit and Esc to cancel (Esc does not close the dialog). */
function RuleInput({ initial = '', check, placeholder, submitLabel, onSubmit, onCancel }) {
  const [value, setValue] = useState(initial);
  const input = useRef(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const problem = value ? check(value.trim() === value ? value : value.trim()) : null;
  const submit = (event) => {
    event.preventDefault();
    const text = value.trim();
    if (!text || check(text)) return;
    onSubmit(text);
  };
  return (
    <form class="rule-form" onSubmit={submit}>
      <input
        class="input mono"
        value={value}
        onInput={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }}
        placeholder={placeholder}
        aria-label="Rule"
        aria-invalid={problem ? 'true' : undefined}
        spellcheck={false}
        autocomplete="off"
        autocapitalize="off"
        ref={input}
      />
      <button type="submit" class="btn btn-sm btn-secondary" disabled={!value.trim() || !!check(value.trim())}>
        {submitLabel}
      </button>
      <button type="button" class="icon-btn icon-btn-sm" onClick={onCancel} aria-label="Cancel" title="Cancel">
        <X size={14} />
      </button>
      {problem && <p class="rule-problem">{problem}</p>}
    </form>
  );
}

// The open chat's "Always allow" grants, each removable; they live in the session, not in a file.
function SessionGrants() {
  const session = useAppState((s) => s.current, (a, b) => a?.id === b?.id && a?.allowRules === b?.allowRules && a?.allowDirectories === b?.allowDirectories);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  if (!session) return <Notice>Open a chat to see what it was allowed to do.</Notice>;

  const rules = Array.isArray(session.allowRules) ? session.allowRules : [];
  const texts = allowRuleTexts(rules);
  const directories = Array.isArray(session.allowDirectories) ? session.allowDirectories.filter((dir) => typeof dir === 'string') : [];
  const remove = async (patch, text) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await patchSession(session.id, patch);
      toast(text);
    } catch (error) {
      toast(error.message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  // allowRules and the rule texts line up one to one (a rule value gives one text).
  const removable = rules.length === texts.length;

  if (!rules.length && !directories.length) return <p class="rule-empty">Nothing was allowed in this chat. “Always allow” on an approval adds to this list.</p>;
  return (
    <div class="perm-sections">
      <section class="perm-section">
        <div class="perm-head">
          <h3 class="perm-title">
            <ShieldCheck size={14} aria-hidden="true" />
            Allowed in “{session.title}”
            <span class="perm-count">{texts.length + directories.length}</span>
          </h3>
          <button type="button" class="btn btn-sm btn-ghost" disabled={busy} onClick={() => remove({ allowRules: [], allowDirectories: [] }, 'Cleared. It will ask again.')}>
            Clear all
          </button>
        </div>
        <ul class="rule-list">
          {texts.map((text, index) => (
            <li class="rule-row" key={'r' + text}>
              <code class="rule-text">{text}</code>
              {removable && (
                <button
                  type="button"
                  class="icon-btn icon-btn-sm"
                  disabled={busy}
                  onClick={() => remove({ allowRules: rules.filter((_, i) => i !== index) }, 'Removed. It will ask again.')}
                  aria-label={`Remove ${text}`}
                  title="Remove"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
          {directories.map((dir) => (
            <li class="rule-row" key={'d' + dir}>
              <code class="rule-text">access to {dir}</code>
              <button
                type="button"
                class="icon-btn icon-btn-sm"
                disabled={busy}
                onClick={() => remove({ allowDirectories: directories.filter((other) => other !== dir) }, 'Removed. It will ask again.')}
                aria-label={`Remove access to ${dir}`}
                title="Remove"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
