import { Component, type ReactNode } from "react";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { InsuremoStatusLocaleKey } from "./locales.ts";
import { postAction, OVERVIEW_URL } from "./actions.ts";
import css from "./ProfilePicker.module.css";

/** Props supplied by the sidebar footer-action slot owner. */
export type ProfilePickerProps = PropsRuntime<"sidebar.footer.action">
  & PropsLocale<"sidebar.insuremo">;

interface ProfileRow {
  readonly name: string;
  readonly env?: string;
  readonly tenantCode?: string;
  readonly account?: string;
  readonly isDefault?: boolean;
}

type PickerState =
  | { readonly phase: "collapsed"; readonly profiles?: readonly ProfileRow[]; readonly defaultName?: string }
  | { readonly phase: "open"; readonly profiles: readonly ProfileRow[]; readonly defaultName?: string; readonly busy: boolean; readonly error?: string };

function tooltipOf(profile: ProfileRow, fallback: string): string {
  const parts = [profile.env, profile.tenantCode, profile.account].filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.length > 0 ? parts.join(" · ") : fallback;
}

/**
 * Sidebar default-profile selector (TASK-041): rendered as plain text rows
 * matching the session rows — collapsed shows the current default profile
 * name; expanded lists profile names with env/account/tenant on hover.
 * Data comes from the fast overview channel (profile-store read, no CLI
 * subprocess); the switch still goes through the write bridge.
 */
export class ProfilePicker extends Component<ProfilePickerProps, PickerState> {
  override state: PickerState = { phase: "collapsed" };

  /** Fetch the current default once on mount (fast channel, millisecond
   * read) so the collapsed row shows the profile name, not a placeholder. */
  override componentDidMount(): void {
    void this.warmDefault();
  }

