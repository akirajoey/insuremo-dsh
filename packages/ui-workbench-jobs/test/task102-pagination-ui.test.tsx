import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import { SlotTestRuntime, usePinnedBrowserLanguages } from "@deepseek-ai/dsh-client-test-runtime";
import { IciExplainToolview } from "../src/client/IciExplainToolview.tsx";
import { apply, inject } from "../src/client/index.ts";
import { zh } from "../src/client/locales.ts";

usePinnedBrowserLanguages("zh-CN");
const batchId = "fedcba9876543210";

/** TASK-102 fixture: ten jobs across two pages with mixed statuses. */
function paged(url: string | undefined, rows: any[]): { jobs: any[]; page: any; countsByStatus: Record<string, number> } {
  // TASK-111 P4: the status route pages server-side; the fixture slices exactly like the server.
  const query = new URL(String(url ?? ""), "http://localhost").searchParams;
  const size = Number(query.get("size") ?? 5);
  const page = Math.max(1, Number(query.get("page") ?? 1));
  const totalPages = Math.max(1, Math.ceil(rows.length / size));
  const from = (Math.min(page, totalPages) - 1) * size;
  const countsByStatus: Record<string, number> = {};
  for (const row of rows) countsByStatus[row.status] = (countsByStatus[row.status] ?? 0) + 1;
  return { jobs: rows.slice(from, from + size), page: { index: Math.min(page, totalPages), size, totalPages }, countsByStatus };
}
function batchStatus(jobs = 10, scheduler: { maxConcurrent: number; inFlight: number } = { maxConcurrent: 4, inFlight: 2 }, url = "") {
  const rows = Array.from({ length: jobs }, (_, index) => ({
    jobId: `000000000000${String(index).padStart(4, "0")}`,
    apiName: `Api${index}`,
    status: index < 3 ? "final" : index < 5 ? "running" : "awaiting-input",
    provider: "mvp",
    model: "mvp-model",
    childSessionId: "123e4567-e89b-12d3-a456-426614174000",
    startedAt: "2026-08-27T01:02:03.000Z",
    finishedAt: index < 3 ? "2026-08-27T01:03:00.000Z" : undefined,
    artifactPath: index < 3 ? `.metadata/icomposer/ici/explain/Api${index}/finals/000000000000${String(index).padStart(4, "0")}.json` : undefined,
    error: index === 0 ? "model-failed: long diagnostic detail that is truncated in the compact row and shown in full inside the details fold" : undefined,
    promptBaseBytes: 1024,
    sourceBytes: 512,
  }));
  const sliced = paged(url, rows);
  return {
    ok: true,
    result: {
      batch: { batchId, workspaceId: "batch", jobCount: rows.length, createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z" },
      jobs: sliced.jobs,
      providers: [{ id: "mvp", models: [{ id: "mvp-model", name: "MVP model" }] }],
      scheduler,
      page: sliced.page,
      summary: { promptBaseBytes: 10240, sourceBytes: 5120, maxPromptBaseBytes: 1024, jobCount: rows.length, countsByStatus: sliced.countsByStatus },
    },
  };
}

describe("TASK-102 batch pagination and concurrency settings", () => {
  let runtime: SlotTestRuntime; let locale: LocaleRuntime; let feature: Awaited<ReturnType<SlotTestRuntime["mount"]>>;
  beforeEach(async () => {
    vi.stubGlobal("localStorage", { clear: () => undefined, getItem: () => null, setItem: () => undefined, removeItem: () => undefined, key: () => null, length: 0 });
    runtime = await SlotTestRuntime.create(); locale = new LocaleRuntime(runtime.ctx); runtime.ctx.provide("locale", locale); runtime.slots.installLocale(locale);
    const owner: any = { callId: "batch-call", toolName: "ici_explain", block: { kind: "tool-result", call: { argsRaw: JSON.stringify({ workspace_id: "batch", queries: ["Api0"] }) }, content: [{ type: "text", text: `batch=${batchId} jobs=10` }] } };
    const Frame = ({ renderSlot }: any) => renderSlot("tool.call.toolview", owner, { entryKey: "ici_explain" });
    await runtime.root.declare({ "tool.call.toolview": { kind: "keyed", scope: "root" } } as never, Frame as never);
    feature = await runtime.mount({ inject, apply });
  });
  afterEach(async () => { await feature.dispose(); await runtime.dispose(); vi.unstubAllGlobals(); });

  it("pages five rows per page, keeps whole-batch stats on every page, and never auto-jumps on polling", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/status") ? new Response(JSON.stringify(batchStatus(10, { maxConcurrent: 4, inFlight: 2 }, String(input))), { status: 200 }) : new Response(JSON.stringify({ ok: false }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderRoot();
    await vi.waitFor(() => expect(view.queryByText("Api0")).not.toBeNull());
    expect(view.getAllByRole("listitem")).toHaveLength(5);
    expect(view.queryByText("Api5")).toBeNull();
    const stats = view.getByTestId("ici-explain-batch-stats").textContent ?? "";
    expect(stats).toContain(`${zh["explain.jobTotal"]} 10`);
    expect(stats).toContain(`${zh["explain.statFinal"]} 3`);
    expect(stats).toContain(`${zh["explain.statRunning"]} 2`);
    expect(stats).toContain(`${zh["status.awaiting-input"]} 5`);
    expect(view.getByText(new RegExp(`${zh["explain.pageLabel"]} 1/2`))).toBeTruthy();
    // A poll must not move the user off page 1.
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(view.getByText(new RegExp(`${zh["explain.pageLabel"]} 1/2`))).toBeTruthy();
    view.getByRole("button", { name: zh["explain.nextPage"] }).click();
    await vi.waitFor(() => expect(view.queryByText("Api5")).not.toBeNull());
    expect(view.getAllByRole("listitem")).toHaveLength(5);
    expect(view.queryByText("Api0")).toBeNull();
    expect(view.getByTestId("ici-explain-batch-stats").textContent ?? "").toContain(`${zh["explain.jobTotal"]} 10`);
    expect(view.getByText(new RegExp(`${zh["explain.pageLabel"]} 2/2`))).toBeTruthy();
    // Polling on page 2 stays on page 2.
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(view.getByText(new RegExp(`${zh["explain.pageLabel"]} 2/2`))).toBeTruthy();
    expect(view.queryByText("Api5")).not.toBeNull();
  });

  it("keeps per-row details folded state across paging", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/status") ? new Response(JSON.stringify(batchStatus(10, { maxConcurrent: 4, inFlight: 2 }, String(input))), { status: 200 }) : new Response(JSON.stringify({ ok: false }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderRoot();
    await vi.waitFor(() => expect(view.queryByText("Api0")).not.toBeNull());
    expect(view.queryByText(/finals\/0000000000000000\.json/)).toBeNull();
    view.getAllByRole("button", { name: zh["explain.details"] })[0]!.click();
    await vi.waitFor(() => expect(view.queryByText(/finals\/0000000000000000\.json/)).not.toBeNull());
    view.getByRole("button", { name: zh["explain.nextPage"] }).click();
    await vi.waitFor(() => expect(view.queryByText("Api5")).not.toBeNull());
    view.getByRole("button", { name: zh["explain.prevPage"] }).click();
    await vi.waitFor(() => expect(view.queryByText("Api0")).not.toBeNull());
    expect(view.getAllByRole("button", { name: zh["explain.hideDetails"] }).length).toBeGreaterThan(0);
    expect(view.queryByText(/finals\/0000000000000000\.json/)).not.toBeNull();
  });

  it("validates the concurrency draft locally and never fakes a save after a storage failure", async () => {
    let settingsCalls = 0; let settingsStatus = 200; let settingsBody: unknown = { ok: true, result: { maxConcurrent: 8, inFlight: 2 } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/status")) return new Response(JSON.stringify(batchStatus(10, { maxConcurrent: 4, inFlight: 2 }, url)), { status: 200 });
      if (url.endsWith("/settings")) { settingsCalls += 1; expect(JSON.parse(String(init?.body))).toEqual({ maxConcurrent: expect.any(Number) }); return new Response(JSON.stringify(settingsBody), { status: settingsStatus }); }
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderRoot();
    await vi.waitFor(() => expect(view.queryByText("Api0")).not.toBeNull());
    const input = view.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("4");
    fireEvent.change(input, { target: { value: "0" } });
    view.getByRole("button", { name: zh["explain.concurrencyApply"] }).click();
    await vi.waitFor(() => expect(view.queryByText(zh["explain.concurrencyInvalid"])).not.toBeNull());
    expect(settingsCalls).toBe(0);
    fireEvent.change(input, { target: { value: "33" } });
    view.getByRole("button", { name: zh["explain.concurrencyApply"] }).click();
    await vi.waitFor(() => expect(view.queryByText(zh["explain.concurrencyInvalid"])).not.toBeNull());
    expect(settingsCalls).toBe(0);
    fireEvent.change(input, { target: { value: "8" } });
    view.getByRole("button", { name: zh["explain.concurrencyApply"] }).click();
    await vi.waitFor(() => expect(view.queryByText(zh["explain.concurrencySaved"])).not.toBeNull());
    expect(settingsCalls).toBe(1);
    settingsStatus = 500; settingsBody = { ok: false, error: { code: "storage-error", message: "storage-error" } };
    fireEvent.change(input, { target: { value: "9" } });
    view.getByRole("button", { name: zh["explain.concurrencyApply"] }).click();
    await vi.waitFor(() => expect(view.queryByText(zh["explain.concurrencyFailed"])).not.toBeNull());
    expect(view.queryByText(zh["explain.concurrencySaved"])).toBeNull();
    expect(settingsCalls).toBe(2);
  });
});

