import { Module, type DynamicModule } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { SQSClient } from "@aws-sdk/client-sqs";
import { PersistenceModule } from "../persistence/persistence.module";
import { OutboxPublisher } from "./outbox-publisher";

@Module({
  providers: [
    {
      provide: OutboxPublisher,
      useFactory: (orm: MikroORM) =>
        new OutboxPublisher(
          orm,
          new SQSClient({
            region: process.env.AWS_REGION ?? "us-east-1",
            endpoint: process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566",
            maxAttempts: 1,
          }),
          process.env.OUTBOX_QUEUE_URL ??
            "http://127.0.0.1:4566/queue/us-east-1/000000000000/wagering-events",
        ),
      inject: [MikroORM],
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
