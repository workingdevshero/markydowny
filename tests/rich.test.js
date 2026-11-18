// Rich mode's decorations, read from the markdown syntax tree by the checked-in CodeMirror bundle
// (js/vendor/codemirror.js, built from scripts/codemirror-entry.mjs by `npm run vendor`), as a
// function of the text and the cursor: what's hidden, what's drawn as a widget, what's styled.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = {};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/vendor/codemirror.js'), 'utf8'), context);
const cm = context.MarkyCodeMirror;

/** The state for `marked` text, with '|' marking the cursor and '{' '}' around a selection. */
function stateFor(marked) {
    const text = marked.replace(/[|{}]/g, '');
    let anchor = marked.indexOf('|');
    let head = anchor;
    if (anchor === -1) {
        anchor = marked.indexOf('{');
        head = marked.indexOf('}') - 1;
    }
    return { text, state: cm.createState(text).update({ selection: { anchor, head } }).state };
}

/** `value`, made of this realm's arrays and objects (the bundle runs in its own). */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Rich mode over `marked`, summarized as text. */
function rich(marked) {
    return summarize(stateFor(marked));
}

/** Rich mode over `text` with the cursor at `anchor` (tables are full of '|'). */
function richAt(text, anchor, head = anchor) {
    return summarize({ text, state: cm.createState(text).update({ selection: { anchor, head } }).state });
}

function summarize({ text, state }) {
    const specs = cm.richDecorations(state);
    const of = (kind) => specs.filter(spec => spec.kind === kind);
    return plain({
        hidden: of('hide').map(s => text.slice(s.from, s.to)),
        replaced: of('replace').map(s => [text.slice(s.from, s.to), s.widget]),
        widgets: of('widget').map(s => s.widget),
        marks: of('mark').map(s => (s.href !== undefined ? [s.className, text.slice(s.from, s.to), s.href] : [s.className, text.slice(s.from, s.to)])),
        lines: of('line').map(s => [state.doc.lineAt(s.from).number, s.className]),
    });
}

test('inline styles: markers hidden off the cursor line, shown on it', () => {
    const off = rich('|x\n\n**bold** _it_ ~~gone~~ `code`');
    assert.deepEqual(off.hidden, ['**', '**', '_', '_', '~~', '~~', '`', '`']);
    assert.deepEqual(off.marks, [
        ['cm-rich-strong', '**bold**'],
        ['cm-rich-em', '_it_'],
        ['cm-rich-strike', '~~gone~~'],
        ['cm-rich-code', '`code`'],
    ]);
    const on = rich('x\n\n**bo|ld** _it_ ~~gone~~ `code`');
    assert.deepEqual(on.hidden, []);
    assert.equal(on.marks.length, 4, 'still styled on the cursor line');
    // Markers inside code are code.
    assert.deepEqual(rich('|x\n\n`**no**`').hidden, ['`', '`']);
});

test('a selection shows the markers of every line it touches', () => {
    assert.deepEqual(rich('{**a**\n**b**}\n**c**').hidden, ['**', '**']);
    assert.deepEqual(rich('**a**\n{**b**}\n**c**').hidden, ['**', '**', '**', '**']);
});

test('headings: sized lines, the # hidden off the cursor line', () => {
    const off = rich('|x\n\n# Title\n\n## Sub ##\n\n###### Six');
    assert.deepEqual(off.lines, [[3, 'cm-rich-h1'], [5, 'cm-rich-h2'], [7, 'cm-rich-h6']]);
    assert.deepEqual(off.hidden, ['# ', '## ', ' ##', '###### ']);
    const on = rich('x\n\n# Ti|tle');
    assert.deepEqual(on.lines, [[3, 'cm-rich-h1']]);
    assert.deepEqual(on.hidden, []);
    // Setext: the underline line is hidden (and shrunk) off the cursor.
    const setext = rich('|x\n\nTitle\n=====');
    assert.deepEqual(setext.lines, [[3, 'cm-rich-h1'], [4, 'cm-rich-setext-underline']]);
    assert.deepEqual(setext.hidden, ['=====']);
    assert.deepEqual(rich('x\n\nTitle\n==|===').hidden, []);
});

test('links: the text styled, [ and ](url) hidden, the target kept for ⌘-click', () => {
    const off = rich('|x\n\nsee [the docs](https://a.b/c "Title") now');
    assert.deepEqual(off.marks, [['cm-rich-link', 'the docs', 'https://a.b/c']]);
    assert.deepEqual(off.hidden, ['[', '](https://a.b/c "Title")']);
    const on = rich('x\n\nsee [the d|ocs](https://a.b/c) now');
    assert.deepEqual(on.hidden, []);
    assert.deepEqual(on.marks, [['cm-rich-link', 'the docs', 'https://a.b/c']]);
    // Relative and anchor links keep their href as written.
    assert.deepEqual(rich('|x\n\n[next](other.md) [up](#top)').marks, [
        ['cm-rich-link', 'next', 'other.md'],
        ['cm-rich-link', 'up', '#top'],
    ]);
});

