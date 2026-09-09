import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { InsuremoCard } from "../src/client/InsuremoCard.tsx";
import { zh } from "../src/client/locales.ts";

const overview = {
  schemaVersion: "1",
  generatedAt: "2026-01-01T00:00:00.000Z",
  imo: { status: "ok", available: true, current: "0.2.17", updateAvailable: false },
  auth: { status: "ok", profiles: [], count: 0, activeProfileName: null },
  skills: { status: "ok", installed: 0, valid: 0, enabled: 0, disabled: 0, names: [], entries: [], formatInvalidCount: 0, pathIssueCount: 0, diagnosticCount: 0, diagnostics: [], diagnosticsTruncated: false },
  operations: { status: "ok", pending: 0, approved: 0, rejected: 0, recorded: 0, recent: [] },
  diagnostics: { status: "ok", diagnostics: [] },
};

const catalog = {
  schemaVersion: "1",
  status: "ready",
  source: "insuremo-skills",
  fetchedAt: "2099-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T00:01:00.000Z",
  entries: [
    { type: "scenario", name: "ask-insuremo", description: "Knowledge tools" },
    { type: "skill", name: "alpha-skill", description: "Audit and search helper", group: "General" },
  ],
} as const;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("trusted available Skills picker", () => {
  it("searches locally, selects a single Skill, and sends only the validated name", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("skill-catalog-refresh")) {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ ok: true, result: catalog }), { status: 200 });
      }
      if (url.includes("skill-install")) {
        expect(JSON.parse(String(init?.body))).toEqual({ skill: "alpha-skill" });
        return new Response(JSON.stringify({ ok: true, result: { status: "completed", added: ["alpha-skill"], updated: [], removed: [] } }), { status: 200 });
      }
      return new Response(JSON.stringify(overview), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<InsuremoCard t={(key: keyof typeof zh) => zh[key]} onChanged={() => undefined} {...({} as never)} />);
    const header = await view.findByRole("button", { name: new RegExp(zh.expand) });
    header.click();
    const search = await view.findByRole("searchbox", { name: zh.skillsCatalogSearch });
    expect(await view.findByRole("listbox", { name: zh.skillsCatalogTitle })).toBeTruthy();
    expect(view.queryByRole("combobox")).toBeNull();
    expect(view.getByText("Audit and search helper")).toBeTruthy();
    fireEvent.change(search, { target: { value: "AUDIT" } });
    expect(view.getByRole("option", { name: `${zh.skillsCatalogSkill}: alpha-skill` })).toBeTruthy();
    fireEvent.change(search, { target: { value: "does-not-exist" } });
    expect(view.getByText(zh.skillsCatalogNoMatch)).toBeTruthy();
    expect((view.getByRole("button", { name: new RegExp(`^${zh.skillsScenarioInstall}`) }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(search, { target: { value: "alpha" } });
    expect(view.getByRole("option", { name: `${zh.skillsCatalogSkill}: alpha-skill` })).toBeTruthy();
    fireEvent.click(view.getByRole("option", { name: `${zh.skillsCatalogSkill}: alpha-skill` }));
    fireEvent.click(await view.findByRole("button", { name: `${zh.skillsCatalogInstall}: alpha-skill` }));
    await view.findByText(new RegExp(zh.skillsCatalogDone));
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes("skill-catalog-refresh"))).toHaveLength(1);
  });

  it("keeps scenario fallback and exposes a retry when the catalog format is unknown or expired", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("skill-catalog-refresh")) {
        return new Response(JSON.stringify({ ok: true, result: { ...catalog, status: "ready", expiresAt: "2000-01-01T00:00:00.000Z", entries: [{ type: "unexpected", name: "alpha-skill", description: "bad" }] } }), { status: 200 });
      }
      if (url.includes("skill-catalog")) return new Response(JSON.stringify({ ok: false, error: { code: "catalog-unavailable", message: "cache miss" } }), { status: 200 });
      return new Response(JSON.stringify(overview), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<InsuremoCard t={(key: keyof typeof zh) => zh[key]} onChanged={() => undefined} {...({} as never)} />);
    (await view.findByRole("button", { name: new RegExp(zh.expand) })).click();
    expect(await view.findByRole("alert")).toBeTruthy();
    expect(view.getByRole("alert").textContent).toContain(zh.skillsCatalogUnavailable);
    expect(view.getByRole("combobox", { name: zh.skillsScenarioLabel })).toBeTruthy();
    expect(view.queryByRole("listbox", { name: zh.skillsCatalogTitle })).toBeNull();
  });

  it("disables conflicting actions while explicit catalog discovery is pending", async () => {
    let release!: (response: Response) => void;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("skill-catalog")) {
        if (url.includes("skill-catalog-refresh")) return await new Promise<Response>(resolve => { release = resolve; });
        return new Response(JSON.stringify({ ok: false, error: { code: "catalog-unavailable", message: "cache miss" } }), { status: 200 });
      }
      return new Response(JSON.stringify(overview), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<InsuremoCard t={(key: keyof typeof zh) => zh[key]} onChanged={() => undefined} {...({} as never)} />);
    (await view.findByRole("button", { name: new RegExp(zh.expand) })).click();
    expect((await view.findByRole("status")).textContent).toContain(zh.skillsCatalogLoading);
    expect((view.getByRole("button", { name: new RegExp(`^${zh.skillsScenarioInstall}`) }) as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByRole("button", { name: new RegExp(`^${zh.skillsUpdateAll}\\b`) }) as HTMLButtonElement).disabled).toBe(true);
    release(new Response(JSON.stringify({ ok: false, error: { code: "catalog-unavailable", message: "unknown format" } }), { status: 200 }));
    expect((await view.findByRole("alert")).textContent).toContain(zh.skillsCatalogUnavailable);
  });
});
