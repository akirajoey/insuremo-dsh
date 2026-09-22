import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { fireEvent, render } from "@testing-library/react";
import { IciExplainToolview } from "../src/client/IciExplainToolview.tsx";
import { zh } from "../src/client/locales.ts";

/**
 * TASK-114: a task blocked by an earlier waiting card must show the blocker identity and
 * offer ONE explicit, confirmed cancel of that job — never a generic "run it again" hint,
 * and never an automatic re-issue of the user's task.
 */

const blockedJob = "0baaef1e9d5a3bab";
const blockerText = [
  "icomposer tools error: job-active — job-active: CheckCountryChangeAPI (0baaef1e9d5a3bab, awaiting-input, since 2026-09-18T02:55:23.513Z)",
  "The blocking card is an earlier explanation task that is still waiting: cancel it from this card, then run the task again. Do not just repeat the call.",
  `blocked=job-active api=CheckCountryChangeAPI old_job=${blockedJob} status=awaiting-input created=2026-09-18T02:55:23.513Z`,
].join("\n");
const block = { kind: "tool-result" as const, call: null, content: [{ type: "text", text: blockerText }] };

describe("TASK-114 blocked-task card", () => {
  beforeEach(() => { vi.stubGlobal("localStorage", { clear: () => undefined, getItem: () => null, setItem: () => undefined, removeItem: () => undefined, key: () => null, length: 0 }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("names the blocking card instead of showing a generic retry hint", () => {
    const t = (key: string) => key;
    const view = render(React.createElement(IciExplainToolview, { block: block as never, t: t as never }));
    try {
      expect(view.getByTestId("ici-explain-prepare-failed").textContent).toContain("job-active");
      const row = view.getByTestId(`ici-explain-blocker-${blockedJob}`);
      expect(row.textContent).toContain("CheckCountryChangeAPI");
      expect(row.textContent).toContain("awaiting-input");
      expect(row.textContent).toContain(blockedJob);
      expect(view.getByTestId("ici-explain-blocked-intro")).toBeTruthy();
      // The misleading generic hint ("this call created no task card: run ici_explain again")
      // must not appear for a blocked task: repeating the call would fail identically.
      expect(view.queryByText(zh["explain.prepareFailedHint"])).toBeNull();
      expect(view.getByRole("button", { name: t("explain.blockedCancelAction") })).toBeTruthy();
    } finally { view.unmount(); }
  });

  it("asks for confirmation, then cancels exactly one job through the gated route", async () => {
    const t = (key: string) => key;
    const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; credentials?: string; body?: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, headers: init?.headers as Record<string, string>, credentials: init?.credentials, body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ ok: true, result: { jobId: blockedJob, apiName: "CheckCountryChangeAPI", status: "cancelled", alreadyCancelled: false } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(React.createElement(IciExplainToolview, { block: block as never, t: t as never }));
    try {
      // Opening the confirmation must not perform any request yet.
      fireEvent.click(view.getByRole("button", { name: t("explain.blockedCancelAction") }));
      const dialog = view.getByTestId("ici-explain-blocked-confirm");
      expect(dialog.textContent).toContain("CheckCountryChangeAPI");
      expect(dialog.textContent).toContain(blockedJob);
      expect(calls.length).toBe(0);

      fireEvent.click(view.getByRole("button", { name: t("explain.blockedConfirmYes") }));
      await vi.waitFor(() => expect(calls.length).toBe(1));
      const call = calls[0]!;
      expect(call.url).toBe(`/api/icomposer-workbench/ici/explain/jobs/${blockedJob}/cancel`);
      expect(call.method).toBe("POST");
      expect(call.headers?.["X-Workbench-Action"]).toBe("1");
      expect(call.credentials).toBe("same-origin");
      // Success is reported in the card, and the task itself is never re-issued.
      expect((await view.findByText(t("explain.blockedCancelled"))).textContent).toContain(t("explain.blockedCancelled"));
      expect(view.getByText(t("explain.blockedRetryHint"))).toBeTruthy();
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(calls.length).toBe(1, "the card must not start the task again on its own");
    } finally { view.unmount(); }
  });

  it("reports a finished blocker without pretending to cancel it", async () => {
    const t = (key: string) => key;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: { code: "revision-conflict", message: "revision-conflict" } }), { status: 409 })));
    const view = render(React.createElement(IciExplainToolview, { block: block as never, t: t as never }));
    try {
      fireEvent.click(view.getByRole("button", { name: t("explain.blockedCancelAction") }));
      fireEvent.click(view.getByRole("button", { name: t("explain.blockedConfirmYes") }));
      expect((await view.findByText(t("explain.blockedGone"))).textContent).toContain(t("explain.blockedGone"));
    } finally { view.unmount(); }
  });
});


