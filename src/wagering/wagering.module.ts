import { SQSClient } from "@aws-sdk/client-sqs";
import { WagerConsumer } from "./wager-consumer";
import { Module, type DynamicModule } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { PersistenceModule } from "../persistence/persistence.module";
import { WageringController } from "./wagering.controller";
import { WageringService } from "./wagering-service";
import { PendingReferenceWorker } from "./pending-reference-worker";

@Module({
  controllers: [WageringController],
  providers: [
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
      useFactory: (orm: MikroORM) => new WageringService(orm),
      inject: [MikroORM],
    },
    {
      provide: PendingReferenceWorker,
      useFactory: (wagering: WageringService) =>
        new PendingReferenceWorker(wagering, {
          intervalMs: Number(process.env.PENDING_REFERENCE_INTERVAL_MS),
          pageSize: Number(process.env.PENDING_REFERENCE_PAGE_SIZE),
        }),
      inject: [WageringService],
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
