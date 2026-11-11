// Keyboard shortcut catalog: the single list the shortcuts dialog, the palette
// hints and the global key handler agree on. Keys use `mod` for ⌘ on Apple
// platforms and Ctrl elsewhere.

export const SHORTCUTS = {
  palette: { label: 'Command palette', keys: ['mod', 'K'] },
  newSession: { label: 'New session', keys: ['mod', 'shift', 'O'] },
  sidebar: { label: 'Toggle sidebar', keys: ['mod', 'B'] },
  panel: { label: 'Toggle side panel', keys: ['mod', 'J'] },
  help: { label: 'Keyboard shortcuts', keys: ['?'] },
};

export const SHORTCUT_GROUPS = [
  {
    title: 'General',
    items: [
      SHORTCUTS.palette,
      SHORTCUTS.newSession,
      SHORTCUTS.sidebar,
      SHORTCUTS.panel,
      SHORTCUTS.help,
      { label: 'Close a dialog, menu or the drawer', keys: ['Esc'] },
    ],
  },
  {
    title: 'Composer',
    items: [
      { label: 'Send message (while Claude works: it reads it at its next step)', keys: ['Enter'] },
      { label: 'Queue for after the running turn', keys: ['alt', 'Enter'] },
      { label: 'New line', keys: ['shift', 'Enter'] },
      { label: 'Send, even on a phone keyboard', keys: ['mod', 'Enter'] },
      { label: 'Mention a file', keys: ['@'] },
      { label: 'Commands and skills', keys: ['/'] },
      { label: 'Edit the last message (empty composer)', keys: ['↑'] },
      { label: 'Stop the running turn', keys: ['Esc', 'Esc'] },
    ],
  },
  {
    title: 'Approvals',
    items: [
      { label: 'Allow once', keys: ['1'] },
      { label: 'Always allow', keys: ['2'] },
      { label: 'Deny', keys: ['3'] },
    ],
  },
  {
    title: 'Command palette',
    items: [
      { label: 'Move through results', keys: ['↑', '↓'] },
      { label: 'Run the highlighted item', keys: ['Enter'] },
      { label: 'Back from a sub-menu', keys: ['⌫'] },
    ],
  },
];

export const isApple = () => /Mac|iPhone|iPad|iPod/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');

const NAMES = {
  apple: { mod: '⌘', shift: '⇧', alt: '⌥', Enter: '↵', Esc: 'esc' },
  other: { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', Enter: 'Enter', Esc: 'Esc' },
};

// ['mod', 'shift', 'O'] → ['⌘', '⇧', 'O'] on Apple, ['Ctrl', 'Shift', 'O'] elsewhere.
export function keyLabels(keys, apple = isApple()) {
  const names = apple ? NAMES.apple : NAMES.other;
  return keys.map((key) => names[key] || key);
}

// One string for tooltips: "⌘⇧O" or "Ctrl+Shift+O".
export function shortcutText(keys, apple = isApple()) {
  return keyLabels(keys, apple).join(apple ? '' : '+');
}

// True when keyboard focus is somewhere text is typed.
export function isTyping(target) {
  if (!target || target === globalThis.document?.body) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(target.type);
}

// Maps a keydown event to a shortcut id (palette | newSession | sidebar | panel |
// help) or null.
export function matchShortcut(event, apple = isApple()) {
  // On Apple platforms Ctrl+K / Ctrl+B are text-editing keys; only Cmd is the modifier.
  const mod = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  const key = String(event.key || '').toLowerCase();
  if (mod && !event.altKey) {
    if (key === 'k' && !event.shiftKey) return 'palette';
    if (key === 'o' && event.shiftKey) return 'newSession';
    if (key === 'b' && !event.shiftKey) return 'sidebar';
    if (key === 'j' && !event.shiftKey) return 'panel';
    return null;
  }
  if (event.key === '?' && !mod && !event.altKey && !isTyping(event.target)) return 'help';
  return null;
}
