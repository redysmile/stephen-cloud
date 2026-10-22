"""Package an already-built static frontend, with no keys, fixtures or test data."""
from pathlib import Path
import hashlib
import zipfile

root = Path(__file__).resolve().parents[1]
dist = root / 'dist'
assert (dist / 'index.html').is_file(), 'Run npm run build first'
out = root / 'btc-utxo-splitter-web.zip'
files = sorted(p for p in dist.rglob('*') if p.is_file())
manifest = '\n'.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(dist).as_posix()}' for p in files) + '\n'
guide = '''BTC MAINNET UTXO SPLITTER

1. Extract this complete ZIP. Keep index.html and assets/ together.
2. Deploy the directory to an HTTPS static host, or use a local HTTP server:
   python3 -m http.server 8080 --bind 127.0.0.1
   Then open http://127.0.0.1:8080 with UniSat installed.
3. Do not open with file://; wallet injection and module loading need localhost or HTTPS.
4. Connect UniSat on Bitcoin Mainnet. Use a dedicated plain-BTC funding address.
5. Select ONE confirmed UTXO. Independently ensure it contains no inscriptions,
   Runes, TAPEBIT or other protocol assets, and is not reserved for another transaction.
6. Choose 10/20/custom count, set fee rate, build preview, review and sign.
7. Signing does NOT broadcast. Confirm broadcasting separately.

No platform fee. Network fees are deducted before splitting. All outputs return
to the selected address. No private key or seed input. The app does not detect
protocol assets. Reads and broadcasting use https://mempool.space/api.

Tests use mock wallets and synthetic transactions. No real BTC was spent and no
real UniSat/mainnet end-to-end transaction was validated during development.
Repository: https://github.com/redysmile/stephen-cloud/tree/main/btc-utxo-splitter

_headers applies on Cloudflare Pages; configure equivalent headers on other hosts.
'''
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for p in files:
        z.write(p, p.relative_to(dist))
    z.writestr('SHA256SUMS.txt', manifest)
    z.writestr('START-HERE.txt', guide)
with zipfile.ZipFile(out) as z:
    assert z.testzip() is None
print(f'{out.name}: {len(files)} static files, {out.stat().st_size:,} bytes; archive verified')
