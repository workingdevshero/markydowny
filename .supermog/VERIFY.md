# Verifying markydowny

markydowny is a markdown viewer: a single static page (`index.html` plus `js/`) that renders a
markdown file the user drops or picks. There is no build step, no backend, no account and no
database, and nothing is sent anywhere: files are read in the browser. Verification serves the
checkout over HTTP and uses the page as a person would.

## Bringing it up

From the repository root, serve the checkout on the first port of your block:

```bash
set -m
PORT="${JOB_PORT_FIRST:-8080}"
bun -e '
const port = Number(process.argv[1]);
Bun.serve({ port, hostname: "0.0.0.0", async fetch(req) {
  let path = decodeURIComponent(new URL(req.url).pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = Bun.file("." + path);
  return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
} });
console.log(`serving on ${port}`);
' "$PORT" > "$VERIFY_ENV_DIR/serve.txt" 2>&1 &
echo $! > "$VERIFY_ENV_DIR/serve.pgid"
```

Open `http://localhost:$PORT/`. It answers within a second; if the page is blank or a script fails
to load, `$VERIFY_ENV_DIR/serve.txt` and the browser console say why. Serve over HTTP rather than
opening `index.html` as a `file://` URL: the site is served over HTTPS in production, and some
browser APIs behave differently for `file://`.

No `npm install` is needed: the only library, `marked`, is checked in at `js/vendor/marked.umd.js`.

## Test files

Nothing is seeded, so bring your own markdown. Copy files into `$VERIFY_UPLOAD_DIR` before
handing them to `browser_file_upload` or `browser_drop`; the browser only reads from there. Good
inputs:

- `README.md`: headings, lists, links, an inline image (`marky.png`) and fenced code.
- A folder containing `README.md` and `marky.png`: dropping it tests relative image resolution.
- A folder with two or more `.md` files: dropping it opens the file picker list.
- Write your own small file for whatever the pull request changed, such as a table, a task list or
  a code block in a particular language.

## What matters

This is a map of the page, not a checklist. The repository's own tests (`npm test`) cover the
parsing and markup helpers; this pass is about what a person sees.

- **Drop zone.** The landing view: drop a file or folder on it, or use *Choose File*. The whole
  zone is also a keyboard-reachable button.
- **File list.** A dropped folder with several markdown files shows *Multiple markdown files
  found*, with a list to choose from and *Cancel*.
- **Rendered view.** The markdown output, with relative images resolved from the dropped folder.
  The header shows the document's title, the fullscreen toggle and *Open another*, which returns
  to the drop zone.
- **Light and dark.** The page follows `prefers-color-scheme`. Check both when the change touches
  styling (`browser_evaluate` can't switch it; use the browser's color-scheme emulation if it's
  available, otherwise say which scheme you saw).
- **Narrow screens.** The layout is responsive; a change to layout deserves one look at a phone
  width.

## Live reload (Chromium)

In Chromium a document opened through a file handle (*Choose File* uses `showOpenFilePicker()`,
drops use `getAsFileSystemHandle()`) re-renders when the file changes: the changed blocks are
tinted for a couple of seconds, a **Follow** toggle and *Updated just now* appear in the top bar,
and a deleted file shows *This file was deleted or moved*. Safari and Firefox have no file
handles, so there the page reads a dropped file once and never shows Follow.

The browser can't edit a file on your disk, but the Origin Private File System gives real
`FileSystemFileHandle`s without a picker, and `MarkyApp.openFileHandle(handle)` opens one as if
it had been picked. With `browser_evaluate`:

```js
async () => {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle('live.md', { create: true });
  const write = async (text) => {
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
  };
  await write('# Live\n\nFirst.\n\nSecond.\n');
  await MarkyApp.openFileHandle(handle);
  await write('# Live\n\nFirst.\n\nSecond, **changed**.\n');
  await new Promise(r => setTimeout(r, 1500));
  return [...document.querySelectorAll('#markdownContent .block-changed')].map(e => e.textContent);
}
```

It returns `["Second, changed."]`: only the changed paragraph is highlighted (the tint fades after
about 2.4 s, so look within that). Then:

- **Deleting** the file (`root.removeEntry('live.md')`) shows the notice within a second or two
  and keeps the content; writing it again reloads and hides the notice. The console stays clean.
