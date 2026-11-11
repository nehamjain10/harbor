// Line counts of a change ("+3 −1"). A zero count is left out: a new file shows "+3",
// a change that only removes lines "−4", and a change without line counts nothing.
export function DiffStats({ adds = 0, dels = 0, class: className = 'tool-stats' }) {
  if (!(adds > 0) && !(dels > 0)) return null;
  return (
    <span class={className}>
      {adds > 0 && <span class="stat-adds">+{adds}</span>}
      {adds > 0 && dels > 0 && ' '}
      {dels > 0 && <span class="stat-dels">−{dels}</span>}
    </span>
  );
}
