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

- **The homepage.** The landing view is the app: a headline, the drop zone, and in the header
  *Docs*, *Download* and **Open a file**. Below the fold, feature cards (live reload, Claude Code,
  the editor, tabs, privacy) linking into `/docs/`, then a *Download for Mac* strip. All of that
  (`.marketing`) disappears once a document or the file list is showing, and comes back with
  *Open another*; the header stays, with only *Open a file* (quieter, and gone while editing).
  `/docs/` is its own pull request; until it lands those links 404 on a checkout without it.
- **Drop anywhere.** A file or folder dropped anywhere on the page opens in place, with no
  navigation: try a feature card below the fold, not the drop zone. Dragging over the page draws
  a dashed outline around it. `browser_drop` onto `.feature` is the real test; failing that,
  `browser_evaluate` can dispatch a `drop` whose `DataTransfer` holds a `File`. A drop into the
  editor is the editor's; with unsaved changes a drop asks first.
- **Open a file.** One click opens the picker: `showOpenFilePicker()` in Chromium, so the file
  live-reloads straight away; the plain file input elsewhere. The drop zone and its *Choose File*
  do the same, and the zone is a keyboard-reachable button.
- **File list.** A dropped folder with several markdown files shows *Multiple markdown files
  found*, with a list to choose from and *Cancel*.
- **Rendered view.** The markdown output, with relative images resolved from the dropped folder.
  The header shows the document's title, the fullscreen toggle and *Open another*, which returns
  to the drop zone.
- **Light and dark.** The page follows `prefers-color-scheme`. Check both when the change touches
  styling (`browser_evaluate` can't switch it; use the browser's color-scheme emulation if it's
  available, otherwise say which scheme you saw).
- **Narrow screens.** The layout is responsive; a change to layout deserves one look at a phone
  width. The homepage's header (logo, *Docs*, *Download*, *Open a file*) must fit in one row at
  390 px, and the feature cards stack.

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
markdown (styled in Rich mode unless Markdown was chosen last; see below), with the same width and fonts, and reads *Done*; *Done* renders the result and scrolls
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
- **Find and replace.** ⌘F / Ctrl+F while editing opens CodeMirror's search panel at the bottom
  of the editor, with the focus in *Find*: matches are tinted, and *replace* / *replace all* act
  on them. The panel takes the page's fonts and colours, so check it in light and dark. While
  viewing, ⌘F is the browser's own find: the page doesn't call `preventDefault` and opens
  nothing. To check it end to end, open an OPFS handle as in *Live reload*, press *Edit*,
  press Ctrl+F, type a word that occurs several times, type the replacement in the second field,
  click *replace all*, press Ctrl+S, and read the file back
  (`await (await handle.getFile()).text()`): every match is replaced and no other byte changed.
  Type into the fields with real key presses: the panel takes its query from `keyup` and
  `change`, which `browser_evaluate` setting `.value` doesn't fire.
- **Word count.** While editing, the top bar shows "1,204 words" where *Updated* would be, and
  "37 of 1,204 words" while text is selected. It updates a moment (200 ms) after typing stops.
  Markup doesn't count: `#`, `**`, list markers and task boxes, a link's URL, code fences and
  their info strings. Link text, alt text and code do. It isn't shown at phone width, where the
  top bar has no room for it.

### Formatting toolbar

While editing, a toolbar sticks under the top bar (`role="toolbar"`, `#formatToolbar`): a block
style menu (Paragraph, Heading 1-3, Quote, Code block), Bold, Italic, Strikethrough, Inline code,
Link, bulleted, numbered and task lists, and Insert table, Insert image and Horizontal rule. Each button's tooltip names its shortcut (Ctrl on
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
- **Phone width.** Strikethrough, Inline code, Numbered list, Task list and the three inserts move
  into a *More formatting* (⋯) menu (*Table…*, *Image*, *Horizontal rule*; *Table…* opens the size
  picker under ⋯), and the toolbar fits without scrolling sideways.
- **Insert table.** The table button (`#tableButton`) opens a grid (`#tablePicker`, 8 columns by 6
  rows); hovering or arrowing over it highlights the size and reads it out below ("3 × 2"; the
  header row counts). Picking inserts an empty GFM table on lines of its own, with a blank line
  either side, and the cursor in its first cell. Escape closes the grid back to the button.
- **Tab between cells (Rich mode).** In a table Tab selects the next cell's text (an empty cell
  gets the cursor), past the delimiter row, and Shift-Tab the previous; Tab in the last cell adds
  an empty row and moves into it. Outside a table Tab leaves the editor as before. In Markdown
  and Split, Tab is unchanged.
- **Insert image (web).** Inserts `![alt](path)` at the cursor with `path` selected (a one-line
  selection becomes the alt text). Rich mode then tries to load `path`, so one 404 for `/path` in
  the network log is expected until it's filled in.
