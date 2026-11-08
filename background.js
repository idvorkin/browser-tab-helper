// The service worker. All browser state lives in Chrome and storage.local, because Chrome kills this at will.
import { ALIAS_RULES } from './src/data/aliases.js';
import { boundShortcuts, buildCard, COMMAND_ACTIONS } from './src/lib/card.js';
import { findControl, keyEvents, numberControls } from './src/lib/controls.js';
import { compileRules, decideCard, duplicateGroups, liveMutes, MUTE_MS, redundantCount } from './src/lib/duplicates.js';
import { buildLayout, planRestore, validateLayout } from './src/lib/layouts.js';
import { normalizeUrl } from './src/lib/normalize.js';
import { pageControls, readSelection } from './src/lib/page-scripts.js';
import { isPacked, reloadDecision, reopenRecord } from './src/lib/reload.js';
import { withDefaults } from './src/lib/settings.js';
import { updateDocTabs } from './src/lib/titles.js';
import { WATCHED_FILES } from './src/lib/watched-files.js';

const RULES = compileRules(ALIAS_RULES);
const LIST_URL = chrome.runtime.getURL('src/page/list.html');
const NATIVE_HOST = 'browser_tab_helper';
const TICK_ALARM = 'tick';
const SELECTION_TIMEOUT_MS = 500;
const POLL_TIMEOUT_MS = 28_000;

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return withDefaults(settings);
}

async function getMuted() {
  const { muted } = await chrome.storage.local.get('muted');
  return liveMutes(muted, Date.now());
}

async function muteUrl(url) {
  const key = normalizeUrl(url);
  if (!key) return;
  await chrome.storage.local.set({ muted: { ...(await getMuted()), [key]: Date.now() + MUTE_MS } });
}

// ---- R2, R3: the card ----

async function hideCard(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.getElementById('browser-tab-helper-card')?.remove(),
  }).catch(() => {});
}

async function showCard(tab, decision) {
  const card = buildCard(decision, tab, boundShortcuts(await chrome.commands.getAll()));
  const target = { tabId: tab.id };
  // Injected from its file each time, so an edit to the banner takes effect on the next duplicate with no reload.
  await chrome.scripting.executeScript({
    target,
    func: (data) => { globalThis.browserTabHelperCard = data; },
    args: [card],
  });
  await chrome.scripting.executeScript({ target, files: ['src/banner/banner.js'] });
}

async function checkLandedTab(tab) {
  if (!(await getSettings()).askEnabled) return;
  const tabs = await chrome.tabs.query({});
  const decision = decideCard(tab, tabs, { rules: RULES, muted: await getMuted(), now: Date.now() });
  if (!decision) return;
  try {
    await showCard(tab, decision);
    logEvent('card', { kind: decision.kind, url: tab.url, target: decision.target?.id ?? null });
  } catch (error) {
    // A page that refuses scripts (the Web Store, a file: page without access) simply gets no card.
    logEvent('card-failed', { url: tab.url, error: String(error) });
  }
}

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

/** A card action or Chrome command. Worked out afresh, since the other tab may have gone while the card sat up. */
async function runCardAction(action, tabId) {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return { done: false };
  // Mutes are ignored here: a command acts on the current tab whether or not a card is up.
  const decision = decideCard(tab, tabs, { rules: RULES });
  logEvent('card-action', { action, url: tab.url, decided: decision?.kind ?? null });
  if (!decision) {
    await hideCard(tab.id);
    return { done: false };
  }

  if (action === 'keep') {
    await muteUrl(tab.url);
    await hideCard(tab.id);
    return { done: true };
  }

  if (decision.kind === 'offer') {
    if (action !== 'jump') return { done: false };
    await chrome.tabs.update(tab.id, { url: decision.rule.canonical });
    return { done: true };
  }

  const { target, copies } = decision;
  if (action === 'jump') {
    await focusTab(target);
    await chrome.tabs.remove(tab.id);
  } else if (action === 'bring') {
    if (target.windowId === tab.windowId) return { done: false };
    await chrome.tabs.move(target.id, { windowId: tab.windowId, index: tab.index });
    await chrome.tabs.update(target.id, { active: true });
    await chrome.tabs.remove(tab.id);
  } else if (action === 'close-other') {
    if (!copies.length) return { done: false };
    // One at a time, so each lands on Chrome's recently-closed stack for Cmd+Shift+T.
    for (const copy of copies) await chrome.tabs.remove(copy.id);
    await hideCard(tab.id);
  } else {
    return { done: false };
  }
  return { done: true };
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  const action = COMMAND_ACTIONS[command];
  if (!action) return;
  const current = tab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (current) await runCardAction(action, current.id);
});

