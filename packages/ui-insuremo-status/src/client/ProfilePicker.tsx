import { Component, type ReactNode } from "react";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-runtime/client";
import type { InsuremoStatusLocaleKey } from "./locales.ts";
import { postAction, OVERVIEW_URL } from "./actions.ts";
import css from "./ProfilePicker.module.css";

/** Props supplied by the sidebar footer-action slot owner. */
export type ProfilePickerProps = PropsRuntime<"sidebar.footer.action">
  & PropsLocale<"sidebar.insuremo">;

export interface ProfilePickerTarget {
  readonly kind: "global" | "workspace" | "unavailable";
  /** Sent to the server only after registry validation; never a cwd. */
  readonly workspaceId?: string;
  /** Registry path is a stale-response guard and is never sent to the server. */
  readonly canonicalPath?: string;
}

interface ProfileRow {
  readonly name: string;
  readonly env?: string;
  readonly tenantCode?: string;
  readonly account?: string;
  /** Auth source location, not the Workbench selection-storage scope. */
  readonly sourceScope?: "workspace" | "global";
  readonly isActive?: boolean;
}

type PickerState =
  | { readonly phase: "collapsed"; readonly targetKey: string; readonly profiles?: readonly ProfileRow[]; readonly activeName?: string }
  | { readonly phase: "open"; readonly targetKey: string; readonly profiles: readonly ProfileRow[]; readonly activeName?: string; readonly busy: boolean; readonly error?: "network" | "workspace" | string };

function tooltipOf(profile: ProfileRow, fallback: string): string {
  const parts = [profile.env, profile.tenantCode, profile.account].filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.length > 0 ? parts.join(" · ") : fallback;
}

/**
 * Derive the current auth target from the renderer's authoritative session and
 * workspace feeds. Workspace path is retained only to invalidate a stale
 * response if a registry row is replaced; the browser sends the id only.
 */
export function resolveProfileTarget(
  sessions: { readonly current?: string },
  workspaces: {
    readonly items: ReadonlyArray<{ readonly workspaceId: string; readonly path: string; readonly sessionIds: ReadonlyArray<string> }>;
    readonly phase: string;
    readonly baselinesReady: boolean;
  },
): ProfilePickerTarget {
  if (sessions.current === undefined) return { kind: "global" };
  if (workspaces.phase !== "ready" || workspaces.baselinesReady !== true) return { kind: "unavailable" };
  const workspace = workspaces.items.find(item => item.sessionIds.includes(sessions.current!));
  if (workspace === undefined) return { kind: "global" };
  return { kind: "workspace", workspaceId: String(workspace.workspaceId), canonicalPath: workspace.path };
}

function targetKey(target: ProfilePickerTarget): string {
  if (target.kind === "workspace") return `workspace:${target.workspaceId ?? ""}:${target.canonicalPath ?? ""}`;
  return target.kind;
}

function targetQuery(target: ProfilePickerTarget): string {
  if (target.kind !== "workspace" || target.workspaceId === undefined) return "";
  return `&workspaceId=${encodeURIComponent(target.workspaceId)}`;
}

function sourceRank(scope: ProfileRow["sourceScope"]): number {
  return scope === "workspace" ? 0 : scope === "global" ? 1 : 2;
}

function sourceScopeOf(item: Record<string, unknown>): ProfileRow["sourceScope"] {
  if (item.sourceScope === "workspace" || item.sourceScope === "global") return item.sourceScope;
  if (item.scope === "workspace" || item.scope === "global") return item.scope;
  return undefined;
}

function mergeProfileRows(rows: readonly ProfileRow[]): readonly ProfileRow[] {
  const byName = new Map<string, ProfileRow>();
  for (const row of rows) {
    const previous = byName.get(row.name);
    if (previous === undefined || sourceRank(row.sourceScope) < sourceRank(previous.sourceScope)) byName.set(row.name, row);
  }
  return [...byName.values()].sort((left, right) => sourceRank(left.sourceScope) - sourceRank(right.sourceScope) || left.name.localeCompare(right.name));
}

