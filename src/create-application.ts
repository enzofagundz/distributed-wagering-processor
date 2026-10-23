import { NestFactory } from "@nestjs/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import { AppModule } from "./app.module";

export async function createApplication(orm: MikroORM) {
  return NestFactory.create(AppModule.register(orm), {
    logger: false,
    abortOnError: false,
  });
}
