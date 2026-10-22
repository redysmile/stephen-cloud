import './style.css';
import { walletInfo, verifyParent, buildPlan, verifySigned, previewSplit, formatBTC, planSummary, invariant, hex, bytes } from './core.js';
import { listUtxos, verifyLive, recommendedFees, broadcast, transactionStatus, explorerTx } from './provider.js';

const $ = id => document.getElementById(id);
const state = { info: null, connected: false, candidates: [], source: null, plan: null, signed: null, sent: false, busy: false, epoch: 0 };
const number = value => BigInt(value).toLocaleString('en-US');

function message(text, kind = 'info') {
  $('message').textContent = text;
  $('message').className = `message ${kind}`;
}
function resetPlan() {
  state.plan = null; state.signed = null; state.sent = false;
  $('reviewCheck').checked = false;
  $('broadcastCheck').checked = false;
  $('signedInput').value = '';
  $('signedPanel').hidden = true;
  preview(); controls();
}
function resetSource() {
  state.epoch++;
  state.source = null; state.candidates = [];
  $('assetCheck').checked = false;
  $('utxoList').replaceChildren();
  $('utxoCount').textContent = '请重新读取';
  $('sourceInfo').classList.add('hidden');
  resetPlan();
}
function resetWallet(reason) {
  resetSource(); state.info = null; state.connected = false;
  $('account').value = ''; $('publicKey').value = '';
  $('walletStatus').textContent = '未连接';
  preview(); controls();
  if (reason) message(reason, 'error');
}
function controls() {
  document.body.classList.toggle('busy', state.busy);
  document.querySelectorAll('button, input:not([type=file]), textarea').forEach(el => { el.disabled = state.busy; });
  $('connectBtn').disabled = state.busy;
  $('disconnectBtn').classList.toggle('hidden', !state.connected);
  $('account').disabled = state.busy || state.connected;
  $('publicKey').disabled = state.busy || state.connected;
  $('buildBtn').disabled = state.busy || !state.source || !$('assetCheck').checked;
  for (const id of ['downloadPsbtBtn', 'copyPsbtBtn', 'exportPlanBtn', 'verifySignedBtn']) $(id).disabled = state.busy || !state.plan;
  $('reviewCheck').disabled = state.busy || !state.plan;
  $('signBtn').disabled = state.busy || !state.plan || !state.connected || !$('reviewCheck').checked || !!state.signed;
  $('broadcastBtn').disabled = state.busy || !state.signed || !$('broadcastCheck').checked || state.sent;
  document.querySelectorAll('[data-utxo]').forEach(el => { el.disabled = state.busy || !state.candidates[Number(el.dataset.utxo)]?.confirmed; });
  $('rawOutput').readOnly = true;
}
async function task(fn) {
  if (state.busy) return;
  state.busy = true; controls();
  const epoch = state.epoch;
  const check = () => invariant(epoch === state.epoch, '账户、网络或输入发生变化，已取消旧操作，请重新生成。');
  try { await fn(check); }
  catch (error) { message(error?.message || '操作未完成。', 'error'); }
  finally { state.busy = false; controls(); }
}
function infoFromForm() { return walletInfo($('account').value.trim(), $('publicKey').value.trim()); }

