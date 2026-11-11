// The Agents view (`/agents`, the palette, the topbar): what this session can hand work
// to, and its agents working now (each opens its transcript in the side panel). Model
// agents are parallel workers on any model of the catalog, started by the main model
// with Harbor's delegate tool; Claude Code's subagents (built in, user, project and
// plugin agents) run on the session's own route.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Bot, LoaderCircle, PanelRightOpen } from 'lucide-preact';
import { api } from '../api.js';
import { closeDialog, openAgent } from '../actions.js';
import { commandCwd } from '../composer.js';
import { shallowEqual, useAppState } from '../state.js';
import { agentKind, isAgentTool, subagentModelLabel } from '../lib/agents.js';
import { clusterQuery, folderClusterId, folderKey } from '../lib/clusters.js';
import { providerNote } from '../lib/models.js';
import { Dialog } from './Dialog.jsx';
import { ModelIcon } from './ModelIcon.jsx';
import './AgentsDialog.css';

// GET /api/agents per project folder on its cluster, kept for the page's lifetime (five minutes).
const cache = new Map();
const MAX_AGE = 5 * 60_000;

function loadAgents(cwd, cluster) {
  const key = folderKey(cluster, cwd);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < MAX_AGE) return hit.promise;
  const promise = api.get('agents?cwd=' + encodeURIComponent(cwd || '') + clusterQuery(cluster), { timeout: 20_000 });
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}

// A working agent's transcript opens in the side panel, in place of this view.
function showAgent(toolId) {
  closeDialog();
  openAgent(toolId);
}

// Claude Code's `model` field: an alias, a model id, or `inherit` (the session's model).
function subagentModel(model) {
  if (!model || model === 'inherit') return 'Session model';
  return model;
}

export function AgentsDialog() {
  const cwd = commandCwd();
  const { info, messages, sessionModel, cluster } = useAppState(
    (s) => ({ info: s.info, messages: s.current?.messages, sessionModel: s.current?.model, cluster: folderClusterId(s) }),
    shallowEqual,
  );
  const [state, setState] = useState(() => ({ loading: true, error: null, agents: [], models: null }));

  useEffect(() => {
    let live = true;
    loadAgents(cwd, cluster).then(
      (data) => live && setState({ loading: false, error: null, agents: data?.agents || [], models: data?.models || null }),
      (error) => live && setState((previous) => ({ ...previous, loading: false, error: error.message })),
    );
    return () => {
      live = false;
    };
  }, [cwd, cluster]);

  // Every agent of this session still working: subagents and model agents.
  const working = useMemo(() => (messages || []).filter((m) => isAgentTool(m) && m.state === 'running' && !m.parentToolId), [messages]);
  // Until the list arrives, the catalog in /api/info names the models.
  const models = state.models || (info?.models || []).map((m) => ({ id: m.id, name: `${m.name} agent`, model: m.name, provider: m.provider, hint: m.description }));

  return (
    <Dialog title="Agents" eyebrow="This session" onClose={closeDialog} class="agents-dialog">
      {working.length > 0 && (
        <section class="agents-section" aria-label="Working now">
          <div class="eyebrow">
            Working now<span class="agents-count">{working.length}</span>
          </div>
          <ul class="agents-list">
            {working.map((agent) => (
              <li class="agents-item agents-working" key={agent.id}>
                <button type="button" class="agents-open" onClick={() => showAgent(agent.toolId)} title="Open its transcript">
                  <LoaderCircle size={14} class="spin agents-item-icon" aria-hidden="true" />
                  <span class="agents-item-name">{agent.input?.description || agent.agentId || 'Agent'}</span>
                  <span class="agents-chip">{agentKind(agent, info) || 'agent'}</span>
                  {subagentModelLabel(agent, info, sessionModel) && <span class="agents-chip">{subagentModelLabel(agent, info, sessionModel)}</span>}
                  <PanelRightOpen size={14} class="agents-open-icon" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section class="agents-section" aria-label="Model agents">
        <div class="eyebrow">
          Model agents<span class="agents-count">{models.length}</span>
        </div>
        <p class="agents-note">
          Parallel workers on any model, with the full toolset, in this session's permission mode. Ask Claude to split work across them, for
          example “have two Luna workers write the tests while Sol does the parser”; it starts them with Harbor's <code>delegate</code> tool,
          optionally each on its own git worktree, and collects their reports.
        </p>
        <ul class="agents-list">
          {models.map((model) => (
            <li class="agents-item agents-model" key={model.id}>
              <ModelIcon model={model} size={15} />
              <div class="agents-item-text">
                <div class="agents-item-title">
                  <span class="agents-item-name">{model.name}</span>
                  <span class="agents-chip">{providerNote(model)}</span>
                  <code class="agents-id">{model.id}</code>
                </div>
                <div class="agents-item-desc">{model.hint}</div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section class="agents-section" aria-label="Claude Code subagents">
        <div class="eyebrow">
          Claude Code subagents{!state.loading && !state.error && <span class="agents-count">{state.agents.length}</span>}
        </div>
        <p class="agents-note">Run on the session's own model route through Claude Code's Agent tool, from its built-in, user, project and plugin agents.</p>
        {state.loading ? (
          <p class="agents-status">
            <LoaderCircle size={14} class="spin" /> Asking Claude Code…
          </p>
        ) : state.error ? (
          <p class="agents-status is-error">Could not list them: {state.error}</p>
        ) : state.agents.length === 0 ? (
          <p class="agents-status">None found for this project.</p>
        ) : (
          <ul class="agents-list">
            {state.agents.map((agent) => (
              <li class="agents-item" key={agent.name}>
                <Bot size={15} class="agents-item-icon" aria-hidden="true" />
                <div class="agents-item-text">
                  <div class="agents-item-title">
                    <span class="agents-item-name">{agent.name}</span>
                    <span class="agents-chip">{subagentModel(agent.model)}</span>
                  </div>
                  <div class="agents-item-desc">{agent.description}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Dialog>
  );
}
