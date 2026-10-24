import type { MikroORM } from "@mikro-orm/postgresql";
import type { LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

export async function createApplication(
  orm: MikroORM,
  logger: LoggerService | false = false,
) {
  return NestFactory.create(AppModule.register(orm), {
    logger,
    abortOnError: false,
  });
}
