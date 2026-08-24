import { Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { InsuremoStatusLocaleKey } from "./locales.ts";
import { IcomposerGlyph, GraphGlyph, IntelligenceGlyph } from "./HealthGlyphs.tsx";
import css from "./WorkspaceHealth.module.css";

/** Props supplied by the sidebar footer-action slot owner. */
export type WorkspaceHealthProps = PropsRuntime<"sidebar.footer.action">
  & PropsLocale<"sidebar.insuremo">;

/** One workspace row of the icon data (mirrors the host route payload). */
export interface WorkspaceHealthRow {
  readonly workspaceId: string;
  /** Display title (registry title; falls back to the id). */
  readonly displayName: string;
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
      displayName: typeof row.displayName === "string" && row.displayName.length > 0 ? row.displayName : row.workspaceId,
      detected: row.detected === true,
      autoBindState: state,
      graphReady: row.graphReady === true,
      explainReady: row.explainReady === true,
    });
  }
  return rows;
}

/** The plugin-owned marker attribute on an injected inline host. */
const HOST_ATTR = "data-icomposer-workspace-health";

function Glyphs(props: {
  t: (key: InsuremoStatusLocaleKey) => string;
  row: WorkspaceHealthRow;
}): ReactNode {
  return (
    <span className={css.rowIcons} data-icomposer-workspace-health-icons="" onClick={event => event.stopPropagation()}>
      {props.row.detected ? (
        <span
          className={`${css.icon} ${props.row.autoBindState === "pending" ? css.iconPending : ""}`}
          data-state={props.row.autoBindState}
          title={props.row.autoBindState === "bound" ? props.t("health.iComposerBound") : props.t("health.iComposerPendingHint")}
          aria-label={props.row.autoBindState === "bound" ? props.t("health.iComposerBound") : props.t("health.iComposerPending")}
        ><IcomposerGlyph /></span>
      ) : null}
      <span
        className={css.icon}
        data-state={props.row.graphReady ? "on" : "off"}
        title={props.row.graphReady ? props.t("health.graphReady") : props.t("health.graphNotReady")}
        aria-label={props.t("health.graphReady")}
      ><GraphGlyph /></span>
      <span
        className={css.icon}
        data-state={props.row.explainReady ? "on" : "off"}
        title={props.row.explainReady ? props.t("health.explainReady") : props.t("health.explainNotReady")}
        aria-label={props.t("health.explainReady")}
      ><IntelligenceGlyph /></span>
    </span>
  );
}

/**
 * TASK-043 (A): the health strip rides the footer slot only as a hidden,
 * zero-size driver; the visible glyphs are injected INLINE into each native
 * Workspaces tree row (between the title text and the row actions) via a
 * MutationObserver + React portals. Cleanup is total: rows that disappear,
 * re-render, or rename lose their hosts; unmount removes every host.
 */
export class WorkspaceHealth extends Component<WorkspaceHealthProps, { rows: readonly WorkspaceHealthRow[] }> {
  override state: { rows: readonly WorkspaceHealthRow[] } = { rows: [] };
  #controller: AbortController | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #observer: MutationObserver | undefined;
  /** workspaceId → portal root mounted into that row's host element. */
  #ports = new Map<string, { host: HTMLElement; root: Root }>();
  #occurrenceCounter = new Map<string, number>();
  #driverRef: HTMLDivElement | null = null;

  override componentDidMount(): void {
    void this.load();
    this.#timer = setInterval(() => void this.load(), 60_000);
    this.#observer = new MutationObserver(() => this.syncRows());
    if (this.#driverRef?.ownerDocument !== undefined) {
      this.#observer.observe(this.#driverRef.ownerDocument.body, { childList: true, subtree: true });
    }
    this.syncRows();
  }

  override componentWillUnmount(): void {
    this.#controller?.abort();
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#observer?.disconnect();
    for (const port of this.#ports.values()) {
      port.root.unmount();
      port.host.remove();
    }
    this.#ports.clear();
  }

  private async load(): Promise<void> {
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    try {
      const response = await fetch(WORKSPACES_STATUS_URL, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const rows = parseWorkspaceHealthRows(await response.json());
      if (rows !== null && !controller.signal.aborted) {
        this.setState({ rows }, () => this.syncRows());
      }
    } catch {
      /* degrade silently */
    }
  }

  private syncRows(): void {
    const driver = this.#driverRef;
    if (driver === null) return;
    const doc = driver.ownerDocument;
    if (doc === undefined) return;
    // Harness allows duplicate workspace TITLES. We key by workspaceId and
    // pair each DOM row to its row data by STABLE OCCURRENCE INDEX (the nth
    // workspace disambiguates same-title rows). Rows without matching data
    // are ignored; a decorated host that no longer maps to a live workspaceId
    // is removed.
    const matched = new Map<string, number>(); // workspaceId -> occurrence index
    const rowsInOrder = this.state.rows;
    const seenIds = new Set<string>();
    const treeitems = Array.from(doc.querySelectorAll<HTMLElement>('[role="treeitem"][aria-expanded]'));
    for (const treeitem of treeitems) {
      const titleText = treeitem.querySelector('[class*="projectText"]');
      const label = (titleText?.textContent ?? "").trim();
      if (label.length === 0) continue;
      // occurrence index among rows SHARING this title
      const candidates = rowsInOrder.filter(candidate => candidate.displayName === label);
      if (candidates.length === 0) continue;
      const occurrence = this.#occurrenceCounter.get(label) ?? 0;
      this.#occurrenceCounter.set(label, occurrence + 1);
      const row = candidates[occurrence % candidates.length];
      const id = row.workspaceId;
      seenIds.add(id);
      // locate any existing host bound to THIS id (freshly sits in this row)
      let port = this.#ports.get(id);
      if (port !== undefined && !port.host.isConnected) {
        port.root.unmount();
        this.#ports.delete(id);
        port = undefined;
      }
      // if this row already carries a host from a DIFFERENT id, leave it (the
      // other sync pass will reconcile); only decorate when absent
      if (port === undefined && treeitem.querySelector(`[${HOST_ATTR}]`) === null) {
        const host = doc.createElement("span");
        host.setAttribute(HOST_ATTR, "");
        host.setAttribute("data-icomposer-workspace-id", id);
        for (const type of ["click", "mousedown", "keydown"]) {
          host.addEventListener(type, event => event.stopPropagation());
        }
        const anchor = treeitem.querySelector('[class*="rowActions"]') ?? treeitem.lastElementChild;
        if (anchor !== null && anchor.parentElement === treeitem) {
          treeitem.insertBefore(host, anchor);
        } else {
          treeitem.appendChild(host);
        }
        port = { host, root: createRoot(host) };
        this.#ports.set(id, port);
      }
      if (port !== undefined) {
        port.root.render(<Glyphs t={this.props.t} row={row} />);
      }
    }
    // reset per-pass occurrence counting
    this.#occurrenceCounter.clear();
    // drop ports whose workspaceId is no longer visible (deleted/renamed/filtered)
    for (const [id, port] of this.#ports.entries()) {
      if (!seenIds.has(id) || !port.host.isConnected) {
        port.root.unmount();
        port.host.remove();
        this.#ports.delete(id);
      }
    }
  }

  override render(): ReactNode {
    const { t } = this.props;
    return (
      <div
        ref = {(element: HTMLDivElement | null): void => { this.#driverRef = element; }}
        className={css.driver}
        role="status"
        aria-label={t("health.strip")}
        data-icomposer-workspace-health-driver=""
      />
    );
  }
}
