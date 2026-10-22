import test from 'node:test';
import assert from 'node:assert/strict';
import { Psbt, payments, networks, Transaction } from 'bitcoinjs-lib';
import { fixture, signedPlan, TEST_PUB } from './fixtures.js';
import { buildPlan, verifySigned, walletInfo, verifyParent, previewSplit, parseRate, satoshi, formatBTC, hex, planSummary, parsePsbt, bytes } from '../src/core.js';

for (const type of ['p2wpkh', 'p2tr']) {
  for (const count of [2, 10, 20, 50, 200]) {
    test(`${type} ${count} outputs: value conservation, PSBT and actual signature`, () => {
      const plan = buildPlan({ ...fixture(type), count, rate: '2' });
      assert.equal(plan.amounts.length, count);
      assert.equal(plan.amounts.reduce((a, b) => a + b, 0n) + plan.fee, 1_000_000n);
      assert.ok(plan.amounts[0] - plan.amounts.at(-1) <= 1n);
      assert.ok(plan.amounts.every(v => v >= 1000n));
      const psbt = Psbt.fromHex(plan.psbtHex);
      assert.equal(psbt.inputCount, 1);
      assert.equal(psbt.txOutputs.length, count);
      assert.ok(psbt.txOutputs.every(out => hex(out.script) === hex(plan.info.script)));
      const signed = signedPlan(plan).toHex();
      const checked = verifySigned(plan, signed);
      assert.equal(checked.outputs.length, count);
      assert.equal(checked.fee, plan.fee);
      assert.ok(checked.vsize <= plan.estimatedVsize);
      assert.equal(planSummary(plan, checked).signedTxid, checked.txid);
      assert.equal(parsePsbt(psbt.toBase64()).toHex(), plan.psbtHex);
    });
  }
}

test('0.01 BTC Taproot exact examples: 10 and 20', () => {
  const ten = previewSplit({ value: 1_000_000n, type: 'p2tr', count: 10, rate: '2' });
  assert.equal(ten.estimatedVsize, 498);
  assert.equal(ten.fee, 996n);
  assert.equal(ten.amounts[0], 99_901n);
  assert.equal(ten.amounts.at(-1), 99_900n);
  const twenty = previewSplit({ value: 1_000_000n, type: 'p2tr', count: 20, rate: '2' });
  assert.equal(twenty.estimatedVsize, 928);
  assert.equal(twenty.fee, 1856n);
  assert.equal(twenty.amounts[0], 49_908n);
  assert.equal(twenty.amounts.at(-1), 49_907n);
});

test('decimal fee rounding and satoshi precision', () => {
  assert.equal(parseRate('1.01'), 101n);
  assert.equal(parseRate('0.10'), 10n);
  const p = previewSplit({ value: 1_000_003n, type: 'p2tr', count: 20, rate: '1.01' });
  assert.equal(p.fee, 938n); // ceil(928 * 1.01)
  assert.equal(p.total + p.fee, 1_000_003n);
  assert.equal(formatBTC(1n), '0.00000001');
  assert.equal(formatBTC(1_000_000n), '0.01000000');
  assert.throws(() => satoshi(1.1));
  assert.throws(() => satoshi(Number.MAX_SAFE_INTEGER));
  assert.throws(() => satoshi('-1'));
  assert.throws(() => parseRate('1e2'));
  assert.throws(() => parseRate('0.01'));
  assert.throws(() => parseRate('501'));
  assert.throws(() => parseRate('1.001'));
});

test('count, dust and fee limits reject unusable plans', () => {
  const input = { value: 1_000_000n, type: 'p2tr', count: 20, rate: '2' };
  for (const count of [0, 1, 201, 2.5, NaN]) assert.throws(() => previewSplit({ ...input, count }));
  assert.throws(() => previewSplit({ ...input, value: 10_000n }), /不足|10%/);
  assert.throws(() => previewSplit({ ...input, rate: '500' }), /100,000/);
  assert.throws(() => previewSplit({ ...input, value: 50_000n, rate: '10' }), /10%/);
});

test('reject other networks, legacy, mismatched pubkey and script-wallet addresses', () => {
  const testnet = payments.p2wpkh({ pubkey: TEST_PUB, network: networks.testnet }).address;
  assert.throws(() => walletInfo(testnet, hex(TEST_PUB)), /主网/);
  const legacy = payments.p2pkh({ pubkey: TEST_PUB, network: networks.bitcoin }).address;
  assert.throws(() => walletInfo(legacy, hex(TEST_PUB)), /不支持/);
  const nested = payments.p2sh({ redeem: payments.p2wpkh({ pubkey: TEST_PUB, network: networks.bitcoin }), network: networks.bitcoin }).address;
  assert.throws(() => walletInfo(nested, hex(TEST_PUB)), /不支持/);
  const wsh = payments.p2wsh({ redeem: { output: new Uint8Array([0x51]) }, network: networks.bitcoin }).address;
  assert.throws(() => walletInfo(wsh, hex(TEST_PUB)), /不支持/);
  assert.throws(() => walletInfo(fixture().info.address, '02' + '00'.repeat(32)), /公钥/);
  const validOther = payments.p2wpkh({ pubkey: TEST_PUB, network: networks.bitcoin }).address;
  const oppositePrefix = TEST_PUB[0] === 3 ? '02' : '03';
  assert.throws(() => walletInfo(validOther, oppositePrefix + hex(TEST_PUB.slice(1))), /不匹配/);
});

