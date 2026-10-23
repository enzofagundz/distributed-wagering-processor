import { MikroORM } from '@mikro-orm/postgresql';
import { createApplication } from '../../../src/create-application';
import { databaseConfig } from '../../../src/persistence/config';
import { WageringService, type SubmitBetInput } from '../../../src/wagering/wagering-service';

const url = process.env.DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Concurrency fixture requires a dedicated _test database');
const orm = await MikroORM.init(databaseConfig(url));
const app = await createApplication(orm);
const service = app.get(WageringService);
process.on('message', async (message: { id: string; input: SubmitBetInput }) => {
  try {
    process.send!({ id: message.id, result: await service.submit(message.input) });
  } catch (error) {
    process.send!({ id: message.id, error: String(error) });
  }
});
process.once('SIGTERM', async () => {
  await app.close();
  await orm.close();
  process.disconnect!();
});
await app.listen(0, '127.0.0.1');
process.send!({ base: await app.getUrl() });
