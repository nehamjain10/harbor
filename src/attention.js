// Getting the user's attention: the "(N)" tab title and favicon dot, desktop
// notifications when a session finishes or needs approval, and marking the open
// session viewed while the page is visible. Decisions live in lib/notify.js; this
// module wires them to the store and the browser. Started once from main.jsx.
import { api } from './api.js';
import { markViewed, selectSession, toast } from './actions.js';
import { shallowEqual, store } from './state.js';
import { attentionCount, createNotifier, documentTitle, finishedBody, pendingBody, showsTurnEnd, turnWasStopped } from './lib/notify.js';
import { getItem, setItem } from './lib/storage.js';
import { NOTIFY_TAIL, sessionRoute } from './lib/tail.js';

const PREFERENCE_KEY = 'mesh-code-notify';
const FAVICON = '/favicon.svg';
const FAVICON_DOT = '/favicon-dot.svg';

const notifier = createNotifier();
let started = false;
let lastBadge = -1;

const pageVisible = () => document.visibilityState !== 'hidden';

// 'unsupported' | 'default' | 'granted' | 'denied'
export function notificationPermission() {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

function requestPermission() {
  // Older Safari only supports the callback form.
  return new Promise((resolve) => {
    try {
      const result = Notification.requestPermission(resolve);
      result?.then?.(resolve, () => resolve('denied'));
    } catch {
      resolve('denied');
    }
  });
}

// Turns desktop notifications on (asking for permission first) or off.
export async function setNotificationsEnabled(on) {
  if (!on) {
    setItem(PREFERENCE_KEY, 'off');
    store.set({ notifications: false });
    return false;
  }
  if (notificationPermission() === 'unsupported') {
    toast('This browser cannot show notifications.');
    return false;
  }
  let permission = Notification.permission;
  if (permission === 'default') permission = await requestPermission();
  store.set({ notificationPermission: permission });
  if (permission !== 'granted') {
    toast('Notifications are blocked. Allow them in this site’s settings, then turn them on again.');
    return false;
  }
  setItem(PREFERENCE_KEY, 'on');
  store.set({ notifications: true });
  return true;
}

function setFavicon(dot) {
  const link = document.querySelector('link[rel="icon"]');
  const href = dot ? FAVICON_DOT : FAVICON;
  if (link && link.getAttribute('href') !== href) link.setAttribute('href', href);
}

function updateBadge() {
  const { sessions, current } = store.get();
  const count = attentionCount(sessions, { currentId: current?.id, visible: pageVisible() });
  const title = documentTitle(current?.title || null, count);
  if (document.title !== title) document.title = title;
  if (count === lastBadge) return;
  lastBadge = count;
  setFavicon(count > 0);
  // Installed PWA: badge the app icon too.
  const badge = count ? navigator.setAppBadge?.(count) : navigator.clearAppBadge?.();
  badge?.catch?.(() => {});
}

// The finished session with its latest messages. List entries carry none, so fetch the
// end of the session (only the last turn is read) unless it is the open one. A copy that
// does not reach back to how the last turn ended (a long turn stopped before its
// result, see turnWasStopped) is fetched whole.
async function withMessages(session) {
  const current = store.get().current;
  let copy = current?.id === session.id && current.messages ? { ...current, status: session.status } : null;
  try {
    copy ??= await api.get(sessionRoute(session.id, { tail: NOTIFY_TAIL }), { timeout: 5000 });
    if (copy.messagesFrom > 0 && !showsTurnEnd(copy.messages)) copy = await api.get('sessions/' + encodeURIComponent(session.id), { timeout: 5000 });
    return copy;
  } catch {
    return copy || session;
  }
}

function show(session, body) {
  if (notificationPermission() !== 'granted') return;
  try {
    const notification = new Notification(session.title || 'Harbor', {
      body,
      tag: 'harbor:' + session.id,
      icon: FAVICON,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
      selectSession(session.id);
    };
  } catch {
    // Some mobile browsers only allow notifications from a service worker.
  }
}

async function announce(event) {
  if (event.type === 'waiting') return show(event.session, pendingBody(event.pending));
  const session = await withMessages(event.session);
  // The user stopped it themselves: nothing to tell them.
  if (turnWasStopped(session.messages)) return;
  show(event.session, finishedBody(session));
}

function refresh() {
  const state = store.get();
  const visible = pageVisible();
  const events = notifier.observe(state.sessions, {
    currentId: state.current?.id || null,
    // A visible window in the background (another app focused) still gets
    // notifications; marking viewed below only needs the page to be visible.
    visible: visible && document.hasFocus(),
    enabled: state.notifications && notificationPermission() === 'granted',
    loaded: state.sessionsLoaded,
  });
  for (const event of events) announce(event);
  updateBadge();
  if (visible) markViewed();
}

export function startAttention() {
  if (started) return;
  started = true;
  const permission = notificationPermission();
  store.set({
    notificationPermission: permission,
    notifications: getItem(PREFERENCE_KEY) === 'on' && permission === 'granted',
  });

  // Streaming ticks replace `current` several times a second; only react to the
  // fields that matter here.
  let last = null;
  store.subscribe((state) => {
    const key = {
      sessions: state.sessions,
      sessionsLoaded: state.sessionsLoaded,
      currentId: state.current?.id,
      title: state.current?.title,
      turnEndedAt: state.current?.turnEndedAt,
      notifications: state.notifications,
    };
    if (last && shallowEqual(key, last)) return;
    last = key;
    refresh();
  });
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('focus', refresh);
  refresh();
}
