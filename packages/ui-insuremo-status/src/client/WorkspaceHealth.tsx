import { Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { InsuremoStatusLocaleKey } from "./locales.ts";
import { IcomposerGlyph, GraphGlyph, IntelligenceGlyph } from "./HealthGlyphs.tsx";
import { BrandChrome } from "./BrandChrome.tsx";
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
  if (!props.row.detected) return null;
  // iComposer is a detected/not-detected signal only.
  const iComposerLabel = props.t("health.iComposer");
  const graphLabel = props.row.graphReady ? props.t("health.graphReady") : props.t("health.graphNotReady");
  const explainLabel = props.row.explainReady ? props.t("health.explainReady") : props.t("health.explainNotReady");
  return (
    <span className={css.rowIcons} data-icomposer-workspace-health-icons="" onClick={event => event.stopPropagation()}>
      <Tooltip label={iComposerLabel} side="top" delayMs={400}>
        <span
          className={css.icon}
          data-state="detected"
          role="img"
          tabIndex={0}
          aria-label={iComposerLabel}
        ><IcomposerGlyph /></span>
      </Tooltip>
      <Tooltip label={graphLabel} side="top" delayMs={400}>
        <span
          className={css.icon}
          data-state={props.row.graphReady ? "on" : "off"}
          role="img"
          tabIndex={0}
          aria-label={graphLabel}
        ><GraphGlyph /></span>
      </Tooltip>
      <Tooltip label={explainLabel} side="top" delayMs={400}>
        <span
          className={css.icon}
          data-state={props.row.explainReady ? "on" : "off"}
          role="img"
          tabIndex={0}
          aria-label={explainLabel}
        ><IntelligenceGlyph /></span>
      </Tooltip>
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
  /** DOM row → workspace identity, retained across duplicate-title filters/reorders. */
  #rowIds = new WeakMap<HTMLElement, string>();
  #driverRef: HTMLDivElement | null = null;
  #mounted = false;

  override componentDidMount(): void {
    this.#mounted = true;
    void this.load();
    this.#timer = setInterval(() => void this.load(), 60_000);
    this.#observer = new MutationObserver(() => this.syncRows());
    if (this.#driverRef?.ownerDocument !== undefined) {
      this.#observer.observe(this.#driverRef.ownerDocument.body, { childList: true, subtree: true });
    }
    this.syncRows();
  }

  override componentWillUnmount(): void {
    this.#mounted = false;
    this.#controller?.abort();
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#observer?.disconnect();
    for (const id of [...this.#ports.keys()]) this.dropPort(id);
  }

  private dropPort(id: string): void {
    const port = this.#ports.get(id);
    if (port === undefined) return;
    port.root.unmount();
    port.host.remove();
    this.#ports.delete(id);
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
    if (!this.#mounted) return;
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
      // Pair by the existing row/host identity first. Only new rows use the
      // occurrence fallback, so filtering or reordering duplicate titles does
      // not make the remaining row lose its port or steal another id.
      const candidates = rowsInOrder.filter(candidate => candidate.displayName === label);
      if (candidates.length === 0) continue;
      const occurrence = this.#occurrenceCounter.get(label) ?? 0;
      this.#occurrenceCounter.set(label, occurrence + 1);
      const existingHost = treeitem.querySelector<HTMLElement>(`[${HOST_ATTR}]`);
      const existingId = this.#rowIds.get(treeitem) ?? existingHost?.getAttribute("data-icomposer-workspace-id");
      const preserved = existingId === undefined || existingId === null
        ? undefined
        : candidates.find(candidate => candidate.workspaceId === existingId);
      const available = candidates.filter(candidate => !seenIds.has(candidate.workspaceId));
      const row = preserved !== undefined && !seenIds.has(preserved.workspaceId)
        ? preserved
        : available[occurrence % Math.max(available.length, 1)];
      if (row === undefined) continue;
      const id = row.workspaceId;
      this.#rowIds.set(treeitem, id);
      if (!row.detected) {
        const staleId = existingHost?.getAttribute("data-icomposer-workspace-id");
        const stalePort = staleId === undefined || staleId === null ? undefined : this.#ports.get(staleId);
        if (staleId !== undefined && staleId !== null && stalePort?.host === existingHost) this.dropPort(staleId);
        else existingHost?.remove();
        continue;
      }
      seenIds.add(id);
      // A stale host can remain for one mutation pass while React filters a
      // row. Remove it before creating the desired identity in this row.
      const hostId = existingHost?.getAttribute("data-icomposer-workspace-id");
      if (hostId !== undefined && hostId !== null && hostId !== id) {
        if (this.#ports.has(hostId)) this.dropPort(hostId);
        else existingHost?.remove();
      }
      let port = this.#ports.get(id);
      if (port !== undefined && !port.host.isConnected) {
        this.dropPort(id);
        port = undefined;
      }
      if (port !== undefined && port.host.parentElement !== treeitem) treeitem.appendChild(port.host);
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
      if (!seenIds.has(id) || !port.host.isConnected) this.dropPort(id);
    }
  }

  override render(): ReactNode {
    const { t } = this.props;
    return (
      <>
        <BrandChrome />
        <div
          ref = {(element: HTMLDivElement | null): void => { this.#driverRef = element; }}
          className={css.driver}
          role="status"
          aria-label={t("health.strip")}
          data-icomposer-workspace-health-driver=""
        />
      </>
    );
  }
}
