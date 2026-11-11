// Permission modes. The UI always works with the v2 names; a v1 server (whose
// /api/info has no `modes` array) only understands yolo | ask | plan, so we map
// names on the way in and out.

const LEGACY_TO_V2 = { yolo: 'bypassPermissions', ask: 'default' };
const V2_TO_LEGACY = { bypassPermissions: 'yolo', default: 'ask', plan: 'plan' };

export const MODE_INFO = {
  default: { label: 'Ask', description: 'Approve commands and edits before they run.', tone: 'neutral' },
  acceptEdits: { label: 'Accept edits', description: 'Edits apply automatically; commands still ask.', tone: 'accent' },
  plan: { label: 'Plan', description: 'Think it through and propose a plan before changing anything.', tone: 'info' },
  auto: { label: 'Auto', description: 'Claude decides when to ask. Claude models only.', tone: 'support' },
  bypassPermissions: { label: 'Bypass', description: 'Run commands and edit files without asking.', tone: 'warning' },
};

// The three modes a v1 server supports, in display order.
export const LEGACY_MODES = ['bypassPermissions', 'default', 'plan'];

export function canonicalMode(mode) {
  return LEGACY_TO_V2[mode] || mode || 'bypassPermissions';
}

export function modeLabel(mode) {
  const id = canonicalMode(mode);
  return MODE_INFO[id]?.label || id;
}

export function modeTone(mode) {
  return MODE_INFO[canonicalMode(mode)]?.tone || 'neutral';
}

// Name to send to the server. v1 servers get legacy names; modes v1 does not know
// fall back to the closest legacy one.
export function wireMode(mode, isV2) {
  const id = canonicalMode(mode);
  if (isV2) return id;
  if (V2_TO_LEGACY[id]) return V2_TO_LEGACY[id];
  return id === 'acceptEdits' ? 'ask' : 'yolo';
}

export function isV2Info(info) {
  return Array.isArray(info?.modes);
}

// Modes the picker offers: from /api/info (v2), restricted to the model's own list
// when it has one, else the v1 trio.
export function availableModes(info, model) {
  if (!isV2Info(info)) {
    return LEGACY_MODES.map((id) => ({ id, ...MODE_INFO[id] }));
  }
  const allowed = Array.isArray(model?.modes) ? new Set(model.modes.map(canonicalMode)) : null;
  return info.modes
    .map((m) => ({ ...MODE_INFO[canonicalMode(m.id)], ...m, id: canonicalMode(m.id) }))
    .filter((m) => !allowed || allowed.has(m.id))
    .map((m) => ({ ...m, label: MODE_INFO[m.id]?.label || m.label || m.id, tone: MODE_INFO[m.id]?.tone || 'neutral' }));
}
