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
  #autoUpgraded = false;

  override componentDidMount(): void {
    void this.load("fast");
  }

  override componentWillUnmount(): void {
    this.#controller?.abort();
  }

  /** Silent refresh for post-action reloads: keeps regions mounted so child state is preserved. */
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
      if (!controller.signal.aborted) {
        this.setState(prev => ({ ...prev, status: "ready", view }));
        // Cold-start auto-upgrade (TASK-079c): a fast projection carrying any
        // fast-uncached section triggers exactly ONE silent full refresh, so
        // the user never sees a false "CLI not detected" first paint.
        if (channel === "fast" && !this.#autoUpgraded
          && [view.imo.code, view.skills.code, view.auth.code].includes("fast-uncached")) {
          this.#autoUpgraded = true;
          void this.silentReload();
        }
      }
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
    const imoCold = state.status === "ready" && state.view.imo.code === "fast-uncached";
    const skillsCold = state.status === "ready" && state.view.skills.code === "fast-uncached";
    const summary = state.status === "ready"
      ? `${state.view.imo.available ? (state.view.imo.current ?? "—") : imoCold ? t("imoLoading") : state.view.imo.code === "not-found" ? t("imoUnavailable") : t("imoDetectFailed")} · ${state.view.auth.activeProfileName ?? "—"} · ${t("skillsTitle")} ${skillsCold ? "…" : `${state.view.skills.enabled}/${state.view.skills.installed}`}`
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
  if (imo.code === "fast-uncached") {
    // Cold fast projection: loading skeleton, never a false "not detected".
    return (
      <div className={css.region}>
        <h4>{t("imoTitle")}</h4>
        <p className={css.hint} data-skeleton="1" aria-busy="true">{t("imoLoading")}</p>
      </div>
    );
  }
  // Install is offered only on a genuine full-read not-found. Transient or
  // unknown failures (timeout/spawn-failed/unavailable/cancelled/...) render
  // a sanitized detection-failed alert and never an install affordance.
  const missing = !imo.available && imo.code === "not-found";
  const failed = !imo.available && !missing;
  return (
    <div className={css.region}>
      <h4>{t("imoTitle")}</h4>
      <p>
        {t("imoCurrent")}: <code data-imo-state={imo.available ? "ok" : missing ? "missing" : "error"}>{imo.available ? (imo.current ?? "—") : missing ? t("imoUnavailable") : t("imoDetectFailed")}</code>
        {imo.updateAvailable && imo.target !== undefined ? ` → ${imo.target}` : ""}
      </p>
      {failed ? <p role="alert" data-imo-state="error" className={css.error}>{t("imoDetectFailed")}: {imo.code}</p> : null}
      {imo.available ? <UpgradeButton t={t} imo={imo} onChanged={props.onChanged} /> : null}
      {missing ? <InstallButton t={t} onChanged={props.onChanged} /> : null}
    </div>
  );
}

/**
 * One-shot IMO CLI installer (TASK-076): rendered only while the overview
 * reports the CLI unavailable. The visible hint names both side effects —
 * the user-level @insuremo registry write and the global package install —
 * and the failure line explains why retrying without rollback is safe.
 */
class InstallButton extends Component<{ t: Translate; onChanged: () => void }, { install: UpgradeState }> {
  override state: { install: UpgradeState } = { install: { phase: "idle" } };

  private async run(): Promise<void> {
    this.setState({ install: { phase: "busy" } });
    const outcome = await postAction<{ status: string; currentVersion: string | null }>("imo-install", {});
    if (outcome.ok && outcome.result.status === "completed") {
      this.setState({ install: { phase: "done", message: outcome.result.currentVersion ?? "?" } });
      this.props.onChanged();
    } else if (outcome.ok) {
      this.setState({ install: { phase: "failed", message: "post-install probe failed" } });
    } else {
      const message = outcome.error.code === "network" ? this.props.t("errorNetwork") : `${outcome.error.code}: ${outcome.error.message}`;
      this.setState({ install: { phase: "failed", message } });
    }
  }

