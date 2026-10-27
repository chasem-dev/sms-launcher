'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const { activityFromLine } = require('../src/progress');

const python = process.platform === 'win32' ? 'python' : 'python3';
const pythonReady = spawnSync(python, ['--version']).status === 0;

test('texture progress reaches the launcher over pipes while the installer keeps ownership of checks and failures',
  { skip: !pythonReady && 'Python is needed to exercise the portable installer adapter' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms texture progress '));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const payload = Buffer.alloc(3 * 1024 * 1024, 'test texture archive');
    const checksum = crypto.createHash('sha256').update(payload).digest('hex');
    const server = http.createServer((req, res) => {
      if (req.url !== '/unknown') res.setHeader('Content-Length', payload.length);
      else { res.write(payload.subarray(0, 65536)); res.end(payload.subarray(65536)); return; }
      if (req.url !== '/known') { res.end(payload); return; }
      res.write(payload.subarray(0, 1024 * 1024));
      setTimeout(() => {
        res.write(payload.subarray(1024 * 1024, 2 * 1024 * 1024));
        setTimeout(() => res.end(payload.subarray(2 * 1024 * 1024)), 600);
      }, 600);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const installer = path.join(root, 'existing installer.py');
    fs.writeFileSync(installer, `import hashlib, os, sys, urllib.request
assert sys.argv[1:] == os.environ.get('TEST_TEXTURE_ARGS', 'textures').split()
with urllib.request.urlopen(os.environ['TEST_TEXTURE_URL']) as response, open('archive.part', 'wb') as target:
    while True:
        chunk = response.read(65536)
        if not chunk:
            break
        target.write(chunk)
with open('archive.part', 'rb') as downloaded:
    checksum = hashlib.sha256(downloaded.read()).hexdigest()
if checksum != os.environ['TEST_TEXTURE_CHECKSUM']:
    sys.exit('error: the download does not match the expected release')
print('Unpacking GMS.7z', flush=True)
with open('installed.flag', 'w') as installed:
    installed.write(checksum)
print('Installed 1 textures in mods/textures/GMS.', flush=True)
`);
    const run = (route, expected = checksum, args = []) => promisify(execFile)(python,
      [path.resolve(__dirname, '..', 'scripts', 'texture-progress.py'), installer, ...args],
      { cwd: root, timeout: 15000, env: { ...process.env, TEST_TEXTURE_ARGS: args.join(' ') || 'textures',
        TEST_TEXTURE_URL: `http://127.0.0.1:${server.address().port}/${route}`, TEST_TEXTURE_CHECKSUM: expected } });

    const known = await run('known');
    const states = known.stdout.split(/\r?\n/).map(activityFromLine).filter(Boolean);
    assert.ok(states.some(state => state.percent > 0 && state.percent < 100), known.stdout);
    assert.ok(states.some(state => state.percent === 100 && state.detail.startsWith('Downloading')));
    assert.deepEqual(states.slice(-3), [
      { detail: 'Checking HD textures', percent: null },
      { detail: 'Installing HD textures', percent: null },
      { detail: 'HD textures installed', percent: 100 }
    ]);
    assert.equal(fs.readFileSync(path.join(root, 'installed.flag'), 'utf8'), checksum);
    const unknown = await run('unknown');
    const downloadStates = unknown.stdout.split(/\r?\n/).map(activityFromLine)
      .filter(state => state?.detail.startsWith('Downloading'));
    assert.ok(downloadStates.length >= 2);
    assert.ok(downloadStates.every(state => state.percent === null));
    fs.rmSync(path.join(root, 'installed.flag'));
    await assert.rejects(run('bad', 'wrong checksum'), error => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /Checking HD texture download/);
      assert.doesNotMatch(error.stdout, /Unpacking|Installed/);
      assert.match(error.stderr, /does not match the expected release/);
      return true;
    });
    assert.equal(fs.existsSync(path.join(root, 'installed.flag')), false);
    // The texture extras run the same installer with their own arguments.
    const extras = await run('known', checksum, ['extras', '--if-outdated']);
    assert.match(extras.stdout, /Texture download: \d+\/\d+ bytes/);
    assert.equal(fs.readFileSync(path.join(root, 'installed.flag'), 'utf8'), checksum);
  });

