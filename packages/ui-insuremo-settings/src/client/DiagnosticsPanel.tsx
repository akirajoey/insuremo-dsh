import type { ReactNode } from "react";
import type { ImoOverviewView } from "./overview.ts";
import type { InsuremoLocaleKey } from "./locales.ts";

export interface DiagnosticsPanelProps {
  readonly t: (key: InsuremoLocaleKey) => string;
  readonly diagnostics: ImoOverviewView["diagnostics"];
}

/** Read-only fixed diagnostic badges; message keys only, never raw text. */
export function DiagnosticsPanel({ t, diagnostics }: DiagnosticsPanelProps): ReactNode {
  const items = diagnostics.diagnostics;
  return (
    <section aria-labelledby="overview-diagnostics-title">
      <h3 id="overview-diagnostics-title">{t("diagnosticsTitle")}</h3>
      {items.length === 0 ? (
        <p>{t("diagnosticsNone")}</p>
      ) : (
        <ul>
          {items.map(item => (
            <li key={item.id} data-severity={item.severity}>
              {t(item.messageKey as InsuremoLocaleKey)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
