/**
 * Plugin-owned Tooltip (TASK-168a). No Harness Client value imports: the
 * bubble is positioned with fixed coordinates and clamped to the viewport, so
 * an ancestor's `overflow: hidden` cannot clip it and no body portal (and thus
 * no extra `react-dom` use) is introduced.
 *
 * Behaviour: hover/focus triggers, delayed show with cancellation, Escape and
 * outside pointer dismissal, `role="tooltip"` + `aria-describedby`, and full
 * listener/timer cleanup on hide/unmount.
 */
import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type FocusEventHandler,
  type MouseEvent,
  type MouseEventHandler,
  type ReactElement,
  type Ref,
} from "react";
import css from "./Tooltip.module.css";

export type TooltipSide = "top" | "bottom" | "right";

interface AnchorProps {
  "aria-describedby"?: string | undefined;
  ref?: Ref<HTMLElement> | undefined;
  onMouseEnter?: MouseEventHandler | undefined;
  onMouseLeave?: MouseEventHandler | undefined;
  onClick?: MouseEventHandler | undefined;
  onFocus?: FocusEventHandler | undefined;
  onBlur?: FocusEventHandler | undefined;
}

const VIEWPORT_MARGIN = 12;
const GAP = 8;

/** Show a small bubble for an anchor element (pointer and keyboard focus). */
export function Tooltip({
  label,
  side = "right",
  delayMs = 0,
  children,
}: {
  label: string | (() => string);
  side?: TooltipSide;
  delayMs?: number;
  children: ReactElement<AnchorProps>;
}) {
  const id = useId();
  const anchorRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLSpanElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; side: TooltipSide } | null>(null);

  const cancelShow = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const hide = useCallback(() => {
    cancelShow();
    setOpen(false);
    setPosition(null);
  }, [cancelShow]);

  const show = useCallback((delay: number) => {
    cancelShow();
    if (delay <= 0) {
      setOpen(true);
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpen(true);
    }, delay);
  }, [cancelShow]);

  // Unmount (or a prop change that hides) must not leave a pending timer.
  useEffect(() => cancelShow, [cancelShow]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [hide, open]);

  // Placement reads only this plugin's anchor and bubble. Fixed positioning
  // plus viewport clamping keeps the bubble visible without a portal.
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const anchor = anchorRef.current;
      const bubble = bubbleRef.current;
      if (anchor === null || bubble === null) return;
      const rect = anchor.getBoundingClientRect();
      const width = bubble.offsetWidth;
      const height = bubble.offsetHeight;
      let nextSide = side;
      let left = side === "right" ? rect.right + GAP : rect.left + rect.width / 2 - width / 2;
      let top = side === "right" ? rect.top + rect.height / 2 - height / 2
        : side === "top" ? rect.top - GAP - height : rect.bottom + GAP;
      const fitsBelow = rect.bottom + GAP + height <= window.innerHeight - VIEWPORT_MARGIN;
      const fitsAbove = rect.top - GAP - height >= VIEWPORT_MARGIN;
      if (nextSide === "bottom" && !fitsBelow && fitsAbove) nextSide = "top";
      else if (nextSide === "top" && !fitsAbove && fitsBelow) nextSide = "bottom";
      if (nextSide === "top") top = rect.top - GAP - height;
      else if (nextSide === "bottom") top = rect.bottom + GAP;
      left = Math.min(Math.max(left, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN));
      top = Math.min(Math.max(top, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN));
      setPosition({ left, top, side: nextSide });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    let observer: ResizeObserver | null = null;
    const bubble = bubbleRef.current;
    if (typeof ResizeObserver !== "undefined" && bubble !== null) {
      observer = new ResizeObserver(place);
      observer.observe(bubble);
    }
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, side]);

  const childRef = (children as ReactElement<AnchorProps> & { ref?: Ref<HTMLElement> }).ref;
  const mergedRef = useCallback((element: HTMLElement | null) => {
    anchorRef.current = element;
    if (typeof childRef === "function") childRef(element);
    else if (childRef != null && typeof childRef === "object") {
      (childRef as { current: HTMLElement | null }).current = element;
    }
  }, [childRef]);

  const anchor = cloneElement(children, {
    ref: mergedRef,
    "aria-describedby": open ? id : undefined,
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      children.props.onMouseEnter?.(event);
      show(delayMs);
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      children.props.onMouseLeave?.(event);
      hide();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      children.props.onFocus?.(event);
      show(0);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      children.props.onBlur?.(event);
      hide();
    },
    onClick: (event: MouseEvent<HTMLElement>) => {
      children.props.onClick?.(event);
      hide();
    },
  });

  return (
    <>
      {anchor}
      {open ? (
        <span
          ref={bubbleRef}
          id={id}
          role="tooltip"
          className={css.bubble}
          data-side={position?.side ?? side}
          style={position === null ? { visibility: "hidden", left: 0, top: 0 } : { left: position.left, top: position.top }}
        >
          {typeof label === "function" ? label() : label}
        </span>
      ) : null}
    </>
  );
}
