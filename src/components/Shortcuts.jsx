// Keyboard shortcuts reference (`?`, the palette, or /help).
import { closeDialog } from '../actions.js';
import { SHORTCUT_GROUPS } from '../lib/shortcuts.js';
import { Dialog } from './Dialog.jsx';
import { Keys } from './Keys.jsx';
import './Shortcuts.css';

export function ShortcutsDialog() {
  return (
    <Dialog title="Keyboard shortcuts" subtitle="Press ? anywhere outside a text box to open this list." onClose={closeDialog} class="shortcuts-dialog" initialFocus=".shortcut-groups">
      {/* Focus lands on the list (not the close button) so arrow keys scroll it. */}
      <div class="shortcut-groups" tabIndex={-1}>
        {SHORTCUT_GROUPS.map((group) => (
          <section class="shortcut-group" key={group.title} aria-label={group.title}>
            <h3 class="eyebrow">{group.title}</h3>
            <dl>
              {group.items.map((item) => (
                <div class="shortcut-row" key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>
                    <Keys keys={item.keys} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