// ---- R4: the list page and the badge ----

async function openList() {
  const [existing] = await chrome.tabs.query({ url: LIST_URL });
  if (existing) await focusTab(existing);
  else await chrome.tabs.create({ url: LIST_URL });
}

chrome.action.onClicked.addListener(openList);

let badgeTimer = null;
function scheduleBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    const count = redundantCount(await chrome.tabs.query({}), RULES);
    await chrome.action.setBadgeText({ text: count ? String(count) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
  }, 200);
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.status) scheduleBadge();
  if (change.status === 'complete') checkLandedTab(tab);
});
chrome.tabs.onCreated.addListener(scheduleBadge);
chrome.tabs.onRemoved.addListener(scheduleBadge);
chrome.tabs.onReplaced.addListener(scheduleBadge);

// ---- R7: the native host ----

let hostPort = null;

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, fail) => setTimeout(() => fail(new Error('timed out')), ms))]);
}

// Asked for only when a tool asks, so no script is added to every page. Pages that refuse scripts answer with none.
async function selectionIn(tabId) {
  try {
    const results = await withTimeout(chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: readSelection,
    }), SELECTION_TIMEOUT_MS);
    const [found] = results.sort((a, b) => a.frameId - b.frameId).filter((frame) => frame.result);
    return found?.result ?? null;
  } catch {
    return null;
  }
}

async function frontPage() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return { error: 'no front tab' };
  return { title: tab.title ?? '', url: tab.url ?? '', selection: await selectionIn(tab.id) };
}

function connectHost() {
  if (hostPort) return;
  hostPort = chrome.runtime.connectNative(NATIVE_HOST);
  // An open native port also keeps this worker alive, which is what makes the answer take milliseconds.
  hostPort.onMessage.addListener(async ({ type, id }) => {
    if (type !== 'front') return;
    const answer = await frontPage().catch((error) => ({ error: String(error) }));
    hostPort?.postMessage({ id, ...answer });
  });
  hostPort.onDisconnect.addListener(() => {
    // Reading lastError marks it handled. A host that is not installed lands here; the next tick tries again.
    logEvent('host-disconnected', { error: chrome.runtime.lastError?.message ?? null });
    hostPort = null;
  });
}

// ---- R5: restoring a layout ----

async function placeTab(windowId, planned) {
  let id = planned.tabId;
  if (id !== null) {
    await chrome.tabs.move(id, { windowId, index: -1 });
  } else {
    ({ id } = await chrome.tabs.create({ windowId, url: planned.url, active: false }));
  }
  await chrome.tabs.update(id, { pinned: planned.pinned });
  return id;
}

async function restoreLayout(layout) {
  const errors = validateLayout(layout);
  if (errors.length) return { errors };
  const { windows, skipped } = planRestore(layout, await chrome.tabs.query({}));
  let opened = 0;
  let moved = 0;
  const count = (planned) => {
    if (planned.tabId === null) opened += 1;
    else moved += 1;
  };

  for (const { items } of windows) {
    const first = items[0].kind === 'tab' ? items[0] : items[0].tabs[0];
    const created = await chrome.windows.create(first.tabId !== null
      ? { tabId: first.tabId, focused: false }
      : { url: first.url, focused: false });
    const windowId = created.id;
    const placeFirst = async (planned) => {
      if (planned !== first) return placeTab(windowId, planned);
      const id = created.tabs[0].id;
      await chrome.tabs.update(id, { pinned: planned.pinned });
      return id;
    };

    for (const item of items) {
      if (item.kind === 'tab') {
        count(item);
        await placeFirst(item);
      } else {
        const tabIds = [];
        for (const planned of item.tabs) {
          count(planned);
          tabIds.push(await placeFirst(planned));
        }
        const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
        await chrome.tabGroups.update(groupId, { title: item.title, color: item.color, collapsed: item.collapsed });
      }
    }
  }
  return { errors: [], skipped, windows: windows.length, opened, moved };
}

