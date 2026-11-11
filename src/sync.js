// Live sync over SSE (/api/events) with a polling fallback.
//
// Connection states: connecting → live (SSE open) → offline (SSE dropped, last poll
// failed) / polling (SSE dropped but polling works). The browser retries SSE on its
// own; if it gives up (readyState CLOSED, e.g. a 502 from the proxy) we reopen it.

const OPEN = 1;
const CLOSED = 2;

export function createSync({
  url = '/api/events',
  EventSourceImpl = globalThis.EventSource,
  timers = globalThis,
  pollInterval = 3000,
  reconnectDelay = 5000,
  onReady = () => {},
  onSession = () => {},
  onLive = () => {},
  onDelta = () => {},
  onInfo = () => {},
  onDeleted = () => {},
  onStatus = () => {},
  poll = async () => {},
} = {}) {
  let stream = null;
  let status = 'connecting';
  let pollTimer = null;
  let reconnectTimer = null;
  let polling = false;
  let stopped = false;

  const setStatus = (next) => {
    if (next === status) return;
    status = next;
    onStatus(next);
  };
  const isOpen = () => stream?.readyState === OPEN;
  const parse = (event) => {
    try {
      return JSON.parse(event.data);
    } catch {
      return null;
    }
  };

  function schedulePoll() {
    if (stopped || pollTimer || polling) return;
    pollTimer = timers.setTimeout(runPoll, pollInterval);
  }

  async function runPoll() {
    pollTimer = null;
    if (stopped || isOpen()) return;
    polling = true;
    try {
      await poll();
      if (!isOpen()) setStatus('polling');
    } catch {
      if (!isOpen()) setStatus('offline');
    } finally {
      polling = false;
      if (!isOpen()) schedulePoll();
    }
  }

  function scheduleReconnect(delay = reconnectDelay) {
    if (stopped || reconnectTimer) return;
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (stopped) return;
    stream?.close();
    const source = new EventSourceImpl(url);
    stream = source;
    source.addEventListener('ready', () => {
      if (source !== stream) return;
      timers.clearTimeout(pollTimer);
      pollTimer = null;
      setStatus('live');
      onReady();
    });
    source.addEventListener('session', (event) => {
      if (source !== stream) return;
      const session = parse(event);
      if (session?.id) onSession(session);
    });
    source.addEventListener('delta', (event) => {
      if (source !== stream) return;
      const delta = parse(event);
      if (delta?.id) onDelta(delta);
    });
    source.addEventListener('live', (event) => {
      if (source !== stream) return;
      const patch = parse(event);
      if (patch?.id) onLive(patch);
    });
    // Sessions deleted for good (Empty Trash).
    source.addEventListener('deleted', (event) => {
      if (source !== stream) return;
      const ids = parse(event)?.ids;
      if (Array.isArray(ids)) onDeleted(ids);
    });
    // The server's catalog changed (a deploy without a restart).
    source.addEventListener('info', () => {
      if (source === stream) onInfo();
    });
    source.onerror = () => {
      if (source !== stream) return;
      if (status !== 'polling') setStatus('offline');
      schedulePoll();
      if (source.readyState === CLOSED) scheduleReconnect();
    };
  }

  return {
    start() {
      stopped = false;
      connect();
    },
    // Called when the page becomes visible or the network returns: reconnect now
    // instead of waiting for the browser's backoff.
    resume() {
      if (stopped || isOpen()) return;
      timers.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      connect();
    },
    stop() {
      stopped = true;
      timers.clearTimeout(pollTimer);
      timers.clearTimeout(reconnectTimer);
      pollTimer = reconnectTimer = null;
      stream?.close();
      stream = null;
    },
    get status() {
      return status;
    },
  };
}
