# Browser tab helper

A Microsoft Edge extension (Manifest V3, plain JavaScript modules, no build step, no runtime dependencies) that:

- stops you settling into a duplicate tab, with a card over the page,
- lists every open tab on one page, by window, kind or tab group, with drag and drop and undo,
- saves and restores tab layouts as JSON,
- shares a tab group as a message, and opens one from the clipboard,
- tells local tools which page is in front, through a native messaging host, and
- lets local tools drive the browser through an opt-in bridge.

What it must do is in [docs/requirements.md](docs/requirements.md).

**macOS only.** The native host, its manifest and the event log use macOS paths, and the tools say so and stop elsewhere.
Node 22 or later.

## Install

1. Open `edge://extensions`, switch on **Developer mode**, click **Load unpacked** and choose this checkout.
2. Optional, for tools that want the front page:

   ```bash
   node tools/host.js install            # allows the id Edge gives an unpacked extension loaded from this checkout
   node tools/host.js install <id>       # or a specific extension id
   ```

   Then reload the extension. `--dir <directory>` writes the manifest somewhere else, for testing or for Chrome
   (`~/Library/Application Support/Google/Chrome/NativeMessagingHosts`). Run the extension in one browser at a time:
   the last host started takes the socket.

The toolbar icon (or the extension's Options entry) opens the list page. The red badge counts tabs that could close
with nothing lost.

## What counts as the same page

Two tabs are the same page when their normalized URLs match. Falsely calling two tabs duplicates is much worse than
missing a pair, so the normalizer is conservative. Only `http:`, `https:` and `file:` URLs take part. It strips a leading
`www.` and trailing slashes, drops tracking params (`utm_*`, `fbclid`, `gclid` and friends; the list is in
[`src/lib/normalize.js`](src/lib/normalize.js)) and sorts what remains. It keeps the whole `#fragment`, because apps keep
state there.

## The duplicate card

| Key        | Default command | Action |
| ---------- | --------------- | ------ |
| `j`, Enter | ⌥⇧D | **Jump to it**: focus the existing tab, close this duplicate |
| `b`        | ⌥⇧B | **Bring here**: move the existing tab here and close this duplicate (only when it is in another window) |
| `x`, `c`   | ⌥⇧X | **Close the other**: stay here, close every older copy (only when there is one; Cmd+Shift+T brings them back) |
| `k`        | ⌥⇧K | **Keep both**: dismiss, and stop asking about this URL for an hour |
| Esc        |     | Dismiss, as do a click on the backdrop and × |

The commands work whether or not a card is up, and can be changed at `edge://extensions/shortcuts`; the card lists the
keys actually bound. While the card is up, focus sits in a hidden read-only input, so Vimium-style extensions see a text
field and let the letters through.

**Alias rules** in [`src/data/aliases.js`](src/data/aliases.js) name destinations with several front doors. Landing on
another door with a canonical tab open gets the normal card, pointing at the canonical tab, which wins even if newer and
even if the other tab is pinned. With none open, the card offers to go to the canonical URL (`j`), or **Stay here** (`k`)
silences it for that URL for an hour.

## The list page

**Lenses:** by window, by kind (rules in [`src/data/kinds.js`](src/data/kinds.js)), by tab group, and duplicates.

| Key | Does |
| --- | ---- |
| `/` | Filter |
| `1`–`9` | Show that window |
| Esc | Clear the filter, then the selection |

Cmd-click selects a row, Shift-click selects a range. Selected rows move together and keep their order. Drag rows onto a
window section, a window chip, or the tray that appears at the bottom while dragging. Every close and move can be undone
from its toast. Double-click a window chip to go there.

### Layouts

**Save layout** downloads every window, tab group and tab as JSON. **Restore layout…** rebuilds a file in new windows.
Commit them to [`layouts/`](layouts/) to carry them between machines, where a test validates every file. Nothing here may
be private: this repo is public, so keep personal layouts elsewhere. [`layouts/example.json`](layouts/example.json) shows
the format.

A `"url": null` tab is a placeholder: restore lists it as skipped and never guesses. Open tabs are matched by normalized
URL, never title, and moved into place instead of opened again. A file with any error opens nothing.

### Sections

In the **By tab group** lens, **Copy** puts a group on the clipboard as a readable message, and **Save** downloads it as a
one-group layout. **Open section** opens whatever links are on the clipboard (numbered or bulleted lists, Markdown links,
bare URLs) as a group at the end of this window, named by the first line.

## The native host: the front page for other tools

Gives local tools the page in front and its selected text without turning on the browser's *Allow JavaScript from Apple
Events*. When the extension starts, the browser starts the host, which listens on a Unix socket.

### The contract

- **Socket:** `~/Library/Caches/browser-tab-helper/host.sock`, mode 0600 in a 0700 directory.
- **Request:** the client sends one line of JSON: `{"type":"front"}\n`
- **Response:** the host answers one line of JSON, then closes:
  - `{"title":str,"url":str,"selection":str|null}`, or
  - `{"error":str}`
- **Install:** `host install [extension id]`, which is `node tools/host.js install [extension id]` from a checkout. By
  default it allows the id Edge gives an unpacked extension loaded from the checkout.

```bash
printf '{"type":"front"}\n' | nc -U ~/Library/Caches/browser-tab-helper/host.sock
```

`selection` is `null` when nothing is selected, on pages that refuse scripts (`chrome://`, canvas-drawn pages such as
Google Docs), and when focus is in a masked field, whose selection is never read: `type=password`, `autocomplete`
containing `password`, or computed `-webkit-text-security` other than `none`. A field masked with CSS for some other
reason therefore answers `null` too, which is the safe way to be wrong. The selection is read only when asked, so no
script is added to every page.

**When the socket is missing**, the host is not installed or Edge is not running. Callers should fall back to
AppleScript for the title and URL, and say to run `node tools/host.js install`.

## The bridge: local tools drive the browser

Off unless switched on at the bottom of the list page. A service worker cannot listen on a port, so the extension is the
client: it long-polls a loopback server, runs the command and posts the result back.

```bash
node tools/bridge.js                      # port 8787 by default; or: node tools/bridge.js 9000
node tools/ask.js tabs
node tools/ask.js read --tab 123          # page text plus numbered controls, every frame
node tools/ask.js click 4 --tab 123       # by index, or by label: click "Sign in"
node tools/ask.js type "hello" --tab 123
node tools/ask.js key Enter --tab 123
node tools/ask.js screenshot --out a.png
node tools/ask.js '{"cmd":"navigate","tab":123,"url":"https://example.com/"}'   # anything as raw JSON
```

All commands: `diag`, `tabs`, `duplicates`, `activate`, `close`, `open`, `navigate`, `reload`, `layout`,
`restore-layout`, `read`, `click`, `type`, `key`, `screenshot`.

> **Stop the server when you are done.** While it runs, any local process can drive your browser through it: read pages,
> click, type. It listens on loopback only. It refuses a browser `Origin` or a non-loopback `Host` on commands, and the
> extension's endpoints need a header a page cannot send without a preflight, which it also refuses. So web pages cannot
> reach it. Other programs on your machine can.

Polling rides the alarm, about every 30 s, and the server waits about 95 s for an answer, so a command landing between
polls is not lost, but the first one can take up to 30 s. A dead server costs one failed fetch. Clicks and typing use
`chrome.debugger`, attached only for the action and detached right after, so Chrome's "started debugging" bar flashes.
Extension events are appended to `~/Library/Caches/browser-tab-helper/events.jsonl`.

Switching the bridge off takes effect at once: the held poll is dropped and no further command runs. A command that does
not finish in 60 s, as on a hung page, answers with an error and lets go of the debugger. It cannot be cancelled, only
abandoned, so a slow `restore-layout` may still finish afterwards.

A click on a background tab lands, but took about 5 s in headless Chromium, against about 20 ms on the active tab of any
window. `activate` first if that matters. `type` and `key` are not affected.

## Development

```bash
npm test             # every unit test, no dependencies and no browser
npm run test:e2e     # the extension in a throwaway headless Chromium; about 3 minutes
```

`test:e2e` uses Playwright's cached Chromium or `$CHROMIUM`, never an installed Chrome, with a temp profile and temp paths.

Pure logic goes in `src/lib/`. Only `background.js`, the banner, the Docs content script and the page touch `chrome.*`;
a test enforces that for `src/lib` and `src/data`. A new file must also go in
[`src/lib/watched-files.js`](src/lib/watched-files.js), and a new module the page imports in the `modulepreload` list in
[`src/page/list.html`](src/page/list.html). Tests fail when either drifts.

The extension reloads itself within about 30 s of any change to a watched file, the manifest included. The switch is at
the bottom of the list page. The banner is injected fresh each time, so an edit to it takes effect on the next duplicate
even with that switched off.

The watcher runs in the worker, so a syntax error in `background.js` or anything it imports stops the watcher too. Fix the
error and press reload at `edge://extensions`. A reload also resets the list page's filter, lens and undo toasts.
