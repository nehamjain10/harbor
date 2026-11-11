// App-wide keyboard shortcuts (see lib/shortcuts.js for the catalog). Esc stays
// with the component that owns whatever it closes.
import { useEffect } from 'preact/hooks';
import { closeDialog, newSession, openDialog, togglePanel, toggleSidebar } from './actions.js';
import { store } from './state.js';
import { matchShortcut } from './lib/shortcuts.js';

export function togglePalette(page) {
  if (store.get().dialog?.type === 'palette') closeDialog();
  else openDialog('palette', page ? { page } : {});
}

function onKeyDown(event) {
  // keyCode 229: Safari sends the IME-confirming Enter after compositionend.
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  const shortcut = matchShortcut(event);
  if (!shortcut) return;
  const { dialog, current } = store.get();
  switch (shortcut) {
    case 'palette':
      event.preventDefault();
      togglePalette();
      break;
    case 'newSession':
      event.preventDefault();
      if (dialog) closeDialog();
      newSession();
      break;
    case 'sidebar':
      event.preventDefault();
      toggleSidebar();
      break;
    case 'panel':
      event.preventDefault();
      if (current) togglePanel();
      break;
    case 'help':
      if (dialog) return;
      event.preventDefault();
      openDialog('shortcuts');
      break;
  }
}

export function useGlobalShortcuts() {
  useEffect(() => {
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}
