// Deterministic test-only keys and synthetic parents. NEVER fund these addresses.
// This module is not imported by the application or production bundle.
import * as ecc from '@bitcoinerlab/secp256k1';
import { payments, Transaction, Psbt, crypto, networks } from 'bitcoinjs-lib';
import { walletInfo, hex, buildPlan, bytes } from '../src/core.js';

export const TEST_KEY = new Uint8Array(32).fill(1);
export const TEST_PUB = ecc.pointFromScalar(TEST_KEY, true);

export function fixture(type = 'p2tr', value = 1_000_000n) {
  const payment = type === 'p2tr'
    ? payments.p2tr({ internalPubkey: TEST_PUB.slice(1), network: networks.bitcoin })
    : payments.p2wpkh({ pubkey: TEST_PUB, network: networks.bitcoin });
  const info = walletInfo(payment.address, hex(TEST_PUB));
  const parent = new Transaction(); parent.version = 2;
  parent.addInput(new Uint8Array(32).fill(0x55), 0, 0xfffffffd);
  parent.addOutput(payment.output, value);
  const source = { rawHex: parent.toHex(), txid: parent.getId(), vout: 0, value };
  return { info, source };
}

export function signer(type) {
  if (type === 'p2wpkh') return { publicKey: TEST_PUB, sign: hash => ecc.sign(hash, TEST_KEY) };
  const secret = TEST_PUB[0] === 3 ? ecc.privateNegate(TEST_KEY) : TEST_KEY;
  const tweaked = ecc.privateAdd(secret, crypto.taggedHash('TapTweak', TEST_PUB.slice(1)));
  return { publicKey: ecc.pointFromScalar(tweaked, true), signSchnorr: hash => ecc.signSchnorr(hash, tweaked) };
}

export function signedPlan(plan, { mutate, sighash, finalize = true } = {}) {
  const psbt = new Psbt({ network: networks.bitcoin });
  psbt.setVersion(2); psbt.setLocktime(0);
  const input = { hash: plan.source.txid, index: plan.source.vout, sequence: 0xfffffffd,
    witnessUtxo: { script: plan.info.script, value: plan.source.value },
    nonWitnessUtxo: bytes(plan.source.rawHex) };
  if (plan.info.type === 'p2tr') input.tapInternalKey = TEST_PUB.slice(1);
  if (sighash !== undefined) input.sighashType = sighash;
  else if (plan.info.type === 'p2wpkh') input.sighashType = Transaction.SIGHASH_ALL;
  psbt.addInput(input);
  const outputs = plan.amounts.map(value => ({ script: plan.info.script, value }));
  if (mutate) mutate(outputs, psbt);
  for (const out of outputs) psbt.addOutput(out);
  psbt.signInput(0, signer(plan.info.type), [sighash ?? (plan.info.type === 'p2tr' ? 0 : 1)]);
  if (finalize) psbt.finalizeAllInputs();
  return psbt;
}

export function browserFixture(type = 'p2tr', count = 20, rate = '2') {
  const f = fixture(type);
  const plan = buildPlan({ ...f, count, rate });
  return { address: f.info.address, publicKey: f.info.publicKey,
    txid: f.source.txid, vout: 0, value: Number(f.source.value), rawHex: f.source.rawHex,
    unsignedPsbt: plan.psbtHex, signedPsbt: signedPlan(plan).toHex(),
    fee: Number(plan.fee), count, rate };
}
