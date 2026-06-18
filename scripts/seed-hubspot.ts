import { Client } from '@hubspot/api-client';
import { env } from '../src/config/env';

// Seeds a handful of real contacts into your HubSpot account so the live
// `/sync/run` pulls genuine CRM data. Idempotent: HubSpot dedupes by email, so
// re-running skips contacts that already exist (409).
const token = env.HUBSPOT_PRIVATE_APP_TOKEN;
if (!token) {
  console.error('HUBSPOT_PRIVATE_APP_TOKEN not set');
  process.exit(1);
}

const client = new Client({ accessToken: token });

const CONTACTS = [
  { firstname: 'Alice', lastname: 'Nguyen', email: 'alice.withremote@example.com' },
  { firstname: 'Bob', lastname: 'Martinez', email: 'bob.withremote@example.com' },
  { firstname: 'Chitra', lastname: 'Rao', email: 'chitra.withremote@example.com' },
  { firstname: 'Diego', lastname: 'Santos', email: 'diego.withremote@example.com' },
  { firstname: 'Emiko', lastname: 'Tan', email: 'emiko.withremote@example.com' },
];

let created = 0;
let existed = 0;
for (const c of CONTACTS) {
  try {
    const res = await client.crm.contacts.basicApi.create({ properties: c, associations: [] });
    created++;
    console.log('created', res.id, c.email);
  } catch (err) {
    if ((err as { code?: number }).code === 409) {
      existed++;
      console.log('exists ', c.email);
    } else {
      console.error('failed ', c.email, (err as Error).message);
    }
  }
}
console.log(`\n[seed-hubspot] created=${created} alreadyExisted=${existed}`);
