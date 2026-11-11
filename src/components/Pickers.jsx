// Composer chips with their popover menus: model, permission mode, effort.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ArrowLeft, Check, ChevronDown, ChevronRight, ClipboardList, FilePen, Hand, Rabbit, Search, Server, Sparkles, Zap } from 'lucide-preact';
import { chooseCluster, chooseEffort, chooseMode, chooseModel, loadOpenRouterModels, setFastMode } from '../actions.js';
import { shallowEqual, store, useAppState } from '../state.js';
import { findCluster } from '../lib/clusters.js';
import { canonicalMode, availableModes, modeLabel, modeTone } from '../lib/modes.js';
import {
  EFFORT_DESCRIPTIONS,
  EFFORT_LEVEL,
  effectiveEffort,
  effortName,
  effortOptions,
  filterOpenRouterModels,
  findModel,
  groupModels,
  isOpenRouterId,
  modelDescription,
  openRouterDescription,
  providerNote,
} from '../lib/models.js';
import { isBusy } from '../lib/sessions.js';
import { MenuRow, Popover, moveMenuFocus } from './Popover.jsx';
import { ModelIcon } from './ModelIcon.jsx';
import './Pickers.css';

const MODE_ICONS = { default: Hand, acceptEdits: FilePen, plan: ClipboardList, auto: Sparkles, bypassPermissions: Zap };

export function ModeIcon({ mode, size = 15 }) {
  const Icon = MODE_ICONS[canonicalMode(mode)] || Hand;
  return <Icon size={size} />;
}

function usePickerState() {
  return useAppState(
    (s) => ({
      info: s.info,
      isV2: s.isV2,
      session: s.current
        ? { id: s.current.id, model: s.current.model, mode: s.current.mode, efforts: s.current.efforts, busy: isBusy(s.current) }
        : null,
      model: s.model,
      mode: s.mode,
      efforts: s.efforts,
    }),
    (a, b) => shallowEqual({ ...a, session: null }, { ...b, session: null }) && shallowEqual(a.session, b.session),
  );
}

// Opens the picker when a `/model`, `/mode` or `/effort` command asks for it.
function usePickerRequest(name, setOpen) {
  const request = useAppState((s) => s.pickerRequest || null);
  useEffect(() => {
    if (request?.name !== name) return;
    setOpen(true);
    store.set({ pickerRequest: null });
  }, [request]);
}

function Chip({ open, setOpen, disabled, title, class: className = '', children }) {
  return (
    <button
      type="button"
      class={`chip ${className}`}
      aria-expanded={String(open)}
      aria-haspopup="listbox"
      disabled={disabled}
      title={title}
      onClick={() => setOpen(!open)}
    >
      {children}
      <ChevronDown size={13} class="chip-caret" />
    </button>
  );
}

const check = <Check size={15} class="menu-row-check" />;

const narrow = () => Boolean(globalThis.matchMedia?.('(max-width: 759px)').matches);

/**
 * The OpenRouter models with a zero-data-retention endpoint: a search box and the list.
 * `side`: a panel next to the model menu (desktop); otherwise it takes the menu's place
 * inside it, with a back button (phones).
 */