/**
 * Global slot wrapper: hooks are consumed here, while the stateful panel below
 * remains a class so the existing picker interaction and DOM stay stable.
 */
export function WorkspaceAwareProfilePicker(props: ProfilePickerProps): ReactNode {
  const sessions = props.useSessions(state => state);
  const workspaces = props.useWorkspaces(state => state);
  return <ProfilePicker {...props} target={resolveProfileTarget(sessions, workspaces)} />;
}

interface ProfilePickerPanelProps extends ProfilePickerProps {
  /** Omitted only for direct legacy consumers; registered UI always supplies it. */
  readonly target?: ProfilePickerTarget;
}

/** Sidebar Active Profile selector with workspace-scoped reads and selection. */
export class ProfilePicker extends Component<ProfilePickerPanelProps, PickerState> {
  override state: PickerState = { phase: "collapsed", targetKey: targetKey(this.props.target ?? { kind: "global" }) };
  #generation = 0;
  #controller: AbortController | undefined;

  private currentTarget(): ProfilePickerTarget {
    return this.props.target ?? { kind: "global" };
  }

  override componentDidMount(): void {
    void this.warmActive(this.currentTarget());
  }

  override componentDidUpdate(previousProps: ProfilePickerPanelProps): void {
    const previousKey = targetKey(previousProps.target ?? { kind: "global" });
    const nextKey = targetKey(this.currentTarget());
    if (previousKey === nextKey) return;
    this.cancelRequest();
    this.setState({ phase: "collapsed", targetKey: nextKey });
    void this.warmActive(this.currentTarget());
  }

  override componentWillUnmount(): void {
    this.cancelRequest();
  }

  private cancelRequest(): void {
    this.#generation += 1;
    this.#controller?.abort();
    this.#controller = undefined;
  }

