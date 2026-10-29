"""Reuse a verified release helper only when its sources/build contract match.

The source checkout remains the build authority. Only the CI workspace compile
recipe skips an unchanged Rust helper; normal SDK builds are unaffected.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
TAG = 'v2026.10.27'
REPO = 'zdabing/Z_bett'

def command(*args):
    return subprocess.check_output(args, text=True).strip()

def download(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Bettbox-build'})
    with urllib.request.urlopen(request, timeout=180) as response:
        return response.read()

def main():
    target, apk = os.environ['PACKAGE_TARGET'], os.environ['APK_TOOL']
    assert target in ('aarch64_generic', 'x86_64')
    subprocess.run(['git', 'fetch', '--no-tags', 'origin', 'refs/tags/' + TAG], check=True)
    previous = command('git', 'rev-parse', 'FETCH_HEAD')
    assert not command('git', 'diff', '--name-only', previous, 'HEAD', '--', 'bettbox/forge'), 'forge source changed: full build required'
    for package in ('bettbox', 'luci-app-bettbox'):
        before = command('git', 'show', previous + ':' + package + '/Makefile')
        after = (ROOT / package / 'Makefile').read_text().strip()
        strip_release = lambda text: re.sub(r'^PKG_RELEASE:=.*$', 'PKG_RELEASE:=verified', text, flags=re.M)
        assert strip_release(before) == strip_release(after), 'build/install contract changed: full build required'
    release = json.loads(download('https://api.github.com/repos/' + REPO + '/releases/tags/' + TAG))
    assert not release['draft'] and not release['prerelease']
    filename = 'bettbox-1.19.33-r4-' + target + '.apk'
    asset = next(a for a in release['assets'] if a['name'] == filename)
    payload = download(asset['browser_download_url'])
    assert asset['size'] == len(payload) and asset['digest'] == 'sha256:' + hashlib.sha256(payload).hexdigest(), 'release digest mismatch'
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary); package = directory / filename; package.write_bytes(payload)
        subprocess.run([apk, '--allow-untrusted', 'verify', str(package)], check=True)
        files = directory / 'files'; files.mkdir()
        subprocess.run([apk, '--allow-untrusted', 'extract', '--destination', str(files), str(package)], check=True)
        binary = files / 'usr/bin/bettbox-forge'
        header = binary.read_bytes()[:20]
        assert header[:6] == b'\x7fELF\x02\x01' and int.from_bytes(header[18:20], 'little') == (183 if target == 'aarch64_generic' else 62), 'helper architecture mismatch'
        dest = ROOT / 'bettbox/prebuilt'; dest.mkdir()
        (dest / 'bettbox-forge').write_bytes(binary.read_bytes())
    makefile = ROOT / 'bettbox/Makefile'; text = makefile.read_text()
    assert text.count('$(call Build/Compile/Cargo,.bettbox-forge)') == 1
    text = text.replace('PKG_BUILD_DEPENDS:=golang/host rust/host', 'PKG_BUILD_DEPENDS:=golang/host')
    text = text.replace('include $(TOPDIR)/feeds/packages/lang/rust/rust-package.mk', '# Verified, unchanged forge helper supplied by CI')
    text = text.replace('$(call Build/Compile/Cargo,.bettbox-forge)', '$(INSTALL_DIR) $(PKG_INSTALL_DIR)/bin\n\t$(INSTALL_BIN) $(CURDIR)/prebuilt/bettbox-forge $(PKG_INSTALL_DIR)/bin/bettbox-forge')
    makefile.write_text(text)
    print(json.dumps({'forge_release': TAG, 'forge_source_commit': previous, 'source_matches': True, 'asset_sha256': hashlib.sha256(payload).hexdigest(), 'binary_sha256': hashlib.sha256((dest / 'bettbox-forge').read_bytes()).hexdigest()}))

if __name__ == '__main__':
    main()
