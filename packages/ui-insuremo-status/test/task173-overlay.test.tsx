// @vitest-environment jsdom
/** Real H2 slot registry + renderer, with jsdom geometry/fetch fixtures only.
 * This is not a real-App visual, focus, installation or rc.5 runtime test. */
import { act, fireEvent, render, within } from "@testing-library/react";
import { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import { SlotTestRuntime, usePinnedBrowserLanguages } from "@deepseek-ai/dsh-client-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { apply, inject } from "../src/client/index.ts";
import { WorkspaceAwareProfilePicker } from "../src/client/ProfilePicker.tsx";
import { zh, en } from "../src/client/locales.ts";

usePinnedBrowserLanguages("zh-CN");

const payload = {
  auth: {
    profiles: [{ name: "first", isActive: true }, { name: "second" }],
    activeProfileName: "first",
  },
  workspaces: [],
};
const response = (value: unknown = payload): Response => new Response(JSON.stringify(value), {
  status: 200, headers: { "Content-Type": "application/json" },
});
const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
  left, top, width, height, right: left + width, bottom: top + height,
  x: left, y: top, toJSON: () => ({}),
}) as DOMRect;

let runtime: SlotTestRuntime | undefined;
let resizeCallbacks: Set<ResizeObserverCallback>;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let geometry: { wrapper: DOMRect; anchor: DOMRect; panel: DOMRect };

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  });
  vi.stubGlobal("fetch", vi.fn(async () => response()));
  resizeCallbacks = new Set();
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: ResizeObserverCallback) { resizeCallbacks.add(callback); }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void { resizeCallbacks.delete(this.callback); }
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  geometry = {
    wrapper: rect(100, 80, 420, 300),
    anchor: rect(500, 360, 36, 36),
    panel: rect(0, 0, 260, 120),
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute("data-icomposer-picker-overlay")) return geometry.wrapper;
    if (this.hasAttribute("data-icomposer-picker-panel")) return geometry.panel;
    if (this.hasAttribute("data-wide")) return geometry.anchor;
    return rect(0, 0, 0, 0);
  });
});

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function init(): Promise<SlotTestRuntime> {
  runtime = await SlotTestRuntime.create();
  const locale = new LocaleRuntime(runtime.ctx);
  runtime.ctx.provide("locale", locale);
  runtime.slots.installLocale(locale);
  return runtime;
}

async function autoRuntime() {
  const r = await init();
  await r.declare({
    "sidebar.footer.action": { kind: "list", scope: "root" },
    "shell.overlay": { kind: "list", scope: "root" },
  });
  const feature = await r.mount({ inject, apply });
  const footer = r.renderSlot("sidebar.footer.action", { wide: false });
  return { r, feature, footer };
}

function panel(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-icomposer-picker-panel="rail"]');
  if (element === null) throw new Error("Picker panel is not mounted");
  return element;
}

function tickFrame(): void {
  const callbacks = [...frames.values()];
  frames.clear();
  act(() => { for (const callback of callbacks) callback(0); });
}

function resizeObserved(): void {
  act(() => { for (const callback of [...resizeCallbacks]) callback([], {} as ResizeObserver); });
}

async function activeTrigger(container: HTMLElement): Promise<HTMLElement> {
  return await vi.waitFor(() => {
    const trigger = within(container).getByRole("button", { name: /first/ });
    expect(trigger).toBeTruthy();
    return trigger;
  });
}

