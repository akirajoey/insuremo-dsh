import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import {
  SlotTestRuntime,
  usePinnedBrowserLanguages,
} from "@deepseek-ai/dsh-client-test-runtime";
import type { JobView } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import { apply, inject, NS } from "../src/client/index.ts";
import { en, zh } from "../src/client/locales.ts";
import {
  projectJobView,
  type WorkbenchJobData,
  type WorkbenchJobStatus,
} from "../src/client/job-data.ts";

usePinnedBrowserLanguages("zh-CN");

type TestNode = {
  key: string;
  kind: "workbench-job";
  id: string;
  target: "chat";
  anchorSeq: number;
  location: { kind: "session" };
  visibility: "visible";
  data: WorkbenchJobData;
};

function node(status: WorkbenchJobStatus): TestNode {
  return {
    key: "job-node:job-1",
    kind: "workbench-job",
    id: "job-1",
    target: "chat",
    anchorSeq: 1,
    location: { kind: "session" },
    visibility: "visible",
    data: {
      jobId: "job-1",
      kindLabel: "Graph build",
      status,
      progressDigest: "digest:42",
    },
  };
}

describe("Workbench job conversation node", () => {
  let runtime: SlotTestRuntime;
  let locale: LocaleRuntime;
  let feature: Awaited<ReturnType<SlotTestRuntime["mount"]>>;
  let currentNode: TestNode = node("running");

  beforeEach(async () => {
    currentNode = node("running");
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
    locale = new LocaleRuntime(runtime.ctx);
    runtime.ctx.provide("locale", locale);
    runtime.slots.installLocale(locale);

    // The production ui-conversation entry declares this keyed session slot.
    // This test frame keeps the same keyed dispatch while using a root scope,
    // so it can focus on this package's renderer without inventing a session.
    const Frame = ({ renderSlot }: {
      renderSlot: (key: string, owner: unknown, options: unknown) => ReactNode;
    }) => renderSlot(
      "conversation.chat.node",
      { node: currentNode },
      { entryKey: "workbench-job", hookContext: "job-test" },
    );
    await runtime.root.declare({
      "conversation.chat.node": { kind: "keyed", scope: "root" },
    } as never, Frame as never);

    feature = await runtime.mount({ inject, apply });
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  it("dispatches the workbench-job key and renders a digest-only row", () => {
    const entry = runtime.slots.entries("conversation.chat.node")[0];
    expect(entry?.options.key).toBe("workbench-job");
    expect(entry?.locale).toBe(NS);

    const view = runtime.renderRoot();
    expect(view.getByText("Graph build")).toBeTruthy();
    expect(view.getByRole("status", { name: zh["status.running"] })).toBeTruthy();
    expect(view.getByText("digest:42")).toBeTruthy();
  });

  it("renders queued, running, done, and failed status badges", () => {
    const expected = {
      queued: zh["status.queued"],
      running: zh["status.running"],
      done: zh["status.done"],
      failed: zh["status.failed"],
    } as const;

    for (const status of Object.keys(expected) as WorkbenchJobStatus[]) {
      currentNode = node(status);
      const view = runtime.renderRoot();
      expect(view.getByRole("status", { name: expected[status] })).toBeTruthy();
      view.unmount();
    }
  });

  it("uses localized Chinese and English status copy", async () => {
    const view = runtime.renderRoot();
    expect(view.getByRole("status", { name: zh["status.running"] })).toBeTruthy();

    locale.setLocale("en");
    await runtime.flush();
    expect(view.getByRole("status", { name: en["status.running"] })).toBeTruthy();
  });

  it("projects the Harness jobs mirror and unregisters on disposal", async () => {
    const job = {
      id: "graph-7",
      kind: "graph-build",
      label: "Graph build",
      status: "completed",
    } as JobView;
    expect(projectJobView(job)).toMatchObject({
      jobId: "graph-7",
      kindLabel: "Graph build",
      status: "done",
    });

    expect(runtime.slots.entries("conversation.chat.node")).toHaveLength(1);
    await feature.dispose();
    expect(runtime.slots.entries("conversation.chat.node")).toHaveLength(0);
  });
});
