import type { ReactNode } from "react";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";

/** Props supplied by the Settings section slot owner. */
export type InsuremoSectionProps = PropsRuntime<"settings.section"> & PropsLocale<"settings.insuremo">;

/** Empty InsureMO landing page; later tasks will add settings and diagnostics. */
export function InsuremoSection({ t }: InsuremoSectionProps): ReactNode {
  return (
    <section aria-labelledby="insuremo-settings-title">
      <h2 id="insuremo-settings-title">{t("title")}</h2>
      <p>{t("placeholder")}</p>
      <output aria-label={t("status")}>{t("status")}</output>
    </section>
  );
}
