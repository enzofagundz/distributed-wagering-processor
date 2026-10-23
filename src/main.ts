import type { INestApplication } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { createApplication } from "./create-application";
import { databaseConfig } from "./persistence/config";

const orm = await MikroORM.init(databaseConfig());
let app: INestApplication | undefined;
let closing: Promise<void> | undefined;
function close() {
  return (closing ??= (async () => {
    try {
      await app?.close();
    } finally {
      await orm.close();
    }
  })());
}
try {
  app = await createApplication(orm);
  await app.listen(
    Number(process.env.PORT ?? "3000"),
    process.env.HOST ?? "127.0.0.1",
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, close);
  }
  console.log(`Wallet HTTP listening at ${await app.getUrl()}`);
} catch (error) {
  await close();
  throw error;
}
