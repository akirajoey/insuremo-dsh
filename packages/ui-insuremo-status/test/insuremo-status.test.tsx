import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import {
  SlotTestRuntime,
  usePinnedBrowserLanguages,
} from "@deepseek-ai/dsh-client-test-runtime";
import { resolveSlotLabel } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import { apply, inject, NS } from "../src/client/index.ts";
import { en, zh } from "../src/client/locales.ts";

usePinnedBrowserLanguages("zh-CN");

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("InsureMO sidebar status", () => {
  let runtime: SlotTestRuntime;
  let locale: LocaleRuntime;
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
    runtime = await SlotTestRuntime.create();
    await runtime.declare({ "sidebar.footer.action": { kind: "list", scope: "root" } });
    locale = new LocaleRuntime(runtime.ctx);
    runtime.ctx.provide("locale", locale);
    runtime.slots.installLocale(locale);
    feature = await runtime.mount({ inject, apply });
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  it("registers and renders the InsureMO footer badge + workspace health strip", () => {
    const entries = runtime.slots.entries("sidebar.footer.action");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.options.id).toBe("insuremo-status");
    expect(entries[1]?.options.id).toBe("insuremo-workspace-health");
    expect(entries[0]?.locale).toBe(NS);
    expect(resolveSlotLabel(entries[0]?.options.label)).toBe(zh.label);
    expect(resolveSlotLabel(entries[1]?.options.label)).toBe(zh["health.strip"]);

    const view = runtime.renderSlot("sidebar.footer.action", { wide: true });
    expect(view.view.getByRole("button", { name: zh.label })).toBeTruthy();
    expect(view.view.getByText("InsureMO", { exact: false })).toBeTruthy();
  });

  it("switches between Chinese and English status copy", async () => {
    const view = runtime.renderSlot("sidebar.footer.action", { wide: true });
    expect(view.view.getByText(zh.label)).toBeTruthy();

    locale.setLocale("en");
    await runtime.flush();
    expect(view.view.getByText(en.label)).toBeTruthy();
  });

  it("removes both footer registrations when disposed", async () => {
    expect(runtime.slots.entries("sidebar.footer.action")).toHaveLength(2);
    await feature.dispose();
    expect(runtime.slots.entries("sidebar.footer.action")).toHaveLength(0);
  });
});

describe("WorkspaceHealth", () => {
  it("parseWorkspaceHealthRows clamps states and drops garbage", async () => {
    const { parseWorkspaceHealthRows } = await import("../src/client/WorkspaceHealth.tsx");
    const rows = parseWorkspaceHealthRows({ workspaces: [
      { workspaceId: "a", detected: true, autoBindState: "bound", graphReady: true, explainReady: true },
      { workspaceId: "b", detected: true, autoBindState: "weird", graphReady: false, explainReady: false },
      { workspaceId: "c" },
      "garbage",
    ] });
    expect(rows).toHaveLength(3);
    const [a, b, c] = rows as ReadonlyArray<{ detected: boolean; autoBindState: string; graphReady: boolean; explainReady: boolean }>;
    expect([a.autoBindState, a.graphReady, a.explainReady]).toEqual(["bound", true, true]);
    expect(b.autoBindState).toBe("none");
    expect([c.detected, c.autoBindState]).toEqual([false, "none"]);
    expect(parseWorkspaceHealthRows({})).toBeNull();
    expect(parseWorkspaceHealthRows({ workspaces: "no" })).toBeNull();
  });

});