test('reference links, autolinks and bare URLs', () => {
    const refs = rich('|x\n\n[full][Ref] and [Ref]\n\n[ref]: https://r.example');
    assert.deepEqual(refs.marks, [
        ['cm-rich-link', 'full', 'https://r.example'],
        ['cm-rich-link', 'Ref', 'https://r.example'],
    ]);
    assert.deepEqual(refs.hidden, ['[', '][Ref]', '[', ']']);
    const auto = rich('|x\n\n<https://a.b> www.c.d');
    assert.deepEqual(auto.marks, [
        ['cm-rich-link', 'https://a.b', 'https://a.b'],
        ['cm-rich-link', 'www.c.d', 'http://www.c.d'],
    ]);
    assert.deepEqual(auto.hidden, ['<', '>']);
});

test('images: rendered under their markdown, cursor or not', () => {
    const off = rich('|x\n\n![Marky](img/marky.png)');
    assert.deepEqual(off.widgets, [{ type: 'image', src: 'img/marky.png', alt: 'Marky' }]);
    assert.deepEqual(off.marks, [['cm-rich-image-source', '![Marky](img/marky.png)']]);
    assert.deepEqual(off.hidden, []);
    const on = rich('x\n\n![Mar|ky](img/marky.png)');
    assert.deepEqual(on.widgets, [{ type: 'image', src: 'img/marky.png', alt: 'Marky' }]);
    assert.deepEqual(on.marks, []);
    assert.deepEqual(rich('|x\n\n![a](<with space.png>)').widgets, [{ type: 'image', src: 'with space.png', alt: 'a' }]);
});

test('lists: bullets drawn as bullets, by depth; numbers kept', () => {
    const off = rich('|x\n\n- a\n  - b\n    - c\n\n1. one');
    assert.deepEqual(off.replaced, [
        ['-', { type: 'bullet', text: '•' }],
        ['-', { type: 'bullet', text: '◦' }],
        ['-', { type: 'bullet', text: '▪' }],
    ]);
    assert.deepEqual(off.marks, [['cm-rich-list-mark', '1.']]);
    const on = rich('x\n\n- |a\n- b');
    assert.deepEqual(on.replaced, [['-', { type: 'bullet', text: '•' }]]);
});

test('tasks: a checkbox in place of "- [ ]" off the cursor line', () => {
    const off = rich('|x\n\n- [ ] todo\n- [x] done');
    assert.deepEqual(off.hidden, ['- ', '- ']);
    assert.deepEqual(off.replaced, [['[ ]', { type: 'task', checked: false }], ['[x]', { type: 'task', checked: true }]]);
    assert.deepEqual(off.marks, [['cm-rich-task-done', ' done']]);
    const on = rich('x\n\n- [ ] to|do');
    assert.deepEqual(on.hidden, []);
    assert.deepEqual(on.replaced, []);
});

test('quotes: styled lines, > hidden off the cursor line', () => {
    const off = rich('|x\n\n> one\n> > two\nlazy');
    assert.deepEqual(off.lines, [[3, 'cm-rich-quote'], [4, 'cm-rich-quote'], [5, 'cm-rich-quote']]);
    assert.deepEqual(off.hidden, ['> ', '> ', '> ']);
    assert.deepEqual(rich('x\n\n> o|ne\n> two').hidden, ['> ']);
});

test('code blocks: styled lines, the fences drawn as a language label', () => {
    const off = rich('|x\n\n```js\nlet a;\n```\n\n    indented');
    assert.deepEqual(off.lines, [
        [3, 'cm-rich-codeblock cm-rich-codeblock-first'],
        [4, 'cm-rich-codeblock'],
        [5, 'cm-rich-codeblock cm-rich-codeblock-last'],
        [5, 'cm-rich-fence-hidden'],
        [7, 'cm-rich-codeblock cm-rich-codeblock-first cm-rich-codeblock-last'],
    ]);
    assert.deepEqual(off.replaced, [['```js', { type: 'codeLabel', lang: 'js' }]]);
    assert.deepEqual(off.hidden, ['```']);
    // Nothing inside is styled as markdown.
    assert.deepEqual(rich('|x\n\n```\n**not bold**\n```').marks, []);
    const on = rich('x\n\n```js|\nlet a;\n```');
    assert.deepEqual(on.replaced, []);
    assert.deepEqual(on.hidden, ['```']);
    assert.deepEqual(rich('x\n\n```js\nlet| a;\n```').replaced, [['```js', { type: 'codeLabel', lang: 'js' }]]);
});

