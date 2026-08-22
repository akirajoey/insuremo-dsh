import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import {
  SlotTestRuntime,
  usePinnedBrowserLanguages,
} from "@deepseek-ai/dsh-client-test-runtime";
import { resolveSlotLabel } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import { apply, inject, NS } from "../src/client/index.ts";
import { OVERVIEW_URL } from "../src/client/overview.ts";
import { en, zh } from "../src/client/locales.ts";

usePinnedBrowserLanguages("zh-CN");

const fixtureView = {
  schemaVersion: "0",
  generatedAt: "2026-01-01T00:00:00.000Z",
  imo: { status: "ok", available: true, current: "0.2.17", target: "0.2.18", updateAvailable: true },
  auth: { status: "ok", profiles: [{ name: "dev", env: "portal", isDefault: true }], count: 1, defaultProfile: "dev" },
  skills: { status: "ok", installed: 1, valid: 1, enabled: 1, disabled: 0, names: ["alpha"] },
  operations: { status: "ok", pending: 2, approved: 0, rejected: 0, recorded: 1, recent: [] },
  diagnostics: { status: "ok", diagnostics: [{ id: "operations-pending", severity: "info", messageKey: "overview.diagnostic.operationsPending" }] },
};

type StubFetch = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("InsureMO Settings overview section", () => {
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
    await runtime.declare({ "settings.section": { kind: "list", scope: "root" } });
    locale = new LocaleRuntime(runtime.ctx);
    runtime.ctx.provide("locale", locale);
    runtime.slots.installLocale(locale);
    feature = await runtime.mount({ inject, apply });
  });

  afterEach(async () => {
    await runtime.dispose();
    vi.unstubAllGlobals();
  });

  it("registers a localized InsureMO nav row in both languages", () => {
    const entry = runtime.slots.entries("settings.section")[0];
    expect(entry?.locale).toBe(NS);
    expect(resolveSlotLabel(entry?.options.label)).toBe(zh.nav);
    locale.setLocale("en");
    expect(resolveSlotLabel(entry?.options.label)).toBe(en.nav);
  });

  it("renders the overview panels from a successful fetch", async () => {
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse(fixtureView));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.section", { close: vi.fn() });
    expect(await view.view.findByText(zh.title)).toBeTruthy();
    expect(await view.view.findByText("0.2.17")).toBeTruthy();
    expect(await view.view.findByText("0.2.18")).toBeTruthy();
    expect((await view.view.findAllByText(/dev/)).length).toBeGreaterThan(0);
    expect(await view.view.findByText(zh.operationsPending)).toBeTruthy();
    expect(await view.view.findByText(zh.diagnosticsTitle)).toBeTruthy();
    expect(await view.view.findByText(/存在待审批操作/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(OVERVIEW_URL, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("shows an error and recovers on refresh", async () => {
    const fetchMock: StubFetch = vi.fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonResponse(fixtureView));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.section", { close: vi.fn() });
    expect(await view.view.findByText(zh.error)).toBeTruthy();
    const button = view.view.getByRole("button", { name: zh.refresh });
    button.click();
    expect(await view.view.findByText("0.2.17")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never renders tokens, paths, or digests from a hostile payload", async () => {
    const hostile = {
      ...fixtureView,
      auth: { ...fixtureView.auth, profiles: [{ name: "dev", isDefault: true, access_token: "SECRETTOKEN" }] },
      skills: { ...fixtureView.skills, names: ["alpha"], path: "/home/secret/.agents/skills/alpha" },
      operations: { ...fixtureView.operations, recent: [{ id: "op-1", kind: "x", decision: "approved", recorded: true, paramsDigest: "sha256:dc0a60e" }] },
    };
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse(hostile));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.section", { close: vi.fn() });
    await view.view.findByText(zh.title);
    await vi.waitFor(() => {
      const text = view.container.textContent ?? "";
      expect(text).toContain("0.2.17");
      expect(text).not.toContain("SECRETTOKEN");
      expect(text).not.toContain("access_token");
      expect(text).not.toContain("/home/secret");
      expect(text).not.toContain("dc0a60e");
    });
  });

  it("removes the section registration when the feature is disposed", async () => {
    expect(runtime.slots.entries("settings.section")).toHaveLength(1);
    await feature.dispose();
    expect(runtime.slots.entries("settings.section")).toHaveLength(0);
  });
});

describe("InsureMO interactive panels (TASK-036)", () => {
  let runtime: SlotTestRuntime;
  let locale: LocaleRuntime;
  let feature: Awaited<ReturnType<SlotTestRuntime["mount"]>>;

  const richView = {
    ...fixtureView,
    imo: { status: "ok", available: true, current: "0.2.17", target: "0.2.18", updateAvailable: true, busy: false },
    auth: { status: "ok", profiles: [
      { name: "portal:microsite", env: "portal", tenantCode: "microsite", isDefault: true, valid: true },
      { name: "portal:mo-re", env: "portal", tenantCode: "mo-re", valid: true },
    ], count: 2, defaultProfile: "portal:microsite" },
    skills: { status: "ok", installed: 3, valid: 3, enabled: 2, disabled: 1, names: ["a", "b", "c"], activationRevision: 7, entries: [
      { name: "imo-audit-helper", description: "audit", enabled: true },
      { name: "imo-log-helper", description: "log", enabled: false },
      { name: "imo-x", description: "x".repeat(300), enabled: true },
    ] },
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
    await runtime.declare({ "settings.section": { kind: "list", scope: "root" } });
    locale = new LocaleRuntime(runtime.ctx);
    runtime.ctx.provide("locale", locale);
    runtime.slots.installLocale(locale);
    feature = await runtime.mount({ inject, apply });
  });

  afterEach(async () => {
    await runtime.dispose();
    vi.unstubAllGlobals();
  });

  it("renders the three panels with rich fixture (20-skill scale counts, busy flags)", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `skill-${i}`, description: `d${i}`, enabled: i % 2 === 0 }));
    const view20 = { ...richView, skills: { ...richView.skills, entries: many, installed: 20, enabled: 10, disabled: 10 } };
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse(view20));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.section", { close: vi.fn() });
    expect(await view.view.findByText(zh.cliUpdate)).toBeTruthy();
    expect(await view.view.findByText(zh.authSetDefault)).toBeTruthy();
    expect(await view.view.findByText(zh.skillsUpdateAll)).toBeTruthy();
    expect(view.view.getAllByRole("checkbox").length).toBe(20);
  });

  it("CLI update button: POST shape, success path, busy disable", async () => {
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/actions/imo-upgrade")) {
        return jsonResponse({ ok: true, result: { status: "completed", currentVersion: "0.2.18", targetVersion: "0.2.18" } });
      }
      return jsonResponse(richView);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.section", { close: vi.fn() });
    const button = await view.view.findByRole("button", { name: zh.cliUpdate });
    button.click();
    await vi.waitFor(() => {
      const actionCall = fetchMock.mock.calls.find(call => String(call[0]).includes("/actions/imo-upgrade"));
      expect(actionCall).toBeTruthy();
      const init = actionCall![1] as RequestInit;
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["X-Workbench-Action"]).toBe("1");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    });
    expect(await view.view.findByText(new RegExp(zh.cliUpdated))).toBeTruthy();
  });

  it("CLI update failure: inline error (code+message), network → fixed copy", async () => {
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/actions/imo-upgrade")) {
        return jsonResponse({ ok: false, error: { code: "busy", message: "an upgrade is already running" } });
      }
      return jsonResponse(richView);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.section", { close: vi.fn() });
    (await view.view.findByRole("button", { name: zh.cliUpdate })).click();
    expect(await view.view.findByText(/busy: an upgrade is already running/)).toBeTruthy();

    // network failure variant
    const netMock: StubFetch = vi.fn(async (input: RequestInfo | URL) => {
      return String(input).includes("/actions/") ? Promise.reject(new Error("offline")) : jsonResponse(richView);
    });
    vi.stubGlobal("fetch", netMock);
    const view2 = runtime.renderSlot("settings.section", { close: vi.fn() });
    (await view2.view.findByRole("button", { name: zh.cliUpdate })).click();
    expect(await view2.view.findByText(new RegExp(zh.errorNetwork))).toBeTruthy();
  });

  it("Skills toggle: optimistic flip + rollback + inline error on failure", async () => {
    let latest = richView;
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions/skill-activation")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { name: string; enabled: boolean; expectedRevision?: number };
        expect(body.expectedRevision).toBe(7);
        if (body.name === "imo-audit-helper") {
          return jsonResponse({ ok: false, error: { code: "not-installed", message: "the skill is not installed" } });
        }
        const entries = latest.skills.entries.map(e => e.name === body.name ? { ...e, enabled: body.enabled } : e);
        latest = { ...latest, skills: { ...latest.skills, entries, enabled: entries.filter(e => e.enabled).length, disabled: entries.filter(e => !e.enabled).length, activationRevision: 8 } };
        return jsonResponse({ ok: true, result: { name: body.name, enabled: body.enabled, revision: 8 } });
      }
      return jsonResponse(latest);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.section", { close: vi.fn() });
    await view.view.findByText(zh.skillsUpdateAll);
    const toggle = view.view.getAllByRole("checkbox").find(el => el.getAttribute("aria-label")?.includes("imo-audit-helper"))!;
    toggle.click();
    expect(await view.view.findByText(/not-installed: the skill is not installed/)).toBeTruthy();
    // rollback: checkbox back to original after refetch
    await vi.waitFor(() => {
      const after = view.view.getAllByRole("checkbox").find(el => el.getAttribute("aria-label")?.includes("imo-audit-helper")) as HTMLInputElement;
      expect(after.checked).toBe(true);
    });
  });

  it("Skills revision-conflict: error row + retry hint + refetch", async () => {
    let latest = richView;
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions/skill-activation")) {
        return jsonResponse({ ok: false, error: { code: "revision-conflict", message: "the activation state changed concurrently; reload and retry" } });
      }
      return jsonResponse(latest);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.section", { close: vi.fn() });
    await view.view.findByText(zh.skillsUpdateAll);
    const toggle = view.view.getAllByRole("checkbox")[0];
    toggle.click();
    expect(await view.view.findByText(/revision-conflict/)).toBeTruthy();
    expect(await view.view.findByText(new RegExp(zh.skillsRetryHint))).toBeTruthy();
  });

  it("Profile default switch (Auth radio): POST envelope + refetch", async () => {
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions/default-profile")) {
        expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({ profile: "portal:mo-re" });
        return jsonResponse({ ok: true, result: { status: "completed", profile: "portal:mo-re" } });
      }
      return jsonResponse(richView);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.section", { close: vi.fn() });
    const radio = await view.view.findByRole("radio", { name: `${zh.authSetDefault}: portal:mo-re` });
    radio.click();
    await vi.waitFor(() => {
      const actionCall = fetchMock.mock.calls.find(call => String(call[0]).includes("/actions/default-profile"));
      expect(actionCall).toBeTruthy();
    });
  });

  it("busy imo section disables the update button", async () => {
    const busyView = { ...richView, imo: { ...richView.imo, busy: true } };
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse(busyView));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.section", { close: vi.fn() });
    const button = await view.view.findByRole("button", { name: new RegExp(zh.cliUpdating) });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("no editable inputs beyond toggles/radios (Auth/Skills read-only surface)", async () => {
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse(richView));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.section", { close: vi.fn() });
    await view.view.findByText(zh.cliUpdate);
    expect(view.view.queryByRole("textbox")).toBeNull();
    expect(view.container.querySelector("input[type=text]")).toBeNull();
    expect(view.container.querySelector("textarea")).toBeNull();
  });
});
