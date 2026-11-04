# Requirements

What this extension must do. Manifest V3, plain JavaScript modules, no build step, no runtime dependencies. URL, grouping
and layout logic stays pure, in `src/lib/`, so it is tested with `node --test` and no browser. Only `background.js`, the
banner, the Docs content script and the list page touch `chrome.*`.

Permissions: `tabs`, `tabGroups`, `storage`, `sessions` (undo), `alarms` (self-reload, bridge polling), `scripting`
(reading a selection on request, drawing the card), `clipboardRead` (Open section), `nativeMessaging` (R7), `debugger` (R8
clicks and typing only), and `<all_urls>` host access.

## R1. Same page: the normalizer

Two tabs are the same page when their normalized URLs match. Being conservative matters most: falsely calling two tabs
duplicates is much worse than missing a pair.

- Only `http:`, `https:` and `file:` URLs take part. Anything else has no key.
- Strip a leading `www.`, and trailing slashes on the path (the root `/` stays).
- Drop tracking params, case-insensitively: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`,
  `utm_id`, `utm_name`, `fbclid`, `gclid`, `dclid`, `msclkid`, `yclid`, `igshid`, `mc_cid`, `mc_eid`, `wbraid`, `gbraid`,
  `ref_src`, `ref_url`, `_hsenc`, `_hsmi`.
- Sort the remaining params by key, then value, so their order does not matter. Every other param counts.
- Keep the whole `#fragment`. Apps keep state there, and nothing reliably tells that from a scroll anchor. Keeping it can
  only miss a duplicate; dropping it invents one.

**Accepted when** unit tests cover each rule, including a fragment-only difference staying distinct.

## R2. The duplicate card

When a tab finishes loading a page already open in another tab, a card asks what to do.

- It sits dead centre over a dimmed page and never times out, because its job is to stop you before you settle into the
  wrong tab.
- Each action has a one-letter key shown in its corner, and Enter takes the primary one:
  - **Jump to it** (`j`): focus the existing tab, close this duplicate.
  - **Bring here** (`b`), only when the existing tab is in another window: move it here at the duplicate's position, close
    the duplicate.
  - **Close the other** (`x` or `c`), only when an older copy exists: stay here and close the older copy, or every older
    copy. Cmd+Shift+T brings them back.
  - **Keep both** (`k`): dismiss, and stop asking about this URL for an hour.
- Escape, a click on the backdrop, or × dismiss it.
- The keys work alongside Vimium-style extensions: while the card is up, focus sits in a hidden read-only input inside it,
  so those extensions see a text field and let the letters through.
- A page cannot press the card's actions: they ignore untrusted events.
- Each action also has a Chrome command (default ⌥⇧D, ⌥⇧B, ⌥⇧X, ⌥⇧K), acting on the current tab whether or not the card
  is up. The card lists the keys actually bound, since they can be changed at `edge://extensions/shortcuts`.
- The banner script is injected fresh each time it is shown, so an edit takes effect on the next duplicate with no reload.

## R3. Alias rules: two front doors to one place

Some destinations have several URLs. An alias rule, in one data file, names the destination, its canonical URL, a regex
for URLs that already are the canonical door, and regexes for the other doors.

- Patterns match whole doors. A door must not match a longer path that merely starts the same way, a deep page on the same
  site, or another signed-in account.
- Landing on another door while a canonical tab is open gets the normal card, pointing at the canonical tab, which wins
  even when newer and even when the other tab is pinned.
- Landing on another door with no canonical tab open gets a card offering to go to the canonical URL (`j`), or **Stay
  here** (`k`), which silences it for that URL for an hour.
- Optional, and not built: a `declarativeNetRequest` redirect that skips the card for top-level loads only.

## R4. The full list page

The toolbar icon and the Options entry open one page listing every open tab. The icon focuses an existing list tab rather
than opening a second.

- **Lenses:**
  - **By window** (the default): one section per window, yours first, each with **Go there** and **Move all here**.
  - **By kind**: groups by rules in a data file, then everything else by hostname.
  - **By tab group**: see R6.
  - **Duplicates**: groups keyed by normalized URL. Each row shows its window, and its real URL when that differs from the
    key. **Close N extras, keep the original** per group, and **Close N duplicates** across all groups.
- A row of **kind chips** gives a count per kind and doubles as a filter.
- **Window names come from their content:** one kind when the window is nearly all that kind; else its mix
  (`Dev servers 16 · Docs 4`); else the title of its active tab, never the list page or a New Tab. Never `Window 2`, which
  renumbers whenever a window closes.
- **Window strip:** one chip per window, yours marked *here*. Click shows that window's tabs, double-click goes there, hover
  highlights its rows.
- Every tab in another window gets **Move here**.
- **Drag and drop:** drop a row on a window section, with a line showing where it lands, or on a window chip to put it at
  the end of that window. While dragging, a tray of every window sits at the bottom. Shift- or Cmd-click selects several
  rows, which move together and keep their order.