test('horizontal rules: a rule off the cursor line', () => {
    assert.deepEqual(rich('|x\n\n---\n\ny').replaced, [['---', { type: 'hr' }]]);
    assert.deepEqual(rich('x\n\n-|--\n\ny').replaced, []);
    // A setext underline isn't a rule.
    assert.deepEqual(rich('|x\n\nTitle\n---').replaced, []);
});

const TABLE = '| Name | *Qty* | Note |\n|:-----|-----:|:----:|\n| a \\| b | 2 | |\n| c | 3 | ok |';

test('tables: drawn whole off the cursor, as markdown on it', () => {
    const doc = `x\n\n${TABLE}\n\ny`;
    const tablesAt = (anchor, head = anchor) => plain(cm.richTables(cm.createState(doc).update({ selection: { anchor, head } }).state));
    const [table] = tablesAt(0);
    assert.deepEqual(table, {
        from: 3,
        to: 3 + TABLE.length,
        active: false,
        align: ['left', 'right', 'center'],
        header: ['Name', '*Qty*', 'Note'],
        rows: [['a | b', '2', ''], ['c', '3', 'ok']],
    });
    // Off the cursor, nothing inside it is decorated: the widget covers it.
    assert.deepEqual(richAt(doc, 0).marks, []);

    const inside = doc.indexOf('| c') + 2;
    assert.equal(tablesAt(inside)[0].active, true);
    const on = richAt(doc, inside);
    assert.deepEqual(on.marks, [['cm-rich-em', '*Qty*']]);
    assert.deepEqual(on.lines.map(([, c]) => c), Array(4).fill('cm-rich-table-source'));
    // A selection reaching into it counts; one ending on the line before doesn't.
    assert.equal(tablesAt(0, 4)[0].active, true);
    assert.equal(tablesAt(0, 1)[0].active, false);
});

test('toggleTask flips only the box', () => {
    assert.deepEqual({ ...cm.toggleTask('- [ ] a', 2) }, { from: 3, to: 4, insert: 'x' });
    assert.deepEqual({ ...cm.toggleTask('- [x] a', 2) }, { from: 3, to: 4, insert: ' ' });
    assert.deepEqual({ ...cm.toggleTask('- [X] a', 2) }, { from: 3, to: 4, insert: ' ' });
    assert.equal(cm.toggleTask('- [ ] a', 0), null);
    assert.equal(cm.toggleTask('- [y] a', 2), null);
    assert.equal(cm.toggleTask('[', 0), null);
});

test('toggling a task in the editor changes one character of the file', () => {
    const text = '# List\r\n\r\n- [ ] one\r\n- [x] two\r\n';
    let state = cm.createState(text, { lineSeparator: '\r\n' });
    const pos = state.doc.toString().indexOf('[ ]');
    const change = cm.toggleTask(state.sliceDoc(pos, pos + 3), 0);
    state = state.update({ changes: { from: pos + change.from, to: pos + change.to, insert: change.insert } }).state;
    assert.equal(state.sliceDoc(), text.replace('[ ]', '[x]'));
});

test('headings lists each heading\'s text without its markup', () => {
    const { state } = stateFor('|# Hello **World**\n\nSub `code`\n---\n\n> ## [Quoted](u)');
    assert.deepEqual(plain(cm.headings(state)), [
        { from: 0, level: 1, text: 'Hello World' },
        { from: 19, level: 2, text: 'Sub code' },
        { from: 37, level: 2, text: 'Quoted' },
    ]);
});

test('switching modes keeps the text, selection and undo history', () => {
    const { text, state: start } = stateFor('# T|itle\n\nbody');
    let state = start.update({ changes: { from: text.length, insert: ' more' } }).state;
    const selection = state.selection.main;
    // setMode only needs the view's state and dispatch.
    const view = {
        get state() {
            return state;
        },
        dispatch(spec) {
            state = state.update(spec).state;
        },
    };
    cm.setMode(view, 'rich');
    assert.equal(state.sliceDoc(), text + ' more');
    assert.deepEqual(plain(state.selection.main), plain(selection));
    assert.equal(cm.richDecorations(state).length > 0, true);
    cm.setMode(view, 'markdown');
    assert.equal(state.sliceDoc(), text + ' more');
    assert.equal(cm.undoDepth(state), 1);
});
