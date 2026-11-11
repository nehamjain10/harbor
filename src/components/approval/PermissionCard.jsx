// Permission request: what the tool will do (command, diff, URL, JSON), with
// Allow once (1) / Always allow (2, when the SDK offered rules) / Deny (3, + reason).
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { FilePen, FilePlus, Globe, Plug, Search, ShieldAlert, ShieldCheck, SquareTerminal, TriangleAlert } from 'lucide-preact';
import { approvalBody, isWebSearch, mcpParts, permissionTitle, suggestionItems } from '../../lib/approvals.js';
import { fileChangeBlocks } from '../../lib/approvalDiff.js';
import { relativePath } from '../../lib/format.js';
import { FileIcon } from '../composer/Attachments.jsx';
import { ApprovalDiff } from './ApprovalDiff.jsx';
import { ApprovalShell, focusIsIdle, Key, useCardKeys, useRespond } from './shared.jsx';

function toolIcon(tool) {
  if (isWebSearch(tool)) return <Search size={16} />;
  if (mcpParts(tool)) return <Plug size={16} />;
  if (tool === 'Bash') return <SquareTerminal size={16} />;
  if (tool === 'Write') return <FilePlus size={16} />;
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') return <FilePen size={16} />;
  if (tool === 'WebFetch') return <Globe size={16} />;
  if (tool === 'Grep' || tool === 'Glob') return <Search size={16} />;
  return <ShieldAlert size={16} />;
}

function CommandPreview({ input }) {
  return (
    <div class="approval-section">
      {input.description && <p class="approval-lead">{input.description}</p>}
      <pre class="approval-code approval-command">
        <span class="command-prompt" aria-hidden="true">
          $
        </span>
        <code>{input.command || ''}</code>
      </pre>
    </div>
  );
}

function FilePreview({ tool, input, blocks, cwd }) {
  const path = input.file_path || input.notebook_path || '';
  const adds = blocks.reduce((n, b) => n + b.adds, 0);
  const dels = blocks.reduce((n, b) => n + b.dels, 0);
  return (
    <div class="approval-section">
      <div class="approval-file">
        <FileIcon name={path} size={14} />
        <span class="approval-path" title={path}>
          {relativePath(path, cwd) || 'file'}
        </span>
        <span class="approval-stats">
          {tool === 'Write' && <span class="approval-new">{blocks[0]?.rows.length || 0} lines</span>}
          {adds > 0 && <span class="stat-adds">+{adds}</span>}
          {dels > 0 && <span class="stat-dels">−{dels}</span>}
        </span>
      </div>
      <div class="approval-scroll">
        <ApprovalDiff blocks={blocks} numbers={tool === 'Write'} />
      </div>
    </div>
  );
}

function UrlPreview({ input }) {
  return (
    <div class="approval-section">
      <div class="approval-code approval-url">
        <Globe size={14} />
        <span>{input.url}</span>
      </div>
      {input.prompt && <p class="approval-lead approval-prompt">{input.prompt}</p>}
    </div>
  );
}

function JsonPreview({ input }) {
  const text = JSON.stringify(input ?? {}, null, 2);
  return (
    <div class="approval-section">
      <pre class="approval-code approval-json">{text === '{}' ? 'No input' : text}</pre>
    </div>
  );
}

function Preview({ tool, input, cwd }) {
  // The line diff is the expensive part of a card; compute it once per request.
  const blocks = useMemo(() => fileChangeBlocks(tool, input), [tool, input]);
  if (tool === 'Bash' && input.command) return <CommandPreview input={input} />;
  if (blocks) return <FilePreview tool={tool} input={input} blocks={blocks} cwd={cwd} />;
  if (tool === 'WebFetch' && input.url) return <UrlPreview input={input} />;
  if (isWebSearch(tool) && input.query) {
    return (
      <div class="approval-section">
        <div class="approval-code approval-url">
          <Search size={14} />
          <span>{input.query}</span>
        </div>
      </div>
    );
  }
  return <JsonPreview input={input} />;
}

function insideFolder(target, folder) {
  if (!folder) return false;
  const root = folder.endsWith('/') ? folder : folder + '/';
  return target === folder || target.startsWith(root);
}