describe("ProfilePicker (TASK-036)", () => {
  let runtime: SlotTestRuntime;
  let locale: LocaleRuntime;
  let feature: Awaited<ReturnType<SlotTestRuntime["mount"]>>;

  const overviewPayload = {
    auth: {
      profiles: [
        { name: "portal:microsite", env: "aws_sg_insuremo_portal", tenantCode: "microsite", account: "user@example.com", isDefault: true, valid: true },
        { name: "portal:mo-re", env: "aws_sg_insuremo_portal", tenantCode: "mo-re", account: "user@example.com", valid: true },
      ],
      defaultProfileName: "portal:microsite",
    },
  };

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
    await runtime.declare({ "sidebar.footer.action": { kind: "list", scope: "root" } });
    locale = new LocaleRuntime(runtime.ctx);
    runtime.ctx.provide("locale", locale);
    runtime.slots.installLocale(locale);
    feature = await runtime.mount({ inject, apply });
  });

  afterEach(async () => {
    await runtime.dispose();
    vi.unstubAllGlobals();
  });

  it("expands into text rows (no select chrome), tooltip carries env/account/tenant, fast channel URL", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(overviewPayload));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("sidebar.footer.action", { wide: true });
    (await view.view.findByRole("button", { name: new RegExp(zh.label) })).click();
    // text-row listbox, not a native select
    const listbox = await view.view.findByRole("listbox", { name: zh["picker.label"] });
    expect(listbox).toBeTruthy();
    const rows = await vi.waitFor(() => {
      const found = view.view.getAllByRole("option");
      expect(found.length).toBe(2);
      return found as HTMLElement[];
    });
    expect(rows[0].textContent).toContain("portal:microsite");
    expect(rows[0].textContent).toContain("✓");
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
    // tooltip = env · tenant · account
    expect(rows[1].title).toBe("aws_sg_insuremo_portal · mo-re · user@example.com");
    // fast channel
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/overview?fast=1"), expect.anything());
  });

  it("selecting a profile POSTs the action envelope and collapses with the new default", async () => {
    let switched = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions/default-profile")) {
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>)["X-Workbench-Action"]).toBe("1");
        expect(JSON.parse(String(init?.body))).toEqual({ profile: "portal:mo-re" });
        switched = true;
        return jsonResponse({ ok: true, result: { status: "completed", profile: "portal:mo-re" } });
      }
      if (url.includes("/overview") && switched) {
        return jsonResponse({ auth: { profiles: overviewPayload.auth.profiles.map(p => ({ ...p, isDefault: p.name === "portal:mo-re" })), defaultProfileName: "portal:mo-re" } });
      }
      return jsonResponse(overviewPayload);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("sidebar.footer.action", { wide: true });
    (await view.view.findByRole("button", { name: new RegExp(zh.label) })).click();
    const row = await vi.waitFor(() => {
      const options = view.view.getAllByRole("option");
      const target = options.find(el => el.textContent?.includes("portal:mo-re"));
      expect(target).toBeTruthy();
      return target as HTMLElement;
    });
    row.click();
    await vi.waitFor(() => {
      const actionCall = fetchMock.mock.calls.find(call => String(call[0]).includes("/actions/default-profile"));
      expect(actionCall).toBeTruthy();
    });
    await vi.waitFor(() => {
      expect(view.view.getByRole("button", { name: new RegExp("portal:mo-re") })).toBeTruthy();
    });
  });

  it("action failure shows the inline error and stays open", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/actions/default-profile")) {
        return jsonResponse({ ok: false, error: { code: "busy", message: "busy" } });
      }
      return jsonResponse(overviewPayload);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("sidebar.footer.action", { wide: true });
    (await view.view.findByRole("button", { name: new RegExp(zh.label) })).click();
    const row = await vi.waitFor(() => {
      const options = view.view.getAllByRole("option");
      const target = options.find(el => el.textContent?.includes("portal:mo-re"));
      expect(target).toBeTruthy();
      return target as HTMLElement;
    });
    row.click();
    expect(await view.view.findByRole("alert")).toBeTruthy();
    expect(view.view.getByRole("listbox")).toBeTruthy();
  });
});

describe("theme variable regression (TASK-040)", () => {
  it("status CSS files use real design-platform variables — no --dsh typos, no literal fallbacks, no raw hex error colors", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    for (const file of ["StatusBadge.module.css", "WorkspaceHealth.module.css", "ProfilePicker.module.css"]) {
      const css = readFileSync(resolve(process.cwd(), `src/client/${file}`), "utf8");
      expect(css).not.toContain("--dsh-alias");
      expect(css).not.toMatch(/var\(--dsw-[^)]+,\s*#/);
    }
    const health = readFileSync(resolve(process.cwd(), "src/client/WorkspaceHealth.module.css"), "utf8");
    expect(health).toContain("var(--dsw-alias-state-success-primary)");
    expect(health).toContain("var(--dsw-alias-label-secondary)");
    expect(health).toContain("iconPending");
    const picker = readFileSync(resolve(process.cwd(), "src/client/ProfilePicker.module.css"), "utf8");
    expect(picker).toContain("var(--dsw-alias-state-error-primary)");
  });

  it("pending iComposer hint locale exists in both languages", async () => {
    expect(zh["health.iComposerPendingHint"]).toContain("绑定");
    expect(en["health.iComposerPendingHint"]).toContain("bind workspace");
  });
});
