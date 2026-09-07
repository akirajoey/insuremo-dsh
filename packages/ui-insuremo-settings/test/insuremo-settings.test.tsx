import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import { SlotTestRuntime, usePinnedBrowserLanguages } from "@deepseek-ai/dsh-client-test-runtime";
import { resolveSlotLabel } from "@deepseek-ai/dsh-client-ui-slots";
import { apply, inject, NS } from "../src/client/index.ts";
import { OVERVIEW_URL } from "../src/client/overview.ts";
import { InsuremoCard } from "../src/client/InsuremoCard.tsx";
import {
  buildDiagnosisText, ensureDiagnosisWorkspace, handOffDiagnosis, peekDiagnosisPrefill, queueDiagnosisPrefill,
  settleDiagnosisPrefill, waitForDiagnosisPrefill, type DiagnosisFaces, type DiagnosisWorkspaces,
} from "../src/client/diagnosis.ts";
import { DiagnosisPrefillEntry } from "../src/client/prefill-slot.tsx";
import { en, zh, type InsuremoLocaleKey } from "../src/client/locales.ts";


usePinnedBrowserLanguages("zh-CN");

const fixtureView = {
  schemaVersion: "0",
  generatedAt: "2026-01-01T00:00:00.000Z",
  imo: { status: "ok", available: true, current: "0.2.17", target: "0.2.18", updateAvailable: true, busy: false },
  auth: { status: "ok", profiles: [
    { name: "portal:microsite", env: "portal", tenantCode: "microsite", isDefault: true, valid: true },
    { name: "portal:mo-re", env: "portal", tenantCode: "mo-re", valid: true },
  ], count: 2, defaultProfile: "portal:microsite", activeProfileName: "portal:microsite", activeProfileStatus: "active" },
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
    // regions hidden while collapsed; the removed embedding endpoint/hint are
    // absent in both collapsed and expanded states.
    expect(view.view.queryByText(zh.imoTitle)).toBeNull();
    expect(view.container.textContent).not.toContain(fixtureView.ici.embeddingUrl);
    expect(view.container.textContent).not.toContain(zh.iciEmbeddingEndpoint);
    expect(view.container.textContent).not.toContain(zh.iciEmbeddingHint);
    // expanding flips aria and reveals regions
    header.click();
    await Promise.resolve();
    const openHeader = view.view.getByRole("button", { name: new RegExp(`${zh.collapse}: ${zh.title}`) });
    expect(openHeader.getAttribute("aria-expanded")).toBe("true");
    expect(await view.view.findByText(zh.imoTitle)).toBeTruthy();
    expect(await view.view.findByRole("switch", { name: `${zh.skillsToggle}: imo-audit-helper` })).toBeTruthy();
    expect(await view.view.findByText(zh.skillsUpdateAll)).toBeTruthy();
    expect(await view.view.findByText(zh.iciTitle)).toBeTruthy();
    expect(view.container.textContent).toContain(`${zh.iciGraphWorkspaces}: 2`);
    expect(view.container.textContent).toContain(`${zh.iciExplainWorkspaces}: 1`);
    expect(view.container.textContent).not.toContain(fixtureView.ici.embeddingUrl);
    expect(view.container.textContent).not.toContain(zh.iciEmbeddingEndpoint);
    expect(view.container.textContent).not.toContain(zh.iciEmbeddingHint);
    // auth region removed (picker owns switching)
    expect(view.view.queryByRole("radio")).toBeNull();
  });

  it("TASK-076: install button renders only while the IMO CLI is unavailable", async () => {
    const unavailableView = { ...fixtureView, imo: { status: "error", code: "not-found", available: false, updateAvailable: false } };
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse(unavailableView));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    expect(await view.view.findByRole("button", { name: zh.cliInstall })).toBeTruthy();
    expect((await view.view.findAllByText(new RegExp(zh.imoUnavailable))).length).toBeGreaterThan(0);
    // The side-effect hint names the registry write and the global install.
    expect(await view.view.findByText(new RegExp("npmrc"))).toBeTruthy();

  });

  it("TASK-076: install button is absent once the IMO CLI is available", async () => {
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse(fixtureView));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    await view.view.findByRole("button", { name: zh.cliUpdate });
    expect(view.view.queryAllByRole("button", { name: zh.cliInstall })).toHaveLength(0);
  });

  it("TASK-076: one-click install posts, shows the success line, and refreshes the overview", async () => {
    const unavailableView = { ...fixtureView, imo: { status: "error", code: "not-found", available: false, updateAvailable: false } };
    const availableView = { ...fixtureView };
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions/imo-install")) {
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>)["X-Workbench-Action"]).toBe("1");
        return jsonResponse({ ok: true, result: { status: "completed", packageManager: "npm", currentVersion: "0.2.14" } });
      }
      if (url.includes("fast=0")) return jsonResponse(availableView);
      return jsonResponse(unavailableView);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    (await view.view.findByRole("button", { name: zh.cliInstall })).click();
    await vi.waitFor(() => {
      const actionCall = fetchMock.mock.calls.find(call => String(call[0]).includes("/actions/imo-install"));
      expect(actionCall).toBeTruthy();
    });
    expect(await view.view.findByText(new RegExp(zh.cliInstalled))).toBeTruthy();
    // The silent reload re-reads the full overview so the card flips available.
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(call => String(call[0]).includes("fast=0"))).toBe(true);
    });
  });

  const coldFastView = {
    ...fixtureView,
    imo: { status: "warning", code: "fast-uncached", available: false, updateAvailable: false },
    skills: { ...fixtureView.skills, code: "fast-uncached" },
  };

  it("TASK-079c: cold fast projection renders skeletons without install/upgrade buttons or a false 'not detected' summary, and auto-upgrades exactly once", async () => {
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse(coldFastView));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await vi.waitFor(() => {
      const summary = view.container.querySelector('[data-summary="1"]');
      if (summary === null || !summary.textContent?.includes(zh.imoLoading)) throw new Error("cold summary not ready");
      expect(summary.textContent).not.toContain(zh.imoUnavailable);
      expect(summary.textContent).toContain("Skills …");
    });
    // Exactly one silent full refresh replaces the manual Refresh.
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter(call => String(call[0]).includes("fast=0"))).toHaveLength(1);
    });
    await expand(view);
    expect(await view.view.findByText(zh.imoLoading)).toBeTruthy();
    expect(view.view.queryByRole("button", { name: zh.cliInstall })).toBeNull();
    expect(view.view.queryByRole("button", { name: zh.cliUpdate })).toBeNull();
    // The skills cold skeleton does not regress.
    expect(await view.view.findByText(zh.skillsLoadingSlow)).toBeTruthy();
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes("fast=0"))).toHaveLength(1);
  });

  it("TASK-079c: auto upgrade renders the full available view without a manual refresh", async () => {
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL) => {
      return jsonResponse(String(input).includes("fast=0") ? fixtureView : coldFastView);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter(call => String(call[0]).includes("fast=0"))).toHaveLength(1);
    });
    await vi.waitFor(() => {
      if (!view.container.textContent?.includes(`${zh.imoCurrent}: 0.2.17`)) throw new Error("full imo view not rendered");
    });
    expect(view.view.queryByRole("button", { name: zh.cliInstall })).toBeNull();
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes("fast=0"))).toHaveLength(1);
  });

  it("TASK-079c: transient/unknown IMO errors never show the install button and never claim 'not detected'", async () => {
    const codes = ["timeout", "spawn-failed", "unavailable", "cancelled"];
    let current = codes[0];
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse({ ...fixtureView, imo: { status: "error", code: current, available: false, updateAvailable: false } }));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    for (const code of codes) {
      // eslint-disable-next-line no-await-in-loop
      const alert = await vi.waitFor(() => {
        const found = view.container.querySelector('[data-imo-state="error"][role="alert"]');
        if (found === null || !found.textContent?.includes(code)) throw new Error(`alert for ${code} not rendered`);
        return found;
      });
      expect(alert.textContent).toContain(zh.imoDetectFailed);
      expect(view.view.queryAllByRole("button", { name: zh.cliInstall })).toHaveLength(0);
      const summary = view.container.querySelector('[data-summary="1"]');
      expect(summary?.textContent).toContain(zh.imoDetectFailed);
      expect(summary?.textContent).not.toContain(zh.imoUnavailable);
      expect(summary?.textContent).not.toContain(zh.imoLoading);
      current = codes[(codes.indexOf(code) + 1) % codes.length]!;
      if (code !== codes[codes.length - 1]) (view.view.getByRole("button", { name: new RegExp(`^${zh.refresh}`) })).click();
    }
  });

  it("TASK-079c: the install button appears only after a full read reports not-found", async () => {
    const unavailableFullView = { ...fixtureView, imo: { status: "error", code: "not-found", available: false, updateAvailable: false } };
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL) => {
      return jsonResponse(String(input).includes("fast=0") ? unavailableFullView : coldFastView);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter(call => String(call[0]).includes("fast=0"))).toHaveLength(1);
    });
    expect(await view.view.findByRole("button", { name: zh.cliInstall })).toBeTruthy();
  });

  it("TASK-076: install failure renders inline with the idempotent retry hint", async () => {
    const unavailableView = { ...fixtureView, imo: { status: "error", code: "not-found", available: false, updateAvailable: false } };
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/actions/imo-install")) {
        return jsonResponse({ ok: false, error: { code: "no-package-manager", message: "neither npm nor pnpm was found on PATH; install Node.js first" } });
      }
      return jsonResponse(unavailableView);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    (await view.view.findByRole("button", { name: zh.cliInstall })).click();
    expect(await view.view.findByText(/no-package-manager: neither npm nor pnpm/)).toBeTruthy();
    expect(await view.view.findByText(new RegExp(zh.cliInstallRetryHint.slice(0, 12)))).toBeTruthy();
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
    const toggle = view.view.getAllByRole("switch").find(el => el.getAttribute("aria-label")?.includes("imo-audit-helper"))!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    toggle.click();
    expect(await view.view.findByText(/revision-conflict/)).toBeTruthy();
    expect(await view.view.findByText(new RegExp(zh.skillsRetryHint))).toBeTruthy();
    await vi.waitFor(() => {
      const after = view.view.getAllByRole("switch").find(el => el.getAttribute("aria-label")?.includes("imo-audit-helper"))!;
      expect(after.getAttribute("aria-checked")).toBe("true"); // rolled back after refetch
    });
  });

  it("skills use native switch semantics with optimistic busy state and no checkbox input", async () => {
    let resolveAction: ((value: Response) => void) | undefined;
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/actions/skill-activation")) {
        return await new Promise<Response>(resolve => { resolveAction = resolve; });
      }
      return jsonResponse(fixtureView);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    const toggle = await view.view.findByRole("switch", { name: `${zh.skillsToggle}: imo-audit-helper` });
    expect(view.container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(toggle.getAttribute("aria-busy")).toBe("true");
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    await vi.waitFor(() => expect(resolveAction).toBeTruthy());
    resolveAction?.(jsonResponse({ ok: true, result: { revision: 8 } }));
    await vi.waitFor(() => expect(toggle.getAttribute("aria-busy")).toBeNull());
  });

  it("successful toggle holds optimistic value until deferred silent reload confirms props", async () => {
    let resolveAction: ((value: Response) => void) | undefined;
    let resolveReload: ((value: Response) => void) | undefined;
    const updated = { ...fixtureView, skills: { ...fixtureView.skills, enabled: 1, disabled: 2, entries: fixtureView.skills.entries!.map(entry => entry.name === "imo-audit-helper" ? { ...entry, enabled: false } : entry) } };
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/actions/skill-activation")) return await new Promise<Response>(resolve => { resolveAction = resolve; });
      if (url.includes("?fast=0")) return await new Promise<Response>(resolve => { resolveReload = resolve; });
      return jsonResponse(fixtureView);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    const toggle = await view.view.findByRole("switch", { name: `${zh.skillsToggle}: imo-audit-helper` });
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-busy")).toBe("true"));
    await vi.waitFor(() => expect(resolveAction).toBeTruthy());
    resolveAction?.(jsonResponse({ ok: true, result: { revision: 8 } }));
    await vi.waitFor(() => expect(toggle.getAttribute("aria-busy")).toBeNull());
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await vi.waitFor(() => expect(resolveReload).toBeTruthy());
    resolveReload?.(jsonResponse(updated));
    await vi.waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  });

  it("skill rows expose only name + native toggle, never description or remove action", async () => {
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse(fixtureView));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    await view.view.findByText(zh.skillsUpdateAll);
    expect(view.view.getByText("imo-audit-helper")).toBeTruthy();
    expect(view.view.queryByText("audit")).toBeNull();
    expect(view.view.queryByRole("button", { name: "remove imo-audit-helper" })).toBeNull();
  });

  const SCENARIO_IDS = ["icomposer-full-stack", "icomposer-coding-lite", "icomposer-api-design", "uic-developer", "ask-insuremo"];

  it("TASK-079: fixed scenario selector exposes exactly the five allowlisted scenarios", async () => {
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse(fixtureView));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    const select = await view.view.findByRole("combobox", { name: zh.skillsScenarioLabel });
    const options = [...select.querySelectorAll("option")].map(option => option.getAttribute("value"));
    expect(options).toEqual(SCENARIO_IDS);
    expect(await view.view.findByRole("button", { name: new RegExp(`^${zh.skillsScenarioInstall}`) })).toBeTruthy();
    expect(await view.view.findByText(zh.skillsScopeHint)).toBeTruthy();
  });

  it("TASK-079: empty inventory still offers the scenario first-install path", async () => {
    const emptyView = { ...fixtureView, skills: { ...fixtureView.skills, installed: 0, valid: 0, enabled: 0, disabled: 0, names: [], entries: [] } };
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse(emptyView));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    const select = await view.view.findByRole("combobox", { name: zh.skillsScenarioLabel });
    expect(select.querySelectorAll("option")).toHaveLength(5);
    expect(await view.view.findByText(new RegExp(zh.skillsInstallFirstHint))).toBeTruthy();
  });

  it("TASK-079: scenario sync posts the allowlisted scenario, shows the structured diff, and refreshes", async () => {
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions/skill-install")) {
        expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({ scenario: "icomposer-full-stack" });
        return jsonResponse({ ok: true, result: { status: "completed", beforeCount: 1, afterCount: 3, added: ["insuremo-auth-cli", "insuremo-deep-search"], removed: [], updated: [] } });
      }
      return jsonResponse(fixtureView);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    (await view.view.findByRole("button", { name: new RegExp(`^${zh.skillsScenarioInstall}`) })).click();
    const done = await view.view.findByText(new RegExp(zh.skillsScenarioDone));
    expect(done.textContent).toContain("2");
    expect(done.textContent).toContain("insuremo-auth-cli");
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(call => String(call[0]).includes("fast=0"))).toBe(true);
    });
  });

  it("TASK-079: failed and partial scenario receipts render alerts, never success", async () => {
    let receipt: { status: string; added: readonly string[] } = { status: "failed", added: ["insuremo-auth-cli"] };
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/actions/skill-install")) {
        return jsonResponse({ ok: true, result: { status: receipt.status, beforeCount: 2, afterCount: 3, added: receipt.added, removed: [], updated: [] } });
      }
      return jsonResponse(fixtureView);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    const install = await view.view.findByRole("button", { name: new RegExp(`^${zh.skillsScenarioInstall}`) });
    for (const status of ["failed", "partial-failure"]) {
      receipt = { status, added: ["insuremo-auth-cli"] };
      install.click();
      // eslint-disable-next-line no-await-in-loop
      const alert = await vi.waitFor(() => {
        const element = view.container.querySelector('[data-scenario="failed"]');
        if (element === null || !element.textContent?.includes(status)) throw new Error(`scenario ${status} alert not rendered`);
        return element;
      });
      expect(alert.textContent).toContain(zh.skillsScenarioFailed);
      expect(alert.textContent).toContain("insuremo-auth-cli"); // recovery evidence stays visible
      expect(alert.getAttribute("role")).toBe("alert");
      expect(view.container.querySelector('[data-scenario="done"]')).toBeNull();
    }
  });

  it("TASK-079: update-all surfaces failure envelopes and structured failed receipts", async () => {
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/actions/skill-update")) {
        return jsonResponse({ ok: false, error: { code: "tool-unavailable", message: "npx is unavailable" } });
      }
      return jsonResponse(fixtureView);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    (await view.view.findByRole("button", { name: new RegExp(`^${zh.skillsUpdateAll}\\b`) })).click();
    const alert = await vi.waitFor(() => {
      const element = view.container.querySelector('[data-update="failed"]');
      if (element === null) throw new Error("update failure alert not rendered");
      return element;
    });
    expect(alert.textContent).toContain(zh.skillsUpdateFailed);
    expect(alert.textContent).toContain("tool-unavailable");

    const receiptMock: StubFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/actions/skill-update")) {
        return jsonResponse({ ok: true, result: { status: "failed", added: [], removed: [], updated: [] } });
      }
      return jsonResponse(fixtureView);
    });
    vi.stubGlobal("fetch", receiptMock);
    (await view.view.findByRole("button", { name: new RegExp(`^${zh.skillsUpdateAll}\\b`) })).click();
    await view.view.findByText(new RegExp(`${zh.skillsUpdateFailed}: failed`));
    expect(view.container.querySelector('[data-update="done"]')).toBeNull();
  });

  it("TASK-079: conflicting skill actions are disabled while a scenario sync is in flight", async () => {
    let resolveInstall: ((value: Response) => void) | undefined;
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/actions/skill-install")) {
        return await new Promise<Response>(resolve => { resolveInstall = resolve; });
      }
      return jsonResponse(fixtureView);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderSlot("settings.plugin.item", {});
    await expand(view);
    const install = await view.view.findByRole("button", { name: new RegExp(`^${zh.skillsScenarioInstall}`) });
    install.click();
    await vi.waitFor(() => {
      // Busy flips the visible label; the descriptive aria-label stays stable.
      expect(view.view.getByText(zh.skillsScenarioInstalling)).toBeTruthy();
      expect((view.view.getByRole("button", { name: new RegExp(`^${zh.skillsScenarioInstall}`) }) as HTMLButtonElement).disabled).toBe(true);
      expect((view.view.getByRole("button", { name: new RegExp(`^${zh.skillsUpdateAll}\\b`) }) as HTMLButtonElement).disabled).toBe(true);
      const toggle = view.view.getAllByRole("switch").find(el => el.getAttribute("aria-label")?.includes("imo-audit-helper"))!;
      expect((toggle as HTMLButtonElement).disabled).toBe(true);
      expect((view.view.getByRole("combobox", { name: zh.skillsScenarioLabel }) as HTMLSelectElement).disabled).toBe(true);
    });
    resolveInstall?.(jsonResponse({ ok: true, result: { status: "completed", beforeCount: 2, afterCount: 3, added: ["insuremo-auth-cli"], removed: [], updated: [] } }));
    await vi.waitFor(() => {
      expect((view.view.getByRole("button", { name: new RegExp(`^${zh.skillsUpdateAll}\\b`) }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("TASK-079: English copy renders for the scenario region", async () => {
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse(fixtureView));
    vi.stubGlobal("fetch", fetchMock);
    locale.setLocale("en");
    const view = runtime.renderSlot("settings.plugin.item", {});
    const header = await view.view.findByRole("button", { name: new RegExp(`${en.expand}: ${en.title}`) });
    header.click();
    expect(await view.view.findByRole("button", { name: new RegExp(`^${en.skillsScenarioInstall}`) })).toBeTruthy();
    expect(await view.view.findByRole("combobox", { name: en.skillsScenarioLabel })).toBeTruthy();
    expect(await view.view.findByRole("button", { name: new RegExp(`^${en.skillsUpdateAll} \\u00b7`) })).toBeTruthy();
    expect(await view.view.findByText(en.skillsScopeHint)).toBeTruthy();
  });

  it("switches locale: English copy renders", async () => {
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse(fixtureView));
    vi.stubGlobal("fetch", fetchMock);
    locale.setLocale("en");
    const view = runtime.renderSlot("settings.plugin.item", {});
    const header = await view.view.findByRole("button", { name: new RegExp(en.expand) });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.textContent).not.toContain(fixtureView.ici.embeddingUrl);
    expect(view.container.textContent).not.toContain(en.iciEmbeddingEndpoint);
    expect(view.container.textContent).not.toContain(en.iciEmbeddingHint);
    header.click();
    expect(await view.view.findByText(en.imoTitle)).toBeTruthy();
    expect(await view.view.findByText(en.iciTitle)).toBeTruthy();
    expect(view.container.textContent).toContain(`${en.iciGraphWorkspaces}: 2`);
    expect(view.container.textContent).toContain(`${en.iciExplainWorkspaces}: 1`);
    expect(view.container.textContent).not.toContain(fixtureView.ici.embeddingUrl);
    expect(view.container.textContent).not.toContain(en.iciEmbeddingEndpoint);
    expect(view.container.textContent).not.toContain(en.iciEmbeddingHint);
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

const DIAGNOSIS_PAYLOAD = {
  available: true,
  diagnosis: {
    kind: "imo-cli",
    operation: "imo-install",
    commands: ["npm config set @insuremo:registry <registry>", "npm install -g @insuremo/imo"],
    exitCode: 1,
    stdout: "npm warn deprecated nothing",
    stderr: "npm ERR! network _auth=*** install failed",
    stdoutTruncated: false,
    stderrTruncated: false,
    packageManager: "npm",
    registry: "https://public.insuremo.com/artifactory/api/npm/npm/",
    nodeVersion: "v22.19.0",
    platform: "darwin",
    arch: "arm64",
    occurredAt: "2026-09-05T08:00:00.000Z",
  },
  diagnosisCwd: "/tmp/dsh-home/install-diagnostics",
} as const;

/** Render the card directly with a localized t seat and injected runtime faces. */
function renderCard(diagnosisFaces?: DiagnosisFaces, translate: (key: InsuremoLocaleKey) => string = key => zh[key]) {
  const props = {
    t: translate,
    diagnosisFaces,
  } as unknown as ComponentProps<typeof InsuremoCard>;
  return render(<InsuremoCard {...props} />);
}

/** A card whose install action already failed (fetch-stubbed end to end). */
async function renderFailedInstall(overrides: Record<string, unknown> = {}) {
  const unavailableView = { ...fixtureView, imo: { status: "error", code: "not-found", available: false, updateAvailable: false } };
  const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/actions/imo-diagnosis")) return jsonResponse({ ok: true, result: overrides.diagnosis ?? DIAGNOSIS_PAYLOAD });
    if (url.includes("/actions/imo-install")) return jsonResponse({ ok: false, error: { code: "install-failed", message: "install failed" } });
    if (url.includes("fast=0")) return jsonResponse(unavailableView);
    return jsonResponse(unavailableView);
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = renderCard(overrides.faces as DiagnosisFaces | undefined);
  const toggle = await view.findByRole("button", { name: new RegExp(`${zh.expand}: ${zh.title}`) });
  toggle.click();
  await view.findByRole("button", { name: zh.cliInstall });
  view.getByRole("button", { name: zh.cliInstall }).click();
  await view.findByText(new RegExp(zh.cliInstallFailed));
  return { view, fetchMock };
}

describe("install/update one-click diagnosis (TASK-083/088)", () => {
  afterEach(() => { cleanup(); });

  /**
   * Faces double over ONLY official rc.7 contract members (IWorkspaces:
   * list/create/connectWorkspace/rename; ISessions: open). `items` is the
   * live list the ensure step scans, so create→list-projection behaves like
   * the real manager's synchronous merge.
   */
  function makeFaces(options: {
    items?: ReadonlyArray<{ workspaceId: string; path?: string }>;
    createError?: Error;
    connectError?: Error;
    sessionIdPrefix?: string;
  } = {}) {
    const items = [...(options.items ?? [])];
    const calls: string[] = [];
    const workspaces = {
      list: { getSnapshot: () => ({ items }) },
      create: vi.fn(async (input: { path: string }) => {
        calls.push(`create:${input.path}`);
        if (options.createError !== undefined) throw options.createError;
        const workspaceId = `ws-${items.length + 1}`;
        items.push({ workspaceId, path: input.path });
        return { workspaceId };
      }),
      connectWorkspace: vi.fn(async (workspaceId: string) => {
        calls.push(`connect:${workspaceId}`);
        if (options.connectError !== undefined) throw options.connectError;
        return `${options.sessionIdPrefix ?? "session-of"}-${workspaceId}`;
      }),
      rename: vi.fn(async (workspaceId: string, title: string) => {
        calls.push(`rename:${workspaceId}:${title}`);
        return { workspaceId, title };
      }),
    };
    const sessions = {
      open: vi.fn((id: string) => { calls.push(`open:${id}`); }),
    };
    const faces: DiagnosisFaces = { workspaces: workspaces as unknown as DiagnosisWorkspaces, sessions };
    return { faces, workspaces, sessions, calls, items };
  }

  it("the diagnosis button appears only in the failed state", async () => {
    const failed = await renderFailedInstall();
    expect(await failed.view.findByRole("button", { name: zh.diagButton })).toBeTruthy();
    failed.view.unmount();

    // A successful install renders no diagnosis affordance.
    const availableView = { ...fixtureView };
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions/imo-install")) return jsonResponse({ ok: true, result: { status: "completed", packageManager: "npm", currentVersion: "0.2.14" } });
      if (url.includes("fast=0")) return jsonResponse(availableView);
      return jsonResponse({ ...fixtureView, imo: { status: "error", code: "not-found", available: false, updateAvailable: false } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ok = renderCard();
    const toggle = await ok.findByRole("button", { name: new RegExp(`${zh.expand}: ${zh.title}`) });
    toggle.click();
    await ok.findByRole("button", { name: zh.cliInstall });
    ok.getByRole("button", { name: zh.cliInstall }).click();
    await ok.findByText(new RegExp(zh.cliInstalled));
    expect(ok.queryAllByRole("button", { name: zh.diagButton })).toHaveLength(0);
    ok.unmount();
  });

  it("TASK-088: diagnose registers the dedicated install-diagnostics Workspace, opens the connectWorkspace-resolved session, and reports prefilled only after the entry writes", async () => {
    const faces = makeFaces();
    const dispatchSpy = vi.spyOn(document, "dispatchEvent");
    const failed = await renderFailedInstall({ faces });
    failed.view.getByRole("button", { name: zh.diagButton }).click();
    // The hand-off keys everything by the session id connectWorkspace RESOLVED
    // (reuse or fresh) — never a current-view guess.
    const sessionId = "session-of-ws-1";
    await vi.waitFor(() => { expect(peekDiagnosisPrefill(sessionId)).toBeDefined(); });
    const queued = peekDiagnosisPrefill(sessionId) ?? "";
    expect(queued).toContain("IMO CLI安装/更新失败诊断");
    expect(queued).toContain("npm config set @insuremo:registry <registry>");
    expect(queued).toContain("exitCode: 1");
    expect(queued).toContain("npm ERR");
    expect(queued).toContain("_auth=***");
    expect(queued).toContain("请分析失败原因并给出修复步骤。");
    // Official order: create → rename(安装诊断) → connect → open.
    expect(faces.calls).toEqual([
      "create:/tmp/dsh-home/install-diagnostics",
      "rename:ws-1:安装诊断",
      "connect:ws-1",
      `open:${sessionId}`,
    ]);
    // Honest status: no "prefilled" claim before the entry settles the write.
    expect(failed.view.queryByText(zh.diagPrefilled)).toBeNull();
    settleDiagnosisPrefill(sessionId, "written");
    await failed.view.findByText(zh.diagPrefilled);
    // The settings shell's own Escape channel closes the panel only on a real
    // prefill, landing the user on the diagnosis session.
    const escape = dispatchSpy.mock.calls.map(call => call[0]).find(event => event instanceof KeyboardEvent && event.key === "Escape");
    expect(escape).toBeTruthy();
    // The visible copy fallback rides every terminal state with text.
    expect(failed.view.getByRole("button", { name: zh.diagCopy })).toBeTruthy();
    dispatchSpy.mockRestore();
  });

  it("TASK-088: a dropped prefill (user-first) never claims prefilled and keeps the visible copy fallback", async () => {
    const faces = makeFaces({ sessionIdPrefix: "s-drop" });
    const failed = await renderFailedInstall({ faces });
    failed.view.getByRole("button", { name: zh.diagButton }).click();
    const sessionId = "s-drop-ws-1";
    await vi.waitFor(() => { expect(peekDiagnosisPrefill(sessionId)).toBeDefined(); });
    settleDiagnosisPrefill(sessionId, "dropped");
    await failed.view.findByText(zh.diagDraftOccupied);
    expect(failed.view.queryByText(zh.diagPrefilled)).toBeNull();
    expect(failed.view.getByRole("button", { name: zh.diagCopy })).toBeTruthy();
  });

  it("TASK-088: workspace-registration failure copies the text and creates/opens NO session (never an inert Ungrouped)", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const faces = makeFaces({ createError: new Error("mkdir failed") });
    const failed = await renderFailedInstall({ faces });
    failed.view.getByRole("button", { name: zh.diagButton }).click();
    await failed.view.findByText(zh.diagClipboardOnly);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0] as string).toContain("请分析失败原因并给出修复步骤。");
    expect(faces.workspaces.connectWorkspace).not.toHaveBeenCalled();
    expect(faces.sessions.open).not.toHaveBeenCalled();
    expect(failed.view.getByRole("button", { name: zh.diagCopy })).toBeTruthy();
  });

  it("TASK-088: connectWorkspace failure falls back to the clipboard and never opens a session", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const faces = makeFaces({ connectError: new Error("connect failed") });
    const failed = await renderFailedInstall({ faces });
    failed.view.getByRole("button", { name: zh.diagButton }).click();
    await failed.view.findByText(zh.diagClipboardOnly);
    expect(faces.workspaces.create).toHaveBeenCalledTimes(1);
    expect(faces.sessions.open).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("without runtime faces the text is copied and no workspace/session is touched", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const failed = await renderFailedInstall();
    failed.view.getByRole("button", { name: zh.diagButton }).click();
    await failed.view.findByText(zh.diagClipboardOnly);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0] as string).toContain("请分析失败原因并给出修复步骤。");
  });

  it("TASK-088: repeated clicks reuse the Workspace (create/rename once) and concurrent ensures coalesce", async () => {
    const faces = makeFaces();
    const failed = await renderFailedInstall({ faces });
    failed.view.getByRole("button", { name: zh.diagButton }).click();
    await vi.waitFor(() => { expect(peekDiagnosisPrefill("session-of-ws-1")).toBeDefined(); });
    settleDiagnosisPrefill("session-of-ws-1", "written");
    await failed.view.findByText(zh.diagPrefilled);
    // Second click: the Workspace is found by path (restart reuse) — no
    // second create, no rename; the same blank session reconnects.
    failed.view.getByRole("button", { name: zh.diagButton }).click();
    await vi.waitFor(() => { expect(faces.workspaces.connectWorkspace).toHaveBeenCalledTimes(2); });
    settleDiagnosisPrefill("session-of-ws-1", "written");
    await failed.view.findByText(zh.diagPrefilled);
    expect(faces.workspaces.create).toHaveBeenCalledTimes(1);
    expect(faces.workspaces.rename).toHaveBeenCalledTimes(1);
    expect(faces.sessions.open).toHaveBeenCalledTimes(2);
    // Concurrent ensures share one in-flight attempt: a single create.
    const slowItems: Array<{ workspaceId: string; path?: string }> = [];
    const slow = {
      list: { getSnapshot: () => ({ items: slowItems }) },
      create: vi.fn(async (input: { path: string }) => {
        await new Promise(resolve => setTimeout(resolve, 20));
        slowItems.push({ workspaceId: "ws-slow", path: input.path });
        return { workspaceId: "ws-slow" };
      }),
      connectWorkspace: vi.fn(async (workspaceId: string) => `session-of-${workspaceId}`),
      rename: vi.fn(async () => undefined),
    };
    const [a, b] = await Promise.all([
      ensureDiagnosisWorkspace(slow as unknown as DiagnosisWorkspaces, "/tmp/dsh-home/install-diagnostics", "安装诊断"),
      ensureDiagnosisWorkspace(slow as unknown as DiagnosisWorkspaces, "/tmp/dsh-home/install-diagnostics", "安装诊断"),
    ]);
    expect(a).toBe(b);
    expect(slow.create).toHaveBeenCalledTimes(1);
  });

  it("an upgrade failure diagnoses under the imo-upgrade operation", async () => {
    const faces = makeFaces({ sessionIdPrefix: "s-up" });
    const upgradeDiagnosis = {
      ...DIAGNOSIS_PAYLOAD,
      diagnosis: { ...DIAGNOSIS_PAYLOAD.diagnosis, operation: "imo-upgrade" },
    };
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions/imo-upgrade")) return jsonResponse({ ok: false, error: { code: "upgrade-failed", message: "upgrade failed" } });
      if (url.includes("/actions/imo-diagnosis")) return jsonResponse({ ok: true, result: upgradeDiagnosis });
      return jsonResponse(fixtureView);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = renderCard(faces);
    const toggle = await view.findByRole("button", { name: new RegExp(`${zh.expand}: ${zh.title}`) });
    toggle.click();
    (await view.findByRole("button", { name: zh.cliUpdate })).click();
    await view.findByText(new RegExp(zh.cliUpdateFailed));
    expect(view.queryAllByRole("button", { name: zh.diagButton })).toHaveLength(1);
    view.getByRole("button", { name: zh.diagButton }).click();
    const sessionId = "s-up-ws-1";
    await vi.waitFor(() => { expect(peekDiagnosisPrefill(sessionId)).toBeDefined(); });
    const draft = peekDiagnosisPrefill(sessionId) ?? "";
    expect(draft).toContain("IMO CLI安装/更新失败诊断");
    expect(draft).toContain("场景：IMO CLI 更新（imo-upgrade）");
    settleDiagnosisPrefill(sessionId, "written");
    await view.findByText(zh.diagPrefilled);
    view.unmount();
  });

  it("TASK-085: a failed scenario install diagnoses with the scenario identity and hands off the draft", async () => {
    const faces = makeFaces({ sessionIdPrefix: "s-sc" });
    const scenarioDiagnosis = {
      available: true,
      diagnosis: {
        kind: "skill",
        operation: "skill-install:scenario/ask-insuremo",
        commands: ["npx -y --registry=https://public.insuremo.com/artifactory/api/npm/npm/ @insuremo/skills-tool add insuremo-skills -g -a universal -s ask-insuremo -l --skip-update-check"],
        exitCode: 1,
        stdout: "",
        stderr: "npm ERR! network _auth=*** fetch failed",
        stdoutTruncated: false,
        stderrTruncated: false,
        error: { code: "non-zero-exit", message: "IMO CLI exited with code 1" },
        nodeVersion: "v22.19.0",
        platform: "darwin",
        arch: "arm64",
        occurredAt: "2026-09-06T09:00:00.000Z",
      },
      diagnosisCwd: "/tmp/dsh-home/install-diagnostics",
    };
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions/skill-install")) {
        expect((init?.body as string)).toContain("ask-insuremo");
        return jsonResponse({ ok: false, error: { code: "non-zero-exit", message: "npm ERR! network fetch failed" } });
      }
      if (url.includes("/actions/imo-diagnosis")) return jsonResponse({ ok: true, result: scenarioDiagnosis });
      return jsonResponse(fixtureView);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = renderCard(faces);
    const toggle = await view.findByRole("button", { name: new RegExp(`${zh.expand}: ${zh.title}`) });
    toggle.click();
    // The scenario install fails at the PREVIEW (dry-run) stage offline.
    (await view.findByRole("button", { name: new RegExp(`^${zh.skillsScenarioInstall}`) })).click();
    await view.findByText(new RegExp(zh.skillsScenarioFailed));
    view.getByRole("button", { name: zh.diagButton }).click();
    const sessionId = "s-sc-ws-1";
    await vi.waitFor(() => { expect(peekDiagnosisPrefill(sessionId)).toBeDefined(); });
    const draft = peekDiagnosisPrefill(sessionId) ?? "";
    expect(draft).toContain("Skills 场景/来源安装");
    expect(draft).toContain("skill-install:scenario/ask-insuremo");
    expect(draft).toContain("-l --skip-update-check");
    expect(draft).toContain("错误：non-zero-exit: IMO CLI exited with code 1");
    expect(draft).toContain("请分析失败原因并给出修复步骤。");
    settleDiagnosisPrefill(sessionId, "written");
    await view.findByText(zh.diagPrefilled);
    view.unmount();
  });

  it("TASK-086: en translator direct-render coverage (no locale switch)", async () => {
    const faces = makeFaces({ sessionIdPrefix: "s-en" });
    const scenarioDiagnosis = {
      available: true,
      diagnosis: {
        kind: "skill",
        operation: "skill-install:scenario/ask-insuremo",
        commands: ["npx -y --registry=https://public.insuremo.com/artifactory/api/npm/npm/ @insuremo/skills-tool add insuremo-skills -g -a universal -s ask-insuremo -l --skip-update-check"],
        exitCode: null,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        error: { code: "tool-unavailable", message: "npx is unavailable; install Node.js/npm to sync Skills" },
        nodeVersion: "v22.19.0",
        platform: "darwin",
        arch: "arm64",
        occurredAt: "2026-09-06T09:30:00.000Z",
      },
      diagnosisCwd: "/tmp/dsh-home/install-diagnostics",
    };
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions/skill-install")) return jsonResponse({ ok: false, error: { code: "tool-unavailable", message: "npx is unavailable; install Node.js/npm to sync Skills" } });
      if (url.includes("/actions/imo-diagnosis")) return jsonResponse({ ok: true, result: scenarioDiagnosis });
      return jsonResponse(fixtureView);
    });
    vi.stubGlobal("fetch", fetchMock);
    // English Settings locale: this case mounts the card directly with an
    // English translator seat injected — it proves the click path consumes the
    // current seat, with NO runtime locale switching (that lives in the
    // same-instance switch case below).
    const view = renderCard(faces, key => en[key]);
    const toggle = await view.findByRole("button", { name: new RegExp(`${en.expand}: ${en.title}`) });
    toggle.click();
    (await view.findByRole("button", { name: new RegExp(`^${en.skillsScenarioInstall}`) })).click();
    await view.findByText(new RegExp(en.skillsScenarioFailed));
    view.getByRole("button", { name: en.diagButton }).click();
    const sessionId = "s-en-ws-1";
    await vi.waitFor(() => { expect(peekDiagnosisPrefill(sessionId)).toBeDefined(); });
    const draft = peekDiagnosisPrefill(sessionId) ?? "";
    expect(draft).toContain("Skills install/update failure diagnosis");
    expect(draft).toContain("Scenario: Skills scenario/source install (skill-install:scenario/ask-insuremo)");
    expect(draft).toContain("Executed commands:");
    expect(draft).toContain("exitCode: (not run)");
    expect(draft).toContain("Error: tool-unavailable: npx is unavailable; install Node.js/npm to sync Skills");
    expect(draft).toContain("(empty)");
    expect(draft).toContain("Environment:");
    expect(draft).toContain("Please analyze the cause of the failure and provide fix steps.");
    // Raw material stays verbatim in the English draft.
    expect(draft).toContain("-l --skip-update-check");
    expect(draft).toContain("node: v22.19.0");
    expect(draft).not.toContain("场景：");
    expect(draft).not.toContain("请分析失败原因");
    // The Workspace title follows the Settings locale at click time.
    expect(faces.workspaces.rename).toHaveBeenCalledWith("ws-1", "Install Diagnostics");
    settleDiagnosisPrefill(sessionId, "written");
    await view.findByText(en.diagPrefilled);
    view.unmount();
  });

  it("TASK-086: one mounted card switches the draft language with the live Settings locale (zh → en → zh)", async () => {
    const scenarioDiagnosis = {
      available: true,
      diagnosis: {
        kind: "skill",
        operation: "skill-install:scenario/ask-insuremo",
        commands: ["npx -y --registry=https://public.insuremo.com/artifactory/api/npm/npm/ @insuremo/skills-tool add insuremo-skills -g -a universal -s ask-insuremo -l --skip-update-check"],
        exitCode: null,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        error: { code: "tool-unavailable", message: "npx is unavailable; install Node.js/npm to sync Skills" },
        nodeVersion: "v22.19.0",
        platform: "darwin",
        arch: "arm64",
        occurredAt: "2026-09-06T09:45:00.000Z",
      },
      diagnosisCwd: "/tmp/dsh-home/install-diagnostics",
    };
    const fetchMock: StubFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/actions/skill-install")) return jsonResponse({ ok: false, error: { code: "tool-unavailable", message: "npx is unavailable; install Node.js/npm to sync Skills" } });
      if (url.includes("/actions/imo-diagnosis")) return jsonResponse({ ok: true, result: scenarioDiagnosis });
      return jsonResponse(fixtureView);
    });
    vi.stubGlobal("fetch", fetchMock);

    // A self-contained runtime: ONE mounted renderSlot instance for the whole
    // case. The runtime's native TestSessions/TestWorkspaces doubles carry
    // the official faces; the dedicated Workspace is pre-seeded into the
    // list, so every round exercises restart-reuse (create never called).
    // A local localStorage stub covers SlotTestRuntime's dispose (this
    // describe sits outside the outer beforeEach's stub scope).
    const storageValues = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => { storageValues.set(key, value); },
      removeItem: (key: string) => { storageValues.delete(key); },
      clear: () => { storageValues.clear(); },
      key: (index: number) => [...storageValues.keys()][index] ?? null,
      get length() { return storageValues.size; },
    });
    const switchRuntime = await SlotTestRuntime.create();
    await switchRuntime.declare({ "settings.plugin.item": { kind: "list", scope: "root" } });
    const switchLocale = new LocaleRuntime(switchRuntime.ctx);
    switchRuntime.ctx.provide("locale", switchLocale);
    switchRuntime.slots.installLocale(switchLocale);
    await switchRuntime.workspaces.update(draft => {
      (draft.items as unknown[]) = [{
        workspaceId: "ws-diagnosis", title: "安装诊断", path: "/tmp/dsh-home/install-diagnostics", sessionIds: [],
      }];
    });
    // The connectWorkspace-resolved session id is not a fixture session, so
    // the native TestSessions.open (which requires listed ids) is grafted to
    // a recording spy — the hand-off contract under test is the CALL, and the
    // workspaces double proves reuse independently.
    const openSpy = vi.fn((id: string) => { void id; });
    (switchRuntime.sessions as unknown as Record<string, unknown>).open = openSpy;
    const switchFeature = await switchRuntime.mount({ inject, apply });
    try {
      const view = switchRuntime.renderSlot("settings.plugin.item", {});
      // zh (pinned zh-CN): enter the failed state and diagnose in Chinese.
      const toggle = await view.view.findByRole("button", { name: new RegExp(`${zh.expand}: ${zh.title}`) });
      toggle.click();
      (await view.view.findByRole("button", { name: new RegExp(`^${zh.skillsScenarioInstall}`) })).click();
      await view.view.findByText(new RegExp(zh.skillsScenarioFailed));
      view.view.getByRole("button", { name: zh.diagButton }).click();
      const sessionId = "session-of-ws-diagnosis";
      await vi.waitFor(() => { expect(peekDiagnosisPrefill(sessionId)).toBeDefined(); });
      let draft = peekDiagnosisPrefill(sessionId) ?? "";
      expect(draft).toContain("Skills安装/更新失败诊断");
      expect(draft).toContain("场景：");
      expect(draft).toContain("错误：tool-unavailable");
      expect(draft).toContain("请分析失败原因并给出修复步骤。");
      settleDiagnosisPrefill(sessionId, "written");
      await view.view.findByText(zh.diagPrefilled);

      // SAME mounted instance: the Settings locale flips to English and the
      // next click stages an English draft (no remount involved).
      switchLocale.setLocale("en");
      // The outlet re-renders through its locale-revision subscription; wait
      // for the English chrome before driving the (now English) button.
      await vi.waitFor(() => {
        expect(view.view.getByRole("button", { name: new RegExp(`${en.collapse}: ${en.title}`) })).toBeTruthy();
      });
      view.view.getByRole("button", { name: en.diagButton }).click();
      await vi.waitFor(() => { expect(peekDiagnosisPrefill(sessionId)).toContain("Skills install/update failure diagnosis"); });
      draft = peekDiagnosisPrefill(sessionId) ?? "";
      expect(draft).toContain("Scenario: Skills scenario/source install (skill-install:scenario/ask-insuremo)");
      expect(draft).toContain("Error: tool-unavailable: npx is unavailable; install Node.js/npm to sync Skills");
      expect(draft).toContain("Please analyze the cause of the failure and provide fix steps.");
      // Raw material identical, Chinese labels gone.
      expect(draft).toContain("-l --skip-update-check");
      expect(draft).toContain("node: v22.19.0");
      expect(draft).not.toContain("场景：");
      expect(draft).not.toContain("请分析失败原因");
      settleDiagnosisPrefill(sessionId, "written");
      await view.view.findByText(en.diagPrefilled);

      // And back to Chinese on the same instance.
      switchLocale.setLocale("zh");
      await vi.waitFor(() => {
        expect(view.view.getByRole("button", { name: new RegExp(`${zh.collapse}: ${zh.title}`) })).toBeTruthy();
      });
      view.view.getByRole("button", { name: zh.diagButton }).click();
      await vi.waitFor(() => { expect(peekDiagnosisPrefill(sessionId)).toContain("场景："); });
      draft = peekDiagnosisPrefill(sessionId) ?? "";
      expect(draft).toContain("请分析失败原因并给出修复步骤。");
      settleDiagnosisPrefill(sessionId, "written");
      await view.view.findByText(zh.diagPrefilled);

      // Every round reused the dedicated Workspace: never a duplicate create,
      // always the connectWorkspace-resolved session id.
      const workspaceCalls = switchRuntime.workspaces.calls.filter(call => call.method === "create");
      expect(workspaceCalls).toHaveLength(0);
      const connectCalls = switchRuntime.workspaces.calls.filter(call => call.method === "connectWorkspace");
      expect(connectCalls).toHaveLength(3);
      for (const call of connectCalls) expect(call.args[0]).toBe("ws-diagnosis");
    } finally {
      await switchFeature.dispose();
      await switchRuntime.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("an empty diagnosis store answers no-data without touching workspaces or sessions", async () => {
    const faces = makeFaces();
    const failed = await renderFailedInstall({ faces, diagnosis: { available: false } });
    failed.view.getByRole("button", { name: zh.diagButton }).click();
    await failed.view.findByText(zh.diagNoData);
    expect(faces.workspaces.create).not.toHaveBeenCalled();
    expect(faces.workspaces.connectWorkspace).not.toHaveBeenCalled();
    expect(faces.sessions.open).not.toHaveBeenCalled();
  });
});

