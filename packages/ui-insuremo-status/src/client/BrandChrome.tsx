import { Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { INSUREMO_GLOBE_SVG, INSUREMO_WORDMARK_SVG } from "./brand-assets.ts";
import css from "./BrandChrome.module.css";

/** Stable DOM signatures owned by the Harness sidebar shell. */
const WORDMARK_VIEWBOX = "0 0 182 24";
const FISH_VIEWBOX = "0 0 23.16 17.04";
const PANEL_VIEWBOX = "0 0 16 16";
export const BRAND_HOST_ATTRIBUTE = "data-icomposer-brand-host";
type HostKind = "wordmark" | "rail";

interface BrandPort {
  readonly original: SVGElement;
  readonly button: HTMLButtonElement;
  readonly host: HTMLSpanElement;
  readonly root: Root;
  readonly originalStyle: string | null;
  readonly buttonStyle: string | null;
}

function svgButton(svg: SVGElement, kind: HostKind): HTMLButtonElement | null {
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
  const svg = kind === "wordmark" ? INSUREMO_WORDMARK_SVG : INSUREMO_GLOBE_SVG;
  return <span className={kind === "wordmark" ? css.wordmark : css.railMark} data-icomposer-brand-asset={kind} dangerouslySetInnerHTML={{ __html: svg }} />;
}

function OwnedWordmark(): ReactNode {
  return <span className={css.wordmarkInner} aria-hidden="true"><Asset kind="wordmark" /><span className={css.dsh}>dsh</span></span>;
}

function OwnedRailMark(): ReactNode {
  return <Asset kind="rail" />;
}

/**
 * Hidden client driver that overlays only the two Harness-owned brand SVGs.
 * The source buttons remain the click/focus/tooltip owners; each original SVG
 * is merely visibility-hidden and restored, while every portal host is removed
 * on unmount or when the shell replaces a button.
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

  private ensure(doc: Document, original: SVGElement, button: HTMLButtonElement, kind: HostKind): void {
    if (this.#ports.has(original)) return;
    const originalStyle = original.getAttribute("style");
    const buttonStyle = button.getAttribute("style");
    const host = doc.createElement("span");
    host.setAttribute(BRAND_HOST_ATTRIBUTE, kind);
    host.setAttribute("aria-hidden", "true");
    host.className = kind === "wordmark" ? css.wordmarkHost : css.railHost;
    // Make the owned host an overlay so the hidden native SVG keeps its
    // geometry and the button keeps its native layout and hit target.
    button.style.position = "relative";
    original.style.visibility = "hidden";
    button.appendChild(host);
    const root = createRoot(host);
    root.render(kind === "wordmark" ? <OwnedWordmark /> : <OwnedRailMark />);
    this.#ports.set(original, { original, button, host, root, originalStyle, buttonStyle });
  }

  private drop(original: SVGElement): void {
    const port = this.#ports.get(original);
    if (port === undefined) return;
    port.root.unmount();
    port.host.remove();
    if (port.originalStyle === null) port.original.removeAttribute("style");
    else port.original.setAttribute("style", port.originalStyle);
    if (port.buttonStyle === null) port.button.removeAttribute("style");
    else port.button.setAttribute("style", port.buttonStyle);
    this.#ports.delete(original);
  }

  private sync(doc: Document): void {
    if (!this.#mounted) return;
    const matched = new Set<SVGElement>();
    for (const kind of ["wordmark", "rail"] as const) {
      const selector = `svg[viewBox="${kind === "wordmark" ? WORDMARK_VIEWBOX : FISH_VIEWBOX}"]`;
      for (const original of Array.from(doc.querySelectorAll<SVGElement>(selector))) {
        const button = svgButton(original, kind);
        if (button === null) continue;
        matched.add(original);
        this.ensure(doc, original, button, kind);
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
