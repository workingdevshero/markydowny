const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const coreSource = fs.readFileSync(path.join(root, 'js', 'core.js'), 'utf8');

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

const main = html.match(/<main>([\s\S]*?)<\/main>/)[1];

test('the homepage sections around the drop zone are marked as marketing', () => {
    const hero = main.match(/<div class="hero marketing">[\s\S]*?<\/div>/);
    assert.ok(hero, 'a hero, marked as marketing');
    assert.match(hero[0], /<h1 class="hero-title">/);
    assert.ok(main.indexOf('class="hero marketing"') < main.indexOf('id="dropZone"'), 'the headline sits above the drop zone');

    const features = main.match(/<div class="features marketing" id="features">([\s\S]*?)\n {12}<\/div>\n/);
    assert.ok(features, 'feature sections, marked as marketing');
    const titles = [...features[1].matchAll(/<section class="feature\b[^"]*"[\s\S]*?<h2[^>]*>([^<]+)<\/h2>/g)].map(m => m[1]);
    assert.equal(titles.length, 5, 'live reload, Claude Code, the editor, tabs and privacy');
    for (const link of ['/docs/live-reload/', '/docs/claude-code/', '/docs/editor/', '/docs/tabs/', '/docs/privacy/']) {
        assert.match(features[1], new RegExp(`href="${link}"`), `links to ${link}`);
    }

    const strip = main.match(/<section class="download-strip marketing"[\s\S]*?<\/section>/);
    assert.ok(strip, 'a download strip, marked as marketing');
    assert.match(strip[0], /href="https:\/\/github\.com\/workingdevshero\/markydowny\/releases\/latest\/download\/Markydowny-mac\.dmg"[^>]*>Download for Mac</);
    assert.match(strip[0], /href="\/docs\/"/);

    // Every section in <main> other than the file list is marketing.
    for (const [tag] of main.matchAll(/<section class="[^"]*"/g)) {
        if (tag.includes('file-selector') || /class="feature\b/.test(tag)) continue;
        assert.match(tag, /\bmarketing\b/, `${tag} is marketing`);
    }
    // The drop zone itself isn't: the desktop app opens straight to it.
    assert.doesNotMatch(main.match(/<div class="drop-zone"[^>]*>/)[0], /marketing/);
});

test('marketing hides in the desktop app, with a document open and with the file list up', () => {
    assert.match(html, /body\.desktop \.topbar,\s*body\.desktop \.footer,\s*body\.desktop main > \.marketing\s*\{\s*display: none !important;/);
    assert.match(html, /body\.document-open main > \.marketing,\s*\.container\.file-selector-active main > \.marketing\s*\{\s*display: none;/);
});

test('homepage styles apply only to the landing sections, never to rendered markdown', () => {
    const block = html.match(/\/\* -+ Homepage[\s\S]*?\/\* -+ File selector/)[0];
    const selectors = [...block.matchAll(/^\s*([^{}\n/][^{}\n]*?)\s*[{,]\s*$/gm)].map(m => m[1].trim());
    assert.ok(selectors.length > 20);
    for (const selector of selectors) {
        assert.match(selector, /main > \./, `${selector} is scoped to <main>'s own children`);
    }
});

test('the header has Docs, Download and Open a file, slimmed down while a document is open', () => {
    const topbar = html.match(/<header class="topbar">([\s\S]*?)<\/header>/)[1];
    const nav = topbar.match(/<nav class="site-nav" aria-label="Site">([\s\S]*?)<\/nav>/);
    assert.ok(nav, 'site nav in the header');
    assert.match(nav[1], /<a class="site-link" href="\/docs\/">Docs<\/a>/);
    assert.match(nav[1], /<a class="site-link" href="\/docs\/install\/">Download<\/a>/);
    const button = topbar.match(/<button[^>]*id="openFileButton"[^>]*>[\s\S]*?<\/button>/);
    assert.ok(button, 'Open a file in the header');
    assert.match(button[0], /type="button"/);
    assert.match(button[0], /<span class="open-file-label">Open a file<\/span>/);
    // Top right: in the actions, after the nav.
    const actions = topbar.match(/<div class="topbar-actions">[\s\S]*$/)[0];
    assert.ok(actions.indexOf('class="site-nav"') < actions.indexOf('id="openFileButton"'));
    // Docs and Download go while a document is open; the app hides the lot.
    assert.match(html, /body\.document-open \.site-nav,\s*body\.editing \.open-file-button\s*\{\s*display: none;/);
    assert.match(html, /body\.desktop \.topbar \.site-nav,\s*body\.desktop \.topbar \.open-file-button,/);
});

// ---------------------------------------------------------------------------
// Wiring: app.js run against a stub page
// ---------------------------------------------------------------------------

/** An element that records its listeners and answers anything else harmlessly. */
function stubElement(name, { closest = () => null } = {}) {
    const listeners = {};
    const classes = new Set();
    const target = {
        name,
        listeners,
        style: {},
        dataset: {},
        hidden: false,
        textContent: '',
        value: '',
        classList: {
            add: (...c) => c.forEach(x => classes.add(x)),
            remove: (...c) => c.forEach(x => classes.delete(x)),
            toggle: (c, on) => ((on === undefined ? !classes.has(c) : on) ? classes.add(c) : classes.delete(c)),
            contains: (c) => classes.has(c),
        },
        addEventListener(type, fn) {
            (listeners[type] = listeners[type] || []).push(fn);
        },
        closest,
        contains: () => true,
        querySelector: () => null,
        querySelectorAll: () => [],
        getAttribute: () => null,
        setAttribute() {},
        removeAttribute() {},
        replaceChildren() {},
        appendChild() {},
        getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
        click() {
            this.clicked = (this.clicked || 0) + 1;
        },
        dispatch(type, event) {
            for (const fn of listeners[type] || []) fn(event);
        },
    };
    return target;
}

function loadApp({ reducedMotion = false } = {}) {
    const alerts = [];
    const elements = new Map();
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, stubElement(id));
        return elements.get(id);
    };
    const body = stubElement('body');
    const document = {
        title: 'Markydowny',
        body,
        hidden: false,
        getElementById: element,
        querySelector: (selector) => element(selector),
        querySelectorAll: (selector) => (selector === 'main > .marketing img[data-src]' ? screenshots : []),
        createElement: (tag) => stubElement(tag),
        addEventListener() {},
    };
    const screenshots = ['live-reload', 'editor'].map((name) => Object.assign(stubElement(name), { dataset: { src: `/media/home/${name}.webp` } }));
    const window = {
        document,
        navigator: { platform: 'Linux', userAgent: 'node' },
        localStorage: { getItem: () => null, setItem() {} },
        addEventListener() {},
        matchMedia: (query) => ({ matches: reducedMotion && query.includes('reduced-motion'), addEventListener() {} }),
        confirm: () => true,
        alert: (message) => alerts.push(message),
        setTimeout,
        clearTimeout,
        console,
    };
    window.window = window;
    element('.spotlight-video').dataset = { src: '/docs/media/markychecky-board.mp4', poster: '/docs/media/markychecky-board-poster.jpg' };
    const context = vm.createContext(window);
    vm.runInContext(coreSource, context);
    vm.runInContext(appSource, context);
    return { body, element, alerts, screenshots };
}

function dropEvent(target, dataTransfer) {
    return {
        target,
        dataTransfer,
        prevented: false,
        preventDefault() {
            this.prevented = true;
        },
        stopPropagation() {},
    };
}

/** A dropped file whose text is never read to completion: reading it is what's checked. */
function droppedFile(name) {
    const file = {
        name,
        type: '',
        reads: 0,
        text() {
            file.reads++;
            return new Promise(() => {});
        },
    };
    return file;
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('a file dropped on a section below the fold, not the drop zone, opens', async () => {
    const { body } = loadApp();
    assert.ok((body.listeners.drop || []).length > 0, 'the page listens for drops on <body>');
    const section = stubElement('feature', { closest: () => null });
    const file = droppedFile('notes.md');
    const event = dropEvent(section, { types: ['Files'], items: [], files: [file] });
    body.dispatch('drop', event);
    await flush();
    assert.ok(event.prevented, 'the browser doesn\'t navigate to the file');
    assert.equal(file.reads, 1, 'the dropped file was read');
});

test('dragging over the page highlights it, and leaving it clears that', () => {
    const { body, element } = loadApp();
    body.dispatch('dragover', dropEvent(body, { types: ['Files'] }));
    assert.ok(body.classList.contains('dragover'));
    assert.ok(element('dropZone').classList.contains('dragover'));
    body.dispatch('dragleave', { ...dropEvent(body, {}), relatedTarget: null });
    assert.ok(!body.classList.contains('dragover'));
});

test('drops into the editor, and drags that carry no files, are left alone', async () => {
    const { body } = loadApp();
    const inEditor = stubElement('cm-line', { closest: (selector) => (selector === '.editor-host' ? {} : null) });
    const file = droppedFile('notes.md');
    body.dispatch('drop', dropEvent(inEditor, { types: ['Files'], items: [], files: [file] }));
    const text = droppedFile('text');
    body.dispatch('drop', dropEvent(stubElement('p'), { types: ['text/plain'], items: [], files: [text] }));
    await flush();
    assert.equal(file.reads, 0);
    assert.equal(text.reads, 0);
});

test('Open a file in the header opens the file picker in one click', () => {
    const { element } = loadApp();
    const button = element('openFileButton');
    assert.equal(button.listeners.click.length, 1);
    button.dispatch('click', {});
    // No File System Access API here, so the plain file input stands in for the picker.
    assert.equal(element('fileInput').clicked, 1);
});

test('a drag without files, or onto the editor, isn\'t taken over by the page', () => {
    const { body } = loadApp();
    const text = dropEvent(stubElement('p'), { types: ['text/uri-list'] });
    body.dispatch('dragover', text);
    assert.ok(!text.prevented, 'a dragged link still navigates when dropped');
    assert.ok(!body.classList.contains('dragover'));
    const inEditor = stubElement('cm-line', { closest: (selector) => (selector === '.editor-host' ? {} : null) });
    const file = dropEvent(inEditor, { types: ['Files'] });
    body.dispatch('dragover', file);
    assert.ok(!body.classList.contains('dragover'), 'no page outline for a drop the editor takes');
});

test('a dropped file is checked and read before unsaved changes are discarded for it', async () => {
    const { body, alerts } = loadApp();
    const image = droppedFile('photo.png');
    image.type = 'image/png';
    body.dispatch('drop', dropEvent(stubElement('p'), { types: ['Files'], items: [], files: [image] }));
    await flush();
    assert.equal(image.reads, 0);
    assert.equal(alerts.length, 1, 'said why it didn\'t open');
    const drop = appSource.match(/function handlePageDrop[\s\S]*?\n {4}}\n/)[0];
    const read = drop.indexOf('prepare()');
    assert.ok(read >= 0 && read < drop.indexOf('leaveEditor()'), 'read first, discard after');
});

test('the file input is cleared before it opens, so the same file can be picked again', () => {
    const { element } = loadApp();
    const input = element('fileInput');
    input.value = 'C:\\fakepath\\notes.md';
    element('openFileButton').dispatch('click', {});
    assert.equal(input.value, '');
    assert.equal(input.clicked, 1);
});

test('opening a file from outside the list closes a file list that was up', () => {
    for (const reader of ['readFiles', 'readFileHandle', 'readFolder']) {
        const body = appSource.match(new RegExp(`async function ${reader}[\\s\\S]*?\\n {4}}\\n`))[0];
        assert.match(body, /closeFileSelector\(\)/, `${reader} closes the list`);
    }
});

test('the homepage shows the product: screenshot rows, the markychecky spotlight and a 1.0 badge', () => {
    const features = main.match(/<div class="features marketing" id="features">([\s\S]*?)\n {12}<\/div>\n/)[1];
    const rows = [...features.matchAll(/<section class="feature feature-row"[\s\S]*?<\/section>/g)].map(m => m[0]);
    assert.equal(rows.length, 3, 'live reload, the editor and tabs each get a screenshot row');
    for (const row of rows) {
        // data-src, not src: the desktop bundle doesn't ship media/home, so app.js loads them on the website only.
        const img = row.match(/<img data-src="\/media\/home\/([\w-]+\.webp)" alt="([^"]+)" width="1200" height="900" loading="lazy"/);
        assert.ok(img, 'a lazy screenshot with its size and a description');
        assert.ok(fs.statSync(path.join(root, 'media', 'home', img[1])).size > 0, `media/home/${img[1]} is committed`);
    }
    assert.doesNotMatch(features, /\ssrc="\/media\/home\//, 'no screenshot is fetched by the HTML itself');
    assert.equal([...features.matchAll(/<section class="feature feature-card"/g)].length, 2, 'Claude Code and privacy as cards');

    const spotlight = main.match(/<section class="spotlight marketing"[\s\S]*?<\/section>/);
    assert.ok(spotlight, 'a markychecky spotlight, marked as marketing');
    assert.match(spotlight[0], /href="\/docs\/markychecky\/"/);
    const video = spotlight[0].match(/<video [^>]*>/)[0];
    assert.match(video, /class="spotlight-video" data-src="\/docs\/media\/markychecky-board\.mp4" data-poster="[^"]+" muted loop playsinline controls/);
    // The desktop bundle doesn't ship the clip, so the HTML mustn't fetch it, and app.js decides whether it plays.
    assert.doesNotMatch(video, /\s(src|poster|autoplay)[\s=>]/);
    const homeMedia = fs.readdirSync(path.join(root, 'media', 'home'));
    for (const file of homeMedia) assert.ok(main.includes(`/media/home/${file}"`), `media/home/${file} is used`);
    // The spotlight leads with the one-line installer that its setup page leads with.
    assert.match(spotlight[0], /<code class="spotlight-command">curl -fsSL https:\/\/markydowny\.com\/markychecky\.sh \| bash<\/code>/);
    assert.match(fs.readFileSync(path.join(root, 'docs', 'markychecky.md'), 'utf8'), /curl -fsSL https:\/\/markydowny\.com\/markychecky\.sh \| bash/);
    assert.ok(main.indexOf('class="spotlight marketing"') < main.indexOf('class="download-strip marketing"'));

    const hero = main.match(/<div class="hero marketing">[\s\S]*?<\/div>/)[0];
    assert.match(hero, /<a class="hero-badge" href="\/docs\/install\/">/);
    // The download band also offers Linux, through the Download page.
    assert.match(main.match(/<section class="download-strip marketing"[\s\S]*?<\/section>/)[0], /href="\/docs\/install\/"/);
});

test('the website loads the homepage screenshots, and the desktop app never does', () => {
    const { screenshots } = loadApp();
    assert.deepEqual(screenshots.map((img) => img.src), ['/media/home/live-reload.webp', '/media/home/editor.webp']);
    assert.match(appSource, /if \(!isDesktop\) \{\n\s*for \(const img of document\.querySelectorAll\('main > \.marketing img\[data-src\]'\)\)/);
});

test('the website loads the spotlight clip, and plays it only without reduced motion', () => {
    const plays = loadApp().element('.spotlight-video');
    assert.equal(plays.src, '/docs/media/markychecky-board.mp4');
    assert.equal(plays.poster, '/docs/media/markychecky-board-poster.jpg');
    assert.equal(plays.autoplay, true);
    const still = loadApp({ reducedMotion: true }).element('.spotlight-video');
    assert.equal(still.src, '/docs/media/markychecky-board.mp4');
    assert.equal(still.autoplay, false);
    assert.match(appSource, /if \(!isDesktop && spotlightVideo\)/, 'the desktop app never loads it');
});
