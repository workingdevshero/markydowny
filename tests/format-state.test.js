// The toolbar's active state, read from the markdown syntax tree by the checked-in CodeMirror
// bundle (js/vendor/codemirror.js, built from scripts/codemirror-entry.mjs by `npm run vendor`).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = {};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/vendor/codemirror.js'), 'utf8'), context);
const cm = context.MarkyCodeMirror;

/** formatState with the selection marked in the text: '|' for a cursor, '{' and '}' around a selection. */
function stateAt(marked) {
    const anchor = marked.indexOf('|') !== -1 ? marked.indexOf('|') : marked.indexOf('{');
    const text = marked.replace(/[|{}]/g, '');
    const head = marked.indexOf('|') !== -1 ? anchor : marked.indexOf('}') - 1;
    const state = cm.createState(text).update({ selection: { anchor, head } }).state;
    return { ...cm.formatState(state) };
}

function active(marked) {
    const state = stateAt(marked);
    return ['bold', 'italic', 'strikethrough', 'code', 'link'].filter(style => state[style]);
}

test('a cursor in bold text lights up Bold', () => {
    assert.deepEqual(active('a **bo|ld** b'), ['bold']);
    assert.deepEqual(active('a __bo|ld__ b'), ['bold']);
    // On either side of it, as the Bold command unwraps from there.
    assert.deepEqual(active('a |**bold** b'), ['bold']);
    assert.deepEqual(active('a **bold**| b'), ['bold']);
    assert.deepEqual(active('a| **bold** b'), []);
});

test('every inline style is read from the tree', () => {
    assert.deepEqual(active('*it|alic*'), ['italic']);
    assert.deepEqual(active('***bo|th***').sort(), ['bold', 'italic']);
    assert.deepEqual(active('~~str|uck~~'), ['strikethrough']);
    assert.deepEqual(active('`co|de`'), ['code']);
    assert.deepEqual(active('[li|nk](url)'), ['link']);
    // Markers inside code are code.
    assert.deepEqual(active('`**no|t**`'), ['code']);
});

test('a selection counts only when all of it is in the style', () => {
    assert.deepEqual(active('a **{bold}** b'), ['bold']);
    assert.deepEqual(active('{a **bold}** b'), []);
});

test('the block style comes from the line the cursor is on', () => {
    assert.equal(stateAt('Plain te|xt').block, 'paragraph');
    assert.equal(stateAt('# Ti|tle').block, 'h1');
    assert.equal(stateAt('|## Title').block, 'h2');
    assert.equal(stateAt('### Title|').block, 'h3');
    assert.equal(stateAt('Title|\n=====').block, 'h1');
    assert.equal(stateAt('> quo|ted').block, 'quote');
    assert.equal(stateAt('```\nco|de\n```').block, 'codeBlock');
    assert.equal(stateAt('```\ncode\n```|').block, 'codeBlock');
    assert.equal(stateAt('# Title\n\n|').block, 'paragraph');
});

test('the list comes from the item the cursor is in', () => {
    assert.equal(stateAt('- it|em').list, 'bullet');
    assert.equal(stateAt('1. it|em').list, 'ordered');
    assert.equal(stateAt('- [ ] ta|sk').list, 'task');
    assert.equal(stateAt('- [x] |done').list, 'task');
    assert.equal(stateAt('pla|in').list, null);
});