export function PermissionCard({ pending, count, cwd }) {
  const input = pending.input || {};
  const tool = pending.tool;
  const grants = suggestionItems(pending.suggestions);
  const canAlways = !pending.suppressAlwaysAllowRule && Array.isArray(pending.suggestions) && pending.suggestions.length > 0;
  // `defaultToNo`: no one-key approve, Allow is not the primary action, Deny has focus.
  const cautious = !!pending.defaultToNo;
  const denyButton = useRef(null);
  const { busy, respond } = useRespond(pending);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const reasonRef = useRef(null);

  const allowOnce = () => respond(approvalBody('allow'));
  const allowAlways = () => canAlways && respond(approvalBody('allowAlways'));
  const deny = () => respond(approvalBody('deny', { reason }));
  const startDeny = () => setDenying(true);
  useLayoutEffect(() => {
    if (denying) reasonRef.current?.focus();
  }, [denying]);

  useCardKeys(
    denying
      ? {}
      : {
          ...(cautious ? null : { 1: allowOnce }),
          ...(canAlways && !cautious ? { 2: allowAlways } : null),
          3: startDeny,
        },
  );

  useLayoutEffect(() => {
    if (cautious && focusIsIdle() && globalThis.matchMedia?.('(hover: hover)').matches) denyButton.current?.focus({ preventScroll: true });
  }, []);

  const mcp = isWebSearch(tool) ? null : mcpParts(tool);
  const subtitle = pending.description || pending.title || (mcp ? `MCP server ${mcp.server}` : '');

  return (
    <ApprovalShell kind="permission" tone="warning" icon={toolIcon(tool)} title={permissionTitle(tool, pending.displayName)} subtitle={subtitle} pending={pending} count={count}>
      <div class="approval-body">
        <Preview tool={tool} input={input} cwd={cwd} />
        {pending.decisionReason && (
          <div class="approval-warning">
            <TriangleAlert size={14} />
            <span>{pending.decisionReason}</span>
          </div>
        )}
        {pending.blockedPath && (
          <div class="approval-warning">
            <TriangleAlert size={14} />
            <span>
              {insideFolder(pending.blockedPath, cwd) ? 'Writes to' : 'Outside the project'}: <code>{pending.blockedPath}</code>
            </span>
          </div>
        )}
      </div>
      {denying ? (
        <form
          class="approval-footer approval-reason"
          onSubmit={(event) => {
            event.preventDefault();
            deny();
          }}
        >
          <input
            ref={reasonRef}
            class="input approval-input"
            value={reason}
            placeholder="What should it do instead? (optional)"
            aria-label="Reason for denying"
            onInput={(event) => setReason(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setDenying(false);
              }
            }}
          />
          <div class="approval-actions">
            <button type="button" class="btn btn-sm btn-ghost" onClick={() => setDenying(false)} disabled={busy}>
              Cancel
            </button>
            <button type="submit" class="btn btn-sm btn-danger" disabled={busy}>
              Deny
              <Key>↵</Key>
            </button>
          </div>
        </form>
      ) : (
        <div class="approval-footer">
          {canAlways && grants.length > 0 && (
            <div class="approval-rule">
              <ShieldCheck size={13} />
              <span>
                Always allow:{' '}
                {grants.map((grant, i) => (
                  <span key={grant.type + grant.text}>
                    {i > 0 && ' · '}
                    {grant.type === 'rule' ? <code>{grant.text}</code> : grant.text}
                  </span>
                ))}{' '}
                <span class="approval-rule-scope">for this session</span>
              </span>
            </div>
          )}
          <div class="approval-actions">
            <button ref={denyButton} type="button" class={`btn btn-sm ${cautious ? 'btn-secondary' : 'btn-ghost'}`} onClick={startDeny} disabled={busy}>
              Deny
              <Key>3</Key>
            </button>
            {canAlways && (
              <button type="button" class={`btn btn-sm ${cautious ? 'btn-ghost' : 'btn-secondary'}`} onClick={allowAlways} disabled={busy}>
                Always allow
                {!cautious && <Key>2</Key>}
              </button>
            )}
            <button type="button" class={`btn btn-sm ${cautious ? 'btn-ghost' : 'btn-primary'}`} onClick={allowOnce} disabled={busy}>
              Allow once
              {!cautious && <Key>1</Key>}
            </button>
          </div>
        </div>
      )}
    </ApprovalShell>
  );
}
