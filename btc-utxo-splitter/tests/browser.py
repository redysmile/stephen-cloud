"""Production-build browser smoke tests. All blockchain calls are intercepted.

Requires Python Playwright + Chromium, only in the test environment. Never sends BTC.
Run `node tests/make-browser-fixtures.js` before running this script.
"""
import asyncio
import functools
import http.server
import json
import threading
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / 'test-results'
FIXTURES = json.loads(Path('/tmp/btc-splitter-browser-fixtures.json').read_text())

async def setup(browser, base, kind='p2tr', wallet=True, mobile=False):
    f = FIXTURES[kind]
    ctx = await browser.new_context(viewport={'width':390,'height':844} if mobile else {'width':1440,'height':1080})
    calls = {'post':0, 'reads':0, 'spent':False, 'confirmed':False, 'fail':False}
    async def api(route):
        request = route.request
        path = request.url.split('/api',1)[1]
        if calls['fail']:
            await route.abort('failed')
            return
        calls['reads'] += 1
        if path.startswith('/address/'):
            result = [
                {'txid':f['txid'],'vout':0,'value':f['value'],'status':{'confirmed':True}},
                {'txid':'a'*64,'vout':1,'value':10000,'status':{'confirmed':False}},
            ]
        elif path == f"/tx/{f['txid']}/hex":
            await route.fulfill(status=200,body=f['rawHex'])
            return
        elif path == f"/tx/{f['txid']}/outspend/0":
            result = {'spent':calls['spent']}
        elif path == f"/tx/{f['txid']}":
            result = {'txid':f['txid'],'status':{'confirmed':True,'block_height':900000},'vin':[{'is_coinbase':False}]}
        elif path == '/v1/fees/recommended':
            result = {'halfHourFee':2,'fastestFee':3,'hourFee':1,'minimumFee':1}
        elif path == '/tx' and request.method == 'POST':
            assert request.post_data == await route.request.frame.evaluate('document.getElementById("rawOutput").value')
            calls['post'] += 1
            await route.fulfill(status=200,body=f['signedTxid'])
            return
        elif path == f"/tx/{f['signedTxid']}/status":
            if calls['post']==0:
                await route.fulfill(status=404,body='Transaction not found')
                return
            result = {'confirmed':calls['confirmed'],'block_height':900100} if calls['confirmed'] else {'confirmed':False}
        else:
            raise AssertionError('Unexpected API request '+path)
        await route.fulfill(status=200,content_type='application/json',body=json.dumps(result))
    await ctx.route('https://mempool.space/**', api)
    if wallet:
        js = '''const F=__FIXTURE__;window.__calls={sign:0};window.__events={};window.__network='livenet';window.__reject=false;
        window.unisat={requestAccounts:async()=>[F.address],getAccounts:async()=>[F.address],getNetwork:async()=>window.__network,getPublicKey:async()=>F.publicKey,
          on:(event,handler)=>window.__events[event]=handler,
          signPsbt:async(psbt,options)=>{window.__calls.sign++;if(window.__reject)throw Error('用户拒绝签名');
            if(psbt!==F.unsignedPsbt)throw Error('Unexpected unsigned PSBT');
            if(options.autoFinalized!==true||options.toSignInputs.length!==1||options.toSignInputs[0].index!==0)throw Error('Signing options mismatch');
            if(window.__defer)await new Promise(resolve=>window.__resolve=resolve);return F.signedPsbt;}};'''.replace('__FIXTURE__',json.dumps(f))
        await ctx.add_init_script(js)
    page = await ctx.new_page()
    errors = []
    page.on('pageerror',lambda e:errors.append(str(e)))
    await page.goto(base)
    await page.wait_for_selector('#outputRows tr')
    return ctx,page,calls,errors

async def wait_done(page):
    await page.wait_for_function('!document.body.classList.contains("busy")')

async def build_connected(page):
    await page.locator('#connectBtn').click()
    await wait_done(page)
    assert '主网' in await page.locator('#walletStatus').inner_text()
    await page.locator('#loadBtn').click()
    await page.wait_for_selector('[data-utxo="0"]')
    await wait_done(page)
    assert await page.locator('[data-utxo="1"]').is_disabled()
    await page.locator('[data-utxo="0"]').check()
    await wait_done(page)
    assert await page.locator('#buildBtn').is_disabled()
    await page.locator('#assetCheck').check()
    await page.locator('#buildBtn').click()
    assert await page.locator('#outputRows tr').count()==20
    assert await page.locator('#signBtn').is_disabled()
    await page.locator('#reviewCheck').check()
    assert await page.locator('#signBtn').is_enabled()