test('independently check parent txid, output index, amount and owner', () => {
  const f = fixture('p2tr');
  assert.equal(verifyParent(f.source.rawHex, f.source.txid, 0, f.info).value, 1_000_000n);
  assert.throws(() => verifyParent(f.source.rawHex, '00'.repeat(32), 0, f.info), /txid/);
  assert.throws(() => verifyParent(f.source.rawHex, f.source.txid, 1, f.info), /不存在/);
  assert.throws(() => verifyParent(f.source.rawHex, f.source.txid, 0, f.info, 999n), /金额/);
  assert.throws(() => verifyParent(f.source.rawHex, f.source.txid, 0, fixture('p2wpkh').info), /不属于/);
});

test('a nonzero parent vout is preserved and its signature verifies', () => {
  const f = fixture('p2tr');
  const parent = Transaction.fromHex(f.source.rawHex);
  parent.addOutput(f.info.script, f.source.value);
  const source = { ...f.source, txid: parent.getId(), rawHex: parent.toHex(), vout: 1 };
  const plan = buildPlan({ info: f.info, source, count: 20, rate: '2' });
  assert.equal(Psbt.fromHex(plan.psbtHex).txInputs[0].index, 1);
  assert.equal(verifySigned(plan, signedPlan(plan).toHex()).outputs.length, 20);
});

for (const type of ['p2wpkh', 'p2tr']) {
  test(`${type}: reject changed destination, amount, count, sequence or witness signature`, () => {
    const plan = buildPlan({ ...fixture(type), count: 20, rate: '2' });
    const alien = fixture(type === 'p2tr' ? 'p2wpkh' : 'p2tr').info.script;
    const redirect = signedPlan(plan, { mutate: outs => { outs[0].script = alien; } });
    assert.throws(() => verifySigned(plan, redirect.toHex()), /收款地址/);
    const feeChange = signedPlan(plan, { mutate: outs => { outs[0].value -= 1n; } });
    assert.throws(() => verifySigned(plan, feeChange.toHex()), /输出金额/);
    const extraOutput = signedPlan(plan, { mutate: outs => { outs[0].value -= 1000n; outs.push({ script: alien, value: 1000n }); } });
    assert.throws(() => verifySigned(plan, extraOutput.toHex()), /数量/);
    const invalid = signedPlan(plan);
    invalid.data.inputs[0].finalScriptWitness[6] ^= 1;
    assert.throws(() => verifySigned(plan, invalid.toHex()));
    const sequenceChange = signedPlan(plan, { mutate: (_outs, p) => p.setInputSequence(0, 0xfffffffe) });
    assert.throws(() => verifySigned(plan, sequenceChange.toHex()), /序列/);
    const locktimeChange = signedPlan(plan, { mutate: (_outs, p) => p.setLocktime(10) });
    assert.throws(() => verifySigned(plan, locktimeChange.toHex()), /锁定时间/);
    const tx = Transaction.fromHex(plan.unsignedHex);
    assert.equal(tx.ins[0].sequence, 0xfffffffd);
    assert.throws(() => verifySigned(plan, plan.psbtHex));
  });
}

test('partially finalized valid PSBT can be finalized locally for both address types', () => {
  for (const type of ['p2tr', 'p2wpkh']) {
    const p = buildPlan({ ...fixture(type), count: 20, rate: '2' });
    const signed = signedPlan(p, { finalize: false });
    assert.equal(verifySigned(p, signed.toBase64()).outputs.length, 20);
  }
});

test('reject otherwise valid weak sighash signatures', () => {
  const w = buildPlan({ ...fixture('p2wpkh'), count: 10, rate: '2' });
  const weak = signedPlan(w, { sighash: Transaction.SIGHASH_ALL | Transaction.SIGHASH_ANYONECANPAY });
  assert.throws(() => verifySigned(w, weak.toHex()), /SIGHASH_ALL/);
  const t = buildPlan({ ...fixture('p2tr'), count: 10, rate: '2' });
  const nonDefault = signedPlan(t, { sighash: Transaction.SIGHASH_ALL });
  assert.throws(() => verifySigned(t, nonDefault.toHex()), /默认签名/);
});

test('invalid or oversized PSBT is rejected', () => {
  assert.throws(() => parsePsbt(''));
  assert.throws(() => parsePsbt('00'));
  assert.throws(() => parsePsbt('A'.repeat(10_000_001)));
  assert.deepEqual(bytes('00ff'), new Uint8Array([0, 255]));
});
