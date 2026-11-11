// Live elapsed-time labels. All of them share one 1 s ticker, and only the label
// itself re-renders on a tick.
import { useEffect, useRef, useState } from 'preact/hooks';
import { formatDuration } from '../lib/format.js';

const listeners = new Set();
let timer = null;

function subscribe(listener) {
  listeners.add(listener);
  if (!timer) {
    timer = setInterval(() => {
      const now = Date.now();
      for (const fn of [...listeners]) fn(now);
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = null;
    }
  };
}

// The current time, refreshed every second while `active`.
export function useNow(active = true) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    return subscribe(setNow);
  }, [active]);
  return now;
}

// Time since `since` (ms timestamp). When the server reports `elapsed` (seconds),
// that wins and keeps counting locally from the moment it arrived, which avoids
// clock skew between the server and this device.
export function Elapsed({ since, elapsed = null, class: className = '' }) {
  const anchor = useRef(null);
  if (!anchor.current || anchor.current.elapsed !== elapsed) anchor.current = { elapsed, at: Date.now() };
  const now = useNow();
  const ms = elapsed != null ? elapsed * 1000 + (now - anchor.current.at) : now - (since || now);
  return <span class={`elapsed ${className}`}>{formatDuration(ms)}</span>;
}
