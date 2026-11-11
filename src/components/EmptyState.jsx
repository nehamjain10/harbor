// A new session, as in the Claude apps: a greeting and the project above the composer,
// which sits in the middle of the page, and starters under it. The two halves render
// on either side of the composer (App.jsx).
import { Bug, ChevronDown, Compass, Folder, GitCompare, Sparkles } from 'lucide-preact';
import { chooseProject, openDialog, presetComposer } from '../actions.js';
import { shallowEqual, useAppState } from '../state.js';
import { basename } from '../lib/format.js';
import { findCluster, isRemote } from '../lib/clusters.js';
import { recentProjects } from '../lib/sessions.js';
import { BrandMark } from './BrandMark.jsx';
import './EmptyState.css';

const STARTERS = [
  {
    icon: Compass,
    title: 'Explore a project',
    prompt: 'Explore this project and explain its structure. Suggest where we should start.',
  },
  {
    icon: Sparkles,
    title: 'Build something new',
    prompt: 'Help me build a new feature. First ask me what I have in mind.',
  },
  {
    icon: Bug,
    title: 'Fix a bug',
    prompt: 'Help me track down a bug. Ask me for the symptoms, then investigate before changing any code.',
  },
  {
    icon: GitCompare,
    title: 'Review changes',
    prompt: 'Review the uncommitted changes in this project. Point out bugs, risks and anything unfinished.',
  },
];

export function greeting(hour = new Date().getHours()) {
  if (hour < 5) return 'Up late?';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function EmptyState() {
  const { project, cluster, clusters } = useAppState(
    (s) => ({ project: s.project, cluster: s.cluster, clusters: s.clusters }),
    shallowEqual,
  );
  // A remote cluster says where the chat runs; the folder is that cluster's own path.
  const chosen = findCluster(clusters, cluster);
  const remote = isRemote(chosen);
  return (
    <div class="empty">
      <div class="empty-inner">
        <h1 class="empty-title">
          <BrandMark size={30} class="empty-mark" />
          {greeting()}
        </h1>
        <p class="empty-sub">
          <span>{remote ? 'Claude Code on' : 'Claude Code in'}</span>
          {remote && <span class="empty-cluster">{chosen.label}</span>}
          {remote && <span>in</span>}
          <button type="button" class="project-chip" onClick={() => openDialog('project')} title={project}>
            <Folder size={14} />
            <span class="project-chip-name">{basename(project, 'Choose a project')}</span>
            <ChevronDown size={13} />
          </button>
        </p>
      </div>
    </div>
  );
}

// Under the composer: starters, then other recent projects.
export function EmptyStarters() {
  const { project, sessions } = useAppState((s) => ({ project: s.project, sessions: s.sessions }), shallowEqual);
  const recent = recentProjects(sessions, 5).filter((p) => p !== project).slice(0, 4);
  return (
    <div class="empty-after">
      <div class="starter-row">
        {STARTERS.map(({ icon: Icon, title, prompt }) => (
          <button type="button" class="starter" key={title} onClick={() => presetComposer(prompt)}>
            <Icon size={15} />
            <span class="starter-title">{title}</span>
          </button>
        ))}
      </div>
      {recent.length > 0 && (
        <div class="recent-projects">
          <span class="recent-label">Recent projects</span>
          {recent.map((path) => (
            <button type="button" class="recent-chip" key={path} onClick={() => chooseProject(path)} title={path}>
              {basename(path)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
