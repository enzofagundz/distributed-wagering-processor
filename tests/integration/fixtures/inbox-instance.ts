import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { databaseConfig } from "../../../src/persistence/config";
import { WagerConsumer } from "../../../src/wagering/wager-consumer";
import { WageringInbox } from "../../../src/wagering/wagering-inbox";
import { WageringService } from "../../../src/wagering/wagering-service";

const url = process.env.DATABASE_URL;
const schema = process.env.INBOX_TEST_SCHEMA;
if (
  !url ||
  !new URL(url).pathname.endsWith("_test") ||
  !schema?.match(/^inbox_[a-f0-9]+$/)
)
  throw new Error(
    "Inbox fixture requires an isolated test database and schema",
  );
const orm = await MikroORM.init({
  ...databaseConfig(url),
  schema,
  driverOptions: { connection: { options: `-c search_path=${schema}` } },
});
const sqs = new SQSClient({
  endpoint: process.env.TEST_SQS_ENDPOINT ?? "http://127.0.0.1:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  maxAttempts: 1,
});
sqs.middlewareStack.add(
  (next, context) => async (args) => {
    if (
      context.commandName === "DeleteMessageCommand" &&
      process.env.INBOX_PAUSE_ACK === "true"
    ) {
      console.log("committed-before-ack");
      await Bun.stdin.stream().getReader().read();
    }
    return next(args);
  },
  { step: "initialize", name: "pauseBeforeAck" },
);
const consumer = new WagerConsumer(
  new WageringService(orm, new WageringInbox()),
  sqs,
  process.env.WAGER_QUEUE_URL!,
  process.env.WAGER_DLQ_URL!,
);
if (process.env.INBOX_START === "true") {
  consumer.start();
  console.log("started");
  process.once("SIGTERM", async () => {
    await consumer.stop();
    await orm.close();
    sqs.destroy();
    console.log("stopped");
    process.exit(0);
  });
} else {
  await consumer.runOnce();
  await orm.close();
  sqs.destroy();
}
