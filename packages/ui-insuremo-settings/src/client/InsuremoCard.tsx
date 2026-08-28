import { Component, type ReactNode } from "react";
import { ChevronIcon } from "./ChevronIcon.tsx";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { OVERVIEW_URL, parseOverview, type ImoOverviewView } from "./overview.ts";
import { postAction } from "./actions.ts";
import type { InsuremoLocaleKey } from "./locales.ts";
import css from "./InsuremoCard.module.css";

/** Props supplied by the Plugins tab card slot owner (settings.plugin.item). */
export type InsuremoCardProps = PropsRuntime<"settings.plugin.item">
  & PropsLocale<"settings.insuremo">;

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly view: ImoOverviewView }
  | { readonly status: "error" };

/**
 * The InsureMO card inside the Plugins settings tab (TASK-041): collapsed by
 * default to a one-line summary (CLI version · default profile · skills
 * count); expanding reveals the IMO CLI / Skills / Code Intelligence regions.
 * The Auth region was removed — the sidebar ProfilePicker owns profile
 * switching. Data loads through the fast channel (`?fast=1`); the Refresh
 * button builds the full CLI-backed view.
 */
export class InsuremoCard extends Component<InsuremoCardProps, LoadState & { expanded: boolean }> {
  override state: LoadState & { expanded: boolean } = { status: "loading", expanded: false };
  #controller: AbortController | undefined;

  override componentDidMount(): void {
    void this.load("fast");
  }

  override componentWillUnmount(): void {
    this.#controller?.abort();
  }

