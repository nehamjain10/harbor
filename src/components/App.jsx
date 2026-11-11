import { useEffect } from 'preact/hooks';
import { LucideProvider } from 'lucide-preact';
import { closeAgent, closeDrawer, closePanel, shownAgent } from '../actions.js';
import { useGlobalShortcuts } from '../hotkeys.js';
import { isTextEntry } from '../lib/keys.js';
import { shallowEqual, store, useAppState } from '../state.js';
import { ComposerArea } from './Composer.jsx';
import { DropZone } from './composer/DropZone.jsx';
import { HelpDialog } from './composer/HelpDialog.jsx';
import { Lightbox } from './composer/Lightbox.jsx';
import { EmptyStarters, EmptyState } from './EmptyState.jsx';
import { ImportDialog } from './ImportDialog.jsx';
import { AgentsDialog } from './AgentsDialog.jsx';
import { McpDialog } from './McpPanel.jsx';
import { Palette } from './Palette.jsx';
import { ProjectDialog } from './ProjectDialog.jsx';
import { RenameDialog } from './RenameDialog.jsx';
import { RewindDialog } from './RewindDialog.jsx';
import { SessionOptions } from './SessionOptions.jsx';
import { SettingsDialog } from './SettingsDialog.jsx';
import { ShortcutsDialog } from './Shortcuts.jsx';
import { SidePanel } from './SidePanel.jsx';
import { Sidebar } from './Sidebar.jsx';
import { Toast } from './Toast.jsx';
import { Topbar } from './Topbar.jsx';
import { Transcript } from './Transcript.jsx';
import './App.css';

function useShortcuts() {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        const state = store.get();
        if (state.drawerOpen) closeDrawer();
        else if (shownAgent(state) && closesAgent(state, event)) {
          // Handled: the composer's Esc (stop the turn) waits for the next press.
          event.preventDefault();
          closeAgent();
        } else if (state.panel.open && globalThis.matchMedia?.('(max-width: 1023px)').matches) closePanel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

// Esc closes the agent view unless a dialog is open or the key belongs to a text field
// (the composer's own excepted).
function closesAgent(state, event) {
  if (state.dialog || state.lightbox || document.querySelector('dialog[open]')) return false;
  return !isTextEntry(event.target) || event.target.classList.contains('composer-input');
}

function Dialogs() {
  const dialog = useAppState((s) => s.dialog);
  if (!dialog) return null;
  if (dialog.type === 'project') return <ProjectDialog />;
  if (dialog.type === 'rename') return <RenameDialog id={dialog.id} />;
  if (dialog.type === 'rewind') return <RewindDialog sessionId={dialog.sessionId} messageId={dialog.messageId} />;
  if (dialog.type === 'options') return <SessionOptions id={dialog.id} />;
  if (dialog.type === 'palette') return <Palette page={dialog.page} />;
  if (dialog.type === 'shortcuts') return <ShortcutsDialog />;
  if (dialog.type === 'help') return <HelpDialog />;
  if (dialog.type === 'import') return <ImportDialog />;
  if (dialog.type === 'agents') return <AgentsDialog />;
  if (dialog.type === 'settings') return <SettingsDialog tab={dialog.tab} />;
  if (dialog.type === 'mcp') return <McpDialog sessionId={dialog.sessionId} />;
  return null;
}

export function App() {
  const { hasSession, loading, switching, collapsed, drawerOpen } = useAppState(
    (s) => ({
      hasSession: !!s.current,
      // Avoid flashing the empty state while the requested session loads.
      loading: !s.current && (!!s.loadingSessionId || (s.booting && !s.bootError)),
      // Another session is on its way: the one still shown is dimmed meanwhile.
      switching: !!s.current && !!s.loadingSessionId && s.loadingSessionId !== s.current.id,
      collapsed: s.sidebarCollapsed,
      drawerOpen: s.drawerOpen,
    }),
    shallowEqual,
  );
  useShortcuts();
  useGlobalShortcuts();

  return (
    <LucideProvider size={16} strokeWidth={1.75}>
      <div class={`app ${collapsed ? 'sidebar-collapsed' : ''} ${drawerOpen ? 'drawer-open' : ''}`}>
        <div class="sidebar-slot" inert={collapsed && !drawerOpen ? true : undefined}>
          <Sidebar />
        </div>
        <div class="drawer-scrim" onClick={closeDrawer} aria-hidden="true" />
        <main class={`main ${switching ? 'is-switching' : ''} ${!hasSession && !loading ? 'is-new' : ''}`} aria-busy={switching ? 'true' : undefined}>
          <Topbar />
          {hasSession ? <Transcript /> : loading ? <div class="main-loading" /> : <EmptyState />}
          <ComposerArea />
          {!hasSession && !loading && <EmptyStarters />}
          <DropZone />
        </main>
        <SidePanel />
      </div>
      <Dialogs />
      <Lightbox />
      <Toast />
    </LucideProvider>
  );
}
