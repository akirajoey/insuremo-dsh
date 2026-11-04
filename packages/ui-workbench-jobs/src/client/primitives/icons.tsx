/** Plugin-owned icon set (TASK-168a): 14px outline mark used by job rows. */
import type { SVGProps } from "react";

/** Outline API glyph; decorative, sized by the caller. */
export function IconApiOutlineRegular({ size = 16, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={props["aria-hidden"] ?? true}
    >
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M9 9h6v6H9z" />
    </svg>
  );
}
