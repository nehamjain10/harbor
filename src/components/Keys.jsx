// A key combination as <kbd> chips, labelled for the platform (⌘ ⇧ O / Ctrl Shift O).
import { keyLabels } from '../lib/shortcuts.js';

export function Keys({ keys, class: className = '' }) {
  return (
    <span class={`keys ${className}`}>
      {keyLabels(keys).map((label, i) => (
        <kbd key={i}>{label}</kbd>
      ))}
    </span>
  );
}
