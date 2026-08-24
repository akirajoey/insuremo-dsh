import type { ReactNode } from "react";

/**
 * Down-chevron disclosure icon mirroring the platform's
 * `IconChevronDownOutline14` (14px outline chevron). Inlined so the card
 * bundle keeps zero non-platform dependencies; the CSS rotation animates
 * the open state exactly like the official PluginCard.
 */
export function ChevronIcon(props: { className?: string }): ReactNode {
  return (
    <svg className={props.className} width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3.5 5.25 7 8.75l3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
