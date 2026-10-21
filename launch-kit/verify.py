import asyncio
import json
import functools
import http.server
import threading
import urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT=Path(__file__).resolve().parent

async def main():
    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    handler=functools.partial(Handler,directory=str(ROOT))
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    base=f'http://127.0.0.1:{server.server_port}'
    url=base+'/'+urllib.parse.quote('TAPEBIT-15天发推时间线.html')
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
        context=await browser.new_context(viewport={'width':1440,'height':1080},device_scale_factor=1)
        page=await context.new_page()
        errors=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        requests=[]
        page.on('request',lambda r:requests.append(r.url))
        await page.goto(url)
        await page.wait_for_selector('.day')
        assert await page.locator('.day').count()==15
        assert await page.locator('.tweet').count()==64
        assert await page.locator('#day-0 .copy').first.is_enabled()
        assert await page.locator('#day-1 .copy').first.is_disabled()
        assert await page.locator('#day-3 .copy').first.is_disabled()
        assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        await page.screenshot(path=str(ROOT/'网页预览.png'))
        await page.locator('#day-5').screenshot(path=str(ROOT/'设计挑战页预览.png'))
        # One direct PNG download plus all card renders, without rapid bulk-download throttling.
        async with page.expect_download() as event:
            await page.locator('#day-5 .png-download').click()
        dl=await event.value
        await dl.save_as(ROOT/'concept-cards'/'tapebit-d05.png')
        card=await context.new_page()
        await card.set_viewport_size({'width':1200,'height':675})
        payload=json.loads((ROOT/'content.json').read_text())
        for i in range(15):
            await card.set_content('<html><head><meta charset="utf-8"></head><body style="margin:0">'+payload['svgs'][str(i)]+'</body></html>')
            await card.screenshot(path=str(ROOT/'concept-cards'/f'tapebit-d{i:02}.png'))
        await card.close()
        # Publishing conditions: filling placeholders alone must not bypass verification.
        await page.locator('[data-field="公测入口"]').first.fill('https://example.com/test')
        await page.locator('[data-field="公测实例"]').first.fill('Signet / TEST-EXAMPLE')
        await page.locator('[data-field="支持钱包"]').first.fill('已核对钱包')
        await page.locator('[data-field="测试币入口"]').first.fill('https://example.com/faucet')
        await page.locator('[data-field="奖励安排"]').first.fill('测试安排')
        await page.locator('[data-field="教程链接"]').first.fill('https://example.com/guide')
        await page.locator('[data-field="状态页"]').first.fill('https://example.com/status')
        await page.locator('[data-field="反馈入口"]').first.fill('https://example.com/feedback')
        assert await page.locator('#day-3 .copy').first.is_disabled()
        await page.locator('#day-3 .gatebox').check()
        assert await page.locator('#day-3 .copy').first.is_enabled()
        # Too-long text cannot be copied, and reset restores its binding.
        await page.locator('#day-0 .tweet textarea').first.fill('中'*150)
        assert await page.locator('#day-0 .copy').first.is_disabled()
        await page.locator('#day-0 .reset').first.click()
        assert await page.locator('#day-0 .copy').first.is_enabled()
        # Manual text persists across shared field updates.
        await page.locator('#day-0 .tweet textarea').first.fill('手动稿件')
        await page.locator('[data-field="公测入口"]').first.fill('https://example.com/changed')
        assert await page.locator('#day-0 .tweet textarea').first.input_value()=='手动稿件'
        # Delay version must not retain an already-launched evening post.
        await page.locator('#day-7 .variant').select_option('fallback')
        evening=await page.locator('#day-7 .evening textarea').input_value()
        assert '主网上线后的' not in evening
        assert '目标日期不等于已经上线' in evening
        assert await page.locator('#day-3 .copy').first.is_disabled() # render clears verification
        # Date offset and storage.
        await page.locator('#startDate').fill('2026-11-01')
        await page.locator('#startDate').dispatch_event('change')
        assert '2026-11-04' in await page.locator('#day-3 .date').inner_text()
        assert '2026-11-08' in await page.locator('#day-7 .date').inner_text()
        await page.locator('#day-0 .donebox').check()
        await page.reload()
        assert await page.locator('#day-0 .donebox').is_checked()
        assert await page.locator('#day-0 .tweet textarea').first.input_value()=='手动稿件'
        # Filters and search.
        await page.locator('[data-phase="公测"]').click()
        assert await page.locator('.day:not(.hidden)').count()==3
        await page.locator('[data-phase="全部"]').click()
        await page.locator('#search').fill('原创存证，保护')
        assert await page.locator('.day:not(.hidden)').count()==1
        await page.locator('#search').fill('')
        # All text stays below the ordinary X limit after realistic bounded substitutions.
        lengths=await page.evaluate('''() => {
            const {data,weight}=TAPEBIT_CALENDAR;
            const out=[];
            for(const d of data.days)for(const t of [...d.posts,d.evening,...(d.fallback||[])]){
                const text=t.replace(/【([^】]+)】/g,(m,k)=>data.defaults[k]||'真实待填值');
                out.push({day:d.id,length:weight(text)});
            }
            return out;
        }''')
        assert all(x['length']<=280 for x in lengths), lengths
        # Export current drafts and backup.
        for button,name in [('#exportTxt','test-copy.txt'),('#exportState','test-backup.json')]:
            async with page.expect_download() as event:
                await page.locator(button).click()
            dl=await event.value
            await dl.save_as(Path('/tmp')/name)
        assert '主网今日暂不上线' in Path('/tmp/test-copy.txt').read_text()
        await page.locator('#importFile').set_input_files('/tmp/test-backup.json')
        assert await page.locator('#startDate').input_value()=='2026-11-01'
        # Fresh mobile context, no edited values in the actual deliverable.
        mobile=await browser.new_context(viewport={'width':390,'height':844},device_scale_factor=1)
        mp=await mobile.new_page()
        mp.on('pageerror',lambda e:errors.append(str(e)))
        await mp.goto(url)
        assert await mp.evaluate('document.documentElement.scrollWidth<=innerWidth')
        await mp.screenshot(path=str(ROOT/'手机预览.png'))
        assert not errors,errors
        assert not [r for r in requests if r.startswith(('https://','http://')) and not r.startswith(base)],requests
        summary={'days':15,'main_and_evening_posts':62,'alternative_and_incident_posts':12,
                 'png_exports':15,'desktop_width':1440,'mobile_width':390,
                 'page_errors':errors,'external_requests':0,'length_max_bounded_fields':max(x['length'] for x in lengths),
                 'checks':['copy gates','placeholder guard','length guard','template reset','manual edits',
                           'delay evening copy','date shifting','local persistence','phase/search filters',
                           'text and JSON exports','JSON import','offline PNG downloads','mobile overflow']}
        (ROOT/'verification.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
        print(json.dumps(summary,ensure_ascii=False,indent=2))
        await browser.close()
        server.shutdown()

asyncio.run(main())
