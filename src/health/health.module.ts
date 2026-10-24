import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { type DynamicModule, Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { HealthChecks, HealthController } from "./health.controller";

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: HealthChecks,
      useFactory: (orm: MikroORM) =>
        new HealthChecks(
          orm,
          new SQSClient({
            region: process.env.AWS_REGION ?? "us-east-1",
            endpoint: process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566",
            maxAttempts: 1,
          }),
          [
            process.env.WAGER_QUEUE_URL ??
              "http://127.0.0.1:4566/queue/us-east-1/000000000000/wager-transactions.fifo",
            process.env.OUTBOX_QUEUE_URL ??
              "http://127.0.0.1:4566/queue/us-east-1/000000000000/wagering-events",
          ],
          Number(process.env.HEALTH_TIMEOUT_MS ?? "2000"),
        ),
      inject: [MikroORM],
    },
  ],
})
export class HealthModule {
  static register(orm?: MikroORM): DynamicModule {
    return {
      module: HealthModule,
      imports: [PersistenceModule.register(orm)],
    };
  }
}
