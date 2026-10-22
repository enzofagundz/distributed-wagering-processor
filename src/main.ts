import { MikroORM } from '@mikro-orm/postgresql';
import { createApplication } from './app';
import { databaseConfig } from './persistence/config';

const orm = await MikroORM.init(databaseConfig());
try {
  const app = await createApplication(orm);
  await app.listen(Number(process.env.PORT ?? '3000'), process.env.HOST ?? '127.0.0.1');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      await app.close();
      await orm.close();
    });
  }
  console.log(`Wallet HTTP listening at ${await app.getUrl()}`);
} catch (error) {
  await orm.close();
  throw error;
}
