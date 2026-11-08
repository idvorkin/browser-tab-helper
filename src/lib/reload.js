// R9: whether the self-reload fires. The worker hashes the watched files, reads storage and calls Chrome; this decides.

/** One from the store has an update_url, and its files cannot change, so it never reloads itself. */
export function isPacked(manifest) {
  return 'update_url' in manifest;
}

/**
 * `current` is the hash of the watched files now, `stored` the one in storage (undefined on the first run).
 * Returns the hash to store (null for none) and whether to reload.
 */
export function reloadDecision({ autoReload, current, stored }) {
  // While switched off the stored hash stays old, so switching on picks up what changed in the meantime.
  if (current === stored || (!autoReload && stored !== undefined)) return { store: null, reload: false };
  // The first run only records where the files start.
  return { store: current, reload: stored !== undefined };
}

/** A reload closes the extension's own pages, so note where the list was to put it back. */
export function reopenRecord(listTab) {
  if (!listTab) return null;
  return { windowId: listTab.windowId, index: listTab.index, active: listTab.active };
}
