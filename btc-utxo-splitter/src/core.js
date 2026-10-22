import { address, networks, payments, Psbt, Transaction, script, initEccLib } from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';

initEccLib(ecc);
export const NETWORK = networks.bitcoin;
export const MAX_MONEY = 2_100_000_000_000_000n;
export const MIN_OUTPUT = 1000n;
export const MAX_FEE = 100_000n;
export const MAX_OUTPUTS = 200;
export const SEQUENCE = 0xfffffffd; // Opt-in RBF. This tool does not implement fee replacement.

export function invariant(ok, message) { if (!ok) throw new Error(message); }
export function hex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
export function bytes(value) {
  invariant(typeof value === 'string' && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value), '十六进制数据格式不正确。');
  return Uint8Array.from(value.match(/../g), x => parseInt(x, 16));
}
export function same(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }
export function satoshi(value) {
  if (typeof value === 'bigint') {
    invariant(value >= 0n && value <= MAX_MONEY, '金额超出 Bitcoin 范围。');
    return value;
  }
  invariant((typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && /^\d+$/.test(value)), '金额必须为整数 sat。');
  const n = BigInt(value);
  invariant(n >= 0n && n <= MAX_MONEY, '金额超出 Bitcoin 范围。');
  return n;
}
export function formatBTC(value) {
  const n = satoshi(value);
  return `${n / 100_000_000n}.${(n % 100_000_000n).toString().padStart(8, '0')}`;
}
export function parseRate(value) {
  const s = String(value).trim();
  invariant(/^\d{1,3}(?:\.\d{1,2})?$/.test(s), '费率须为最多两位小数的 sat/vB。');
  const [a, b = ''] = s.split('.');
  const hundredths = BigInt(a) * 100n + BigInt(b.padEnd(2, '0'));
  invariant(hundredths >= 10n && hundredths <= 50_000n, '费率范围为 0.10–500 sat/vB。');
  return hundredths;
}

export function walletInfo(account, publicKeyHex) {
  invariant(typeof account === 'string' && account.length <= 100, '请填写 BTC 主网地址。');
  let output;
  try { output = address.toOutputScript(account, NETWORK); }
  catch { throw new Error('地址无效或不属于 BTC 主网。请选择 bc1q 或 bc1p 地址。'); }
  const pubkey = bytes(String(publicKeyHex).trim());
  invariant(pubkey.length === 33 && ecc.isPoint(pubkey), '需要该地址对应的 33 字节压缩公钥。');
  let type, derived;
  if (output.length === 22 && output[0] === 0 && output[1] === 20) {
    type = 'p2wpkh';
    derived = payments.p2wpkh({ pubkey, network: NETWORK }).output;
  } else if (output.length === 34 && output[0] === 0x51 && output[1] === 32) {
    type = 'p2tr';
    derived = payments.p2tr({ internalPubkey: pubkey.slice(1), network: NETWORK }).output;
  } else {
    throw new Error('当前支持原生 SegWit P2WPKH（bc1q）和 BIP86 Taproot（bc1p）；不支持 Legacy、嵌套 SegWit 或脚本钱包。');
  }
  invariant(same(output, derived), '公钥与主网地址不匹配，或该地址不是支持的单签地址。');
  return { address: account.toLowerCase(), publicKey: hex(pubkey), type, script: output };
}

/** Validate the actual parent bytes; never trust API-reported amount/script alone. */
export function verifyParent(rawHex, txid, vout, info, reportedValue) {
  invariant(typeof rawHex === 'string' && rawHex.length <= 8_000_000, '父交易数据为空或过大。');
  invariant(/^[0-9a-f]{64}$/i.test(txid), 'txid 必须为 64 位十六进制。');
  invariant(Number.isInteger(vout) && vout >= 0 && vout <= 0xffffffff, 'vout 必须为非负整数。');
  const tx = Transaction.fromHex(rawHex.trim());
  invariant(tx.getId() === txid.toLowerCase(), '原始交易与选中 txid 不一致。');
  invariant(vout < tx.outs.length, '该交易不存在指定输出。');
  const out = tx.outs[vout];
  invariant(same(out.script, info.script), '该 UTXO 不属于当前地址。');
  const value = satoshi(out.value);
  invariant(value > 0n, 'UTXO 金额必须大于零。');
  if (reportedValue !== undefined) invariant(value === satoshi(reportedValue), 'API 金额与原始交易不一致。');
  return { txid: txid.toLowerCase(), vout, value, rawHex: hex(tx.toBuffer()), script: out.script };
}

function txFor(source, info, amounts) {
  const tx = new Transaction();
  tx.version = 2;
  tx.locktime = 0;
  tx.addInput(bytes(source.txid).reverse(), source.vout, SEQUENCE);
  for (const amount of amounts) tx.addOutput(info.script, amount);
  return tx;
}

export function previewSplit({ value, type, count, rate }) {
  invariant(Number.isInteger(count) && count >= 2 && count <= MAX_OUTPUTS, '拆分数量必须为 2–200 的整数。');
  value = satoshi(value);
  invariant(type === 'p2tr' || type === 'p2wpkh', '不支持的地址类型。');
  const hundredths = parseRate(rate);
  // One input, <=200 outputs: CompactSize fields occupy one byte.
  // Include marker/flag and maximum ECDSA witness, or 64-byte Taproot key-path witness.
  const baseSize = 51 + count * (type === 'p2tr' ? 43 : 31);
  const estimatedVsize = Math.ceil((baseSize * 4 + (type === 'p2tr' ? 68 : 111)) / 4);
  const fee = (BigInt(estimatedVsize) * hundredths + 99n) / 100n;
  invariant(fee <= MAX_FEE, '手续费超过 100,000 sat 保护上限，请降低费率或拆分数量。');
  invariant(fee * 10n <= value, '手续费超过输入金额的 10%，请降低费率或拆分数量。');
  const total = value - fee;
  invariant(total >= BigInt(count) * MIN_OUTPUT, '扣除手续费后，每笔不足本工具最低 1,000 sat，请减少拆分数量。');
  const base = total / BigInt(count), remainder = Number(total % BigInt(count));
  const amounts = Array.from({ length: count }, (_, i) => base + (i < remainder ? 1n : 0n));
  return { count, rate: String(rate), fee, total, amounts, estimatedVsize };
}

