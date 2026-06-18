import Stripe from 'stripe';
import { env } from '../src/config/env';

// Seeds real Stripe test-mode charges. This account is in India, where the legacy
// Charges API is disabled and cards require authentication — so we use the
// supported PaymentIntents flow with off_session + a customer that has a
// name/address + a description (all required by India export rules). The result
// is genuine succeeded charges that `charges.list` returns for both the sync
// pipeline (Problem 1) and the metrics seed (Problem 2). Idempotency keys make
// re-runs safe (no duplicate charges).
const key = env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('STRIPE_SECRET_KEY not set');
  process.exit(1);
}
const stripe = new Stripe(key);

const ADDRESS = {
  line1: '1 Market St',
  city: 'San Francisco',
  state: 'CA',
  postal_code: '94105',
  country: 'US',
} as const;

const PLAN = [
  { name: 'Alice Nguyen', email: 'alice.withremote@example.com', amount: 4999, pm: 'pm_card_visa', desc: 'Pro plan — monthly' },
  { name: 'Bob Martinez', email: 'bob.withremote@example.com', amount: 12000, pm: 'pm_card_visa', desc: 'Team seats x4' },
  { name: 'Chitra Rao', email: 'chitra.withremote@example.com', amount: 2500, pm: 'pm_card_visa', desc: 'Usage add-on' },
  { name: 'Diego Santos', email: 'diego.withremote@example.com', amount: 7800, pm: 'pm_card_visa', desc: 'Annual upgrade' },
  { name: 'Emiko Tan', email: 'emiko.withremote@example.com', amount: 1500, pm: 'pm_card_chargeDeclined', desc: 'Declined payment' },
];

let succeeded = 0;
let failed = 0;
for (const [i, p] of PLAN.entries()) {
  const customer = await stripe.customers.create(
    { name: p.name, email: p.email, address: { ...ADDRESS } },
    { idempotencyKey: `wr-cus-${i}` },
  );
  try {
    const pi = await stripe.paymentIntents.create(
      {
        amount: p.amount,
        currency: 'usd',
        customer: customer.id,
        payment_method: p.pm,
        confirm: true,
        off_session: true,
        payment_method_types: ['card'],
        description: p.desc,
      },
      { idempotencyKey: `wr-pi-${i}` },
    );
    succeeded++;
    console.log('charge', pi.latest_charge, pi.status, `$${(p.amount / 100).toFixed(2)}`, p.desc);
  } catch (err) {
    const e = err as Stripe.errors.StripeError & { payment_intent?: Stripe.PaymentIntent };
    const charge = e.payment_intent?.latest_charge ?? '(no charge)';
    failed++;
    console.log('declined', charge, e.code, p.desc);
  }
}
console.log(`\n[seed-stripe] succeeded=${succeeded} declined=${failed}`);
