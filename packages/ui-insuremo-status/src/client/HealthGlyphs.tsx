import type { ReactNode } from "react";

/**
 * Consistent 16×16 inline health glyphs (TASK-044 A). All three share the
 * same viewBox and stroke style, use `currentColor` so the CSS state tokens
 * (`--dsw-alias-state-*` / `--dsw-alias-label-*`) color them, and are never
 * opaque squares/dots.
 */

function baseProps(): Record<string, string | number> {
  return {
    width: "16",
    height: "16",
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.3",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": "true",
  };
}

/** iComposer: rounded hexagonal ring with a lowercase "i" code mark. */
export function IcomposerGlyph(props: { className?: string }): ReactNode {
  return (
    <svg {...baseProps()} className={props.className}>
      {/* rounded hex ring */}
      <path d="M8 1.7l5.3 3.05c.35.2.56.57.56.96v4.58c0 .4-.21.77-.56.96L8 14.3l-5.3-3.05C2.35 11.05 2.14 10.68 2.14 10.3V5.7c0-.4.21-.77.56-.96L8 1.7z" />
      {/* lowercase i code mark */}
      <path d="M8 5.4v5" />
      <path d="M8 4.4h.01" />
    </svg>
  );
}

/** Graph: three nodes with two connecting edges. */
export function GraphGlyph(props: { className?: string }): ReactNode {
  return (
    <svg {...baseProps()} className={props.className}>
      <circle cx="4" cy="4" r="1.5" />
      <circle cx="12" cy="4" r="1.5" />
      <circle cx="9.5" cy="11.5" r="1.5" />
      <path d="M5.2 4.9l1.5.8" />
      <path d="M10.6 5.2l1 .6" />
      <path d="M9 6.6 8.4 9.9" />
    </svg>
  );
}

/** Intelligence: spark/orbit, not a plain dot. */
export function IntelligenceGlyph(props: { className?: string }): ReactNode {
  return (
    <svg {...baseProps()} className={props.className}>
      <ellipse cx="8" cy="8" rx="5.6" ry="3.4" transform="rotate(-20 8 8)" />
      <path d="M8 1.2l1 2.2 2.2.9-2.2 1-1 2.2-1-2.2-2.2-1 2.2-.9z" />
      <circle cx="4.4" cy="10.8" r="1" />
    </svg>
  );
}
