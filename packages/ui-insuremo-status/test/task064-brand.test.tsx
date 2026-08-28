// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrandChrome, BRAND_HOST_ATTRIBUTE } from "../src/client/BrandChrome.tsx";
import { BRAND_ASSET_NAMES, BRAND_ASSET_ROUTE, serveBrandAsset } from "../src/brand-assets-server.ts";
import { en, zh } from "../src/client/locales.ts";
import { WorkspaceHealth } from "../src/client/WorkspaceHealth.tsx";

function png(bytes: Buffer): { width: number; height: number; pixel(x: number, y: number): [number, number, number, number] } {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  expect(bytes[24]).toBe(8);
  expect(bytes[25]).toBe(6); // RGBA, so alpha can be inspected without compositing.
  const chunks: Buffer[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const inflated = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const rows: Buffer[] = [];
  let at = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[at++];
    const row = Buffer.from(inflated.subarray(at, at + stride));
    at += stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? row[x - 4]! : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= 4 ? previous[x - 4]! : 0;
      if (filter === 1) row[x] = (row[x]! + left) & 255;
      else if (filter === 2) row[x] = (row[x]! + up) & 255;
      else if (filter === 3) row[x] = (row[x]! + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        row[x] = (row[x]! + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 255;
      } else expect(filter).toBe(0);
    }
    rows.push(row);
    previous = row;
  }
  return { width, height, pixel: (x, y) => {
    const row = rows[y];
    expect(row).toBeDefined();
    const at = x * 4;
    return [row?.[at] ?? 0, row?.[at + 1] ?? 0, row?.[at + 2] ?? 0, row?.[at + 3] ?? 0];
  } };
}

async function packageFiles(): Promise<{ readFile(path: string): Promise<Buffer>; packageJson: { files?: string[] } }> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  return {
    readFile: (file: string) => fs.readFile(path.resolve(process.cwd(), file)),
    packageJson: JSON.parse(await fs.readFile(path.resolve(process.cwd(), "package.json"), "utf8")) as { files?: string[] },
  };
}

function wideShell(): void {
  const row = document.createElement("div");
  const button = document.createElement("button");
  button.type = "button";
  const wordmark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  wordmark.setAttribute("viewBox", "0 0 182 24");
  button.append(wordmark);
  const toggle = document.createElement("button");
  const panel = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  panel.setAttribute("viewBox", "0 0 16 16");
  toggle.append(panel);
  row.append(button, toggle);
  document.body.append(row);
}

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

