import { browserFixture } from './fixtures.js';
import { buildPlan, verifySigned } from '../src/core.js';
import { fixture } from './fixtures.js';
import { writeFileSync } from 'node:fs';

const result = {};
for (const type of ['p2tr', 'p2wpkh']) {
  const f = browserFixture(type);
  const plan = buildPlan({ ...fixture(type), count: 20, rate: '2' });
  f.signedTxid = verifySigned(plan, f.signedPsbt).txid;
  result[type] = f;
}
writeFileSync('/tmp/btc-splitter-browser-fixtures.json', JSON.stringify(result));