async function currentLayout() {
  const [windows, tabs, groups] = await Promise.all([
    chrome.windows.getAll(), chrome.tabs.query({}), chrome.tabGroups.query({}),
  ]);
  return buildLayout({ name: 'layout', windows, tabs, groups });
}

// ---- Messages from the banner, the Docs script and the page ----

const MESSAGE_HANDLERS = {
  'card-action': (message, sender) => runCardAction(message.action, sender.tab?.id),
  'doc-tab': async ({ url, name }) => {
    const { docTabs } = await chrome.storage.local.get('docTabs');
    // ponytail: one short string per named document tab ever seen, never pruned. Cap it if it ever shows up in
    // storage usage.
    await chrome.storage.local.set({ docTabs: updateDocTabs(docTabs ?? {}, url, name) });
  },
  'restore-layout': ({ layout }) => restoreLayout(layout),
};

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const handler = sender.id === chrome.runtime.id ? MESSAGE_HANDLERS[message?.type] : null;
  if (!handler) return false;
  Promise.resolve(handler(message, sender)).then(respond, (error) => respond({ error: String(error) }));
  return true;
});

// ---- R8: the bridge ----

let bridgeUp = true;
let polling = false;
let pollAbort = null;

function bridgeUrl(settings, path) {
  return `http://127.0.0.1:${settings.bridgePort}${path}`;
}

// How tools/bridge.js tells the extension from a web page.
const BRIDGE_HEADERS = { 'x-browser-tab-helper': '1' };

async function logEvent(event, detail = {}) {
  const settings = await getSettings();
  if (!settings.bridgeEnabled || !bridgeUp) return;
  fetch(bridgeUrl(settings, '/event'), { method: 'POST', headers: BRIDGE_HEADERS, body: JSON.stringify({ event, ...detail }) }).catch(() => {});
}

function rowOf(tab) {
  return {
    id: tab.id, windowId: tab.windowId, index: tab.index, active: tab.active, pinned: tab.pinned, groupId: tab.groupId,
    title: tab.title, url: tab.url, status: tab.status,
  };
}

async function tabFor(command) {
  if (command.tab !== undefined) return chrome.tabs.get(command.tab);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('no front tab');
  return tab;
}

async function readTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: pageControls,
    args: ['read'],
  });
  const frames = results
    .filter((frame) => frame.result)
    .map((frame) => ({ frameId: frame.frameId, ...frame.result }));
  return { frames, controls: numberControls(frames) };
}

const debuggerTabs = new Set();

// Attached only for the action and detached right after, so Chrome's "is debugging this browser" bar stays brief.
async function withDebugger(tabId, action) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  debuggerTabs.add(tabId);
  try {
    return await action(target);
  } finally {
    debuggerTabs.delete(tabId);
    await chrome.debugger.detach(target).catch(() => {});
  }
}

// For a command that ran out of time: its withDebugger may be stuck for good, so its finally cannot be relied on.
async function releaseDebuggers() {
  for (const tabId of [...debuggerTabs]) {
    debuggerTabs.delete(tabId);
    await withTimeout(chrome.debugger.detach({ tabId }), 2000).catch(() => {});
  }
}

