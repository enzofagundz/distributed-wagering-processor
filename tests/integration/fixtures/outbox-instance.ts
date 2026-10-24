import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Logger } from "@nestjs/common";
import { OutboxPublisher } from "../../../src/outbox/outbox-publisher";
import { databaseConfig } from "../../../src/persistence/config";

const url = process.env.DATABASE_URL;
const schema = process.env.OUTBOX_TEST_SCHEMA;
if (
  !url ||
  !new URL(url).pathname.endsWith("_test") ||
  !schema?.match(/^outbox_[a-f0-9]+$/)
)
  throw new Error(
    "Outbox fixture requires an isolated test schema and database",
  );
// O teste lê sinais no stdout; logs do publisher ali quebrariam o protocolo.
Logger.overrideLogger(false);
const orm = await MikroORM.init({
  ...databaseConfig(url),
  schema,
  driverOptions: { connection: { options: `-c search_path=${schema}` } },
});
const client = new SQSClient({
  endpoint: process.env.TEST_SQS_ENDPOINT ?? "http://127.0.0.1:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  maxAttempts: 1,
});
if (process.env.OUTBOX_GATE === "true") {
  let gated = false;
  client.middlewareStack.add(
    (next) => async (args) => {
      const result = await next(args);
      if (!gated) {
        gated = true;
        console.log("sent");
        await Bun.stdin.stream().getReader().read();
      }
      return result;
    },
    { step: "initialize", name: "pauseAfterAcceptedSend" },
  );
}
if (process.env.OUTBOX_HOLD !== "true")
  await new OutboxPublisher(
    orm,
    client,
    process.env.OUTBOX_QUEUE_URL!,
  ).runOnce();
console.log("ready");
setInterval(() => {}, 1000);