/** TASK-102 P2-03: card isolation probes render the toolview directly with two blocks. */
const cardBlock = (id: string) => ({ kind: "tool-result" as const, call: null, content: [{ type: "text", text: `batch=${id}` }] });
function namedBatchStatus(id: string, cap: number, url = "") {
  return {
    ok: true,
    result: {
      batch: { batchId: id, workspaceId: "ws", jobCount: 10, createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z" },
      jobs: (() => { const all = Array.from({ length: 10 }, (_, index) => ({ jobId: `${id.slice(0, 14)}${String(index).padStart(2, "0")}`, apiName: `${id}Api${index}`, status: "running" })); const sliced = paged(url, all); return sliced.jobs; })(),
      providers: [],
      scheduler: { maxConcurrent: cap, inFlight: 0 },
      page: (() => { const all = Array.from({ length: 10 }, (_, index) => ({ jobId: `${id.slice(0, 14)}${String(index).padStart(2, "0")}`, apiName: `${id}Api${index}`, status: "running" })); return paged(url, all).page; })(),
      summary: { sourceBytes: 0, promptBaseBytes: 0, maxPromptBaseBytes: 0, jobCount: 10, countsByStatus: { running: 10 } },
    },
  };
}

describe("TASK-102 P2-03 card isolation", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("switching cards during a parked settings request keeps B clean and drops A's late reply", async () => {
    const a = "1111111111111111";
    const b = "2222222222222222";
    let release!: () => void;
    let posted = false;
    let applied = false;
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/settings")) {
        posted = true;
        signal = init?.signal;
        await new Promise<void>(resolve => { release = resolve; });
        applied = true;
        return new Response(JSON.stringify({ ok: true, result: { maxConcurrent: 8, inFlight: 0 } }), { status: 200 });
      }
      const id = String(url).includes(a) ? a : b;
      return new Response(JSON.stringify(namedBatchStatus(id, applied ? 8 : 4, url)), { status: 200 });
    }));
    const t = (key: string) => key;
    const view = render(React.createElement(IciExplainToolview, { block: cardBlock(a) as never, t: t as never }));
    try {
      await vi.waitFor(() => expect(view.queryByRole("spinbutton")).not.toBeNull());
      fireEvent.click(view.getByRole("button", { name: "explain.nextPage" }));
      await vi.waitFor(() => expect(view.queryByText(`${a}Api5`)).not.toBeNull());
      fireEvent.change(view.getByRole("spinbutton"), { target: { value: "8" } });
      fireEvent.click(view.getByRole("button", { name: "explain.concurrencyApply" }));
      await vi.waitFor(() => expect(posted).toBe(true));
      expect(signal, "the settings request carries an AbortSignal").toBeDefined();
      view.rerender(React.createElement(IciExplainToolview, { block: cardBlock(b) as never, t: t as never }));
      await vi.waitFor(() => expect(view.queryByText(`${b}Api0`)).not.toBeNull());
      // B is a fresh surface: page 1, its own draft, editable.
      expect(view.queryByText(`${b}Api5`)).toBeNull();
      expect(view.queryByText(`${a}Api5`)).toBeNull();
      const input = view.getByRole("spinbutton") as HTMLInputElement;
      expect(input.value).toBe("4");
      expect(input.disabled).toBe(false);
      // A's late reply must not surface on B.
      await act(async () => { release(); });
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(view.queryByText("explain.concurrencySaved")).toBeNull();
      expect((view.getByRole("spinbutton") as HTMLInputElement).value).toBe("4");
      expect((view.getByRole("spinbutton") as HTMLInputElement).disabled).toBe(false);
    } finally {
      release();
      view.unmount();
    }
  });

  it("unmounting during a parked settings request aborts it", async () => {
    const id = "3333333333333333";
    let release!: () => void;
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/settings")) {
        signal = init?.signal;
        await new Promise<void>(resolve => { release = resolve; });
        return new Response(JSON.stringify({ ok: true, result: { maxConcurrent: 8, inFlight: 0 } }), { status: 200 });
      }
      return new Response(JSON.stringify(namedBatchStatus(id, 4, url)), { status: 200 });
    }));
    const t = (key: string) => key;
    const view = render(React.createElement(IciExplainToolview, { block: cardBlock(id) as never, t: t as never }));
    try {
      await vi.waitFor(() => expect(view.queryByRole("spinbutton")).not.toBeNull());
      fireEvent.change(view.getByRole("spinbutton"), { target: { value: "8" } });
      fireEvent.click(view.getByRole("button", { name: "explain.concurrencyApply" }));
      await vi.waitFor(() => expect(signal).toBeDefined());
      view.unmount();
      expect(signal?.aborted).toBe(true);
    } finally {
      release();
    }
  });

  it("polling never overwrites a user-edited concurrency draft", async () => {
    const id = "4444444444444444";
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/settings")) return new Response(JSON.stringify({ ok: true, result: { maxConcurrent: 6, inFlight: 0 } }), { status: 200 });
      return new Response(JSON.stringify(namedBatchStatus(id, 4, url)), { status: 200 });
    }));
    const t = (key: string) => key;
    const view = render(React.createElement(IciExplainToolview, { block: cardBlock(id) as never, t: t as never }));
    try {
      await vi.waitFor(() => expect(view.queryByRole("spinbutton")).not.toBeNull());
      expect((view.getByRole("spinbutton") as HTMLInputElement).value).toBe("4");
      fireEvent.change(view.getByRole("spinbutton"), { target: { value: "6" } });
      fireEvent.click(view.getByRole("button", { name: "explain.concurrencyApply" }));
      await vi.waitFor(() => expect((view.getByRole("spinbutton") as HTMLInputElement).value).toBe("6"));
      // A user edit after the save must survive subsequent status polls.
      fireEvent.change(view.getByRole("spinbutton"), { target: { value: "7" } });
      await new Promise(resolve => setTimeout(resolve, 1_300));
      expect((view.getByRole("spinbutton") as HTMLInputElement).value).toBe("7");
      expect((view.getByRole("spinbutton") as HTMLInputElement).disabled).toBe(false);
    } finally {
      view.unmount();
    }
  });
});


