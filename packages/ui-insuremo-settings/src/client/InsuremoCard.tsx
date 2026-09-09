import { Component, type ReactNode } from "react";
import { ChevronIcon } from "./ChevronIcon.tsx";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import {
  OVERVIEW_URL,
  SKILL_CATALOG_URL,
  parseOverview,
  parseSkillCatalog,
  type ImoOverviewView,
  type OverviewSkillDiagnosticView,
  type SkillCatalogEntryView,
  type SkillCatalogView,
} from "./overview.ts";
import { postAction } from "./actions.ts";
import { buildDiagnosisText, handOffDiagnosis, waitForDiagnosisPrefill, type DiagnosisActionPayload, type DiagnosisFaces } from "./diagnosis.ts";
import type { InsuremoLocaleKey } from "./locales.ts";
import css from "./InsuremoCard.module.css";

/** Props supplied by the Plugins tab card slot owner (settings.plugin.item). */
export type InsuremoCardProps = PropsRuntime<"settings.plugin.item">
  & PropsLocale<"settings.insuremo">
  & { /** Narrow sessions face for the diagnosis hand-off (wired by apply; tests inject a double). */
      diagnosisFaces?: DiagnosisFaces };

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
                <ImoRegion t={t} imo={state.view.imo} onChanged={() => void this.silentReload()} faces={this.props.diagnosisFaces} />
                <SkillsRegion t={t} skills={state.view.skills} onChanged={() => void this.silentReload()} faces={this.props.diagnosisFaces} />
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

function ImoRegion(props: { t: Translate; imo: ImoOverviewView["imo"]; onChanged: () => void; faces?: DiagnosisFaces }): ReactNode {
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
      {imo.available ? <UpgradeButton t={t} imo={imo} onChanged={props.onChanged} faces={props.faces} /> : null}
      {missing ? <InstallButton t={t} onChanged={props.onChanged} faces={props.faces} /> : null}
    </div>
  );
}

/**
 * One-shot IMO CLI installer (TASK-076): rendered only while the overview
 * reports the CLI unavailable. The visible hint names both side effects —
 * the user-level @insuremo registry write and the global package install —
 * and the failure line explains why retrying without rollback is safe.
 */
class InstallButton extends Component<{ t: Translate; onChanged: () => void; faces?: DiagnosisFaces }, { install: UpgradeState }> {
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
          <p className={css.hint} data-install-retry="1">{t("cliInstallRetryHint")} <DiagnoseButton t={t} kind="imo-cli" faces={this.props.faces} /></p>
        ) : (
          <p className={css.hint}>{t("cliInstallHint")}</p>
        )}
      </div>
    );
  }
}

/**
 * One failure state's 诊断 affordance (TASK-083/088): rendered only while
 * that install/update operation is failed. Clicking fetches the last
 * failure's full capture from the `imo-diagnosis` action, then hands off
 * through the dedicated persistent "install diagnostics" Workspace on
 * official rc.7 seams only (TASK-088): the target session id is what
 * `connectWorkspace` resolves, the prefill lands via the session-scope
 * `inputActions.setDraft` kit, and the status reflects the REAL outcome —
 * a dropped (user-first) or unconfirmed prefill never reports "prefilled".
 * A visible copy button is the always-available fallback. Never rendered on
 * success or without a captured failure; never auto-sends.
 */
class DiagnoseButton extends Component<
  { t: Translate; kind: "imo-cli" | "skill"; faces?: DiagnosisFaces },
  {
    phase: "idle" | "busy" | "prefilled" | "draft-occupied" | "copied" | "clipboard-only" | "no-data" | "failed";
    lastText: string | null;
    copyFlash: boolean;
  }
