import { Component, type ReactNode } from "react";
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
 * The InsureMO card inside the Plugins settings tab (TASK-039): four
 * regions — IMO CLI (one-click upgrade), Auth (default-profile switch),
 * Skills (toggles + update-all + install/remove), Code Intelligence
 * (embedding endpoint display). All actions run directly through the
 * write bridge (no approval chain); errors render inline.
 */
export class InsuremoCard extends Component<InsuremoCardProps, LoadState> {
  override state: LoadState = { status: "loading" };
  #controller: AbortController | undefined;

  override componentDidMount(): void {
    void this.load();
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

  private async reload(): Promise<void> {
    try {
      const response = await fetch(OVERVIEW_URL, { headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const view = parseOverview(await response.json());
      if (view !== null) this.setState({ status: "ready", view });
    } catch { /* keep previous */ }
  }

  private t(key: InsuremoLocaleKey): string {
    return this.props.t(key);
  }

  override render(): ReactNode {
    const state = this.state;
    const t = this.t.bind(this);
    return (
      <section className={css.card} aria-labelledby="insuremo-card-title">
        <h3 id="insuremo-card-title">{t("title")}</h3>
        {state.status === "loading" ? <p>{t("loading")}</p> : null}
        {state.status === "error" ? <p>{t("error")}</p> : null}
        {state.status === "ready" ? (
          <>
            <ImoRegion t={t} imo={state.view.imo} onChanged={() => void this.reload()} />
            <AuthRegion t={t} auth={state.view.auth} onChanged={() => void this.reload()} />
            <SkillsRegion t={t} skills={state.view.skills} onChanged={() => void this.reload()} />
            {state.view.ici !== undefined ? <IciRegion t={t} ici={state.view.ici} /> : null}
          </>
        ) : null}
        <p>
          <button type="button" onClick={() => void this.load()} aria-label={t("refresh")}>{t("refresh")}</button>
        </p>
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

class AuthRegion extends Component<{ t: Translate; auth: ImoOverviewView["auth"]; onChanged: () => void }, { error?: string; busy: boolean }> {
  override state: { error?: string; busy: boolean } = { busy: false };

  private async setDefault(name: string): Promise<void> {
    this.setState({ busy: true, error: undefined });
    const outcome = await postAction<{ status: string }>("default-profile", { profile: name });
    this.setState({ busy: false });
    if (outcome.ok) this.props.onChanged();
    else {
      const network = outcome.error.code === "network";
      this.setState({ error: network ? this.props.t("errorNetwork") : `${outcome.error.code}: ${outcome.error.message}` });
    }
  }

  override render(): ReactNode {
    const { t, auth } = this.props;
    return (
      <div className={css.region}>
        <h4>{t("authTitle")}</h4>
        {auth.profiles.length === 0 ? (
          <p>{t("authNone")} · <code>imo auth login</code></p>
        ) : (
          <ul className={css.list}>
            {auth.profiles.map(profile => (
              <li key={profile.name}>
                <label>
                  <input
                    type="radio"
                    name="insuremo-default-profile"
                    checked={profile.isDefault}
                    disabled={this.state.busy}
                    onChange={() => void this.setDefault(profile.name)}
                    aria-label={`${t("authSetDefault")}: ${profile.name}`}
                  />
                  <code>{profile.name}</code>
                </label>
                <span className={css.meta}>{profile.env ?? "—"} / {profile.tenantCode ?? "—"}</span>
              </li>
            ))}
          </ul>
        )}
        {this.state.error !== undefined ? <p role="alert" className={css.error}>{this.state.error}</p> : null}
        <p className={css.hint}>{t("authCliHint")}</p>
      </div>
    );
  }
}

class SkillsRegion extends Component<{ t: Translate; skills: ImoOverviewView["skills"]; onChanged: () => void }, { rows: Readonly<Record<string, { error?: string; retry?: boolean }>>; updatingAll: boolean }> {
  override state: { rows: Readonly<Record<string, { error?: string; retry?: boolean }>>; updatingAll: boolean } = { rows: {}, updatingAll: false };

  private async toggle(name: string, next: boolean): Promise<void> {
    const expectedRevision = this.props.skills.activationRevision;
    this.setState(prev => ({ rows: { ...prev.rows, [name]: {} } }));
    const outcome = await postAction<{ revision: number }>("skill-activation", {
      name,
      enabled: next,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
    if (outcome.ok) this.props.onChanged();
    else {
      const conflict = outcome.error.code === "revision-conflict";
      const network = outcome.error.code === "network";
      const message = network ? this.props.t("errorNetwork") : `${outcome.error.code}: ${outcome.error.message}`;
      this.setState(prev => ({ rows: { ...prev.rows, [name]: { error: message, ...(conflict ? { retry: true } : {}) } } }));
      if (conflict) this.props.onChanged();
    }
  }

  private async updateAll(): Promise<void> {
    this.setState({ updatingAll: true });
    const outcome = await postAction<{ status: string }>("skill-update", { name: "__all__" });
    this.setState({ updatingAll: false });
    if (outcome.ok) this.props.onChanged();
  }

  private async remove(name: string): Promise<void> {
    const outcome = await postAction<{ status: string }>("skill-remove", { name });
    if (outcome.ok) this.props.onChanged();
    else {
      const network = outcome.error.code === "network";
      const message = network ? this.props.t("errorNetwork") : `${outcome.error.code}: ${outcome.error.message}`;
      this.setState(prev => ({ rows: { ...prev.rows, [name]: { error: message } } }));
    }
  }

  override render(): ReactNode {
    const { t, skills } = this.props;
    const entries = skills.entries ?? [];
    return (
      <div className={css.region}>
        <h4>{t("skillsTitle")}</h4>
        <p>
          <button type="button" disabled={this.state.updatingAll} onClick={() => void this.updateAll()} aria-label={t("skillsUpdateAll")}>
            {this.state.updatingAll ? t("skillsUpdatingAll") : t("skillsUpdateAll")}
          </button>
        </p>
        {entries.length === 0 ? (
          <p>{t("skillsNone")} · <code>imo skills install</code></p>
        ) : (
          <ul className={css.list}>
            {entries.map(entry => {
              const row = this.state.rows[entry.name] ?? {};
              return (
                <li key={entry.name}>
                  <label>
                    <input
                      type="checkbox"
                      checked={entry.enabled}
                      onChange={event => void this.toggle(entry.name, event.target.checked)}
                      aria-label={`${t("skillsToggle")}: ${entry.name}`}
                    />
                    <code>{entry.name}</code>
                  </label>
                  <span className={css.meta}>{entry.description}</span>
                  <button type="button" className={css.small} onClick={() => void this.remove(entry.name)} aria-label={`remove ${entry.name}`}>×</button>
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
        {t("iciEmbeddingEndpoint")}: <code>{ici.embeddingUrl}</code>
      </p>
      <p className={css.hint}>{t("iciEmbeddingHint")}</p>
      <p>
        {t("iciGraphWorkspaces")}: {ici.graphWorkspaces} · {t("iciExplainWorkspaces")}: {ici.explainWorkspaces}
      </p>
    </div>
  );
}