test('a game download that drops, stalls or meets a busy server carries on from where it stopped',
  { skip: !pythonReady && 'Python is needed to exercise the download wrapper' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms resume downloads '));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const payload = crypto.randomBytes(1024 * 1024);
    const checksum = crypto.createHash('sha256').update(payload).digest('hex');
    const half = payload.length / 2;
    const requests = [];
    const serve = (req, res) => {
      const route = req.url.slice(1);
      const range = req.headers.range?.match(/^bytes=(\d+)-$/);
      const first = !requests.some(seen => seen.route === route);
      requests.push({ route, range: req.headers.range || null, ifRange: req.headers['if-range'] || null });
      if (route === 'missing') { res.writeHead(404); res.end(); return; }
      // As GitHub's release links do: a redirect to another host that serves the file.
      if (route === 'release') {
        res.writeHead(302, { Location: `http://127.0.0.1:${assets.address().port}/asset` }); res.end(); return;
      }
      if (route === 'busy' && first) { res.writeHead(503); res.end(); return; }
      if (range && route !== 'no-range') {
        const start = Number(range[1]);
        res.writeHead(206, { 'Content-Length': payload.length - start, ETag: '"v1"',
          'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}` });
        res.end(payload.subarray(start));
        return;
      }
      res.writeHead(200, { 'Content-Length': payload.length, ETag: '"v1"' });
      if (!first || route === 'busy') { res.end(payload); return; }
      // The first try sends half the file, then drops the connection or goes quiet.
      res.write(payload.subarray(0, half), () => {
        if (route !== 'stall') setTimeout(() => res.socket.destroy(), 50);
      });
    };
    const server = http.createServer(serve);
    // GitHub's download servers answer a request for another host with "Domain Not Found".
    const assets = http.createServer((req, res) => {
      if (req.headers.host !== `127.0.0.1:${assets.address().port}`) {
        requests.push({ route: 'wrong host', host: req.headers.host });
        res.writeHead(500, 'Domain Not Found'); res.end(); return;
      }
      serve(req, res);
    });
    for (const listening of [server, assets]) {
      await new Promise(resolve => listening.listen(0, '127.0.0.1', resolve));
      t.after(() => { listening.closeAllConnections(); return new Promise(resolve => listening.close(resolve)); });
    }
    const driver = path.join(root, 'driver.py');
    fs.writeFileSync(driver, `import hashlib, sys, urllib.request
sys.path.insert(0, ${JSON.stringify(path.resolve(__dirname, '..', 'scripts'))})
import resume_downloads
resume_downloads.TIMEOUT = 1
resume_downloads.pause = lambda attempt: None
resume_downloads.install()
request = urllib.request.Request(sys.argv[1], headers={'User-Agent': 'test'})
try:
    with urllib.request.urlopen(request) as response:
        digest = hashlib.sha256()
        while True:
            chunk = response.read(65536)
            if not chunk:
                break
            digest.update(chunk)
except OSError as error:
    sys.exit('failed: %s' % error)
print(digest.hexdigest())
`);
    const run = route => promisify(execFile)(python, [driver, `http://127.0.0.1:${server.address().port}/${route}`],
      { cwd: root, timeout: 20000 });
    const routeRequests = route => requests.filter(seen => seen.route === route);

    for (const route of ['drop', 'stall']) {
      const { stdout } = await run(route);
      assert.equal(stdout.trim().split('\n').at(-1), checksum, route);
      assert.match(stdout, /download stopped at .*resuming \(try 2 of 5\)/, route);
      assert.deepEqual(routeRequests(route).map(seen => seen.range), [null, `bytes=${half}-`], route);
      assert.equal(routeRequests(route)[1].ifRange, '"v1"');
    }
    // A release link resumes at the host it redirects to, asked for by its own name.
    assert.equal((await run('release')).stdout.trim().split('\n').at(-1), checksum);
    assert.deepEqual(routeRequests('release').length, 2);
    assert.deepEqual(routeRequests('asset').map(seen => seen.range), [null, `bytes=${half}-`]);
    assert.deepEqual(routeRequests('wrong host'), []);
    // A server that can't resume sends the whole file again: the part already had is skipped.
    assert.equal((await run('no-range')).stdout.trim().split('\n').at(-1), checksum);
    // A server that is briefly down is asked again.
    const busy = await run('busy');
    assert.equal(busy.stdout.trim().split('\n').at(-1), checksum);
    assert.match(busy.stdout, /could not connect \(HTTP Error 503.*trying again \(2 of 5\)/);
    // A file that isn't there fails at once.
    await assert.rejects(run('missing'), /HTTP Error 404/);
    assert.equal(routeRequests('missing').length, 1);
  });

test('a download stopped partway carries on from the kept part next time, unless the file changed',
  { skip: !pythonReady && 'Python is needed to exercise the download wrapper' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms kept downloads '));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const original = crypto.randomBytes(1024 * 1024), changed = crypto.randomBytes(1024 * 1024);
    const sha = data => crypto.createHash('sha256').update(data).digest('hex');
    const half = original.length / 2;
    let version = 'v1', stall = true;
    const requests = [];
    const server = http.createServer((req, res) => {
      const route = req.url.slice(1), payload = version === 'v1' ? original : changed;
      const range = req.headers.range?.match(/^bytes=(\d+)-$/);
      requests.push({ route, range: req.headers.range || null, ifRange: req.headers['if-range'] || null });
      const current = req.headers['if-range'] === undefined || req.headers['if-range'] === `"${version}"`;
      if (range && current && route !== 'no-range') {
        const start = Number(range[1]);
        res.writeHead(206, { 'Content-Length': payload.length - start, ETag: `"${version}"`,
          'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}` });
        res.end(payload.subarray(start));
        return;
      }
      res.writeHead(200, { 'Content-Length': payload.length, ETag: `"${version}"` });
      // Half the file, then nothing: the player stops the launcher.
      if (stall) res.write(payload.subarray(0, half));
      else res.end(payload);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const driver = path.join(root, 'driver.py');
    fs.writeFileSync(driver, `import hashlib, sys, urllib.request
sys.path.insert(0, ${JSON.stringify(path.resolve(__dirname, '..', 'scripts'))})
import resume_downloads
resume_downloads.install()
with urllib.request.urlopen(sys.argv[1]) as response:
    digest = hashlib.sha256()
    while True:
        chunk = response.read(65536)
        if not chunk:
            break
        digest.update(chunk)
print(digest.hexdigest())
`);
    const game = path.join(root, 'game');
    const kept = path.join(game, 'mods', '.downloads', 'resume');
    fs.mkdirSync(game);
    const url = route => `http://127.0.0.1:${server.address().port}/${route}`;
    const run = route => promisify(execFile)(python, [driver, url(route)], { cwd: game, timeout: 20000 });
    const keptBytes = () => (fs.existsSync(kept) ? fs.readdirSync(kept) : [])
      .filter(name => name.endsWith('.part')).reduce((sum, name) => sum + fs.statSync(path.join(kept, name)).size, 0);
    // Starts a download and kills it, as Stop does, once what the server sent
    // (half the file, then nothing) is kept on disk.
    async function stopHalfway(route) {
      stall = true;
      const child = execFile(python, [driver, url(route)], { cwd: game });
      let stderr = '';
      child.stderr.on('data', data => { stderr += data; });
      const exited = new Promise(resolve => child.on('exit', resolve));
      try {
        for (let waited = 0; keptBytes() < half; waited += 50) {
          assert.ok(waited < 15000, `the download was not kept: ${keptBytes()} of ${half} bytes. ${stderr}`);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } finally {
        child.kill('SIGKILL');
        await exited;
        stall = false;
      }
      assert.equal(keptBytes(), half);
    }
    const of = route => requests.filter(seen => seen.route === route).map(({ range, ifRange }) => [range, ifRange]);

    await stopHalfway('file');
    const resumed = await run('file');
    assert.equal(resumed.stdout.trim().split('\n').at(-1), sha(original));
    assert.match(resumed.stdout, /carrying on from the .* downloaded before/);
    assert.deepEqual(of('file'), [[null, null], [null, null], [`bytes=${half}-`, '"v1"']]);
    // A finished download leaves nothing kept.
    assert.deepEqual(fs.readdirSync(kept), []);

    // The file changed on the server since: the download starts over.
    await stopHalfway('changes');
    version = 'v2';
    const fresh = await run('changes');
    assert.equal(fresh.stdout.trim().split('\n').at(-1), sha(changed));
    assert.doesNotMatch(fresh.stdout, /carrying on/);
    assert.deepEqual(of('changes'), [[null, null], [null, null]]);
    assert.deepEqual(fs.readdirSync(kept), []);

    // A server that can't resume sends the whole file to the ranged request: it starts over too.
    version = 'v1';
    await stopHalfway('no-range');
    const whole = await run('no-range');
    assert.equal(whole.stdout.trim().split('\n').at(-1), sha(original));
    assert.doesNotMatch(whole.stdout, /carrying on/);
    assert.deepEqual(of('no-range'), [[null, null], [null, null], [`bytes=${half}-`, '"v1"']]);
    assert.deepEqual(fs.readdirSync(kept), []);
  });

test('parts of a file (range requests, as the Eclipse textures installer makes) leave the progress to the installer',
  { skip: !pythonReady && 'Python is needed to exercise the portable installer adapter' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms texture ranges '));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const payload = Buffer.alloc(256 * 1024, 'eclipse textures');
    const server = http.createServer((req, res) => {
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (!range) { res.writeHead(200, { 'Content-Length': payload.length }); res.end(payload); return; }
      const [start, end] = [Number(range[1]), Number(range[2])];
      res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${payload.length}` });
      res.end(payload.subarray(start, end + 1));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const installer = path.join(root, 'ranges.py');
    fs.writeFileSync(installer, `import os, urllib.request
url = os.environ['TEST_TEXTURE_URL']
for start in range(0, 4 * 65536, 65536):
    req = urllib.request.Request(url, headers={'Range': 'bytes=%d-%d' % (start, start + 65535)})
    with urllib.request.urlopen(req) as r:
        got = b''.join(iter(lambda: r.read(8192), b''))  # to the end, as a download reads
        assert r.status == 206 and len(got) == 65536
    print('Eclipse texture download: %d/%d bytes (%d/4 textures)' % (start + 65536, 4 * 65536, start // 65536 + 1), flush=True)
with urllib.request.urlopen(url) as r:
    assert len(b''.join(iter(lambda: r.read(8192), b''))) == ${payload.length}
`);
    const { stdout } = await promisify(execFile)(python, [path.resolve(__dirname, '..', 'scripts', 'texture-progress.py'), installer],
      { cwd: root, env: { ...process.env, TEST_TEXTURE_URL: `http://127.0.0.1:${server.address().port}/pack.zip` } });
    const lines = stdout.trim().split(/\r?\n/);
    assert.deepEqual(lines.filter(line => line.startsWith('Eclipse texture download:')).map(line => activityFromLine(line).percent),
      [25, 50, 75, 100]);
    assert.ok(lines.filter(line => line.startsWith('Texture download:')).every(line => line.endsWith(`/${payload.length} bytes`)),
      'only the whole file reports its own bytes');
    assert.ok(lines.some(line => line.startsWith('Texture download: ')), 'the whole file still reports');
    assert.equal(lines.filter(line => line === 'Checking HD texture download').length, 1);
  });