  override render(): ReactNode {
    const { t } = this.props;
    const busy = this.state.install.phase === "busy";
    return (
      <div>
        <p>
          <button
            type="button"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void this.run()}
            aria-label={busy ? t("cliInstalling") : t("cliInstall")}
          >
            {busy ? t("cliInstalling") : t("cliInstall")}
          </button>
          {this.state.install.phase === "done" ? <span role="status" data-install="done">{t("cliInstalled")}: {this.state.install.message}</span> : null}
          {this.state.install.phase === "failed" ? <span role="alert" data-install="failed" className={css.error}>{t("cliInstallFailed")}: {this.state.install.message}</span> : null}
        </p>
        {this.state.install.phase === "failed" ? (
          <p className={css.hint} data-install-retry="1">{t("cliInstallRetryHint")}</p>
        ) : (
          <p className={css.hint}>{t("cliInstallHint")}</p>
        )}
      </div>
    );
  }
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

/** Allowlisted server scenario ids (TASK-079): no arbitrary agent/source argv. */
const SKILL_SCENARIOS = [
  "icomposer-full-stack", "icomposer-coding-lite", "icomposer-api-design", "uic-developer", "ask-insuremo",
] as const;
type SkillScenarioId = typeof SKILL_SCENARIOS[number];

interface SkillDiff {
  readonly added: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
}

interface SkillActionResultView {
  readonly status: string;
  readonly added?: readonly string[];
  readonly updated?: readonly string[];
  readonly removed?: readonly string[];
}

function diffOf(result: SkillActionResultView): SkillDiff {
  return { added: result.added ?? [], updated: result.updated ?? [], removed: result.removed ?? [] };
}

function diffText(diff: SkillDiff, t: Translate): string {
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`${t("skillsAdded")} ${diff.added.length}: ${diff.added.join(", ")}`);
  if (diff.updated.length > 0) parts.push(`${t("skillsUpdated")} ${diff.updated.length}: ${diff.updated.join(", ")}`);
  if (diff.removed.length > 0) parts.push(`${t("skillsRemoved")} ${diff.removed.length}: ${diff.removed.join(", ")}`);
  return parts.join(" · ");
}

interface ScenarioRunState {
  readonly phase: "idle" | "busy" | "done" | "failed";
  readonly message?: string;
  readonly diff?: SkillDiff;
}

class SkillsRegion extends Component<
  { t: Translate; skills: ImoOverviewView["skills"]; onChanged: () => void },
  {
    rows: Readonly<Record<string, SkillRowState>>;
    updatingAll: boolean;
    updateResult?: SkillActionResultView;
    updateError?: string;
    scenario: SkillScenarioId;
    scenarioRun: ScenarioRunState;
  }
