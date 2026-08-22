import { Component, type ReactNode } from "react";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { AuthPanel } from "./AuthPanel.tsx";
import { DiagnosticsPanel } from "./DiagnosticsPanel.tsx";
import { IciPanel } from "./IciPanel.tsx";
import { OverviewPanel } from "./OverviewPanel.tsx";
import { SkillsPanel } from "./SkillsPanel.tsx";
import { OVERVIEW_URL, parseOverview, type ImoOverviewView } from "./overview.ts";
import type { InsuremoLocaleKey } from "./locales.ts";

/** Props supplied by the Settings section slot owner. */
export type InsuremoSectionProps = PropsRuntime<"settings.section"> & PropsLocale<"settings.insuremo">;

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly view: ImoOverviewView }
  | { readonly status: "error" };

/** Read-only InsureMO overview landing page (class-based: no hooks across react copies). */
export class InsuremoSection extends Component<InsuremoSectionProps, LoadState> {
  override state: LoadState = { status: "loading" };
  #controller: AbortController | undefined;

  override componentDidMount(): void {
    void this.load();
  }

  /** Background refresh after an action: keep the previous view mounted. */
  private async reload(): Promise<void> {
    try {
      const response = await fetch(OVERVIEW_URL, { headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const view = parseOverview(await response.json());
      if (view !== null) this.setState({ status: "ready", view });
    } catch { /* keep previous */ }
  }

  override componentWillUnmount(): void {
    this.#controller?.abort();
  }

  private async load(): Promise<void> {
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    this.setState({ status: "loading" });
    try {
      const response = await fetch(OVERVIEW_URL, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`overview fetch failed: ${response.status}`);
      const view = parseOverview(await response.json());
      if (view === null) throw new Error("overview payload was not recognized");
      if (!controller.signal.aborted) this.setState({ status: "ready", view });
    } catch {
      if (!controller.signal.aborted) this.setState({ status: "error" });
    }
  }

  private t(key: InsuremoLocaleKey): string {
    return this.props.t(key);
  }

  override render(): ReactNode {
    const state = this.state;
    const t = this.t.bind(this);
    return (
      <section aria-labelledby="insuremo-settings-title">
        <h2 id="insuremo-settings-title">{t("title")}</h2>
        <div aria-live="polite" role="status">
          {state.status === "loading" ? t("loading") : null}
          {state.status === "error" ? (
            <p>
              <strong>{t("error")}</strong> {t("errorHint")}
            </p>
          ) : null}
        </div>
        {state.status === "ready" ? (
          <>
            <OverviewPanel t={t} imo={state.view.imo} operations={state.view.operations} onChanged={() => void this.reload()} />
            <AuthPanel t={t} auth={state.view.auth} onChanged={() => void this.reload()} />
            <SkillsPanel t={t} skills={state.view.skills} activationRevision={state.view.skills.activationRevision} onChanged={() => void this.reload()} />
            {state.view.ici !== undefined ? <IciPanel t={t} ici={state.view.ici} /> : null}
            <DiagnosticsPanel t={t} diagnostics={state.view.diagnostics} />
          </>
        ) : null}
        <p>
          <button type="button" onClick={() => void this.load()} aria-label={t("refresh")}>
            {t("refresh")}
          </button>
        </p>
      </section>
    );
  }
}
