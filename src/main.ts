import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { createApplication } from "./create-application";
import { OutboxPublisher } from "./outbox/outbox-publisher";
import { databaseConfig } from "./persistence/config";
import { PendingReferenceWorker } from "./wagering/pending-reference-worker";
import { WagerConsumer } from "./wagering/wager-consumer";

const orm = await MikroORM.init(databaseConfig());
let app: INestApplication | undefined;
let worker: PendingReferenceWorker | undefined;
let publisher: OutboxPublisher | undefined;
let consumer: WagerConsumer | undefined;
let closing: Promise<void> | undefined;
function close() {
  if (closing === undefined) {
    closing = (async () => {
      try {
        await consumer?.stop();
        await worker?.stop();
        await publisher?.stop();
        await app?.close();
      } finally {
        await orm.close();
      }
    })();
  }
  return closing;
}
try {
  app = await createApplication(orm);
  await app.listen(
    Number(process.env.PORT ?? "3000"),
    process.env.HOST ?? "127.0.0.1",
  );
  const pendingWorker = app.get(PendingReferenceWorker);
  worker = pendingWorker;
  pendingWorker.start();
  const outboxPublisher = app.get(OutboxPublisher);
  publisher = outboxPublisher;
  outboxPublisher.start();
  const wagerConsumer = app.get(WagerConsumer);
  consumer = wagerConsumer;
  wagerConsumer.start();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    // Sai mesmo com transação presa: o PostgreSQL desfaz o que não foi commitado.
    process.once(signal, () => {
      // orm.close() espera conexões ativas; 10 s após o prazo do consumidor, força a saída.
      setTimeout(
        () => process.exit(1),
        Number(process.env.WAGER_SHUTDOWN_DRAIN_MS ?? "20000") + 10000,
      ).unref();
      close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
  console.log(`Wallet HTTP listening at ${await app.getUrl()}`);
} catch (error) {
  await close();
  throw error;
}
