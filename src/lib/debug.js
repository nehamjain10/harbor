// Opt-in render counters for performance checks. Enable with
// localStorage['mesh-code-debug-renders'] = '1' (or ?debug=renders) and read
// window.__harborRenders; reset it by assigning {}.
let enabled = false;
try {
  enabled = globalThis.localStorage?.getItem('mesh-code-debug-renders') === '1' || /[?&]debug=renders\b/.test(globalThis.location?.search || '');
} catch {
  enabled = false;
}
if (enabled) globalThis.__harborRenders = {};

export function countRender(name) {
  if (!enabled) return;
  const counts = (globalThis.__harborRenders ||= {});
  counts[name] = (counts[name] || 0) + 1;
}
