import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures.js';
import { listUtxos, verifyLive, broadcast, recommendedFees } from '../src/provider.js';

function stub(routes, captured = []) {
  const original = global.fetch;
  global.fetch = async (url, options) => {
    captured.push({ url, options });
    const path = url.replace('https://mempool.space/api', '');
    if (!Object.hasOwn(routes, path)) throw Error(`Unexpected network access: ${url}`);
    const val = routes[path];
    return new Response(typeof val === 'string' ? val : JSON.stringify(val), { status: 200 });
  };
  return () => { global.fetch = original; };
}
function routesFor(f) {
  return {
    [`/tx/${f.source.txid}/hex`]: f.source.rawHex,
    [`/tx/${f.source.txid}`]: { txid: f.source.txid, status: { confirmed: true, block_height: 900_000 }, vin: [{ is_coinbase: false }] },
    [`/tx/${f.source.txid}/outspend/0`]: { spent: false },
  };
}

test('mainnet API validates raw bytes and unspent status without sending credentials', async () => {
  const f = fixture(), captured = [], restore = stub(routesFor(f), captured);
  try {
    const source = await verifyLive(f.info, f.source);
    assert.equal(source.value, 1_000_000n);
    assert.ok(source.verifiedAt > 0);
    assert.ok(captured.every(r => r.options.credentials === 'omit' && r.options.method === 'GET'));
    assert.ok(captured.every(r => !r.url.includes('testnet') && !r.url.includes('signet')));
  } finally { restore(); }
});

test('spent, unconfirmed, inconsistent amount and immature coinbase fail', async () => {
  const f = fixture();
  for (const failure of ['spent','unconfirmed','amount','coinbase']) {
    const routes = routesFor(f);
    if (failure === 'spent') routes[`/tx/${f.source.txid}/outspend/0`].spent = true;
    if (failure === 'unconfirmed') routes[`/tx/${f.source.txid}`].status.confirmed = false;
    if (failure === 'coinbase') { routes[`/tx/${f.source.txid}`].vin[0].is_coinbase = true; routes['/blocks/tip/height'] = '900050'; }
    const restore = stub(routes);
    try { await assert.rejects(verifyLive(f.info, failure === 'amount' ? { ...f.source, value: 1n } : f.source)); }
    finally { restore(); }
  }
});

test('UTXO list separates confirmation states and uses integer amounts', async () => {
  const f = fixture();
  const restore = stub({ [`/address/${f.info.address}/utxo`]: [
    { txid: f.source.txid, vout: 0, value: 1_000_000, status: { confirmed: true } },
    { txid: 'a'.repeat(64), vout: 1, value: 200, status: { confirmed: false } },
  ] });
  try {
    const list = await listUtxos(f.info.address);
    assert.equal(list[0].value, 1_000_000n);
    assert.equal(list[1].confirmed, false);
  } finally { restore(); }
});

test('fee recommendation bounds and returned broadcast txid', async () => {
  let restore = stub({ '/v1/fees/recommended': { halfHourFee: 501 } });
  try { await assert.rejects(recommendedFees()); } finally { restore(); }
  const captured = [];
  restore = stub({ '/tx': 'a'.repeat(64) }, captured);
  try {
    assert.equal(await broadcast('deadbeef', 'a'.repeat(64)), 'a'.repeat(64));
    assert.equal(captured[0].options.method, 'POST');
    assert.equal(captured[0].options.body, 'deadbeef');
    await assert.rejects(broadcast('deadbeef', 'b'.repeat(64)), /txid/);
  } finally { restore(); }
});
