import theme from "../common/theme.css" with { type: "text" };

export const CARD_THEME_CSS = `${theme.replace(":root", ":host")}
:host, :host([data-sb-theme]) {
  --sb-surface: var(--surface);
  --sb-surface-muted: var(--surface-muted);
  --sb-surface-hover: var(--surface-hover);
  --sb-ink: var(--ink);
  --sb-ink-body: var(--ink);
  --sb-ink-muted: var(--ink-muted);
  --sb-ink-subtle: var(--ink-subtle);
  --sb-outline: var(--outline);
  --sb-divider: var(--outline);
  --sb-accent: var(--primary);
  --sb-accent-hover: var(--primary-hover);
  --sb-accent-tint: var(--primary-tint);
  --sb-accent-tint-strong: color-mix(in srgb, var(--primary) 25%, var(--surface));
  --sb-accent-border: color-mix(in srgb, var(--primary) 50%, var(--surface));
  --sb-source: var(--primary);
  --sb-field: var(--primary);
  --sb-jlpt-bg: var(--primary-tint);
  --sb-jlpt-fg: var(--primary);
  --sb-known-btn: var(--ink-subtle);
  --sb-known-btn-hover: var(--ink-muted);
  --sb-on-solid: var(--on-primary);
  --sb-chip-bg: color-mix(in srgb, var(--ink) 8%, transparent);
  --sb-chip-bg-strong: color-mix(in srgb, var(--ink) 15%, transparent);
  --sb-chip-border: color-mix(in srgb, var(--ink) 25%, transparent);
}
`;
