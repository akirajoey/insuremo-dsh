import type { ReactNode } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrandChrome, BRAND_HOST_ATTRIBUTE } from "../src/client/BrandChrome.tsx";
import { en, zh } from "../src/client/locales.ts";
import { WorkspaceHealth } from "../src/client/WorkspaceHealth.tsx";

function wideShell(): { row: HTMLDivElement; brand: HTMLButtonElement; native: SVGElement; toggle: HTMLButtonElement } {
  const row = document.createElement("div");
  const brand = document.createElement("button");
  brand.type = "button";
  brand.setAttribute("aria-label", "New Session");
  const native = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  native.setAttribute("viewBox", "0 0 182 24");
  brand.append(native);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.setAttribute("aria-label", "Collapse sidebar");
  const panel = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  panel.setAttribute("viewBox", "0 0 16 16");
  toggle.append(panel);
  row.append(brand, toggle);
  document.body.append(row);
  return { row, brand, native, toggle };
}

function railShell(): { row: HTMLDivElement; toggle: HTMLButtonElement; native: SVGElement; panel: SVGElement } {
  const row = document.createElement("div");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.setAttribute("aria-label", "Open sidebar");
  const native = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  native.setAttribute("viewBox", "0 0 23.16 17.04");
  const panel = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  panel.setAttribute("viewBox", "0 0 16 16");
  toggle.append(native, panel);
  row.append(toggle);
  document.body.append(row);
  return { row, toggle, native, panel };
}

