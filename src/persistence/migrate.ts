import { MikroORM } from "@mikro-orm/postgresql";
import { databaseConfig } from "./config";

const direction = process.argv[2];
if (direction !== "up" && direction !== "down")
  throw new Error("Expected up or down");
const orm = await MikroORM.init(databaseConfig());
try {
  await orm.migrator[direction]();
} finally {
  await orm.close();
}
