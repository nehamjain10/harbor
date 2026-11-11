// CLAUDE.md tab: the instruction files Claude Code reads (user, project, local), listed
// per scope with a Create button for the ones that do not exist, and a Markdown editor.
import { useState } from 'preact/hooks';
import { FilePlus2, FileText } from 'lucide-preact';
import { relativeTime } from '../../lib/format.js';
import { fileSize } from '../../lib/settings.js';
import { settingsApi } from '../../lib/settingsApi.js';
import { useAppState } from '../../state.js';
import { useRemote, useSettings } from './hooks.js';
import { Loading, LoadFailed, Notice, shortPath } from './parts.jsx';
import { TextFileEditor } from './fields.jsx';
import { SplitView } from './SplitView.jsx';

const SCOPE_LABELS = { user: 'User', project: 'Project', local: 'Local' };
const SCOPE_NOTES = {
  user: 'Applies to every project.',
  project: 'This project, shared with the team when committed.',
  local: 'Only on this machine; keep it out of git.',
};

const keyOf = (file) => `${file.scope}/${file.id}`;

export function InstructionsTab() {
  const { cwd, cluster, guard } = useSettings();
  const home = useAppState((s) => s.info?.root);
  const list = useRemote(() => settingsApi.files(cwd, cluster), [cluster, cwd]);
  const [selected, setSelected] = useState('user/claude-md');
  const [open, setOpen] = useState(false);

  if (list.error) return <LoadFailed message={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const files = list.data.files.filter((file) => file.kind === 'markdown');
  const current = files.find((file) => keyOf(file) === selected) || files[0];

  const choose = (file) => guard(() => {
    setSelected(keyOf(file));
    setOpen(true);
  });

  const listView = (
    <>
      {Object.keys(SCOPE_LABELS).map((scope) => {
        const group = files.filter((file) => file.scope === scope);
        if (!group.length) return null;
        return (
          <section class="split-group" key={scope} aria-label={`${SCOPE_LABELS[scope]} files`}>
            <div class="eyebrow">{SCOPE_LABELS[scope]}</div>
            <ul class="split-items">
              {group.map((file) => (
                <li key={keyOf(file)}>
                  <button
                    type="button"
                    class={`split-item ${current && keyOf(file) === keyOf(current) ? 'is-selected' : ''}`}
                    onClick={() => choose(file)}
                    aria-current={current && keyOf(file) === keyOf(current) ? 'true' : undefined}
                    disabled={!!file.error}
                    title={file.path}
                  >
                    {file.exists ? <FileText size={15} aria-hidden="true" /> : <FilePlus2 size={15} aria-hidden="true" />}
                    <span class="split-item-text">
                      <span class="split-item-title">
                        <span class="split-item-name">{file.rel}</span>
                      </span>
                      <span class="split-item-sub">
                        {file.error ? file.error : file.exists ? `${fileSize(file.size)} · ${relativeTime(file.mtime)}` : 'Not created yet'}
                      </span>
                    </span>
                    {!file.exists && !file.error && <span class="settings-chip is-new">Create</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {!cwd && <p class="settings-note">Open a chat or choose a project folder above for its CLAUDE.md files.</p>}
    </>
  );

  return (
    <SplitView open={open} onBack={() => guard(() => setOpen(false))} backLabel="Files" list={listView}>
      {current ? (
        <InstructionFile key={keyOf(current)} entry={current} cwd={cwd} cluster={cluster} home={home} onChanged={list.reload} />
      ) : (
        <Notice>No instruction files to show.</Notice>
      )}
    </SplitView>
  );
}

function InstructionFile({ entry, cwd, cluster, home, onChanged }) {
  const remote = useRemote(() => settingsApi.file(entry.scope, entry.id, cwd, cluster), [cluster, entry.scope, entry.id, entry.scope === 'user' ? '' : cwd]);
  const file = remote.data;
  if (remote.error) return <LoadFailed message={remote.error} onRetry={remote.reload} />;
  if (!file) return <Loading />;
  const saved = (result) => {
    remote.set(result);
    onChanged();
  };
  return (
    <div class="settings-pane">
      <div class="detail-head">
        <h3 class="detail-title">{file.rel}</h3>
        <p class="settings-path">
          <code title={file.path}>{shortPath(file.path, home)}</code>
          {!file.exists && <span class="settings-chip">Not created yet</span>}
        </p>
        <p class="settings-note">{SCOPE_NOTES[file.scope]}</p>
      </div>
      <TextFileEditor
        key={`${file.version}`}
        file={file}
        label="Instructions"
        save={(content, version) => settingsApi.putFile(file.scope, file.id, { cwd, content, version }, cluster)}
        onSaved={saved}
        onReload={saved}
        note={!file.exists ? <p class="settings-note">This file does not exist yet. Saving creates it.</p> : null}
      />
    </div>
  );
}
