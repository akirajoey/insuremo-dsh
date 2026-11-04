// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { fireEvent, render, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "../src/client/primitives/Button.tsx";
import { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import { SlotTestRuntime, usePinnedBrowserLanguages } from "@deepseek-ai/dsh-client-test-runtime";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import { BrandSignal, InsuremoBrandMark, InsuremoBrandName, InsuremoHeroBrandMark } from "../src/client/InsuremoBrand.tsx";
import { apply, inject } from "../src/client/index.ts";
import { zh } from "../src/client/locales.ts";

usePinnedBrowserLanguages("zh-CN");

/**
 * TASK-144/169. The brand is composed from independent public slots: the mark
 * slot always draws the globe, the name slot draws only the lettering (the
 * local CSS crops the globe region from the owned combined PNG), and the hero
 * keeps its own globe. No component reads host ancestors or host DOM.
 */

const GLOBE = 'img[src*="insuremo-globe"]';

function mount(node: ReactNode): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
  return {
    container,
    unmount: () => {
      act(() => { root.unmount(); });
      container.remove();
    },
  };
}

/** The official wide identity row, in both host shapes. */
function wideRow(as: "span" | "button"): ReactNode {
  const signal = new BrandSignal();
  const identity = (
    <span className="brandIdentity">
      <span className="brandMark"><InsuremoBrandMark size={24} brandSignal={signal} /></span>
      <span className="brandName"><InsuremoBrandName brandSignal={signal} /></span>
    </span>
  );
  return as === "span"
    ? <span className="brand">{identity}</span>
    : <button type="button" className="brand" aria-label="New Session">{identity}</button>;
}

/** The official collapsed-rail toggle: one member of a button, panel icon included. */
const railSignal = new BrandSignal();
const railRow = (
  <button type="button" className="iconButton toggle" aria-label="Expand sidebar">
    <span className="railMark"><InsuremoBrandMark size={24} brandSignal={railSignal} /></span>
    <svg viewBox="0 0 16 16" aria-hidden="true" />
  </button>
);

describe("TASK-144 brand surfaces", () => {
  beforeEach(() => { document.body.innerHTML = ""; });
  afterEach(() => { document.body.innerHTML = ""; });

  it("expanded identity row on macOS (window-drag span) renders the complete logo without a separate mark", () => {
    const view = mount(wideRow("span"));
    expect(view.container.querySelectorAll(GLOBE)).toHaveLength(0);
    expect(view.container.querySelectorAll('img[src*="insuremo-wordmark"]')).toHaveLength(2);
    view.unmount();
  });

  it("expanded identity row elsewhere (New Session button) renders the same complete logo", () => {
    const view = mount(wideRow("button"));
    expect(view.container.querySelectorAll(GLOBE)).toHaveLength(0);
    expect(view.container.querySelectorAll('img[src*="insuremo-wordmark"]')).toHaveLength(2);
    view.unmount();
  });

  it("brand source has no ancestor walk, host query or DOM observation", () => {
    const source = readFileSync(resolve(process.cwd(), "src/client/InsuremoBrand.tsx"), "utf8");
    expect(source).not.toMatch(/parentElement|querySelector|closest|MutationObserver|document\./);
    const css = readFileSync(resolve(process.cwd(), "src/client/InsuremoBrand.module.css"), "utf8");
    expect(css).toMatch(/\.wordmark \{[^}]*width: 99px;/s);
    expect(css).not.toContain("margin-left");
    expect(css).not.toMatch(/\.wordmark \{[^}]*overflow: hidden/s);
  });

  it("the name mount signal suppresses the mark globe and restores it on unmount", async () => {
    const signal = new BrandSignal();
    const view = render(<><InsuremoBrandMark brandSignal={signal} /><InsuremoBrandName brandSignal={signal} /></>);
    expect(view.container.querySelector("[data-icomposer-brand-mark]")).toBeNull();
    expect(view.container.querySelectorAll(GLOBE)).toHaveLength(0);
    view.rerender(<InsuremoBrandMark brandSignal={signal} />);
    await vi.waitFor(() => {
      expect(view.container.querySelector("[data-icomposer-brand-mark]")).not.toBeNull();
    });
    expect(view.container.querySelectorAll(GLOBE)).toHaveLength(1);
    view.unmount();
  });

  it("collapsed rail keeps the standalone globe at the slot's 24px size", async () => {
    const view = mount(railRow);
    const globes = await vi.waitFor(() => {
      const found = view.container.querySelectorAll<HTMLImageElement>(GLOBE);
      expect(found).toHaveLength(1);
      return found;
    });
    expect(globes[0]?.getAttribute("width")).toBe("24");
    view.unmount();
  });

  it("hero keeps the standalone globe at the requested size", () => {
    const view = mount(<span className="fishHitbox"><InsuremoHeroBrandMark size={34} /></span>);
    const globes = view.container.querySelectorAll<HTMLImageElement>(GLOBE);
    expect(globes).toHaveLength(1);
    expect(globes[0]?.getAttribute("width")).toBe("34");
    expect(globes[0]?.getAttribute("height")).toBe("32");
    view.unmount();
  });
});

