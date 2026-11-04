/** Plugin-owned state dot (TASK-168a): token colours plus a text/aria signal. */
import css from "./StateDot.module.css";

export type StateDotState = "done" | "warning" | "ongoing" | "error" | "idle";

/**
 * Decorative dot; callers pair it with text (never colour alone). The
 * `data-state` attribute carries the semantic for styling and tests.
 */
export function StateDot({ state, size, className }: {
  state: StateDotState;
  size?: number | undefined;
  className?: string | undefined;
}) {
  const edge = size ?? (state === "ongoing" ? 14 : 10);
  const classes = [css.dot, className].filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
  if (state === "ongoing") {
    return (
      <svg className={[css.spinner, className].filter(Boolean).join(" ")} data-state="ongoing" width={edge} height={edge} viewBox="0 0 24 24" aria-hidden="true">
        <circle className={css.spinnerTrack} cx="12" cy="12" r="9.5" />
        <circle className={css.spinnerArc} cx="12" cy="12" r="9.5" />
      </svg>
    );
  }
  return <span className={classes} data-state={state} style={{ width: edge, height: edge }} aria-hidden="true" />;
}
