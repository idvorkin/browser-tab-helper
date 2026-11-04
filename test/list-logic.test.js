import test from 'node:test';
import assert from 'node:assert/strict';
import { groupByKind, kindCounts, kindOf, matchesKindChip, OTHER_KIND } from '../src/lib/kinds.js';
import { windowName } from '../src/lib/window-names.js';
import { groupSections, nextSelection, orderWindows, visibleTabs } from '../src/lib/view.js';
import { cleanTitle, docKey, rowTitle, updateDocTabs } from '../src/lib/titles.js';
import { KIND_RULES } from '../src/data/kinds.js';

const RULES = [
  { name: 'Dev servers', hosts: ['localhost'] },
  { name: 'Docs', hosts: ['docs.example.com'] },
  { name: 'Code', hosts: ['example.com'] },
];
const tab = (url, extra = {}) => ({ url, title: url, ...extra });
const many = (n, url) => Array.from({ length: n }, (_, i) => tab(`${url}/${i}`));

test('kindOf: rules, subdomains, first match wins, hostname otherwise', () => {
  assert.deepEqual(kindOf('http://localhost:3000/', RULES), { kind: 'Dev servers', known: true });
  assert.deepEqual(kindOf('https://docs.example.com/a', RULES), { kind: 'Docs', known: true });
  assert.deepEqual(kindOf('https://git.example.com/a', RULES), { kind: 'Code', known: true });
  assert.deepEqual(kindOf('https://www.other.test/a', RULES), { kind: 'other.test', known: false });
  assert.deepEqual(kindOf('chrome://settings/', RULES), { kind: 'Browser', known: false });
  assert.deepEqual(kindOf('file:///tmp/a', RULES), { kind: 'Files', known: false });
  assert.equal(kindOf('https://notexample.com/', RULES).known, false, 'suffix must be a whole label');
});

test('the shipped kinds name the same groups the issue does', () => {
  const names = KIND_RULES.map((rule) => rule.name);
  for (const name of ['Code', 'Docs', 'Chat', 'Dev servers']) assert.ok(names.includes(name));
  assert.equal(kindOf('https://docs.github.com/x', KIND_RULES).kind, 'Docs');
  assert.equal(kindOf('https://github.com/x', KIND_RULES).kind, 'Code');
});

test('kind chips count per kind and filter', () => {
  const tabs = [...many(2, 'http://localhost'), tab('https://example.com/'), tab('https://a.test/'), tab('chrome://x/')];
  assert.deepEqual(kindCounts(tabs, RULES), [
    { kind: 'Dev servers', count: 2 }, { kind: 'Code', count: 1 }, { kind: OTHER_KIND, count: 2 },
  ]);
  assert.ok(matchesKindChip(tabs[0], 'Dev servers', RULES));
  assert.ok(!matchesKindChip(tabs[0], 'Code', RULES));
  assert.ok(matchesKindChip(tabs[3], OTHER_KIND, RULES));
  assert.ok(!matchesKindChip(tabs[0], OTHER_KIND, RULES));
});

test('By kind: rule kinds first, in rule order, then hostnames', () => {
  const names = groupByKind([tab('https://z.test/'), tab('https://example.com/'), tab('https://b.test/'), tab('http://localhost/')], RULES)
    .map((group) => group.name);
  assert.deepEqual(names, ['Dev servers', 'Code', 'b.test', 'z.test']);
});

test('window name: one kind when nearly all that kind', () => {
  const tabs = [...many(9, 'http://localhost'), tab('https://a.test/')];
  assert.equal(windowName(tabs, { rules: RULES }), 'Dev servers');
});

test('window name: its mix otherwise', () => {
  const tabs = [...many(16, 'http://localhost'), ...many(4, 'https://docs.example.com'), ...many(2, 'https://a.test')];
  assert.equal(windowName(tabs, { rules: RULES }), 'Dev servers 16 · Docs 4');
});

test('window name: the active tab title when kinds say little', () => {
  const tabs = [tab('https://a.test/', { title: 'A' }), tab('https://b.test/', { title: 'B', active: true }), tab('https://c.test/', { title: 'C' })];
  assert.equal(windowName(tabs, { rules: RULES }), 'B');
});

test('window name: never the list page or a New Tab', () => {
  const listUrl = 'chrome-extension://abc/src/page/list.html';
  const tabs = [
    tab(listUrl, { title: 'Tabs', active: true }),
    tab('chrome://newtab/', { title: 'New Tab' }),
    tab('https://a.test/', { title: 'Real page' }),
  ];
  assert.equal(windowName(tabs, { rules: RULES, listUrl }), 'Real page');
  assert.equal(windowName([tab('chrome://newtab/', { title: 'New Tab' })], { rules: RULES, listUrl }), 'Empty window');
  assert.equal(windowName([tab('edge://newtab/', { title: 'New tab' })], { rules: RULES, listUrl }), 'Empty window');
  assert.doesNotMatch(windowName([tab(listUrl, { title: 'Tabs' })], { rules: RULES, listUrl }), /Tabs|Window \d/);
});