describe("TASK-144 hero registration", () => {
  let runtime: SlotTestRuntime;

  beforeEach(async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => { values.clear(); },
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    });
    runtime = await SlotTestRuntime.create();
    await runtime.declare({
      "sidebar.brand.mark": { kind: "single", scope: "root" },
      "sidebar.brand.name": { kind: "single", scope: "root" },
      "conversation.hero.brand.mark": { kind: "single", scope: "root" },
    });
    const locale = new LocaleRuntime(runtime.ctx);
    runtime.ctx.provide("locale", locale);
    runtime.slots.installLocale(locale);
    await runtime.mount({ inject, apply });
  });

  afterEach(async () => {
    await runtime.dispose();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("the registered hero occupant always draws the globe, even without a button host", () => {
    const view = runtime.renderSlot("conversation.hero.brand.mark", { size: 34 });
    const globes = view.container.querySelectorAll<HTMLImageElement>(GLOBE);
    expect(globes).toHaveLength(1);
    expect(globes[0]?.getAttribute("width")).toBe("34");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** Class names the shared Button atom emits for ghost/sm, to prove reuse. */
function ghostSmallButtonClasses(): string[] {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => { root.render(<Button variant="ghost" size="sm">probe</Button>); });
  const classes = [...(container.querySelector("button")?.classList ?? [])];
  act(() => { root.unmount(); });
  container.remove();
  return classes;
}

/** Long enough that the row ellipsizes, so the title is the only full copy. */
const LONG_PROFILE_NAME = "portal:very-long-workspace-profile-name-for-ellipsis-check";

const overviewPayload = {
  auth: {
    profiles: [
      { name: "portal:microsite", env: "aws_sg", tenantCode: "microsite", account: "user@example.com", isActive: true },
      { name: "portal:mo-re", env: "aws_sg", tenantCode: "mo-re", account: "user@example.com" },
      { name: LONG_PROFILE_NAME, env: "aws_sg", tenantCode: "longtenant", account: "user@example.com" },
    ],
    activeProfileName: "portal:microsite",
  },
};

describe("TASK-144 picker uses the official compact Button", () => {
  let runtime: SlotTestRuntime;
  let feature: Awaited<ReturnType<SlotTestRuntime["mount"]>>;

  beforeEach(async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => { values.clear(); },
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(overviewPayload)));
    runtime = await SlotTestRuntime.create();
    await runtime.declare({
      "sidebar.footer.action": { kind: "list", scope: "root" },
      "shell.overlay": { kind: "list", scope: "root" },
    });
    const locale = new LocaleRuntime(runtime.ctx);
    runtime.ctx.provide("locale", locale);
    runtime.slots.installLocale(locale);
    feature = await runtime.mount({ inject, apply });
  });

  afterEach(async () => {
    await feature.dispose();
    await runtime.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("wide: the trigger carries the official ghost/sm Button classes and the label", async () => {
    const view = runtime.renderSlot("sidebar.footer.action", { wide: true });
    const trigger = await view.view.findByRole("button", { name: new RegExp(zh.label) });
    expect(trigger.getAttribute("data-wide")).toBe("true");
    for (const name of ghostSmallButtonClasses()) expect(trigger.classList.contains(name)).toBe(true);
    // Once the fast overview lands, the wide trigger shows the active profile name.
    await vi.waitFor(() => expect(trigger.textContent).toContain("portal:microsite"));
    trigger.click();
    // Wide keeps the in-place panel: no portal, still inside the slot outlet.
    const listbox = await view.view.findByRole("listbox", { name: zh["picker.label"] });
    expect(view.container.contains(listbox)).toBe(true);
    expect(document.querySelector("[data-icomposer-picker-panel]")).toBeNull();
  });

  /** jsdom has no layout: give only our own frame/trigger/panel controlled rectangles. */
  function mockRailGeometry(): void {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const rect = this.hasAttribute("data-icomposer-picker-overlay")
        ? { left: 0, top: 0, width: 1024, height: 768 }
        : this.hasAttribute("data-icomposer-picker-panel")
          ? { left: 0, top: 0, width: 260, height: 180 }
          : { left: 20, top: 600, width: 36, height: 36 };
      return { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => ({}) } as DOMRect;
    });
  }

  function railPanel(): HTMLElement {
    const panel = document.querySelector<HTMLElement>('[data-icomposer-picker-panel="rail"]');
    if (panel === null) throw new Error("the rail panel was not rendered by shell.overlay");
    return panel;
  }

  it("narrow rail: the official overlay holds the full list outside the clipped footer", async () => {
    mockRailGeometry();
    let switched = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/actions/active-profile")) {
        switched = true;
        return jsonResponse({ ok: true, result: { status: "completed", profile: "portal:mo-re" } });
      }
      if (switched) {
        return jsonResponse({ auth: { profiles: overviewPayload.auth.profiles.map(p => ({ ...p, isActive: p.name === "portal:mo-re" })), activeProfileName: "portal:mo-re" } });
      }
      return jsonResponse(overviewPayload);
    }));
    const view = runtime.renderSlot("sidebar.footer.action", { wide: false });
    const overlay = runtime.renderSlot("shell.overlay", {});
    const trigger = await view.view.findByRole("button", { name: new RegExp(zh.label) });
    expect(trigger.getAttribute("data-wide")).toBe("false");
    for (const name of ghostSmallButtonClasses()) expect(trigger.classList.contains(name)).toBe(true);
    // The rail hides the footer label; the dot and the accessible name stay.
    expect(trigger.textContent?.trim()).toBe("");
    // Rail geometry: the official 36x36 rail control, not the 28px sm button.
    const railCss = readFileSync(resolve(process.cwd(), "src/client/ProfilePicker.module.css"), "utf8");
    expect(railCss).toMatch(/\.trigger\[data-wide="false"\] \{[^}]*width: 36px;[^}]*height: 36px;[^}]*border-radius: var\(--dsw-radius-md\)/s);

    trigger.click();
    const panel = await vi.waitFor(railPanel);
    // The trigger stays mounted as the anchor, and reports the open state.
    expect(document.contains(trigger)).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // The official sibling outlet, not a body portal, owns the panel.
    expect(overlay.container.contains(panel)).toBe(true);
    expect(panel.parentElement).not.toBe(document.body);
    expect(view.container.contains(panel)).toBe(false);
    // Readable frame-relative width instead of the rail's 56px.
    const panelCss = readFileSync(resolve(process.cwd(), "src/client/ProfilePicker.module.css"), "utf8");
    expect(panelCss).toMatch(/\.railPanel \{[^}]*position: absolute;/s);
    expect(panelCss).toMatch(/\.railPanel \{[^}]*width: 260px;/s);
    expect(panel.textContent).toContain("portal:microsite");

    // Focus enters the panel so the keyboard reaches the rows.
    expect(document.activeElement).toBe(panel);
    // O1: a name that ellipsizes stays complete in the row title, metadata kept.
    const longRow = within(panel).getAllByRole("option").find(el => el.textContent === LONG_PROFILE_NAME);
    expect(longRow?.getAttribute("title")).toBe(`${LONG_PROFILE_NAME} · aws_sg · longtenant · user@example.com`);
    const option = await vi.waitFor(() => {
      const found = within(panel).getAllByRole("option").find(el => el.textContent?.includes("portal:mo-re"));
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    option.click();
    await vi.waitFor(() => {
      expect(view.view.getByRole("button", { name: /portal:mo-re/ })).toBeTruthy();
    });
    // Selection collapsed the panel and left no overlay residue behind.
    expect(document.querySelector("[data-icomposer-picker-panel]")).toBeNull();
  });

  it("narrow rail: Esc and outside pointers close it, inside pointers do not, and Esc returns focus", async () => {
    mockRailGeometry();
    const view = runtime.renderSlot("sidebar.footer.action", { wide: false });
    runtime.renderSlot("shell.overlay", {});
    const trigger = await view.view.findByRole("button", { name: new RegExp(zh.label) });

    trigger.click();
    await vi.waitFor(railPanel);
    // A pointer on the panel's own content must not dismiss it.
    fireEvent.pointerDown(railPanel());
    expect(document.querySelector("[data-icomposer-picker-panel]")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    await vi.waitFor(() => expect(document.querySelector("[data-icomposer-picker-panel]")).toBeNull());
    expect(document.activeElement).toBe(trigger);

    // Reopen, then dismiss from outside.
    trigger.click();
    await vi.waitFor(railPanel);
    fireEvent.pointerDown(document.body);
    await vi.waitFor(() => expect(document.querySelector("[data-icomposer-picker-panel]")).toBeNull());

    // Unmounting while open removes the panel; the local MenuSurface adds no
    // body-level backing node (that was a Harness primitive detail).
    trigger.click();
    await vi.waitFor(railPanel);
    expect(document.querySelectorAll("[data-menu-backing]").length).toBe(0);
    await feature.dispose();
    expect(document.querySelector("[data-icomposer-picker-panel]")).toBeNull();
  });
});