describe("diagnosis hand-off + prefill entry units (TASK-088)", () => {
  afterEach(() => { cleanup(); });

  function mountEntry(sessionId: string, draftState: { draft: string }, setDraft: ReturnType<typeof vi.fn>) {
    const useInput = (selector: (state: { draft: string }) => unknown) => selector(draftState);
    const inputActions = { setDraft: (text: string) => setDraft(text) };
    return render(<DiagnosisPrefillEntry sessionId={sessionId} useInput={useInput as never} inputActions={inputActions} />);
  }

  it("handOffDiagnosis keys the queue and open by the connectWorkspace-resolved id (never a current guess)", async () => {
    const workspaces = {
      list: { getSnapshot: () => ({ items: [] as ReadonlyArray<{ workspaceId: string; path?: string }> }) },
      create: vi.fn(async () => ({ workspaceId: "ws-x" })),
      connectWorkspace: vi.fn(async () => "session-42"),
      rename: vi.fn(async () => undefined),
    };
    const open = vi.fn();
    const handoff = await handOffDiagnosis("TEXT", "/d", { workspaces: workspaces as unknown as DiagnosisWorkspaces, sessions: { open } }, "安装诊断");
    expect(handoff).toEqual({ kind: "opened", sessionId: "session-42" });
    expect(open).toHaveBeenCalledWith("session-42");
    expect(peekDiagnosisPrefill("session-42")).toBe("TEXT");
    settleDiagnosisPrefill("session-42", "written");
  });

  it("prefill entry writes the queued text once into an empty draft and settles written", async () => {
    const sessionId = `entry-empty-${Date.now()}`;
    const setDraft = vi.fn();
    const draftState = { draft: "" };
    queueDiagnosisPrefill(sessionId, "PREFILL-TEXT");
    const entry = mountEntry(sessionId, draftState, setDraft);
    await vi.waitFor(() => { expect(setDraft).toHaveBeenCalledWith("PREFILL-TEXT"); });
    await expect(waitForDiagnosisPrefill(sessionId, 50)).resolves.toBe("written");
    // Consume-once: further renders never rewrite.
    entry.rerender(<DiagnosisPrefillEntry sessionId={sessionId} useInput={selector => selector(draftState)} inputActions={{ setDraft }} />);
    await Promise.resolve();
    expect(setDraft).toHaveBeenCalledTimes(1);
  });

  it("prefill entry never overwrites a user draft (drop + settled dropped)", async () => {
    const sessionId = `entry-occupied-${Date.now()}`;
    const setDraft = vi.fn();
    const draftState = { draft: "user typed first" };
    queueDiagnosisPrefill(sessionId, "PREFILL-TEXT");
    mountEntry(sessionId, draftState, setDraft);
    await vi.waitFor(() => { expect(peekDiagnosisPrefill(sessionId)).toBeUndefined(); });
    expect(setDraft).not.toHaveBeenCalled();
    await expect(waitForDiagnosisPrefill(sessionId, 50)).resolves.toBe("dropped");
  });

  it("prefill entry consumes reactively while already mounted (no remount needed)", async () => {
    const sessionId = `entry-reactive-${Date.now()}`;
    const setDraft = vi.fn();
    const draftState = { draft: "" };
    // Mounted BEFORE anything is queued.
    mountEntry(sessionId, draftState, setDraft);
    await Promise.resolve();
    expect(setDraft).not.toHaveBeenCalled();
    // Queueing notifies subscribers; the mounted entry consumes immediately.
    queueDiagnosisPrefill(sessionId, "REACTIVE-TEXT");
    await vi.waitFor(() => { expect(setDraft).toHaveBeenCalledWith("REACTIVE-TEXT"); });
  });

  it("prefill entry is session-keyed: another session's queued text never lands", async () => {
    const setDraft = vi.fn();
    const draftState = { draft: "" };
    mountEntry("entry-isolation-a", draftState, setDraft);
    queueDiagnosisPrefill("entry-isolation-b", "OTHER-SESSION-TEXT");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(setDraft).not.toHaveBeenCalled();
  });

  it("ensureDiagnosisWorkspace reuses by path without rename (restart reuse)", async () => {
    const items = [{ workspaceId: "ws-keep", path: "/tmp/dsh-home/install-diagnostics" }];
    const workspaces = {
      list: { getSnapshot: () => ({ items }) },
      create: vi.fn(async () => ({ workspaceId: "ws-new" })),
      connectWorkspace: vi.fn(async () => "s"),
      rename: vi.fn(async () => undefined),
    };
    const id = await ensureDiagnosisWorkspace(workspaces as unknown as DiagnosisWorkspaces, "/tmp/dsh-home/install-diagnostics", "安装诊断");
    expect(id).toBe("ws-keep");
    expect(workspaces.create).not.toHaveBeenCalled();
    expect(workspaces.rename).not.toHaveBeenCalled();
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