function preview() {
  let p;
  try {
    p = state.plan || previewSplit({ value: state.source?.value ?? 1_000_000n, type: state.info?.type ?? 'p2tr', count: Number($('count').value), rate: $('rate').value });
  } catch (error) {
    $('previewLabel').textContent = '参数无效';
    $('previewLabel').classList.remove('real');
    $('outputRows').replaceChildren();
    for (const id of ['summaryCount', 'perOutput', 'summaryFee', 'summaryVsize']) $(id).textContent = '—';
    $('outputTotal').textContent = '请修正参数';
    $('remainderHint').textContent = error.message;
    return;
  }
  const value = state.source?.value ?? 1_000_000n;
  $('previewLabel').textContent = state.plan ? '已生成 PSBT' : state.source ? '输入已选 · 待生成' : '示例测算';
  $('previewLabel').classList.toggle('real', !!state.plan);
  $('amountLabel').textContent = state.source ? `所选输入 · ${state.info.type.toUpperCase()}` : '示例输入 · Taproot';
  $('inputBTC').replaceChildren(document.createTextNode(`${formatBTC(value)} `), unit('BTC'));
  $('summaryCount').replaceChildren(document.createTextNode(`${p.count} `), unit('笔'));
  const min = p.amounts.at(-1), max = p.amounts[0];
  $('perOutput').replaceChildren(document.createTextNode(min === max ? number(min) + ' ' : `${number(min)}–${number(max)} `), unit('sat'));
  $('summaryFee').replaceChildren(document.createTextNode(number(p.fee) + ' '), unit('sat'));
  $('summaryVsize').replaceChildren(document.createTextNode(p.estimatedVsize + ' '), unit('vB'));
  $('destination').textContent = state.source ? state.info.address : '连接钱包或导入后显示';
  $('outputTotal').textContent = state.plan ? `合计 ${formatBTC(p.total)} BTC` : '试算 · 未生成交易';
  $('outputRows').replaceChildren(...p.amounts.map((value, index) => {
    const tr = document.createElement('tr');
    for (const item of [index, formatBTC(value), number(value)]) { const td = document.createElement('td'); td.textContent = item; tr.append(td); }
    return tr;
  }));
  $('remainderHint').textContent = `扣费后均分，各输出最多相差 1 sat。共 ${p.count} 个输出，无额外找零。${state.plan ? '尚未广播；签名后再次核对。' : '当前仅为试算，不生成可花费 UTXO。'}`;
}
function unit(text) { const el = document.createElement('small'); el.textContent = text; return el; }
function showSource(source, live) {
  state.source = { ...source, live };
  $('sourceInfo').classList.remove('hidden');
  $('sourceInfo').textContent = `${live ? '原始交易、金额、确认与未花费状态已由 API 核对' : '仅核对原始交易、金额和地址，尚未联网核验'} · ${source.txid}:${source.vout} · ${number(source.value)} sat。未进行协议资产扫描。`;
  $('assetCheck').checked = false;
  resetPlan();
}

async function assertWallet(info) {
  invariant(window.unisat, '未检测到 UniSat 扩展。');
  const [network, accounts, publicKey] = await Promise.all([window.unisat.getNetwork(), window.unisat.getAccounts(), window.unisat.getPublicKey()]);
  invariant(network === 'livenet', 'UniSat 当前不是 BTC 主网，请在钱包切换到 Bitcoin Mainnet 后重新连接。');
  invariant(accounts?.[0]?.toLowerCase() === info.address && publicKey.toLowerCase() === info.publicKey, 'UniSat 账户已变化，请重新连接。');
}

$('connectBtn').onclick = () => task(async check => {
  invariant(window.unisat?.requestAccounts, '未检测到 UniSat。请在安装扩展的浏览器中，用 localhost 或 HTTPS 打开本工具。也可手动导入并导出 PSBT。');
  const accounts = await window.unisat.requestAccounts(); check();
  const [network, publicKey] = await Promise.all([window.unisat.getNetwork(), window.unisat.getPublicKey()]); check();
  invariant(network === 'livenet', '请选择 UniSat 的 Bitcoin Mainnet，再重新连接；工具不会自动切换网络。');
  invariant(accounts?.[0], 'UniSat 没有返回账户。');
  const info = walletInfo(accounts[0], publicKey);
  resetSource(); state.info = info; state.connected = true;
  $('account').value = info.address; $('publicKey').value = info.publicKey;
  $('walletStatus').textContent = `${info.type.toUpperCase()} · 主网`;
  message('已连接 UniSat 主网账户。点击“读取 UTXO”，手动选择一笔普通 BTC 输入。');
});
$('disconnectBtn').onclick = () => { resetWallet(); message('已清除本页账户与交易状态。钱包中的站点授权可在 UniSat 内单独撤销。'); };

