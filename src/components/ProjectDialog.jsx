import { useEffect, useState } from 'preact/hooks';
import { ArrowRight, ChevronRight, CornerLeftUp, Folder, FolderGit2, Server } from 'lucide-preact';
import { chooseProject, closeDialog, listProjects } from '../actions.js';
import { useAppState } from '../state.js';
import { basename } from '../lib/format.js';
import { findCluster, isRemote } from '../lib/clusters.js';
import { Dialog } from './Dialog.jsx';
import './ProjectDialog.css';

export function ProjectDialog() {
  const { project, root, clusters, cluster } = useAppState(
    (s) => ({ project: s.project, root: s.info?.root, clusters: s.clusters, cluster: s.cluster }),
    (a, b) => a.project === b.project && a.root === b.root && a.clusters === b.clusters && a.cluster === b.cluster,
  );
  // A remote cluster's folders cannot be listed here (only this server's disks are
  // browsable), so its folder is typed in full, starting from the cluster's home.
  const chosen = findCluster(clusters, cluster);
  const remote = isRemote(chosen);
  const [listing, setListing] = useState(null);
  const [path, setPath] = useState(project || (remote ? chosen.home || '' : root) || '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async (target) => {
    setLoading(true);
    setError('');
    try {
      const data = await listProjects(target);
      setListing(data);
      setPath(data.path);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!remote) load(project || root || '');
  }, []);

  const use = () => {
    const target = remote ? path.trim() : listing?.path;
    if (!target) return;
    chooseProject(target);
    closeDialog();
  };
  const folder = remote ? path.trim() : listing?.path || '';

  return (
    <Dialog
      title={remote ? `Folder on ${chosen.label}` : 'Choose a project'}
      eyebrow={remote ? 'Remote cluster' : 'Workspace'}
      subtitle={remote ? `${chosen.host ? `${chosen.host} · ` : ''}type the folder's path on ${chosen.label}; folders are not listed for a remote cluster.` : undefined}
      onClose={closeDialog}
      class="project-dialog"
      initialFocus={remote ? '.project-path .input' : undefined}
      footer={
        <>
          <span class="project-selected" title={folder}>
            <Folder size={14} />
            {folder ? basename(folder) : '…'}
          </span>
          <span class="spacer" />
          <button type="button" class="btn btn-ghost" onClick={closeDialog}>
            Cancel
          </button>
          <button type="button" class="btn btn-primary" onClick={use} disabled={!folder}>
            Use this folder
          </button>
        </>
      }
    >
      <form
        class="project-path"
        onSubmit={(event) => {
          event.preventDefault();
          if (!remote) load(path);
        }}
      >
        <input
          class="input mono"
          value={path}
          onInput={(e) => setPath(e.currentTarget.value)}
          aria-label={remote ? `Folder path on ${chosen.label}` : 'Project directory'}
          placeholder={remote ? chosen.home || '/path/on/the/cluster' : undefined}
          spellcheck={false}
          autocomplete="off"
        />
        {!remote && (
          <button type="submit" class="icon-btn" aria-label="Open folder" title="Open folder">
            <ArrowRight />
          </button>
        )}
      </form>
      {error && !remote && <p class="project-error">{error}</p>}
      {remote && (
        <p class="project-remote-note">
          <Server size={13} />
          The agent runs on {chosen.label}
          {chosen.home ? `, where this folder usually lives under ${chosen.home}.` : '.'}
        </p>
      )}
      {!remote && (
        <div class={`project-folders ${loading ? 'is-loading' : ''}`}>
          {listing?.parent && (
            <button type="button" class="folder-row" onClick={() => load(listing.parent)}>
              <CornerLeftUp size={16} />
              <span class="folder-name">Parent folder</span>
            </button>
          )}
          {listing?.items?.map((item) => (
            <button type="button" class="folder-row" key={item.path} onClick={() => load(item.path)}>
              {item.git ? <FolderGit2 size={16} class="folder-git" /> : <Folder size={16} />}
              <span class="folder-name">{item.name}</span>
              {item.git && <span class="git-badge">git</span>}
              <ChevronRight size={14} class="folder-chevron" />
            </button>
          ))}
          {listing && !listing.items?.length && <p class="project-empty">No subfolders here.</p>}
        </div>
      )}
    </Dialog>
  );
}