- **Horizontal rule.** Inserts `---` on a line of its own with blank lines around it (so it's
  never read as a heading underline), the cursor on the line after.

### Rich mode and the Rich | Markdown | Split switch

While editing, a three-option switch (*Rich* | *Markdown* | *Split*, `#modeSwitch`,
`role="radiogroup"`) sits next to the pencil. ⌘/ (Ctrl+/ elsewhere) goes round them. Rich is the
default; the last choice is kept in `localStorage` under `markydowny.editorMode`. Both are the same CodeMirror document:
Rich adds the class `cm-rich` to `.cm-editor` and draws the markup over it, Markdown shows the
plain source.

- **Looks like the rendered view.** Open a file with headings, bold/italic/strikethrough/inline
  code, links, a bulleted list with a nested item, a task list, a numbered list, a quote, a fenced
  code block with a language, a `---` rule, a table and an image (`![Marky](marky.png)`), then
  press *Edit*. Headings are at heading sizes, bullets are `•` (`◦` nested), tasks are
  checkboxes, the code block is a grey box with its language as a small label, the rule is a
  line, the table is a table and the image shows under its (muted) markdown. Take a screenshot in
  light and in dark.
- **Markers on the cursor line.** Every line except the ones holding the cursor or a selection
  hides its markers (`#`, `**`, `_`, `~~`, backticks, `[` and `](url)`, `>`, `- [ ]`, fences).
  Put the cursor on a line (click it, or place a selection with `browser_evaluate` as in the
  toolbar section): that line alone shows its markdown, e.g. `A line with **bold**` while the
  next line reads `Another line with bold`. A table shows as markdown (monospace, pipes and all)
  while the cursor is in it, and as a table otherwise.
- **Typing.** Type `**bold**` on a new line: once the cursor moves to another line it reads
  *bold*, in bold, with no asterisks.
- **Task boxes.** Clicking a checkbox toggles it without moving the cursor; saving changes only
  `[ ]` to `[x]` (or back) in the file.
- **Links.** A plain click places the cursor. ⌘-click (Ctrl-click off a Mac) opens the link as
  the rendered view would: external links in a new tab, `#anchors` move the cursor to that
  heading.
- **Switching.** Switching mid-edit keeps the text, the cursor and selection, and the line at
  the top of the window; undo (Ctrl+Z) after a switch undoes the edit made before it. The
  formatting toolbar behaves the same in both.
- **Phone width.** Only the current view's label shows in the switch; pressing it switches.
  Split isn't offered there: a stored Split shows as Markdown, and widening the window again
  brings Split back.
- **Split.** The markdown (as in Markdown mode) on the left, the document rendered as the
  rendered view would show it on the right (`#splitPreview`), with `split-view` on `<body>`.
  Typing updates the right side within a moment. Scrolling either side brings the other to the
  same block (scroll the page for the editor, the right pane on its own): with a long document,
  the heading at the top of one is at or near the top of the other. Links on the right open as
  Rich mode's ⌘-click does, `#anchors` scroll the right side, images open the lightbox. Take a
  screenshot in light and in dark. *Done* returns to the single rendered view.
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
- **Insert image.** The image button opens the Open panel in the document's folder, filtered to
  images. A picked image is linked by its path from the document (`![name](img/shot.png)`, the
  name selected) and shows in Rich mode. One from outside the document's folder asks first:
  *Copy* puts a copy next to the document (numbered, `shot-1.png`, if another file has the name)
  and links that; *Link Where It Is* links it with `../`.
- **Staying open (macOS only).** Closing the last window leaves the app running; clicking its
  Dock icon brings back an empty window. ⌘Q quits. On Linux, closing the last window quits.
- **Links** open in the default browser, not in the app.

macOS-only behaviour (tabs, the Dock, opening files from Finder) can't be seen on Linux. On a
Linux round, say so rather than reporting it missing.

## Docs

The docs live at `/docs/`: static pages rendered from `docs/*.md` by `scripts/build-docs.mjs`
and committed, so the same server serves them. When a change touches `docs/`:

- Open `http://localhost:$PORT/docs/` and use the side navigation to reach every page. Each one
  highlights itself in the navigation and has its own title in the tab.
- The header's logo and **Open a file** go back to the app at `/`, **Docs** to `/docs/`, and
  **Download** to the Install page. The homepage's footer links to the docs.
- Check light and dark, and one look at a phone width (about 390px): the page list becomes a row
  that scrolls sideways above the page, and tables scroll rather than overflow.
- Headings show a `#` anchor on hover; links between pages land on the right section.

## Known quirks

- The same `index.html` and `js/` are bundled into the macOS app (`scripts/build-frontend.mjs`
  copies them into `dist/`), where `body.desktop` hides the homepage's sections and header links:
  the app opens straight to the drop zone. Code that checks for `window.__TAURI__` only runs in the app, so a
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
