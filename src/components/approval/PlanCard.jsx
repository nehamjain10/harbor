// ExitPlanMode: the proposed plan, rendered. Approve and switch to Accept edits (1) or
// Ask (2), or keep planning with feedback (3 → deny with the feedback as reason).
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ClipboardList } from 'lucide-preact';
import { approvalBody, planMode, planText } from '../../lib/approvals.js';
import { findModel } from '../../lib/models.js';
import { useAppState } from '../../state.js';
import { Markdown } from '../Markdown.jsx';
import { ApprovalShell, Key, useCardKeys, useRespond } from './shared.jsx';

export function PlanCard({ pending, count }) {
  const plan = useAppState((s) => planText(pending, s.current?.plan));
  const { busy, respond } = useRespond(pending);
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState('');
  const feedbackRef = useRef(null);

  // Only modes the session's model supports (gateway models have no `auto`).
  const allowedModes = useAppState((s) => {
    const model = findModel(s.info, s.current?.model);
    return Array.isArray(model?.modes) ? model.modes.join(',') : '';
  });
  const approve = (mode) => respond(approvalBody('allow', { mode: planMode(mode, allowedModes ? allowedModes.split(',') : null) }));
  const keepPlanning = () => respond(approvalBody('deny', { reason: feedback }));
  const startRevising = () => setRevising(true);
  useLayoutEffect(() => {
    if (revising) feedbackRef.current?.focus();
  }, [revising]);

  useCardKeys(
    revising
      ? {}
      : {
          1: () => approve('acceptEdits'),
          2: () => approve('default'),
          3: startRevising,
        },
  );

  const lines = plan.split('\n').filter((l) => l.trim()).length;

  return (
    <ApprovalShell kind="plan" tone="info" icon={<ClipboardList size={16} />} title="Ready to code?" subtitle={`A plan${lines ? ` · ${lines} lines` : ''}. Review it before any file changes.`} pending={pending} count={count}>
      <div class="approval-body">
        <div class="plan-scroll">{plan ? <Markdown text={plan} class="plan-markdown" /> : <p class="approval-lead">No plan text was provided.</p>}</div>
      </div>
      {revising ? (
        <form
          class="approval-footer approval-reason is-stacked"
          onSubmit={(event) => {
            event.preventDefault();
            keepPlanning();
          }}
        >
          <textarea
            ref={feedbackRef}
            class="input approval-textarea"
            rows={3}
            value={feedback}
            placeholder="What should change in the plan?"
            aria-label="Feedback on the plan"
            onInput={(event) => setFeedback(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setRevising(false);
              } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                keepPlanning();
              }
            }}
          />
          <div class="approval-actions">
            <button type="button" class="btn btn-sm btn-ghost" onClick={() => setRevising(false)} disabled={busy}>
              Cancel
            </button>
            <button type="submit" class="btn btn-sm btn-secondary" disabled={busy}>
              Keep planning
              <Key>↵</Key>
            </button>
          </div>
        </form>
      ) : (
        <div class="approval-footer">
          <div class="approval-actions approval-actions-plan">
            <button type="button" class="btn btn-sm btn-ghost" onClick={startRevising} disabled={busy}>
              Keep planning
              <Key>3</Key>
            </button>
            <button type="button" class="btn btn-sm btn-secondary" onClick={() => approve('default')} disabled={busy}>
              Approve &amp; ask for each edit
              <Key>2</Key>
            </button>
            <button type="button" class="btn btn-sm btn-primary" onClick={() => approve('acceptEdits')} disabled={busy}>
              Approve &amp; auto-accept edits
              <Key>1</Key>
            </button>
          </div>
        </div>
      )}
    </ApprovalShell>
  );
}