  private beginRequest(): { readonly generation: number; readonly signal: AbortSignal; readonly targetKey: string } {
    this.cancelRequest();
    const controller = new AbortController();
    this.#controller = controller;
    return { generation: this.#generation, signal: controller.signal, targetKey: targetKey(this.currentTarget()) };
  }

  private isCurrent(generation: number, key: string, signal: AbortSignal): boolean {
    return !signal.aborted && generation === this.#generation && key === targetKey(this.currentTarget()) && this.#controller?.signal === signal;
  }

  private overviewUrl(target: ProfilePickerTarget): string {
    return `${OVERVIEW_URL}?fast=1${targetQuery(target)}`;
  }

  private async waitBeforeRetry(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, 300);
      const abort = (): void => {
        clearTimeout(timer);
        reject(new Error("cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  /** One retry after a short delay; aborts cleanly when target changes. */
  private async fetchFastRetry(target: ProfilePickerTarget, signal: AbortSignal): Promise<Response> {
    const first = await fetch(this.overviewUrl(target), { headers: { Accept: "application/json" }, signal }).catch(error => {
      if (signal.aborted) throw error;
      return undefined;
    });
    if (first !== undefined && first.ok) return first;
    await this.waitBeforeRetry(signal);
    const second = await fetch(this.overviewUrl(target), { headers: { Accept: "application/json" }, signal }).catch(error => {
      if (signal.aborted) throw error;
      return undefined;
    });
    if (second !== undefined) return second;
    if (first !== undefined) return first;
    throw new Error("overview");
  }

  private async warmActive(target: ProfilePickerTarget): Promise<void> {
    if (target.kind === "unavailable") return;
    const request = this.beginRequest();
    try {
      const response = await this.fetchFastRetry(target, request.signal);
      if (!response.ok) return;
      const parsed = this.parseProfiles(await response.json());
      if (!this.isCurrent(request.generation, request.targetKey, request.signal)) return;
      if (this.state.phase === "collapsed" && this.state.targetKey === request.targetKey) {
        this.setState({ phase: "collapsed", targetKey: request.targetKey, profiles: parsed.profiles, activeName: parsed.activeName });
      }
    } catch {
      // A superseded request is intentionally silent; the next target owns UI.
    } finally {
      if (this.#controller?.signal === request.signal) this.#controller = undefined;
    }
  }

  private parseProfiles(payload: unknown): { profiles: readonly ProfileRow[]; activeName?: string } {
    if (typeof payload !== "object" || payload === null) throw new Error("shape");
    const auth = (payload as { auth?: unknown }).auth;
    if (typeof auth !== "object" || auth === null) throw new Error("shape");
    const raw = (auth as { profiles?: unknown }).profiles;
    if (!Array.isArray(raw)) throw new Error("shape");
    const profiles = mergeProfileRows(raw
      .map(item => (typeof item === "object" && item !== null ? item as Record<string, unknown> : null))
      .filter((item): item is Record<string, unknown> => item !== null && typeof item.name === "string")
      .slice(0, 100)
      .map(item => ({
        name: String(item.name),
        env: typeof item.env === "string" ? item.env : undefined,
        tenantCode: typeof item.tenantCode === "string" ? item.tenantCode : undefined,
        account: typeof item.account === "string" ? item.account : undefined,
        sourceScope: sourceScopeOf(item),
        isActive: item.isActive === true,
      })));
    const authRecord = auth as Record<string, unknown>;
    const activeName = typeof authRecord.activeProfileName === "string" ? authRecord.activeProfileName : undefined;
    return { profiles, activeName };
  }

  private async open(): Promise<void> {
    if (this.state.phase === "open") return;
    const target = this.currentTarget();
    const key = targetKey(target);
    const previous = this.state.activeName;
    if (target.kind === "unavailable") {
      this.setState({ phase: "open", targetKey: key, profiles: [], activeName: previous, busy: false, error: "workspace" });
      return;
    }
    const request = this.beginRequest();
    this.setState({ phase: "open", targetKey: key, profiles: [], activeName: previous, busy: true });
    try {
      const response = await this.fetchFastRetry(target, request.signal);
      if (!response.ok) throw new Error("overview");
      const parsed = this.parseProfiles(await response.json());
      if (!this.isCurrent(request.generation, request.targetKey, request.signal)) return;
      this.setState({ phase: "open", targetKey: request.targetKey, profiles: parsed.profiles, activeName: parsed.activeName, busy: false });
    } catch {
      if (!this.isCurrent(request.generation, request.targetKey, request.signal)) return;
      this.setState(prev => prev.phase === "open" ? { ...prev, busy: false, error: "network" } : prev);
    } finally {
      if (this.#controller?.signal === request.signal) this.#controller = undefined;
    }
  }

  private async pick(name: string): Promise<void> {
    if (this.state.phase !== "open" || this.state.busy) return;
    const target = this.currentTarget();
    const key = targetKey(target);
    if (this.state.targetKey !== key || target.kind === "unavailable") return;
    const request = this.beginRequest();
    this.setState(prev => prev.phase === "open" ? { ...prev, busy: true, error: undefined } : prev);
    const body = target.kind === "workspace" && target.workspaceId !== undefined
      ? { profile: name, workspaceId: target.workspaceId }
      : { profile: name };
    try {
      const outcome = await postAction<{ status: string; profile: string }>("active-profile", body, request.signal);
      if (!this.isCurrent(request.generation, request.targetKey, request.signal)) return;
      if (outcome.ok) {
        let nextActive = name;
        let nextProfiles: readonly ProfileRow[] | undefined;
        try {
          const refreshed = await this.fetchFastRetry(target, request.signal);
          if (refreshed.ok) {
            const parsed = this.parseProfiles(await refreshed.json());
            if (!this.isCurrent(request.generation, request.targetKey, request.signal)) return;
            nextActive = parsed.activeName ?? name;
            nextProfiles = parsed.profiles;
          }
        } catch {
          // Keep the optimistic row when the post succeeded but the readback failed.
        }
        if (!this.isCurrent(request.generation, request.targetKey, request.signal)) return;
        this.setState(prev => prev.phase === "open"
          ? { phase: "collapsed", targetKey: request.targetKey, profiles: nextProfiles ?? prev.profiles, activeName: nextActive }
          : prev);
      } else {
        const error = outcome.error.code === "network" ? "network" : outcome.error.code;
        this.setState(prev => prev.phase === "open" ? { ...prev, busy: false, error } : prev);
      }
    } catch {
      if (!this.isCurrent(request.generation, request.targetKey, request.signal)) return;
      this.setState(prev => prev.phase === "open" ? { ...prev, busy: false, error: "network" } : prev);
    } finally {
      if (this.#controller?.signal === request.signal) this.#controller = undefined;
    }
  }

  private errorText(error: string | undefined): string {
    return error === "workspace" ? this.props.t("picker.workspaceUnavailable") : this.props.t("picker.error");
  }

  override render(): ReactNode {
    const { t } = this.props;
    const state = this.state;
    if (state.phase === "collapsed") {
      const current = state.activeName ?? "";
      const currentRow = state.profiles?.find(profile => profile.name === current);
      const title = currentRow !== undefined ? tooltipOf(currentRow, current) : current.length > 0 ? current : t("label");
      return (
        <button type="button" className={css.trigger} data-wide="true" aria-haspopup="listbox" aria-expanded={false} title={title} aria-label={current.length > 0 ? `${t("label")} · ${current}` : t("label")} onClick={() => void this.open()}>
          <span className={css.dot} aria-hidden="true" />
          <span className={css.label}>{current.length > 0 ? current : t("label")}</span>
        </button>
      );
    }
    let lastScope: ProfileRow["sourceScope"] | undefined;
    return (
      <div className={css.picker} role="group" aria-label={t("picker.label")}>
        <button type="button" className={css.pickerHeader} onClick={() => { this.cancelRequest(); this.setState({ phase: "collapsed", targetKey: targetKey(this.currentTarget()), profiles: state.profiles, activeName: state.activeName }); }} aria-label={t("picker.close")}>
          <span className={css.dot} aria-hidden="true" />
          <span className={css.label}>{t("picker.label")}</span>
          <span className={css.closeMark} aria-hidden="true">×</span>
        </button>
        {state.busy && state.profiles.length === 0 ? <p className={css.hint}>{t("picker.loading")}</p> : null}
        {state.profiles.length === 0 && !state.busy && state.error === undefined ? <p className={css.hint}>{t("picker.empty")}</p> : null}
        <ul className={css.list} role="listbox" aria-label={t("picker.label")}>
          {state.profiles.map(profile => {
            const heading = profile.sourceScope !== undefined && profile.sourceScope !== lastScope;
            lastScope = profile.sourceScope;
            const selected = profile.name === state.activeName || (state.activeName === undefined && profile.isActive === true);
            return (
              <li key={profile.name}>
                {heading ? <span role="presentation" className={css.groupLabel}>{profile.sourceScope === "workspace" ? t("picker.project") : t("picker.global")}</span> : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={state.busy}
                  title={tooltipOf(profile, profile.name)}
                  data-active={selected ? "1" : undefined}
                  data-source-scope={profile.sourceScope}
                  onClick={() => void this.pick(profile.name)}
                  className={css.row}
                >
                  <span className={css.rowName}>{profile.name}</span>
                  {selected ? <span className={css.rowMark} aria-hidden="true">✓</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
        {state.error !== undefined ? <span role="alert" className={css.error}>{this.errorText(state.error)}</span> : null}
      </div>
    );
  }
}

/** Compatibility alias for callers that imported the stateful panel by name. */
export { ProfilePicker as ProfilePickerPanel };
