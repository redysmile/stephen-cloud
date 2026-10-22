# BTC 主网 UTXO 拆分工具

单笔普通 BTC UTXO → 扣除矿工费 → 10 / 20 / 自定义 2–200 笔 UTXO，全部回到原地址。没有平台费，不接触私钥或助记词。

**[下载可部署的静态网页 ZIP](./btc-utxo-splitter-web.zip?raw=true)** · [界面预览](./preview.png)

ZIP 是完整的静态网站，不需要构建。源码和锁文件也在本目录。此仓库中的 HTML 源码页面不是已部署的网站。

## 使用静态包

将 ZIP 解压到 HTTPS 静态网站目录，保留 `index.html` 和 `assets/` 的相对位置。也可以在解压目录使用本地服务器：

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

在安装 UniSat 扩展的浏览器打开 `http://127.0.0.1:8080`。使用 localhost 或 HTTPS，不要直接双击 HTML 用 `file://` 打开。

1. 在 UniSat 切换至 **Bitcoin Mainnet**，连接钱包。当前支持单签原生 SegWit P2WPKH（`bc1q`）和 BIP86 Taproot（`bc1p`）。
2. 读取 UTXO，手动选择一笔已确认、未花费的普通 BTC 输入。
3. **自行确认没有铭文、Runes、TAPEBIT 或其他协议资产，且未被其他待完成交易占用。** 公共 BTC 浏览器无法完成这一资产检查，建议使用专门的普通 BTC 资金地址。
4. 选择拆分数量及费率，核对原地址、每笔金额和总手续费，生成 PSBT。
5. 交给 UniSat 签名，或导出 PSBT 在其他钱包签名后导入。签名不会自动广播。
6. 检查签名后，再单独确认广播至 BTC 主网。可以导出 `txid:vout` 和金额清单。
7. 查询确认状态。导出清单不代表输出已经确认或仍未花费，后续使用前应重新查询。

## 0.01 BTC 的计算示例

以下为 **Taproot、1 笔输入、2 sat/vB** 的公式示例，并非实时费率或确认时间保证：

| 拆分数量 | 估算体积 | 矿工费 | 各输出金额 |
| --- | --- | --- | --- |
| 10 笔 | 498 vB | 996 sat | 前 4 笔 99,901 sat，其余 99,900 sat |
| 20 笔 | 928 vB | 1,856 sat | 前 4 笔 49,908 sat，其余 49,907 sat |

输入 0.01 BTC 为 1,000,000 sat。输出总额加手续费等于输入；没有额外找零或平台收款。ECDSA 交易使用最大签名尺寸保守估算，实际费率可能略高于设置值。

## 实现与边界

- 本地用 `bitcoinjs-lib` 构建 PSBT，通过 UniSat `requestAccounts / getNetwork / getPublicKey / signPsbt` 请求用户授权。
- 通过 mempool.space 主网 API 读取 UTXO、父交易、未花费状态与费率。签名前、广播前重新查询。父交易 txid、输出金额和脚本按实际交易字节核对；确认及未花费状态依赖 API。
- 签名结果会逐项核对原输入、全部输出、金额、版本、锁定时间与序列，并校验 ECDSA / Schnorr 签名。P2WPKH 只接受 SIGHASH_ALL，Taproot 只接受默认 key-path 签名。
- 原地址和公钥必须相互匹配。测试网地址、Legacy、嵌套 SegWit、多签／脚本钱包以及带脚本树的 Taproot 不在当前支持范围。
- 原始父交易导入可离线构建 PSBT；离线导入不证明交易存在于主网、已确认或仍未花费。UniSat 签名和主网广播仍须联网复核。
- 每笔至少 1,000 sat 是工具限制，不是 Bitcoin 对所有输出统一规定的下限。费率可设 0.10–500 sat/vB；总手续费最多 100,000 sat，且最多为输入的 10%。低费率可能不被中继。
- 交易启用 RBF 信号（sequence `0xfffffffd`），但工具不实现替换、取消或加速。广播超时不等于交易未传播，先按本地 txid 查询。
- 不自动保存地址、PSBT 或已签交易。数据只在页面内存中；导出由用户主动操作。已签交易文件可被用于广播，请按自己的交易资料保管。
- 读取地址会将该地址交给 mempool.space；仅点击广播后才向其发送已签原始交易。

## 开发

Node.js 22.12+（Vite 推荐较新的 Node 22 / 24）。

```sh
cd btc-utxo-splitter
npm ci
npm test
npm run dev
```

生产构建与静态包：

```sh
npm run build
python3 scripts/package.py
```

`npm run build` 输出 `dist/`。第三方依赖全部打包在本地 JS 中，运行时不使用 CDN 脚本。

## Cloudflare Pages 部署

- Git 仓库：`redysmile/stephen-cloud`。
- 根目录：`btc-utxo-splitter`。
- 构建命令：`npm ci && npm run build`。
- 构建输出目录：`dist`。
- 使用支持的 Node 版本（建议 Node 24）。

也可将 ZIP 解压内容部署到现有服务器，例如网站 `/tools/utxo-splitter/` 子目录。构建使用相对资源路径。`public/_headers` 会随构建输出，Cloudflare Pages 会应用其中的响应头；其他服务器应配置等效响应头。

本次仅提供文件与部署步骤，没有替你启用 Pages 或修改线上域名。

## 验证记录

```sh
npm test
npm run build
npm audit
```

浏览器测试还需要 Python Playwright 和 Chromium：

```sh
node tests/make-browser-fixtures.js
python3 tests/browser.py
```

交易测试使用专门的测试密钥与合成父交易；**不要向测试文件里的地址转入资金**。浏览器测试拦截全部区块链 API，模拟 UniSat 的连接、拒签、签名、广播确认、状态查询、账户切换和离线导入。

当前云环境对 mempool.space 的请求返回网络策略 403，未验证实际 API 连通性；未使用真实 UniSat 扩展或真实 BTC 完成主网端到端交易。模拟测试通过不构成外部安全审计。首次使用应先用可承受的小额普通 BTC 验证自己的钱包及部署环境。

UniSat 接口核对来源：[官方 page provider](https://github.com/unisat-wallet/extension/blob/master/src/content-script/pageProvider/index.ts)、[官方钱包控制器](https://github.com/unisat-wallet/extension/blob/master/src/background/controller/wallet.ts)。
