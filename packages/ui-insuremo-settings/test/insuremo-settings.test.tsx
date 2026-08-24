import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import { SlotTestRuntime, usePinnedBrowserLanguages } from "@deepseek-ai/dsh-client-test-runtime";
import { resolveSlotLabel } from "@deepseek-ai/dsh-client-ui-slots";
import { apply, inject, NS } from "../src/client/index.ts";
import { OVERVIEW_URL } from "../src/client/overview.ts";
import { InsuremoCard } from "../src/client/InsuremoCard.tsx";
import { en, zh } from "../src/client/locales.ts";


usePinnedBrowserLanguages("zh-CN");

const fixtureView = {
  schemaVersion: "0",
  generatedAt: "2026-01-01T00:00:00.000Z",
  imo: { status: "ok", available: true, current: "0.2.17", target: "0.2.18", updateAvailable: true, busy: false },
  auth: { status: "ok", profiles: [
    { name: "portal:microsite", env: "portal", tenantCode: "microsite", isDefault: true, valid: true },
    { name: "portal:mo-re", env: "portal", tenantCode: "mo-re", valid: true },
  ], count: 2, defaultProfile: "portal:microsite" },
  skills: { status: "ok", installed: 3, valid: 3, enabled: 2, disabled: 1, names: ["a", "b", "c"], activationRevision: 7, entries: [
    { name: "imo-audit-helper", description: "audit", enabled: true },
    { name: "imo-log-helper", description: "log", enabled: false },
  ] },
  operations: { status: "ok", pending: 0, approved: 0, rejected: 0, recorded: 0, recent: [] },
  diagnostics: { status: "ok", diagnostics: [] },
  ici: { status: "ok", embeddingUrl: "https://portal-gw.insuremo.com/mo-re/1.0/aiqa/api/embedding", graphWorkspaces: 2, explainWorkspaces: 1 },
};

