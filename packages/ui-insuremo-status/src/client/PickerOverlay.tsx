import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { MenuSurface } from "./primitives/MenuSurface.tsx";
import { useAnchoredPosition } from "./primitives/anchored-position.ts";
import { useDismissOnOutsidePointer } from "./primitives/dismiss.ts";
import type { PickerOverlayController, PickerOverlayPanel } from "./PickerOverlayController.ts";
import css from "./ProfilePicker.module.css";

const GAP = 8;
const MARGIN = 12;
const MEASURE_STYLE = { visibility: "hidden", left: 0, top: 0 } as const;

function RailPanel({ panel, wrapperRef }: {
  readonly panel: PickerOverlayPanel;
  readonly wrapperRef: RefObject<HTMLDivElement | null>;
}): ReactNode {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const anchorLost = useCallback(() => { panel.onDismiss(false); }, [panel.onDismiss]);
  const dismiss = useCallback(() => { panel.onDismiss(true); }, [panel.onDismiss]);
  const position = useAnchoredPosition({
    open: true,
    anchorRef: panel.anchorRef,
    panelRef,
    wrapperRef,
    onAnchorLost: anchorLost,
    side: "top",
    align: "start",
    gap: GAP,
    margin: MARGIN,
  });
  useDismissOnOutsidePointer(panel.anchorRef, true, dismiss, panelRef);

  // The panel is initially hidden for measurement. Focus once, after placement;
  // subsequent scroll/resize/panel-size corrections must not steal focus.
  const focused = useRef(false);
  useLayoutEffect(() => {
    if (focused.current || position === null || panelRef.current === null) return;
    focused.current = true;
    panelRef.current.focus();
  }, [position]);
  return (
    <MenuSurface
      ref={panelRef}
      compact
      tabIndex={-1}
      role="group"
      aria-label={panel.label}
      data-icomposer-picker-panel="rail"
      className={css.railPanel}
      style={position === null ? MEASURE_STYLE : position}
    >
      {panel.content}
    </MenuSurface>
  );
}

/** Stable slot component: acknowledgement occurs only after its wrapper commits. */
export function PickerOverlay({ pickerOverlay }: { readonly pickerOverlay: PickerOverlayController }): ReactNode {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const panel = useSyncExternalStore(pickerOverlay.subscribePanel, pickerOverlay.getPanel, pickerOverlay.getPanel);
  useLayoutEffect(() => {
    if (!wrapperRef.current?.isConnected) return;
    return pickerOverlay.mount();
  }, [pickerOverlay]);
  return (
    <div ref={wrapperRef} className={css.overlayFrame} style={{ pointerEvents: "none" }} data-icomposer-picker-overlay="">
      {panel === null ? null : <RailPanel panel={panel} wrapperRef={wrapperRef} />}
    </div>
  );
}
