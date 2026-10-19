#!/usr/bin/env python3
"""Build an unpacked extension and a local native host. No packages to install."""
import argparse, base64, hashlib, json, pathlib, shutil, subprocess, sys, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description='Build the browser extension and optional macOS integration.')
parser.add_argument('--browser-only', action='store_true', help='Package the extension without Swift or macOS tools')
args = parser.parse_args()
manifest = ROOT / 'extension/manifest.json'
data = json.loads(manifest.read_text(encoding='utf-8'))
if not data.get('key'):
    # Only the public key is kept. It fixes the unpacked extension ID across builds.
    with tempfile.TemporaryDirectory() as temp:
        key = pathlib.Path(temp) / 'key.pem'
        subprocess.run(['openssl','genrsa','-out',str(key),'2048'],check=True,capture_output=True)
        public = subprocess.check_output(['openssl','rsa','-in',str(key),'-pubout','-outform','DER'],stderr=subprocess.DEVNULL)
    data['key'] = base64.b64encode(public).decode()
    manifest.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
extension_id = ''.join(chr(ord('a')+int(c,16)) for c in hashlib.sha256(base64.b64decode(data['key'])).hexdigest()[:32])
IGNORE = shutil.ignore_patterns('.DS_Store','__pycache__','*.log')
def fresh(path):
    # Rebuild from scratch so files removed from the source never linger in a release.
    if path.exists(): shutil.rmtree(path)
    path.mkdir(parents=True)
    return path
browser = fresh(ROOT / 'dist/BBReader-browser')
shutil.copytree(ROOT/'extension',browser/'extension',ignore=IGNORE)
shutil.copy2(ROOT/'README.md',browser/'使用说明.md')
shutil.copy2(ROOT/'LICENSE',browser/'LICENSE')
shutil.make_archive(str(ROOT/'dist/BBReader-browser'),'zip',ROOT/'dist','BBReader-browser')
print(f'Browser package: {ROOT / "dist/BBReader-browser.zip"}')
if args.browser_only or sys.platform != 'darwin':
    sys.exit(0)
out = fresh(ROOT / 'dist/BBReader')
shutil.copytree(ROOT/'extension',out/'extension',ignore=IGNORE)
(out/'native').mkdir(exist_ok=True)
# Compile from the project root with relative source paths so the binaries do not embed the builder's home directory.
swift = ['swiftc','-O','-target','arm64-apple-macosx13.0','-module-cache-path','dist/module-cache']
subprocess.run(swift+['native/main.swift','native/reminders.swift','native/auth.swift','-o',str(out/'native/bbreader-host')],check=True,cwd=ROOT)
subprocess.run(swift+['native/picker.swift','-o',str(out/'native/bbreader-picker')],check=True,cwd=ROOT)
(out/'native/extension-origin.txt').write_text(f'chrome-extension://{extension_id}/\n')
subprocess.run([str(out/'native/bbreader-host'),'--self-test'],check=True)
installer=out/'安装本地助手.command'
installer.write_text('#!/bin/zsh\nset -eu\ncd -- "${0:A:h}"\n./native/bbreader-host --install\n./native/bbreader-picker --install\nprintf "\\n按回车关闭此窗口。"\nread -r reply\n')
installer.chmod(0o755)
if (ROOT/'README.md').exists(): shutil.copy2(ROOT/'README.md',out/'使用说明.md')
shutil.copy2(ROOT/'LICENSE',out/'LICENSE')
(ROOT/'dist/extension-id.txt').write_text(extension_id+'\n')
shutil.make_archive(str(ROOT/'dist/BBReader-macOS-arm64'),'zip',ROOT/'dist','BBReader')
print(f'Extension ID: {extension_id}\nPackage: {out}')
