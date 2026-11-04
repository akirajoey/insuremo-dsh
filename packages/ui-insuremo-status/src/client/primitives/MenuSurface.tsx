/** Plugin-owned menu surface (TASK-168a). No portal/backing: the caller owns placement. */
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import css from "./MenuSurface.module.css";

export interface MenuSurfaceProps extends ComponentPropsWithoutRef<"div"> {
  compact?: boolean;
}

/** Rounded menu material with optional compact geometry. */
export const MenuSurface = forwardRef<HTMLDivElement, MenuSurfaceProps>(function MenuSurface({
  compact = false,
  className,
  children,
  ...props
}, ref) {
  const classes = [css.surface, compact ? css.compact : undefined, className].filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
  return <div {...props} ref={ref} className={classes}>{children}</div>;
});
