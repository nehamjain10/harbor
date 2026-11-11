// Autocomplete menu for `@` files and `/` commands. Focus stays in the textarea: the
// composer drives the highlighted row with the keyboard (aria-activedescendant), and
// mouse-down on the menu is swallowed so the textarea keeps focus.
import { useLayoutEffect, useRef } from 'preact/hooks';
import { LoaderCircle } from 'lucide-preact';
import '../Popover.css';
import './composer.css';

export function SuggestMenu({ id, label, groups, activeIndex, onPick, onHover, loading, empty, position, class: className = '' }) {
  const ref = useRef(null);

  useLayoutEffect(() => {
    ref.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, groups]);

  const count = groups.reduce((n, group) => n + group.items.length, 0);
  let index = -1;

  return (
    <div
      ref={ref}
      id={id}
      class={`popover suggest ${className}`}
      role="listbox"
      aria-label={label}
      style={position}
      onMouseDown={(event) => event.preventDefault()}
    >
      {groups.map((group) => (
        <div key={group.label || 'items'} role="group" aria-label={group.label || label}>
          {group.label && <div class="popover-group">{group.label}</div>}
          {group.items.map((item) => {
            index += 1;
            const i = index;
            return (
              <div
                key={item.key}
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === activeIndex ? 'true' : 'false'}
                class={`menu-row suggest-row ${i === activeIndex ? 'is-active' : ''} ${item.class || ''}`}
                onMouseMove={() => i !== activeIndex && onHover(i)}
                onClick={() => onPick(i)}
              >
                <span class="menu-row-icon">{item.icon}</span>
                <span class="menu-row-text">
                  <span class="suggest-title">{item.title}</span>
                  {item.description && <span class="menu-row-description suggest-description">{item.description}</span>}
                </span>
                {item.trailing}
              </div>
            );
          })}
        </div>
      ))}
      {!count && (
        <div class="suggest-empty">
          {loading ? <LoaderCircle size={14} class="spin" /> : null}
          {loading ? 'Searching…' : empty}
        </div>
      )}
      <div class="suggest-foot" aria-hidden="true">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> to navigate
        </span>
        <span>
          <kbd>↵</kbd> to select
        </span>
        <span>
          <kbd>esc</kbd> to close
        </span>
        {loading && count > 0 && <LoaderCircle size={12} class="spin suggest-busy" />}
      </div>
    </div>
  );
}
