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
    // TASK-108: the row is compact again -- type label + name only; the
    // description lives in the native hover tooltip instead of inline copy.
    const row = view.getByRole("option", { name: `${zh.skillsCatalogSkill}: alpha-skill` });
    expect(row.textContent).toBe(`${zh.skillsCatalogSkill}alpha-skill`);
    expect(row.getAttribute("title")).toBe("Audit and search helper");
    expect(view.queryByText("Audit and search helper")).toBeNull();
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

describe("TASK-106 catalog parser bounds", () => {
  it("accepts multi-line descriptions up to 4096 and rejects what the host rejects", async () => {
    const { parseSkillCatalog } = await import("../src/client/overview.ts");
    const base = {
      schemaVersion: "1", status: "ready", source: "insuremo-skills",
      fetchedAt: "2099-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:01:00.000Z",
      entries: [{ type: "skill", name: "alpha-skill", description: "line one\nline two", group: "General" }],
    };
    const parsed = parseSkillCatalog({ ok: true, result: base });
    expect(parsed?.entries[0]?.description).toBe("line one\nline two");
    // The real 1.1.2 capture tops out at 1622 characters, well above the old 500 bound.
    const long = { ...base, entries: [{ type: "skill", name: "alpha-skill", description: "x".repeat(1622) }] };
    expect(parseSkillCatalog({ ok: true, result: long })?.entries[0]?.description.length).toBe(1622);
    const atBound = { ...base, entries: [{ type: "skill", name: "alpha-skill", description: "x".repeat(4096) }] };
    expect(parseSkillCatalog({ ok: true, result: atBound })?.entries[0]?.description.length).toBe(4096);
    const overBound = { ...base, entries: [{ type: "skill", name: "alpha-skill", description: "x".repeat(4097) }] };
    expect(parseSkillCatalog({ ok: true, result: overBound })).toBeNull();
    const control = { ...base, entries: [{ type: "skill", name: "alpha-skill", description: "bad\u0001control" }] };
    expect(parseSkillCatalog({ ok: true, result: control })).toBeNull();
  });
});

describe("TASK-108 compact catalog rows", () => {
  const renderCard = async (entries: readonly Record<string, unknown>[]) => {
    const payload = { ...catalog, entries };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("skill-catalog-refresh")) return new Response(JSON.stringify({ ok: true, result: payload }), { status: 200 });
      if (url.includes("skill-catalog")) return new Response(JSON.stringify({ ok: true, result: payload }), { status: 200 });
      return new Response(JSON.stringify(overview), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<InsuremoCard t={(key: keyof typeof zh) => zh[key]} onChanged={() => undefined} {...({} as never)} />);
    (await view.findByRole("button", { name: new RegExp(zh.expand) })).click();
    await view.findByRole("listbox", { name: zh.skillsCatalogTitle });
    return view;
  };

  it("keeps scenario rows on the allowlisted i18n copy and never inlines the description", async () => {
    const view = await renderCard([
      { type: "scenario", name: "ask-insuremo", description: "raw server copy that must not render" },
      { type: "skill", name: "alpha-skill", description: "Audit and search helper", group: "General" },
    ]);
    const scenario = view.getByRole("option", { name: `${zh.skillsCatalogScenario}: ask-insuremo` });
    expect(scenario.textContent).toBe(`${zh.skillsCatalogScenario}ask-insuremo`);
    expect(scenario.getAttribute("title")).toBe(zh.skillsCatalogDescriptionAsk);
    const skill = view.getByRole("option", { name: `${zh.skillsCatalogSkill}: alpha-skill` });
    expect(skill.textContent).toBe(`${zh.skillsCatalogSkill}alpha-skill`);
    expect(skill.getAttribute("title")).toBe("Audit and search helper");
    expect(view.queryByText("raw server copy that must not render")).toBeNull();
    expect(view.queryByText("Audit and search helper")).toBeNull();
  });

  it("collapses paragraph LFs into a single-line tooltip, bounds it, and still searches the full description", async () => {
    const full = `Short summary.\nWrapped second line   with   runs. ${"detail ".repeat(80)}needle-tail marker`;
    const view = await renderCard([{ type: "skill", name: "long-skill", description: full, group: "General" }]);
    const row = view.getByRole("option", { name: `${zh.skillsCatalogSkill}: long-skill` });
    const title = row.getAttribute("title") ?? "";
    expect(title.startsWith("Short summary. Wrapped second line with runs.")).toBe(true);
    expect(title.includes("\n")).toBe(false);
    expect(title.length).toBeLessThanOrEqual(400);
    expect(title.endsWith("\u2026")).toBe(true);
    expect(title.includes("needle-tail")).toBe(false);
    // Search semantics are untouched: the untruncated description still matches.
    fireEvent.change(view.getByRole("searchbox", { name: zh.skillsCatalogSearch }), { target: { value: "needle-tail" } });
    expect(view.getByRole("option", { name: `${zh.skillsCatalogSkill}: long-skill` })).toBeTruthy();
    expect(view.queryByText(zh.skillsCatalogNoMatch)).toBeNull();
  });

  it("keeps all 41 real-shaped rows in server order, each as label + name", async () => {
    const scenarioNames = ["icomposer-full-stack", "icomposer-coding-lite", "icomposer-api-design", "uic-developer", "ask-insuremo"];
    const scenarios = scenarioNames.map(name => ({ type: "scenario", name, description: `server copy for ${name}` }));
    const skills = Array.from({ length: 36 }, (_, index) => ({
      type: "skill", name: `skill-${String(index + 1).padStart(2, "0")}`, description: `description ${index + 1}`, group: "General",
    }));
    const view = await renderCard([...scenarios, ...skills]);
    const options = view.getAllByRole("option");
    expect(options).toHaveLength(41);
    expect(options.map(option => option.getAttribute("data-catalog-entry"))).toEqual([
      ...scenarioNames.map(name => `scenario:${name}`),
      ...skills.map(skill => `skill:${skill.name}`),
    ]);
    options.forEach((option, index) => {
      const isScenario = index < scenarioNames.length;
      const name = isScenario ? scenarioNames[index]! : skills[index - scenarioNames.length]!.name;
      expect(option.textContent).toBe(`${isScenario ? zh.skillsCatalogScenario : zh.skillsCatalogSkill}${name}`);
      expect(option.getAttribute("title")).toBeTruthy();
    });
  });

  it("never splits an astral character at the tooltip cap", async () => {
    const view = await renderCard([{ type: "skill", name: "emoji-skill", description: `${"y".repeat(398)}\u{1F600}tail`, group: "General" }]);
    const title = view.getByRole("option", { name: `${zh.skillsCatalogSkill}: emoji-skill` }).getAttribute("title") ?? "";
    expect(title.endsWith("\u2026")).toBe(true);
    expect(title.length).toBe(399);
    // encodeURIComponent throws on a lone surrogate, so this proves the pair was not cut.
    expect(() => encodeURIComponent(title)).not.toThrow();
  });
});