const t = (key: keyof typeof en): string => en[key];

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.removeAttribute("data-ds-dark-theme");
  document.body.style.setProperty("--dsw-alias-label-primary", "rgb(230, 230, 230)");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("TASK-064 raster brand assets", () => {
  it("keeps exact source dimensions, transparent O counter, antialias alpha, and purple ink", async () => {
    const files = await packageFiles();
    const light = png(await files.readFile("assets/insuremo-wordmark-light.png"));
    const dark = png(await files.readFile("assets/insuremo-wordmark-dark.png"));
    const globe = png(await files.readFile("assets/insuremo-globe.png"));
    expect([light.width, light.height]).toEqual([312, 76]);
    expect([dark.width, dark.height]).toEqual([312, 76]);
    expect([globe.width, globe.height]).toEqual([65, 62]);
    expect(light.pixel(278, 51)[3]).toBe(0); // O center remains a hole.
    expect(dark.pixel(278, 51)[3]).toBe(0);
    expect(light.pixel(70, 45)).toEqual([0, 0, 0, 255]);
    expect(dark.pixel(70, 45)).toEqual([247, 247, 250, 255]);
    expect(light.pixel(270, 30)).toEqual([119, 122, 242, 255]);
    expect(dark.pixel(270, 30)).toEqual(light.pixel(270, 30));
    expect(light.pixel(201, 30)[3]).toBeGreaterThan(0);
    expect(light.pixel(201, 30)[3]).toBeLessThan(255);
  });

  it("uses independent emitted PNG URLs, not inline data, and has no old traced assets", async () => {
    const files = await packageFiles();
    expect(files.packageJson.files).toEqual(expect.arrayContaining([
      "lib/assets/insuremo-wordmark-light.png",
      "lib/assets/insuremo-wordmark-dark.png",
      "lib/assets/insuremo-globe.png",
    ]));
    expect(files.packageJson.files).not.toContain("assets/*.png");
    expect(files.packageJson.files).not.toContain("assets/*.svg");
    for (const name of ["insuremo-wordmark-light.png", "insuremo-wordmark-dark.png", "insuremo-globe.png"]) {
      const bytes = await files.readFile(`assets/${name}`);
      expect(bytes.toString("ascii")).not.toMatch(/data:|base64/i);
    }
    const source = (await files.readFile("src/client/BrandChrome.tsx")).toString("utf8");
    expect(source).toContain("insuremo-wordmark-light.png");
    expect(source).toContain("insuremo-wordmark-dark.png");
    expect(source).toContain("insuremo-globe.png");
    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).not.toContain("brand-assets.ts");
    const bundle = await files.readFile("lib/client.js").catch(() => Buffer.from(""));
    if (bundle.length > 0) {
      const text = bundle.toString("utf8");
      expect(text).toMatch(/\.\/assets\/insuremo-(wordmark-(?:light|dark)|globe)\.png/);
      expect(text).not.toMatch(/data:image|base64,/i);
      expect(text).not.toContain(process.cwd());
      for (const name of ["insuremo-wordmark-light.png", "insuremo-wordmark-dark.png", "insuremo-globe.png"]) {
        const emitted = await files.readFile(`lib/assets/${name}`).catch(() => Buffer.from(""));
        if (emitted.length > 0) expect(emitted).toEqual(await files.readFile(`assets/${name}`));
      }
    }
  });

  it("swaps raster light/dark files immediately without changing the owned native button", async () => {
    wideShell();
    render(<BrandChrome />);
    const host = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>(`[${BRAND_HOST_ATTRIBUTE}="wordmark"]`);
      expect(found).toBeTruthy();
      return found!;
    });
    const light = await vi.waitFor(() => {
      const found = host.querySelector<HTMLImageElement>('img[src*="wordmark-light"]');
      expect(found).toBeTruthy();
      return found!;
    });
    const dark = host.querySelector<HTMLImageElement>('img[src*="wordmark-dark"]')!;
    expect(dark).toBeTruthy();
    expect(host.textContent?.replace(/\s/g, "")).toContain("dsh");
    document.body.setAttribute("data-ds-dark-theme", "true");
    const css = await (await import("node:fs/promises")).readFile(`${process.cwd()}/src/client/BrandChrome.module.css`, "utf8");
    expect(css).toContain("body[data-ds-dark-theme]");
    expect(light.className).not.toBe(dark.className);
    const healthCss = await (await import("node:fs/promises")).readFile(`${process.cwd()}/src/client/WorkspaceHealth.module.css`, "utf8");
    expect(healthCss).toContain('var(--dsw-alias-brand-primary)');
    expect(healthCss).toMatch(/\.icon\[data-state="detected"\][\\s\\S]*?color: var\\(--dsw-alias-brand-primary\\)/);
    expect(healthCss).not.toMatch(/\.icon\[data-state="detected"\][^}]*state-success-primary/);
  });
});