$('loadBtn').onclick = () => task(async check => {
  const info = infoFromForm();
  if (state.connected) { await assertWallet(info); check(); }
  const list = await listUtxos(info.address); check();
  resetSource(); state.info = info; state.candidates = list;
  $('utxoCount').textContent = `${list.filter(u => u.confirmed).length} 笔已确认 / ${list.length} 笔总计`;
  const options = list.map((u, i) => {
    const label = document.createElement('label'); label.className = 'utxo-option';
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'utxo'; radio.dataset.utxo = String(i); radio.disabled = !u.confirmed;
    const description = document.createElement('div');
    const id = document.createElement('span'); id.className = 'utxo-id'; id.textContent = `${u.txid.slice(0, 15)}…${u.txid.slice(-9)}:${u.vout}`;
    const note = document.createElement('span'); note.className = 'utxo-meta'; note.textContent = `${u.confirmed ? '已确认' : '未确认 · 不可选'} · 协议资产未扫描`;
    description.append(id, note);
    const value = document.createElement('div'); value.className = 'utxo-value'; value.textContent = formatBTC(u.value);
    const sats = document.createElement('small'); sats.textContent = `${number(u.value)} sat`; value.append(sats);
    label.append(radio, description, value);
    radio.onchange = () => task(async verifyCheck => {
      state.source = null; $('sourceInfo').classList.add('hidden'); $('assetCheck').checked = false; resetPlan();
      const source = await verifyLive(info, u); verifyCheck();
      showSource(source, true);
      message('已核对选中的父交易、金额与未花费状态。请自行确认它不包含协议资产。');
    });
    return label;
  });
  if (!options.length) {
    const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '该地址没有可查询的 UTXO。'; options.push(empty);
  }
  $('utxoList').replaceChildren(...options);
  message('UTXO 已读取。列表不会区分铭文、Runes 或 TAPEBIT，请只选择普通 BTC。');
});

$('importParentBtn').onclick = () => task(async () => {
  const info = infoFromForm();
  const voutText = $('parentVout').value;
  invariant(/^\d+$/.test(voutText), 'vout 必须为非负整数。');
  const source = verifyParent($('parentHex').value.trim(), $('parentTxid').value.trim(), Number(voutText), info);
  resetSource(); state.info = info;
  showSource(source, false);
  message('原始交易已核对。离线导入不证明未花费；签名及广播前必须联网复核。');
});

for (const id of ['account', 'publicKey']) $(id).addEventListener('input', () => { resetSource(); state.info = null; controls(); });
for (const id of ['count', 'rate']) $(id).addEventListener('input', () => {
  resetPlan();
  document.querySelectorAll('[data-count]').forEach(b => b.classList.toggle('active', Number(b.dataset.count) === Number($('count').value)));
  if (id === 'rate') $('feeHint').textContent = '当前为手动设置费率，未承诺确认时间。手续费从输入扣除，不另设找零输出。';
});
document.querySelectorAll('[data-count]').forEach(b => b.onclick = () => { $('count').value = b.dataset.count; $('count').dispatchEvent(new Event('input')); });
$('assetCheck').onchange = () => { if (!$('assetCheck').checked) resetPlan(); controls(); };
$('reviewCheck').onchange = controls;
$('broadcastCheck').onchange = controls;
$('feesBtn').onclick = () => task(async check => {
  const fees = await recommendedFees(); check();
  $('rate').value = String(fees.halfHourFee); resetPlan();
  $('feeHint').textContent = `刚读取的半小时档推荐值：${fees.halfHourFee} sat/vB（${new Date().toLocaleTimeString('zh-CN')}）。仅作参考，不保证确认时间。`;
  message('已更新推荐费率，请重新核对拆分计划。');
});
$('buildBtn').onclick = () => {
  try {
    invariant(state.source && $('assetCheck').checked, '请先选择并确认普通 BTC 输入。');
    resetPlan();
    state.plan = buildPlan({ source: state.source, info: state.info, count: Number($('count').value), rate: $('rate').value });
    preview(); controls();
    message('拆分计划与未签名 PSBT 已在本地生成。没有签名，也没有广播。');
  } catch (error) { message(error.message, 'error'); }
};

