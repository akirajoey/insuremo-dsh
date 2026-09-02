import { Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import wordmarkDarkUrl from "../../assets/insuremo-wordmark-dark.png";
import wordmarkLightUrl from "../../assets/insuremo-wordmark-light.png";
import globeUrl from "../../assets/insuremo-globe.png";
import css from "./BrandChrome.module.css";

/** Stable DOM signatures owned by the Harness sidebar shell. */
const WORDMARK_VIEWBOX = "0 0 182 24";
const FISH_VIEWBOX = "0 0 23.16 17.04";
const PANEL_VIEWBOX = "0 0 16 16";
const BRAND_ASSET_URL = "/api/icomposer-workbench/ui/assets";
export const BRAND_HOST_ATTRIBUTE = "data-icomposer-brand-host";
type HostKind = "wordmark" | "rail" | "hero";

interface BrandPort {
  readonly original: SVGElement;
  readonly anchor: HTMLElement;
  readonly host: HTMLSpanElement;
  readonly root: Root;
  readonly originalStyle: string | null;
  readonly anchorStyle: string | null;
}

/**
 * Resolves the overlay anchor for one kind. wordmark/rail ride the Harness
 * button shell; the hero fish lives inside a plain span (New Session empty
 * state), so its span becomes the relative overlay host instead.
 */
function svgAnchor(svg: SVGElement, kind: HostKind): HTMLElement | null {
  if (kind === "hero") {
    if (svg.getAttribute("viewBox") !== FISH_VIEWBOX) return null;
    const parent = svg.parentElement;
    if (parent === null || parent.tagName === "BUTTON") return null;
    return parent as HTMLElement;
  }
  if (svg.getAttribute("viewBox") !== (kind === "wordmark" ? WORDMARK_VIEWBOX : FISH_VIEWBOX)) return null;
  const button = svg.parentElement;
  if (button === null || button.tagName !== "BUTTON") return null;
  const nativeButton = button as HTMLButtonElement;
  const hasPanel = button.querySelector(`svg[viewBox="${PANEL_VIEWBOX}"]`) !== null;
  if (kind === "rail") return hasPanel ? nativeButton : null;
  const row = button.parentElement;
  if (row === null) return null;
  // The wide logo button is identified by its sibling panel-toggle button,
  // not by a generated CSS-module class. This avoids touching other brands.
  const siblingPanel = Array.from(row.children).some(child => child !== button
    && child.tagName === "BUTTON"
    && child.querySelector(`svg[viewBox="${PANEL_VIEWBOX}"]`) !== null);
  return siblingPanel ? nativeButton : null;
}

function Asset({ kind }: { kind: HostKind }): ReactNode {
  if (kind === "wordmark") {
    return (
      <span className={css.wordmarkInner} aria-hidden="true">
        <span
          className={css.wordmark}
          data-icomposer-brand-asset={kind}
          data-emitted-brand-assets={`${wordmarkLightUrl}|${wordmarkDarkUrl}`}
        >
          <img className={css.wordmarkLight} src={`${BRAND_ASSET_URL}/insuremo-wordmark-light.png`} alt="" width={312} height={76} decoding="async" />
          <img className={css.wordmarkDark} src={`${BRAND_ASSET_URL}/insuremo-wordmark-dark.png`} alt="" width={312} height={76} decoding="async" />
        </span>
        <span className={css.dsh}>dsh</span>
      </span>
    );
  }
  if (kind === "hero") {
    return (
      <span className={css.heroMark} data-icomposer-brand-asset={kind} data-emitted-brand-asset={globeUrl}>
        <img src={`${BRAND_ASSET_URL}/insuremo-globe.png`} alt="" width={34} height={32} decoding="async" />
      </span>
    );
  }
  return (
    <span className={css.railMark} data-icomposer-brand-asset={kind} data-emitted-brand-asset={globeUrl}>
      <img src={`${BRAND_ASSET_URL}/insuremo-globe.png`} alt="" width={65} height={62} decoding="async" />
    </span>
  );
}

/**
 * Hidden client driver that overlays only the Harness-owned brand SVGs.
 * The source buttons remain the click/focus/tooltip owners; each original SVG
 * is merely visibility-hidden and restored, while every portal host is removed
 * on unmount or when the shell replaces a button. On rc.2+ runtimes the brand
 * slots replace the native SVGs, so the driver simply finds nothing to own.
 */
export class BrandChrome extends Component {
  #driverRef: HTMLDivElement | null = null;
  #observer: MutationObserver | undefined;
  #ports = new Map<SVGElement, BrandPort>();
  #mounted = false;

  override componentDidMount(): void {
    this.#mounted = true;
    const doc = this.#driverRef?.ownerDocument;
    if (doc === undefined) return;
    const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    if (Observer !== undefined) {
      this.#observer = new Observer(() => { this.sync(doc); });
      this.#observer.observe(doc.body, { childList: true, subtree: true });
    }
    this.sync(doc);
  }

  override componentWillUnmount(): void {
    this.#mounted = false;
    this.#observer?.disconnect();
    this.#observer = undefined;
    for (const original of [...this.#ports.keys()]) this.drop(original);
  }

  private ensure(doc: Document, original: SVGElement, anchor: HTMLElement, kind: HostKind): void {
    if (this.#ports.has(original)) return;
    const originalStyle = original.getAttribute("style");
    const anchorStyle = anchor.getAttribute("style");
    const host = doc.createElement("span");
    host.setAttribute(BRAND_HOST_ATTRIBUTE, kind);
    host.setAttribute("aria-hidden", "true");
    host.className = kind === "wordmark" ? css.wordmarkHost : kind === "rail" ? css.railHost : css.heroHost;
    // Make the owned host an overlay so the hidden native SVG keeps its
    // geometry and the source element keeps its native layout and hit target.
    anchor.style.position = "relative";
    original.style.visibility = "hidden";
    anchor.appendChild(host);
    const root = createRoot(host);
    root.render(<Asset kind={kind} />);
    this.#ports.set(original, { original, anchor, host, root, originalStyle, anchorStyle });
  }

  private drop(original: SVGElement): void {
    const port = this.#ports.get(original);
    if (port === undefined) return;
    port.root.unmount();
    port.host.remove();
    if (port.originalStyle === null) port.original.removeAttribute("style");
    else port.original.setAttribute("style", port.originalStyle);
    if (port.anchorStyle === null) port.anchor.removeAttribute("style");
    else port.anchor.setAttribute("style", port.anchorStyle);
    this.#ports.delete(original);
  }

  private sync(doc: Document): void {
    if (!this.#mounted) return;
    const matched = new Set<SVGElement>();
    for (const kind of ["wordmark", "rail", "hero"] as const) {
      const selector = `svg[viewBox="${kind === "wordmark" ? WORDMARK_VIEWBOX : FISH_VIEWBOX}"]`;
      for (const original of Array.from(doc.querySelectorAll<SVGElement>(selector))) {
        const anchor = svgAnchor(original, kind);
        if (anchor === null) continue;
        matched.add(original);
        this.ensure(doc, original, anchor, kind);
      }
    }
    for (const [original, port] of this.#ports) {
      if (!matched.has(original) || !original.isConnected || !port.host.isConnected) this.drop(original);
    }
  }

  override render(): ReactNode {
    return <div ref={element => { this.#driverRef = element; }} className={css.driver} data-icomposer-brand-driver="" />;
  }
}
