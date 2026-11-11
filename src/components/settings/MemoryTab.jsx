// Memory tab: Claude Code's auto-memory for the project (`<config>/projects/<slug>/memory`):
// the memory files with their frontmatter, and the MEMORY.md index that Claude reads
// at the start of every session. Create, edit and delete keep the index in step.
import { useMemo, useState } from 'preact/hooks';
import { BookText, Plus, Search, Trash2 } from 'lucide-preact';
import { toast } from '../../actions.js';
import { MEMORY_TYPES, addIndexLine, composeMemory, memoryTitle } from '../../../server/memory-format.mjs';
import { joinEol, memoryNameProblem, memoryStem, savedText, splitEol } from '../../lib/settings.js';
import { settingsApi } from '../../lib/settingsApi.js';
import { useAppState } from '../../state.js';
import { useRemote, useSettings } from './hooks.js';
import { EditorShell, Loading, LoadFailed, Notice, shortPath } from './parts.jsx';
import { MarkdownField, TextFileEditor } from './fields.jsx';
import { SplitView } from './SplitView.jsx';

const INDEX = 'MEMORY.md';

export function MemoryTab() {
  const { cwd, cluster, guard } = useSettings();
  const list = useRemote(() => settingsApi.memories(cwd, cluster), [cluster, cwd]);
  // Which one is open: 'index', 'new' or a file name.
  const [selected, setSelected] = useState(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');

  if (!cwd) return <Notice>Open a chat or choose a project folder above to see its memory.</Notice>;
  if (list.error) return <LoadFailed message={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const { files, index, missing } = list.data;
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? files.filter((file) => [file.name, file.frontmatter?.name, file.frontmatter?.description, file.frontmatter?.type].some((value) => String(value || '').toLowerCase().includes(needle)))
    : files;

  const choose = (next) => guard(() => {
    setSelected(next);
    setOpen(true);
  });

  const listView = (
    <>
      <div class="memory-tools">
        <label class="memory-search">
          <Search size={14} aria-hidden="true" />
          <input type="search" class="input" placeholder="Search memories" aria-label="Search memories" value={filter} onInput={(event) => setFilter(event.currentTarget.value)} />
        </label>
        <button type="button" class="btn btn-sm btn-secondary" onClick={() => choose('new')}>
          <Plus size={14} />
          New
        </button>
      </div>
      <ul class="split-items">
        <li>
          <button type="button" class={`split-item ${selected === 'index' ? 'is-selected' : ''}`} onClick={() => choose('index')} aria-current={selected === 'index' ? 'true' : undefined}>
            <BookText size={15} aria-hidden="true" />
            <span class="split-item-text">
              <span class="split-item-title">
                <span class="split-item-name">{INDEX}</span>
              </span>
              <span class="split-item-sub">{index.exists ? `Index · ${index.lines.length} ${index.lines.length === 1 ? 'entry' : 'entries'}` : 'Not created yet'}</span>
            </span>
          </button>
        </li>
        {shown.map((file) => (
          <li key={file.name}>
            <button
              type="button"
              class={`split-item memory-item ${selected === file.name ? 'is-selected' : ''}`}
              onClick={() => choose(file.name)}
              aria-current={selected === file.name ? 'true' : undefined}
              title={file.name}
              disabled={!!file.error}
            >
              <span class="split-item-text">
                <span class="split-item-title">
                  <span class="split-item-name">{file.frontmatter?.name || file.name.replace(/\.md$/, '')}</span>
                  {file.frontmatter?.type && <span class="settings-chip">{file.frontmatter.type}</span>}
                  {!file.inIndex && !file.error && <span class="settings-chip is-warn">Not in index</span>}
                </span>
                <span class="split-item-sub memory-desc">{file.error || file.frontmatter?.description || file.name}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {!files.length && <p class="settings-note memory-empty">{list.data.exists ? 'No memory files yet.' : 'This project has no memory yet. New creates the first one.'}</p>}
      {files.length > 0 && !shown.length && <p class="settings-note memory-empty">No memory matches “{filter}”.</p>}
    </>
  );

  const closeDetail = () => {
    setSelected(null);
    setOpen(false);
  };
  const changed = () => list.reload();

  return (
    <SplitView open={open} onBack={() => guard(() => setOpen(false))} backLabel="Memories" list={listView}>
      {selected === 'index' ? (
        <MemoryIndex key={`index:${index.version}`} index={index} dir={list.data.dir} missing={missing} cwd={cwd} cluster={cluster} onChanged={changed} />
      ) : selected === 'new' ? (
        <NewMemory key="new" cwd={cwd} cluster={cluster} existing={files.map((file) => file.name)} onCreated={(name) => { changed(); setSelected(name); }} onOpen={(name) => setSelected(name)} />
      ) : selected ? (
        <MemoryFile key={selected} name={selected} cwd={cwd} cluster={cluster} index={index} inIndex={files.find((file) => file.name === selected)?.inIndex} onChanged={changed} onDeleted={() => { changed(); closeDetail(); }} />
      ) : (
        <div class="memory-placeholder">
          <p class="settings-note">
            Claude Code keeps notes about this project between sessions. Pick one to read or edit it, or create a new one. Claude reads <code>{INDEX}</code> at the start of every session and opens the files it
            lists when they matter.
          </p>
        </div>
      )}
    </SplitView>
  );
}

/** The MEMORY.md index as a Markdown file; the list reloads after a save (remounting this on the new version). */
function MemoryIndex({ index, dir, missing, cwd, cluster, onChanged }) {
  const home = useAppState((s) => s.info?.root);
  const [file, setFile] = useState({ ...index, scope: 'memory', id: INDEX, name: INDEX, path: `${dir}/${INDEX}` });
  const saved = (view) => {
    setFile((previous) => ({ ...previous, ...view }));
    onChanged();
  };
  return (
    <div class="settings-pane">
      <div class="detail-head">
        <h3 class="detail-title">{INDEX}</h3>
        <p class="settings-path">
          <code title={file.path}>{shortPath(file.path, home)}</code>
          {!file.exists && <span class="settings-chip">Not created yet</span>}
        </p>
        <p class="settings-note">
          One line per memory: <code>- [Title](file.md) — hook</code>. Claude reads this file at the start of every session, so keep it short.
        </p>
      </div>
      {missing.length > 0 && (
        <Notice tone="warning">
          {missing.length === 1 ? 'One line points' : `${missing.length} lines point`} to a file that does not exist: {missing.map((line) => line.file).join(', ')}.
        </Notice>
      )}
      <TextFileEditor
        key={file.version}
        file={file}
        label="Index"
        save={(content, version) => settingsApi.putMemory(INDEX, { cwd, content, version }, cluster)}
        onSaved={saved}
        onReload={saved}
      />
    </div>
  );
}

function MemoryFile({ name, cwd, cluster, index, inIndex, onChanged, onDeleted }) {
  const home = useAppState((s) => s.info?.root);
  const remote = useRemote(() => settingsApi.memory(cwd, name, cluster), [cluster, cwd, name]);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const file = remote.data;
  if (remote.error) return <LoadFailed message={remote.error} onRetry={remote.reload} />;
  if (!file) return <Loading />;

  const saved = (result) => {
    remote.set(result);
    onChanged();
  };
  const remove = async () => {
    setBusy(true);
    setProblem('');
    try {
      const result = await settingsApi.deleteMemory(cwd, name, file.version, cluster);
      toast(savedText({ changed: true, restartsPending: result.restartsPending }, { verb: 'Deleted' }));
      onDeleted();
    } catch (error) {
      setProblem(error.status === 409 ? 'This memory changed on disk since you opened it. Reload it to see the new version, then delete again if you still want to.' : error.message);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };
  const addToIndex = async () => {
    setBusy(true);
    setProblem('');
    try {
      const entry = { title: memoryTitle(file.name, file.frontmatter), file: file.name, hook: file.frontmatter.description };
      const result = await settingsApi.putMemory(INDEX, { cwd, content: addIndexLine(index.content, entry), version: index.exists ? index.version : null }, cluster);
      toast(savedText(result));
      onChanged();
    } catch (error) {
      setProblem(error.status === 409 ? 'MEMORY.md changed on disk. Open it from the list to see the new version, then add the line there.' : error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="settings-pane">
      <div class="detail-head">
        <div class="detail-title-row">
          <h3 class="detail-title">{file.frontmatter.name || file.name}</h3>
          {confirming ? (
            <span class="detail-confirm" role="group" aria-label="Confirm delete">
              <span>Delete {file.name}?</span>
              <button type="button" class="btn btn-sm btn-ghost" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
              <button type="button" class="btn btn-sm btn-danger" onClick={remove} disabled={busy}>
                Delete
              </button>
            </span>
          ) : (
            <button type="button" class="btn btn-sm btn-ghost" onClick={() => setConfirming(true)}>
              <Trash2 size={14} />
              Delete
            </button>
          )}
        </div>
        <p class="settings-path">
          <code title={file.path}>{shortPath(file.path, home)}</code>
          {inIndex === false && (
            <>
              <span class="settings-chip is-warn">Not in MEMORY.md</span>
              <button type="button" class="btn btn-sm btn-ghost" onClick={addToIndex} disabled={busy}>
                Add to index
              </button>
            </>
          )}
        </p>
        {confirming && <p class="settings-note">The file and its line in MEMORY.md go; a copy stays in Harbor's settings backups.</p>}
      </div>
      {problem && <Notice tone="error">{problem}</Notice>}
      <MemoryForm key={file.version} file={file} cwd={cwd} cluster={cluster} onSaved={saved} onReload={saved} />
    </div>
  );
}

const TYPE_OPTIONS = (current) => [...new Set(['', ...MEMORY_TYPES, current])].filter((value) => value !== undefined);

/** Frontmatter fields and the body of an existing memory; the file text is composed from them. */
function MemoryForm({ file, cwd, cluster, onSaved, onReload }) {
  const original = useMemo(() => ({ ...file.frontmatter, body: splitEol(file.body).text, eol: splitEol(file.content).eol }), [file]);
  const [name, setName] = useState(original.name);
  const [description, setDescription] = useState(original.description);
  const [type, setType] = useState(original.type);
  const [body, setBody] = useState(original.body);
  const dirty = name !== original.name || description !== original.description || type !== original.type || body !== original.body;
  // Only the fields that changed are rewritten; every other frontmatter line stays as it was.
  const composed = useMemo(
    () =>
      composeMemory(file.content, {
        name: name !== original.name ? name : undefined,
        description: description !== original.description ? description : undefined,
        type: type !== original.type ? type : undefined,
        body: body !== original.body ? joinEol(body, original.eol) : undefined,
      }),
    [file, name, description, type, body],
  );

  return (
    <EditorShell
      file={file}
      textOf={(view) => splitEol(view.content).text}
      text={splitEol(composed).text}
      dirty={dirty}
      live
      save={(version) => settingsApi.putMemory(file.name, { cwd, content: composed, version }, cluster)}
      onSaved={onSaved}
      onReload={onReload}
      onRevert={() => {
        setName(original.name);
        setDescription(original.description);
        setType(original.type);
        setBody(original.body);
      }}
    >
      <div class="memory-fields">
        <div class="field">
          <label class="settings-label" for="memory-name">
            Name
          </label>
          <input id="memory-name" class="input" value={name} onInput={(event) => setName(event.currentTarget.value)} autocomplete="off" />
        </div>
        <div class="field field-type">
          <label class="settings-label" for="memory-type">
            Type
          </label>
          <select id="memory-type" class="input" value={type} onChange={(event) => setType(event.currentTarget.value)}>
            {TYPE_OPTIONS(original.type).map((value) => (
              <option key={value} value={value}>
                {value || 'None'}
              </option>
            ))}
          </select>
        </div>
        <div class="field field-wide">
          <label class="settings-label" for="memory-description">
            Description
          </label>
          <input id="memory-description" class="input" value={description} onInput={(event) => setDescription(event.currentTarget.value)} autocomplete="off" placeholder="One line: what this memory is for" />
        </div>
      </div>
      <MarkdownField id="memory-body" label="Memory" value={body} onInput={setBody} rows={12} fill />
    </EditorShell>
  );
}

/** The form for a new memory: file name, frontmatter and body; it also adds the MEMORY.md line. */
function NewMemory({ cwd, cluster, existing, onCreated, onOpen }) {
  const [title, setTitle] = useState('');
  const [stem, setStem] = useState('');
  const [stemEdited, setStemEdited] = useState(false);
  const [type, setType] = useState('project');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const shownStem = stemEdited ? stem : memoryStem(title);
  const nameProblem = shownStem ? memoryNameProblem(shownStem, existing) : null;
  const dirty = !!(title || stem || description || body);
  const content = composeMemory('', { name: title || shownStem, description, type, body: body ? (body.endsWith('\n') ? body : body + '\n') : '' });
  const file = { path: `${shownStem || 'new-memory'}.md`, version: null, exists: false };

  return (
    <div class="settings-pane">
      <div class="detail-head">
        <h3 class="detail-title">New memory</h3>
        <p class="settings-note">Saved as a file in this project's memory folder, with a line added to MEMORY.md so Claude finds it.</p>
      </div>
      <EditorShell
        file={file}
        textOf={(view) => splitEol(view.content ?? '').text}
        text={splitEol(content).text}
        dirty={dirty}
        problem={dirty ? nameProblem : null}
        review={false}
        live
        saveLabel="Create memory"
        save={() => settingsApi.putMemory(`${shownStem}.md`, { cwd, content, version: null }, cluster)}
        onSaved={() => onCreated(`${shownStem}.md`)}
        onReload={(disk) => onOpen(disk.name || `${shownStem}.md`)}
        onRevert={() => {
          setTitle('');
          setStem('');
          setStemEdited(false);
          setDescription('');
          setBody('');
        }}
      >
        <div class="memory-fields">
          <div class="field">
            <label class="settings-label" for="new-memory-title">
              Name
            </label>
            <input id="new-memory-title" class="input" value={title} onInput={(event) => setTitle(event.currentTarget.value)} autocomplete="off" placeholder="Release checklist" />
          </div>
          <div class="field field-type">
            <label class="settings-label" for="new-memory-type">
              Type
            </label>
            <select id="new-memory-type" class="input" value={type} onChange={(event) => setType(event.currentTarget.value)}>
              {MEMORY_TYPES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <div class="field field-wide">
            <label class="settings-label" for="new-memory-file">
              File
            </label>
            <div class="file-name-field">
              <input
                id="new-memory-file"
                class="input mono"
                value={shownStem}
                onInput={(event) => {
                  setStem(event.currentTarget.value);
                  setStemEdited(true);
                }}
                aria-invalid={dirty && nameProblem ? 'true' : undefined}
                spellcheck={false}
                autocomplete="off"
                autocapitalize="off"
                placeholder="release-checklist"
              />
              <span class="file-name-ext">.md</span>
            </div>
          </div>
          <div class="field field-wide">
            <label class="settings-label" for="new-memory-description">
              Description
            </label>
            <input
              id="new-memory-description"
              class="input"
              value={description}
              onInput={(event) => setDescription(event.currentTarget.value)}
              autocomplete="off"
              placeholder="One line: what this memory is for"
            />
          </div>
        </div>
        <MarkdownField id="new-memory-body" label="Memory" value={body} onInput={setBody} rows={10} fill />
      </EditorShell>
    </div>
  );
}