/** TASK-123: the same batch card block the other cases use (identity token + task counts). */
const blockWithQueries = () => ({ kind: "tool-result" as const, call: { argsRaw: JSON.stringify({ workspace_id: "batch", queries: ["SmallAPI", "CommonQueryInvestmentAPI"] }) }, content: [{ type: "text", text: `batch=${batchId} targets=2 unique=2 concurrency=4` }] });

describe("TASK-123 prompt budget on the task card", () => {
  beforeEach(() => { vi.stubGlobal("localStorage", { clear: () => undefined, getItem: () => null, setItem: () => undefined, removeItem: () => undefined, key: () => null, length: 0 }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const jobs = [
    { jobId: "0000000000000001", apiName: "SmallAPI", status: "awaiting-input", provider: null, model: null, promptBaseBytes: 40 * 1024, sourceBytes: 1024 },
    { jobId: "0000000000000002", apiName: "CommonQueryInvestmentAPI", status: "awaiting-input", provider: null, model: null, promptBaseBytes: 300 * 1024, sourceBytes: 1024 },
  ];
  const budgetStatus = () => ({
    ok: true,
    result: {
      batch: { batchId, workspaceId: "batch", jobCount: jobs.length, maxConcurrent: 4, requestedCount: jobs.length, selector: { kind: "queries" }, createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z" },
      jobs,
      providers: [{ id: "mvp", models: [{ id: "mvp-model", name: "MVP model" }] }],
      scheduler: { maxConcurrent: 4, inFlight: 0, taskMaxConcurrent: 4, taskInFlight: 0, hostMaxConcurrent: 4, maxPromptBytes: 256 * 1024 },
      page: { index: 1, size: 5, totalPages: 1 },
      summary: { promptBaseBytes: 340 * 1024, sourceBytes: 2048, jobCount: jobs.length, countsByStatus: { "awaiting-input": jobs.length } },
    },
  });

  it("names the oversized member, separates the numbers, and offers the skip-and-run path", async () => {
    const t = (key: string) => key;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(budgetStatus()), { status: 200 })));
    const view = render(React.createElement(IciExplainToolview, { block: blockWithQueries() as never, t: t as never }));
    try {
      // The card needs its first status poll before the confirmation surface (and the budget line) exists.
      await vi.waitFor(() => expect(view.queryByTestId("ici-explain-budget")).not.toBeNull());
      const budget = view.getByTestId("ici-explain-budget");
      expect(budget.textContent).toContain(`${t("explain.budgetMaxJob")} 300.0 KiB / 256.0 KiB`);
      expect(budget.textContent).toContain(`${t("explain.budgetBatchTotal")} 340.0 KiB`);
      expect(budget.textContent).toContain(`${t("explain.budgetEffective")} 256.0 KiB`);
      const over = view.getByTestId("ici-explain-over-budget");
      expect(over.textContent).toContain("CommonQueryInvestmentAPI");
      expect(over.textContent).toContain(t("explain.skippedTitle"));
      // The Start action is explicit about skipping the oversized member instead of blocking the batch.
      expect(view.getByRole("button", { name: new RegExp(`${t("explain.startSkippingOver")} 1`) })).toBeTruthy();
    } finally { view.unmount(); }
  });

  it("reports the scheduled/skipped split after the confirmation", async () => {
    const t = (key: string) => key;
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/confirm")) {
        calls.push({ url, body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ ok: true, result: { batchId, applied: [{ jobId: jobs[0]!.jobId, status: "scheduled", revision: 2 }], jobs: 1, status: "partial", skipped: [{ jobId: jobs[1]!.jobId, apiName: "CommonQueryInvestmentAPI", promptBaseBytes: 300 * 1024, code: "input-too-large" }], maxPromptBytes: 256 * 1024 } }), { status: 200 });
      }
      return new Response(JSON.stringify(budgetStatus()), { status: 200 });
    }));
    const view = render(React.createElement(IciExplainToolview, { block: blockWithQueries() as never, t: t as never }));
    try {
      await vi.waitFor(() => expect(view.queryByTestId("ici-explain-over-budget")).not.toBeNull());
      const startButton = view.getByRole("button", { name: new RegExp(`${t("explain.startSkippingOver")} 1`) }) as HTMLButtonElement;
      expect(startButton.disabled).toBe(false);
      fireEvent.click(startButton);
      await vi.waitFor(() => expect(calls.length).toBe(1));
      const split = await view.findByTestId("ici-explain-confirm-split");
      expect(split.textContent).toContain(`${t("explain.resultScheduled")} 1`);
      expect(split.textContent).toContain(`${t("explain.resultSkipped")} 1`);
      expect(split.textContent).toContain("CommonQueryInvestmentAPI");
    } finally { view.unmount(); }
  });
});


