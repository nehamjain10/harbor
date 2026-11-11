// A page Claude published to claude.ai with the Artifact tool: its name, what it is,
// and a link that opens it in a new tab. Artifacts start private to their owner.
import { AppWindow, ExternalLink } from 'lucide-preact';
import { artifactLink, artifactTitle } from '../lib/tools.js';
import { CopyButton } from './tools/shared.jsx';
import './ArtifactCard.css';

export function ArtifactCard({ message }) {
  const url = artifactLink(message);
  const title = artifactTitle(message);
  const input = message.input || {};
  const what = input.url ? 'Updated artifact' : 'Artifact';
  return (
    <div class="artifact-card">
      <a class="artifact-card-main" href={url} target="_blank" rel="noopener noreferrer" title={url}>
        <span class="artifact-card-icon">
          <AppWindow size={18} />
        </span>
        <span class="artifact-card-text">
          <span class="artifact-card-title">{title}</span>
          <span class="artifact-card-sub">{input.description ? `${what} · ${input.description}` : `${what} on claude.ai`}</span>
        </span>
        <span class="artifact-card-open">
          Open
          <ExternalLink size={13} />
        </span>
      </a>
      <CopyButton text={url} label="Copy link" class="artifact-card-copy" />
    </div>
  );
}
