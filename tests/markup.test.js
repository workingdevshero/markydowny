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
