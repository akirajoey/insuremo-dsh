import type { ReactNode } from "react";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { InsuremoStatusLocaleKey } from "./locales.ts";
import css from "./StatusBadge.module.css";

/** Props supplied by the sidebar footer-action slot owner. */
export type StatusBadgeProps = PropsRuntime<"sidebar.footer.action">
  & PropsLocale<"sidebar.insuremo">;

/** Static InsureMO status badge; live environment health arrives in a later phase. */
export function StatusBadge({ wide, t }: StatusBadgeProps): ReactNode {
  const label = t("label");
  return (
    <div className={css.badge} data-wide={wide} role="status" aria-label={label}>
      <span className={css.dot} aria-hidden="true" />
      <span className={css.label}>{label}</span>
    </div>
  );
}

export type { InsuremoStatusLocaleKey };
