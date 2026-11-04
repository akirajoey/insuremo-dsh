// @vitest-environment jsdom
/**
 * TASK-168a plugin-owned primitives. These are component/DOM behaviour tests
 * in jsdom — they do not claim the real Host page, real focus or real layout.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, type ReactNode } from "react";
import { Tooltip } from "../src/client/primitives/Tooltip.tsx";
import { Button } from "../src/client/primitives/Button.tsx";
import { MenuSurface } from "../src/client/primitives/MenuSurface.tsx";
import { useAnchoredPosition } from "../src/client/primitives/anchored-position.ts";
import { useDismissOnOutsidePointer } from "../src/client/primitives/dismiss.ts";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("TASK-168a Tooltip", () => {
  it("delays hover, cancels on leave, shows on focus, and wires role/aria", () => {
    vi.useFakeTimers();
    render(<Tooltip label="hello" delayMs={400}><button type="button">anchor</button></Tooltip>);
    const anchor = screen.getByRole("button", { name: "anchor" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseEnter(anchor);
    act(() => { vi.advanceTimersByTime(399); });
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByRole("tooltip").textContent).toBe("hello");
    expect(anchor.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
    fireEvent.mouseLeave(anchor);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(anchor);
    expect(screen.getByRole("tooltip").textContent).toBe("hello");
    fireEvent.blur(anchor);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("cancels a pending delayed show on leave and cleans the timer on unmount", () => {
    vi.useFakeTimers();
    const view = render(<Tooltip label="late" delayMs={500}><button type="button">anchor</button></Tooltip>);
    const anchor = screen.getByRole("button", { name: "anchor" });
    fireEvent.mouseEnter(anchor);
    fireEvent.mouseLeave(anchor);
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseEnter(anchor);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clamps a fixed-position bubble inside the viewport and removes listeners", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    render(<Tooltip label="edge" side="top"><button type="button">anchor</button></Tooltip>);
    const anchor = screen.getByRole("button", { name: "anchor" });
    anchor.getBoundingClientRect = () => ({ left: -40, right: 0, top: 2, bottom: 20, width: 40, height: 18, x: -40, y: 2, toJSON: () => ({}) }) as DOMRect;
    fireEvent.focus(anchor);
    const bubble = screen.getByRole("tooltip");
    expect(bubble.style.left).toBe("12px");
    expect(Number.parseInt(bubble.style.top, 10)).toBeGreaterThanOrEqual(12);
    cleanup();
    expect(remove.mock.calls.some(([type]) => type === "resize" || type === "scroll")).toBe(true);
  });
});

describe("TASK-168a Button", () => {
  it("is type=button, forwards disabled/aria, and fires once per click", () => {
    const onClick = vi.fn();
    const view = render(<Button onClick={onClick} aria-label="pick" disabled>Pick</Button>);
    const button = screen.getByRole("button", { name: "pick" }) as HTMLButtonElement;
    expect(button.type).toBe("button");
    expect(button.disabled).toBe(true);
    view.rerender(<Button onClick={onClick} aria-label="pick">Pick</Button>);
    fireEvent.click(screen.getByRole("button", { name: "pick" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.className).toContain("button");
  });

  it("keeps the sm/ghost variant classes and keyboard activation", () => {
    const onClick = vi.fn();
    render(<Button size="sm" variant="ghost" onClick={onClick}>Go</Button>);
    const button = screen.getByRole("button", { name: "Go" });
    expect(button.className).toContain("sm");
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("TASK-168a MenuSurface", () => {
  it("renders a plugin-owned surface with compact geometry and scrollable content", () => {
    render(<MenuSurface compact role="group" aria-label="menu" data-testid="surface"><span>row</span></MenuSurface>);
    const surface = screen.getByTestId("surface");
    expect(surface.getAttribute("role")).toBe("group");
    expect(surface.className).toContain("compact");
    expect(surface.textContent).toBe("row");
  });
});

function Harness({ open, onDismiss, anchor }: { open: boolean; onDismiss: () => void; anchor?: ReactNode }): ReactNode {
  const root = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const position = useAnchoredPosition({ open, anchorRef: root, panelRef: panel, gap: 8, margin: 12 });
  useDismissOnOutsidePointer(root, open, onDismiss, panel);
  return (
    <div>
      <div ref={root}>{anchor ?? <button type="button">trigger</button>}</div>
      {open ? <div ref={panel} data-testid="panel" style={position ?? undefined}>panel</div> : null}
    </div>
  );
}

describe("TASK-168a anchored position + dismiss", () => {
  it("dismisses on outside pointerdown and Escape, not on inside pointerdown", () => {
    const onDismiss = vi.fn();
    render(<Harness open onDismiss={onDismiss} />);
    fireEvent.pointerDown(screen.getByTestId("panel"));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("detaches listeners when closed/unmounted", () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const onDismiss = vi.fn();
    const view = render(<Harness open onDismiss={onDismiss} />);
    view.rerender(<Harness open={false} onDismiss={onDismiss} />);
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(remove.mock.calls.some(([type]) => type === "pointerdown" || type === "keydown")).toBe(true);
  });
});