  private async warmDefault(): Promise<void> {
    if (this.state.phase !== "collapsed" || this.state.defaultName !== undefined) return;
    try {
      const response = await fetch(`${OVERVIEW_URL}?fast=1`, { headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const parsed = this.parseProfiles(await response.json());
      if (this.state.phase === "collapsed" && this.state.defaultName === undefined) {
        this.setState({ phase: "collapsed", profiles: parsed.profiles, defaultName: parsed.defaultName });
      }
    } catch { /* keep placeholder */ }
  }

  /** One retry after a short delay: a Host restart / plugin reinstall window
   * answers transiently and should not immediately show "cannot connect". */
  private async fetchFastRetry(): Promise<Response> {
    const url = `${OVERVIEW_URL}?fast=1`;
    const first = await fetch(url, { headers: { Accept: "application/json" } }).catch(() => undefined);
    if (first !== undefined && first.ok) return first;
    await new Promise(resolve => setTimeout(resolve, 300));
    const second = await fetch(url, { headers: { Accept: "application/json" } }).catch(() => undefined);
    if (second !== undefined) return second;
    if (first !== undefined) return first;
    throw new Error("overview");
  }

  private parseProfiles(payload: unknown): { profiles: readonly ProfileRow[]; defaultName?: string } {
    if (typeof payload !== "object" || payload === null) throw new Error("shape");
    const auth = (payload as { auth?: unknown }).auth;
    if (typeof auth !== "object" || auth === null) throw new Error("shape");
    const raw = (auth as { profiles?: unknown }).profiles;
    if (!Array.isArray(raw)) throw new Error("shape");
    const profiles = raw
      .map(item => (typeof item === "object" && item !== null ? item as Record<string, unknown> : null))
      .filter((item): item is Record<string, unknown> => item !== null && typeof item.name === "string")
      .slice(0, 100)
      .map(item => ({
        name: String(item.name),
        env: typeof item.env === "string" ? item.env : undefined,
        tenantCode: typeof item.tenantCode === "string" ? item.tenantCode : undefined,
        account: typeof item.account === "string" ? item.account : undefined,
        isDefault: item.isDefault === true,
      }));
    const authRecord = auth as Record<string, unknown>;
    const defaultName = typeof authRecord.defaultProfileName === "string"
      ? authRecord.defaultProfileName
      : typeof authRecord.defaultProfile === "string" ? authRecord.defaultProfile : undefined;
    return { profiles, defaultName };
  }

  private async open(): Promise<void> {
    if (this.state.phase === "open") return;
    const previous = "defaultName" in this.state ? this.state.defaultName : undefined;
    this.setState({ phase: "open", profiles: [], defaultName: previous, busy: true });
    try {
      const response = await this.fetchFastRetry();
      if (!response.ok) throw new Error("overview");
      const parsed = this.parseProfiles(await response.json());
      this.setState({ phase: "open", profiles: parsed.profiles, defaultName: parsed.defaultName, busy: false });
    } catch {
      this.setState(prev => (prev.phase === "open" ? { ...prev, busy: false, error: "network" } : prev));
    }
  }

  private async pick(name: string): Promise<void> {
    if (this.state.phase !== "open" || this.state.busy) return;
    this.setState((prev: PickerState) => prev.phase === "open" ? { ...prev, busy: true } : prev);
    const outcome = await postAction<{ status: string; profile: string }>("default-profile", { profile: name });
    if (outcome.ok) {
      const refreshed = await fetch(`${OVERVIEW_URL}?fast=1`, { headers: { Accept: "application/json" } }).then(r => r.ok ? r.json() : null).catch(() => null);
      let nextDefault = name;
      let nextProfiles: readonly ProfileRow[] | undefined;
      try {
        const parsed = this.parseProfiles(refreshed);
        nextDefault = parsed.defaultName ?? name;
        nextProfiles = parsed.profiles;
      } catch { /* keep optimistic */ }
      this.setState((prev: PickerState) => prev.phase === "open"
        ? { phase: "collapsed", profiles: nextProfiles ?? prev.profiles, defaultName: nextDefault }
        : prev);
    } else {
      const error = outcome.error.code === "network" ? "network" : outcome.error.code;
      this.setState((prev: PickerState) => prev.phase === "open" ? { ...prev, busy: false, error } : prev);
    }
  }

  override render(): ReactNode {
    const { t } = this.props;
    const state = this.state;
    if (state.phase === "collapsed") {
      const current = "defaultName" in state && state.defaultName !== undefined ? state.defaultName : "";
      const currentRow = "profiles" in state ? state.profiles?.find(profile => profile.name === current) : undefined;
      const title = currentRow !== undefined ? tooltipOf(currentRow, current) : current.length > 0 ? current : t("label");
      return (
        <button type="button" className={css.trigger} data-wide="true" aria-haspopup="listbox" aria-expanded={false} title={title} aria-label={current.length > 0 ? `${t("label")} · ${current}` : t("label")} onClick={() => void this.open()}>
          <span className={css.dot} aria-hidden="true" />
          <span className={css.label}>{current.length > 0 ? current : t("label")}</span>
        </button>
      );
    }
    return (
      <div className={css.picker} role="group" aria-label={t("picker.label")}>
        <button type="button" className={css.pickerHeader} onClick={() => this.setState({ phase: "collapsed" })} aria-label={t("picker.close")}>
          <span className={css.dot} aria-hidden="true" />
          <span className={css.label}>{t("picker.label")}</span>
          <span className={css.closeMark} aria-hidden="true">×</span>
        </button>
        {state.busy && state.profiles.length === 0 ? <p className={css.hint}>{t("picker.loading")}</p> : null}
        {state.profiles.length === 0 && !state.busy ? <p className={css.hint}>{t("picker.empty")}</p> : null}
        <ul className={css.list} role="listbox" aria-label={t("picker.label")}>
          {state.profiles.map(profile => (
            <li key={profile.name}>
              <button
                type="button"
                role="option"
                aria-selected={profile.isDefault === true}
                disabled={state.busy}
                title={tooltipOf(profile, profile.name)}
                data-default={profile.isDefault === true ? "1" : undefined}
                onClick={() => void this.pick(profile.name)}
                className={css.row}
              >
                <span className={css.rowName}>{profile.name}</span>
                {profile.isDefault === true ? <span className={css.rowMark} aria-hidden="true">✓</span> : null}
              </button>
            </li>
          ))}
        </ul>
        {"error" in state && state.error !== undefined ? <span role="alert" className={css.error}>{t("picker.error")}</span> : null}
      </div>
    );
  }
}
