/**
 * Plugin-owned anchored placement (TASK-168a): measures only this plugin's
 * trigger and panel, recomputes on scroll/resize/panel resize, and clamps
 * inside the viewport. Listener/observer cleanup is symmetric.
 */
import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

export interface AnchoredPositionOptions {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  side?: "top" | "bottom";
  align?: "start" | "end";
  gap: number;
  margin: number;
}

/** Fixed `left`/`top` for the panel, or `null` before the first measurement. */
export function useAnchoredPosition(options: AnchoredPositionOptions): CSSProperties | null {
  const { open, anchorRef, panelRef, side = "bottom", align = "start", gap, margin } = options;
  const [position, setPosition] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const place = (): void => {
      const anchor = anchorRef.current;
      if (anchor === null) return;
      const rect = anchor.getBoundingClientRect();
      const panel = panelRef.current;
      const width = panel?.offsetWidth ?? 0;
      const height = panel?.offsetHeight ?? 0;
      let left = align === "end" ? rect.right - width : rect.left;
      let top = side === "top" ? rect.top - gap - height : rect.bottom + gap;
      if (width > 0) left = Math.min(Math.max(left, margin), Math.max(margin, window.innerWidth - width - margin));
      if (height > 0) top = Math.min(Math.max(top, margin), Math.max(margin, window.innerHeight - height - margin));
      setPosition({ left, top });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    let observer: ResizeObserver | null = null;
    const panel = panelRef.current;
    if (typeof ResizeObserver !== "undefined" && panel !== null) {
      observer = new ResizeObserver(place);
      observer.observe(panel);
    }
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, anchorRef, panelRef, side, align, gap, margin]);
  return position;
}