const t = (key: keyof typeof en): string => en[key];
function mount(node: ReactNode): { root: Root; unmount: () => Promise<void> } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
  return { root, unmount: async () => { await act(async () => { root.unmount(); }); } };
}
async function eventually(check: () => void): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try { check(); return; } catch { await new Promise(resolve => setTimeout(resolve, 0)); }
  }
  check();
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.removeAttribute("data-ds-dark-theme");
  document.body.style.setProperty("--dsw-alias-label-primary", "rgb(230, 230, 230)");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("TASK-063 owned brand chrome", () => {
  it("overlays the wide wordmark without changing the native button contract", async () => {
    const shell = wideShell();
    shell.native.setAttribute("style", "opacity: 0.4");
    shell.brand.setAttribute("style", "position: fixed");
    const clicks = vi.fn();
    shell.brand.addEventListener("click", clicks);
    const view = mount(<BrandChrome />);
    let host!: HTMLElement;
    await eventually(() => { host = document.querySelector<HTMLElement>(`[${BRAND_HOST_ATTRIBUTE}="wordmark"]`)!; expect(host).toBeTruthy(); });
    expect(host.querySelector('img[src*="insuremo-wordmark-light"]')).toBeTruthy();
    expect(host.querySelector('img[src*="insuremo-wordmark-dark"]')).toBeTruthy();
    expect(host.textContent?.replace(/\s/g, "")).toContain("dsh");
    expect(shell.native.isConnected).toBe(true);
    expect(shell.native.style.visibility).toBe("hidden");
    expect(shell.brand.getAttribute("aria-label")).toBe("New Session");
    expect(document.querySelectorAll("button")).toHaveLength(2);
    shell.brand.click();
    expect(clicks).toHaveBeenCalledTimes(1);
    shell.brand.focus();
    expect(document.activeElement).toBe(shell.brand);

    const originalHost = host;
    const light = host.querySelector<HTMLImageElement>('img[src*="insuremo-wordmark-light"]')!;
    const dark = host.querySelector<HTMLImageElement>('img[src*="insuremo-wordmark-dark"]')!;
    expect(light.alt).toBe("");
    expect(dark.alt).toBe("");
    document.body.setAttribute("data-ds-dark-theme", "true");
    expect(document.body.hasAttribute("data-ds-dark-theme")).toBe(true);
    expect(document.querySelector(`[${BRAND_HOST_ATTRIBUTE}=\"wordmark\"]`)).toBe(originalHost);
    document.body.removeAttribute("data-ds-dark-theme");
    await view.unmount();
    expect(document.querySelector(`[${BRAND_HOST_ATTRIBUTE}=\"wordmark\"]`)).toBeNull();
    expect(shell.native.getAttribute("style")).toBe("opacity: 0.4");
    expect(shell.brand.getAttribute("style")).toBe("position: fixed");
  });

  it("swaps the collapsed resting mark while retaining the panel hover icon and restoring on dispose", async () => {
    const shell = railShell();
    const view = mount(<BrandChrome />);
    let host!: HTMLElement;
    await eventually(() => { host = document.querySelector<HTMLElement>(`[${BRAND_HOST_ATTRIBUTE}="rail"]`)!; expect(host).toBeTruthy(); });
    expect(host.querySelector('img[src*="insuremo-globe"]')).toBeTruthy();
    expect(host.textContent?.replace(/\s/g, "")).toBe("");
    expect(shell.native.style.visibility).toBe("hidden");
    expect(shell.panel.isConnected).toBe(true);
    expect(shell.toggle.getAttribute("aria-label")).toBe("Open sidebar");
    expect(document.querySelectorAll("button")).toHaveLength(1);
    await view.unmount();
    await eventually(() => expect(document.querySelector(`[${BRAND_HOST_ATTRIBUTE}=\"rail\"]`)).toBeNull());
    expect(shell.native.style.visibility).toBe("");
    expect(shell.toggle.getAttribute("style")).toBeNull();
  });

  it("reconciles a wide-to-rail DOM replacement and removes stale owned hosts", async () => {
    const wide = wideShell();
    const view = mount(<BrandChrome />);
    await eventually(() => expect(document.querySelector(`[${BRAND_HOST_ATTRIBUTE}=\"wordmark\"]`)).toBeTruthy());
    wide.row.remove();
    const rail = railShell();
    await eventually(() => expect(document.querySelector(`[${BRAND_HOST_ATTRIBUTE}=\"wordmark\"]`)).toBeNull());
    await eventually(() => expect(document.querySelector(`[${BRAND_HOST_ATTRIBUTE}=\"rail\"]`)).toBeTruthy());
    expect(wide.native.style.visibility).toBe("");
    expect(rail.native.style.visibility).toBe("hidden");
    await view.unmount();
  });

  it("keeps the theme switch attribute-driven and ships owned non-base64 assets", async () => {
    const source = await import("node:fs/promises");
    const path = await import("node:path");
    const packageJson = JSON.parse(await source.readFile(path.resolve(process.cwd(), "package.json"), "utf8")) as { files?: string[] };
    expect(packageJson.files).toEqual(expect.arrayContaining([
      "lib/assets/insuremo-wordmark-light.png",
      "lib/assets/insuremo-wordmark-dark.png",
      "lib/assets/insuremo-globe.png",
    ]));
    expect(packageJson.files).not.toContain("assets/*.svg");
    for (const file of ["insuremo-wordmark-light.png", "insuremo-wordmark-dark.png", "insuremo-globe.png"]) {
      const bytes = await source.readFile(path.resolve(process.cwd(), "assets", file));
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(bytes.toString("ascii")).not.toMatch(/data:|base64/i);
    }
    const css = await source.readFile(path.resolve(process.cwd(), "src/client/BrandChrome.module.css"), "utf8");
    expect(css).toContain("body[data-ds-dark-theme]");
    expect(css).toContain("button:hover");
    expect(t("health.graphReady")).toBe("ICI Graph · Ready");
    expect(zh["health.graphReady"]).toBe("ICI Graph · 就绪");
  });
});

