const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');

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
    assert.equal(calls.length, 3, 'expected the definition plus the desktop and web callers');
    const desktopDrop = app.match(/async function handleDesktopDrop[\s\S]*?\n {4}}\n/)[0];
    assert.match(desktopDrop, /openAllAsTabs\(entries\.map\(entry => entry\.path\)\)/);
    const webFolder = app.match(/async function handleFolder[\s\S]*?\n {4}}\n/)[0];
    assert.doesNotMatch(webFolder, /openAllAsTabs/);
    const openAll = app.match(/function openAllAsTabs[\s\S]*?\n {4}}\n/)[0];
    assert.match(openAll, /invoke\('open_documents', \{ paths \}\)/);
    assert.doesNotMatch(openAll, /showDropZone\(/, 'showDropZone would mark the window idle after a file landed in it');
    // The app must stop counting this window as showing (or following) the folder first.
    const clear = Math.max(openAll.indexOf('await watchDesktopDocument('), openAll.indexOf("await invoke('set_document_open'"));
    assert.ok(clear > 0 && clear < openAll.indexOf("invoke('open_documents'"), 'the window is cleared, awaited, before the files are routed');
    assert.match(openAll, /generation: \+\+watchGeneration/);
});

test('only the desktop app forwards ⌃Tab to switch tabs', () => {
    const initDesktop = app.match(/async function initDesktop[\s\S]*?\n {4}}\n/)[0];
    assert.match(initDesktop, /core\.tabStepForKey\(e\)/);
    assert.match(initDesktop, /invoke\('select_tab', \{ direction \}\)/);
    assert.equal([...app.matchAll(/select_tab/g)].length, 1, 'select_tab is only invoked from initDesktop');
});

test('desktop windows report their document path so same-named tabs can be told apart', () => {
    assert.match(app, /invoke\('set_document_open', \{ open, title: title \|\| null, path: path \|\| null, generation \}\)/);
    assert.match(app, /kind: 'desktop', dir: doc\.dir, title, path: doc\.path/);
    // A file from a dropped folder keeps its "folder › file" title, so it sends no path.
    const show = app.match(/function showMarkdownContent[\s\S]*?\n {4}}\n/)[0];
    assert.match(show, /currentSource\.kind === 'desktop' && !desktopFolder \? currentSource\.path : null/);
    assert.match(show, /setDocumentOpen\(true, title, path\)/);
});