function OpenRouterMenu({ side, modelId, onPick, onBack, menuRef }) {
  const { models, status } = useAppState((s) => ({ models: s.info?.openrouterModels, status: s.openrouterStatus }), shallowEqual);
  const [query, setQuery] = useState('');
  const ref = useRef(null);
  const input = useRef(null);
  useEffect(() => {
    void loadOpenRouterModels();
    input.current?.focus({ preventScroll: true });
  }, []);
  // The side panel opens to the right of the menu, or to its left when there is no room,
  // and is kept inside the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    const menu = menuRef?.current?.closest('.popover');
    if (!side || !el || !menu) return;
    const margin = 8;
    const gap = 6;
    const box = menu.getBoundingClientRect();
    let x = box.right + gap;
    if (x + el.offsetWidth > window.innerWidth - margin && box.left - gap - el.offsetWidth >= margin) x = box.left - gap - el.offsetWidth;
    x = Math.max(margin, Math.min(x, window.innerWidth - margin - el.offsetWidth));
    el.style.left = x - (el.offsetParent || el.parentElement).getBoundingClientRect().left + 'px';
  });
  const shown = filterOpenRouterModels(models || [], query);
  const onKeyDown = (event) => {
    if (event.key === 'ArrowLeft' && side && event.target.tagName !== 'INPUT') {
      event.preventDefault();
      onBack();
      return;
    }
    moveMenuFocus(ref.current, event);
    // Arrow keys stay in this list (not the model menu's).
    event.stopPropagation();
  };
  return (
    <div
      ref={ref}
      class={side ? 'popover popover-top-start picker-popover openrouter-menu openrouter-side' : 'openrouter-menu'}
      role={side ? 'dialog' : undefined}
      aria-label="OpenRouter models"
      onKeyDown={onKeyDown}
    >
      <div class="openrouter-head">
        {!side && (
          <button type="button" class="openrouter-back" aria-label="Back to models" onClick={onBack}>
            <ArrowLeft size={15} />
          </button>
        )}
        <label class="openrouter-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={input}
            type="search"
            placeholder="Search OpenRouter models"
            aria-label="Search OpenRouter models"
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && shown.length) onPick(shown[0].id);
            }}
          />
        </label>
      </div>
      <div class="popover-group">
        OpenRouter
        <span class="popover-group-note">Zero data retention</span>
      </div>
      {status === 'error' && !models?.length && (
        <div class="popover-note openrouter-error">
          Could not load the OpenRouter models.{' '}
          <button type="button" class="openrouter-retry" onClick={() => loadOpenRouterModels()}>
            Retry
          </button>
        </div>
      )}
      {status !== 'error' && !models && <div class="popover-note">Loading models…</div>}
      {models && !shown.length && <div class="popover-note">No model matches “{query}”.</div>}
      <div role="listbox" aria-label="OpenRouter models">
        {shown.map((m) => (
          <MenuRow
            key={m.id}
            label={m.name}
            description={openRouterDescription(m)}
            selected={m.id === modelId}
            trailing={m.id === modelId ? check : null}
            onSelect={() => onPick(m.id)}
          />
        ))}
      </div>
    </div>
  );
}

