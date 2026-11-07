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
  to the drop zone. (README.md still calls it *← Back to Drop Zone*; the page is right.)
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
