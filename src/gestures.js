// Phone drawer gestures: swipe right from the left edge to open the sessions
// drawer, swipe left on the open drawer to close it. The drawer follows the finger
// and settles by distance or flick speed. Listeners are passive so scrolling never
// waits on JavaScript.
import { closeDrawer, toggleSidebar } from './actions.js';
import { store } from './state.js';
import './styles/gestures.css';

const EDGE = 24; // px from the left edge where an opening swipe may start
const SLOP = 10; // px of movement before deciding horizontal vs vertical
const FLICK = 0.35; // px/ms

const isPhone = () => globalThis.matchMedia?.('(max-width: 759px)').matches;

export function installDrawerGestures() {
  let drag = null;
  const app = () => document.querySelector('.app');

  const reset = () => {
    const el = app();
    el?.classList.remove('drawer-dragging');
    el?.style.removeProperty('--drawer-offset');
    el?.style.removeProperty('--drawer-progress');
  };

  document.addEventListener(
    'touchstart',
    (event) => {
      drag = null;
      const { drawerOpen, dialog } = store.get();
      if (!isPhone() || dialog || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!drawerOpen && touch.clientX > EDGE) return;
      const width = document.querySelector('.sidebar-slot')?.offsetWidth || 300;
      drag = { startX: touch.clientX, startY: touch.clientY, open: drawerOpen, width, offset: drawerOpen ? width : 0, decided: false, x: touch.clientX, t: event.timeStamp, velocity: 0 };
    },
    { passive: true },
  );

  document.addEventListener(
    'touchmove',
    (event) => {
      if (!drag) return;
      const touch = event.touches[0];
      const dx = touch.clientX - drag.startX;
      const dy = touch.clientY - drag.startY;
      if (!drag.decided) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        // Vertical scrolls, and swipes the wrong way, are not ours.
        if (Math.abs(dy) > Math.abs(dx) || (drag.open ? dx > 0 : dx < 0)) {
          drag = null;
          return;
        }
        drag.decided = true;
        app()?.classList.add('drawer-dragging');
      }
      const dt = Math.max(1, event.timeStamp - drag.t);
      drag.velocity = (touch.clientX - drag.x) / dt;
      drag.x = touch.clientX;
      drag.t = event.timeStamp;
      drag.offset = Math.min(drag.width, Math.max(0, (drag.open ? drag.width : 0) + dx));
      const el = app();
      el?.style.setProperty('--drawer-offset', drag.offset + 'px');
      el?.style.setProperty('--drawer-progress', String(drag.offset / drag.width));
    },
    { passive: true },
  );

  const end = () => {
    if (!drag) return;
    const { decided, velocity, offset, width } = drag;
    drag = null;
    if (!decided) return;
    const open = velocity > FLICK ? true : velocity < -FLICK ? false : offset > width / 2;
    reset();
    if (open && !store.get().drawerOpen) toggleSidebar();
    else if (!open) closeDrawer();
  };
  document.addEventListener('touchend', end, { passive: true });
  // A cancelled touch (the browser took the gesture, a long-press selection) changes nothing.
  document.addEventListener(
    'touchcancel',
    () => {
      if (!drag) return;
      drag = null;
      reset();
    },
    { passive: true },
  );
}
