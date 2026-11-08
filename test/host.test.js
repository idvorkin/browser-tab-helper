// R7: the host for real: a spawned process, a real Unix socket in a temp directory, real native-messaging frames.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultManifestDir, encodeFrame, extensionIdForPath, frameReader, HOST_NAME, installHost, socketPath } from '../tools/host.js';

const HOST = fileURLToPath(new URL('../tools/host.js', import.meta.url));
const ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';

function tempDir() {
  // Short: a Unix socket path is limited to about 104 bytes on macOS.
  return realpathSync(mkdtempSync(join(tmpdir(), 'bth-')));
}

async function startHost(t, sock = join(tempDir(), 'cache', 'host.sock')) {
  const child = spawn(process.execPath, [HOST, ORIGIN], {
    env: { ...process.env, BROWSER_TAB_HELPER_SOCK: sock },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const fromHost = [];
  const waiters = [];
  child.stdout.on('data', frameReader((message) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else fromHost.push(message);
  }));
  const exited = new Promise((done) => child.on('exit', done));
  await new Promise((done, fail) => {
    child.stderr.on('data', (chunk) => {
      if (chunk.toString().includes('listening')) done();
    });
    child.on('exit', (code) => fail(new Error(`host exited early: ${code}`)));
  });
  t.after(async () => {
    child.kill();
    await exited;
    rmSync(dirname(dirname(sock)), { recursive: true, force: true });
  });
  return {
    child,
    sock,
    exited,
    nextRequest: () => (fromHost.length ? Promise.resolve(fromHost.shift()) : new Promise((done) => waiters.push(done))),
    answer: (message) => child.stdin.write(encodeFrame(message)),
  };
}

/** A client per the contract: writes its text, reads until the host closes. */
function ask(sock, text) {
  return new Promise((done, fail) => {
    const client = net.createConnection(sock, () => client.write(text));
    let answer = '';
    client.on('data', (chunk) => { answer += chunk; });
    client.on('end', () => done(answer));
    client.on('error', fail);
  });
}

test('a front request is answered with one line of JSON, then close', async (t) => {
  const host = await startHost(t);
  const answer = ask(host.sock, '{"type":"front"}\n');
  const request = await host.nextRequest();
  assert.equal(request.type, 'front');
  host.answer({ id: request.id, title: 'A page', url: 'https://a.test/', selection: 'picked' });
  const line = await answer;
  assert.ok(line.endsWith('\n'));
  assert.equal(line.indexOf('\n'), line.length - 1, 'exactly one line');
  assert.deepEqual(JSON.parse(line), { title: 'A page', url: 'https://a.test/', selection: 'picked' });
});

test('no selection is null, and only the contract fields go out', async (t) => {
  const host = await startHost(t);
  const answer = ask(host.sock, '{"type":"front"}\n');
  const { id } = await host.nextRequest();
  host.answer({ id, title: 'T', url: 'chrome://settings/', selection: null, extra: 'nope' });
  assert.deepEqual(JSON.parse(await answer), { title: 'T', url: 'chrome://settings/', selection: null });
});

test('an extension error comes back as {"error":str}', async (t) => {
  const host = await startHost(t);
  const answer = ask(host.sock, '{"type":"front"}\n');
  const { id } = await host.nextRequest();
  host.answer({ id, error: 'no front tab' });
  assert.deepEqual(JSON.parse(await answer), { error: 'no front tab' });
});

test('anything but a front request is refused without reaching the extension', async (t) => {
  const host = await startHost(t);
  assert.match(JSON.parse(await ask(host.sock, '{"type":"close-all"}\n')).error, /unknown request type/);
  assert.match(JSON.parse(await ask(host.sock, 'not json\n')).error, /not JSON/);
  assert.match(JSON.parse(await ask(host.sock, 'null\n')).error, /unknown request type/);
  const answer = ask(host.sock, '{"type":"front"}\n');
  const request = await host.nextRequest();
  assert.equal(request.id, 1, 'the refused requests never reached the extension');
  host.answer({ id: request.id, title: '', url: '', selection: null });
  await answer;
});

test('a silent extension gets an error rather than a hang', async (t) => {
  const host = await startHost(t);
  const answer = ask(host.sock, '{"type":"front"}\n');
  await host.nextRequest();
  assert.match(JSON.parse(await answer).error, /did not answer/);
});

test('concurrent clients each get their own answer', async (t) => {
  const host = await startHost(t);
  const first = ask(host.sock, '{"type":"front"}\n');
  const a = await host.nextRequest();
  const second = ask(host.sock, '{"type":"front"}\n');
  const b = await host.nextRequest();
  host.answer({ id: b.id, title: 'second', url: 'https://b.test/', selection: null });
  host.answer({ id: a.id, title: 'first', url: 'https://a.test/', selection: null });
  assert.equal(JSON.parse(await first).title, 'first');
  assert.equal(JSON.parse(await second).title, 'second');
});

test('frames split across writes still parse', async (t) => {
  const host = await startHost(t);
  const answer = ask(host.sock, '{"type":"front"}\n');
  const { id } = await host.nextRequest();
  const frame = encodeFrame({ id, title: 'slow', url: 'https://a.test/', selection: null });
  for (const byte of frame) host.child.stdin.write(Buffer.from([byte]));
  assert.equal(JSON.parse(await answer).title, 'slow');
});

test('a request split across writes still parses', async (t) => {
  const host = await startHost(t);
  const answer = new Promise((done, fail) => {
    const client = net.createConnection(host.sock, async () => {
      client.write('{"type":');
      await new Promise((later) => setTimeout(later, 20));
      client.write('"front"}\n');
    });
    let text = '';
    client.on('data', (chunk) => { text += chunk; });
    client.on('end', () => done(text));
    client.on('error', fail);
  });
  const { id } = await host.nextRequest();
  host.answer({ id, title: 'split', url: '', selection: null });
  assert.equal(JSON.parse(await answer).title, 'split');
});

test('the socket is mode 0600 in a 0700 directory, readable by the user alone', async (t) => {
  const host = await startHost(t);
  assert.ok(statSync(host.sock).isSocket());
  assert.equal(statSync(host.sock).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(host.sock)).mode & 0o777, 0o700);
});

