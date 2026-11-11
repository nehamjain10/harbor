// `/help`: keyboard shortcuts and the slash commands available in this project.
import { useEffect, useState } from 'preact/hooks';
import { closeDialog } from '../../actions.js';
import { cachedCommands, commandScope, loadCommands } from '../../composer.js';
import { COMMAND_GROUPS, mergeCommands } from '../../lib/commands.js';
import { SHORTCUT_GROUPS } from '../../lib/shortcuts.js';
import { Dialog } from '../Dialog.jsx';
import { Keys } from '../Keys.jsx';
import './composer.css';

export function HelpDialog() {
  const scope = commandScope();
  const [commands, setCommands] = useState(() => cachedCommands(scope) || mergeCommands([]));

  useEffect(() => {
    let live = true;
    loadCommands(scope).then(
      (list) => live && setCommands(list),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [scope]);

  return (
    <Dialog title="Shortcuts and commands" eyebrow="Help" onClose={closeDialog} class="help-dialog">
      {/* Same catalog as the ? shortcuts dialog and the global key handler. */}
      {SHORTCUT_GROUPS.map((group) => (
        <div class="help-section" key={group.title}>
          <div class="eyebrow">{group.title}</div>
          <dl class="help-keys">
            {group.items.map((item) => (
              <div class="help-key-row" key={item.label}>
                <dt>
                  <Keys keys={item.keys} />
                </dt>
                <dd>{item.label}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      {COMMAND_GROUPS.map((group) => {
        const items = commands.filter((c) => c.source === group.id);
        if (!items.length) return null;
        return (
          <div class="help-section" key={group.id}>
            <div class="eyebrow">
              {group.label === 'Local' ? 'Commands in this app' : group.label}
              <span class="help-count">{items.length}</span>
            </div>
            <dl class="help-commands">
              {items.map((c) => (
                <div class="help-command" key={c.name}>
                  <dt>
                    /{c.name}
                    {c.argumentHint && <span class="help-arg"> {c.argumentHint}</span>}
                  </dt>
                  <dd>{c.description}</dd>
                </div>
              ))}
            </dl>
          </div>
        );
      })}
    </Dialog>
  );
}