> {
  override state: {
    rows: Readonly<Record<string, SkillRowState>>;
    updatingAll: boolean;
    updateResult?: SkillActionResultView;
    updateError?: string;
    scenario: SkillScenarioId;
    scenarioRun: ScenarioRunState;
  } = { rows: {}, updatingAll: false, scenario: SKILL_SCENARIOS[0], scenarioRun: { phase: "idle" } };

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

  get #busy(): boolean {
    return this.state.updatingAll || this.state.scenarioRun.phase === "busy";
  }

  /** Last-write-wins (TASK-041): server commits on its own revision; no CAS storms. */
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

  /** `imo skills update --all` equivalent: only already-installed sources. */
  private async updateAll(): Promise<void> {
    if (this.#busy) return;
    this.setState({ updatingAll: true, updateError: undefined, updateResult: undefined });
    const outcome = await postAction<SkillActionResultView>("skill-update", {});
    if (outcome.ok) {
      const result = outcome.result;
      // Only status "completed" is success; failed/partial-failure receipts
      // (structured, with any real diff) must render as alerts.
      this.setState({ updatingAll: false, updateResult: result, updateError: result.status === "completed" ? undefined : `${result.status}` });
      this.props.onChanged();
    } else {
      const message = outcome.error.code === "network" ? this.props.t("errorNetwork") : `${outcome.error.code}: ${outcome.error.message}`;
      this.setState({ updatingAll: false, updateError: message });
    }
  }

  /** Explicit install/sync of the selected allowlisted scenario. */
  private async syncScenario(): Promise<void> {
    if (this.#busy) return;
    this.setState({ scenarioRun: { phase: "busy" } });
    const outcome = await postAction<SkillActionResultView>("skill-install", { scenario: this.state.scenario });
    if (outcome.ok) {
      const result = outcome.result;
      const diff = diffOf(result);
      this.setState({
        scenarioRun: result.status === "completed"
          ? { phase: "done", diff }
          : { phase: "failed", message: result.status, diff },
      });
      this.props.onChanged();
    } else {
      const message = outcome.error.code === "network" ? this.props.t("errorNetwork") : `${outcome.error.code}: ${outcome.error.message}`;
      this.setState({ scenarioRun: { phase: "failed", message } });
    }
  }

  override render(): ReactNode {
    const { t, skills } = this.props;
    const entries = skills.entries ?? [];
    const cold = skills.code === "fast-uncached";
    const busy = this.#busy;
    const run = this.state.scenarioRun;
    return (
      <div className={css.region}>
        <h4>{t("skillsTitle")}</h4>
        <div className={css.controls}>
          <label>
            <span className={css.meta}>{t("skillsScenarioLabel")}</span>{" "}
            <select
              className={css.select}
              value={this.state.scenario}
              disabled={busy}
              aria-label={t("skillsScenarioLabel")}
              onChange={event => this.setState({ scenario: event.target.value as SkillScenarioId, scenarioRun: { phase: "idle" } })}
            >
              {SKILL_SCENARIOS.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
          <button
            type="button"
            className={css.action}
            disabled={busy}
            aria-busy={run.phase === "busy" || undefined}
            onClick={() => void this.syncScenario()}
            aria-label={`${t("skillsScenarioInstall")}: ${this.state.scenario}`}
          >
            {run.phase === "busy" ? t("skillsScenarioInstalling") : t("skillsScenarioInstall")}
          </button>
          <button
            type="button"
            className={css.action}
            disabled={busy}
            aria-busy={this.state.updatingAll || undefined}
            onClick={() => void this.updateAll()}
            aria-label={`${t("skillsUpdateAll")} · ${t("skillsScopeHint")}`}
          >
            {this.state.updatingAll ? t("skillsUpdatingAll") : t("skillsUpdateAll")}
          </button>
        </div>
        {run.phase === "done" ? (
          <p role="status" data-scenario="done">{t("skillsScenarioDone")}{run.diff === undefined ? "" : `: ${diffText(run.diff, t)}`}</p>
        ) : null}
        {run.phase === "failed" ? (
          <p role="alert" data-scenario="failed" className={css.error}>
            {t("skillsScenarioFailed")}: {run.message}{run.diff === undefined ? "" : ` · ${diffText(run.diff, t)}`} · {t("skillsRetryHint")}
          </p>
        ) : null}
        {this.state.updateResult !== undefined && this.state.updateResult.status === "completed" ? (
          <p role="status" data-update="done">{t("skillsUpdateDone")}: {diffText(diffOf(this.state.updateResult), t) || "0"}</p>
        ) : null}
        {this.state.updateError !== undefined ? (
          <p role="alert" data-update="failed" className={css.error}>
            {t("skillsUpdateFailed")}: {this.state.updateError}{this.state.updateResult !== undefined && this.state.updateResult.status !== "completed" ? ` · ${diffText(diffOf(this.state.updateResult), t)}` : ""} · {t("skillsRetryHint")}
          </p>
        ) : null}
        {cold ? (
          <p className={css.hint} data-skeleton="1" aria-busy="true">{t("skillsLoadingSlow")}</p>
        ) : entries.length === 0 ? (
          <p>{t("skillsNone")} · {t("skillsInstallFirstHint")}</p>
        ) : (
          <ul className={css.list}>
            {entries.map(entry => {
              const row = this.state.rows[entry.name] ?? {};
              const enabled = row.enabled ?? entry.enabled;
              const rowBusy = row.busy === true || busy;
              return (
                <li key={entry.name}>
                  <button
                    type="button"
                    role="switch"
                    className={css.toggle}
                    aria-checked={enabled}
                    aria-busy={row.busy === true || undefined}
                    aria-label={`${t("skillsToggle")}: ${entry.name}`}
                    disabled={rowBusy}
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
        <p className={css.hint}>{t("skillsScopeHint")}</p>
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
