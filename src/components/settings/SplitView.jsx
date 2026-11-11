// A list on the left and its detail on the right; on a phone one at a time, with a back
// button on the detail.
import { ChevronLeft } from 'lucide-preact';

export function SplitView({ open, onBack, backLabel, list, children }) {
  return (
    <div class={`split-view ${open ? 'has-detail' : ''}`}>
      <div class="split-list">{list}</div>
      <div class="split-detail">
        <button type="button" class="btn btn-sm btn-ghost split-back" onClick={onBack}>
          <ChevronLeft size={14} />
          {backLabel}
        </button>
        {children}
      </div>
    </div>
  );
}
