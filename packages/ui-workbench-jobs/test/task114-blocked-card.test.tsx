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