  /** Silent refresh for post-action reloads: keeps regions mounted so child
   * state (upgrade success lines, per-skill errors) is not destroyed. */
  private async silentReload(): Promise<void> {
    try {
      const response = await fetch(`${OVERVIEW_URL}?fast=0`, { headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const view = parseOverview(await response.json());
      if (view !== null) this.setState(prev => ({ ...prev, status: "ready", view }));
    } catch { /* keep previous */ }
  }

  private async load(channel: "fast" | "full"): Promise<void> {
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    if (channel === "full") this.setState({ status: "loading" });
    try {
      const response = await fetch(`${OVERVIEW_URL}?fast=${channel === "fast" ? "1" : "0"}`, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`overview fetch failed: ${response.status}`);
      const view = parseOverview(await response.json());
      if (view === null) throw new Error("overview payload was not recognized");
      if (!controller.signal.aborted) this.setState(prev => ({ ...prev, status: "ready", view }));
    } catch {
      if (!controller.signal.aborted && this.state.status !== "ready") this.setState({ status: "error" });
    }
  }

  private t(key: InsuremoLocaleKey): string {
    return this.props.t(key);
  }

  override render(): ReactNode {
    const state = this.state;
    const t = this.t.bind(this);
    const summary = state.status === "ready"
      ? `${state.view.imo.available ? (state.view.imo.current ?? "—") : t("imoUnavailable")} · ${state.view.auth.activeProfileName ?? "—"} · ${t("skillsTitle")} ${state.view.skills.enabled}/${state.view.skills.installed}`
      : state.status === "loading" ? t("loading") : t("error");
    return (
      <section className={`${css.card}${state.expanded ? ` ${css.cardOpen}` : ""}`}>
        <button
          type="button"
          className={css.header}
          aria-expanded={state.expanded}
          aria-label={`${t(state.expanded ? "collapse" : "expand")}: ${t("title")}`}
          onClick={() => this.setState(prev => ({ ...prev, expanded: !prev.expanded }))}
        >
          <span className={css.headText}>
            <span className={css.name}>{t("title")}</span>
            <span className={css.description} data-summary="1">{summary}</span>
          </span>
          {state.status === "ready" && state.view.imo.updateAvailable ? <span className={css.pending}>{t("imoUpdateAvailable")}</span> : null}
          <ChevronIcon className={`${css.chevron}${state.expanded ? ` ${css.chevronOpen}` : ""}`} />
        </button>
        {state.expanded ? (
          <div className={css.body}>
            {state.status === "loading" ? (
              <p className={css.hint} data-skeleton="1" aria-busy="true">{t("loading")}</p>
            ) : null}
            {state.status === "error" ? <p className={css.error}>{t("error")}</p> : null}
            {state.status === "ready" ? (
              <>
                <ImoRegion t={t} imo={state.view.imo} onChanged={() => void this.silentReload()} />
                <SkillsRegion t={t} skills={state.view.skills} onChanged={() => void this.silentReload()} />
                {state.view.ici !== undefined ? <IciRegion t={t} ici={state.view.ici} /> : null}
              </>
            ) : null}
            <div className={css.footer}>
              <button type="button" className={css.refresh} onClick={() => void this.load("full")} aria-label={t("refresh")}>{t("refresh")}</button>
            </div>
          </div>
        ) : null}
      </section>
    );
  }
}

type Translate = (key: InsuremoLocaleKey) => string;

function ImoRegion(props: { t: Translate; imo: ImoOverviewView["imo"]; onChanged: () => void }): ReactNode {
  const { t, imo } = props;
  return (
    <div className={css.region}>
      <h4>{t("imoTitle")}</h4>
      <p>
        {t("imoCurrent")}: <code>{imo.available ? (imo.current ?? "—") : t("imoUnavailable")}</code>
        {imo.updateAvailable && imo.target !== undefined ? ` → ${imo.target}` : ""}
      </p>
      <UpgradeButton t={t} imo={imo} onChanged={props.onChanged} />
    </div>
  );
}

interface UpgradeState {
  readonly phase: "idle" | "busy" | "done" | "failed";
  readonly message?: string;
}

class UpgradeButton extends Component<{ t: Translate; imo: ImoOverviewView["imo"]; onChanged: () => void }, { upgrade: UpgradeState }> {
  override state: { upgrade: UpgradeState } = { upgrade: { phase: "idle" } };

  private async run(): Promise<void> {
    this.setState({ upgrade: { phase: "busy" } });
    const outcome = await postAction<{ status: string; currentVersion: string | null }>("imo-upgrade", {});
    if (outcome.ok) {
      this.setState({ upgrade: { phase: "done", message: `${this.props.imo.current ?? "?"} → ${outcome.result.currentVersion ?? "?"}` } });
      this.props.onChanged();
    } else {
      const message = outcome.error.code === "network" ? this.props.t("errorNetwork") : `${outcome.error.code}: ${outcome.error.message}`;
      this.setState({ upgrade: { phase: "failed", message } });
    }
  }

  override render(): ReactNode {
    const { t, imo } = this.props;
    const busy = imo.busy === true || this.state.upgrade.phase === "busy";
    if (!imo.available || !imo.updateAvailable) return null;
    return (
      <p>
        <button type="button" disabled={busy} onClick={() => void this.run()} aria-label={busy ? t("cliUpdating") : t("cliUpdate")}>
          {busy ? t("cliUpdating") : t("cliUpdate")}
        </button>
        {this.state.upgrade.phase === "done" ? <span role="status" data-upgrade="done">{t("cliUpdated")}: {this.state.upgrade.message}</span> : null}
        {this.state.upgrade.phase === "failed" ? <span role="alert" data-upgrade="failed" className={css.error}>{t("cliUpdateFailed")}: {this.state.upgrade.message}</span> : null}
      </p>
    );
  }
}

interface SkillRowState {
  readonly enabled?: boolean;
  readonly busy?: boolean;
  readonly error?: string;
  readonly retry?: boolean;
}

class SkillsRegion extends Component<{ t: Translate; skills: ImoOverviewView["skills"]; onChanged: () => void }, { rows: Readonly<Record<string, SkillRowState>>; updatingAll: boolean }> {
  override state: { rows: Readonly<Record<string, SkillRowState>>; updatingAll: boolean } = { rows: {}, updatingAll: false };

  override componentDidUpdate(): void {
    // Keep a successful optimistic value visible until silentReload delivers
    // the authoritative parent props. Then remove only the override, keeping
    // any row error/busy metadata intact.
    const confirmed = new Set(
      (this.props.skills.entries ?? []).filter(entry => {
        const row = this.state.rows[entry.name];
        return row?.enabled !== undefined && row.enabled === entry.enabled;
      }).map(entry => entry.name),
    );
    if (confirmed.size === 0) return;
    this.setState(prev => {
      const rows = { ...prev.rows };
      for (const name of confirmed) {
        const row = rows[name];
        if (row === undefined || row.enabled === undefined) continue;
        const { enabled: _enabled, ...rest } = row;
        rows[name] = rest;
      }
      return { ...prev, rows };
    });
  }

  /**
   * Last-write-wins (TASK-041): no expectedRevision is sent — the server
   * commits against its own latest revision and returns the new one, which
   * removes the revision-conflict storms when the card holds a stale view.
   */
  private async toggle(name: string, next: boolean, previous: boolean): Promise<void> {
    // Optimistically move the thumb and lock only this row while the action is
    // in flight. A failed request restores the server value explicitly.
    this.setState(prev => ({ rows: { ...prev.rows, [name]: { enabled: next, busy: true } } }));
    const outcome = await postAction<{ revision: number }>("skill-activation", { name, enabled: next });
    if (outcome.ok) {
      // Keep the optimistic value while the parent's silent reload is still
      // returning; otherwise the old entry prop briefly flashes back.
      this.setState(prev => ({ rows: { ...prev.rows, [name]: { enabled: next, busy: false } } }));
      this.props.onChanged();
    } else {
      const conflict = outcome.error.code === "revision-conflict";
      const network = outcome.error.code === "network";
      const message = network ? this.props.t("errorNetwork") : `${outcome.error.code}: ${outcome.error.message}`;
      this.setState(prev => ({ rows: { ...prev.rows, [name]: { enabled: previous, error: message, ...(conflict ? { retry: true } : {}) } } }));
      if (conflict) this.props.onChanged();
    }
  }

  private async updateAll(): Promise<void> {
    this.setState({ updatingAll: true });
    const outcome = await postAction<{ status: string }>("skill-update", { name: "__all__" });
    this.setState({ updatingAll: false });
    if (outcome.ok) this.props.onChanged();
  }

  override render(): ReactNode {
    const { t, skills } = this.props;
    const entries = skills.entries ?? [];
    const cold = skills.code === "fast-uncached";
    return (
      <div className={css.region}>
        <h4>{t("skillsTitle")}</h4>
        <p>
          <button type="button" disabled={this.state.updatingAll} onClick={() => void this.updateAll()} aria-label={t("skillsUpdateAll")}>
            {this.state.updatingAll ? t("skillsUpdatingAll") : t("skillsUpdateAll")}
          </button>
        </p>
        {cold ? (
          <p className={css.hint} data-skeleton="1" aria-busy="true">{t("skillsLoadingSlow")}</p>
        ) : entries.length === 0 ? (
          <p>{t("skillsNone")} · <code>imo skills install</code></p>
        ) : (
          <ul className={css.list}>
            {entries.map(entry => {
              const row = this.state.rows[entry.name] ?? {};
              const enabled = row.enabled ?? entry.enabled;
              const busy = row.busy === true;
              return (
                <li key={entry.name}>
                  <button
                    type="button"
                    role="switch"
                    className={css.toggle}
                    aria-checked={enabled}
                    aria-busy={busy || undefined}
                    aria-label={`${t("skillsToggle")}: ${entry.name}`}
                    disabled={busy}
                    onClick={() => void this.toggle(entry.name, !enabled, entry.enabled)}
                  >
                    <span className={css.controlTrack} aria-hidden="true"><span className={css.controlThumb} /></span>
                  </button>
                  <code>{entry.name}</code>
                  {row.error !== undefined ? <span role="alert" className={css.error}>{row.error}{row.retry === true ? ` · ${t("skillsRetryHint")}` : ""}</span> : null}
                </li>
              );
            })}
          </ul>
        )}
        <p className={css.hint}>{t("skillsCliHint")}</p>
      </div>
    );
  }
}

function IciRegion(props: { t: Translate; ici: NonNullable<ImoOverviewView["ici"]> }): ReactNode {
  const { t, ici } = props;
  return (
    <div className={css.region}>
      <h4>{t("iciTitle")}</h4>
      <p>
        {t("iciGraphWorkspaces")}: {ici.graphWorkspaces} · {t("iciExplainWorkspaces")}: {ici.explainWorkspaces}
      </p>
    </div>
  );
}
