import type { ReactNode } from "react";
import type { ImoOverviewView } from "./overview.ts";
import type { InsuremoLocaleKey } from "./locales.ts";

export interface OverviewPanelProps {
  readonly t: (key: InsuremoLocaleKey) => string;
  readonly imo: ImoOverviewView["imo"];
  readonly operations: ImoOverviewView["operations"];
}

/** IMO CLI + operation counts read-only panels. */
export function OverviewPanel({ t, imo, operations }: OverviewPanelProps): ReactNode {
  return (
    <section aria-labelledby="overview-imo-title">
      <h3 id="overview-imo-title">{t("imoTitle")}</h3>
      <table aria-label={t("imoTitle")}>
        <tbody>
          <tr>
            <th scope="row">{t("imoCurrent")}</th>
            <td>{imo.available ? (imo.current ?? "—") : t("imoUnavailable")}</td>
          </tr>
          {imo.available && imo.updateAvailable && (
            <tr>
              <th scope="row">{t("imoTarget")}</th>
              <td>{imo.target ?? "—"}</td>
            </tr>
          )}
          <tr>
            <th scope="row">{t("imoUpdateAvailable")}</th>
            <td>{imo.available ? (imo.updateAvailable ? t("yes") : t("no")) : "—"}</td>
          </tr>
        </tbody>
      </table>

      <h3>{t("operationsTitle")}</h3>
      <table aria-label={t("operationsTitle")}>
        <tbody>
          <tr><th scope="row">{t("operationsPending")}</th><td>{operations.pending}</td></tr>
          <tr><th scope="row">{t("operationsApproved")}</th><td>{operations.approved}</td></tr>
          <tr><th scope="row">{t("operationsRejected")}</th><td>{operations.rejected}</td></tr>
          <tr><th scope="row">{t("operationsRecorded")}</th><td>{operations.recorded}</td></tr>
        </tbody>
      </table>
    </section>
  );
}