async def main():
    RESULTS.mkdir(exist_ok=True)
    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self,*args): pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT/'dist')))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    checks=[]
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
        for kind in ['p2tr','p2wpkh']:
            ctx,page,calls,errors=await setup(browser,base,kind)
            if kind=='p2tr':
                assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                await page.screenshot(path=str(RESULTS/'desktop.png'),full_page=True)
            await build_connected(page)
            assert calls['post']==0
            assert await page.evaluate('__calls.sign')==0
            async with page.expect_download() as event:
                await page.locator('#downloadPsbtBtn').click()
            dl=await event.value
            await dl.save_as(RESULTS/f'{kind}-unsigned.psbt')
            assert (RESULTS/f'{kind}-unsigned.psbt').read_bytes().startswith(b'psbt\xff')
            await page.evaluate('__reject=true')
            await page.locator('#signBtn').click(); await wait_done(page)
            assert '拒绝' in await page.locator('#message').inner_text()
            assert await page.locator('#signedPanel').is_hidden()
            assert calls['post']==0
            await page.evaluate('__reject=false')
            await page.locator('#signBtn').click(); await wait_done(page)
            assert await page.locator('#signedPanel').is_visible()
            assert await page.locator('#signedTxid').inner_text()==FIXTURES[kind]['signedTxid']
            assert calls['post']==0
            assert await page.locator('#broadcastBtn').is_disabled()
            await page.locator('#broadcastCheck').check()
            calls['spent']=True
            await page.locator('#broadcastBtn').click(); await wait_done(page)
            assert calls['post']==0
            assert '已花费' in await page.locator('#message').inner_text()
            calls['spent']=False
            await page.locator('#broadcastBtn').click(); await wait_done(page)
            assert calls['post']==1
            assert '已广播' in await page.locator('#broadcastStatus').inner_text()
            assert await page.locator('#broadcastBtn').is_disabled()
            calls['confirmed']=True
            await page.locator('#statusBtn').click(); await wait_done(page)
            assert '已确认' in await page.locator('#broadcastStatus').inner_text()
            async with page.expect_download() as event:
                await page.locator('#exportOutputsBtn').click()
            dl=await event.value
            await dl.save_as(RESULTS/f'{kind}-outputs.json')
            outputs=json.loads((RESULTS/f'{kind}-outputs.json').read_text())
            assert len(outputs['outputs'])==20
            assert sum(int(v['sats']) for v in outputs['outputs'])+int(outputs['feeSats'])==1_000_000
            await page.evaluate("__network='testnet';__events.networkChanged({network:'testnet'})")
            assert await page.locator('#signedPanel').is_hidden()
            assert await page.locator('#signBtn').is_disabled()
            await page.locator('#connectBtn').click(); await wait_done(page)
            assert 'Mainnet' in await page.locator('#message').inner_text()
            assert not errors,errors
            checks.append(kind+' wallet: build/sign/reject/reverify/broadcast/status/export/network change')
            await ctx.close()
        # No extension and blocked API: manual import and externally signed PSBT remain usable.
        ctx,page,calls,errors=await setup(browser,base,wallet=False)
        await page.locator('#connectBtn').click(); await wait_done(page)
        assert '未检测到' in await page.locator('#message').inner_text()
        await page.locator('#manualDetails summary').click()
        f=FIXTURES['p2tr']
        for key,value in [('account',f['address']),('publicKey',f['publicKey']),('parentTxid',f['txid']),('parentHex',f['rawHex'])]:
            await page.locator('#'+key).fill(value)
        await page.locator('#importParentBtn').click(); await wait_done(page)
        assert '尚未联网核验' in await page.locator('#sourceInfo').inner_text()
        await page.locator('#assetCheck').check()
        await page.locator('#buildBtn').click()
        assert await page.locator('#signBtn').is_disabled()
        await page.locator('#reviewCheck').check()
        await page.locator('summary',has_text='导入其他钱包签好的 PSBT').click()
        await page.locator('#signedInput').fill(f['signedPsbt'])
        await page.locator('#verifySignedBtn').click(); await wait_done(page)
        assert await page.locator('#signedPanel').is_visible()
        assert calls['reads']==0 and calls['post']==0
        await page.locator('#broadcastCheck').check()
        calls['fail']=True
        await page.locator('#broadcastBtn').click(); await wait_done(page)
        assert calls['post']==0
        assert await page.locator('#signedPanel').is_visible()
        assert 'fetch' in (await page.locator('#message').inner_text()).lower()
        await page.locator('#count').fill('201')
        assert '参数无效' in await page.locator('#previewLabel').inner_text()
        assert await page.locator('#signedPanel').is_hidden()
        assert await page.locator('#downloadPsbtBtn').is_disabled()
        assert not errors,errors
        checks.append('no extension: offline parent import, signed PSBT verification, API failure, stale plan invalidation')
        await ctx.close()
        # Changes during a pending wallet signature cannot revive the old plan.
        ctx,page,calls,errors=await setup(browser,base)
        await build_connected(page)
        await page.evaluate('__defer=true')
        await page.locator('#signBtn').click()
        await page.wait_for_function('typeof __resolve==="function"')
        await page.evaluate("__events.accountsChanged([]);__resolve()")
        await wait_done(page)
        assert await page.locator('#signedPanel').is_hidden()
        assert calls['post']==0
        assert not errors,errors
        checks.append('account change while signature pending invalidates result')
        await ctx.close()
        # Phone layout, no extension needed to review defaults.
        ctx,page,calls,errors=await setup(browser,base,wallet=False,mobile=True)
        assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        await page.screenshot(path=str(RESULTS/'mobile.png'),full_page=True)
        await page.locator('[data-count="10"]').click()
        assert await page.locator('#outputRows tr').count()==10
        assert not errors,errors
        checks.append('390px mobile layout and 10-output preset')
        await ctx.close()
        await browser.close()
    server.shutdown()
    (RESULTS/'browser-results.json').write_text(json.dumps({'passed':checks,'real_btc_spent':False,'live_wallet_tested':False,'api':'intercepted fixture responses only'},ensure_ascii=False,indent=2))
    print(json.dumps({'passed':checks,'real_btc_spent':False},ensure_ascii=False,indent=2))

asyncio.run(main())
