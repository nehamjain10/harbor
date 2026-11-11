// Approval cards above the composer: permission requests, AskUserQuestion and
// ExitPlanMode. Shows the first pending request with a "1 of N" counter.
import { shallowEqual, useAppState } from '../state.js';
import { approvalKind } from '../lib/approvals.js';
import { PermissionCard } from './approval/PermissionCard.jsx';
import { PlanCard } from './approval/PlanCard.jsx';
import { QuestionCard } from './approval/QuestionCard.jsx';

export function ApprovalCard() {
  const { pending, count, cwd } = useAppState(
    (s) => ({ pending: s.current?.pending?.[0] || null, count: s.current?.pending?.length || 0, cwd: s.current?.cwd || '' }),
    shallowEqual,
  );
  if (!pending) return null;
  const kind = approvalKind(pending);
  if (kind === 'question') return <QuestionCard key={pending.id} pending={pending} count={count} />;
  if (kind === 'plan') return <PlanCard key={pending.id} pending={pending} count={count} />;
  return <PermissionCard key={pending.id} pending={pending} count={count} cwd={cwd} />;
}
