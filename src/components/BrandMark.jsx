// Harbor's mark: a faceted sailing ship in lime (as public/favicon.svg, which sets it
// on a dark tile). Traced from a Codex image-generation concept; the points are in that
// image's 1024 px space and the group scales them into the 64 px box. Each facet is
// stroked in its own shade so neighbours meet without anti-aliasing seams.
const FACETS = [
  ['443,263 220,608 378,500', 'var(--mark-1)'],
  ['220,608 428,632 378,500', 'var(--mark-3)'],
  ['443,263 378,500 428,632', 'var(--mark-5)'],
  ['473,153 680,378 572,403', 'var(--mark-1)'],
  ['473,153 572,403 473,628', 'var(--mark-3)'],
  ['572,403 680,378 818,622 640,555', 'var(--mark-2)'],
  ['572,403 640,555 473,628', 'var(--mark-5)'],
  ['473,628 640,555 818,622', 'var(--mark-6)'],
  ['130,678 375,645 330,712', 'var(--mark-2)'],
  ['375,645 470,680 330,712', 'var(--mark-4)'],
  ['330,712 470,680 905,630 640,713', 'var(--mark-1)'],
  ['130,678 330,712 262,825', 'var(--mark-6)'],
  ['330,712 560,757 708,825 262,825', 'var(--mark-5)'],
  ['330,712 640,713 560,757', 'var(--mark-3)'],
  ['640,713 905,630 708,825', 'var(--mark-2)'],
  ['560,757 640,713 708,825', 'var(--mark-4)'],
];

export function BrandMark({ size = 28, class: className = '' }) {
  return (
    <svg class={`brand-mark ${className}`} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <g transform="translate(32 32) scale(0.08) translate(-517.5 -489)" stroke-width="3" stroke-linejoin="round">
        {FACETS.map(([points, fill]) => (
          <polygon key={points} points={points} fill={fill} stroke={fill} />
        ))}
      </g>
    </svg>
  );
}
