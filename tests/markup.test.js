const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const fn = (name) => app.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n {4}}\\n`))[0];

test('every element app.js looks up by id exists in index.html', () => {
    const ids = [...app.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]);
    assert.ok(ids.length > 10, 'expected app.js to look up its elements with $()');
    for (const id of ids) {
        assert.match(html, new RegExp(`id="${id}"`), `index.html has no element with id="${id}"`);
    }
});

test('the fullscreen button stays in the top bar, outside the rendered markdown', () => {
    assert.doesNotMatch(app, /replaceChildren\(fullscreenButton/);
    const article = html.match(/<article class="markdown-content" id="markdownContent">([\s\S]*?)<\/article>/);
    assert.ok(article, 'markdownContent article not found');
    assert.equal(article[1].trim(), '');
});

test('the Follow button and live status live in the top bar, hidden until a document is live', () => {
    const topbar = html.match(/<header class="topbar">([\s\S]*?)<\/header>/);
    assert.ok(topbar, 'top bar not found');
    const button = topbar[1].match(/<button[^>]*id="followButton"[^>]*>/);
    assert.ok(button, 'followButton is not in the top bar');
    assert.match(button[0], /aria-pressed="false"/);
    assert.match(button[0], /\shidden[\s>]/);
    assert.match(topbar[1], /<span[^>]*id="liveStatus"[^>]*\shidden[\s>]/);
    assert.match(topbar[1], /id="followLabel"/);
});

test('Watch this folder sits with the file list buttons, hidden by default', () => {
    const selector = html.match(/<section class="file-selector" id="fileSelector">([\s\S]*?)<\/section>/);
    assert.ok(selector, 'file selector not found');
    const button = selector[1].match(/<button[^>]*id="watchFolderButton"[^>]*>/);
    assert.ok(button, 'watchFolderButton is not in the file selector');
    assert.match(button[0], /\shidden[\s>]/);
    assert.match(button[0], /aria-pressed="false"/);
    // .btn sets display, so hiding needs its own rule.
    assert.match(html, /\.watch-folder-button\[hidden\]\s*\{\s*display:\s*none/);
});

test('the missing-file notice sits outside the rendered markdown', () => {
    assert.match(html, /id="liveNotice"[^>]*role="status"[^>]*hidden/);
    const article = html.match(/<article class="markdown-content" id="markdownContent">([\s\S]*?)<\/article>/);
    assert.doesNotMatch(article[1], /liveNotice/);
});

test('the file selector has an "Open all as tabs" button, hidden until the desktop app shows it', () => {
    const buttons = html.match(/<div class="selector-buttons">([\s\S]*?)<\/div>/);
    assert.ok(buttons, 'selector-buttons not found');
    const button = buttons[1].match(/<button[^>]*id="openAllTabs"[^>]*>([^<]*)<\/button>/);
    assert.ok(button, 'openAllTabs button not found in the selector buttons');
    assert.match(button[0], /\shidden[\s>]/, 'the button must start hidden, so the website never shows it');
    assert.match(button[1], /Open all as tabs/);
    // .btn sets display, which would otherwise override the hidden attribute.
    assert.match(html, /\.selector-buttons \.btn\[hidden\]\s*{\s*display:\s*none;/);
});

test('only desktop drops offer "Open all as tabs", which opens every file through the app', () => {
    const calls = [...app.matchAll(/showFileSelector\(/g)];
    assert.equal(calls.length, 4, 'expected the definition plus the desktop and web callers, and the web\'s unsaved documents');
    const restore = app.match(/function offerRestore[\s\S]*?\n {4}}\n/)[0];
    assert.match(restore, /showFileSelector\([\s\S]*\}\)\), undefined, \{/, 'unsaved documents are never opened all at once');
    const desktopDrop = app.match(/async function handleDesktopDrop[\s\S]*?\n {4}}\n/)[0];
    assert.match(desktopDrop, /openAllAsTabs\(entries\.map\(entry => entry\.path\)\)/);
    const webFolder = app.match(/async function readFolder[\s\S]*?\n {4}}\n/)[0];
    assert.doesNotMatch(webFolder, /openAllAsTabs/);
    const openAll = app.match(/function openAllAsTabs[\s\S]*?\n {4}}\n/)[0];
    assert.match(openAll, /invoke\('open_documents', \{ paths \}\)/);
    assert.doesNotMatch(openAll, /showDropZone\(/, 'showDropZone would mark the window idle after a file landed in it');
    // The app must stop counting this window as showing (or following) the folder first.
    const clear = Math.max(openAll.indexOf('await watchDesktopDocument('), openAll.indexOf("await invoke('set_document_open'"));
    assert.ok(clear > 0 && clear < openAll.indexOf("invoke('open_documents'"), 'the window is cleared, awaited, before the files are routed');
    assert.match(openAll, /generation: \+\+watchGeneration/);
});

test('Open Recent records window drops itself, but not folders the app already routed', () => {
    const desktopDrop = app.match(/async function handleDesktopDrop[\s\S]*?\n {4}}\n/)[0];
    assert.match(desktopDrop, /if \(dropped\) invoke\('add_recent_documents', \{ paths \}\)/);
    const pending = app.match(/async function loadPendingDocument[\s\S]*?\n {4}}\n/)[0];
    assert.match(pending, /handleDesktopDrop\(\[pending\.folder\]\)/);
});

test('only the desktop app forwards ⌃Tab to switch tabs', () => {
    const initDesktop = app.match(/async function initDesktop[\s\S]*?\n {4}}\n/)[0];
    assert.match(initDesktop, /core\.tabStepForKey\(e\)/);
    assert.match(initDesktop, /invoke\('select_tab', \{ direction \}\)/);
    assert.equal([...app.matchAll(/select_tab/g)].length, 1, 'select_tab is only invoked from initDesktop');
});

test('desktop windows report their document path so same-named tabs can be told apart', () => {
    assert.match(app, /invoke\('set_document_open', \{ open, title: title \|\| null, path: path \|\| null, generation, edited \}\)/);
    assert.match(app, /kind: 'desktop', dir: doc\.dir, title, path: doc\.path/);
    // A file from a dropped folder keeps its "folder › file" title, so it sends no path.
    const show = app.match(/function showTitle[\s\S]*?\n {4}}\n/)[0];
    assert.match(show, /currentSource\.kind === 'desktop' && !desktopFolder \? currentSource\.path : null/);
    assert.match(show, /setDocumentOpen\(true, title, path\)/);
});

test('the pencil button sits in the top bar next to fullscreen, with Save and Revert, all hidden at first', () => {
    const topbar = html.match(/<header class="topbar">([\s\S]*?)<\/header>/)[1];
    const button = topbar.match(/<button[^>]*id="editButton"[^>]*>[\s\S]*?<\/button>/);
    assert.ok(button, 'editButton is not in the top bar');
    assert.match(button[0], /\shidden[\s>]/);
    assert.match(button[0], /aria-pressed="false"/);
    assert.match(button[0], /<span id="editLabel">Edit<\/span>/);
    // Right before the fullscreen toggle.
    const after = topbar.slice(topbar.indexOf(button[0]) + button[0].length);
    assert.match(after, /^\s*<button[^>]*id="fullscreenButton"/);
    for (const id of ['saveButton', 'saveAsButton', 'revertButton']) {
        assert.match(topbar, new RegExp(`<button[^>]*id="${id}"[^>]*\\shidden[\\s>]`), `${id} starts hidden`);
    }
    // .btn sets display, so hiding needs its own rules.
    assert.match(html, /\.edit-button\[hidden\],\s*\.save-button\[hidden\],\s*\.save-as-button\[hidden\],\s*\.revert-button\[hidden\]\s*\{\s*display:\s*none/);
});

test('the editor and the conflict banner sit outside the rendered markdown', () => {
    const main = html.match(/<main>([\s\S]*?)<\/main>/)[1];
    assert.match(main, /<div class="editor-host" id="editorHost" hidden><\/div>/);
    const banner = main.match(/<div class="edit-banner" id="editBanner"[^>]*>([\s\S]*?)<\/div>/);
    assert.ok(banner, 'edit banner not found');
    assert.match(banner[0], /\shidden[\s>]/);
    assert.match(banner[1], /This file changed on disk/);
    assert.match(banner[1], /id="bannerReload"[^>]*>Reload</);
    assert.match(banner[1], /id="bannerKeep"[^>]*>Keep mine</);
});

test('desktop: below the Edit controls, the toolbar and the conflict banner share the text column', () => {
    const rule = html.match(/body\.desktop\.toolbar-below:not\(\.split-view\) \.format-toolbar,\s*body\.desktop\.toolbar-below:not\(\.split-view\) \.edit-banner\s*\{([^}]*)\}/);
    assert.ok(rule, 'shared toolbar/banner column rule not found');
    // The column is the editor's, less its padding.
    const width = Number(html.match(/body\.desktop \.markdown-content,\s*body\.desktop \.editor-host,\s*body\.desktop \.file-selector\s*\{[^}]*max-width: (\d+)px/)[1]);
    const pad = Number(html.match(/body\.desktop \.markdown-content,\s*body\.desktop \.editor-host\s*\{\s*padding: \d+px (\d+)px/)[1]);
    const gutter = `max(${pad}px, calc((100% - ${width - 2 * pad}px) / 2))`;
    assert.ok(rule[1].includes(`margin-left: ${gutter};`), `expected margin-left: ${gutter}`);
    assert.ok(rule[1].includes(`margin-right: ${gutter};`), `expected margin-right: ${gutter}`);
});

test('CodeMirror is loaded only when editing starts, never by the page itself', () => {
    assert.doesNotMatch(html, /codemirror/i, 'index.html must not load the editor');
    const mentions = [...app.matchAll(/js\/vendor\/codemirror\.js/g)];
    assert.equal(mentions.length, 1, 'app.js names the bundle once');
    const loader = app.match(/function loadCodeMirror[\s\S]*?\n {4}}\n/)[0];
    assert.match(loader, /loadScript\(CODEMIRROR_SRC, 'MarkyCodeMirror'\)/);
    // The toolbar's commands come with it, not with the page.
    assert.match(loader, /loadScript\(FORMAT_SRC, 'MarkyFormat'\)/);
    assert.doesNotMatch(html, /format\.js/, 'index.html must not load the toolbar\'s commands');
    const loadScript = app.match(/function loadScript[\s\S]*?\n {4}}\n/)[0];
    assert.match(loadScript, /script\.src = src/);
    // Only starting to edit loads it: startEditing, and a new document, which opens in the
    // editor (and loads it first, before anything unsaved is let go).
    const callers = [...app.matchAll(/(?<!function )loadCodeMirror\(\)/g)];
    assert.equal(callers.length, 2);
    const start = app.match(/async function startEditing[\s\S]*?\n {4}}\n/)[0];
    assert.match(start, /await loadCodeMirror\(\)/);
    const newDocument = app.match(/async function newDocument[\s\S]*?\n {4}}\n/)[0];
    assert.match(newDocument, /await loadCodeMirror\(\)[\s\S]*await startEditing\(/);
});

test('the vendored editor bundle exposes window.MarkyCodeMirror', () => {
    const bundle = fs.readFileSync(path.join(root, 'js', 'vendor', 'codemirror.js'), 'utf8');
    assert.match(bundle, /^var MarkyCodeMirror=/);
    const window = {};
    new Function('window', 'self', `${bundle}\nwindow.MarkyCodeMirror = MarkyCodeMirror;`)(window, window);
    for (const name of ['createEditor', 'createState', 'formatState', 'ensureSyntaxTree', 'EditorView', 'Transaction', 'openSearchPanel']) {
        assert.ok(window.MarkyCodeMirror[name], `MarkyCodeMirror.${name}`);
    }
});

test('find and replace is in the editor bundle, so it loads on first edit and not before', () => {
    const entry = fs.readFileSync(path.join(root, 'scripts', 'codemirror-entry.mjs'), 'utf8');
    assert.match(entry, /from '@codemirror\/search'/);
    assert.match(entry, /search\(\)/);
    assert.match(entry, /keymap\.of\(\[\.\.\.searchKeymap/);
    const bundle = fs.readFileSync(path.join(root, 'js', 'vendor', 'codemirror.js'), 'utf8');
    // The search panel's own strings, as @codemirror/search builds it.
    assert.match(bundle, /cm-search/);
    assert.match(bundle, /"replace all"/);
    // Nothing else loads it: the page names only the lazily loaded bundle (see above).
    assert.doesNotMatch(html, /codemirror|cm-search/i);
    assert.doesNotMatch(app, /<script[^>]*search/i);
});

test('⌘F opens find and replace only while editing; viewing keeps the browser\'s find', () => {
    const handler = app.match(/function onEditShortcut[\s\S]*?\n {4}}\n/)[0];
    assert.match(handler, /action === 'find'\) \{\s*if \(!editing\) return;\s*e\.preventDefault\(\);\s*editing\.cm\.openSearchPanel\(editing\.view\);/);
});

test('the word count sits in the top bar, shown only while editing and not on phones', () => {
    const topbar = html.match(/<header class="topbar">([\s\S]*?)<\/header>/);
    assert.match(topbar[1], /<span[^>]*id="wordCount"[^>]*\shidden[\s>]/);
    assert.match(html, /body\.editing \.word-count:not\(\[hidden\]\)/);
    assert.match(html, /@media \(max-width: 700px\)[\s\S]*?\.word-count \{\s*display: none !important;/);
    // Counted with core.countWords, after a pause in typing.
    assert.match(app, /function scheduleWordCount\(\) \{\s*clearTimeout\(wordCountTimer\);\s*wordCountTimer = setTimeout\(renderWordCount, WORD_COUNT_DELAY_MS\);/);
    assert.match(app, /core\.countWords\(state\.sliceDoc\(\)\)/);
});

test('unsaved changes are guarded: closing the window, the browser tab, Open another, drops and the file list', () => {
    assert.match(app, /onCloseRequested\(async \(event\) => \{\s*if \(!\(await leaveEditor\(\)\)\) event\.preventDefault\(\);/);
    assert.match(app, /addEventListener\('beforeunload'/);
    assert.match(app, /backButton\.addEventListener\('click', \(\) => \{\s*leaveEditor\(\)\.then/);
    assert.match(app, /leaveEditor\(\)\.then\(left => \{\s*if \(left\) handleDesktopDrop\(paths, \{ dropped: true \}\);/);
    // The file list stays up beside the document: picking from it, Cancel and Watch this folder.
    assert.match(app, /const pick = async \(\) => \{[\s\S]*?if \(!\(await leaveEditor\(\)\)\) return;/);
    assert.match(app, /cancelSelectorButton\.addEventListener\('click', \(\) => \{\s*leaveEditor\(\)\.then/);
    assert.match(app, /async function toggleWatchFolder\(\) \{[\s\S]*?if \(editing\) \{\s*await finishEditing\(\);/);
    // A save being written finishes before anything is discarded.
    assert.match(app, /async function leaveEditor\(\) \{[\s\S]*?if \(editing && editing\.saving\) await editing\.saving;/);
    // Closing needs the window's destroy permission once a JS listener takes over.
    const capability = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'capabilities', 'default.json'), 'utf8'));
    assert.ok(capability.permissions.includes('core:window:allow-destroy'));
});

test('the formatting toolbar has a labelled control for every command', () => {
    const format = require('../js/format.js');
    const toolbar = html.match(/<div class="format-toolbar"[\s\S]*?\n {12}<\/div>\n/)[0];
    assert.match(toolbar, /role="toolbar"/);
    assert.match(toolbar, /aria-label="Formatting"/);
    for (const command of format.COMMANDS) {
        const button = toolbar.match(new RegExp(`<button class="tool"[^>]*data-command="${command}"[^>]*>`));
        assert.ok(button, `a toolbar button for ${command}`);
        assert.match(button[0], /aria-label="[^"]+"/, `${command} has a label`);
        assert.match(button[0], /aria-pressed="false"/, `${command} shows whether it's on`);
        assert.match(button[0], /data-tool/, `${command} takes part in the arrow keys`);
    }
    for (const style of format.BLOCK_STYLES) {
        assert.match(toolbar, new RegExp(`role="menuitemradio"[^>]*data-command="block:${style}"`), `a menu item for ${style}`);
    }
    // Whatever moves into the overflow menu at narrow widths is in it.
    for (const [, command] of toolbar.matchAll(/data-command="(\w+)" data-tool data-overflow/g)) {
        assert.match(toolbar, new RegExp(`role="menuitemcheckbox"[^>]*data-command="${command}"`), `${command} in the overflow menu`);
    }
});