test('an existing directory is tightened to 0700', async (t) => {
  const root = tempDir();
  const dir = join(root, 'cache');
  mkdirSync(dir, { mode: 0o755 });
  const host = await startHost(t, join(dir, 'host.sock'));
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.ok(existsSync(host.sock));
});

test('a stale socket file left by a crash is replaced', async (t) => {
  const root = tempDir();
  const dir = join(root, 'cache');
  mkdirSync(dir);
  const sock = join(dir, 'host.sock');
  writeFileSync(sock, 'stale');
  const host = await startHost(t, sock);
  assert.ok(statSync(sock).isSocket());
  const answer = ask(sock, '{"type":"front"}\n');
  const { id } = await host.nextRequest();
  host.answer({ id, title: 'live', url: '', selection: null });
  assert.equal(JSON.parse(await answer).title, 'live');
});

test('when Chrome goes away the host exits and removes its socket', async (t) => {
  const host = await startHost(t);
  host.child.stdin.end();
  assert.equal(await host.exited, 0);
  assert.ok(!existsSync(host.sock));
});

test('run with no origin it prints usage rather than taking the socket', () => {
  const sock = join(tempDir(), 'host.sock');
  const result = spawnSync(process.execPath, [HOST], { env: { ...process.env, BROWSER_TAB_HELPER_SOCK: sock }, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage/);
  assert.ok(!existsSync(sock));
});

test('the default socket path is the contract path', () => {
  assert.match(socketPath({}), /\/Library\/Caches\/browser-tab-helper\/host\.sock$/);
  assert.equal(socketPath({ BROWSER_TAB_HELPER_SOCK: '/tmp/x.sock' }), '/tmp/x.sock');
});

test('host install writes a working manifest into the directory it is pointed at', () => {
  const dir = join(tempDir(), 'hosts');
  const result = spawnSync(process.execPath, [HOST, 'install', 'abcdefghijklmnopabcdefghijklmnop', '--dir', dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(join(dir, `${HOST_NAME}.json`), 'utf8'));
  assert.equal(manifest.name, HOST_NAME);
  assert.equal(manifest.type, 'stdio');
  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/']);
  accessSync(manifest.path, constants.X_OK);
  assert.ok(manifest.path.startsWith('/'), 'Chrome needs an absolute path');
});

test('the installed launcher starts the host with no PATH at all', async () => {
  const root = tempDir();
  const { launcherPath } = installHost({ dir: join(root, 'hosts'), extensionId: 'a'.repeat(32) });
  const sock = join(root, 'launched.sock');
  const child = spawn(launcherPath, [ORIGIN], { env: { BROWSER_TAB_HELPER_SOCK: sock }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((done) => child.on('exit', done));
  await new Promise((done) => child.stderr.on('data', (chunk) => { if (chunk.toString().includes('listening')) done(); }));
  assert.ok(statSync(sock).isSocket());
  child.stdin.end();
  assert.equal(await exited, 0);
});

test('host install defaults to the id of an unpacked extension loaded from the checkout', () => {
  const checkout = realpathSync(fileURLToPath(new URL('..', import.meta.url))).replace(/\/$/, '');
  const { extensionId } = installHost({ dir: join(tempDir(), 'hosts') });
  assert.equal(extensionId, extensionIdForPath(checkout));
});

test('an unpacked id is 32 letters from a to p', () => {
  // SHA-256 of "/x" begins b3d1db318671a024a7e4b433389f8820, mapped digit by digit (0 to a, f to p).
  assert.equal(extensionIdForPath('/x'), 'ldnbnldbighbkacekhoeledddijpiica');
  assert.match(extensionIdForPath('/some/checkout'), /^[a-p]{32}$/);
});

test('a bad id is refused', () => {
  const result = spawnSync(process.execPath, [HOST, 'install', 'NOT-AN-ID', '--dir', join(tempDir(), 'hosts')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not an extension id/);
});

test('off macOS, the default paths fail clearly rather than pointing where the browser will not look', () => {
  assert.throws(() => defaultManifestDir('linux'), /macOS/);
  assert.throws(() => socketPath({}, 'linux'), /macOS/);
  assert.equal(socketPath({ BROWSER_TAB_HELPER_SOCK: '/tmp/x.sock' }, 'linux'), '/tmp/x.sock', 'an explicit path still works');
  assert.match(defaultManifestDir('darwin'), /Microsoft Edge\/NativeMessagingHosts$/);
});

test('off macOS, install with no directory says so; with one it still works', () => {
  // In a child with its own HOME: if this ever regresses, installHost writes to the default directory, which on a
  // developer's Mac is their real Chrome profile. It did exactly that once, when this test ran in-process.
  const home = tempDir();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { homedir } from 'node:os';
    import { installHost } from ${JSON.stringify(HOST)};
    console.log(homedir());
    try {
      installHost({ extensionId: ${JSON.stringify('a'.repeat(32))}, platform: 'linux' });
      console.log('WROTE');
    } catch (error) {
      console.log(error.message);
    }`], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  const [childHome, outcome] = child.stdout.trim().split('\n');
  assert.equal(childHome, home, 'the child cannot reach the real home');
  assert.match(outcome, /macOS/);
  assert.ok(!existsSync(join(home, 'Library')), 'nothing written');
  const dir = join(tempDir(), 'hosts');
  assert.ok(installHost({ dir, extensionId: 'a'.repeat(32), platform: 'linux' }).manifestPath.startsWith(dir));
});

test('the tools run when started through a symlink, as an npm bin is, and not when imported', async () => {
  const dir = tempDir();
  const link = join(dir, 'host');
  symlinkSync(HOST, link);
  const result = spawnSync(process.execPath, [link], { encoding: 'utf8' });
  assert.equal(result.status, 2, 'usage, which proves main ran');
  assert.match(result.stderr, /usage/);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(HOST)}); console.log('imported')`], { encoding: 'utf8' });
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout.trim(), 'imported');
});
