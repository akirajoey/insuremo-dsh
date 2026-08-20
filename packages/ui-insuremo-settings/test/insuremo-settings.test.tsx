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
