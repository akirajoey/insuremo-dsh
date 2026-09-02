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
    expect(await view.view.findByRole("button", { name: zh.skillsScenarioInstall })).toBeTruthy();
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
    (await view.view.findByRole("button", { name: zh.skillsScenarioInstall })).click();
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
    const install = await view.view.findByRole("button", { name: zh.skillsScenarioInstall });
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
    (await view.view.findByRole("button", { name: zh.skillsUpdateAll })).click();
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
    (await view.view.findByRole("button", { name: zh.skillsUpdateAll })).click();
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
    const install = await view.view.findByRole("button", { name: zh.skillsScenarioInstall });
    install.click();
    await vi.waitFor(() => {
      expect((view.view.getByRole("button", { name: zh.skillsScenarioInstalling }) as HTMLButtonElement).disabled).toBe(true);
      expect((view.view.getByRole("button", { name: zh.skillsUpdateAll }) as HTMLButtonElement).disabled).toBe(true);
      const toggle = view.view.getAllByRole("switch").find(el => el.getAttribute("aria-label")?.includes("imo-audit-helper"))!;
      expect((toggle as HTMLButtonElement).disabled).toBe(true);
      expect((view.view.getByRole("combobox", { name: zh.skillsScenarioLabel }) as HTMLSelectElement).disabled).toBe(true);
    });
    resolveInstall?.(jsonResponse({ ok: true, result: { status: "completed", beforeCount: 2, afterCount: 3, added: ["insuremo-auth-cli"], removed: [], updated: [] } }));
    await vi.waitFor(() => {
      expect((view.view.getByRole("button", { name: zh.skillsUpdateAll }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("TASK-079: English copy renders for the scenario region", async () => {
    const fetchMock: StubFetch = vi.fn(async () => jsonResponse(fixtureView));
    vi.stubGlobal("fetch", fetchMock);
    locale.setLocale("en");
    const view = runtime.renderSlot("settings.plugin.item", {});
    const header = await view.view.findByRole("button", { name: new RegExp(`${en.expand}: ${en.title}`) });
    header.click();
    expect(await view.view.findByRole("button", { name: en.skillsScenarioInstall })).toBeTruthy();
    expect(await view.view.findByRole("combobox", { name: en.skillsScenarioLabel })).toBeTruthy();
    expect(await view.view.findByRole("button", { name: en.skillsUpdateAll })).toBeTruthy();
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
