// Hooks tab: the hooks of Claude Code's user, project and local settings files, as a
// readable list per event and as JSON to edit. Saving changes only `hooks` in the file.
import { useMemo, useState } from 'preact/hooks';
import { Terminal } from 'lucide-preact';
import { hookRows, hooksText, parseHooksDraft } from '../../lib/settings.js';
import { settingsApi } from '../../lib/settingsApi.js';
import { useAppState } from '../../state.js';
import { useRemote, useSettings } from './hooks.js';
import { EditorShell, Loading, LoadFailed, Notice, shortPath } from './parts.jsx';
import { ScopeSwitch } from './ScopeSwitch.jsx';

const SCOPES = [
  { id: 'user', label: 'User' },
  { id: 'project', label: 'Project' },
  { id: 'local', label: 'Local' },
];

export function HooksTab() {
  const { guard } = useSettings();
  const [scope, setScope] = useState('user');
  return (
    <div class="settings-pane">
      <ScopeSwitch scopes={SCOPES} value={scope} onChange={(next) => guard(() => setScope(next))} label="Hooks scope" />
      <p class="settings-note">
        Hooks run a command when Claude Code reaches an event, such as before a tool runs. They run on this machine with your permissions, so read a hook before you save it.
      </p>
      <FileHooks key={scope} scope={scope} />
    </div>
  );
}

function FileHooks({ scope }) {
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
        <Notice tone="error">This file is not valid JSON ({file.parsed.error}). Harbor does not change a file it cannot read; fix it by hand first.</Notice>
      ) : (
        <HooksEditor key={`${file.scope}:${file.version}`} file={file} cwd={cwd} onSaved={remote.set} onReload={remote.set} />
      )}
    </>
  );
}

function HooksEditor({ file, cwd, onSaved, onReload }) {
  const base = useMemo(() => hooksText(file.parsed.hooks), [file]);
  const [text, setText] = useState(base);
  const parsed = useMemo(() => parseHooksDraft(text), [text]);
  // Spacing alone is no change: a valid draft is compared in its canonical form.
  const dirty = (parsed.hooks ? hooksText(parsed.hooks) : text) !== base;
  // The list shows the draft while it is valid, else what is saved.
  const shown = parsed.hooks ?? file.parsed.hooks;

  return (
    <EditorShell
      file={file}
      textOf={(view) => hooksText(view.parsed?.hooks)}
      text={parsed.hooks ? hooksText(parsed.hooks) : text}
      dirty={dirty}
      problem={parsed.error}
      language="json"
      save={(version) => settingsApi.patchFile(file.scope, file.id, { cwd, version, hooks: parsed.hooks }, cluster)}
      onSaved={onSaved}
      onReload={onReload}
      onRevert={() => setText(base)}
    >
      <HookList hooks={shown} stale={!!parsed.error} />
      <label class="settings-label" for="hooks-json">
        Edit as JSON
      </label>
      <textarea
        id="hooks-json"
        class={`settings-textarea mono hooks-json ${parsed.error ? 'is-invalid' : ''}`}
        value={text}
        onInput={(event) => setText(event.currentTarget.value)}
        spellcheck={false}
        autocomplete="off"
        autocapitalize="off"
        aria-invalid={parsed.error ? 'true' : undefined}
        aria-describedby={parsed.error ? 'hooks-problem' : undefined}
        rows={12}
      />
      {parsed.error && (
        <p class="settings-problem" id="hooks-problem" role="alert">
          {parsed.error}
        </p>
      )}
      <p class="settings-note">
        Shape: <code>{'{"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "./check.sh"}]}]}'}</code>
      </p>
    </EditorShell>
  );
}

/** The hooks per event: its matcher groups, each with the commands it runs. */
function HookList({ hooks, stale }) {
  const rows = hookRows(hooks);
  if (!rows.length) return <p class="rule-empty">No hooks in this file.</p>;
  return (
    <div class={`hook-events ${stale ? 'is-stale' : ''}`} aria-label="Hooks by event">
      {rows.map((row) => (
        <section class="hook-event" key={row.event}>
          <h3 class="hook-event-name">
            {row.event}
            {!row.known && <span class="settings-chip is-warn">Unknown event</span>}
          </h3>
          {row.groups.map((group, index) => (
            <div class="hook-group" key={index}>
              <span class="hook-matcher" title={group.matcher ? 'Tools or sources it applies to' : 'Applies to everything'}>
                {group.matcher || 'All'}
              </span>
              <ul class="hook-commands">
                {group.hooks.map((hook, i) => (
                  <li key={i}>
                    <Terminal size={13} aria-hidden="true" />
                    <code>{hook.summary || hook.type}</code>
                    {hook.type !== 'command' && <span class="settings-chip">{hook.type}</span>}
                    {hook.timeout ? <span class="hook-timeout">{hook.timeout}s</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
