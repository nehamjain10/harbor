// The segmented control that picks which file (user, project, local, ...) a tab edits.
export function ScopeSwitch({ scopes, value, onChange, label }) {
  return (
    <div class="segmented scope-switch" role="radiogroup" aria-label={label}>
      {scopes.map((scope) => (
        <button type="button" key={scope.id} role="radio" aria-checked={String(value === scope.id)} aria-pressed={String(value === scope.id)} onClick={() => value !== scope.id && onChange(scope.id)}>
          {scope.label}
        </button>
      ))}
    </div>
  );
}
