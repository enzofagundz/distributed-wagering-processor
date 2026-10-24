import { Logger } from "@nestjs/common";
import type {
  PendingReferenceBatch,
  PendingReferenceBatchRunner,
} from "./pending-reference-batch-runner";

export interface PendingReferenceWorkerOptions {
  intervalMs?: number;
  pageSize?: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

export class PendingReferenceWorker {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private readonly intervalMs: number;
  private readonly pageSize: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly batch: PendingReferenceBatchRunner,
    options: PendingReferenceWorkerOptions = {},
  ) {
    this.intervalMs = positiveInteger(options.intervalMs, 1000);
    this.pageSize = positiveInteger(options.pageSize, 100);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  runOnce(at?: Date): Promise<PendingReferenceBatch> {
    return this.batch.run(this.pageSize, at);
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.tick().finally(() => {
        this.running = undefined;
        if (!this.stopped) this.schedule();
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      const summary = await this.runOnce();
      if (
        summary.processed > 0 ||
        summary.rejected > 0 ||
        summary.terminalFailures > 0
      )
        this.logger.log({ event: "PendingReferenceResolved", ...summary });
      if (summary.failed > 0)
        this.logger.warn({
          event: "PendingReferenceResolutionFailed",
          ...summary,
        });
    } catch (error) {
      this.logger.error({
        event: "PendingReferenceWorkerFailed",
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}