describe("TASK-173 official Picker overlay", () => {
  it("does not introduce a body portal, extra root, host query or host observer in the Picker path", () => {
    for (const name of ["ProfilePicker.tsx", "PickerOverlay.tsx", "PickerOverlayController.ts", "primitives/anchored-position.ts"]) {
      const source = readFileSync(resolve(process.cwd(), `src/client/${name}`), "utf8");
      expect(source).not.toMatch(/\b(?:createPortal|createRoot|MutationObserver)\b/);
      expect(source).not.toMatch(/document\.(?:body|querySelector|getElementById)/);
    }
  });

  it("keeps legacy direct wrapper consumers safe when no injected overlay face exists", async () => {
    const view = render(<WorkspaceAwareProfilePicker
      wide={false}
      t={key => zh[key]}
      useSessions={selector => selector({ byId: {} })}
      useWorkspaces={selector => selector({ phase: "ready", items: [] })}
    />);
    const trigger = await activeTrigger(view.container);
    fireEvent.click(trigger);
    expect(view.getByText(zh["picker.expandSidebar"]).getAttribute("role")).toBe("status");
    view.unmount();
  });

  it("requires a rendered mount acknowledgement; absent overlay gives a manual-expand hint and wide inline remains usable", async () => {
    const { r, footer } = await autoRuntime();
    expect(r.slots.spec("shell.overlay")).toEqual({ kind: "list", scope: "root" });
    expect(r.slots.entries("shell.overlay").map(entry => entry.options.id)).toEqual(["insuremo-profile-picker"]);
    const trigger = await activeTrigger(footer.container);
    expect(trigger.getAttribute("title")).toContain(zh["picker.expandSidebar"]);
    const fetchCount = vi.mocked(fetch).mock.calls.length;
    fireEvent.click(trigger);
    expect(within(footer.container).getByText(zh["picker.expandSidebar"]).getAttribute("role")).toBe("status");
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetchCount);
    expect(document.querySelector("[data-icomposer-picker-panel]")).toBeNull();

    footer.update({ wide: true });
    fireEvent.click(within(footer.container).getByRole("button", { name: /first/ }));
    expect(await within(footer.container).findByRole("option", { name: /second/ })).toBeTruthy();
    fireEvent.click(within(footer.container).getByRole("button", { name: zh["picker.close"] }));
    footer.update({ wide: false });

    const overlay = r.renderSlot("shell.overlay", {});
    const readyTrigger = within(footer.container).getByRole("button", { name: /first/ });
    expect(readyTrigger.getAttribute("title")).not.toContain(zh["picker.expandSidebar"]);
    fireEvent.click(readyTrigger);
    await vi.waitFor(() => expect(overlay.container.contains(panel())).toBe(true));
    expect(en["picker.expandSidebar"]).toContain("Expand the sidebar manually");
  });

  it("converts and clamps against its own frame, recomputes on scroll/resize/observed resize, and focuses only once", async () => {
    const { r, footer, feature } = await autoRuntime();
    const overlay = r.renderSlot("shell.overlay", {});
    const trigger = await activeTrigger(footer.container);
    fireEvent.click(trigger);
    const element = await vi.waitFor(panel);
    expect(overlay.container.contains(element)).toBe(true);
    expect(element.style.left).toBe("148px"); // 520 - 260 - 12 - frame.left
    expect(element.style.top).toBe("152px");  // 360 - 8 - 120 - frame.top
    expect(document.activeElement).toBe(element);
    const frame = overlay.container.querySelector<HTMLElement>("[data-icomposer-picker-overlay]");
    expect(frame?.style.pointerEvents).toBe("none");
    const css = readFileSync(resolve(process.cwd(), "src/client/ProfilePicker.module.css"), "utf8");
    expect(css).toMatch(/\.railPanel\s*\{[^}]*pointer-events:\s*auto/s);

    const option = await within(element).findByRole("option", { name: /second/ });
    option.focus();
    geometry.anchor = rect(110, 100, 36, 36);
    act(() => { window.dispatchEvent(new Event("scroll")); });
    expect(element.style.left).toBe("12px");
    expect(element.style.top).toBe("12px");
    expect(document.activeElement).toBe(option);

    geometry.anchor = rect(500, 360, 36, 36);
    geometry.panel = rect(0, 0, 280, 160);
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(element.style.left).toBe("128px");
    expect(element.style.top).toBe("112px");
    geometry.panel = rect(0, 0, 240, 140);
    resizeObserved();
    expect(element.style.left).toBe("168px");
    expect(element.style.top).toBe("132px");
    expect(document.activeElement).toBe(option);

    fireEvent.pointerDown(element);
    expect(panel()).toBe(element);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector("[data-icomposer-picker-panel]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(frames.size).toBe(0);
    expect(resizeCallbacks.size).toBe(0);
    await feature.dispose();
  });

  it("uses scaled wrapper-local coordinates when the frame is transformed", async () => {
    const { r, footer } = await autoRuntime();
    const overlay = r.renderSlot("shell.overlay", {});
    const wrapper = overlay.container.querySelector<HTMLElement>("[data-icomposer-picker-overlay]");
    expect(wrapper).not.toBeNull();
    Object.defineProperty(wrapper, "offsetWidth", { configurable: true, value: 210 });
    Object.defineProperty(wrapper, "offsetHeight", { configurable: true, value: 150 });
    const trigger = await activeTrigger(footer.container);
    fireEvent.click(trigger);
    const element = await vi.waitFor(panel);
    expect(element.style.left).toBe("74px");
    expect(element.style.top).toBe("76px");
  });

  it("constrains panel dimensions to the visible intersection when the frame is partly clipped", async () => {
    geometry.wrapper = rect(-100, 80, 300, 200);
    geometry.anchor = rect(175, 200, 20, 20);
    geometry.panel = rect(0, 0, 260, 160);
    const { r, footer } = await autoRuntime();
    r.renderSlot("shell.overlay", {});
    fireEvent.click(await activeTrigger(footer.container));
    const element = await vi.waitFor(panel);
    expect(element.style.maxWidth).toBe("176px"); // visible 200px minus two margins
    expect(element.style.maxHeight).toBe("176px");
    expect(element.style.left).toBe("112px"); // viewport x=12, local origin x=-100
    expect(element.style.top).toBe("12px");
  });

  it("closes and aborts its own in-flight request when the anchor disappears, with no frame/listener residue", async () => {
    let pendingSignal: AbortSignal | undefined;
    let overviewCount = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("overview?fast=1") && ++overviewCount > 1) {
        pendingSignal = init?.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(response());
    }));
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const removeDocument = vi.spyOn(document, "removeEventListener");
    const { r, footer } = await autoRuntime();
    r.renderSlot("shell.overlay", {});
    const trigger = await activeTrigger(footer.container);
    fireEvent.click(trigger);
    await vi.waitFor(() => expect(pendingSignal).toBeDefined());
    await vi.waitFor(panel);
    Object.defineProperty(trigger, "isConnected", { configurable: true, value: false });
    tickFrame();
    expect(pendingSignal?.aborted).toBe(true);
    expect(document.querySelector("[data-icomposer-picker-panel]")).toBeNull();
    expect(frames.size).toBe(0);
    expect(resizeCallbacks.size).toBe(0);
    expect(removeWindow.mock.calls.some(([name]) => name === "scroll")).toBe(true);
    expect(removeWindow.mock.calls.some(([name]) => name === "resize")).toBe(true);
    expect(removeDocument.mock.calls.some(([name]) => name === "pointerdown")).toBe(true);
    expect(removeDocument.mock.calls.some(([name]) => name === "keydown")).toBe(true);
    Object.defineProperty(trigger, "isConnected", { configurable: true, value: true });
  });

  it("closes and returns focus on outside pointer, aborting the current read", async () => {
    let count = 0;
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("overview?fast=1") && ++count > 1) {
        signal = init?.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(response());
    }));
    const { r, footer } = await autoRuntime();
    r.renderSlot("shell.overlay", {});
    const trigger = await activeTrigger(footer.container);
    fireEvent.click(trigger);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await vi.waitFor(panel);
    fireEvent.pointerDown(document.body);
    expect(signal?.aborted).toBe(true);
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector("[data-icomposer-picker-panel]")).toBeNull();
  });

  it("closes on workspace target change, aborts the old request, and rejects its late response", async () => {
    let callsA = 0;
    let oldSignal: AbortSignal | undefined;
    let resolveOld: ((value: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("workspaceId=workspace-a")) {
        if (++callsA === 1) return Promise.resolve(response());
        oldSignal = init?.signal as AbortSignal;
        return new Promise<Response>(resolve => { resolveOld = resolve; });
      }
      if (url.includes("workspaceId=workspace-b")) {
        return Promise.resolve(response({ auth: { profiles: [{ name: "profile-b", isActive: true }], activeProfileName: "profile-b" } }));
      }
      return Promise.resolve(response());
    }));
    const r = await init();
    await r.declare({ "sidebar.footer.action": { kind: "list", scope: "root" }, "shell.overlay": { kind: "list", scope: "root" } });
    const sessionA = await r.sessions.add({ id: "session-a", summary: { cwd: "/fixture-a" } });
    const sessionB = await r.sessions.add({ id: "session-b", summary: { cwd: "/fixture-b" } });
    const mainA = r.sessions.retain(sessionA, { source: "mainView" });
    await r.workspaces.update(draft => {
      draft.items = [
        { workspaceId: "workspace-a", title: "A", path: "/fixture-a", sessionIds: ["session-a"] },
        { workspaceId: "workspace-b", title: "B", path: "/fixture-b", sessionIds: ["session-b"] },
      ];
    });
    await r.mount({ inject, apply });
    const footer = r.renderSlot("sidebar.footer.action", { wide: false });
    r.renderSlot("shell.overlay", {});
    fireEvent.click(await activeTrigger(footer.container));
    await vi.waitFor(() => expect(oldSignal).toBeDefined());
    await vi.waitFor(panel);
    mainA.release();
    r.sessions.retain(sessionB, { source: "mainView" });
    await r.flush();
    expect(oldSignal?.aborted).toBe(true);
    expect(document.querySelector("[data-icomposer-picker-panel]")).toBeNull();
    await vi.waitFor(() => expect(within(footer.container).getByRole("button", { name: /profile-b/ })).toBeTruthy());
    await act(async () => {
      resolveOld?.(response({ auth: { profiles: [{ name: "stale-profile" }], activeProfileName: "stale-profile" } }));
    });
    expect(within(footer.container).queryByRole("button", { name: /stale-profile/ })).toBeNull();
    expect(within(footer.container).getByRole("button", { name: /profile-b/ })).toBeTruthy();
  });

  it("follows declaration and mount lifetimes, aborts on slot loss/unload, preserves other overlays and isolates re-apply", async () => {
    let overviewCount = 0;
    const pending: Array<{ signal: AbortSignal; resolve: (value: Response) => void }> = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("overview?fast=1") && ++overviewCount > 1) {
        return new Promise<Response>(resolve => { pending.push({ signal: init?.signal as AbortSignal, resolve }); });
      }
      return Promise.resolve(response());
    }));
    const r = await init();
    type RenderProps = { renderSlot: (name: string, owner: object) => ReactNode };
    function RootFrame({ renderSlot }: RenderProps): ReactNode {
      return <div>{renderSlot("sidebar.footer.action", { wide: false })}{renderSlot("test.overlay.owner", {})}</div>;
    }
    function OverlayOwner({ renderSlot }: RenderProps): ReactNode {
      return <div data-testid="owner">{renderSlot("shell.overlay", {})}</div>;
    }
    await r.root.declare({
      "sidebar.footer.action": { kind: "list", scope: "root" },
      "test.overlay.owner": { kind: "single", scope: "root" },
    } as never, RootFrame as never);
    const foreign = await r.mount({ inject: ["slots"], apply(ctx: Context) {
      ctx.slots.inject("shell.overlay", () => ctx.slots.register(
        { name: "shell.overlay", id: "foreign-overlay" },
        () => <span data-testid="foreign">other overlay</span>,
      ));
    } });
    let feature = await r.mount({ inject, apply });
    const view = r.renderRoot();
    expect(r.slots.spec("shell.overlay")).toBeUndefined();
    const initial = await activeTrigger(view.container);
    expect(initial.getAttribute("title")).toContain(zh["picker.expandSidebar"]);
    const mountOwner = () => r.mount({ inject: ["slots"], apply(ctx: Context) {
      ctx.slots.register({
        name: "test.overlay.owner",
        children: { "shell.overlay": { kind: "list", scope: "root" } },
      } as never, OverlayOwner as never);
    } });
    let owner = await mountOwner();
    expect(r.slots.spec("shell.overlay")).toEqual({ kind: "list", scope: "root" });
    expect(view.getByTestId("foreign")).toBeTruthy();
    const footerEntry = r.slots.entries("sidebar.footer.action").find(entry => entry.options.id === "insuremo-status")!;
    const overlayEntry = r.slots.entries("shell.overlay").find(entry => entry.options.id === "insuremo-profile-picker")!;
    const firstController = footerEntry.inject!().pickerOverlay;
    expect(overlayEntry.inject!().pickerOverlay).toBe(firstController);
    const component = overlayEntry.component;

    fireEvent.click(await activeTrigger(view.container));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await vi.waitFor(panel);
    await owner.dispose();
    expect(pending[0]?.signal.aborted).toBe(true);
    expect(document.querySelector("[data-icomposer-picker-panel]")).toBeNull();
    expect(r.slots.spec("shell.overlay")).toBeUndefined();
    expect((await activeTrigger(view.container)).getAttribute("title")).toContain(zh["picker.expandSidebar"]);

    owner = await mountOwner();
    expect(view.getByTestId("foreign")).toBeTruthy();
    expect(r.slots.entries("shell.overlay")).toHaveLength(2);
    expect(r.slots.entries("shell.overlay").find(entry => entry.options.id === "insuremo-profile-picker")?.component).toBe(component);
    fireEvent.click(await activeTrigger(view.container));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    await vi.waitFor(panel);
    await feature.dispose();
    expect(pending[1]?.signal.aborted).toBe(true);
    expect(document.querySelector("[data-icomposer-picker-panel]")).toBeNull();
    expect(view.getByTestId("foreign")).toBeTruthy();
    expect(r.slots.entries("shell.overlay").map(entry => entry.options.id)).toEqual(["foreign-overlay"]);

    feature = await r.mount({ inject, apply });
    const freshFooter = r.slots.entries("sidebar.footer.action").find(entry => entry.options.id === "insuremo-status")!;
    const freshOverlay = r.slots.entries("shell.overlay").find(entry => entry.options.id === "insuremo-profile-picker")!;
    expect(freshFooter.inject!().pickerOverlay).toBe(freshOverlay.inject!().pickerOverlay);
    expect(freshFooter.inject!().pickerOverlay).not.toBe(firstController);
    expect(freshOverlay.component).toBe(component);
    await act(async () => {
      pending[0]?.resolve(response({ auth: { profiles: [{ name: "stale" }], activeProfileName: "stale" } }));
      pending[1]?.resolve(response({ auth: { profiles: [{ name: "stale" }], activeProfileName: "stale" } }));
    });
    expect(within(view.container).queryByRole("button", { name: /stale/ })).toBeNull();
    await feature.dispose();
    await foreign.dispose();
    await owner.dispose();
  });

  it("withdraws mount acknowledgement when an outlet unmounts while its declaration remains live", async () => {
    let count = 0;
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("overview?fast=1") && ++count > 1) {
        signal = init?.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(response());
    }));
    const r = await init();
    type RenderProps = { renderSlot: (name: string, owner: object) => ReactNode };
    function Frame({ renderSlot }: RenderProps): ReactNode {
      const [shown, setShown] = useState(true);
      return <div>
        {renderSlot("sidebar.footer.action", { wide: false })}
        <button type="button" onClick={() => { setShown(value => !value); }}>toggle overlay outlet</button>
        {shown ? renderSlot("shell.overlay", {}) : null}
      </div>;
    }
    await r.root.declare({
      "sidebar.footer.action": { kind: "list", scope: "root" },
      "shell.overlay": { kind: "list", scope: "root" },
    } as never, Frame as never);
    await r.mount({ inject, apply });
    const view = r.renderRoot();
    const trigger = await activeTrigger(view.container);
    fireEvent.click(trigger);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await vi.waitFor(panel);
    fireEvent.click(view.getByRole("button", { name: "toggle overlay outlet" }));
    expect(signal?.aborted).toBe(true);
    expect(r.slots.spec("shell.overlay")).toEqual({ kind: "list", scope: "root" });
    expect(r.slots.entries("shell.overlay")).toHaveLength(1);
    expect(document.querySelector("[data-icomposer-picker-panel]")).toBeNull();
    expect(trigger.getAttribute("title")).toContain(zh["picker.expandSidebar"]);
    fireEvent.click(view.getByRole("button", { name: "toggle overlay outlet" }));
    await vi.waitFor(() => expect(trigger.getAttribute("title")).not.toContain(zh["picker.expandSidebar"]));
  });

  it("retries a failed fast overview once while the overlay remains open", async () => {
    let overviewCalls = 0;
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("overview?fast=1")) {
        urls.push(url);
        expect((init?.headers as Record<string, string>).Accept).toBe("application/json");
        overviewCalls += 1;
        if (overviewCalls === 2) return new Response("{}", { status: 503 });
      }
      return response();
    }));
    const { r, footer } = await autoRuntime();
    r.renderSlot("shell.overlay", {});
    fireEvent.click(await activeTrigger(footer.container));
    const surface = await vi.waitFor(panel);
    expect(await within(surface).findByRole("option", { name: /second/ })).toBeTruthy();
    expect(overviewCalls).toBe(3); // warm, failed open, one retry
    expect(urls.every(url => url.endsWith("/overview?fast=1"))).toBe(true);
  });

  it("keeps HTTP selection semantics and permits retry after an action failure in the overlay", async () => {
    let attempts = 0;
    let selected = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/actions/active-profile")) {
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>)["X-Workbench-Action"]).toBe("1");
        expect(JSON.parse(String(init?.body))).toEqual({ profile: "second" });
        attempts += 1;
        if (attempts === 1) return response({ ok: false, error: { code: "busy", message: "busy" } });
        selected = true;
        return response({ ok: true, result: { status: "completed", profile: "second" } });
      }
      return response(selected ? { ...payload, auth: { ...payload.auth, activeProfileName: "second" } } : payload);
    }));
    const { r, footer } = await autoRuntime();
    r.renderSlot("shell.overlay", {});
    const trigger = await activeTrigger(footer.container);
    fireEvent.click(trigger);
    const surface = await vi.waitFor(panel);
    fireEvent.click(await within(surface).findByRole("option", { name: /second/ }));
    expect(await within(surface).findByRole("alert")).toBeTruthy();
    fireEvent.click(within(surface).getByRole("option", { name: /second/ }));
    await vi.waitFor(() => expect(within(footer.container).getByRole("button", { name: /second/ })).toBeTruthy());
    expect(attempts).toBe(2);
    expect(document.querySelector("[data-icomposer-picker-panel]")).toBeNull();
  });
});
