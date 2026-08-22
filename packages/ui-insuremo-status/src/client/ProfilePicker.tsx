import { Component, type ReactNode } from "react";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { InsuremoStatusLocaleKey } from "./locales.ts";
import { postAction, OVERVIEW_URL } from "./actions.ts";
import css from "./ProfilePicker.module.css";

/** Props supplied by the sidebar footer-action slot owner. */
export type ProfilePickerProps = PropsRuntime<"sidebar.footer.action">
  & PropsLocale<"sidebar.insuremo">;

interface ProfileRow { readonly name: string; readonly isDefault?: boolean }

type PickerState =
  | { readonly phase: "collapsed"; readonly profiles?: readonly ProfileRow[]; readonly defaultName?: string }
  | { readonly phase: "open"; readonly profiles: readonly ProfileRow[]; readonly defaultName?: string; readonly busy: boolean }
  | { readonly phase: "open"; readonly profiles: readonly ProfileRow[]; readonly defaultName?: string; readonly busy: boolean; readonly error?: string };

/** Sidebar badge + expandable default-profile selector (native select for keyboard/a11y). */
export class ProfilePicker extends Component<ProfilePickerProps, PickerState> {
  override state: PickerState = { phase: "collapsed" };

  /** One retry after a short delay: a Host restart / plugin reinstall window
   * answers transiently and should not immediately show "cannot connect". */
  private async fetchOverviewRetry(): Promise<Response> {
    const first = await fetch(OVERVIEW_URL, { headers: { Accept: "application/json" } }).catch(() => undefined);
    if (first !== undefined && first.ok) return first;
    await new Promise(resolve => setTimeout(resolve, 300));
    const second = await fetch(OVERVIEW_URL, { headers: { Accept: "application/json" } }).catch(() => undefined);
    if (second !== undefined) return second;
    if (first !== undefined) return first;
    throw new Error("overview");
  }

  private async open(): Promise<void> {
    this.setState({ phase: "open", profiles: [], busy: true });
    try {
      const response = await this.fetchOverviewRetry();
      if (!response.ok) throw new Error("overview");
      const payload = await response.json() as { auth?: { profiles?: unknown; defaultProfileName?: unknown; defaultProfile?: unknown } };
      const raw = payload.auth?.profiles;
      if (!Array.isArray(raw)) throw new Error("shape");
      const profiles = raw
        .map(item => (typeof item === "object" && item !== null ? item as Record<string, unknown> : null))
        .filter((item): item is Record<string, unknown> => item !== null && typeof item.name === "string")
        .slice(0, 100)
        .map(item => ({ name: String(item.name), isDefault: item.isDefault === true }));
      const defaultName = typeof payload.auth?.defaultProfileName === "string"
        ? payload.auth.defaultProfileName
        : typeof payload.auth?.defaultProfile === "string" ? payload.auth.defaultProfile : undefined;
      this.setState({ phase: "open", profiles, defaultName, busy: false });
    } catch {
      this.setState(prev => (prev.phase === "open" ? { ...prev, busy: false, error: "network" } : prev));
    }
  }

  private async pick(name: string): Promise<void> {
    if (this.state.phase !== "open" || this.state.busy) return;
    this.setState((prev: PickerState) => prev.phase === "open" ? { ...prev, busy: true } : prev);
    const outcome = await postAction<{ status: string; profile: string }>("default-profile", { profile: name });
    if (outcome.ok) {
      const refreshed = await fetch(OVERVIEW_URL, { headers: { Accept: "application/json" } }).then(r => r.ok ? r.json() : null).catch(() => null) as { auth?: { defaultProfileName?: unknown; defaultProfile?: unknown } } | null;
      const nextDefault = typeof refreshed?.auth?.defaultProfileName === "string"
        ? refreshed.auth.defaultProfileName
        : typeof refreshed?.auth?.defaultProfile === "string" ? refreshed.auth.defaultProfile : name;
      this.setState((prev: PickerState) => prev.phase === "open" ? { phase: "collapsed", profiles: prev.profiles, defaultName: nextDefault } : prev);
    } else {
      const error = outcome.error.code === "network" ? "network" : outcome.error.code;
      this.setState((prev: PickerState) => prev.phase === "open" ? { ...prev, busy: false, error } : prev);
    }
  }

  override render(): ReactNode {
    const { t } = this.props;
    const state = this.state;
    if (state.phase === "collapsed") {
      const label = t("label");
      const current = "defaultName" in state && state.defaultName !== undefined ? state.defaultName : "";
      return (
        <button type="button" className={css.trigger} data-wide="true" aria-haspopup="listbox" aria-expanded={false} aria-label={current.length > 0 ? `${label} · ${current}` : label} onClick={() => void this.open()}>
          <span className={css.dot} aria-hidden="true" />
          <span className={css.label}>{label}{current.length > 0 ? ` · ${current}` : ""}</span>
        </button>
      );
    }
    const options = state.profiles.map(profile => (
      <option key={profile.name} value={profile.name}>{profile.name}{profile.isDefault ? " ✓" : ""}</option>
    ));
    return (
      <div className={css.picker} role="group" aria-label={t("picker.label")}>
        <button type="button" className={css.trigger} data-wide="true" aria-expanded onClick={() => this.setState({ phase: "collapsed" })} aria-label={t("picker.close")}>×</button>
        <select
          aria-label={t("picker.label")}
          disabled={state.busy}
          value={state.defaultName ?? ""}
          onChange={event => void this.pick(event.target.value)}
        >
          {options.length > 0 ? options : <option value="">{state.busy ? t("picker.loading") : t("picker.empty")}</option>}
        </select>
        {"error" in state && state.error !== undefined ? <span role="alert" className={css.error}>{t("picker.error")}</span> : null}
      </div>
    );
  }
}