test('window name: a lone known tab shows its title, not a kind', () => {
  assert.equal(windowName([tab('http://localhost/', { title: 'App', active: true })], { rules: RULES }), 'App');
});

test('windows: yours first, normal only', () => {
  const windows = [{ id: 1, type: 'normal' }, { id: 2, type: 'popup' }, { id: 3, type: 'normal' }];
  assert.deepEqual(orderWindows(windows, 3).map((w) => w.id), [3, 1]);
});

test('visibleTabs: text, kind chip and window filters combine', () => {
  const tabs = [
    tab('http://localhost/a', { windowId: 1, title: 'Alpha' }),
    tab('http://localhost/b', { windowId: 2, title: 'Beta' }),
    tab('https://a.test/', { windowId: 1, title: 'Gamma' }),
  ];
  assert.equal(visibleTabs(tabs).length, 3);
  assert.deepEqual(visibleTabs(tabs, { filter: 'BET' }).map((t) => t.title), ['Beta']);
  assert.deepEqual(visibleTabs(tabs, { filter: 'a.test' }).map((t) => t.title), ['Gamma']);
  assert.deepEqual(visibleTabs(tabs, { onlyWindow: 1 }).map((t) => t.title), ['Alpha', 'Gamma']);
  assert.deepEqual(visibleTabs(tabs, { kindChip: 'Dev servers', rules: RULES, onlyWindow: 2 }).map((t) => t.title), ['Beta']);
});

test('groupSections lists groups in strip order, then loose tabs', () => {
  const tabs = [
    { id: 1, windowId: 1, index: 1, groupId: 7 },
    { id: 2, windowId: 1, index: 0, groupId: 7 },
    { id: 3, windowId: 1, index: 2, groupId: -1 },
  ];
  const { groups, loose } = groupSections(tabs, [{ id: 7, title: 'G' }, { id: 8, title: 'empty' }]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].tabs.map((t) => t.id), [2, 1]);
  assert.deepEqual(loose.map((t) => t.id), [3]);
});

test('selection: Cmd toggles, Shift takes the range', () => {
  const visible = [1, 2, 3, 4, 5];
  let state = nextSelection(new Set(), visible, null, 2);
  assert.deepEqual([...state.selected], [2]);
  state = nextSelection(state.selected, visible, state.anchor, 4, { range: true });
  assert.deepEqual([...state.selected].sort(), [2, 3, 4]);
  state = nextSelection(state.selected, visible, state.anchor, 3);
  assert.deepEqual([...state.selected].sort(), [2, 4]);
});

test('the app suffix is dropped everywhere', () => {
  assert.equal(cleanTitle('Plan - Google Docs'), 'Plan');
  assert.equal(cleanTitle('Budget - Google Sheets'), 'Budget');
  assert.equal(cleanTitle('Talk – Google Slides'), 'Talk');
  assert.equal(cleanTitle('Google Docs tips'), 'Google Docs tips');
  assert.equal(cleanTitle(undefined), '');
});

test('docKey is per doc and document tab', () => {
  assert.equal(docKey('https://docs.google.com/document/d/ABC/edit?tab=t.1'), 'ABC:t.1');
  assert.equal(docKey('https://docs.google.com/document/d/ABC/edit#tab=t.2'), 'ABC:t.2');
  assert.equal(docKey('https://docs.google.com/document/u/1/d/ABC/edit'), 'ABC:');
  assert.equal(docKey('https://docs.google.com/spreadsheets/d/ABC/edit'), null);
  assert.equal(docKey('https://example.com/document/d/ABC/'), null);
  assert.equal(docKey('nope'), null);
});

test('Docs rows name the document tab; a doc with one tab shows none', () => {
  const url = 'https://docs.google.com/document/d/ABC/edit?tab=t.1';
  const named = updateDocTabs({}, url, 'Chapter 2');
  assert.equal(rowTitle({ url, title: 'Plan - Google Docs' }, named), 'Plan › Chapter 2');
  const cleared = updateDocTabs(named, url, null);
  assert.deepEqual(cleared, {});
  assert.equal(rowTitle({ url, title: 'Plan - Google Docs' }, cleared), 'Plan');
  assert.equal(updateDocTabs(named, 'https://example.com/', 'x'), named);
});