- **Polling.** Where `FileSystemObserver` exists (recent Chromium) changes arrive through it. To
  exercise the once-a-second polling instead, pass a wrapper the observer can't watch:
  `{ kind: 'file', name: 'live.md', getFile: () => handle.getFile() }`. Hiding the tab stops
  the polling and showing it checks once; headless tabs don't change visibility, so overriding
  `document.hidden` and dispatching `visibilitychange` stands in for it.
- **Without the API** the page must behave as before. Add an init script that deletes
  `window.showOpenFilePicker`, `window.FileSystemObserver` and
  `DataTransferItem.prototype.getAsFileSystemHandle` before load: *Choose File* opens the plain
  file input, the Follow button stays hidden, and nothing is logged.
- **Follow** scrolls a change that's out of view into view. Scrolling yourself (wheel, keys)
  pauses it, and the button reads *Resume* until clicked.

## Editing

A pencil button (*Edit*, ⌘E on a Mac, Ctrl+E elsewhere) sits in the top bar next to fullscreen
while a document is open. It swaps the rendered view for a CodeMirror editor showing the
markdown, with the same width and fonts, and reads *Done*; *Done* renders the result and scrolls
near where the cursor was. *Save* (⌘S / Ctrl+S) and *Revert* appear while editing. Unsaved
changes put a dot before the title in the top bar and the page title ("• live.md - Markydowny").

- **Lazy loading.** CodeMirror is `js/vendor/codemirror.js`, loaded the first time *Edit* is
  pressed. Before that, `window.MarkyCodeMirror` is undefined and the network log has no
  request for it; viewing a document must never load it.
- **Saving in place (Chromium).** Open an Origin Private File System handle with
  `MarkyApp.openFileHandle(handle)` as in *Live reload* above, press *Edit*, click into the text,
  type, and press Ctrl+S (or *Save*). Read the file back with
  `await (await handle.getFile()).text()`: it holds exactly the edit, no other bytes, and the dot
  clears. The save must not come back through live reload as a change or a banner.
- **Live reload while editing.** With nothing unsaved, writing the file from `browser_evaluate`
  updates the editor in place: typing afterwards lands where the cursor was. With unsaved
  changes, the same write shows *This file changed on disk* with *Reload* (takes the file, drops
  the changes) and *Keep mine* (hides the banner; the next save overwrites the file).
- **Revert** puts back the saved text and clears the dot.
- **Download fallback (Safari, Firefox).** With the File System Access API deleted by an init
  script (see *Without the API* above), a file opened through *Choose File* has no handle: the
  save button reads *Download* and saving downloads a copy under the original file name. A file
  with Windows (CRLF) line endings comes back with CRLF intact.
- **Unsaved-changes guard.** With unsaved changes, *Open another* and *Done* ask first
  (`confirm`; *Cancel* keeps editing), and reloading or closing the tab triggers the browser's
  "Leave site?" prompt (`beforeunload`). Without unsaved changes none of them ask.
- **Phone width.** While editing, the pencil goes icon-only and fullscreen steps aside, so
  *Revert* and *Save* fit in the top bar.

### Formatting toolbar

While editing, a toolbar sticks under the top bar (`role="toolbar"`, `#formatToolbar`): a block
style menu (Paragraph, Heading 1-3, Quote, Code block), Bold, Italic, Strikethrough, Inline code,
Link, and bulleted, numbered and task lists. Each button's tooltip names its shortcut (Ctrl on
Linux and Windows, ⌘ on a Mac): Ctrl+B, Ctrl+I, Ctrl+Shift+X, Ctrl+Shift+C, Ctrl+K,
Ctrl+Shift+8/7/9, and Ctrl+Alt+0-3 for paragraph and headings. `js/format.js` is loaded with
CodeMirror, on first edit, never before.

- **Commands edit the markdown.** With the cursor in a word, Bold wraps the word; pressing it
  again unwraps it. A selection is wrapped; a multi-line selection styles each line. Italic uses
  `_` when the document already does. Link wraps the selection as `[text](url)` with `url`
  selected; in a link it selects the URL, and with the URL selected it removes the link. Saving
  afterwards changes only the lines touched. Each command is one undo step.