type StubFetch = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("InsureMO Plugins card (TASK-039/041)", () => {
  /** Card is collapsed by default (TASK-041); expand to reach the regions. */
  async function expand(view: { view: { findByRole: (role: string, opts?: Record<string, unknown>) => Promise<HTMLElement> } }): Promise<void> {
    const toggle = await view.view.findByRole("button", { name: new RegExp(zh.expand) });
    toggle.click();
    await Promise.resolve();
  }

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
    await runtime.declare({ "settings.plugin.item": { kind: "list", scope: "root" } });
    locale = new LocaleRuntime(runtime.ctx);
    runtime.ctx.provide("locale", locale);
    runtime.slots.installLocale(locale);
    feature = await runtime.mount({ inject, apply });
  });

  afterEach(async () => {
    await runtime.dispose();
    vi.unstubAllGlobals();
  });



  it("registers the card under settings.plugin.item keyed by the insuremo namespace", () => {
    const entries = runtime.slots.entries("settings.plugin.item");
    expect(entries).toHaveLength(1);
    expect((entries[0]?.options as { key?: string } | undefined)?.key).toBe("insuremo");
    expect(entries[0]?.locale).toBe(NS);
    void resolveSlotLabel;
  });

  it("collapsed PluginCard-style header (summary description, chevron, aria); expanding reveals regions (no Auth)", async () => {
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse(fixtureView));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    // collapsed header button: aria-expanded=false, name + summary description
    const header = await view.view.findByRole("button", { name: new RegExp(`${zh.expand}: ${zh.title}`) });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    // wait for the fast fetch to land: the description line carries the real
    // summary only once the overview is ready (intermittent-loading fix)
    await vi.waitFor(() => {
      const element = view.container.querySelector("[data-summary=\"1\"]");
      if (element === null || !element.textContent?.includes("0.2.17")) throw new Error("summary not ready");
    });
    const summary = view.container.querySelector("[data-summary=\"1\"]");
    expect(summary?.textContent).toContain("0.2.17");
    expect(summary?.textContent).toContain("portal:microsite");
    expect(summary?.textContent).toContain("Skills 2/3");
    // chevron present (svg)
    expect(header.querySelector("svg")).toBeTruthy();
    // fast channel URL
    expect(fetchMock).toHaveBeenCalledWith(`${OVERVIEW_URL}?fast=1`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    // regions hidden while collapsed
    expect(view.view.queryByText(zh.imoTitle)).toBeNull();
    // expanding flips aria and reveals regions
    header.click();
    await Promise.resolve();
    const openHeader = view.view.getByRole("button", { name: new RegExp(`${zh.collapse}: ${zh.title}`) });
    expect(openHeader.getAttribute("aria-expanded")).toBe("true");
    expect(await view.view.findByText(zh.imoTitle)).toBeTruthy();
    expect(await view.view.findByRole("checkbox", { name: `${zh.skillsToggle}: imo-audit-helper` })).toBeTruthy();
    expect(await view.view.findByText(zh.skillsUpdateAll)).toBeTruthy();
    expect(await view.view.findByText(zh.iciTitle)).toBeTruthy();
    // auth region removed (picker owns switching)
    expect(view.view.queryByRole("radio")).toBeNull();
  });

  it("update-available badge rides the collapsed header (pending slot)", async () => {
    const updateView = { ...fixtureView, imo: { ...fixtureView.imo, updateAvailable: true, target: "0.2.18" } };
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse(updateView));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    expect(await view.view.findByText(zh.imoUpdateAvailable)).toBeTruthy();
  });

  it("one-click upgrade: POST envelope + success line (direct, no approval chain)", async () => {
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions/imo-upgrade")) {
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>)["X-Workbench-Action"]).toBe("1");
        return jsonResponse({ ok: true, result: { status: "completed", currentVersion: "0.2.18", targetVersion: "0.2.18" } });
      }
      return jsonResponse(fixtureView);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    const button = await view.view.findByRole("button", { name: zh.cliUpdate });
    button.click();
    await vi.waitFor(() => {
      const actionCall = fetchMock.mock.calls.find(call => String(call[0]).includes("/actions/imo-upgrade"));
      expect(actionCall).toBeTruthy();
    });
    expect(await view.view.findByText(new RegExp(zh.cliUpdated))).toBeTruthy();
  });

  it("upgrade failure renders inline (code: message)", async () => {
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/actions/imo-upgrade")) {
        return jsonResponse({ ok: false, error: { code: "pre-check-failed", message: "could not read version" } });
      }
      return jsonResponse(fixtureView);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    (await view.view.findByRole("button", { name: zh.cliUpdate })).click();
    expect(await view.view.findByText(/pre-check-failed: could not read version/)).toBeTruthy();
  });

  it("busy imo disables the upgrade button", async () => {
    const busyView = { ...fixtureView, imo: { ...fixtureView.imo, busy: true } };
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse(busyView));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    const button = await view.view.findByRole("button", { name: new RegExp(zh.cliUpdating) });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("skills toggle: optimistic + rollback on failure + retry hint on conflict", async () => {
    let latest = fixtureView;
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions/skill-activation")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { name: string; enabled: boolean; expectedRevision?: number };
        expect(body.expectedRevision).toBeUndefined(); // last-write-wins (TASK-041)
        if (body.name === "imo-audit-helper") {
          return jsonResponse({ ok: false, error: { code: "revision-conflict", message: "state changed" } });
        }
        const entries = latest.skills.entries!.map(e => e.name === body.name ? { ...e, enabled: body.enabled } : e);
        latest = { ...latest, skills: { ...latest.skills, entries, activationRevision: 8 } };
        return jsonResponse({ ok: true, result: { name: body.name, enabled: body.enabled, revision: 8 } });
      }
      return jsonResponse(latest);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    await view.view.findByText(zh.skillsUpdateAll);
    const toggle = view.view.getAllByRole("checkbox").find(el => el.getAttribute("aria-label")?.includes("imo-audit-helper"))!;
    toggle.click();
    expect(await view.view.findByText(/revision-conflict/)).toBeTruthy();
    expect(await view.view.findByText(new RegExp(zh.skillsRetryHint))).toBeTruthy();
    await vi.waitFor(() => {
      const after = view.view.getAllByRole("checkbox").find(el => el.getAttribute("aria-label")?.includes("imo-audit-helper")) as HTMLInputElement;
      expect(after.checked).toBe(true); // rolled back after refetch
    });
  });

  it("skill remove button posts skill-remove (auth radio removed with the Auth region)", async () => {
    const posts: string[] = [];
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions/")) {
        posts.push(url.split("/actions/")[1]);
        return jsonResponse({ ok: true, result: { status: "completed", revision: 9 } });
      }
      return jsonResponse(fixtureView);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    await view.view.findByText(zh.skillsUpdateAll);
    (await view.view.findByRole("button", { name: "remove imo-audit-helper" })).click();
    await vi.waitFor(() => {
      expect(posts).toContain("skill-remove");
      expect(posts).not.toContain("default-profile");
    });
  });

  it("switches locale: English copy renders", async () => {
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse(fixtureView));
    vi.stubGlobal("fetch", fetchMock);
    locale.setLocale("en");
    const view = runtime.renderSlot("settings.plugin.item", {});
    (await view.view.findByRole("button", { name: new RegExp(en.expand) })).click();
    expect(await view.view.findByText(en.imoTitle)).toBeTruthy();
  });

  it("hostile payload fields never render", async () => {
    const hostile = {
      ...fixtureView,
      auth: { ...fixtureView.auth, profiles: [{ name: "dev", isDefault: true, access_token: "SECRETTOKEN" }] },
    };
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse(hostile));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await view.view.findByRole("button", { name: new RegExp(zh.title) });
    await vi.waitFor(() => {
      const text = view.container.textContent ?? "";
      expect(text).not.toContain("SECRETTOKEN");
      expect(text).not.toContain("access_token");
    });
  });

  it("disposes the card registration", async () => {
    expect(runtime.slots.entries("settings.plugin.item")).toHaveLength(1);
    await feature.dispose();
    expect(runtime.slots.entries("settings.plugin.item")).toHaveLength(0);
  });
});

describe("theme variable regression (TASK-040)", () => {
  it("InsuremoCard.module.css uses real design-platform variables with no literal fallbacks", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const css = readFileSync(resolve(process.cwd(), "src/client/InsuremoCard.module.css"), "utf8");
    expect(css).toContain("var(--dsw-alias-bg-layer-3)");
    expect(css).toContain("var(--dsw-alias-border-l2)");
    expect(css).toContain("var(--dsw-alias-label-primary)");
    expect(css).toContain("var(--dsw-alias-label-tertiary)");
    expect(css).toContain("var(--dsw-alias-state-error-primary)");
    expect(css).not.toContain("surface-elevated");
    expect(css).not.toMatch(/var\(--dsw-[^)]+,\s*#/);
  });
});
