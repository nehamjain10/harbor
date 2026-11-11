// A small chip naming the cluster a session's agent runs on. The local cluster has no
// badge (every session used to be local), so this shows nothing for it.
import { clusterLabel } from '../lib/clusters.js';
import './ClusterBadge.css';

export function ClusterBadge({ clusters, cluster, class: className = '' }) {
  const label = clusterLabel(clusters, cluster);
  if (!label) return null;
  return (
    <span class={`cluster-badge ${className}`} title={`Runs on ${label}`}>
      {label}
    </span>
  );
}