function download(name, data, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportJSON(name, data) { download(name, JSON.stringify(data, null, 2), 'application/json;charset=utf-8'); }
$('downloadPsbtBtn').onclick = () => { if (state.plan) download('btc-mainnet-split-unsigned.psbt', bytes(state.plan.psbtHex), 'application/octet-stream'); };
$('copyPsbtBtn').onclick = async () => {
  if (!state.plan) return;
  try { await navigator.clipboard.writeText(state.plan.psbtBase64); message('已复制未签名 PSBT（Base64）。'); }
  catch { message('剪贴板不可用，请下载 PSBT 文件。', 'error'); }
};
$('exportPlanBtn').onclick = () => { if (state.plan) exportJSON('btc-split-plan.json', planSummary(state.plan, state.signed)); };

function showSigned(result) {
  state.signed = result; state.sent = false; $('broadcastCheck').checked = false;
  $('signedTxid').textContent = result.txid; $('rawOutput').value = result.rawHex;
  $('signedFacts').textContent = `矿工费 ${number(result.fee)} sat · 实际体积 ${result.vsize} vB · 实际费率 ${result.feeRate.toFixed(2)} sat/vB · ${result.outputs.length} 个输出。`;
  $('broadcastStatus').textContent = '尚未广播';
  $('signedStatus').textContent = '输入、输出、手续费与 Bitcoin 签名均已本地校验';
  $('explorerLink').href = explorerTx(result.txid);
  $('signedPanel').hidden = false;
  controls();
  message('已核验签名与全部交易内容，尚未广播。请检查第三步后自行决定是否发送。');
}
$('signBtn').onclick = () => task(async check => {
  const plan = state.plan;
  invariant(plan && $('reviewCheck').checked && $('assetCheck').checked, '请先核对计划。');
  await assertWallet(plan.info); check();
  await verifyLive(plan.info, plan.source); check();
  const result = await window.unisat.signPsbt(plan.psbtHex, {
    autoFinalized: true,
    toSignInputs: [{ index: 0, address: plan.info.address, sighashTypes: [plan.info.type === 'p2tr' ? 0 : 1] }],
  }); check();
  await assertWallet(plan.info); check();
  showSigned(verifySigned(plan, result));
});
$('verifySignedBtn').onclick = () => task(async () => {
  invariant(state.plan && $('assetCheck').checked && $('reviewCheck').checked, '请先生成并勾选核对当前计划。');
  showSigned(verifySigned(state.plan, $('signedInput').value));
});
$('signedFile').onchange = event => task(async check => {
  const file = event.target.files?.[0]; if (!file) return;
  invariant(file.size <= 5_000_000, 'PSBT 文件过大。');
  const data = new Uint8Array(await file.arrayBuffer()); check();
  $('signedInput').value = hex(data.slice(0, 5)) === '70736274ff' ? hex(data) : new TextDecoder().decode(data);
  message('PSBT 文件已读入，请核对当前计划后点击“验证已签名 PSBT”。');
  event.target.value = '';
});
$('downloadRawBtn').onclick = () => { if (state.signed) download(`btc-${state.signed.txid}.hex`, state.signed.rawHex); };
$('exportOutputsBtn').onclick = () => {
  if (!state.signed) return;
  exportJSON('btc-split-outputs.json', {
    ...planSummary(state.plan, state.signed),
    broadcastAttemptAcknowledged: state.sent,
    note: '本清单不证明广播、确认或未花费状态；使用前需重新查链。',
  });
};
$('broadcastBtn').onclick = () => task(async check => {
  invariant(state.signed && state.plan && $('broadcastCheck').checked && $('assetCheck').checked, '请先核验交易并确认主网广播。');
  const plan = state.plan, signed = state.signed;
  // Check again even for externally signed PSBTs; never send a changed or stale plan.
  verifySigned(plan, signed.psbtHex);
  if (state.connected) { await assertWallet(plan.info); check(); }
  await verifyLive(plan.info, plan.source); check();
  message('正在广播已核验的主网交易，请勿重复操作。');
  try {
    const txid = await broadcast(signed.rawHex, signed.txid); check();
    state.sent = true; $('broadcastStatus').textContent = '已广播 · 待确认';
    message(`广播服务已接受交易：${txid}。这不代表已确认，后续请查询确认状态。`);
  } catch (error) {
    // A timeout can happen after relay. Preserve signed bytes and instruct a lookup.
    $('broadcastStatus').textContent = '广播结果待核实';
    throw new Error(`${error.message} 广播结果可能不确定，请先查询本地 txid：${signed.txid}；不要改参数重复拆分。`);
  }
});
$('statusBtn').onclick = () => task(async check => {
  invariant(state.signed, '请先签名或导入签名。');
  const result = await transactionStatus(state.signed.txid); check();
  invariant(typeof result.confirmed === 'boolean', '查询服务未返回有效确认状态。');
  state.sent = true;
  $('broadcastStatus').textContent = result.confirmed ? `已确认 · 高度 ${result.block_height}` : '已查到 · 待确认';
  message(result.confirmed ? '拆分交易已确认。清单中的输出在后续使用前仍需检查未花费状态。' : '区块浏览器已查到交易，尚未确认。');
});

if (window.unisat?.on) {
  window.unisat.on('accountsChanged', () => { if (state.connected) resetWallet('UniSat 账户发生变化，已清除原计划与签名，请重新连接。'); });
  window.unisat.on('networkChanged', () => { if (state.connected) resetWallet('UniSat 网络发生变化，已清除原计划与签名；本工具仅支持 BTC 主网。'); });
}
preview(); controls();