export function buildPlan({ source, info, count, rate }) {
  const verified = verifyParent(source.rawHex, source.txid, source.vout, info, source.value);
  const calculated = previewSplit({ value: verified.value, type: info.type, count, rate });
  const { amounts } = calculated;
  const psbt = new Psbt({ network: NETWORK });
  psbt.setVersion(2);
  psbt.setLocktime(0);
  const input = {
    hash: verified.txid, index: verified.vout, sequence: SEQUENCE,
    witnessUtxo: { script: info.script, value: verified.value },
    nonWitnessUtxo: bytes(verified.rawHex),
  };
  if (info.type === 'p2tr') input.tapInternalKey = bytes(info.publicKey).slice(1);
  else input.sighashType = Transaction.SIGHASH_ALL;
  psbt.addInput(input);
  for (const value of amounts) psbt.addOutput({ script: info.script, value });
  invariant(amounts.reduce((a, b) => a + b, 0n) + calculated.fee === verified.value, '金额守恒检查失败。');
  return {
    ...calculated, source: verified, info,
    unsignedHex: txFor(verified, info, amounts).toHex(),
    psbtHex: psbt.toHex(), psbtBase64: psbt.toBase64(),
  };
}

export function parsePsbt(text) {
  invariant(typeof text === 'string' && text.length <= 10_000_000, 'PSBT 数据过大。');
  const value = text.trim();
  invariant(value.length > 0, '请粘贴钱包返回的 PSBT。');
  return /^[0-9a-f]+$/i.test(value)
    ? Psbt.fromHex(value, { network: NETWORK })
    : Psbt.fromBase64(value, { network: NETWORK });
}

/** Verify structure and actual Bitcoin signature against independently verified prevout. */
export function verifySigned(plan, signedText) {
  const psbt = parsePsbt(signedText);
  if (!psbt.data.inputs.every(i => i.finalScriptWitness)) psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction(true);
  const expected = Transaction.fromHex(plan.unsignedHex);
  invariant(tx.version === expected.version && tx.locktime === expected.locktime, '钱包改变了交易版本或锁定时间。');
  invariant(tx.ins.length === 1 && tx.outs.length === plan.count, '钱包改变了输入或输出数量。');
  const a = tx.ins[0], b = expected.ins[0];
  invariant(same(a.hash, b.hash) && a.index === b.index && a.sequence === b.sequence && a.script.length === 0,
    '钱包改变了输入、序列或 scriptSig。');
  tx.outs.forEach((out, i) => invariant(out.value === expected.outs[i].value && same(out.script, expected.outs[i].script),
    '钱包改变了收款地址或输出金额，已拒绝。'));
  const fee = plan.source.value - tx.outs.reduce((n, out) => n + out.value, 0n);
  invariant(fee === plan.fee && fee >= 0n && fee <= MAX_FEE, '实际手续费与预览不一致。');
  if (plan.info.type === 'p2wpkh') {
    invariant(a.witness.length === 2 && same(a.witness[1], bytes(plan.info.publicKey)), '签名公钥或见证结构不正确。');
    const signature = script.signature.decode(a.witness[0]);
    invariant(signature.hashType === Transaction.SIGHASH_ALL, '仅接受完整承诺全部输入输出的 SIGHASH_ALL 签名。');
    const prevScript = payments.p2pkh({ pubkey: bytes(plan.info.publicKey), network: NETWORK }).output;
    const digest = tx.hashForWitnessV0(0, prevScript, plan.source.value, Transaction.SIGHASH_ALL);
    invariant(ecc.verify(digest, a.witness[1], signature.signature), 'Bitcoin ECDSA 签名校验失败。');
  } else {
    invariant(a.witness.length === 1 && a.witness[0].length === 64, '仅接受标准 Taproot key-path 默认签名，不接受脚本路径或其他 sighash。');
    const digest = tx.hashForWitnessV1(0, [plan.info.script], [plan.source.value], Transaction.SIGHASH_DEFAULT);
    invariant(ecc.verifySchnorr(digest, plan.info.script.slice(2), a.witness[0]), 'Bitcoin Schnorr 签名校验失败。');
  }
  invariant(tx.virtualSize() <= plan.estimatedVsize, '实际交易体积超出保守估算，已停止。');
  return {
    txid: tx.getId(), rawHex: tx.toHex(), psbtHex: psbt.toHex(),
    vsize: tx.virtualSize(), fee,
    feeRate: Number(fee) / tx.virtualSize(),
    outputs: tx.outs.map((out, vout) => ({ txid: tx.getId(), vout, value: out.value, address: plan.info.address })),
  };
}

export function planSummary(plan, signed) {
  return {
    network: 'bitcoin-mainnet',
    input: { txid: plan.source.txid, vout: plan.source.vout, sats: plan.source.value.toString() },
    address: plan.info.address, count: plan.count, feeSats: plan.fee.toString(),
    estimatedVsize: plan.estimatedVsize, requestedSatPerVbyte: plan.rate,
    signedTxid: signed?.txid ?? null,
    actualVsize: signed?.vsize ?? null,
    outputs: plan.amounts.map((value, vout) => ({ txid: signed?.txid ?? null, vout, sats: value.toString() })),
  };
}
