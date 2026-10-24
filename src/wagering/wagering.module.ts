import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { type DynamicModule, Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { PendingReferenceBatchRunner } from "./pending-reference-batch-runner";
import { PendingReferenceWorker } from "./pending-reference-worker";
import { WagerConsumer } from "./wager-consumer";
import { WageringController } from "./wagering.controller";
import { WageringInbox } from "./wagering-inbox";
import { WageringQueries } from "./wagering-queries";
import { WageringService } from "./wagering-service";

@Module({
  controllers: [WageringController],
  providers: [
    WageringInbox,
    {
      provide: WageringQueries,
      useFactory: (orm: MikroORM) => new WageringQueries(orm),
      inject: [MikroORM],
    },
    {
      provide: WagerConsumer,
      useFactory: (wagering: WageringService) =>
        new WagerConsumer(
          wagering,
          new SQSClient({
            region: process.env.AWS_REGION ?? "us-east-1",
            endpoint: process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566",
            maxAttempts: 1,
          }),
          process.env.WAGER_QUEUE_URL ??
            "http://127.0.0.1:4566/queue/us-east-1/000000000000/wager-transactions.fifo",
          process.env.WAGER_DLQ_URL ??
            "http://127.0.0.1:4566/queue/us-east-1/000000000000/wager-transactions-dlq.fifo",
        ),
      inject: [WageringService],
    },
    {
      provide: WageringService,
      useFactory: (orm: MikroORM, inbox: WageringInbox) =>
        new WageringService(orm, inbox),
      inject: [MikroORM, WageringInbox],
    },
    {
      provide: PendingReferenceBatchRunner,
      useFactory: (orm: MikroORM, wagering: WageringService) =>
        new PendingReferenceBatchRunner(orm, wagering),
      inject: [MikroORM, WageringService],
    },
    {
      provide: PendingReferenceWorker,
      useFactory: (batch: PendingReferenceBatchRunner) =>
        new PendingReferenceWorker(batch, {
          intervalMs: Number(process.env.PENDING_REFERENCE_INTERVAL_MS),
          pageSize: Number(process.env.PENDING_REFERENCE_PAGE_SIZE),
        }),
      inject: [PendingReferenceBatchRunner],
    },
  ],
})
export class WageringModule {
  static register(orm?: MikroORM): DynamicModule {
    return {
      module: WageringModule,
      imports: [PersistenceModule.register(orm)],
    };
  }
}
