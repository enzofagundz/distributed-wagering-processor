import type { MikroORM } from "@mikro-orm/postgresql";
import type { LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import type { AuthConfig } from "./auth/auth.module";

export async function createApplication(
  orm: MikroORM,
  logger: LoggerService | false = false,
  // Sem config, sem guard: main.ts sempre passa a do ambiente.
  auth?: AuthConfig,
) {
  return NestFactory.create(AppModule.register(orm, auth), {
    logger,
    abortOnError: false,
  });
}