export function ModelPicker() {
  const { info, isV2, session, model: draftModel } = usePickerState();
  const [open, setOpen] = useState(false);
  // The OpenRouter side menu: closed, 'side' (next to the menu) or 'inline' (phones).
  const [openrouter, setOpenrouter] = useState(null);
  const menu = useRef(null);
  const anchor = useRef(null);
  // Set when the model changes mid-turn; the switch only applies from the next turn.
  const [switchedMidTurn, setSwitchedMidTurn] = useState(false);
  usePickerRequest('model', setOpen);
  const modelId = session?.model || draftModel;
  const model = findModel(info, modelId);
  // A v1 server refuses model switches during a turn.
  const locked = !!session?.busy && !isV2;
  const busy = !!session?.busy;
  const onOpenRouter = isOpenRouterId(modelId);
  useEffect(() => {
    if (!busy) setSwitchedMidTurn(false);
  }, [busy, session?.id]);
  // An OpenRouter model's name, efforts and context come from the list.
  useEffect(() => {
    if (onOpenRouter && info) void loadOpenRouterModels();
  }, [onOpenRouter, !!info]);
  useEffect(() => {
    if (!open) setOpenrouter(null);
  }, [open]);
  const close = () => setOpen(false);
  const closeOpenRouter = () => {
    setOpenrouter(null);
    // Back on the row that opened it.
    requestAnimationFrame(() => menu.current?.querySelector('.openrouter-row')?.focus({ preventScroll: true }));
  };
  const pick = (id) => {
    // Focus was in the side panel, outside the popover: give it back to the chip.
    if (openrouter === 'side') requestAnimationFrame(() => anchor.current?.querySelector('.chip')?.focus({ preventScroll: true }));
    setOpen(false);
    if (id === modelId) return;
    if (busy) setSwitchedMidTurn(true);
    chooseModel(id);
  };
  const inline = openrouter === 'inline';
  return (
    <div ref={anchor} class="popover-anchor">
      <Chip
        open={open}
        setOpen={setOpen}
        disabled={locked || !info}
        title={locked ? 'Available after the current turn' : switchedMidTurn ? `${model.name} · applies from the next turn` : `Model: ${model.name}`}
        class="chip-model"
      >
        <ModelIcon model={model} size={15} />
        <span class="chip-label">{model.name.replace(/^Claude /, '')}</span>
        {switchedMidTurn && <span class="chip-hint">next turn</span>}
      </Chip>
      {open && (
        <Popover
          onClose={close}
          onEscape={() => {
            if (!openrouter) return false;
            closeOpenRouter();
            return true;
          }}
          label="Choose a model"
          class="picker-popover"
        >
          <div ref={menu} class="model-menu">
            {inline ? (
              <OpenRouterMenu side={false} modelId={modelId} onPick={pick} onBack={closeOpenRouter} />
            ) : (
              <>
                {groupModels(info?.models).map((group) => (
                  <div key={group.name} role="listbox" aria-label={group.name}>
                    <div class="popover-group">
                      {group.name}
                      {providerNote(group.models[0]) !== group.name && <span class="popover-group-note">{providerNote(group.models[0])}</span>}
                    </div>
                    {group.models.map((m) => (
                      <MenuRow
                        key={m.id}
                        icon={<ModelIcon model={m} size={15} />}
                        label={m.name}
                        description={modelDescription(m)}
                        selected={m.id === modelId}
                        trailing={m.id === modelId ? check : null}
                        onSelect={() => pick(m.id)}
                      />
                    ))}
                  </div>
                ))}
                <MenuRow
                  role="menuitem"
                  class={`openrouter-row ${openrouter ? 'is-open' : ''}`}
                  aria-haspopup="dialog"
                  aria-expanded={String(Boolean(openrouter))}
                  icon={<ModelIcon model={{ provider: 'OpenRouter' }} size={15} />}
                  label="OpenRouter models"
                  description={onOpenRouter ? `${model.name} · current` : 'Every model with zero data retention'}
                  selected={onOpenRouter}
                  trailing={<ChevronRight size={15} class="openrouter-chevron" />}
                  onSelect={() => setOpenrouter(openrouter ? null : narrow() ? 'inline' : 'side')}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowRight') return;
                    event.preventDefault();
                    setOpenrouter(narrow() ? 'inline' : 'side');
                  }}
                />
              </>
            )}
          </div>
          {session && isV2 && session.busy && <div class="popover-note">A turn is running · a new model applies from the next turn.</div>}
        </Popover>
      )}
      {open && openrouter === 'side' && <OpenRouterMenu side modelId={modelId} onPick={pick} onBack={closeOpenRouter} menuRef={menu} />}
    </div>
  );
}