describe("TASK-064 owned asset route", () => {
  function fakeResponse(): { response: any; readonly status?: number; readonly headers?: Record<string, string>; readonly body?: Buffer } {
    const result: { status?: number; headers?: Record<string, string>; body?: Buffer } = {};
    return {
      response: {
        writeHead: (status: number, headers?: Record<string, string>) => { result.status = status; result.headers = headers; },
        end: (body?: Buffer) => { result.body = body; },
      },
      get status() { return result.status; },
      get headers() { return result.headers; },
      get body() { return result.body; },
    };
  }

  it("serves exactly the three PNGs with safe immutable headers and rejects traversal", async () => {
    const path = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const assetRoot = pathToFileURL(`${path.resolve(process.cwd(), "assets")}/`);
    for (const name of BRAND_ASSET_NAMES) {
      const capture = fakeResponse();
      await serveBrandAsset({ method: "GET", url: `${BRAND_ASSET_ROUTE}/${name}?v=1` } as any, capture.response, assetRoot);
      expect(capture.status).toBe(200);
      expect(capture.headers).toMatchObject({ "content-type": "image/png", "x-content-type-options": "nosniff" });
      expect(capture.headers?.["content-length"]).toBe(String(capture.body?.byteLength));
      expect(capture.body?.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
    for (const name of [
      "other.png",
      "../insuremo-globe.png",
      "../assets/insuremo-globe.png",
      "%2e%2e/assets/insuremo-globe.png",
      "%2E%2E/assets/insuremo-globe.png",
      ".%2e/assets/insuremo-globe.png",
      "insuremo-globe.png/extra",
      "insuremo-globe.svg",
      "insuremo%2Fglobe.png",
      "insuremo%5Cglobe.png",
      "insuremo-globe.png%00",
      "insuremo-globe.png%252e%252e",
      "insuremo-globe%ZZ.png",
      "/insuremo-globe.png",
      "..\\\\assets\\\\insuremo-globe.png",
    ]) {
      const capture = fakeResponse();
      await serveBrandAsset({ method: "GET", url: `${BRAND_ASSET_ROUTE}/${name}` } as any, capture.response, assetRoot);
      expect(capture.status).toBe(404);
    }
    const head = fakeResponse();
    await serveBrandAsset({ method: "HEAD", url: `${BRAND_ASSET_ROUTE}/insuremo-globe.png` } as any, head.response, assetRoot);
    expect(head.status).toBe(200);
    expect(head.body).toBeUndefined();
    const post = fakeResponse();
    await serveBrandAsset({ method: "POST", url: `${BRAND_ASSET_ROUTE}/insuremo-globe.png` } as any, post.response, assetRoot);
    expect(post.status).toBe(405);
  });
});

describe("TASK-065 workspace glyph semantics", () => {
  it("uses only detected state for iComposer across pending and bound payloads", async () => {
    expect(en["health.iComposer"]).toBe("iComposer");
    expect(zh["health.iComposer"]).toBe("iComposer");
    const pending = treeitem("Pending");
    const bound = treeitem("Bound");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ workspaces: [
      { workspaceId: "w1", displayName: "Pending", detected: true, autoBindState: "pending", graphReady: true, explainReady: true },
      { workspaceId: "w2", displayName: "Bound", detected: true, autoBindState: "bound", graphReady: false, explainReady: false },
    ] }), { status: 200 })));
    render(<WorkspaceHealth t={t} wide />);
    const iconsFor = async (item: HTMLElement): Promise<HTMLElement[]> => vi.waitFor(() => {
      const found = [...item.querySelectorAll<HTMLElement>('[data-icomposer-workspace-health-icons] [role="img"]')];
      expect(found).toHaveLength(3);
      return found;
    });
    const pendingIcons = await iconsFor(pending);
    const boundIcons = await iconsFor(bound);
    for (const first of [pendingIcons[0]!, boundIcons[0]!]) {
      expect(first.getAttribute("aria-label")).toBe(en["health.iComposer"]);
      expect(first.getAttribute("data-state")).toBe("detected");
      expect(first.className).not.toContain("iconPending");
    }
    expect(document.querySelector('[data-state="pending"]')).toBeNull();
    await act(async () => { fireEvent.focus(boundIcons[0]!); await Promise.resolve(); });
    expect(screen.getByRole("tooltip").textContent).toBe(en["health.iComposer"]);
    await act(async () => { fireEvent.blur(boundIcons[0]!); await Promise.resolve(); });
  });
});