> {
  override state: {
    phase: "idle" | "busy" | "prefilled" | "draft-occupied" | "copied" | "clipboard-only" | "no-data" | "failed";
    lastText: string | null;
    copyFlash: boolean;
  } = { phase: "idle", lastText: null, copyFlash: false };

  private async run(): Promise<void> {
    this.setState({ phase: "busy" });
    const outcome = await postAction<DiagnosisActionPayload>("imo-diagnosis", { kind: this.props.kind });
    if (!outcome.ok) {
      this.setState({ phase: "failed" });
      return;
    }
    if (!outcome.result.available || outcome.result.diagnosis === undefined || outcome.result.diagnosisCwd === undefined) {
      this.setState({ phase: "no-data" });
      return;
    }
    try {
      const text = buildDiagnosisText(outcome.result.diagnosis, this.props.t);
      const handoff = await handOffDiagnosis(text, outcome.result.diagnosisCwd, this.props.faces, this.props.t("diagWorkspaceTitle"));
      if (handoff.kind === "clipboard-only") {
        this.setState({ phase: "clipboard-only", lastText: text });
        return;
      }
      // Honest status: wait for the real prefill outcome (the session-scope
      // entry writes only while the draft is empty) before claiming success.
      const prefill = await waitForDiagnosisPrefill(handoff.sessionId, 1500);
      if (prefill === "written") {
        this.setState({ phase: "prefilled", lastText: text });
        // Close the settings modal through the shell's own close path so the
        // user lands on the prefilled diagnosis session (owner props supply
        // no close callback; the panel's document-level Escape handler is
        // the one public channel a card can reach).
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        return;
      }
      this.setState({ phase: prefill === "dropped" ? "draft-occupied" : "copied", lastText: text });
    } catch {
      this.setState({ phase: "failed" });
    }
  }

  private copyText(): void {
    const { lastText } = this.state;
    if (lastText === null) return;
    void navigator.clipboard.writeText(lastText)
      .then(() => {
        this.setState({ copyFlash: true });
        setTimeout(() => { this.setState({ copyFlash: false }); }, 1500);
      })
      .catch(() => { /* clipboard unavailable: the hint stays; user can select manually */ });
  }

  override render(): ReactNode {
    const { t } = this.props;
    const busy = this.state.phase === "busy";
    const showCopy = this.state.lastText !== null && (this.state.phase === "prefilled" || this.state.phase === "draft-occupied" || this.state.phase === "copied" || this.state.phase === "clipboard-only");
    return (
      <span data-diagnosis="1">
        {" "}
        <button
          type="button"
          className={css.action}
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={() => void this.run()}
          aria-label={busy ? t("diagBusy") : t("diagButton")}
        >
          {busy ? t("diagBusy") : t("diagButton")}
        </button>
        {this.state.phase === "prefilled" ? <span role="status" data-diagnosis-state="prefilled" className={css.hint}>{t("diagPrefilled")}</span> : null}
        {this.state.phase === "draft-occupied" ? <span role="status" data-diagnosis-state="draft-occupied" className={css.hint}>{t("diagDraftOccupied")}</span> : null}
        {this.state.phase === "copied" ? <span role="status" data-diagnosis-state="copied" className={css.hint}>{t("diagCopied")}</span> : null}
        {this.state.phase === "clipboard-only" ? <span role="status" data-diagnosis-state="clipboard-only" className={css.hint}>{t("diagClipboardOnly")}</span> : null}
        {showCopy ? (
          <button
            type="button"
            className={css.action}
            data-diagnosis-copy="1"
            onClick={() => this.copyText()}
            aria-label={t("diagCopy")}
          >
            {this.state.copyFlash ? t("diagCopyFlash") : t("diagCopy")}
          </button>
        ) : null}
        {this.state.phase === "no-data" ? <span role="alert" data-diagnosis-state="no-data" className={css.error}>{t("diagNoData")}</span> : null}
        {this.state.phase === "failed" ? <span role="alert" data-diagnosis-state="failed" className={css.error}>{t("diagActionFailed")}</span> : null}
      </span>
    );
  }
}

interface UpgradeState {
  readonly phase: "idle" | "busy" | "done" | "failed";
  readonly message?: string;
}