describe("TASK-123 default 1 MiB budget", () => {
  beforeEach(() => { vi.stubGlobal("localStorage", { clear: () => undefined, getItem: () => null, setItem: () => undefined, removeItem: () => undefined, key: () => null, length: 0 }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("lets a 372 KiB member pass under the 1 MiB default without any skip affordance", async () => {
    const t = (key: string) => key;
    const jobs = [
      { jobId: "0000000000000001", apiName: "SmallAPI", status: "awaiting-input", provider: null, model: null, promptBaseBytes: 40 * 1024, sourceBytes: 1024 },
      { jobId: "0000000000000002", apiName: "CommonQueryInvestmentAPI", status: "awaiting-input", provider: null, model: null, promptBaseBytes: 372 * 1024, sourceBytes: 1024 },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: {
        batch: { batchId, workspaceId: "batch", jobCount: 2, maxConcurrent: 4, requestedCount: 2, selector: { kind: "queries" }, createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z" },
        jobs,
        providers: [{ id: "mvp", models: [{ id: "mvp-model", name: "MVP model" }] }],
        scheduler: { maxConcurrent: 4, inFlight: 0, taskMaxConcurrent: 4, taskInFlight: 0, hostMaxConcurrent: 4, maxPromptBytes: 1024 * 1024 },
        page: { index: 1, size: 5, totalPages: 1 },
        summary: { promptBaseBytes: 412 * 1024, sourceBytes: 2048, jobCount: 2, countsByStatus: { "awaiting-input": 2 } },
      },
    }), { status: 200 })));
    const view = render(React.createElement(IciExplainToolview, { block: blockWithQueries() as never, t: t as never }));
    try {
      await vi.waitFor(() => expect(view.queryByTestId("ici-explain-budget")).not.toBeNull());
      const budget = view.getByTestId("ici-explain-budget");
      expect(budget.textContent).toContain(`${t("explain.budgetEffective")} 1.0 MiB`);
      expect(budget.textContent).toContain(`${t("explain.budgetMaxJob")} 372.0 KiB`);
      expect(view.queryByTestId("ici-explain-over-budget")).toBeNull();
      expect(view.getByRole("button", { name: t("explain.start") })).toBeTruthy();
    } finally { view.unmount(); }
  });
});
