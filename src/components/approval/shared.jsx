// Building blocks shared by the approval cards: the card shell (icon, title, "1 of N",
// waiting timer), single-key shortcuts, the answer request, and kbd hints.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Bot, Clock } from 'lucide-preact';
import { answerApproval, toast } from '../../actions.js';
import { store } from '../../state.js';
import { waitingLabel } from '../../lib/approvals.js';
import { isTextEntry } from '../../lib/keys.js';
import './approval.css';

const canHover = () => globalThis.matchMedia?.('(hover: hover)').matches;
// Cards ignore their keys this long after appearing, so a quick double press can never
// answer a request the user has not seen yet.
const KEY_ARM_MS = 400;

/** Nothing has focus (the page itself): a card may take it without stealing keystrokes. */
export function focusIsIdle() {
  const active = document.activeElement;
  return !active || active === document.body;
}

function useNow(interval = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

export function Waiting({ since }) {
  const now = useNow();
  if (!since) return null;
  return (
    <span class="approval-wait" title="Waiting for you">
      <Clock size={12} />
      {waitingLabel(now - since)}
    </span>
  );
}

// Single-key shortcuts ('1', '2', 'Enter'…) while the card is shown. They do not fire
// while typing in a text field, from a menu, or with a dialog open.
export function useCardKeys(map) {
  const latest = useRef(map);
  latest.current = map;
  useEffect(() => {
    const armedAt = performance.now() + KEY_ARM_MS;
    const onKey = (event) => {
      if (performance.now() < armedAt) return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.keyCode === 229 || event.repeat) return;
      if (isTextEntry(event.target)) return;
      // Enter on a button presses that button.
      if (event.key === 'Enter' && event.target.closest?.('button, a, summary')) return;
      if (document.querySelector('dialog[open], .popover')) return;
      const handler = latest.current[event.key];
      if (!handler) return;
      event.preventDefault();
      handler();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

// Posts the answer once; on failure re-enables the card and shows why.
export function useRespond(pending) {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const respond = async (body) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await answerApproval(pending, body);
    } catch (error) {
      if (error.dropped) {
        toast(error.message || 'This request was already answered.');
        return;
      }
      toast(error.message);
      inFlight.current = false;
      setBusy(false);
    }
  };
  return { busy, respond };
}

export function Key({ children }) {
  return <kbd class="btn-kbd">{children}</kbd>;
}

export function ApprovalShell({ kind, tone = kind, icon, title, subtitle, pending, count, children, cardRef }) {
  const ref = useRef(null);

  // Take focus only when nothing has it, so the number keys work straight away. Never
  // take it from the composer: keystrokes meant for a follow-up would answer the card.
  useLayoutEffect(() => {
    if (focusIsIdle() && canHover()) ref.current?.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      if (now && now !== document.body && !ref.current?.contains(now)) return;
      // Next tick: a following card may have taken focus already.
      setTimeout(() => {
        const active = document.activeElement;
        if (!active || active === document.body) store.set({ focusNonce: store.get().focusNonce + 1 });
      }, 0);
    };
  }, []);

  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (cardRef) cardRef.current = el;
      }}
      class={`approval approval-${kind} tone-${tone}`}
      role="region"
      aria-label={pending.agent ? `${title} (agent ${pending.agent.description || pending.agent.subagentType || ''})` : title}
      tabIndex={-1}
    >
      <div class="approval-head">
        <span class="approval-icon">{icon}</span>
        <div class="approval-heading">
          {pending.agent && <AgentLabel agent={pending.agent} />}
          <div class="approval-title">{title}</div>
          {subtitle && <div class="approval-subtitle">{subtitle}</div>}
        </div>
        <div class="approval-meta">
          {count > 1 && <span class="approval-count">1 of {count}</span>}
          <Waiting since={pending.at} />
        </div>
      </div>
      {children}
    </div>
  );
}

// Which subagent is asking (parallel agents would otherwise look alike).
function AgentLabel({ agent }) {
  return (
    <div class="approval-agent" title="Asked by a subagent">
      <Bot size={12} aria-hidden="true" />
      <span class="approval-agent-name">{agent.description || 'Subagent'}</span>
      {agent.subagentType && <span class="approval-agent-type">{agent.subagentType}</span>}
    </div>
  );
}