- **Undo:** every close or move made from the page can be undone from a toast, including one that only partly succeeded.
  Closed tabs come back through `chrome.sessions.restore`, whose stack means undo must restore in the right order. Undoing a
  move brings back a tab group the move emptied.
- **Keys:** `/` filters, `1`–`9` shows that window, Esc clears the filter, then the selection.
- The page updates live. **⟳ Refresh** only re-reads the tabs; it does not reload the extension.
- **Google Docs rows name the document tab:** Chrome's title is the same for every tab of a doc, so a content script reads
  the selected document tab, the worker caches it per doc and tab in `storage.local`, and the list reads only the cache.
  Drop the "- Google Docs/Sheets/Slides" suffix everywhere. A doc with one tab shows no tab name.
- The toolbar badge shows how many tabs are redundant right now.
- The top of the page has the *Ask when I open a duplicate* switch, and lists the URLs **Keep both** muted, each with
  **Resume**.
- **Load time:** list the page's whole module graph as `<link rel="modulepreload">`. A test fails when that list drifts from
  the real imports. The page shows its load time at the bottom, with the breakdown on hover.

## R5. Tab layouts

**Save layout** downloads every window, tab group and tab as JSON. **Restore layout…** rebuilds a file in new windows.
Layouts can be committed to `layouts/` to carry them between machines. [`layouts/example.json`](../layouts/example.json)
shows the format.

- Items keep their order, so ungrouped tabs before, between and after groups land where they were.
- Colours are Chrome's: grey, blue, red, yellow, green, pink, purple, cyan, orange.
- A `"url": null` tab is a placeholder: restore lists it as skipped and never guesses. A group holding only placeholders is
  not created.
- Save skips non-web pages and non-normal windows, and stores each tab's real URL, not a short link.
- Restore matches open tabs by normalized URL, never by title, and moves them into place instead of opening a second copy.
- Restore opens nothing if the file has any error, such as an unknown colour or a non-http URL. A URL must be a string. A
  test validates every file in `layouts/`.

## R6. Sections: share and open one tab group

- The **By tab group** lens lists each group with **Copy** and **Save**.
- **Copy** puts the group on the clipboard as a message anyone can read and click:

  ```
  📂 Reading
  • Page title — https://…
  • Another page — https://…
  ```

- **Open section** reads the clipboard and opens it as a group at the end of this window, named by its first line. Tabs
  already open on those pages are moved in. It accepts any text with links: numbered or bulleted lists, Markdown links, a
  bare URL.
- **Save** downloads one group as a one-group layout file.

## R7. Native messaging host: the front page for other tools

Gives local tools the page in front and its selected text, without turning on the browser's *Allow JavaScript from Apple Events*.

- When the extension starts, the browser starts the host, which listens on a Unix socket readable by the user alone.
- It answers one read-only request, the front tab's title, URL and selection, in a few milliseconds. The contract is in the
  [README](../README.md#the-contract).
- The worker reads the selection only when asked, so no script is added to every page. Pages that refuse scripts answer with
  no selection.
- A masked field's selection is never read: `type=password`, `autocomplete` containing `password`, or computed
  `-webkit-text-security` other than `none`.
- `host install [extension id]` writes Edge's host manifest. By default it allows the id Edge gives an unpacked extension
  loaded from the checkout. macOS only: elsewhere it fails clearly unless given a directory.
- When the host is missing, callers fall back to AppleScript for the title and URL, and say how to install the host.

## R8. The bridge: local tools drive the browser

Off unless switched on from the list page. A service worker cannot listen on a port, so the extension is the client.

- It long-polls a loopback-only server (`tools/bridge.js`, default port 8787) for a command, runs it, and posts the result.
- Polling rides the alarm, about every 30 s, and the server waits about 95 s for an answer, so a command landing between polls
  is not lost.
- Switching it off takes effect at once: the held poll is dropped and no further command runs.
- A command that never finishes times out, lets go of the debugger, and does not block the next one.
- A dead server costs one failed fetch.
- `tools/ask.js` sends commands: `diag`, `tabs`, `duplicates`, `activate`, `close`, `open`, `navigate`, `reload`, `layout`,
  `restore-layout`, `read` (page text plus numbered controls, every frame), `click` (by index or label), `type`, `key`,
  `screenshot`. Anything else can be sent as raw JSON.
- Clicks and typing use `chrome.debugger`, attached only for the action and detached right after.
- While the server runs, any local process can drive the browser through it, so the docs must say to stop it when done.
- The bridge also appends extension events to a local JSONL log, since the worker cannot write files.

## R9. Development comfort

- The extension reloads itself within about 30 s of any change to its files, the manifest included. It can be switched off at
  the bottom of the list page.
- `npm test` runs every unit test with no dependencies.
