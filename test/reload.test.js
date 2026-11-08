// R9: when the self-reload fires. The worker only hashes, stores and calls chrome.runtime.reload().
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPacked, reloadDecision, reopenRecord } from '../src/lib/reload.js';

const NOTHING = { store: null, reload: false };

test('a store install never reloads; an unpacked one may', () => {
  assert.equal(isPacked({ manifest_version: 3, update_url: 'https://edge.microsoft.com/extensionwebstorebase/v1/crx' }), true);
  assert.equal(isPacked({ manifest_version: 3 }), false);
});

test('the first run stores the hash and does not reload, switched on or off', () => {
  for (const autoReload of [true, false]) {
    assert.deepEqual(reloadDecision({ autoReload, current: 'a', stored: undefined }), { store: 'a', reload: false });
  }
});

test('an unchanged hash does nothing, switched on or off', () => {
  for (const autoReload of [true, false]) {
    assert.deepEqual(reloadDecision({ autoReload, current: 'a', stored: 'a' }), NOTHING);
  }
});

test('switched on, an edit stores the new hash and reloads', () => {
  assert.deepEqual(reloadDecision({ autoReload: true, current: 'b', stored: 'a' }), { store: 'b', reload: true });
});

test('switched off, an edit stores nothing and does not reload', () => {
  assert.deepEqual(reloadDecision({ autoReload: false, current: 'b', stored: 'a' }), NOTHING);
});

test('edits made while switched off reload once it is switched on', () => {
  let stored;
  const tick = (autoReload, current) => {
    const decision = reloadDecision({ autoReload, current, stored });
    if (decision.store !== null) stored = decision.store;
    return decision.reload;
  };
  assert.equal(tick(true, 'v0'), false, 'first run');
  assert.equal(tick(false, 'v1'), false, 'off: the edit is not acted on');
  assert.equal(tick(false, 'v2'), false, 'off: nor the next');
  assert.equal(stored, 'v0', 'the old hash is kept while off');
  assert.equal(tick(true, 'v2'), true, 'on: the edits made while off fire the reload');
  assert.equal(stored, 'v2');
  assert.equal(tick(true, 'v2'), false, 'and only once');
});

test('the list tab\'s place is recorded for reopening, and nothing when it is not open', () => {
  const listTab = { id: 7, windowId: 3, index: 2, active: true, url: 'chrome-extension://x/src/page/list.html', title: 'Tabs' };
  assert.deepEqual(reopenRecord(listTab), { windowId: 3, index: 2, active: true });
  assert.equal(reopenRecord(undefined), null);
});
