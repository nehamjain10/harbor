// The tabs of the settings dialog, in the order they show.
//
// ADDING A TAB: write its component (it reads the project folder and the leave guard
// with useSettings() from ./hooks.js, and wraps anything editable in EditorShell so unsaved
// changes are guarded and a file that changed on disk is handled), then add one entry
// below. Nothing else in the dialog changes.
import { Brain, Cpu, FileText, Plug, ShieldCheck, Webhook } from 'lucide-preact';
import { HooksTab } from './HooksTab.jsx';
import { InstructionsTab } from './InstructionsTab.jsx';
import { McpTab } from './McpTab.jsx';
import { MemoryTab } from './MemoryTab.jsx';
import { ModelsTab } from './ModelsTab.jsx';
import { PermissionsTab } from './PermissionsTab.jsx';

export const SETTINGS_TABS = [
  { id: 'permissions', label: 'Permissions', icon: ShieldCheck, Panel: PermissionsTab },
  { id: 'hooks', label: 'Hooks', icon: Webhook, Panel: HooksTab },
  { id: 'instructions', label: 'CLAUDE.md', icon: FileText, Panel: InstructionsTab },
  { id: 'memory', label: 'Memory', icon: Brain, Panel: MemoryTab },
  { id: 'mcp', label: 'MCP servers', icon: Plug, Panel: McpTab },
  { id: 'models', label: 'Models', icon: Cpu, Panel: ModelsTab },
];
