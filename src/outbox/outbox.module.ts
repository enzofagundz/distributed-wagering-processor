import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { type DynamicModule, Module } from "@nestjs/common";
import { Metrics } from "../metrics/metrics";
import { PersistenceModule } from "../persistence/persistence.module";
import { OutboxPublisher } from "./outbox-publisher";

@Module({
  providers: [
    {
      provide: OutboxPublisher,
      useFactory: (orm: MikroORM, metrics: Metrics) =>
        new OutboxPublisher(
          orm,
          new SQSClient({
            region: process.env.AWS_REGION ?? "us-east-1",
            endpoint: process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566",
            maxAttempts: 1,
          }),
          process.env.OUTBOX_QUEUE_URL ??
            "http://127.0.0.1:4566/queue/us-east-1/000000000000/wagering-events",
          metrics,
        ),
      inject: [MikroORM, Metrics],
    },
  ],
})
export class OutboxModule {
  static register(orm?: MikroORM): DynamicModule {
    return {
      module: OutboxModule,
      imports: [PersistenceModule.register(orm)],
    };
  }
}
