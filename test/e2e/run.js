#!/usr/bin/env node
// The extension in a real browser, run by hand with `npm run test:e2e`; `npm test` stays browser-free.
//
// Uses Playwright's cached Chromium or the binary in $CHROMIUM, never an installed Chrome: always --headless=new, a
// temp profile, a mock keychain, and temp paths for the socket, host manifest and log. Pages come from a local server.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../../tools/bridge.js';
import { isEntryPoint } from '../../tools/entry.js';
import { extensionIdForPath, installHost } from '../../tools/host.js';

const CHECKOUT = realpathSync(fileURLToPath(new URL('../../', import.meta.url))).replace(/\/$/, '');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const builds = existsSync(cache) ? readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse() : [];
  for (const build of builds) {
    for (const arch of ['chrome-mac-arm64', 'chrome-mac', 'chrome-mac-x64']) {
      for (const app of ['Google Chrome for Testing', 'Chromium']) {
        const contents = join(cache, build, arch, `${app}.app`, 'Contents');
        const binary = join(contents, 'MacOS', app);
        // A half-finished Playwright download leaves the binary without its framework.
        const framework = join(contents, 'Frameworks', `${app} Framework.framework`, 'Versions', 'Current', `${app} Framework`);
        if (existsSync(binary) && existsSync(framework)) return binary;
      }
    }
  }
  throw new Error('No Chromium. Set $CHROMIUM to a Chromium binary.');
}

// ---- Harness ----