async function clickControl(tabId, wanted, signal) {
  const { controls } = await readTab(tabId);
  const control = findControl(controls, wanted);
  if (!control) throw new Error(`no control matches ${JSON.stringify(wanted)}`);
  const [{ result: point }] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [control.frameId] },
    func: pageControls,
    args: ['locate', control.localIndex],
  });
  if (point.error) throw new Error(point.error);
  if (point.clicked) return { label: control.label, via: 'dom' };

  // A page that was hung may recover long after the asker was told this failed. Do not click it then.
  signal?.throwIfAborted();
  await withDebugger(tabId, async (target) => {
    const mouse = (type, extra = {}) => chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type, x: point.x, y: point.y, ...extra });
    await mouse('mouseMoved');
    await mouse('mousePressed', { button: 'left', clickCount: 1 });
    await mouse('mouseReleased', { button: 'left', clickCount: 1 });
  });
  return { label: control.label, via: 'debugger' };
}

const BRIDGE_COMMANDS = {
  diag: async () => ({
    version: chrome.runtime.getManifest().version,
    id: chrome.runtime.id,
    tabs: (await chrome.tabs.query({})).length,
    windows: (await chrome.windows.getAll()).length,
    redundant: redundantCount(await chrome.tabs.query({}), RULES),
    hostConnected: hostPort !== null,
    settings: await getSettings(),
  }),
  tabs: async () => (await chrome.tabs.query({})).map(rowOf),
  duplicates: async () => duplicateGroups(await chrome.tabs.query({}), RULES)
    .map(({ key, keeper, extras }) => ({ key, keeper: rowOf(keeper), extras: extras.map(rowOf) })),
  activate: async (command) => {
    const tab = await tabFor(command);
    await focusTab(tab);
    return rowOf(tab);
  },
  close: async (command) => {
    await chrome.tabs.remove((await tabFor(command)).id);
    return { closed: true };
  },
  open: async ({ url }) => rowOf(await chrome.tabs.create({ url })),
  navigate: async (command) => rowOf(await chrome.tabs.update((await tabFor(command)).id, { url: command.url })),
  reload: async (command) => {
    await chrome.tabs.reload((await tabFor(command)).id);
    return { reloaded: true };
  },
  layout: currentLayout,
  'restore-layout': ({ layout }) => restoreLayout(layout),
  read: async (command) => {
    const tab = await tabFor(command);
    const { frames, controls } = await readTab(tab.id);
    return {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      frames: frames.map(({ frameId, text }) => ({ frameId, text })),
      controls,
    };
  },
  click: async (command, signal) => clickControl((await tabFor(command)).id, command.target, signal),
  type: async (command) => withDebugger((await tabFor(command)).id, async (target) => {
    await chrome.debugger.sendCommand(target, 'Input.insertText', { text: command.text });
    return { typed: command.text.length };
  }),
  key: async (command) => withDebugger((await tabFor(command)).id, async (target) => {
    for (const event of keyEvents(command.key)) await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', event);
    return { pressed: command.key };
  }),
  screenshot: async (command) => {
    const tab = await tabFor(command);
    if (!tab.active) throw new Error(`tab ${tab.id} is not the active tab of its window; activate it first`);
    return { dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }) };
  },
};

/**
 * Runs one command within its time limit. A hung page never answers script injection or CDP input, so without a limit
 * one command would hold the bridge and the debugger for good. The command itself cannot be cancelled, only abandoned.
 */
