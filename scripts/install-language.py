#!/usr/bin/env python3
"""Install a language pack into the game folder (the working directory).

usage: install-language.py CODE NAME URL MD5 SIZE

Downloads the pack from URL, checks its MD5, unpacks it (<CODE>/files/...)
into mods/languages/<CODE> in place of any earlier one, and records the
release in mods/languages/<CODE>/.release. SMS Launcher runs it through
texture-progress.py, which reports the download's progress.
"""
import hashlib
import json
import os
import shutil
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile

# The only source packs are downloaded from: an attacker who could point this
# installer at a URL of their choosing could also supply the MD5 digest that
# matches whatever file they host there, so the digest alone cannot be
# trusted as an integrity check. Pinning the origin closes that hole.
TRUSTED_RELEASE = 'https://github.com/chasem-dev/sms-hd-texture-extras/releases/download/'


def main():
    code, name, url, md5, size = sys.argv[1:6]
    if not code.replace('-', '').replace('_', '').isalnum():
        sys.exit('error: bad language code %r' % code)
    if not url.startswith(TRUSTED_RELEASE) or '..' in urllib.parse.urlparse(url).path.split('/'):
        sys.exit('error: refusing to download a language pack from an untrusted source (%s)' % url)
    install = os.path.join('mods', 'languages', code)
    os.makedirs(os.path.dirname(install), exist_ok=True)
    print('Downloading Super Mario Sunshine language packs (%s)' % name, flush=True)
    print('  from %s' % url, flush=True)
    tmp = tempfile.mkdtemp(prefix='.language-', dir=os.path.dirname(install))
    try:
        archive = os.path.join(tmp, 'pack.zip')
        req = urllib.request.Request(url, headers={'User-Agent': 'SMS Launcher language installer'})
        h = hashlib.md5()
        with urllib.request.urlopen(req) as r, open(archive, 'wb') as f:
            while True:
                chunk = r.read(1 << 16)
                if not chunk:
                    break
                h.update(chunk)
                f.write(chunk)
        if h.hexdigest() != md5:
            sys.exit('error: the download does not match the expected release (MD5 %s, expected %s)'
                     % (h.hexdigest(), md5))
        with zipfile.ZipFile(archive) as z:
            names = [n for n in z.namelist() if not n.endswith('/')]
            if not names or any(not n.startswith(code + '/files/') or '..' in n.split('/') for n in names):
                sys.exit('error: the archive is not laid out as expected (%s/files/...)' % code)
            z.extractall(tmp)
        with open(os.path.join(tmp, code, '.release'), 'w', encoding='utf-8') as f:
            json.dump({'name': name, 'file': os.path.basename(url), 'md5': md5}, f, indent=2, ensure_ascii=False)
        if os.path.isdir(install):
            shutil.rmtree(install)
        os.replace(os.path.join(tmp, code), install)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print('Installed %s in %s.' % (name, install), flush=True)


if __name__ == '__main__':
    main()