class UpgradeButton extends Component<{ t: Translate; imo: ImoOverviewView["imo"]; onChanged: () => void; faces?: DiagnosisFaces }, { upgrade: UpgradeState }> {
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
        {this.state.upgrade.phase === "failed" ? (
          <span role="alert" data-upgrade="failed" className={css.error}>
            {t("cliUpdateFailed")}: {this.state.upgrade.message} <DiagnoseButton t={t} kind="imo-cli" faces={this.props.faces} />
          </span>
        ) : null}
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
const SCENARIO_DESCRIPTION_KEYS: Record<SkillScenarioId, InsuremoLocaleKey> = {
  "icomposer-full-stack": "skillsCatalogDescriptionFullStack",
  "icomposer-coding-lite": "skillsCatalogDescriptionCodingLite",
  "icomposer-api-design": "skillsCatalogDescriptionApiDesign",
  "uic-developer": "skillsCatalogDescriptionUic",
  "ask-insuremo": "skillsCatalogDescriptionAsk",
};

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

type CatalogState =
  | { readonly phase: "idle" | "loading" }
  | { readonly phase: "ready"; readonly view: SkillCatalogView }
  | { readonly phase: "unavailable"; readonly message?: string };

function catalogKey(entry: Pick<SkillCatalogEntryView, "type" | "name">): string {
  return `${entry.type}:${entry.name}`;
}

class SkillsRegion extends Component<
  { t: Translate; skills: ImoOverviewView["skills"]; onChanged: () => void; faces?: DiagnosisFaces },
  {
    rows: Readonly<Record<string, SkillRowState>>;
    updatingAll: boolean;
    updateResult?: SkillActionResultView;
    updateError?: string;
    scenario: SkillScenarioId;
    scenarioRun: ScenarioRunState;
    catalog: CatalogState;
    catalogQuery: string;
    catalogChoice?: string;
  }
> {
  override state: {
    rows: Readonly<Record<string, SkillRowState>>;
    updatingAll: boolean;
    updateResult?: SkillActionResultView;
    updateError?: string;
    scenario: SkillScenarioId;
    scenarioRun: ScenarioRunState;
    catalog: CatalogState;
    catalogQuery: string;
    catalogChoice?: string;
  } = {
    rows: {},
    updatingAll: false,
    scenario: SKILL_SCENARIOS[0],
    scenarioRun: { phase: "idle" },
    catalog: { phase: "idle" },
    catalogQuery: "",
  };
  #catalogController: AbortController | undefined;
  #catalogRequest = 0;

  override componentDidMount(): void {
    // Opening the expanded card is the explicit discovery affordance. It uses
    // a POST refresh action (which may invoke npx); the separate GET bridge is
    // cache-only and is never called for every search/render.
    void this.loadCatalog(false);
  }

  override componentWillUnmount(): void {
    this.#catalogController?.abort();
  }

  private commitCatalog(view: SkillCatalogView, controller: AbortController, request: number): void {
    if (controller.signal.aborted || request !== this.#catalogRequest) return;
    const currentChoice = this.state.catalogChoice;
    const choice = currentChoice !== undefined && view.entries.some(entry => catalogKey(entry) === currentChoice)
      ? currentChoice
      : catalogKey(view.entries[0]!);
    this.setState(prev => ({ ...prev, catalog: { phase: "ready", view }, catalogChoice: choice }));
  }

  private async loadCatalog(force: boolean): Promise<void> {
    this.#catalogController?.abort();
    const controller = new AbortController();
    const request = ++this.#catalogRequest;
    this.#catalogController = controller;
    this.setState(prev => ({ ...prev, catalog: { phase: "loading" } }));

    // First consult the Host cache. This GET is intentionally side-effect
    // free; a cache miss then performs the explicit POST refresh associated
    // with opening the install area.
    if (!force) {
      try {
        const response = await fetch(SKILL_CATALOG_URL, { signal: controller.signal, headers: { Accept: "application/json" } });
        if (response.ok) {
          const view = parseSkillCatalog(await response.json());
          if (view !== null) {
            this.commitCatalog(view, controller, request);
            return;
          }
        }
      } catch { /* cache miss/network failure: continue to explicit refresh */ }
      if (controller.signal.aborted || request !== this.#catalogRequest) return;
    }

    const outcome = await postAction<SkillCatalogView>("skill-catalog-refresh", { force }, controller.signal);
    if (controller.signal.aborted || request !== this.#catalogRequest) return;
    if (!outcome.ok) {
      this.setState(prev => ({ ...prev, catalog: { phase: "unavailable", message: `${outcome.error.code}: ${outcome.error.message}` } }));
      return;
    }
    const view = parseSkillCatalog(outcome.result);
    if (view === null) {
      this.setState(prev => ({ ...prev, catalog: { phase: "unavailable", message: this.props.t("skillsCatalogUnavailable") } }));
      return;
    }
    this.commitCatalog(view, controller, request);
  }

  private catalogDescription(entry: SkillCatalogEntryView, t: Translate): string {
    if (entry.type !== "scenario") return entry.description;
    const key = SCENARIO_DESCRIPTION_KEYS[entry.name as SkillScenarioId];
    return key === undefined ? entry.description : t(key);
  }

  private filteredCatalog(view: SkillCatalogView, t: Translate): readonly SkillCatalogEntryView[] {
    const query = this.state.catalogQuery.trim().toLocaleLowerCase();
    if (query.length === 0) return view.entries;
    return view.entries.filter(entry => {
      const typeLabel = entry.type === "scenario" ? t("skillsCatalogScenario") : t("skillsCatalogSkill");
      return `${entry.name} ${this.catalogDescription(entry, t)} ${entry.type} ${typeLabel} ${entry.group ?? ""}`.toLocaleLowerCase().includes(query);
    });
  }

  private selectedCatalog(view: SkillCatalogView, visible: readonly SkillCatalogEntryView[] = view.entries): SkillCatalogEntryView | undefined {
    const selected = view.entries.find(entry => catalogKey(entry) === this.state.catalogChoice);
    return selected !== undefined && visible.some(entry => catalogKey(entry) === catalogKey(selected)) ? selected : visible[0];
  }

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
    return this.state.updatingAll || this.state.scenarioRun.phase === "busy" || this.state.catalog.phase === "loading";
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

  /** Explicit install/sync of the selected scenario or exact catalog Skill. */
  private async syncSelected(): Promise<void> {
    if (this.#busy) return;
    const catalog = this.state.catalog;
    const selected = catalog.phase === "ready"
      ? this.selectedCatalog(catalog.view, this.filteredCatalog(catalog.view, key => this.props.t(key)))
      : undefined;
    const payload = selected === undefined
      ? { scenario: this.state.scenario }
      : selected.type === "scenario" ? { scenario: selected.name } : { skill: selected.name };
    this.setState({ scenarioRun: { phase: "busy" } });
    const outcome = await postAction<SkillActionResultView>("skill-install", payload);
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
      const catalogFailure = outcome.error.code === "catalog-unavailable" || outcome.error.code === "catalog-selection-invalid";
      const message = outcome.error.code === "network" ? this.props.t("errorNetwork") : `${outcome.error.code}: ${outcome.error.message}`;
      this.setState(prev => ({
        ...prev,
        ...(catalogFailure ? { catalog: { phase: "unavailable", message: this.props.t("skillsCatalogUnavailable") } } : {}),
        scenarioRun: { phase: "failed", message },
      }));
    }
  }

  private renderCatalogPicker(t: Translate, busy: boolean): ReactNode {
    const catalog = this.state.catalog;
    if (catalog.phase === "ready") {
      const filtered = this.filteredCatalog(catalog.view, t);
      const selected = this.selectedCatalog(catalog.view, filtered);
      const selectedKey = selected === undefined ? undefined : catalogKey(selected);
      return (
        <div className={css.catalog}>
          <div className={css.catalogTools}>
            <label className={css.catalogSearch}>
              <span className={css.meta}>{t("skillsCatalogSearch")}</span>{" "}
              <input
                type="search"
                className={css.catalogInput}
                value={this.state.catalogQuery}
                placeholder={t("skillsCatalogSearchPlaceholder")}
                aria-label={t("skillsCatalogSearch")}
                onChange={event => this.setState({ catalogQuery: event.target.value.slice(0, 256) })}
              />
            </label>
            <button
              type="button"
              className={css.action}
              disabled={busy}
              onClick={() => void this.loadCatalog(true)}
              aria-label={t("skillsCatalogRefresh")}
            >{t("skillsCatalogRefresh")}</button>
          </div>
          <div
            className={css.catalogList}
            role="listbox"
            aria-label={t("skillsCatalogTitle")}
            aria-multiselectable="false"
          >
            {filtered.map((entry, index) => {
              const key = catalogKey(entry);
              const isSelected = key === selectedKey;
              return (
                <button
                  key={key}
                  type="button"
                  role="option"
                  className={`${css.catalogOption}${isSelected ? ` ${css.catalogOptionSelected}` : ""}`}
                  aria-selected={isSelected}
                  aria-label={`${entry.type === "scenario" ? t("skillsCatalogScenario") : t("skillsCatalogSkill")}: ${entry.name}`}
                  data-catalog-entry={key}
                  disabled={busy}
                  onClick={() => this.setState({ catalogChoice: key, scenarioRun: { phase: "idle" } })}
                  onKeyDown={event => {
                    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                    event.preventDefault();
                    const nextIndex = event.key === "ArrowDown"
                      ? Math.min(filtered.length - 1, index + 1)
                      : Math.max(0, index - 1);
                    const next = filtered[nextIndex];
                    if (next !== undefined) this.setState({ catalogChoice: catalogKey(next) });
                  }}
                >
                  <span className={css.catalogOptionTop}>
                    <span className={css.meta}>{entry.type === "scenario" ? t("skillsCatalogScenario") : t("skillsCatalogSkill")}</span>
                    <code>{entry.name}</code>
                  </span>
                  <span className={css.catalogDescription}>{this.catalogDescription(entry, t)}</span>
                </button>
              );
            })}
          </div>
          {catalog.view.status === "empty" ? <p className={css.hint} data-catalog-state="empty">{t("skillsCatalogEmpty")}</p> : null}
          {filtered.length === 0 ? <p className={css.hint}>{t("skillsCatalogNoMatch")}</p> : null}
        </div>
      );
    }
    return (
      <div className={css.catalog}>
        <div className={css.catalogTools}>
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
            disabled={catalog.phase === "loading" || busy}
            aria-busy={catalog.phase === "loading" || undefined}
            onClick={() => void this.loadCatalog(true)}
            aria-label={catalog.phase === "loading" ? t("skillsCatalogLoading") : t("skillsCatalogRefresh")}
          >
            {catalog.phase === "loading" ? t("skillsCatalogLoading") : t("skillsCatalogRefresh")}
          </button>
        </div>
        {catalog.phase === "loading" ? <p className={css.hint} role="status" aria-busy="true">{t("skillsCatalogLoading")}</p> : null}
        {catalog.phase === "unavailable" ? (
          <p className={css.error} role="alert" data-catalog-state="unavailable">
            {t("skillsCatalogUnavailable")}{catalog.message === undefined ? "" : ` · ${catalog.message}`}
          </p>
        ) : null}
      </div>
    );
  }

  override render(): ReactNode {
    const { t, skills } = this.props;
    const entries = skills.entries ?? [];
    const cold = skills.code === "fast-uncached";
    const busy = this.#busy;
    const run = this.state.scenarioRun;
    const catalogView = this.state.catalog.phase === "ready" ? this.state.catalog.view : undefined;
    const visibleCatalog = catalogView === undefined ? [] : this.filteredCatalog(catalogView, t);
    const selected = catalogView === undefined ? undefined : this.selectedCatalog(catalogView, visibleCatalog);
    const noCatalogMatch = catalogView !== undefined && visibleCatalog.length === 0;
    const isSingleSelection = selected?.type === "skill";
    const installingLabel = selected === undefined ? t("skillsScenarioInstall") : t("skillsCatalogInstall");
    const installingBusyLabel = selected === undefined ? t("skillsScenarioInstalling") : t("skillsCatalogInstalling");
    const installingDoneLabel = isSingleSelection ? t("skillsCatalogDone") : t("skillsScenarioDone");
    const installingFailedLabel = isSingleSelection ? t("skillsCatalogFailed") : t("skillsScenarioFailed");
    const installingName = selected?.name ?? this.state.scenario;
    return (
      <div className={css.region}>
        <h4>{t("skillsTitle")}</h4>
        {skills.code === "scan-failed" || skills.code === "unavailable" ? (
          <p role="alert" data-skills-scan="failed" className={css.error}>{t("skillsScanFailed")}</p>
        ) : null}
        {skills.diagnosticCount > 0 ? (
          <p role="alert" data-skills-diagnostics="summary" className={css.error}>
            {t("skillsDiagnosticsSummary")}: {t("skillsFormatInvalidCount")} {skills.formatInvalidCount} · {t("skillsPathIssueCount")} {skills.pathIssueCount}
            {skills.diagnosticsTruncated ? ` · ${t("skillsDiagnosticsVisible")} ${skills.diagnosticCount}` : ""}
          </p>
        ) : null}
        {this.renderCatalogPicker(t, busy)}
        <div className={css.controls}>
          <button
            type="button"
            className={css.action}
            disabled={busy || noCatalogMatch}
            aria-busy={run.phase === "busy" || undefined}
            onClick={() => void this.syncSelected()}
            aria-label={`${installingLabel}: ${installingName}`}
          >
            {run.phase === "busy" ? installingBusyLabel : installingLabel}
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
          <p role="status" data-scenario="done">{installingDoneLabel}{run.diff === undefined ? "" : `: ${diffText(run.diff, t)}`}</p>
        ) : null}
        {run.phase === "failed" ? (
          <p role="alert" data-scenario="failed" className={css.error}>
            {installingFailedLabel}: {run.message}{run.diff === undefined ? "" : ` · ${diffText(run.diff, t)}`} · {t("skillsRetryHint")}
            <DiagnoseButton t={t} kind="skill" faces={this.props.faces} />
          </p>
        ) : null}
        {this.state.updateResult !== undefined && this.state.updateResult.status === "completed" ? (
          <p role="status" data-update="done">{t("skillsUpdateDone")}: {diffText(diffOf(this.state.updateResult), t) || "0"}</p>
        ) : null}
        {this.state.updateError !== undefined ? (
          <p role="alert" data-update="failed" className={css.error}>
            {t("skillsUpdateFailed")}: {this.state.updateError}{this.state.updateResult !== undefined && this.state.updateResult.status !== "completed" ? ` · ${diffText(diffOf(this.state.updateResult), t)}` : ""} · {t("skillsRetryHint")}
            <DiagnoseButton t={t} kind="skill" faces={this.props.faces} />
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
                  {!enabled ? <span className={css.meta} data-skill-state="disabled">{t("skillsDisabledState")}</span> : null}
                  {entry.diagnostic !== undefined ? <SkillDiagnosticView t={t} diagnostic={entry.diagnostic} /> : null}
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

function SkillDiagnosticView(props: { t: Translate; diagnostic: OverviewSkillDiagnosticView }): ReactNode {
  const { t, diagnostic } = props;
  const format = isFormatDiagnostic(diagnostic.reason);
  const reason = skillReasonLabel(diagnostic.reason, t);
  const impact = diagnostic.contextImpact === "disabled"
    ? t("skillsDiagnosticImpactDisabled")
    : diagnostic.contextImpact === "source-unavailable"
      ? t("skillsDiagnosticImpactUnavailable")
      : t("skillsDiagnosticImpactMaybe");
  return (
    <span
      role="alert"
      className={css.diagnostic}
      data-skill-diagnostic={diagnostic.skill}
      data-skill-diagnostic-code={diagnostic.code}
    >
      {format ? t("skillsDiagnosticFormat") : t("skillsDiagnosticPath")} · <code>{diagnostic.code}</code> · {t("skillsDiagnosticSource")}: {diagnostic.source} · {t("skillsDiagnosticReason")}: {reason}
      {diagnostic.line === undefined ? "" : ` · ${t("skillsDiagnosticLine")} ${diagnostic.line}`} · {impact}
    </span>
  );
}

function isFormatDiagnostic(reason: string): boolean {
  return reason.startsWith("frontmatter-") || reason === "skill-file-too-large";
}

function skillReasonLabel(reason: string, t: Translate): string {
  const labels: Record<string, InsuremoLocaleKey> = {
    "frontmatter-unclosed": "skillsReasonFrontmatterUnclosed",
    "frontmatter-too-large": "skillsReasonFrontmatterTooLarge",
    "frontmatter-yaml-invalid": "skillsReasonFrontmatterYaml",
    "frontmatter-root-invalid": "skillsReasonFrontmatterRoot",
    "frontmatter-field-type-invalid": "skillsReasonFieldType",
    "frontmatter-field-too-large": "skillsReasonFieldTooLarge",
    "skill-file-too-large": "skillsReasonFileTooLarge",
    "outside-allowed-root": "skillsReasonPathOutside",
    "missing-directory": "skillsReasonMissingDirectory",
    "path-unreadable": "skillsReasonPathUnreadable",
    "not-directory": "skillsReasonNotDirectory",
    "missing-skill-md": "skillsReasonManifestMissing",
    "skill-md-unreadable": "skillsReasonManifestUnreadable",
  };
  return t(labels[reason] ?? "skillsReasonUnknown");
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