- **Active state.** `aria-pressed` on the buttons (and the block menu's label) follows the
  cursor: in `**bold**` Bold is pressed, in `## Title` the menu reads *Heading 2*. CodeMirror's
  view is reachable with `MarkyCodeMirror.EditorView.findFromDOM(document.querySelector('.cm-editor'))`
  to place a selection from `browser_evaluate`.
- **Keyboard.** One toolbar item is in the tab order; arrow keys, Home and End move between
  items. ArrowDown on the block menu opens it at the current style; Enter picks, Escape closes.
- **Phone width.** Strikethrough, Inline code, Numbered list and Task list move into a *More
  formatting* (⋯) menu, and the toolbar fits without scrolling sideways.

The desktop app saves through `write_document` (atomic, permission-keeping, refused when the file
changed since the editor read it) and asks before closing a window with unsaved changes; that
side can't run here, and its Rust is covered by `cargo test`.

## The desktop app

Only for a round that has `desktop_*` tools. Otherwise skip this section: the browser pass
above is the whole job.

The round has already built the app with `scripts/build-desktop.sh`: `Markydowny.app` on macOS
(bundle id `com.workingdevshero.markydowny`), the `markydowny` binary on Linux. It's a debug
build with no `BUGSPLAT_DATABASE`, so crash reporting is off and a **Crash Test** menu exists.
Don't use that menu: it crashes the app on purpose.

The app is the same page as the website, in a native window, with real file paths. *Choose
File* and File > Open... (⌘O) show the system's Open panel. You have no shell on that machine, so
use files that are already there: the pull request's checkout is, since the round built it. The
build's last line is the app's path inside that checkout (`<checkout>/src-tauri/target/...`), so
`<checkout>/README.md` and `<checkout>/.supermog/VERIFY.md` exist, and the checkout folder itself
is a folder of markdown files to drop or watch. In the macOS Open panel, ⌘⇧G takes a typed path.

To change a file on disk while the app shows it, edit it in another app and save: on macOS,
`desktop_launch` with `com.apple.TextEdit`, open the same file there (⌘O, ⌘⇧G), type, ⌘S.
Saving from Markydowny's own editor counts too, but it must not come back as a reload.

What differs from the browser:

- **Opening files.** Each document gets its own window. On macOS, windows are native tabs: open
  two files and you get one window with two tabs; ⌘T opens a tab showing the drop zone, and
  Window > Merge All Windows gathers windows into one. A file that's already open isn't opened
  again; its tab comes forward. Two tabs with the same file name get their folder added to the
  title ("README.md — docs").
- **Live reload.** Every open document reloads when its file changes on disk, highlighting the
  changed blocks, with *Follow* as on the web. Dragging a folder with several markdown files
  from a Finder window onto the app (`desktop_drag`) offers *Watch this folder* (show whichever
  file changes) and, on macOS, *Open all N as tabs*.
- **Editing.** The pencil (⌘E) and *Save* (⌘S) as in the browser, but saving always writes the
  file in place. Closing a window with unsaved changes asks first.
- **Staying open (macOS only).** Closing the last window leaves the app running; clicking its
  Dock icon brings back an empty window. ⌘Q quits. On Linux, closing the last window quits.
- **Links** open in the default browser, not in the app.

macOS-only behaviour (tabs, the Dock, opening files from Finder) can't be seen on Linux. On a
Linux round, say so rather than reporting it missing.

## Known quirks

- The same `index.html` and `js/` are bundled into the macOS app (`scripts/build-frontend.mjs`
  copies them into `dist/`). Code that checks for `window.__TAURI__` only runs in the app, so a
  desktop-only path doing nothing in the browser is expected, not a finding.
- `dist/` is build output for the app and is git-ignored. Never serve from it; serve the
  repository root.
- The page needs no network: no web fonts, no CDN, no analytics. The footer's links go to
  external sites; don't follow them.

## Tear down

Stop the server by its process group, then confirm the port is quiet:

```bash
kill -- -"$(cat "$VERIFY_ENV_DIR/serve.pgid")"
curl -s -o /dev/null "http://localhost:${JOB_PORT_FIRST:-8080}/" && echo "still up" || echo "down"
```

Never find it by name: `pkill -f bun` matches your own session's tools as well.
