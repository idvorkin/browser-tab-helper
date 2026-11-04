// R4: window names come from their content. Never `Window 2`, which renumbers whenever a window closes.
import { kindOf } from './kinds.js';

const NEARLY_ALL = 0.8;
const MOSTLY_KNOWN = 0.5;
const MIX_PARTS = 3;

const NEW_TAB_URLS = ['edge://newtab/', 'chrome://newtab/', 'chrome://new-tab-page/', 'about:blank', 'about:newtab'];

export function windowName(tabs, { rules, listUrl = null, titleOf = (tab) => tab.title } = {}) {
  const real = tabs.filter((tab) => !NEW_TAB_URLS.includes(tab.url) && !(listUrl && tab.url?.startsWith(listUrl)));
  if (!real.length) return 'Empty window';

  const counts = new Map();
  for (const tab of real) {
    const { kind, known } = kindOf(tab.url, rules);
    if (known) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const knownTotal = ranked.reduce((sum, [, count]) => sum + count, 0);

  if (ranked.length && real.length > 1 && ranked[0][1] / real.length >= NEARLY_ALL) return ranked[0][0];
  if (ranked.length > 1 && knownTotal / real.length >= MOSTLY_KNOWN) {
    return ranked.slice(0, MIX_PARTS).map(([kind, count]) => `${kind} ${count}`).join(' · ');
  }
  const active = real.find((tab) => tab.active) ?? real[0];
  return titleOf(active) || active.url;
}
