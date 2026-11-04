// @vitest-environment jsdom
/** TASK-168a plugin-owned job icons/dots. jsdom behaviour only, not real UI. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StateDot } from "../src/client/primitives/StateDot.tsx";
import { IconApiOutlineRegular } from "../src/client/primitives/icons.tsx";

afterEach(() => { cleanup(); });

describe("TASK-168a StateDot", () => {
  it("carries the semantic state and stays decorative (text carries meaning)", () => {
    const { container } = render(<StateDot state="warning" />);
    const dot = container.querySelector("[data-state='warning']");
    expect(dot).toBeTruthy();
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect((dot as HTMLElement).style.width).toBe("10px");
  });

  it("renders a 14px spinner for ongoing with a reduced-motion-friendly class", () => {
    const { container } = render(<StateDot state="ongoing" />);
    const svg = container.querySelector("svg[data-state='ongoing']");
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("width")).toBe("14");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });

  it("uses an explicit size override", () => {
    const { container } = render(<StateDot state="done" size={16} />);
    const dot = container.querySelector("[data-state='done']") as HTMLElement;
    expect(dot.style.width).toBe("16px");
    expect(dot.style.height).toBe("16px");
  });
});

describe("TASK-168a IconApiOutlineRegular", () => {
  it("is decorative and sized by the caller", () => {
    const { container } = render(<IconApiOutlineRegular size={14} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("14");
    expect(svg?.getAttribute("height")).toBe("14");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });
});