describe("TASK-064 workspace glyph tooltips", () => {
  it("shows each exact localized status on delayed hover and immediate keyboard focus", async () => {
    const item = treeitem("Detected");
    const rowClick = vi.fn();
    item.addEventListener("click", rowClick);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ workspaces: [{
      workspaceId: "w1", displayName: "Detected", detected: true, autoBindState: "pending", graphReady: false, explainReady: true,
    }] }), { status: 200 })));
    render(<WorkspaceHealth t={t} wide />);
    const icons = await vi.waitFor(() => {
      const found = [...item.querySelectorAll<HTMLElement>('[data-icomposer-workspace-health-icons] [role="img"]')];
      expect(found).toHaveLength(3);
      return found;
    });
    expect(icons.map(icon => icon.getAttribute("aria-label"))).toEqual([en["health.iComposer"], en["health.graphNotReady"], en["health.explainReady"]]);
    expect(icons.map(icon => icon.tabIndex)).toEqual([0, 0, 0]);
    expect(icons[0]?.getAttribute("data-state")).toBe("detected");
    expect(icons[0]?.className).not.toContain("iconPending");
    expect(item.querySelector('[data-state="pending"]')).toBeNull();
    vi.useFakeTimers();
    fireEvent.mouseEnter(icons[0]!);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(399); await Promise.resolve(); });
    expect(screen.queryByRole("tooltip")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); });
    expect(screen.getByRole("tooltip").textContent).toBe(en["health.iComposer"]);
    await act(async () => { fireEvent.mouseLeave(icons[0]!); await Promise.resolve(); });
    expect(screen.queryByRole("tooltip")).toBeNull();
    await act(async () => { fireEvent.focus(icons[1]!); await Promise.resolve(); });
    expect(screen.getByRole("tooltip").textContent).toBe(en["health.graphNotReady"]);
    fireEvent.click(icons[1]!);
    expect(rowClick).not.toHaveBeenCalled();
    await act(async () => { fireEvent.blur(icons[1]!); await Promise.resolve(); });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("uses Chinese labels and no tooltip/host for undetected workspaces", async () => {
    const item = treeitem("Undetected");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ workspaces: [{
      workspaceId: "w2", displayName: "Undetected", detected: false, autoBindState: "bound", graphReady: true, explainReady: true,
    }] }), { status: 200 })));
    render(<WorkspaceHealth t={(key) => zh[key]} wide />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(item.querySelector("[data-icomposer-workspace-health-icons]")).toBeNull();
    expect(item.querySelectorAll('[role="tooltip"]')).toHaveLength(0);
    expect(document.querySelectorAll("[data-icomposer-workspace-health]")).toHaveLength(0);
  });

  it("keeps the tooltip outside a clipped row through fixed positioning", async () => {
    const item = treeitem("Detected");
    item.style.overflow = "hidden";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ workspaces: [{
      workspaceId: "w1", displayName: "Detected", detected: true, autoBindState: "bound", graphReady: true, explainReady: false,
    }] }), { status: 200 })));
    render(<WorkspaceHealth t={t} wide />);
    const icons = await vi.waitFor(() => {
      const found = [...item.querySelectorAll<HTMLElement>('[data-icomposer-workspace-health-icons] [role="img"]')];
      expect(found).toHaveLength(3);
      return found;
    });
    await act(async () => { fireEvent.focus(icons[2]!); await Promise.resolve(); });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toBe(en["health.explainNotReady"]);
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const tooltipCss = await fs.readFile(path.resolve(process.cwd(), "../../../deepseek-harness/packages/client/ui-primitives/src/Tooltip.module.css"), "utf8");
    expect(tooltipCss).toContain("position: fixed");
  });
});