async function runBridgeCommand(command, limitMs) {
  const run = BRIDGE_COMMANDS[command.cmd];
  if (!run) return { id: command.id, error: `unknown command: ${command.cmd}` };
  const abandoned = new AbortController();
  let timer;
  const expired = new Promise((_, fail) => {
    timer = setTimeout(() => {
      abandoned.abort();
      fail(new Error(`${command.cmd} did not finish in ${Math.round(limitMs / 1000)} s. The page may be hung.`));
    }, limitMs);
  });
  try {
    return { id: command.id, result: await Promise.race([run(command, abandoned.signal), expired]) };
  } catch (error) {
    if (abandoned.signal.aborted) await releaseDebuggers();
    return { id: command.id, error: error.message ?? String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One poll per alarm tick, and at once again after a command. The server holds an empty poll for about 25 s and an
 * asker for about 95 s, so a command landing between polls waits for the next tick rather than being lost. A dead
 * server costs one failed fetch.
 *
 * Switching off aborts a held poll, and the setting is read afresh before each poll and each command, so nothing runs
 * once it is off.
 */
async function pollBridge() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const settings = await getSettings();
      if (!settings.bridgeEnabled) return;
      pollAbort = new AbortController();
      const response = await fetch(bridgeUrl(settings, '/next'), {
        headers: BRIDGE_HEADERS,
        signal: AbortSignal.any([pollAbort.signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]),
      });
      bridgeUp = true;
      if (response.status !== 200) return;
      const command = await response.json();
      const latest = await getSettings();
      const answer = latest.bridgeEnabled
        ? await runBridgeCommand(command, latest.bridgeCommandTimeoutMs)
        : { id: command.id, error: 'the bridge was switched off before this command ran' };
      await fetch(bridgeUrl(settings, '/result'), {
        method: 'POST',
        headers: BRIDGE_HEADERS,
        body: JSON.stringify(answer),
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      });
    }
  } catch {
    bridgeUp = false;
  } finally {
    polling = false;
    pollAbort = null;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const before = withDefaults(changes.settings.oldValue);
  const after = withDefaults(changes.settings.newValue);
  if (before.bridgeEnabled && !after.bridgeEnabled) pollAbort?.abort();
  if (after.bridgeEnabled && !before.bridgeEnabled) {
    bridgeUp = true;
    pollBridge();
  }
});

// ---- R9: reload on change ----

async function hashWatchedFiles() {
  const parts = await Promise.all(WATCHED_FILES.map(async (path) => {
    const response = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' });
    return `${path}\n${await response.text()}\n`;
  }));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('')));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function reloadIfChanged() {
  // The rules are in src/lib/reload.js; this hashes, reads storage and calls Chrome.
  if (isPacked(chrome.runtime.getManifest())) return;
  const { autoReload } = await getSettings();
  let current;
  try {
    current = await hashWatchedFiles();
  } catch {
    return; // A file mid-save or deleted: look again on the next tick.
  }
  const { fileHash } = await chrome.storage.local.get('fileHash');
  const { store, reload } = reloadDecision({ autoReload, current, stored: fileHash });
  if (store !== null) await chrome.storage.local.set({ fileHash: store });
  if (!reload) return;

  const [listTab] = await chrome.tabs.query({ url: LIST_URL });
  const reopenList = reopenRecord(listTab);
  if (reopenList) await chrome.storage.local.set({ reopenList });
  logEvent('self-reload');
  chrome.runtime.reload();
}

async function reopenListAfterReload() {
  const { reopenList } = await chrome.storage.local.get('reopenList');
  if (!reopenList) return;
  await chrome.storage.local.remove('reopenList');
  const [existing] = await chrome.tabs.query({ url: LIST_URL });
  if (existing) return;
  const properties = { url: LIST_URL, windowId: reopenList.windowId, index: reopenList.index, active: reopenList.active };
  await chrome.tabs.create(properties).catch(() => chrome.tabs.create({ url: LIST_URL }));
}

// ---- The tick, and start-up ----

chrome.alarms.onAlarm.addListener(async ({ name }) => {
  if (name !== TICK_ALARM) return;
  connectHost();
  await reloadIfChanged();
  await pollBridge();
});

// Chrome only starts a worker for an event it has a listener for. These do nothing but ensure it runs, and so runs
// start() below, when the browser starts and after a reload, rather than at the next tab event.
chrome.runtime.onStartup.addListener(() => {});
chrome.runtime.onInstalled.addListener(() => {});

async function start() {
  if (!(await chrome.alarms.get(TICK_ALARM))) {
    await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
  }
  connectHost();
  scheduleBadge();
  await reopenListAfterReload();
  await reloadIfChanged();
  await pollBridge();
}

start();
