import { Logger } from "@nestjs/common";
import type { FilterQuery } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  wagerTransactionSchema,
  type WagerTransactionRecord,
} from "../persistence/wager-transaction-record";
import { WageringService } from "./wagering-service";

export interface PendingReferenceBatch {
  scanned: number;
  processed: number;
  rejected: number;
  pending: number;
  skipped: number;
  failed: number;
}

export class PendingReferenceBatchRunner {
  private readonly logger = new Logger(WageringService.name);

  constructor(
    private readonly orm: MikroORM,
    private readonly wagering: WageringService,
  ) {}

  async run(pageSize = 100, at?: Date): Promise<PendingReferenceBatch> {
    const dueAt = at ?? new Date();
    const summary: PendingReferenceBatch = {
      scanned: 0,
      processed: 0,
      rejected: 0,
      pending: 0,
      skipped: 0,
      failed: 0,
    };
    let cursor: string | undefined;
    for (;;) {
      const where: FilterQuery<WagerTransactionRecord> = {
        status: "PENDING_REFERENCE",
        referenceNextAttemptAt: { $lte: dueAt },
        ...(cursor === undefined ? {} : { id: { $gt: cursor } }),
      };
      const page = await this.orm.em
        .fork()
        .find(wagerTransactionSchema, where, {
          orderBy: { id: "ASC" },
          limit: pageSize,
        });
      if (page.length === 0) break;
      cursor = page[page.length - 1]!.id;
      for (const candidate of page) {
        summary.scanned++;
        try {
          const status = await this.wagering.resolvePendingReference(
            candidate.id,
            at,
          );
          if (status === "PROCESSED") summary.processed++;
          else if (status === "REJECTED") summary.rejected++;
          else if (status === "PENDING_REFERENCE") summary.pending++;
          else summary.skipped++;
        } catch (error) {
          summary.failed++;
          this.logger.warn(
            JSON.stringify({
              event: "PendingReferenceResolutionFailed",
              transactionId: candidate.id,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      if (page.length < pageSize) break;
    }
    return summary;
  }
}
