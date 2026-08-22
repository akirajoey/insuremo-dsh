import { Component, type ReactNode } from "react";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { InsuremoStatusLocaleKey } from "./locales.ts";
import css from "./WorkspaceHealth.module.css";

/** Props supplied by the sidebar footer-action slot owner. */
export type WorkspaceHealthProps = PropsRuntime<"sidebar.footer.action">
  & PropsLocale<"sidebar.insuremo">;

/** One workspace row of the icon data (mirrors the host route payload). */
export interface WorkspaceHealthRow {
  readonly workspaceId: string;
  readonly detected: boolean;
  readonly autoBindState: "bound" | "pending" | "none";
  readonly graphReady: boolean;
  readonly explainReady: boolean;
}

export const WORKSPACES_STATUS_URL = "/api/icomposer-workbench/insuremo/overview/workspaces/status" as const;

export function parseWorkspaceHealthRows(value: unknown): readonly WorkspaceHealthRow[] | null {
  if (typeof value !== "object" || value === null) return null;
  const list = (value as { workspaces?: unknown }).workspaces;
  if (!Array.isArray(list)) return null;
  const rows: WorkspaceHealthRow[] = [];
  for (const item of list.slice(0, 100)) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.workspaceId !== "string") continue;
    const state = row.autoBindState === "bound" || row.autoBindState === "pending" ? row.autoBindState : "none";
    rows.push({
      workspaceId: row.workspaceId,
      detected: row.detected === true,
      autoBindState: state,
      graphReady: row.graphReady === true,
      explainReady: row.explainReady === true,
    });
  }
  return rows;
}

/**
 * Compact workspace health strip for the sidebar foot: per workspace three
 * 16px glyphs — "i" (iComposer binding: lit=bound, 50% alpha=pending,
 * hidden=not iComposer), graph (ICI snapshot), brain (explain output).
 * Data comes from the read-only host route with a 60s TTL cache; fetch
 * failures degrade to an empty strip, never an error state.
 */
export class WorkspaceHealth extends Component<WorkspaceHealthProps, { rows: readonly WorkspaceHealthRow[] }> {
  override state: { rows: readonly WorkspaceHealthRow[] } = { rows: [] };
  #controller: AbortController | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  override componentDidMount(): void {
    void this.load();
    this.#timer = setInterval(() => void this.load(), 60_000);
  }

  override componentWillUnmount(): void {
    this.#controller?.abort();
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  private async load(): Promise<void> {
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    try {
      const response = await fetch(WORKSPACES_STATUS_URL, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const rows = parseWorkspaceHealthRows(await response.json());
      if (rows !== null && !controller.signal.aborted) this.setState({ rows });
    } catch {
      /* degrade silently */
    }
  }

  override render(): ReactNode {
    const { t } = this.props;
    const rows = this.state.rows;
    if (rows.length === 0) return null;
    return (
      <div className={css.strip} role="status" aria-label={t("health.strip")}>
        {rows.map(row => (
          <div key={row.workspaceId} className={css.row} data-workspace={row.workspaceId}>
            <span className={css.workspaceName} title={row.workspaceId}>{row.workspaceId}</span>
            {row.detected ? (
              <span
                className={css.icon}
                data-state={row.autoBindState}
                title={row.autoBindState === "bound" ? t("health.iComposerBound") : t("health.iComposerPending")}
                aria-label={t("health.iComposerBound")}
              >i</span>
            ) : null}
            <span
              className={css.icon}
              data-state={row.graphReady ? "on" : "off"}
              title={row.graphReady ? t("health.graphReady") : t("health.graphNotReady")}
              aria-label={t("health.graphReady")}
            >▦</span>
            <span
              className={css.icon}
              data-state={row.explainReady ? "on" : "off"}
              title={row.explainReady ? t("health.explainReady") : t("health.explainNotReady")}
              aria-label={t("health.explainReady")}
            >◍</span>
          </div>
        ))}
      </div>
    );
  }
}
