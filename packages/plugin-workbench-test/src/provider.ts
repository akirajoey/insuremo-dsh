import type {
  WorkbenchTestRequest,
  WorkbenchTestResponse,
  WorkbenchTestService,
} from "./types.ts";

/** A deliberately side-effect-free provider used to prove bundle composition. */
export class NoopWorkbenchTestProvider implements WorkbenchTestService {
  readonly provider = "noop" as const;
  private disposed = false;

  ping(request: WorkbenchTestRequest): WorkbenchTestResponse {
    if (this.disposed) throw new Error("workbench-test provider is disposed");
    return {
      requestId: request.requestId,
      provider: this.provider,
      ok: true,
    };
  }

  dispose(): void {
    this.disposed = true;
  }
}
