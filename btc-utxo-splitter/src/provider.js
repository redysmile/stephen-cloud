import { invariant, verifyParent } from './core.js';

const API = 'https://mempool.space/api';
export const explorerTx = txid => `https://mempool.space/tx/${txid}`;
export const explorerAddress = address => `https://mempool.space/address/${address}`;

async function request(path, { text = false, method = 'GET', body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method, body,
    ...(method === 'POST' ? { headers: { 'Content-Type': 'text/plain' } } : {}),
    credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    const message = (await response.text()).slice(0, 300);
    throw new Error(`mempool.space 请求失败（${response.status}）：${message}`);
  }
  return text ? response.text() : response.json();
}

export async function listUtxos(account) {
  const list = await request(`/address/${encodeURIComponent(account)}/utxo`);
  invariant(Array.isArray(list), 'UTXO 服务响应不正确。');
  invariant(list.length <= 10_000, '该地址的 UTXO 太多，请使用原始交易导入。');
  return list.map(u => {
    invariant(/^[0-9a-f]{64}$/.test(u.txid) && Number.isSafeInteger(u.vout) && u.vout >= 0 && Number.isSafeInteger(u.value) && u.value > 0,
      'UTXO 服务返回了无效数据。');
    return { txid: u.txid, vout: u.vout, value: BigInt(u.value), confirmed: u.status?.confirmed === true };
  }).sort((a, b) => a.value > b.value ? -1 : a.value < b.value ? 1 : 0);
}

export async function verifyLive(info, selected) {
  invariant(/^[0-9a-f]{64}$/i.test(selected.txid), 'txid 无效。');
  invariant(Number.isInteger(selected.vout) && selected.vout >= 0, 'vout 无效。');
  const base = `/tx/${selected.txid}`;
  const [rawHex, tx, spent] = await Promise.all([
    request(`${base}/hex`, { text: true }),
    request(base),
    request(`${base}/outspend/${selected.vout}`),
  ]);
  invariant(tx.txid === selected.txid && tx.status?.confirmed === true, '只支持已确认的 UTXO；父交易未确认。');
  invariant(spent.spent === false, '该 UTXO 已花费，或未能确认未花费状态。');
  // Newly mined coinbase outputs need 100 confirmations before spending.
  if (tx.vin?.some(v => v.is_coinbase === true)) {
    const tip = Number(await request('/blocks/tip/height', { text: true }));
    invariant(Number.isSafeInteger(tip) && Number.isSafeInteger(tx.status.block_height)
      && tip - tx.status.block_height + 1 >= 100, 'Coinbase 输出尚未达到 100 次确认。');
  }
  const source = verifyParent(rawHex, selected.txid, selected.vout, info, selected.value);
  return { ...source, verifiedAt: Date.now() };
}

export async function recommendedFees() {
  const data = await request('/v1/fees/recommended');
  invariant(Number.isFinite(data.halfHourFee) && data.halfHourFee >= 0.1 && data.halfHourFee <= 500, '推荐费率超出工具支持范围，请手动设置。');
  return data;
}

export async function broadcast(rawHex, expectedTxid) {
  const txid = (await request('/tx', { text: true, method: 'POST', body: rawHex })).trim();
  invariant(txid === expectedTxid, '广播服务返回的 txid 与本地计算不一致；请按本地 txid 查询，勿重复操作。');
  return txid;
}

export async function transactionStatus(txid) {
  invariant(/^[0-9a-f]{64}$/.test(txid), '交易 ID 无效。');
  return request(`/tx/${txid}/status`);
}
