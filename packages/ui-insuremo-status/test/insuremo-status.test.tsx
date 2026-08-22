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
        { name: "portal:microsite", env: "portal", isDefault: true, valid: true },
        { name: "portal:mo-re", env: "portal", valid: true },
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

  it("expands on click, lists profiles with default marked, busy during load", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(overviewPayload));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("sidebar.footer.action", { wide: true });
    (await view.view.findByRole("button", { name: zh.label })).click();
    const select = await view.view.findByRole("combobox", { name: zh["picker.label"] });
    expect(select).toBeTruthy();
    await vi.waitFor(() => {
      expect((select as HTMLSelectElement).options.length).toBe(2);
      expect((select as HTMLSelectElement).options[0].textContent).toContain("portal:microsite");
      expect((select as HTMLSelectElement).options[0].textContent).toContain("✓");
    });
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
    (await view.view.findByRole("button", { name: zh.label })).click();
    const select = (await view.view.findByRole("combobox", { name: zh["picker.label"] })) as HTMLSelectElement;
    await vi.waitFor(() => { expect(select.options.length).toBe(2); });
    select.value = "portal:mo-re";
    select.dispatchEvent(new Event("change", { bubbles: true }));
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
    (await view.view.findByRole("button", { name: zh.label })).click();
    const select = (await view.view.findByRole("combobox", { name: zh["picker.label"] })) as HTMLSelectElement;
    await vi.waitFor(() => { expect(select.options.length).toBe(2); });
    select.value = "portal:mo-re";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(await view.view.findByRole("alert")).toBeTruthy();
    expect(view.view.getByRole("combobox")).toBeTruthy();
  });
});