describe("TASK-114 member conflicts are never cancellable from this card", () => {
  beforeEach(() => { vi.stubGlobal("localStorage", { clear: () => undefined, getItem: () => null, setItem: () => undefined, removeItem: () => undefined, key: () => null, length: 0 }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const memberBlock = {
    kind: "tool-result" as const,
    call: null,
    content: [{ type: "text", text: [
      "icomposer tools error: job-active — job-active: 1 target already belong to another task card (handle them in that card: confirm or cancel)",
      "Some of these APIs already belong to another task card: open that card and confirm or cancel it there — this card cannot cancel its members.",
      "member_conflict=1",
    ].join("\n") }],
  };

  it("shows the pointer to the owning card and offers no cancel button", () => {
    const t = (key: string) => key;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => { calls.push(String(input)); return new Response(JSON.stringify({ ok: false }), { status: 404 }); }));
    const view = render(React.createElement(IciExplainToolview, { block: memberBlock as never, t: t as never }));
    try {
      expect(view.getByTestId("ici-explain-member-conflicts").textContent).toContain(t("explain.memberConflictIntro"));
      expect(view.getByTestId("ici-explain-member-conflicts").textContent).toContain("1");
      // No blocker row, no cancel affordance for a member of another task.
      expect(view.queryByRole("button", { name: t("explain.blockedCancelAction") })).toBeNull();
      expect(view.queryByTestId("ici-explain-blocked-confirm")).toBeNull();
      expect(calls.length).toBe(0, "no request is made for a member conflict");
    } finally { view.unmount(); }
  });
});


describe("TASK-116 batch cancel of legacy blockers", () => {
  beforeEach(() => { vi.stubGlobal("localStorage", { clear: () => undefined, getItem: () => null, setItem: () => undefined, removeItem: () => undefined, key: () => null, length: 0 }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const listed = Array.from({ length: 5 }, (_, index) => `blocked=job-active api=Api${index} old_job=${String(index + 1).repeat(16).slice(0, 16)} status=awaiting-input created=2026-09-18T02:55:23.513Z`);
  const batchBlock = (argsRaw: string) => ({
    kind: "tool-result" as const,
    call: { argsRaw },
    content: [{ type: "text", text: [
      "icomposer tools error: job-active — job-active: 5 cards (…)",
      "The blocking card is an earlier explanation task that is still waiting: cancel it from this card, then run the task again. Do not just repeat the call.",
      ...listed,
      "blocked_more=58",
    ].join("\n") }],
  });

  it("offers one batch action for the whole 63-card scope and confirms the exact total", async () => {
    const t = (key: string) => key;
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      if (String(input).includes("/blocked-cancel")) return new Response(JSON.stringify({ ok: true, result: { requested: 63, cancelled: 62, alreadyCancelled: 0, failed: [{ jobId: "0000000000000009", apiName: "Api8", code: "revision-conflict" }], failedMore: 0, chunks: 4, recomputedTargets: 63, unresolved: 0, memberConflicts: 0, audit: { requestId: "ici-explain-jobs-cancel:abcdef0123456789", id: "op-1", decision: "approved" } } }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(React.createElement(IciExplainToolview, { block: batchBlock(JSON.stringify({ workspace_id: "ws", all: true })) as never, t: t as never }));
    try {
      const batch = view.getByTestId("ici-explain-cancel-all");
      expect(batch.textContent).toContain("63");
      // One explicit confirmation naming the legacy scope and the exact total.
      fireEvent.click(batch);
      const dialog = view.getByTestId("ici-explain-cancel-all-confirm");
      expect(dialog.textContent).toContain(t("explain.blockedBatchConfirmTitle").replace("{}", "63"));
      expect(calls.length).toBe(0, "opening the confirmation performs no request");
      fireEvent.click(view.getByRole("button", { name: t("explain.blockedBatchConfirmYes") }));
      await vi.waitFor(() => expect(calls.length).toBe(1));
      expect(calls[0]!.url).toBe("/api/icomposer-workbench/ici/explain/blocked-cancel");
      expect(JSON.parse(calls[0]!.body!)).toEqual({ workspace_id: "ws", selector: { kind: "all" } });
      // Honest partial result: counts, the failing job, and a way to retry the remainder.
      const result = await view.findByTestId("ici-explain-batch-result");
      expect(result.textContent).toContain("62");
      expect(result.textContent).toContain("0000000000000009");
      expect(result.textContent).toContain("revision-conflict");
      fireEvent.click(view.getByRole("button", { name: t("explain.blockedBatchRetryRemaining") }));
      await vi.waitFor(() => expect(calls.length).toBe(2), { timeout: 2000 });
      expect(calls[1]!.url).toBe("/api/icomposer-workbench/ici/explain/blocked-cancel");
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(calls.length).toBe(2, "the task itself is never re-issued automatically");
    } finally { view.unmount(); }
  });

  it("falls back to per-card cancellation when the call carries no selector", () => {
    const t = (key: string) => key;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })));
    const view = render(React.createElement(IciExplainToolview, { block: batchBlock(JSON.stringify({ workspace_id: "ws" })) as never, t: t as never }));
    try {
      expect(view.queryByTestId("ici-explain-cancel-all")).toBeNull();
      expect(view.getByText(t("explain.blockedNoSelector"))).toBeTruthy();
      expect(view.getAllByRole("button", { name: t("explain.blockedCancelAction") })).toHaveLength(5);
    } finally { view.unmount(); }
  });
});


describe("TASK-119 ambiguous target resolution hint", () => {
  it("asks for the exact API name instead of the generic retry hint", () => {
    const t = (key: string) => key;
    const block = { kind: "tool-result" as const, call: null, content: [{ type: "text", text: "icomposer tools error: ambiguous-target — no exact api name matched (a substring is not enough); use the full API name: AddRider; candidates: api:AddRiderAPI_NONILP, api:QuoteAddRiderAPI_NONILP" }] };
    const view = render(React.createElement(IciExplainToolview, { block: block as never, t: t as never }));
    try {
      expect(view.getByTestId("ici-explain-prepare-failed").textContent).toContain("ambiguous-target");
      expect(view.getByTestId("ici-explain-full-name-hint").textContent).toContain(t("explain.useFullApiName"));
      expect(view.queryByText(t("explain.prepareFailedHint"))).toBeNull();
    } finally { view.unmount(); }
  });
});