export function ModePicker() {
  const { info, isV2, session, model: draftModel, mode: draftMode } = usePickerState();
  const [open, setOpen] = useState(false);
  usePickerRequest('mode', setOpen);
  const mode = canonicalMode(session?.mode || draftMode);
  const model = findModel(info, session?.model || draftModel);
  const locked = !!session?.busy && !isV2;
  const modes = availableModes(info, model);
  const pick = (id) => {
    setOpen(false);
    if (id !== mode) chooseMode(id);
  };
  return (
    <div class="popover-anchor">
      <Chip open={open} setOpen={setOpen} disabled={locked} title={locked ? 'Available after the current turn' : 'Permission mode'} class={`chip-mode tone-${modeTone(mode)}`}>
        <ModeIcon mode={mode} />
        <span class="chip-label">{modeLabel(mode)}</span>
      </Chip>
      {open && (
        <Popover onClose={() => setOpen(false)} label="Permission mode" class="picker-popover">
          <div class="popover-group">Permission mode</div>
          <div role="listbox" aria-label="Permission mode">
            {modes.map((m) => (
              <MenuRow
                key={m.id}
                icon={<ModeIcon mode={m.id} />}
                class={`tone-${m.tone}`}
                label={m.label}
                description={m.description}
                selected={m.id === mode}
                trailing={m.id === mode ? check : null}
                onSelect={() => pick(m.id)}
              />
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}

export function EffortBars({ level }) {
  return (
    <span class="effort-bars" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((n) => (
        <i key={n} class={n <= level ? 'lit' : ''} />
      ))}
    </span>
  );
}

export function EffortPicker() {
  const { info, session, model: draftModel, efforts: draftEfforts } = usePickerState();
  const [open, setOpen] = useState(false);
  usePickerRequest('effort', setOpen);
  const modelId = session?.model || draftModel;
  const model = findModel(info, modelId);
  const chosen = (session ? session.efforts?.[modelId] : draftEfforts[modelId]) || 'default';
  const effective = effectiveEffort(model, chosen);
  const options = effortOptions(model);
  if (options.length <= 1) return null;
  const pick = (effort) => {
    setOpen(false);
    if (effort !== chosen) chooseEffort(effort);
  };
  return (
    <div class="popover-anchor">
      <Chip open={open} setOpen={setOpen} title={model.fast ? 'Reasoning effort · fast mode on' : 'Reasoning effort'} class="chip-effort">
        <EffortBars level={EFFORT_LEVEL[effective] || 2} />
        <span class="chip-label">{effortName(effective)}</span>
        {model.fast && <Rabbit size={13} class="chip-fast" aria-label="Fast mode" />}
      </Chip>
      {open && (
        <Popover onClose={() => setOpen(false)} label="Reasoning effort" class="picker-popover">
          <div class="popover-group">Effort · {model.name}</div>
          <div role="listbox" aria-label="Reasoning effort">
            {options.map((effort) => (
              <MenuRow
                key={effort}
                icon={<EffortBars level={EFFORT_LEVEL[effort === 'default' ? model.defaultEffort : effort] || 2} />}
                label={effortName(effort)}
                description={effort === 'default' ? `Model default · ${effortName(model.defaultEffort)}` : EFFORT_DESCRIPTIONS[effort]}
                selected={effort === chosen}
                trailing={effort === chosen ? check : null}
                onSelect={() => pick(effort)}
              />
            ))}
          </div>
          {model.fastNote && (
            <button
              type="button"
              role="switch"
              class="menu-row fast-row"
              aria-checked={String(Boolean(model.fast))}
              onClick={() => setFastMode(model.id, !model.fast)}
            >
              <span class="menu-row-icon">
                <Rabbit size={14} />
              </span>
              <span class="menu-row-text">
                <span class="menu-row-label">Fast mode</span>
                <span class="menu-row-description">{model.fastNote}</span>
              </span>
              <span class="switch" aria-hidden="true" />
            </button>
          )}
          <div class="popover-note">{model.fastNote ? `Applies from the next turn. Fast mode is for every ${model.name} chat.` : 'Applies from the next turn.'}</div>
        </Popover>
      )}
    </div>
  );
}

// Which cluster the next new chat's agent runs on. Shown only when the server offers
// more than itself; a session keeps the cluster it was created on.
export function ClusterPicker() {
  const { clusters, cluster } = useAppState((s) => ({ clusters: s.clusters, cluster: s.cluster }), shallowEqual);
  const [open, setOpen] = useState(false);
  if (!clusters || clusters.length <= 1) return null;
  const current = findCluster(clusters, cluster);
  const pick = (id) => {
    setOpen(false);
    if (id !== current.id) chooseCluster(id);
  };
  const describe = (c) => (c.host ? [c.host, c.home].filter(Boolean).join(' · ') : 'This server');
  return (
    <div class="popover-anchor">
      <Chip open={open} setOpen={setOpen} title={`Cluster: ${current.label}${current.host ? ` · ${current.host}` : ''}`} class="chip-cluster">
        <Server size={15} />
        <span class="chip-label">{current.label}</span>
      </Chip>
      {open && (
        <Popover onClose={() => setOpen(false)} label="Cluster" class="picker-popover">
          <div class="popover-group">Run on</div>
          <div role="listbox" aria-label="Cluster">
            {clusters.map((c) => (
              <MenuRow
                key={c.id}
                icon={<Server size={15} />}
                label={c.label}
                description={describe(c)}
                selected={c.id === current.id}
                trailing={c.id === current.id ? check : null}
                onSelect={() => pick(c.id)}
              />
            ))}
          </div>
          <div class="popover-note">The agent runs on that cluster, in its folders.</div>
        </Popover>
      )}
    </div>
  );
}