describe("TASK-063 workspace health detection gate", () => {
  function treeitem(label: string): HTMLDivElement {
    const item = document.createElement("div");
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-expanded", "false");
    const title = document.createElement("span");
    title.className = "projectText";
    title.textContent = label;
    const actions = document.createElement("span");
    actions.className = "rowActions";
    item.append(title, actions);
    document.body.append(item);
    return item;
  }

  it("creates exactly three labeled icons only for detected workspaces and cleans them on a false poll", async () => {
    const item = treeitem("Detected");
    const responses = [
      { workspaces: [{ workspaceId: "w1", displayName: "Detected", detected: true, autoBindState: "pending", graphReady: false, explainReady: true }] },
      { workspaces: [{ workspaceId: "w1", displayName: "Detected", detected: false, autoBindState: "none", graphReady: true, explainReady: true }] },
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    let poll!: () => void;
    vi.stubGlobal("setInterval", ((callback: () => void) => { poll = callback; return 1; }) as typeof setInterval);
    vi.stubGlobal("clearInterval", (() => undefined) as typeof clearInterval);
    const view = mount(<WorkspaceHealth t={t} wide />);
    await eventually(() => expect(item.querySelectorAll("[data-icomposer-workspace-health-icons] > *")).toHaveLength(3));
    const icons = [...item.querySelectorAll<HTMLElement>("[data-icomposer-workspace-health-icons] > *")];
    expect(icons.map(icon => icon.getAttribute("aria-label"))).toEqual([en["health.iComposer"], en["health.graphNotReady"], en["health.explainReady"]]);
    expect(icons[0]?.getAttribute("data-state")).toBe("detected");
    expect(icons[0]?.className).not.toContain("iconPending");
    expect(icons.map(icon => icon.getAttribute("title"))).toEqual([null, null, null]);
    expect(icons.map(icon => icon.getAttribute("tabindex"))).toEqual(["0", "0", "0"]);
    expect(item.querySelectorAll("svg")).toHaveLength(3);
    poll();
    await eventually(() => expect(item.querySelector("[data-icomposer-workspace-health-icons]")).toBeNull());
    expect(item.querySelectorAll("svg")).toHaveLength(0);
    expect(document.querySelectorAll("[data-icomposer-workspace-health]")).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await view.unmount();
  });

  it("preserves duplicate-title row identity when the first filtered row disappears", async () => {
    const first = treeitem("Same title");
    const second = treeitem("Same title");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ workspaces: [
      { workspaceId: "w1", displayName: "Same title", detected: true, autoBindState: "bound", graphReady: true, explainReady: true },
      { workspaceId: "w2", displayName: "Same title", detected: true, autoBindState: "pending", graphReady: false, explainReady: false },
    ] }), { status: 200 })));
    const view = mount(<WorkspaceHealth t={t} wide />);
    await eventually(() => expect(document.querySelectorAll("[data-icomposer-workspace-health-icons]")).toHaveLength(2));
    expect(first.querySelector("[data-icomposer-workspace-id=\"w1\"]")).toBeTruthy();
    expect(second.querySelector("[data-icomposer-workspace-id=\"w2\"]")).toBeTruthy();
    first.remove();
    await eventually(() => expect(document.querySelectorAll("[data-icomposer-workspace-health-icons]")).toHaveLength(1));
    expect(second.querySelector("[data-icomposer-workspace-id=\"w2\"]")).toBeTruthy();
    expect(second.querySelector("[data-icomposer-workspace-id=\"w1\"]")).toBeNull();
    await view.unmount();
  });

  it("does not create any icon host for undetected rows", async () => {
    const item = treeitem("Undetected");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ workspaces: [{ workspaceId: "w2", displayName: "Undetected", detected: false, autoBindState: "bound", graphReady: true, explainReady: true }] }), { status: 200 })));
    const view = mount(<WorkspaceHealth t={t} wide />);
    await eventually(() => expect(document.querySelector("[data-icomposer-workspace-health-driver]")).toBeTruthy());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(item.querySelector("[data-icomposer-workspace-health-icons]")).toBeNull();
    expect(document.querySelectorAll("[data-icomposer-workspace-health]")).toHaveLength(0);
    await view.unmount();
  });
});