test('the Rich | Markdown | Split switch sits beside the pencil, a radio group of the views', () => {
    const actions = html.match(/<div class="topbar-actions">[\s\S]*?\n {12}<\/div>\n/)[0];
    const group = actions.match(/<div class="mode-switch" id="modeSwitch"[^>]*>([\s\S]*?)<\/div>/);
    assert.ok(group, 'the switch is in the top bar');
    assert.match(group[0], /role="radiogroup"/);
    assert.match(group[0], /aria-label="Editor view"/);
    assert.match(group[0], /hidden>/, 'hidden until editing');
    const modes = [...group[1].matchAll(/<button[^>]*role="radio"[^>]*data-mode="(\w+)"[^>]*>(\w+)</g)].map(m => [m[1], m[2]]);
    assert.deepEqual(modes, [['rich', 'Rich'], ['markdown', 'Markdown'], ['split', 'Split']]);
    assert.ok(actions.indexOf('id="modeSwitch"') < actions.indexOf('id="editButton"'), 'next to the pencil');
    // Rich unless the reader last chose another view.
    assert.match(app, /return core\.EDITOR_MODES\.includes\(saved\) \? saved : 'rich'/);
    // Split isn't offered at phone widths.
    const phone = html.match(/@media \(max-width: 700px\) \{[\s\S]*?\n {8}\}\n/)[0];
    assert.match(phone, /\.mode-option\[data-mode="split"\] \{\s*display: none;/);
    assert.match(app, /window\.matchMedia\('\(max-width: 700px\)'\)/);
});

test('split view renders the document beside the editor, outside the rendered markdown', () => {
    const main = html.match(/<main>([\s\S]*?)<\/main>/)[1];
    const preview = main.match(/<article class="markdown-content split-preview" id="splitPreview"[^>]*>([\s\S]*?)<\/article>/);
    assert.ok(preview, 'the split preview is in main');
    assert.match(preview[0], /\shidden>/);
    assert.equal(preview[1].trim(), '');
    assert.ok(main.indexOf('id="editorHost"') < main.indexOf('id="splitPreview"'), 'the editor on the left');
});

test('the toolbar inserts tables, images and rules, which narrow widths reach through the overflow menu', () => {
    const toolbar = html.match(/<div class="format-toolbar"[\s\S]*?\n {12}<\/div>\n/)[0];
    for (const action of ['table', 'image', 'horizontalRule']) {
        const button = toolbar.match(new RegExp(`<button class="tool"[^>]*data-action="${action}"[^>]*>`));
        assert.ok(button, `a toolbar button for ${action}`);
        assert.match(button[0], /aria-label="[^"]+"/, `${action} has a label`);
        assert.doesNotMatch(button[0], /aria-pressed/, `${action} is an action, not a toggle`);
        assert.match(button[0], /data-tool/, `${action} takes part in the arrow keys`);
    }
    for (const [, action] of toolbar.matchAll(/data-action="(\w+)" data-tool data-overflow/g)) {
        assert.match(toolbar, new RegExp(`role="menuitem"[^>]*data-action="${action}"`), `${action} in the overflow menu`);
    }
    // The table's size picker is a dialog the table button opens.
    assert.match(toolbar, /id="tableButton"[^>]*aria-haspopup="dialog"[^>]*aria-controls="tablePicker"/);
    assert.match(toolbar, /<div class="table-picker" id="tablePicker" role="dialog" aria-label="[^"]+" hidden>/);
});

test('desktop images are picked by the app, which offers to copy them next to the document', () => {
    assert.match(app, /invoke\('choose_image'\)/);
    assert.match(app, /core\.relativePath\(source\.dir, picked\)/);
    const lib = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
    assert.match(lib, /generate_handler!\[[\s\S]*?\bchoose_image,/);
});

test('the drop zone offers New file beside Choose File, which starts an untitled document in the editor', () => {
    const zone = html.match(/<div class="drop-zone" id="dropZone"[\s\S]*?<p class="drop-hint">/)[0];
    const actions = zone.match(/<div class="drop-actions">([\s\S]*?)<\/div>/);
    assert.ok(actions, 'the drop zone has its actions together');
    assert.ok(actions[1].indexOf('id="uploadButton"') < actions[1].indexOf('id="newFileButton"'), 'New file comes after Choose File');
    assert.match(actions[1], /<button class="btn btn-ghost new-file-button" id="newFileButton" type="button"[^>]*>[\s\S]*?New file\s*<\/button>/);
    const newDocument = app.match(/async function newDocument[\s\S]*?\n {4}}\n/)[0];
    // Unsaved changes are asked about before anything is replaced.
    assert.ok(newDocument.indexOf('await loadCodeMirror()') < newDocument.indexOf('await leaveEditor()'), 'the editor loads (and can fail) before unsaved changes go');
    assert.ok(newDocument.indexOf('await leaveEditor()') < newDocument.indexOf('renderMarkdown('));
    assert.match(newDocument, /kind: 'untitled'/);
    assert.match(newDocument, /await startEditing\(restore \? [^\n]* : null\)/);
    // File > New reaches the page as a pending untitled document.
    assert.match(app, /if \(pending\.untitled\) \{\s*\/\/ File > New\.[^\n]*\s*if \(!\(await newDocument\(\)\) && !currentSource\) showDropZone\(\);/);
});

test('a new document\'s first save goes through the Save panel or showSaveFilePicker, then it is that file', () => {
    const save = app.match(/async function saveToFile[\s\S]*?\n {4}}\n/)[0];
    // In the app, an untitled document has no file to name: the panel suggests Untitled.md.
    assert.match(save, /const path = source\.kind === 'desktop' \? source\.path : null;\s*const doc = await invoke\('save_document_as', \{ path, base, content \}\);/);
    assert.match(save, /window\.showSaveFilePicker\(\{ suggestedName: core\.saveAsName\(source\), types: SAVE_TYPES \}\)/);
    // Cancelling the panel keeps the document untitled; the picker's cancel is an AbortError,
    // which writeSession ignores.
    assert.match(save, /if \(!doc\) return;/);
    const write = app.match(/async function writeSession[\s\S]*?\n {4}}\n/)[0];
    assert.match(write, /if \(mode === 'saveAs'\) \{\s*await saveToFile\(session, source, content, base\);/);
    assert.match(write, /err\.name === 'AbortError'/);
    // Afterwards it saves in place and live-reloads.
    assert.match(save, /kind: 'desktop', dir: doc\.dir, title: doc\.name, path: doc\.path/);
    assert.match(save, /await watchDesktopDocument\(doc\.path\)/);
    assert.match(save, /kind: 'file', dir: '', title: handle\.name, handle/);
    assert.match(save, /startWebWatch\(handle, /);
    const lib = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
    assert.match(lib, /generate_handler!\[[\s\S]*?\bsave_document_as,/);
    assert.match(lib, /save::save_panel_start\(file\.as_deref\(\), UNTITLED_FILE_NAME, \|\| \{\s*state\.recent\.lock\(\)\.unwrap\(\)\.last_folder\(\)/);
    // The app's File > New, above New Tab.
    assert.match(lib, /MenuItemBuilder::with_id\(NEW_DOCUMENT_MENU_ID, "New"\)\s*\.accelerator\("CmdOrCtrl\+N"\)/);
    assert.match(lib, /submenu\.prepend\(&new_tab\)\?;\s*submenu\.prepend\(&new_document\)\?;/);
    assert.match(lib, /&\[\s*&new_document,\s*&open,/, 'and first in the Linux File menu');
});

test('Save As saves under another name from the menu, the shortcut and the button, while viewing too', () => {
    // A button next to Save, shown with it while editing.
    assert.match(html, /<button class="btn btn-ghost save-as-button" id="saveAsButton" type="button" hidden>Save As…<\/button>\s*<button class="btn btn-primary save-button" id="saveButton"/);
    assert.match(html, /\.save-as-button\[hidden\]/);
    assert.match(app, /saveAsButton\.addEventListener\('click', saveDocumentAs\);/);
    const controls = app.match(/function renderEditControls[\s\S]*?\n {4}}\n/)[0];
    assert.match(controls, /saveAsButton\.hidden = !on;/);
    // Enabled with nothing unsaved; not while a save is written or the banner waits.
    assert.match(controls, /saveAsButton\.disabled = Boolean\(editing\.saving\) \|\| editing\.state\.conflict !== null;/);
    // ⇧⌘S / Ctrl+Shift+S, whether or not the editor is open.
    const shortcut = app.match(/function onEditShortcut[\s\S]*?\n {4}}\n/)[0];
    assert.match(shortcut, /\} else if \(action === 'saveAs'\) \{\s*e\.preventDefault\(\);\s*saveDocumentAs\(\);\s*\} else if \(editing\) \{/);
    // The app's File > Save As… reaches the front window's page.
    assert.match(app, /listen\('save-as', \(\) => saveDocumentAs\(\)\)/);
    const lib = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
    assert.match(lib, /MenuItemBuilder::with_id\(SAVE_AS_MENU_ID, "Save As…"\)\s*\.accelerator\("CmdOrCtrl\+Shift\+S"\)/);
    assert.match(lib, /submenu\.insert\(&save_as, 5\)\?;/);
    assert.match(lib, /&recent,\s*&PredefinedMenuItem::separator\(app\)\?,\s*&save_as,/, 'and in the Linux File menu');
    assert.match(lib, /id == SAVE_AS_MENU_ID \{\s*if let Some\(label\) = front_window\(app\) \{\s*let _ = app\.emit_to\(label\.as_str\(\), SAVE_AS_EVENT, \(\)\);/);

    // One at a time (the menu and the page's shortcut can both fire), and like Save, not while
    // the banner waits for an answer.
    const saveAs = app.match(/async function saveDocumentAs[\s\S]*?\n {4}}\n/)[0];
    assert.match(saveAs, /if \(!source \|\| savingAs\) return;/);
    assert.match(saveAs, /session\.saving \|\| session\.state\.conflict !== null/);
    assert.match(saveAs, /if \(session\) session\.saving = writing;/);
    const writeAs = app.match(/async function writeAs[\s\S]*?\n {4}}\n/)[0];
    // While viewing, the text on screen; the base is what a same-file save is checked against.
    assert.match(writeAs, /const content = session \? editorText\(\) : source\.markdown;/);
    assert.match(writeAs, /const base = session \? session\.state\.base : source\.markdown;/);
    assert.match(writeAs, /downloadText\(content, core\.saveAsName\(source\)\);/);
    assert.match(writeAs, /err\.name === 'AbortError'\) return;/);

    const save = app.match(/async function saveToFile[\s\S]*?\n {4}}\n/)[0];
    // The picker is called before anything is awaited, while the click still counts.
    assert.match(save, /if \(isDesktop\) \{[\s\S]*?\n {8}\}\n\s*\/\/ Called before anything is awaited[^\n]*\n[^\n]*\n\s*const handle = await window\.showSaveFilePicker\(/);
    assert.match(fn('saveDocumentAs'), /const writing = writeAs\(session, source\);/);
    assert.match(fn('writeAs'), /try \{\s*const mode = [^\n]*\n\s*if \(mode === 'saveAs'\) \{\s*await saveToFile\(/);
    // Picking the file it already is: an ordinary, checked save.
    assert.match(save, /if \(source\.handle && await source\.handle\.isSameEntry\(handle\)\) \{[\s\S]*?if \(session\) await writeSession\(session, source\);\s*return;/);
    // The old file's watch stops; the new one's starts.
    assert.match(save, /stopWebWatch\(\);\s*startWebWatch\(handle, /);
    assert.ok(save.indexOf("let rewatch = doc.path !== source.path;") > 0);
    assert.match(save, /if \(currentSource !== source \|\| !rewatch\) return;\s*setLive\(true\);[\s\S]*?await watchDesktopDocument\(doc\.path\);/);
    // The backup of anything still unsaved names the new file at once.
    assert.match(app, /dispatchEdit\(\{ type: 'saved', content, text: editorText\(\) \}\);\s*if \(session\.state\.dirty\) writeBackup\(session\);/);
});

test('the shortcuts page lists Save As', () => {
    const shortcuts = fs.readFileSync(path.join(root, 'docs', 'shortcuts.md'), 'utf8');
    assert.match(shortcuts, /\| Save As, to a file you pick \| <kbd>⇧⌘S<\/kbd> \| <kbd>Ctrl\+Shift\+S<\/kbd> \|/);
});

test('the shortcuts page lists New file', () => {
    const shortcuts = fs.readFileSync(path.join(root, 'docs', 'shortcuts.md'), 'utf8');
    assert.match(shortcuts, /\| New file \(app\) \| <kbd>⌘N<\/kbd> \| <kbd>Ctrl\+N<\/kbd> \|/);
});
