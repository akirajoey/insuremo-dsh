/** Stable service name used by the Workbench host test plugin. */
export const WORKBENCH_TEST_SERVICE = "workbenchTest" as const;

/** Stable event emitted after the no-op provider is registered. */
export const WORKBENCH_TEST_READY_EVENT = "workbench-test/ready" as const;

/** Request accepted by the test provider's method surface. */
export interface WorkbenchTestRequest {
  requestId: string;
}

/** Canonical response returned by the test provider. */
export interface WorkbenchTestResponse {
  requestId: string;
  provider: "noop";
  ok: true;
}

/** Payload emitted with {@link WORKBENCH_TEST_READY_EVENT}. */
export interface WorkbenchTestReadyEvent {
  provider: "noop";
}

/** Event map owned by this Service Definition. */
export interface WorkbenchTestEvents {
  [WORKBENCH_TEST_READY_EVENT](event: WorkbenchTestReadyEvent): void;
}

/** Host-facing Service Definition: one method and one event are enough for the smoke plugin. */
export interface WorkbenchTestService {
  readonly provider: "noop";
  ping(request: WorkbenchTestRequest): WorkbenchTestResponse;
}

/** Minimal structural host context needed by the provider; no UI or React dependency. */
export interface WorkbenchHostContext {
  provide(name: typeof WORKBENCH_TEST_SERVICE, value: WorkbenchTestService): () => void;
  emit(name: typeof WORKBENCH_TEST_READY_EVENT, event: WorkbenchTestReadyEvent): void;
  effect(
    setup: () => void | (() => void | Promise<void>),
    label?: string,
  ): unknown;
}
