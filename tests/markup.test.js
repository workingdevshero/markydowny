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
