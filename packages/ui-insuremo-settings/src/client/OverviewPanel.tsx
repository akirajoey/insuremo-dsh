import { Component, type ReactNode } from "react";
import type { ImoOverviewView } from "./overview.ts";
import type { InsuremoLocaleKey } from "./locales.ts";
import { postAction } from "./actions.ts";

export interface OverviewPanelProps {
  readonly t: (key: InsuremoLocaleKey) => string;
  readonly imo: ImoOverviewView["imo"];
  readonly operations: ImoOverviewView["operations"];
  /** Called after a successful upgrade so the section refetches. */
  readonly onChanged?: () => void;
}

type UpgradeState =
  | { readonly phase: "idle" }
  | { readonly phase: "busy" }
  | { readonly phase: "done"; readonly from: string; readonly to: string }
  | { readonly phase: "failed"; readonly message: string };

/** IMO CLI panel with the approval-gated upgrade button + operation counts. */
export class OverviewPanel extends Component<OverviewPanelProps, { upgrade: UpgradeState }> {
  override state: { upgrade: UpgradeState } = { upgrade: { phase: "idle" } };

  private async runUpgrade(): Promise<void> {
    this.setState({ upgrade: { phase: "busy" } });
    const outcome = await postAction<{ status: string; currentVersion: string | null; targetVersion: string | null }>("imo-upgrade", {});
    if (outcome.ok) {
      this.setState({ upgrade: { phase: "done", from: this.props.imo.current ?? "?", to: outcome.result.currentVersion ?? this.props.imo.target ?? "?" } });
      this.props.onChanged?.();
    } else {
      const message = outcome.error.code === "network" ? this.props.t("errorNetwork") : `${outcome.error.code}: ${outcome.error.message}`;
      this.setState({ upgrade: { phase: "failed", message } });
    }
  }

  override render(): ReactNode {
    const { t, imo, operations } = this.props;
    const busy = imo.busy === true || this.state.upgrade.phase === "busy";
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
        {imo.available && imo.updateAvailable ? (
          <p>
            <button type="button" disabled={busy} onClick={() => void this.runUpgrade()} aria-label={busy ? t("cliUpdating") : t("cliUpdate")}>
              {busy ? t("cliUpdating") : t("cliUpdate")}
            </button>
            {this.state.upgrade.phase === "done" ? (
              <span role="status" aria-live="polite" data-upgrade="done">{t("cliUpdated")}: {this.state.upgrade.from} → {this.state.upgrade.to}</span>
            ) : null}
            {this.state.upgrade.phase === "failed" ? (
              <span role="alert" data-upgrade="failed" style={{ color: "#c0392b" }}>{t("cliUpdateFailed")}: {this.state.upgrade.message}</span>
            ) : null}
          </p>
        ) : null}

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
}
