/** Plugin-owned dismissal (TASK-168a): outside pointer + Escape, with cleanup. */
import { useEffect, type RefObject } from "react";

/**
 * Close an open surface when a pointerdown lands outside the root/portal, or
 * when Escape is pressed. Listeners detach with the effect.
 */
export function useDismissOnOutsidePointer(
  root: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
  portal?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node
        && root.current?.contains(event.target) !== true
        && portal?.current?.contains(event.target) !== true) {
        onDismiss();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDismiss();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [root, open, onDismiss, portal]);
}
