/**
 * Plugin-owned anchored placement: only the caller's anchor, panel and optional
 * overlay wrapper are measured. With a wrapper, client coordinates are
 * clamped to the visible frame and converted to wrapper-local CSS coordinates.
 */
import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

export interface AnchoredPositionOptions {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  /** Plugin-owned, frame-sized child of the official overlay seat. */
  wrapperRef?: RefObject<HTMLElement | null>;
  /** Called once when an open panel's own anchor is disconnected. */
  onAnchorLost?: () => void;
  side?: "top" | "bottom";
  align?: "start" | "end";
  gap: number;
  margin: number;
}

/** Coordinates relative to the wrapper, or viewport coordinates without one. */
export function useAnchoredPosition(options: AnchoredPositionOptions): CSSProperties | null {
  const { open, anchorRef, panelRef, wrapperRef, onAnchorLost, side = "bottom", align = "start", gap, margin } = options;
  const [position, setPosition] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    let active = true;
    let lost = false;
    let frame = 0;
    const place = (): void => {
      if (!active) return;
      const anchor = anchorRef.current;
      if (anchor === null || (onAnchorLost !== undefined && !anchor.isConnected)) {
        if (!lost && onAnchorLost !== undefined) {
          lost = true;
          onAnchorLost();
        }
        return;
      }
      const panel = panelRef.current;
      const wrapper = wrapperRef?.current;
      if (panel === null || (wrapperRef !== undefined && wrapper == null)) return;
      const bounds = wrapper?.getBoundingClientRect();
      if (bounds !== undefined && (bounds.width <= 0 || bounds.height <= 0)) return;
      const scaleX = bounds !== undefined && wrapper && wrapper.offsetWidth > 0 ? bounds.width / wrapper.offsetWidth : 1;
      const scaleY = bounds !== undefined && wrapper && wrapper.offsetHeight > 0 ? bounds.height / wrapper.offsetHeight : 1;
      const frameLeft = Math.max(0, bounds?.left ?? 0);
      const frameTop = Math.max(0, bounds?.top ?? 0);
      const frameRight = Math.min(window.innerWidth, bounds?.right ?? window.innerWidth);
      const frameBottom = Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight);
      if (frameRight <= frameLeft || frameBottom <= frameTop) return;
      const rect = anchor.getBoundingClientRect();
      const measuredPanel = panel.getBoundingClientRect();
      const maxWidth = Math.max(0, (frameRight - frameLeft - 2 * margin) / scaleX);
      const maxHeight = Math.max(0, Math.min(420, (frameBottom - frameTop - 2 * margin) / scaleY));
      // The wrapper may itself be partly clipped by the viewport. Constrain
      // the panel to the intersection, not merely to the wrapper's full size.
      const width = Math.min(measuredPanel.width || panel.offsetWidth * scaleX, maxWidth * scaleX);
      const height = Math.min(measuredPanel.height || panel.offsetHeight * scaleY, maxHeight * scaleY);
      let left = align === "end" ? rect.right - width : rect.left;
      let top = side === "top" ? rect.top - gap - height : rect.bottom + gap;
      if (width > 0) left = Math.min(Math.max(left, frameLeft + margin), Math.max(frameLeft + margin, frameRight - width - margin));
      if (height > 0) top = Math.min(Math.max(top, frameTop + margin), Math.max(frameTop + margin, frameBottom - height - margin));
      left = (left - (bounds?.left ?? 0)) / scaleX;
      top = (top - (bounds?.top ?? 0)) / scaleY;
      const next = wrapperRef === undefined ? { left, top } : { left, top, maxWidth, maxHeight };
      setPosition(previous => previous?.left === next.left && previous.top === next.top
        && previous.maxWidth === next.maxWidth && previous.maxHeight === next.maxHeight ? previous : next);
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(place);
      if (panelRef.current !== null) observer.observe(panelRef.current);
      if (anchorRef.current !== null) observer.observe(anchorRef.current);
      if (wrapperRef?.current != null) observer.observe(wrapperRef.current);
    }
    // An anchor can disappear without a scroll/resize event. Do not observe the
    // host DOM: while open, inspect only this anchor's connectivity once/frame.
    const checkAnchor = (): void => {
      if (!active) return;
      if (anchorRef.current === null || !anchorRef.current.isConnected) {
        place();
        return;
      }
      frame = requestAnimationFrame(checkAnchor);
    };
    if (onAnchorLost !== undefined) frame = requestAnimationFrame(checkAnchor);
    return () => {
      active = false;
      if (frame !== 0) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, anchorRef, panelRef, wrapperRef, onAnchorLost, side, align, gap, margin]);
  return position;
}