const results = [];
async function check(name, fn) {
  try {
    let timer;
    const limit = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('check timed out after 90 s')), 90_000); });
    await Promise.race([fn(), limit]).finally(() => clearTimeout(timer));
    results.push({ name, ok: true });
    console.log(`ok    ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}
function equal(actual, expected, what = '') {
  const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
  if (a !== e) throw new Error(`${what} expected ${e}, got ${a}`);
}
function ok(value, what) {
  if (!value) throw new Error(what);
}
async function until(what, fn, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
      if (Date.now() > end) throw new Error(`${what}: ${error.message}`);
    }
    if (Date.now() > end) throw new Error(`${what}: gave up, last ${JSON.stringify(last)}`);
    await sleep(60);
  }
}

// ---- CDP over Node's built-in WebSocket ----

export class Browser {
  static async launch({ extensionDir, userDataDir, env }) {
    const child = spawn(findChromium(), [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
      `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`,
      '--use-mock-keychain', '--password-store=basic', '--no-first-run', '--no-default-browser-check',
      '--disable-sync', '--disable-background-networking', '--disable-component-update', '--window-size=1200,800',
      'about:blank',
    ], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    const wsUrl = await new Promise((done, fail) => {
      let text = '';
      child.stderr.on('data', (chunk) => {
        text += chunk;
        const match = text.match(/DevTools listening on (ws:\S+)/);
        if (match) done(match[1]);
      });
      child.on('exit', (code) => fail(new Error(`browser exited: ${code}\n${text}`)));
    });
    const browser = new Browser(child, new WebSocket(wsUrl));
    await new Promise((done, fail) => {
      browser.ws.addEventListener('open', done, { once: true });
      browser.ws.addEventListener('error', fail, { once: true });
    });
    await browser.send('Target.setDiscoverTargets', { discover: true });
    return browser;
  }

  constructor(child, ws) {
    Object.assign(this, { child, ws, nextId: 1, pending: new Map(), targets: new Map(), errors: [], sessions: new Map() });
    ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter.fail(new Error(`${waiter.method}: ${message.error.message}`));
        else waiter.done(message.result);
      } else if (message.method === 'Target.targetCreated' || message.method === 'Target.targetInfoChanged') {
        this.targets.set(message.params.targetInfo.targetId, message.params.targetInfo);
      } else if (message.method === 'Target.targetDestroyed') {
        this.targets.delete(message.params.targetId);
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      }
    });
  }

  send(method, params = {}, sessionId, limitMs = 15_000) {
    const id = this.nextId++;
    return new Promise((done, fail) => {
      // A target that goes away mid-call never answers, so every call has a limit.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`${method}: no answer in ${limitMs / 1000} s`));
      }, limitMs);
      this.pending.set(id, {
        done: (value) => { clearTimeout(timer); done(value); },
        fail: (error) => { clearTimeout(timer); fail(error); },
        method,
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async attach(targetId, limitMs) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, undefined, limitMs);
    await this.send('Runtime.enable', {}, sessionId, limitMs);
    return sessionId;
  }

  async evalIn(sessionId, expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  async worker(id) {
    // Chromium can stop and restart a worker around install, and a stopped instance never answers, so each attempt
    // gets a short limit and the next one looks up the target again.
    return until('the service worker', async () => {
      const target = [...this.targets.values()].find((info) => info.type === 'service_worker' && (!id || info.url.includes(id)));
      if (!target) return null;
      return { id: new URL(target.url).hostname, session: await this.attach(target.targetId, 3000) };
    }, 30_000);
  }

  /** A session on the page in tab `url`, by URL prefix. */
  async page(url) {
    const target = await until(`a page at ${url}`, () => [...this.targets.values()].find((info) => info.type === 'page' && info.url.startsWith(url)));
    return this.attach(target.targetId);
  }

  async close() {
    this.ws.close();
    this.child.kill('SIGKILL');
    await new Promise((done) => this.child.once('exit', done));
  }
}

// ---- Local pages ----

function startPages() {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    const headers = { 'content-type': 'text/html' };
    let body = `<!doctype html><title>Page ${pathname}</title><p id=text>Some selectable text on ${pathname}</p>`;
    if (pathname.startsWith('/csp')) headers['content-security-policy'] = "default-src 'none'; style-src 'none'; script-src 'none'";
    if (pathname.startsWith('/login')) {
      body = `<!doctype html><title>Login</title><input id=pw type=password value=hunter2><input id=name value="plain words"><p id=text>public text</p>
        <input id=auto autocomplete="current-password" value="autopw"><input id=css style="-webkit-text-security: disc" value="csspw">`;
    }
    // Hangs for good once loaded, as a stuck page does: script injection and CDP input then never answer.
    if (pathname.startsWith('/hang')) {
      body = '<!doctype html><title>Hung</title><input id=f autofocus><script>setTimeout(() => { for (;;); }, 300)</script>';
    }
    if (pathname.startsWith('/inner')) {
      body = '<!doctype html><title>Inner</title><button onclick="parent.postMessage(\'inner-click\',\'*\');document.title=\'clicked\'">Inner button</button>';
    }
    if (pathname.startsWith('/controls')) {
      body = `<!doctype html><title>Controls</title><button id=go onclick="this.textContent='Pressed';window.pressed=(window.pressed||0)+1">Press me</button>
        <input id=field aria-label="Your name" onkeydown="if(event.key==='Enter')window.entered=this.value">
        <iframe id=frame src="/inner" style="position:absolute;top:200px;left:50px;width:300px;height:100px;border:0"></iframe>
        <script>window.addEventListener('message',(e)=>{window.fromFrame=e.data})</script>`;
    }
    res.writeHead(200, headers);
    res.end(body);
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

// ---- The run ----

function askSocket(sock, text = '{"type":"front"}\n') {
  return new Promise((done, fail) => {
    const started = performance.now();
    const client = net.createConnection(sock, () => client.write(text));
    let answer = '';
    client.on('data', (chunk) => { answer += chunk; });
    client.on('end', () => done({ line: answer, ms: performance.now() - started }));
    client.on('error', fail);
  });
}

async function main() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bth-e2e-')));
  const userDataDir = join(root, 'profile');
  const sock = join(root, 'host.sock');
  const logPath = join(root, 'events.jsonl');
  const expectedId = extensionIdForPath(CHECKOUT);
  installHost({ dir: join(userDataDir, 'NativeMessagingHosts'), extensionId: expectedId });

  const { server, base } = await startPages();
  const browser = await Browser.launch({ extensionDir: CHECKOUT, userDataDir, env: { BROWSER_TAB_HELPER_SOCK: sock } });

  let sw;
  const inWorker = (expression) => browser.evalIn(sw.session, `(async () => { ${expression} })()`);
  const open = (path, extra = '') => inWorker(`return (await chrome.tabs.create({url: ${JSON.stringify(`${base}${path}`)}, active: true ${extra}})).id`);
  const tabIds = async () => inWorker('return (await chrome.tabs.query({})).map((t) => t.id)');
  const cardIn = (session) => browser.evalIn(session, `(() => {
    const host = document.getElementById('browser-tab-helper-card');
    if (!host) return null;
    const root = host.shadowRoot;
    const box = root.querySelector('.card').getBoundingClientRect();
    const focus = root.activeElement;
    return {
      heading: root.querySelector('h1').textContent,
      actions: [...root.querySelectorAll('[data-action]')].map((b) => b.dataset.action),
      letters: [...root.querySelectorAll('.letter')].map((b) => b.textContent),
      shortcuts: [...root.querySelectorAll('.shortcut')].map((b) => b.textContent),
      centreX: box.left + box.width / 2 - innerWidth / 2,
      centreY: box.top + box.height / 2 - innerHeight / 2,
      backdropPosition: getComputedStyle(root.querySelector('.backdrop')).position,
      focusTag: focus && focus.tagName, focusReadOnly: focus && focus.readOnly,
      activeInDocument: document.activeElement === host,
    };
  })()`);
  const press = async (session, key) => {
    await browser.send('Page.bringToFront', {}, session);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key.length === 1 ? key : undefined, ...(key === 'Enter' ? { text: '\r', windowsVirtualKeyCode: 13 } : {}), ...(key === 'Escape' ? { windowsVirtualKeyCode: 27, code: 'Escape' } : {}) }, session);
    // The keyDown may have closed this very tab, which leaves nothing to send the keyUp to.
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key }, session).catch(() => {});
  };
  const closeAllBut = async (...keep) => {
    await inWorker(`for (const t of await chrome.tabs.query({})) if (!${JSON.stringify(keep)}.includes(t.id)) await chrome.tabs.remove(t.id).catch(()=>{});`);
  };

  /** Two tabs on one page: `first` then `second`, the second carrying the card. */
  const openPair = async (path, firstExtra = '') => {
    const first = await open(path, firstExtra);
    await until('first load', () => inWorker(`return (await chrome.tabs.get(${first})).status === 'complete'`));
    const second = await open(`${path}${path.includes('?') ? '&' : '?'}utm_source=e2e`);
    const session = await browser.page(`${base}${path}${path.includes('?') ? '&' : '?'}utm_source=e2e`);
    await until('the card', () => cardIn(session));
    return { first, second, session };
  };

  const stay = await (async () => {
    // By id, since Chromium runs service workers of its own built-in extensions too. Timing out here means the
    // default host id is not the id Chromium gave the extension.
    sw = await browser.worker(expectedId);
    let seen = null;
    try {
      await until('the worker\'s extension APIs', async () => {
        seen = await browser.evalIn(sw.session, "JSON.stringify({href: self.location.href, apis: Object.keys(chrome ?? {}), perms: chrome.runtime?.getManifest?.().permissions})");
        return JSON.parse(seen).apis.includes('tabs');
      }, 10_000);
    } catch (error) {
      throw new Error(`${error.message}; the worker saw ${seen}`);
    }
    return inWorker('return (await chrome.tabs.create({url: "about:blank"})).id');
  })();

  await check('R7 the default host id is the id Chromium really gave the unpacked extension', () => equal(sw.id, expectedId));

  await check('R2 a duplicate gets a card: centred, dimmed, focus in a hidden read-only input, the bound keys listed', async () => {
    const { first, second, session } = await openPair('/dup1');
    const card = await cardIn(session);
    ok(Math.abs(card.centreX) <= 1 && Math.abs(card.centreY) <= 1, `not centred: ${card.centreX}, ${card.centreY}`);
    equal(card.backdropPosition, 'fixed');
    equal(card.focusTag, 'INPUT');
    equal(card.focusReadOnly, true);
    equal(card.actions, ['jump', 'close-other', 'keep']);
    equal(card.letters, ['j', 'x c', 'k']);
    ok(card.shortcuts.length > 0, 'no bound shortcuts listed');
    await closeAllBut(stay, first);
    equal((await tabIds()).includes(second), false);
  });

  await check('R2 j jumps: focuses the existing tab and closes the duplicate', async () => {
    const { first, second, session } = await openPair('/dup2');
    await press(session, 'j');
    await until('the duplicate closes', async () => !(await tabIds()).includes(second));
    equal(await inWorker(`return (await chrome.tabs.get(${first})).active`), true);
    await closeAllBut(stay);
  });

  await check('R2 Enter takes the primary action', async () => {
    const { second, session } = await openPair('/dup3');
    await press(session, 'Enter');
    await until('the duplicate closes', async () => !(await tabIds()).includes(second));
    await closeAllBut(stay);
  });

  await check('R2 x closes the older copy and stays, c does too', async () => {
    for (const [key, path] of [['x', '/dup4'], ['c', '/dup5']]) {
      const { first, second, session } = await openPair(path);
      await press(session, key);
      await until('the other closes', async () => !(await tabIds()).includes(first));
      ok((await tabIds()).includes(second), 'this tab stayed');
      await until('the card goes', async () => !(await cardIn(session)));
      await closeAllBut(stay);
    }
  });

  await check('R2 x closes every older copy when there are several', async () => {
    const a = await open('/dup6');
    const { first: b, second, session } = await openPair('/dup6');
    await press(session, 'x');
    await until('both close', async () => {
      const ids = await tabIds();
      return !ids.includes(a) && !ids.includes(b) && ids.includes(second);
    });
    await closeAllBut(stay);
  });

  await check('R2 b brings a tab from another window to the duplicate\'s position', async () => {
    const otherWindow = await inWorker(`return (await chrome.windows.create({url: ${JSON.stringify(`${base}/dup7`)}, focused: false})).id`);
    const first = await inWorker(`return (await chrome.tabs.query({windowId: ${otherWindow}}))[0].id`);
    await until('first load', () => inWorker(`return (await chrome.tabs.get(${first})).status === 'complete'`));
    const left = await open('/left');
    const second = await open('/dup7?utm_id=1');
    const session = await browser.page(`${base}/dup7?utm_id=1`);
    await until('the card', () => cardIn(session));
    equal((await cardIn(session)).actions, ['jump', 'bring', 'close-other', 'keep']);
    const before = await inWorker(`const t = await chrome.tabs.get(${second}); return {windowId: t.windowId, index: t.index}`);
    await press(session, 'b');
    await until('the duplicate closes', async () => !(await tabIds()).includes(second));
    const after = await inWorker(`const t = await chrome.tabs.get(${first}); return {windowId: t.windowId, index: t.index, active: t.active}`);
    equal(after, { ...before, active: true });
    await closeAllBut(stay, left);
    await closeAllBut(stay);
  });

  await check('R2 k keeps both and stops asking about this URL', async () => {
    const { first, second, session } = await openPair('/dup8');
    await press(session, 'k');
    await until('the card goes', async () => !(await cardIn(session)));
    ok((await tabIds()).includes(first) && (await tabIds()).includes(second), 'both stayed');
    const muted = await inWorker("return (await chrome.storage.local.get('muted')).muted");
    const until_ = muted[`${base}/dup8`];
    ok(until_ > Date.now() + 59 * 60 * 1000 && until_ <= Date.now() + 60 * 60 * 1000, `an hour, got ${until_ - Date.now()}`);
    await open('/dup8?gclid=1');
    const third = await browser.page(`${base}/dup8?gclid=1`);
    await sleep(600);
    equal(await cardIn(third), null, 'no card while muted');
    await inWorker("await chrome.storage.local.remove('muted')");
    await closeAllBut(stay);
  });

  await check('R2 Escape, the backdrop and × dismiss and keep both tabs', async () => {
    const { first, second, session } = await openPair('/dup9');
    await press(session, 'Escape');
    await until('Escape dismisses', async () => !(await cardIn(session)));

    await inWorker(`await chrome.tabs.reload(${second})`);
    await sleep(200);
    await until('the card returns on reload', () => cardIn(session));
    await browser.evalIn(session, "document.getElementById('browser-tab-helper-card').shadowRoot.querySelector('.backdrop').click()");
    equal(await cardIn(session), null, 'the backdrop dismisses');

    await inWorker(`await chrome.tabs.reload(${second})`);
    await sleep(200);
    await until('the card returns', () => cardIn(session));
    await browser.evalIn(session, "document.getElementById('browser-tab-helper-card').shadowRoot.querySelector('.close').click()");
    equal(await cardIn(session), null, '× dismisses');
    ok((await tabIds()).includes(first) && (await tabIds()).includes(second), 'both stayed');
    await closeAllBut(stay);
  });

  await check('R2 the card never times out', async () => {
    const { session } = await openPair('/dup10');
    await sleep(3000);
    ok(await cardIn(session), 'still up after 3 s');
    await closeAllBut(stay);
  });

  await check('R2 a page with a strict CSP still gets a styled card', async () => {
    const { session } = await openPair('/csp');
    const card = await cardIn(session);
    equal(card.backdropPosition, 'fixed', 'the constructed sheet applied');
    await closeAllBut(stay);
  });

  await check('R2 the commands act on the current tab whether or not the card is up', async () => {
    // dispatch runs the real listener; the key press itself belongs to Chrome and is not exercised.
    const command = (name, tab) => inWorker(`chrome.commands.onCommand.dispatch(${JSON.stringify(name)}, await chrome.tabs.get(${tab}))`);

    const jump = await openPair('/cmd1');
    await press(jump.session, 'Escape');
    await until('dismissed', async () => !(await cardIn(jump.session)));
    await command('dup-jump', jump.second);
    await until('jumped with no card up', async () => !(await tabIds()).includes(jump.second));
    equal(await inWorker(`return (await chrome.tabs.get(${jump.first})).active`), true);
    await closeAllBut(stay);

    const closing = await openPair('/cmd2');
    await command('dup-close-other', closing.second);
    await until('the other closes', async () => !(await tabIds()).includes(closing.first));
    await until('the card goes too', async () => !(await cardIn(closing.session)));
    await closeAllBut(stay);

    const keeping = await openPair('/cmd3');
    await command('dup-keep', keeping.second);
    await until('the card goes', async () => !(await cardIn(keeping.session)));
    ok((await inWorker("return (await chrome.storage.local.get('muted')).muted"))[`${base}/cmd3`], 'muted');
    await inWorker("await chrome.storage.local.remove('muted')");
    await closeAllBut(stay);

    const unique = await open('/cmd4');
    await until('load', () => inWorker(`return (await chrome.tabs.get(${unique})).status === 'complete'`));
    await command('dup-jump', unique);
    await sleep(200);
    ok((await tabIds()).includes(unique), 'no duplicate, nothing closes');
    await closeAllBut(stay);
  });

  await check('R2 a page cannot press the card\'s buttons or keys; a real click can', async () => {
    const { first, second, session } = await openPair('/forged');
    await browser.send('Page.bringToFront', {}, session);
    await browser.evalIn(session, `(() => {
      const root = document.getElementById('browser-tab-helper-card').shadowRoot;
      root.querySelector('[data-action="jump"]').click();
      root.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', {key: 'j', bubbles: true, composed: true}));
    })()`);
    await sleep(400);
    ok((await tabIds()).includes(second), 'the forged press closed the tab');
    ok(await cardIn(session), 'the forged press took the card down');
    const box = await browser.evalIn(session, `(() => {
      const r = document.getElementById('browser-tab-helper-card').shadowRoot.querySelector('[data-action="jump"]').getBoundingClientRect();
      return {x: r.left + r.width / 2, y: r.top + r.height / 2};
    })()`);
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box }, session);
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box }, session);
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box }, session).catch(() => {});
    await until('the real click jumps', async () => !(await tabIds()).includes(second));
    ok((await tabIds()).includes(first), 'the original stayed');
    await closeAllBut(stay);
  });

  await check('R2 the card has its own font, and with no older copy no Close the other', async () => {
    const { first, session } = await openPair('/looks');
    const font = await browser.evalIn(session, "getComputedStyle(document.getElementById('browser-tab-helper-card').shadowRoot.querySelector('.card')).fontFamily");
    ok(/apple-system|BlinkMacSystemFont/.test(font), `the card fell back to ${font}`);
    if (process.env.E2E_SHOTS) {
      await browser.send('Page.bringToFront', {}, session);
      const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, session);
      writeFileSync(join(process.env.E2E_SHOTS, 'card.png'), Buffer.from(data, 'base64'));
    }
    // Reloading the older tab lands it with only a newer copy open.
    await inWorker(`await chrome.tabs.reload(${first})`);
    await sleep(300);
    const olderTarget = [...browser.targets.values()].find((info) => info.type === 'page' && info.url === `${base}/looks`);
    const older = await browser.attach(olderTarget.targetId);
    const card = await until('the card on the older tab', () => cardIn(older));
    equal(card.actions, ['jump', 'keep']);
    await closeAllBut(stay);
  });

  await check('R1 a fragment-only difference gets no card, in a real browser', async () => {
    const first = await open('/frag#one');
    await until('load', () => inWorker(`return (await chrome.tabs.get(${first})).status === 'complete'`));
    const second = await open('/frag#two');
    const session = await browser.page(`${base}/frag#two`);
    await until('load', () => inWorker(`return (await chrome.tabs.get(${second})).status === 'complete'`));
    await sleep(500);
    equal(await cardIn(session), null);
    await closeAllBut(stay);
  });

  await check('R2 the Ask switch turns cards off', async () => {
    await inWorker("await chrome.storage.local.set({settings: {askEnabled: false}})");
    const first = await open('/off');
    await until('load', () => inWorker(`return (await chrome.tabs.get(${first})).status === 'complete'`));
    await open('/off?utm_id=1');
    const session = await browser.page(`${base}/off?utm_id=1`);
    await sleep(600);
    equal(await cardIn(session), null);
    await inWorker("await chrome.storage.local.remove('settings')");
    await closeAllBut(stay);
  });

  await check('R4 the badge counts redundant tabs right now', async () => {
    await open('/badge');
    await open('/badge#x');
    await open('/badge?fbclid=1');
    await until('badge 1', async () => (await inWorker('return chrome.action.getBadgeText({})')) === '1');
    await closeAllBut(stay);
    await until('badge empty', async () => (await inWorker('return chrome.action.getBadgeText({})')) === '');
  });

  // ---- The list page ----

  const LIST = `chrome-extension://${sw.id}/src/page/list.html`;
  let list;
  const inList = (expression) => browser.evalIn(list, `(async () => { ${expression} })()`);
  const rows = () => inList("return [...document.querySelectorAll('#sections .row .row-title')].map((n) => n.textContent)");
  const clickText = (scope, text) => inList(`
    const node = [...document.querySelectorAll(${JSON.stringify(scope)})].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}));
    if (!node) throw new Error('no ' + ${JSON.stringify(text)});
    node.click();`);

  await check('R4 the icon opens the list, and focuses it rather than opening a second', async () => {
    // dispatch runs the real listener; a person clicking the toolbar is the one thing not exercised.
    await inWorker('chrome.action.onClicked.dispatch({})');
    list = await browser.page(LIST);
    await until('rows', async () => (await browser.evalIn(list, "document.querySelectorAll('#sections .row').length")) > 0);
    await inWorker('await chrome.tabs.create({url: "about:blank", active: true})');
    await inWorker('chrome.action.onClicked.dispatch({})');
    await until('the list tab is focused', async () => (await inWorker(`return (await chrome.tabs.query({url: ${JSON.stringify(LIST)}}))[0].active`)));
    equal(await inList(`return (await chrome.tabs.query({url: ${JSON.stringify(LIST)}})).length`), 1);
  });

  await check('R4 the page loads with no exceptions, preloads its modules, and shows its load time', async () => {
    equal(browser.errors, [], 'page exceptions');
    const preloads = await inList("return [...document.querySelectorAll('link[rel=modulepreload]')].length");
    ok(preloads >= 10, `preloads: ${preloads}`);
    const text = await inList("return document.getElementById('load-time').textContent");
    ok(/Loaded in \d+ ms/.test(text), text);
    const hover = await inList("return document.getElementById('load-time').title");
    ok(/Read tabs: \d+ ms/.test(hover), hover);
  });

  const a = await open('/row-a');
  const b = await open('/row-b');
  const c = await open('/row-c');
  const d = await open('/row-d');
  await until('all loaded', () => inWorker('return (await chrome.tabs.query({})).every((t) => t.status === "complete")'));
  const homeWindow = await inList('return (await chrome.tabs.getCurrent()).windowId');
  const urlsInOrder = async () => inWorker(`return (await chrome.tabs.query({windowId: ${homeWindow}})).sort((x, y) => x.index - y.index).map((t) => t.url.replace(${JSON.stringify(base)}, ''))`);

  await check('R4 the page updates live as tabs open and close', async () => {
    await until('rows appear', async () => (await rows()).includes('Page /row-d'));
    await inWorker(`await chrome.tabs.remove(${d})`);
    await until('the row goes', async () => !(await rows()).includes('Page /row-d'));
  });

  await check('R4 closes undo through chrome.sessions, back in their original places', async () => {
    const before = await urlsInOrder();
    for (const id of [a, b, c]) {
      await inList(`document.querySelector('#sections .row[data-tab="${id}"] .row-actions button:last-child').click()`);
      await until('closed', async () => !(await tabIds()).includes(id));
      await until('redrawn', async () => (await inList(`return !document.querySelector('#sections .row[data-tab="${id}"]')`)));
    }
    equal((await urlsInOrder()).filter((u) => u.startsWith('/row')), []);
    const toasts = await inList("return document.querySelectorAll('.toast button').length");
    equal(toasts, 3);
    // Newest toast first, the way a person would take them back.
    for (let i = 0; i < 3; i += 1) {
      await inList("const all = document.querySelectorAll('.toast button'); all[all.length - 1].click()");
      await sleep(400);
    }
    await until('restored', async () => JSON.stringify(await urlsInOrder()) === JSON.stringify(before), 5000);
  });

  await check('R4 a bulk close undoes in one step and keeps the order', async () => {
    const before = await urlsInOrder();
    await until('rows', async () => (await rows()).includes('Page /row-c'));
    const ids = await inWorker(`return (await chrome.tabs.query({})).filter((t) => t.url.includes('/row-')).map((t) => t.id)`);
    await inList(`
      const rowsNow = ${JSON.stringify(ids)}.map((id) => document.querySelector('#sections .row[data-tab="' + id + '"]'));
      rowsNow[0].dispatchEvent(new MouseEvent('click', {bubbles: true, metaKey: true}));`);
    await sleep(50);
    await inList(`document.querySelector('#sections .row[data-tab="${ids.at(-1)}"]').dispatchEvent(new MouseEvent('click', {bubbles: true, shiftKey: true}));`);
    await sleep(50);
    equal(await inList("return document.querySelectorAll('#sections .row.selected').length"), ids.length, 'shift range');
    await clickText('#selection-bar button', 'Close');
    await until('all closed', async () => (await urlsInOrder()).every((u) => !u.startsWith('/row')));
    await inList("const all = document.querySelectorAll('.toast button'); all[all.length - 1].click()");
    await until('restored', async () => JSON.stringify(await urlsInOrder()) === JSON.stringify(before), 5000);
  });

  let secondWindow;
  await check('R4 Move here and Move all here, with undo', async () => {
    secondWindow = await inWorker(`return (await chrome.windows.create({url: [${JSON.stringify(`${base}/w2-a`)}, ${JSON.stringify(`${base}/w2-b`)}], focused: false})).id`);
    await until('rows', async () => (await rows()).includes('Page /w2-b'));
    const w2tabs = () => inWorker(`return (await chrome.tabs.query({windowId: ${secondWindow}})).map((t) => t.url.replace(${JSON.stringify(base)}, ''))`);
    const target = await inWorker(`return (await chrome.tabs.query({windowId: ${secondWindow}}))[1].id`);
    await inList(`[...document.querySelectorAll('#sections .row[data-tab="${target}"] button')].find((b) => b.textContent === 'Move here').click()`);
    await until('moved', async () => (await w2tabs()).length === 1);
    await inList("const all = document.querySelectorAll('.toast button'); all[all.length - 1].click()");
    await until('moved back in place', async () => JSON.stringify(await w2tabs()) === JSON.stringify(['/w2-a', '/w2-b']));
    await sleep(200);
    await clickText('section[data-drop-window="' + secondWindow + '"] button', 'Move all here');
    await until('the window empties', async () => !(await inWorker('return (await chrome.windows.getAll()).map((w) => w.id)')).includes(secondWindow));
    await inList("const all = document.querySelectorAll('.toast button'); all[all.length - 1].click()");
    await until('undo rebuilds the window', async () => {
      const urls = await inWorker(`return (await chrome.tabs.query({})).filter((t) => t.url.includes('/w2-')).map((t) => ({w: t.windowId, u: t.url}))`);
      const here = await inList(`return (await chrome.tabs.getCurrent()).windowId`);
      return urls.length === 2 && urls.every((row) => row.w !== here);
    });
    secondWindow = await inWorker(`return (await chrome.tabs.query({})).find((t) => t.url.includes('/w2-')).windowId`);
  });

  await check('R4 window strip: one chip per window, yours marked here; click filters, double-click focuses', async () => {
    await until('the rebuilt window\'s chip', async () => inList(`return document.querySelectorAll('#strip .chip').length === 2 && !!document.querySelector('#strip .chip[data-chip-window="${secondWindow}"]')`));
    const chips = await inList("return [...document.querySelectorAll('#strip .chip')].map((c) => c.textContent)");
    ok(chips[0].endsWith('here'), `yours first and marked: ${chips}`);
    ok(!chips.some((text) => /Window \d/.test(text)), `no numbered names: ${chips}`);
    await inList(`document.querySelector('#strip .chip[data-chip-window="${secondWindow}"]').click()`);
    const only = await rows();
    equal(only.every((title) => title.includes('w2-')), true, 'only that window');
    await inList(`document.querySelector('#strip .chip[data-chip-window="${secondWindow}"]').click()`);
    ok((await rows()).length > 2, 'click again clears');
    await inList(`document.querySelector('#strip .chip[data-chip-window="${secondWindow}"]').dispatchEvent(new MouseEvent('dblclick', {bubbles: true}))`);
    await until('focused', () => inWorker(`return (await chrome.windows.get(${secondWindow})).focused`));
    // The page redraws about 80 ms after the last event. If it never shows both rows, it has gone stale for good.
    await until('both rows drawn in their window', async () => (await inList(`return document.querySelectorAll('#sections .row[data-window="${secondWindow}"]').length`)) === 2);
    await inList(`document.querySelector('#strip .chip[data-chip-window="${secondWindow}"]').dispatchEvent(new MouseEvent('mouseover', {bubbles: true}))`);
    const lit = await inList(`return JSON.stringify({
      lit: [...document.querySelectorAll('#sections .row.highlight')].map((row) => row.querySelector('.row-title').textContent),
      inWindow: [...document.querySelectorAll('#sections .row[data-window="${secondWindow}"]')].length,
      all: document.querySelectorAll('#sections .row').length,
      real: (await chrome.tabs.query({windowId: ${secondWindow}})).map((t) => t.url.split('/').pop()),
    })`);
    equal(JSON.parse(lit).lit.length, JSON.parse(lit).real.length, `hover highlights its rows: ${lit}`);
    equal(JSON.parse(lit).real.length, 2, `the rebuilt window: ${lit}`);
    await inList("document.getElementById('strip').dispatchEvent(new MouseEvent('mouseleave'))");
    await browser.send('Page.bringToFront', {}, list);
  });

  await check('R4 keys: / filters, a digit shows that window, Esc clears the filter and then the selection', async () => {
    await press(list, '/');
    ok(await inList("return document.activeElement.id === 'filter'"), '/ focuses the filter');
    await browser.send('Input.insertText', { text: 'row-b' }, list);
    await until('filtered', async () => JSON.stringify(await rows()) === JSON.stringify(['Page /row-b']));
    await press(list, 'Escape');
    await until('cleared', async () => (await rows()).length > 1);
    await press(list, '2');
    await until('window 2 shown', async () => (await rows()).every((title) => title.includes('w2-')));
    await inList(`document.querySelector('#strip .chip[data-chip-window="${secondWindow}"]').click()`);
    await inList(`document.querySelector('#sections .row').dispatchEvent(new MouseEvent('click', {bubbles: true, metaKey: true}))`);
    equal(await inList("return document.querySelectorAll('#sections .row.selected').length"), 1);
    await press(list, 'Escape');
    await until('selection cleared', async () => (await inList("return document.querySelectorAll('#sections .row.selected').length")) === 0);
  });

  await check('R4 drag and drop: the tray appears, a drop on a section lands at the line, on a chip at the end', async () => {
    const firstRowIn = async (win, n) => inWorker(`return (await chrome.tabs.query({windowId: ${win}})).sort((x, y) => x.index - y.index)[${n}].id`);
    const here = await inList('return (await chrome.tabs.getCurrent()).windowId');
    const dragged = await firstRowIn(secondWindow, 1);
    // Synthetic drag events: this checks the page's handlers, not Chrome's own drag gesture.
    const dragTo = (selector, y = null) => inList(`
      const row = document.querySelector('#sections .row[data-tab="${dragged}"]');
      const data = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', {bubbles: true, dataTransfer: data}));
      const trayUp = !document.getElementById('tray').hidden && document.querySelectorAll('#tray .chip').length;
      const target = document.querySelector(${JSON.stringify(selector)});
      const box = target.getBoundingClientRect();
      const clientY = ${y === null ? 'box.top + 2' : y};
      const over = new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: data, clientY});
      target.dispatchEvent(over);
      const lineUp = !document.getElementById('drop-line').hidden;
      target.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: data, clientY}));
      row.dispatchEvent(new DragEvent('dragend', {bubbles: true}));
      return {trayUp, lineUp, accepted: over.defaultPrevented};`);
    const before = await firstRowIn(here, 1);
    const onSection = await dragTo(`#sections .row[data-tab="${before}"]`);
    equal(onSection.trayUp, 2, 'a tray of every window');
    equal(onSection.lineUp, true, 'a line shows where it lands');
    equal(onSection.accepted, true);
    await until('landed before the row', async () => {
      const tab = await inWorker(`return await chrome.tabs.get(${dragged})`);
      return tab.windowId === here && tab.index === 1;
    });
    await inList("const all = document.querySelectorAll('.toast button'); all[all.length - 1].click()");
    await until('undone', async () => (await inWorker(`return (await chrome.tabs.get(${dragged})).windowId`)) === secondWindow);
    await sleep(200);
    const onChip = await dragTo(`#strip .chip[data-drop-chip="${here}"]`);
    equal(onChip.lineUp, false);
    await until('landed at the end', async () => {
      const row = await inWorker(`const t = await chrome.tabs.get(${dragged}); const all = await chrome.tabs.query({windowId: t.windowId}); return {w: t.windowId, last: t.index === all.length - 1}`);
      return row.w === here && row.last;
    });
    await inList("const all = document.querySelectorAll('.toast button'); all[all.length - 1].click()");
    await until('undone', async () => (await inWorker(`return (await chrome.tabs.get(${dragged})).windowId`)) === secondWindow);
  });

  const newestUndo = () => inList("const all = document.querySelectorAll('.toast button'); all[all.length - 1].click()");
  const failedToasts = () => inList("return [...document.querySelectorAll('.toast span')].map((n) => n.textContent).filter((text) => /failed/i.test(text))");
  const openIn = (windowId, paths) => inWorker(`
    const ids = [];
    for (const path of ${JSON.stringify(paths)}) ids.push((await chrome.tabs.create({windowId: ${windowId}, url: ${JSON.stringify(base)} + path, active: false})).id);
    return ids;`);
  const rowsDrawn = (ids) => until('the rows', () => inList(`return ${JSON.stringify(ids)}.every((id) => document.querySelector('#sections .row[data-tab="' + id + '"]'))`));
  const selectRows = (ids) => inList(`
    for (const id of ${JSON.stringify(ids)}) {
      document.querySelector('#sections .row[data-tab="' + id + '"]').dispatchEvent(new MouseEvent('click', {bubbles: true, metaKey: true}));
    }`);

  await check('R4 several rows dragged rightward keep their order, through real tabs.move, and undo', async () => {
    const paths = ['/m-a', '/m-b', '/m-c', '/m-d', '/m-e'];
    const [ma, mb, , md] = await openIn(homeWindow, paths);
    await rowsDrawn([ma, mb, md]);
    const strip = async () => (await urlsInOrder()).filter((url) => url.startsWith('/m-'));
    // A tab still loading has an empty url, so this waits for them all rather than checking once.
    await until('all five open in order', async () => JSON.stringify(await strip()) === JSON.stringify(paths));
    await selectRows([ma, mb]);
    await inList(`
      const row = document.querySelector('#sections .row[data-tab="${ma}"]');
      const target = document.querySelector('#sections .row[data-tab="${md}"]');
      const data = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', {bubbles: true, dataTransfer: data}));
      const clientY = target.getBoundingClientRect().top + 2;
      target.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: data, clientY}));
      target.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: data, clientY}));
      row.dispatchEvent(new DragEvent('dragend', {bubbles: true}));`);
    await sleep(500);
    equal(await strip(), ['/m-c', '/m-a', '/m-b', '/m-d', '/m-e'], 'dragged A,B to before D');
    await newestUndo();
    await until('undone', async () => JSON.stringify(await strip()) === JSON.stringify(paths));
    await inWorker('for (const t of await chrome.tabs.query({})) if (t.url.includes("/m-")) await chrome.tabs.remove(t.id)');
  });

  await check('R4 undoing a move brings back the tab group it emptied', async () => {
    const [solo] = await openIn(secondWindow, ['/g-solo']);
    await inWorker(`const g = await chrome.tabs.group({tabIds: [${solo}], createProperties: {windowId: ${secondWindow}}}); await chrome.tabGroups.update(g, {title: 'Emptied', color: 'red', collapsed: false});`);
    await rowsDrawn([solo]);
    await until('the page knows the group', () => inList(`return [...document.querySelectorAll('#sections .row[data-tab="${solo}"] .pill')].some((n) => n.textContent === 'Emptied')`));
    await inList(`[...document.querySelectorAll('#sections .row[data-tab="${solo}"] button')].find((b) => b.textContent === 'Move here').click()`);
    await until('the group is gone', async () => (await inWorker("return (await chrome.tabGroups.query({title: 'Emptied'})).length")) === 0);
    await newestUndo();
    const group = await until('the group is back', async () => (await inWorker("return (await chrome.tabGroups.query({title: 'Emptied'}))[0]")) ?? null);
    equal([group.color, group.windowId], ['red', secondWindow]);
    equal(await inWorker(`return (await chrome.tabs.get(${solo})).groupId`), group.id);
    equal(await failedToasts(), []);
    await inWorker(`await chrome.tabs.remove(${solo})`);
  });

  await check('R4 a partly failed bulk close still offers undo for what did close', async () => {
    const [pa, pb, pc] = await openIn(homeWindow, ['/p-a', '/p-b', '/p-c']);
    await rowsDrawn([pa, pb, pc]);
    await until('loaded', () => inWorker(`return (await Promise.all([${pa}, ${pb}, ${pc}].map((id) => chrome.tabs.get(id)))).every((t) => t.status === 'complete')`));
    await selectRows([pa, pb, pc]);
    // The middle tab goes behind the page's back, before it has redrawn.
    await inList(`
      await chrome.tabs.remove(${pb});
      [...document.querySelectorAll('#selection-bar button')].find((b) => b.textContent === 'Close').click();`);
    const left = () => inWorker("return (await chrome.tabs.query({})).filter((t) => t.url.includes('/p-')).map((t) => t.url.split('/').pop())");
    await until('the rest still close', async () => (await left()).length === 0);
    await until('a toast offers undo', () => inList("return [...document.querySelectorAll('.toast')].some((n) => /Closed 2 tabs/.test(n.textContent) && n.querySelector('button'))"));
    await newestUndo();
    await until('both come back', async () => JSON.stringify((await left()).sort()) === JSON.stringify(['p-a', 'p-c']));
    await inWorker('for (const t of await chrome.tabs.query({})) if (t.url.includes("/p-")) await chrome.tabs.remove(t.id)');
  });

  await check('R4 lenses: By kind, Duplicates with real URLs, Close N extras with undo, Close N duplicates', async () => {
    await clickText('#lenses button', 'By kind');
    ok((await inList("return [...document.querySelectorAll('#sections h2')].map((n) => n.textContent)")).includes('Dev servers'), 'loopback is a Dev server');
    const chips = await inList("return [...document.querySelectorAll('#kinds .chip')].map((c) => c.textContent)");
    ok(chips.some((chip) => /^Dev servers \d+$/.test(chip)), `kind chips: ${chips}`);

    await open('/twin?utm_source=a');
    await open('/twin?utm_source=b');
    await clickText('#lenses button', 'Duplicates');
    await until('a group', async () => (await inList("return document.querySelectorAll('#sections section').length")) === 1);
    const urls = await inList("return [...document.querySelectorAll('#sections .row-url')].map((n) => n.textContent)");
    ok(urls.some((url) => url.includes('utm_source')), `shows the real URL: ${urls}`);
    const extras = await inList("return [...document.querySelectorAll('#sections section button')].map((b) => b.textContent)");
    ok(extras.includes('Close 1 extra, keep the original'), `button: ${extras}`);
    await clickText('#sections section button', 'Close 1 extra');
    await until('closed', async () => (await inWorker("return (await chrome.tabs.query({})).filter((t) => t.url.includes('/twin')).length")) === 1);
    await inList("const all = document.querySelectorAll('.toast button'); all[all.length - 1].click()");
    await until('back', async () => (await inWorker("return (await chrome.tabs.query({})).filter((t) => t.url.includes('/twin')).length")) === 2);
    await browser.send('Page.bringToFront', {}, list);
    // The restored tab has a new id, so wait for the page to draw that one, not the row it had a moment ago.
    const twins = await inWorker("return (await chrome.tabs.query({})).filter((t) => t.url.includes('/twin')).map((t) => t.id)");
    await until('the restored row', async () => inList(`return ${JSON.stringify(twins)}.every((id) => document.querySelector('#sections .row[data-tab="' + id + '"]'))`));
    await clickText('#sections .selection-bar button', 'Close 1 duplicate');
    await until('closed', async () => (await inWorker("return (await chrome.tabs.query({})).filter((t) => t.url.includes('/twin')).length")) === 1);
    await clickText('#lenses button', 'By window');
  });

  await check('R4 the muted list has a Resume button', async () => {
    await inWorker(`await chrome.storage.local.set({muted: {'https://muted.test/': Date.now() + 100000, 'https://expired.test/': 1}})`);
    await until('listed', async () => (await inList("return document.querySelectorAll('#muted .muted-url').length")) === 1);
    await clickText('#muted button', 'Resume');
    await until('resumed', async () => Object.keys(await inWorker("return (await chrome.storage.local.get('muted')).muted")).length === 0);
  });

  // ---- R5, R6 ----

  const restore = (layout) => inList(`return chrome.runtime.sendMessage({type: 'restore-layout', layout: ${JSON.stringify(layout)}})`);

  await check('R5 a bad layout opens nothing', async () => {
    const before = (await tabIds()).length;
    const outcome = await restore({ version: 1, windows: [{ items: [
      { title: 'fine', url: `${base}/never` },
      { group: 'g', color: 'magenta', tabs: [] },
      { title: 'bad', url: 'file:///etc/hosts' },
    ] }] });
    equal(outcome.errors.length, 2);
    equal((await tabIds()).length, before);
  });

  await check('R5 restore rebuilds windows in order, moves open tabs in, skips placeholders, and save reads it back', async () => {
    const already = await inWorker("return (await chrome.tabs.query({})).find((t) => t.url.includes('/row-b')).id");
    const outcome = await restore({ version: 1, name: 't', windows: [{ items: [
      { title: 'pin', url: `${base}/l-pin`, pinned: true },
      { group: 'Reading', color: 'green', collapsed: false, tabs: [
        { title: 'ph', url: null, todo: 'why' },
        { title: 'stale title', url: `${base}/row-b?utm_medium=x` },
        { title: 'new', url: `${base}/l-new` },
      ] },
      { title: 'after', url: `${base}/l-after` },
      { group: 'only placeholders', color: 'red', tabs: [{ title: 'ph2', url: null }] },
    ] }] });
    equal(outcome.errors, []);
    equal(outcome.skipped.map((s) => s.title), ['ph', 'ph2']);
    equal([outcome.windows, outcome.opened, outcome.moved], [1, 3, 1]);
    const strip = await inWorker(`
      const moved = await chrome.tabs.get(${already});
      const tabs = (await chrome.tabs.query({windowId: moved.windowId})).sort((x, y) => x.index - y.index);
      const groups = await chrome.tabGroups.query({windowId: moved.windowId});
      return {
        urls: tabs.map((t) => (t.pendingUrl || t.url).replace(${JSON.stringify(base)}, '')),
        pinned: tabs.map((t) => t.pinned),
        grouped: tabs.map((t) => t.groupId !== -1),
        groups: groups.map((g) => [g.title, g.color]),
        movedId: moved.id,
      };`);
    equal(strip.urls, ['/l-pin', '/row-b', '/l-new', '/l-after']);
    equal(strip.pinned, [true, false, false, false]);
    equal(strip.grouped, [false, true, true, false]);
    equal(strip.groups, [['Reading', 'green']]);
    equal(strip.movedId, already, 'the open tab moved rather than a second copy opening');
    await until('rows', async () => (await rows()).includes('Page /l-after'));

    const saved = await inList(`
      const [{ buildLayout }] = await Promise.all([import('../lib/layouts.js')]);
      return buildLayout({ windows: await chrome.windows.getAll(), tabs: await chrome.tabs.query({}), groups: await chrome.tabGroups.query({}) });`);
    const win = saved.windows.find((w) => w.items.some((item) => item.group === 'Reading'));
    equal(win.items.map((item) => item.group ?? 'tab'), ['tab', 'Reading', 'tab']);
    ok(!JSON.stringify(saved).includes('chrome-extension:'), 'skips extension pages');
  });

  await check('R6 Copy puts the group on the clipboard; Open section reads it back as a group, moving what is open', async () => {
    await browser.send('Page.bringToFront', {}, list);
    await browser.send('Browser.grantPermissions', { origin: `chrome-extension://${sw.id}`, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await clickText('#lenses button', 'By tab group');
    await until('the group', async () => (await inList("return [...document.querySelectorAll('#sections h2')].map((n) => n.textContent)")).includes('Reading'));
    await clickText('#sections section button', 'Copy');
    const copied = await until('clipboard', async () => {
      const text = await inList('return navigator.clipboard.readText()');
      return text.startsWith('📂 Reading') ? text : null;
    });
    ok(copied.includes(`• Page /row-b — ${base}/row-b`), copied);

    const here = await inList('return (await chrome.tabs.getCurrent()).windowId');
    await inList(`await navigator.clipboard.writeText(${JSON.stringify(`Shared reading\n1. Moved in - ${base}/l-after\n- [Fresh](${base}/s-fresh)\n${base}/s-bare`)})`);
    await clickText('#open-section', 'Open section');
    const group = await until('the new group', async () => {
      const found = await inWorker(`return (await chrome.tabGroups.query({windowId: ${here}})).find((g) => g.title === 'Shared reading')`);
      return found ?? null;
    });
    const members = await inWorker(`return (await chrome.tabs.query({groupId: ${group.id}})).sort((x, y) => x.index - y.index).map((t) => (t.pendingUrl || t.url).replace(${JSON.stringify(base)}, ''))`);
    equal(members, ['/l-after', '/s-fresh', '/s-bare']);
    equal(await inWorker("return (await chrome.tabs.query({})).filter((t) => (t.pendingUrl || t.url).includes('/l-after')).length"), 1, 'moved, not opened twice');
    await clickText('#lenses button', 'By window');
  });

  await check('R6 undo of Open section: new tabs close and moved tabs go back', async () => {
    const after = await inWorker("const t = (await chrome.tabs.query({})).find((x) => x.url.includes('/l-after')); return t.id");
    await newestUndo();
    await until('the new tabs close', async () => (await inWorker("return (await chrome.tabs.query({})).filter((t) => /s-fresh|s-bare/.test(t.pendingUrl || t.url)).length")) === 0);
    await until('the moved tab goes home', async () => (await inWorker(`return (await chrome.tabs.get(${after})).windowId`)) !== homeWindow);
    equal(await failedToasts(), []);
  });

  await check('R6 undo of Open section when every tab was new', async () => {
    await inList(`await navigator.clipboard.writeText(${JSON.stringify(`All new\n${base}/n-one\n${base}/n-two`)})`);
    await clickText('#open-section', 'Open section');
    const newOnes = () => inWorker("return (await chrome.tabs.query({})).filter((t) => /n-one|n-two/.test(t.pendingUrl || t.url)).length");
    await until('opened', async () => (await newOnes()) === 2 && (await inWorker("return (await chrome.tabGroups.query({title: 'All new'})).length")) === 1);
    await until('its toast', () => inList("return [...document.querySelectorAll('.toast')].some((n) => n.textContent.startsWith('Opened All new'))"));
    await newestUndo();
    await until('closed', async () => (await newOnes()) === 0);
    await sleep(200);
    equal(await failedToasts(), []);
  });

  // ---- R7 ----

  await check('R7 Chromium starts the host from the installed manifest, and its socket is 0600', async () => {
    await until('the socket', () => existsSync(sock), 5000);
    equal(statSync(sock).mode & 0o777, 0o600);
  });

  await check('R7 front page: title, URL and selection, in milliseconds', async () => {
    const tab = await open('/front');
    const session = await browser.page(`${base}/front`);
    await browser.send('Page.bringToFront', {}, session);
    await until('load', () => inWorker(`return (await chrome.tabs.get(${tab})).status === 'complete'`));
    await browser.evalIn(session, "getSelection().selectAllChildren(document.getElementById('text'))");
    const { line, ms } = await askSocket(sock);
    const answer = JSON.parse(line);
    equal(answer.url, `${base}/front`);
    equal(answer.title, 'Page /front');
    equal(answer.selection, 'Some selectable text on /front');
    console.log(`      answered in ${ms.toFixed(1)} ms`);
  });

  await check('R7 a password field\'s selection is never read; a plain field\'s is', async () => {
    await open('/login');
    const session = await browser.page(`${base}/login`);
    await browser.send('Page.bringToFront', {}, session);
    await browser.evalIn(session, "(() => { const p = document.getElementById('pw'); p.focus(); p.select(); })()");
    equal(JSON.parse((await askSocket(sock)).line).selection, null);
    await browser.evalIn(session, "(() => { const n = document.getElementById('name'); n.focus(); n.select(); })()");
    equal(JSON.parse((await askSocket(sock)).line).selection, 'plain words');
  });

  await check('R7 fields masked another way are not read either: autocomplete, and CSS', async () => {
    const session = await browser.page(`${base}/login`);
    await browser.send('Page.bringToFront', {}, session);
    for (const field of ['auto', 'css']) {
      await browser.evalIn(session, `(() => { const f = document.getElementById('${field}'); f.focus(); f.select(); })()`);
      equal(JSON.parse((await askSocket(sock)).line).selection, null, field);
    }
  });

  await check('R7 a page that refuses scripts answers with no selection', async () => {
    const tab = await inWorker("return (await chrome.tabs.create({url: 'chrome://version/', active: true})).id");
    await sleep(300);
    const answer = JSON.parse((await askSocket(sock)).line);
    equal(answer.url, 'chrome://version/');
    equal(answer.selection, null);
    await inWorker(`await chrome.tabs.remove(${tab})`);
  });

  await check('R7 the contract: anything but front is refused', async () => {
    ok(JSON.parse((await askSocket(sock, '{"type":"tabs"}\n')).line).error, 'an error');
  });

  // ---- R8 ----

  const bridge = createBridge({ logPath });
  const bridgePort = await bridge.listen(0);
  const ask = async (command) => {
    const response = await fetch(`http://127.0.0.1:${bridgePort}/ask`, { method: 'POST', body: JSON.stringify(command) });
    const body = await response.json();
    if (body.error !== undefined) throw new Error(body.error);
    return body.result;
  };

  // getTargets' `attached` also counts this harness's own session. An extension cannot attach twice, so attaching
  // again succeeds only if the extension let go.
  const extensionDetached = (tabId) => inWorker(`await chrome.debugger.attach({tabId: ${tabId}}, '1.3'); await chrome.debugger.detach({tabId: ${tabId}});`);

  await check('R8 off until switched on: the worker does not poll', async () => {
    equal(await inWorker("return (await chrome.storage.local.get('settings')).settings?.bridgeEnabled ?? false"), false);
  });

  await check('R8 switched on, ask reaches the extension: diag, tabs, duplicates, layout', async () => {
    await inWorker(`await chrome.storage.local.set({settings: {bridgeEnabled: true, bridgePort: ${bridgePort}}})`);
    const diag = await ask({ cmd: 'diag' });
    equal(diag.id, sw.id);
    equal(diag.hostConnected, true);
    ok((await ask({ cmd: 'tabs' })).length > 2, 'tabs');
    equal(Array.isArray(await ask({ cmd: 'duplicates' })), true);
    equal((await ask({ cmd: 'layout' })).version, 1);
  });

  await check('R8 unknown commands answer with an error', async () => {
    await ask({ cmd: 'launch-rockets' }).then(() => { throw new Error('it answered'); }, (error) => ok(/unknown command/.test(error.message), error.message));
  });

  let controlsTab;
  await check('R8 open, activate, read every frame, navigate, reload, close', async () => {
    const opened = await ask({ cmd: 'open', url: `${base}/controls` });
    controlsTab = opened.id;
    await until('load', async () => (await inWorker(`return (await chrome.tabs.get(${controlsTab})).status`)) === 'complete');
    await ask({ cmd: 'activate', tab: controlsTab });
    const page = await until('both frames', async () => {
      const read = await ask({ cmd: 'read', tab: controlsTab });
      return read.frames.length === 2 ? read : null;
    });
    ok(page.controls.some((control) => control.label === 'Press me'), 'top-frame control');
    ok(page.controls.some((control) => control.label === 'Inner button' && control.frameId !== 0), 'frame control');
    const temp = await ask({ cmd: 'open', url: `${base}/temp` });
    await ask({ cmd: 'navigate', tab: temp.id, url: `${base}/temp2` });
    await until('navigated', async () => (await inWorker(`return (await chrome.tabs.get(${temp.id})).url`)).endsWith('/temp2'));
    await ask({ cmd: 'reload', tab: temp.id });
    await ask({ cmd: 'close', tab: temp.id });
    ok(!(await tabIds()).includes(temp.id), 'closed');
    await ask({ cmd: 'activate', tab: controlsTab });
  });

  await check('R8 click by label and by index with the debugger, which detaches right after', async () => {
    const session = await browser.page(`${base}/controls`);
    await browser.send('Page.bringToFront', {}, session);
    equal((await ask({ cmd: 'click', tab: controlsTab, target: 'Press me' })).via, 'debugger');
    await until('pressed', () => browser.evalIn(session, 'window.pressed === 1'));
    const { controls } = await ask({ cmd: 'read', tab: controlsTab });
    const pressed = controls.find((control) => control.label === 'Pressed');
    await ask({ cmd: 'click', tab: controlsTab, target: pressed.index });
    await until('pressed twice', () => browser.evalIn(session, 'window.pressed === 2'));
    await extensionDetached(controlsTab);
  });

  await check('R8 click reaches into a same-origin frame by real coordinates', async () => {
    const session = await browser.page(`${base}/controls`);
    equal((await ask({ cmd: 'click', tab: controlsTab, target: 'Inner button' })).via, 'debugger');
    await until('the frame heard it', () => browser.evalIn(session, "window.fromFrame === 'inner-click'"));
  });

  await check('R8 type and key', async () => {
    const session = await browser.page(`${base}/controls`);
    await ask({ cmd: 'click', tab: controlsTab, target: 'Your name' });
    await ask({ cmd: 'type', tab: controlsTab, text: 'typed via CDP' });
    equal(await browser.evalIn(session, "document.getElementById('field').value"), 'typed via CDP');
    await ask({ cmd: 'key', tab: controlsTab, key: 'Enter' });
    await until('Enter arrived', () => browser.evalIn(session, "window.entered === 'typed via CDP'"));
    await extensionDetached(controlsTab);
  });

  await check('R8 screenshot', async () => {
    const { dataUrl } = await ask({ cmd: 'screenshot', tab: controlsTab });
    ok(dataUrl.startsWith('data:image/png;base64,'), dataUrl.slice(0, 40));
    ok(dataUrl.length > 500, 'an image');
  });

  await check('R8 restore-layout through the bridge, and a bad one refused', async () => {
    equal((await ask({ cmd: 'restore-layout', layout: { version: 9, windows: [] } })).errors.length > 0, true);
    equal((await ask({ cmd: 'restore-layout', layout: { version: 1, windows: [{ items: [{ title: 'b', url: `${base}/via-bridge` }] }] } })).opened, 1);
  });

  await check('R8 extension events reach the JSONL log', async () => {
    await open('/logged');
    await until('load', () => inWorker("return (await chrome.tabs.query({})).every((t) => t.status === 'complete')"));
    await open('/logged?utm_id=1');
    await until('a card event', () => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('"event":"card"'));
  });

  await check('R8 a click on a background tab lands, slowly', async () => {
    const tab = (await ask({ cmd: 'open', url: `${base}/controls?background` })).id;
    await until('load', async () => (await inWorker(`return (await chrome.tabs.get(${tab})).status`)) === 'complete');
    await inWorker(`await chrome.tabs.update(${controlsTab}, {active: true})`);
    equal(await inWorker(`return (await chrome.tabs.get(${tab})).active`), false);
    const started = Date.now();
    equal((await ask({ cmd: 'click', tab, target: 'Press me' })).via, 'debugger');
    console.log(`      background click took ${((Date.now() - started) / 1000).toFixed(1)} s`);
    await until('it landed', async () => (await ask({ cmd: 'read', tab })).controls.some((control) => control.label === 'Pressed'));
    await extensionDetached(tab);
    await ask({ cmd: 'close', tab });
  });

  await check('R8 a command that never finishes times out, lets go of the debugger, and frees the bridge', async () => {
    await inWorker(`await chrome.storage.local.set({settings: {bridgeEnabled: true, bridgePort: ${bridgePort}, bridgeCommandTimeoutMs: 2000}})`);
    const hung = (await ask({ cmd: 'open', url: `${base}/hang` })).id;
    await sleep(1200);
    const limited = (command) => Promise.race([
      ask(command).then(() => 'answered', (error) => error.message),
      sleep(12_000).then(() => 'STILL WAITING after 12 s'),
    ]);
    const typed = await limited({ cmd: 'type', tab: hung, text: 'x' });
    ok(/did not finish/.test(typed), `type: ${typed}`);
    await extensionDetached(hung);
    const read = await limited({ cmd: 'read', tab: hung });
    ok(/did not finish/.test(read), `read: ${read}`);
    equal((await ask({ cmd: 'diag' })).id, sw.id, 'the bridge still answers');
    await inWorker(`await chrome.tabs.remove(${hung})`);
    await inWorker(`await chrome.storage.local.set({settings: {bridgeEnabled: true, bridgePort: ${bridgePort}}})`);
  });

  await check('R8 the worker carries on when the server dies', async () => {
    await bridge.close();
    await sleep(200);
    equal(await inWorker('return typeof chrome.runtime.id'), 'string');
    const tab = await open('/after-bridge');
    await until('still answering', () => inWorker(`return (await chrome.tabs.get(${tab})).status === 'complete'`));
  });

  await check('R8 switching off drops the held poll, and no command runs after it', async () => {
    const off = createBridge({ logPath, answerTimeoutMs: 2500 });
    const port = await off.listen(0);
    const send = async (command) => {
      const response = await fetch(`http://127.0.0.1:${port}/ask`, { method: 'POST', body: JSON.stringify(command) });
      return { status: response.status, ...(await response.json()) };
    };
    const setBridge = (on) => inWorker(`await chrome.storage.local.set({settings: {bridgeEnabled: ${on}, bridgePort: ${port}}})`);
    try {
      await setBridge(false);
      await sleep(100);
      await setBridge(true);
      equal((await send({ cmd: 'diag' })).result?.id, sw.id, 'on: a command runs');
      await sleep(300); // The worker is holding its next poll now.
      await setBridge(false);
      await sleep(300);
      const refused = await send({ cmd: 'open', url: `${base}/must-not-open` });
      equal(refused.status, 504, `answered: ${JSON.stringify(refused)}`);
      equal(await inWorker("return (await chrome.tabs.query({})).filter((t) => (t.pendingUrl || t.url).includes('must-not-open')).length"), 0, 'it ran while off');
      await setBridge(true);
      equal((await send({ cmd: 'diag' })).result?.id, sw.id, 'on again at once: the old poll left nothing behind');
    } finally {
      await inWorker("await chrome.storage.local.remove('settings')");
      await off.close();
    }
  });

  await browser.close();
  server.close();

  // ---- R9, with a copy of the extension so the checkout is never edited ----

  const copy = join(root, 'copy');
  cpSync(CHECKOUT, copy, { recursive: true, filter: (path) => !path.includes('/.git') && !path.includes('/test') });
  const { server: server2, base: base2 } = await startPages();
  const secondSock = join(root, 'h2.sock');
  const launchSecond = () => Browser.launch({ extensionDir: copy, userDataDir: join(root, 'profile2'), env: { BROWSER_TAB_HELPER_SOCK: secondSock } });
  installHost({ dir: join(root, 'profile2', 'NativeMessagingHosts'), extensionId: extensionIdForPath(copy) });
  let second = await launchSecond();
  try {
    await check('R7 the host starts again when the browser restarts, without waiting for a tab or an alarm', async () => {
      await until('the socket', () => existsSync(secondSock), 10_000);
      await second.close();
      await until('the old host removes its socket', () => !existsSync(secondSock), 5000);
      const started = Date.now();
      second = await launchSecond();
      await until('the socket after a restart', () => existsSync(secondSock), 15_000);
      console.log(`      socket back ${((Date.now() - started) / 1000).toFixed(1)} s after the relaunch`);
    });

    const copyId = extensionIdForPath(copy);
    let worker;
    const attachWorker = async () => {
      worker = await second.worker(copyId);
      await until('the worker\'s APIs', () => second.evalIn(worker.session, "typeof chrome.tabs?.create === 'function'"));
    };
    await attachWorker();
    const inW = (expression) => second.evalIn(worker.session, `(async () => { ${expression} })()`);
    const listUrl = `chrome-extension://${copyId}/src/page/list.html`;
    const listIsOpen = () => [...second.targets.values()].some((info) => info.type === 'page' && info.url === listUrl);

    // The full cycle cannot run here: in --headless=new with --load-extension, chrome.runtime.reload() unloads any
    // extension, even a minimal one, and never brings it back. So these two cover its parts: what a reload leaves
    // behind is picked up, and an edit fires the reload when switched on. When it does not fire is test/reload.test.js.
    await check('R9 the list page comes back from what a reload leaves behind', async () => {
      await inW('await chrome.storage.local.set({reopenList: {windowId: 999999, index: 0, active: true}})');
      await sleep(1000);
      await second.close();
      second = await launchSecond();
      await until('the list page', listIsOpen, 10_000);
      await attachWorker();
      equal(await inW("return (await chrome.storage.local.get('reopenList')).reopenList ?? null"), null, 'used once');
      equal(await inW(`return (await chrome.tabs.query({url: ${JSON.stringify(listUrl)}})).length`), 1);
    });

    await check('R2 an edit to the banner takes effect on the next duplicate, with no reload', async () => {
      await inW("await chrome.storage.local.set({settings: {autoReload: false}})");
      const before = readFileSync(join(copy, 'src/banner/banner.js'), 'utf8');
      writeFileSync(join(copy, 'src/banner/banner.js'), before.replace('(() => {', "(() => { document.documentElement.dataset.editedBanner = 'yes';"));
      const first = await inW(`return (await chrome.tabs.create({url: ${JSON.stringify(`${base2}/edited`)}})).id`);
      await until('load', () => inW(`return (await chrome.tabs.get(${first})).status === 'complete'`));
      await inW(`await chrome.tabs.create({url: ${JSON.stringify(`${base2}/edited?utm_id=1`)}})`);
      const session = await second.page(`${base2}/edited?utm_id=1`);
      await until('the edited banner ran', () => second.evalIn(session, "document.documentElement.dataset.editedBanner === 'yes'"));
    });

    const manifestPath = join(copy, 'manifest.json');

    // Switched off, an edit does not reload: test/reload.test.js covers that decision, so no 35 s wait here.
    let cardSession = null;

    await check('R9 switched on, a manifest edit fires the reload within about 30 s', async () => {
      // Attached before the reload: this card is the one the next check finds orphaned.
      const listSession = await second.page(listUrl);
      cardSession = await second.page(`${base2}/edited?utm_id=1`);
      await second.evalIn(listSession, "chrome.storage.local.set({settings: {autoReload: true}})");
      const started = Date.now();
      writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('"version": "0.1.0"', '"version": "0.1.1"'));
      await until('the reload closes the list page', () => !listIsOpen(), 40_000).catch(async (error) => {
        const state = await second.evalIn(listSession, `Promise.all([chrome.storage.local.get(), chrome.alarms.getAll()]).then(([s, a]) => JSON.stringify({
          settings: s.settings, hash: s.fileHash?.slice(0, 8), reopen: s.reopenList, alarmInMs: a[0] && a[0].scheduledTime - Date.now(), manifest: chrome.runtime.getManifest().version,
        }))`).catch((inner) => `unreadable: ${inner.message}`);
        const workers = [...second.targets.values()].filter((info) => info.type === 'service_worker').map((info) => info.url.split('/')[2]);
        throw new Error(`${error.message}; state ${state}; workers ${workers}; ${copyId}`);
      });
      const seconds = (Date.now() - started) / 1000;
      console.log(`      reload fired after ${seconds.toFixed(1)} s`);
      ok(seconds < 35, `took ${seconds} s`);
    });

    await check('R2 a card left over from before a reload dismisses cleanly', async () => {
      // The reload above has just orphaned this card's script, so its message cannot be sent.
      await second.send('Page.bringToFront', {}, cardSession);
      await second.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'j', text: 'j' }, cardSession);
      await second.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'j' }, cardSession);
      await until('the card goes', () => second.evalIn(cardSession, "!document.getElementById('browser-tab-helper-card')"));
      await sleep(300);
      equal(second.errors.filter((text) => /context invalidated|sendMessage|runtime/i.test(text)), [], 'exceptions');
    });
  } finally {
    await second.close();
    server2.close();
    // Chromium's last helper processes can still be writing here for a moment after the kill.
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
