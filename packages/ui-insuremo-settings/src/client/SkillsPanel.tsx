import { Component, type ReactNode } from "react";
import type { ImoOverviewView } from "./overview.ts";
import type { InsuremoLocaleKey } from "./locales.ts";
import { postAction } from "./actions.ts";

export interface SkillsPanelProps {
  readonly t: (key: InsuremoLocaleKey) => string;
  readonly skills: ImoOverviewView["skills"];
  /** Latest activation revision for optimistic toggles (revision-conflict detection). */
  readonly activationRevision?: number;
  /** Called after a successful toggle / update-all so the section refetches. */
  readonly onChanged?: () => void;
}

type RowState = { readonly error?: string; readonly retry?: boolean };

/** Skills panel: per-skill enable switches (optimistic, rollback on failure) + update-all. */
export class SkillsPanel extends Component<SkillsPanelProps, { rows: Readonly<Record<string, RowState>>; updatingAll: boolean }> {
  override state: { rows: Readonly<Record<string, RowState>>; updatingAll: boolean } = { rows: {}, updatingAll: false };

  private async toggle(name: string, next: boolean): Promise<void> {
    const expectedRevision = this.props.activationRevision;
    const optimistic = { ...this.state.rows, [name]: {} as RowState };
    this.setState({ rows: optimistic });
    const outcome = await postAction<{ name: string; enabled: boolean; revision: number }>("skill-activation", {
      name,
      enabled: next,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
    if (outcome.ok) {
      this.props.onChanged?.();
    } else {
      const network = outcome.error.code === "network";
      const conflict = outcome.error.code === "revision-conflict";
      const message = network ? this.props.t("errorNetwork") : `${outcome.error.code}: ${outcome.error.message}`;
      this.setState({ rows: { ...this.state.rows, [name]: { error: message, ...(conflict ? { retry: true } : {}) } } });
      if (conflict) this.props.onChanged?.(); // refetch for fresh revision + hint
    }
  }

  private async updateAll(): Promise<void> {
    this.setState({ updatingAll: true });
    const outcome = await postAction<{ status: string; names: readonly string[] }>("skill-update", { name: "__all__" });
    this.setState({ updatingAll: false });
    if (outcome.ok) this.props.onChanged?.();
  }

  override render(): ReactNode {
    const { t, skills } = this.props;
    const entries = skills.entries ?? [];
    return (
      <section aria-labelledby="overview-skills-title">
        <h3 id="overview-skills-title">{t("skillsTitle")}</h3>
        <p>
          <button type="button" disabled={this.state.updatingAll} onClick={() => void this.updateAll()} aria-label={t("skillsUpdateAll")}>
            {this.state.updatingAll ? t("skillsUpdatingAll") : t("skillsUpdateAll")}
          </button>
        </p>
        {entries.length === 0 ? (
          <p>{t("skillsNone")}</p>
        ) : (
          <ul aria-label={t("skillsTitle")}>
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
                    <span>{entry.name}</span>
                  </label>
                  <span aria-hidden="true"> — {entry.description}</span>
                  {row.error !== undefined ? (
                    <span role="alert" style={{ color: "#c0392b" }}>{row.error}{row.retry === true ? ` · ${t("skillsRetryHint")}` : ""}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <p>{t("skillsCliHint")}</p>
      </section>
    );
  }
}
