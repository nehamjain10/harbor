// Models tab: how much context each model's conversations use, and fast mode for the
// models that have one. Under its most, a model compacts sooner (cheaper, faster turns
// on long chats). Both are Harbor's own (server/model-settings.mjs) and apply from each
// session's next turn.
import { useState } from 'preact/hooks';
import { applyModelSettings, setFastMode, toast } from '../../actions.js';
import { api } from '../../api.js';
import { formatTokens } from '../../lib/format.js';
import { groupModels } from '../../lib/models.js';
import { ModelIcon } from '../ModelIcon.jsx';
import { useRemote } from './hooks.js';
import { Loading, LoadFailed } from './parts.jsx';

const K = 1000;

export function ModelsTab() {
  const remote = useRemote(() => api.get('model-settings'), []);
  if (remote.error) return <LoadFailed message={remote.error} onRetry={remote.reload} />;
  if (!remote.data) return <Loading />;

  const save = async (id, limit) => {
    try {
      const data = await api.put('model-settings', { context: { [id]: limit } });
      remote.set(data);
      applyModelSettings(data.models);
      return true;
    } catch (error) {
      toast(error.message);
      return false;
    }
  };

  return (
    <div class="settings-pane">
      <p class="settings-note">
        The most context each model’s conversations use. A model compacts (summarizes older turns) before it reaches this, so a lower limit keeps long chats
        cheaper and faster. Changes apply from each chat’s next turn.
      </p>
      {groupModels(remote.data.models).map((group) => (
        <section key={group.name} class="models-group" aria-label={group.name}>
          <div class="settings-label">{group.name}</div>
          {group.models.map((model) => (
            <div key={model.id} class="models-item">
              <ModelRow model={model} save={save} />
              {model.fastNote && <FastRow model={model} onChange={remote.set} />}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function ModelRow({ model, save }) {
  const [text, setText] = useState(String(Math.round(model.contextWindow / K)));
  const [saving, setSaving] = useState(false);
  const shown = String(Math.round(model.contextWindow / K));
  const value = Number(text) * K;
  const min = model.minContext;
  const max = model.maxContext;
  const fallback = model.defaultContext ?? max;
  const valid = Number.isFinite(value) && Number.isInteger(Number(text)) && value >= min && value <= Math.ceil(max / K) * K;
  const dirty = text !== shown;

  const commit = async (limit) => {
    setSaving(true);
    // Limits are typed in thousands; the most and the default need not be whole thousands.
    const isDefault = limit === null || Math.round(limit / K) === Math.round(fallback / K);
    const ok = await save(model.id, isDefault ? null : Math.min(limit, max));
    setSaving(false);
    if (ok && limit === null) setText(String(Math.round(fallback / K)));
  };
  const submit = (event) => {
    event.preventDefault();
    if (dirty && valid) commit(value);
  };

  return (
    <form class="models-row" onSubmit={submit}>
      <ModelIcon model={model} size={15} />
      <div class="models-name">
        <span>{model.name}</span>
        <span class="models-range">
          {model.custom ? `Default ${formatTokens(fallback)}` : 'Default'} · {formatTokens(min)}–{formatTokens(max)}
        </span>
      </div>
      <label class="models-input">
        <input
          type="number"
          inputMode="numeric"
          min={min / K}
          max={Math.ceil(max / K)}
          step="1"
          value={text}
          aria-label={`${model.name} context, thousands of tokens`}
          aria-invalid={String(!valid)}
          onInput={(event) => setText(event.currentTarget.value)}
        />
        <span>k tokens</span>
      </label>
      <div class="models-actions">
        {dirty ? (
          <button type="submit" class="btn btn-sm btn-primary" disabled={!valid || saving}>
            Save
          </button>
        ) : (
          model.custom && (
            <button type="button" class="btn btn-sm btn-secondary" disabled={saving} onClick={() => commit(null)}>
              Reset
            </button>
          )
        )}
      </div>
    </form>
  );
}

function FastRow({ model, onChange }) {
  const [saving, setSaving] = useState(false);
  const toggle = async () => {
    setSaving(true);
    const data = await setFastMode(model.id, !model.fast);
    setSaving(false);
    if (data) onChange(data);
  };
  return (
    <div class="models-fast">
      <div class="models-name">
        <span>Fast mode</span>
        <span class="models-range">{model.fastNote}</span>
      </div>
      <button
        type="button"
        role="switch"
        class="models-switch"
        aria-checked={String(Boolean(model.fast))}
        aria-label={`${model.name} fast mode`}
        disabled={saving}
        onClick={toggle}
      >
        <span class="switch" aria-hidden="true" />
      </button>
    </div>
  );
}
