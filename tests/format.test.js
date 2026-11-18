const test = require('node:test');
const assert = require('node:assert/strict');
const format = require('../js/format.js');

/**
 * Runs `command` on a document written with the selection marked in it: '|' for a cursor,
 * '{' and '}' around a selection (anchor at '{', head at '}'). Returns the result written the
 * same way, so a test reads as before -> after. (Braces, as '[' and ']' are markdown.)
 */
function run(command, marked) {
    const input = parse(marked);
    const out = format.apply(command, input);
    return show(out.text, out.selection);
}

function parse(marked) {
    let text = '';
    let anchor = null;
    let head = null;
    for (const ch of marked) {
        if (ch === '|') anchor = head = text.length;
        else if (ch === '{') anchor = text.length;
        else if (ch === '}') head = text.length;
        else text += ch;
    }
    return { text, selection: { anchor, head } };
}

function show(text, { anchor, head }) {
    if (anchor === head) return text.slice(0, anchor) + '|' + text.slice(anchor);
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);
    return text.slice(0, from) + '{' + text.slice(from, to) + '}' + text.slice(to);
}

// Link tests use offsets: the selected URL is easier to read that way.
function runAt(command, text, anchor, head = anchor) {
    return format.apply(command, { text, selection: { anchor, head } });
}

const INLINE = [
    { command: 'bold', open: '**', close: '**', alt: '__' },
    { command: 'italic', open: '*', close: '*', alt: '_' },
    { command: 'strikethrough', open: '~~', close: '~~' },
    { command: 'code', open: '`', close: '`' },
];

for (const { command, open, close } of INLINE) {
    test(`${command} wraps a selection`, () => {
        assert.equal(run(command, 'say {hello} there'), `say ${open}{hello}${close} there`);
        // Spaces at the edges stay outside the markers.
        assert.equal(run(command, 'say{ hello }there'), `say ${open}{hello}${close} there`);
    });

    test(`${command} unwraps a selection already in it`, () => {
        assert.equal(run(command, `say ${open}{hello}${close} there`), 'say {hello} there');
        assert.equal(run(command, `say ${open}he{ll}o${close} there`), 'say he{ll}o there');
        // The markers themselves selected too.
        assert.equal(run(command, `say {${open}hello${close}} there`), 'say {hello} there');
    });

    test(`${command} on an empty selection in a word wraps the word`, () => {
        assert.equal(run(command, 'say hel|lo there'), `say ${open}hel|lo${close} there`);
        assert.equal(run(command, 'say |hello there'), `say ${open}|hello${close} there`);
        assert.equal(run(command, 'say hello| there'), `say ${open}hello|${close} there`);
        // ...and unwraps it again.
        assert.equal(run(command, `say ${open}hel|lo${close} there`), 'say hel|lo there');
    });

    test(`${command} on an empty selection off a word inserts the markers`, () => {
        assert.equal(run(command, 'say | there'), `say ${open}|${close} there`);
        assert.equal(run(command, '|'), `${open}|${close}`);
    });

    test(`${command} on several lines styles each line, and toggles back`, () => {
        const on = run(command, '{one\ntwo}\n');
        assert.equal(on, `${open}{one${close}\n${open}two}${close}\n`);
        assert.equal(run(command, on), '{one\ntwo}\n');
        // List and heading markers stay outside; blank lines are left alone.
        assert.equal(run(command, '{- one\n\n# two}'), `{- ${open}one${close}\n\n# ${open}two}${close}`);
        // Some lines already styled: the rest join them, nothing is doubled.
        assert.equal(run(command, `{${open}one${close}\ntwo}`), `{${open}one${close}\n${open}two}${close}`);
    });
}

test('bold and italic match the markers the document already uses', () => {
    assert.equal(run('bold', 'An __old__ one, a {new} one'), 'An __old__ one, a __{new}__ one');
    assert.equal(run('italic', 'An _old_ one, a {new} one'), 'An _old_ one, a _{new}_ one');
    assert.equal(run('italic', 'An *old* one, a {new} one'), 'An *old* one, a *{new}* one');
    // Defaults: ** and *.
    assert.equal(run('bold', 'a {new} one'), 'a **{new}** one');
    assert.equal(run('italic', 'a {new} one'), 'a *{new}* one');
    // Both kinds come off, whichever the document prefers.
    assert.equal(run('bold', 'An **old** one, a __n|ew__ one'), 'An **old** one, a n|ew one');
    assert.equal(run('italic', 'An *old* one, a _n|ew_ one'), 'An *old* one, a n|ew one');
});

test('the markers in a code block or code span are not the document\'s', () => {
    assert.equal(format.documentStyle('```\n_x_ and __y__\n* item\n```\n').italic, '*');
    assert.equal(format.documentStyle('Use `_x_` here').italic, '*');
    assert.deepEqual(format.documentStyle(''), { bold: '**', italic: '*', bullet: '-' });
    assert.deepEqual(format.documentStyle('* a\n\n_i_ and __b__'), { bold: '__', italic: '_', bullet: '*' });
    // A bullet isn't italic, and a rule isn't a bullet.
    assert.deepEqual(format.documentStyle('* * *\n\n+ one\n'), { bold: '**', italic: '*', bullet: '+' });
});

test('inline styles nest and leave other styles alone', () => {
    assert.equal(run('italic', '**bo|ld**'), '***bo|ld***');
    assert.equal(run('italic', '***bo|ld***'), '**bo|ld**');
    assert.equal(run('bold', '***bo|ld***'), '*bo|ld*');
    assert.equal(run('bold', '*bo|ld*'), '***bo|ld***');
    // Bold inside the selection is merged into the new bold rather than doubled.
    assert.equal(run('bold', '{a **b** c}'), '**{a b c}**');
});

test('inline styles never rewrite markers outside the selection', () => {
    const doc = '__keep__ this, *and* this\n\nchange {me}\n';
    const out = parse(run('bold', doc)).text;
    assert.equal(out, '__keep__ this, *and* this\n\nchange __me__\n');
});

test('strikethrough leaves a single-tilde subscript alone', () => {
    assert.equal(run('strikethrough', 'x ~s|ub~ y'), 'x ~~~s|ub~~~ y');
    assert.equal(run('strikethrough', 'x ~~~s|ub~~~ y'), 'x ~s|ub~ y');
});

test('emphasis pairs the way the editor reads it (CommonMark\'s rule of 3)', () => {
    assert.equal(run('bold', '*foo**b|ar**baz*'), '*foob|arbaz*');
    assert.equal(run('italic', '*foo**b|ar**baz*'), 'foo**b|ar**baz');
});

test('inline code picks markers its content can\'t close', () => {
    assert.equal(run('code', 'run {a`b}'), 'run ``{a`b}``');
    assert.equal(run('code', 'run {`a}'), 'run `` {`a} ``');
    assert.equal(run('code', 'x ``a`b|`` y'), 'x a`b| y');
});

test('escaped markers are text, not styles', () => {
    assert.equal(run('italic', 'a \\*b|c\\* d'), 'a \\**b|c*\\* d');
});

test('link wraps a selection and selects the url', () => {
    const out = runAt('link', 'see the docs now', 4, 12);
    assert.equal(out.text, 'see [the docs](url) now');
    assert.equal(out.text.slice(out.selection.anchor, out.selection.head), 'url');
});

test('link on an empty selection in a word links the word', () => {
    const out = runAt('link', 'see docs now', 6);
    assert.equal(out.text, 'see [docs](url) now');
    assert.equal(out.text.slice(out.selection.anchor, out.selection.head), 'url');
});

test('link off a word inserts an empty link with the cursor in its text', () => {
    const out = runAt('link', 'see  now', 4);
    assert.equal(out.text, 'see [](url) now');
    assert.deepEqual(out.selection, { anchor: 5, head: 5 });
});

test('link in an existing link selects its url', () => {
    const text = 'see [the docs](https://example.com "Title") now';
    const url = 'https://example.com';
    for (const at of [4, 8, 16, 30, text.indexOf(')') + 1]) {
        const out = runAt('link', text, at);
        assert.equal(out.text, text);
        assert.equal(out.text.slice(out.selection.anchor, out.selection.head), url, `cursor at ${at}`);
    }
    // An image's URL too.
    const image = runAt('link', '![alt](pic.png)', 3);
    assert.equal(image.text.slice(image.selection.anchor, image.selection.head), 'pic.png');
});

test('link with its url selected removes the link, keeping its text', () => {
    const text = 'see [the docs](url) now';
    const out = runAt('link', text, 15, 18);
    assert.equal(out.text, 'see the docs now');
    assert.equal(out.text.slice(out.selection.anchor, out.selection.head), 'the docs');
});

test('link reads a destination with balanced parentheses to its end', () => {
    const text = '[docs](https://en.wikipedia.org/wiki/Markdown_(markup_language)) x';
    const out = runAt('link', text, 2);
    assert.equal(out.text.slice(out.selection.anchor, out.selection.head), 'https://en.wikipedia.org/wiki/Markdown_(markup_language)');
    assert.equal(format.apply('link', out).text, 'docs x');
});

test('link in a reference link selects its label, then removes the link', () => {
    for (const [text, label, after] of [
        ['see [the docs][ref] now', 'ref', 'see the docs now'],
        ['see [the docs][] now', 'the docs', 'see the docs now'],
        ['see [docs] now', 'docs', 'see docs now'],
    ]) {
        const out = runAt('link', text, 7);
        assert.equal(out.text, text);
        assert.equal(out.text.slice(out.selection.anchor, out.selection.head), label, text);
        assert.equal(format.apply('link', out).text, after, text);
    }
    // A task's box isn't a link.
    assert.equal(runAt('link', '- [ ] task', 8).text, '- [ ] [task](url)');
});

test('link over several lines wraps the whole selection', () => {
    const out = runAt('link', 'one\ntwo', 0, 7);
    assert.equal(out.text, '[one\ntwo](url)');
    assert.equal(out.text.slice(out.selection.anchor, out.selection.head), 'url');
});

test('link leaves the rest of the document as it is', () => {
    const text = '[a](b) and c';
    const out = runAt('link', text, 11, 12);
    assert.equal(out.text, '[a](b) and [c](url)');
});

// ------------------------------------------------------------------
// Block styles
// ------------------------------------------------------------------

/** A line of text in each block style, and what it reads as. */
const STYLED = {
    paragraph: 'Te|xt',
    h1: '# Te|xt',
    h2: '## Te|xt',
    h3: '### Te|xt',
    quote: '> Te|xt',
    codeBlock: '```\nTe|xt\n```',
};

test('the block style menu switches between every pair of styles', () => {
    for (const [from, before] of Object.entries(STYLED)) {
        for (const to of format.BLOCK_STYLES) {
            const after = run(`block:${to}`, before);
            // Choosing the style a line already has turns it back into a paragraph.
            const expected = from === to && to !== 'paragraph' ? STYLED.paragraph : STYLED[to];
            assert.equal(after, expected, `${from} -> ${to}`);
            const parsed = parse(after);
            assert.equal(format.blockStyleAt(parsed.text, parsed.selection.head), from === to ? 'paragraph' : to, `${from} -> ${to}: read back`);
        }
    }
});

test('a heading replaces the heading marker rather than adding another', () => {
    assert.equal(run('block:h2', '# Ti|tle'), '## Ti|tle');
    assert.equal(run('block:h1', '###### Ti|tle'), '# Ti|tle');
    assert.equal(run('block:h3', '- # Ti|tle'), '- ### Ti|tle');
});

test('block styles apply to every line the selection touches', () => {
    assert.equal(run('block:h2', '{one\n# two\nthree}'), '## {one\n## two\n## three}');
    // A selection that ends at the start of a line leaves that line alone.
    assert.equal(run('block:h1', '{one\n}two'), '# {one\n}two');
    assert.equal(run('block:quote', '{one\n\ntwo}\n\nthree'), '> {one\n>\n> two}\n\nthree');
    assert.equal(run('block:quote', '> {one\n>\n> two}'), '{one\n\ntwo}');
    assert.equal(run('block:paragraph', '{# one\n> two}'), '{one\ntwo}');
    assert.equal(run('block:codeBlock', 'a\n{b\nc}\nd'), 'a\n```\n{b\nc}\n```\nd');
});

test('a mix of styles takes the one chosen, rather than toggling it off', () => {
    assert.equal(run('block:h1', '{# one\ntwo}'), '{# one\n# two}');
    assert.equal(run('block:quote', '{> one\ntwo}'), '{> one\n> two}');
});

test('a code block keeps its code as it is, and takes in the code blocks it touches', () => {
    assert.equal(run('block:codeBlock', '# He|ading'), '```\nHe|ading\n```');
    assert.equal(run('block:codeBlock', '{intro\n```js\nx}\n```'), '```\n{intro\nx}\n```');
    // Back to paragraphs: the fences go, the lines inside are left as they are.
    assert.equal(run('block:paragraph', '~~~\n# not| a heading\n~~~\nafter'), '# not| a heading\nafter');
    // A cursor on a fence counts as in the block.
    assert.equal(run('block:codeBlock', '`|``\ncode\n```'), '|code');
    assert.equal(run('block:codeBlock', '{```\nx\n```}'), '{x}');
    assert.equal(format.blockStyleAt('```\nx\n```', 0), 'codeBlock');
});

test('a setext heading reads as a heading, and loses its underline', () => {
    assert.equal(format.blockStyleAt('Title\n=====', 2), 'h1');
    assert.equal(format.blockStyleAt('Title\n-----', 8), 'h2');
    assert.equal(run('block:paragraph', 'Ti|tle\n====='), 'Ti|tle');
    assert.equal(run('block:h1', 'Ti|tle\n====='), 'Ti|tle');
    assert.equal(run('block:h1', '{Title\n=====}\n\nnext'), '{Title}\n\nnext');
    assert.equal(run('block:h2', 'Title\n==|==='), '## Title|');
    assert.equal(run('block:h1', 'Ti|tle\n-----'), '# Ti|tle');
    assert.equal(run('block:quote', 'Ti|tle\n-----\nafter'), '> Ti|tle\nafter');
    // A rule after a blank line is no underline.
    assert.equal(format.blockStyleAt('Text\n\n---', 0), 'paragraph');
});

test('indented code reads as a code block, and is dedented out of it', () => {
    assert.equal(format.blockStyleAt('    code', 6), 'codeBlock');
    assert.equal(run('block:codeBlock', '    co|de'), 'co|de');
    assert.equal(run('block:paragraph', 'a\n\n    co|de\n\n    more\n\nb'), 'a\n\nco|de\n\nmore\n\nb');
    assert.equal(run('block:h2', '    co|de\n    more'), '## co|de\nmore');
    assert.equal(run('block:quote', '\tco|de'), '> co|de');
    // Not after a paragraph, nor in a list: there it's the paragraph's or the item's.
    assert.equal(format.blockStyleAt('para\n    cont', 8), 'paragraph');
    assert.equal(format.blockStyleAt('- a\n\n    cont', 9), 'paragraph');
    assert.equal(run('block:codeBlock', 'para\n    co|nt'), 'para\n```\n    co|nt\n```');
});

test('a code block in a quote or a list item is one code block', () => {
    assert.equal(format.blockStyleAt('> ```\n> code\n> ```', 9), 'codeBlock');
    assert.equal(run('block:codeBlock', '> ```\n> co|de\n> ```'), 'co|de');
    assert.equal(run('block:paragraph', '> ```\n> co|de\n> ```'), 'co|de');
    assert.equal(run('block:quote', '> ```\n> co|de\n> ```'), '> co|de');
    // The quote ends the block when it isn't closed first.
    assert.equal(run('block:codeBlock', '> ```\n> co|de\nafter'), 'co|de\nafter');
    // In a list item, the item stays.
    assert.equal(format.blockStyleAt('- ```\n  code\n  ```', 9), 'codeBlock');
    assert.equal(run('block:codeBlock', '- ```\n  co|de\n  ```\n- b'), '-\n  co|de\n- b');
    assert.equal(run('block:h1', '- ```\n  co|de\n  ```'), '-\n  # co|de');
});

test('block styles never rewrite markers outside the selection', () => {
    const doc = '# Keep\n\n* keep\n\nchange |me\n\n> keep\n';
    assert.equal(parse(run('block:h2', doc)).text, '# Keep\n\n* keep\n\n## change me\n\n> keep\n');
});

// ------------------------------------------------------------------
// Lists
// ------------------------------------------------------------------

const LISTS = {
    bulletList: (n) => '- ',
    orderedList: (n) => `${n}. `,
    taskList: (n) => '- [ ] ',
};

for (const [command, marker] of Object.entries(LISTS)) {
    test(`${command} turns lines into a list, and the same list off again`, () => {
        assert.equal(run(command, 'it|em'), `${marker(1)}it|em`);
        assert.equal(run(command, `${marker(1)}it|em`), 'it|em');
        const on = run(command, '{one\ntwo\n\nthree}');
        assert.equal(on, `${marker(1)}{one\n${marker(2)}two\n\n${marker(3)}three}`);
        assert.equal(run(command, on), '{one\ntwo\n\nthree}');
    });

    test(`${command} on an empty line starts a list item`, () => {
        assert.equal(run(command, 'a\n|\nb'), `a\n${marker(1)}|\nb`);
    });
}

test('a list switches to another kind rather than stacking', () => {
    assert.equal(run('orderedList', '{- one\n- two}'), '{1. one\n2. two}');
    assert.equal(run('bulletList', '{1. one\n2. two}'), '{- one\n- two}');
    assert.equal(run('taskList', '{1. one\n- two}'), '{- [ ] one\n- [ ] two}');
    assert.equal(run('bulletList', '{- [x] one\n- [ ] two}'), '{- one\n- two}');
    // A mix including the chosen kind becomes all of that kind.
    assert.equal(run('bulletList', '{- one\ntwo}'), '{- one\n- two}');
});

test('numbered lists count from 1, per level', () => {
    assert.equal(run('orderedList', '{a\n  b\n  c\nd}'), '1. {a\n  1. b\n  2. c\n2. d}');
    assert.equal(run('orderedList', '{7. a\n- b}'), '{1. a\n2. b}');
});

test('lists match the bullet the document already uses', () => {
    assert.equal(run('bulletList', '* old\n\n{new}'), '* old\n\n* {new}');
    assert.equal(run('taskList', '+ old\n\n{new}'), '+ old\n\n+ [ ] {new}');
    // A task keeps its own bullet, and whether it's done.
    assert.equal(run('taskList', '{* x\n- [x] y}'), '{* [ ] x\n- [x] y}');
});

test('lists keep indents and quotes, and skip code', () => {
    assert.equal(run('bulletList', '{> one\n> two}'), '{> - one\n> - two}');
    assert.equal(run('bulletList', '{a\n```\ncode\n```\nb}'), '- {a\n```\ncode\n```\n- b}');
    // A rule isn't a list.
    assert.equal(run('bulletList', '* * |*'), '- * * |*');
});

test('lists never rewrite markers outside the selection', () => {
    const doc = '* keep\n* keep\n\n{one\ntwo}\n\n1. keep\n';
    assert.equal(parse(run('orderedList', doc)).text, '* keep\n* keep\n\n1. one\n2. two\n\n1. keep\n');
});

test('selections keep their direction', () => {
    const out = format.apply('bold', { text: 'a word b', selection: { anchor: 6, head: 2 } });
    assert.equal(out.text, 'a **word** b');
    assert.deepEqual(out.selection, { anchor: 8, head: 4 });
});

test('every command keeps the text outside what it changed', () => {
    const doc = '# Title\n\nSome *text* with **bold**.\n\n- a\n- b\n\n```\ncode\n```\n';
    const commands = [...format.COMMANDS, ...format.BLOCK_STYLES.map(style => `block:${style}`)];
    for (const command of commands) {
        for (let at = 0; at <= doc.length; at += 3) {
            const out = format.apply(command, { text: doc, selection: { anchor: at, head: Math.min(doc.length, at + 4) } });
            assert.equal(typeof out.text, 'string');
            assert.ok(out.selection.anchor >= 0 && out.selection.anchor <= out.text.length, `${command} at ${at}`);
            assert.ok(out.selection.head >= 0 && out.selection.head <= out.text.length, `${command} at ${at}`);
            // The first and last lines are only touched when the selection is on them.
            if (at > 8) assert.ok(out.text.startsWith('# Title\n'), `${command} at ${at}`);
            if (at + 4 < doc.length - 12) assert.ok(out.text.endsWith('```\ncode\n```\n'), `${command} at ${at}`);
        }
    }
});

// ------------------------------------------------------------------
// Shortcuts
// ------------------------------------------------------------------

function key(init) {
    return { key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init };
}

test('⌘/ where / is Shift+7 is also ⌘⇧7: app.js asks editorShortcut first', () => {
    const core = require('../js/core.js');
    const slash = key({ key: '/', code: 'Digit7', shiftKey: true, metaKey: true });
    assert.equal(core.editorShortcut(slash, true), 'mode');
    assert.equal(format.shortcutCommand(slash, true), 'orderedList');
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../js/app.js'), 'utf8');
    const handler = source.slice(source.indexOf('function onEditShortcut'));
    assert.ok(handler.indexOf('core.editorShortcut(') < handler.indexOf('shortcutCommand('), 'the mode switch is resolved first');
    assert.match(handler, /action !== 'mode' && editing && window\.MarkyFormat/);
});

test('shortcutCommand reads ⌘ on a Mac and Ctrl elsewhere', () => {
    assert.equal(format.shortcutCommand(key({ key: 'b', code: 'KeyB', metaKey: true }), true), 'bold');
    assert.equal(format.shortcutCommand(key({ key: 'b', code: 'KeyB', ctrlKey: true }), false), 'bold');
    assert.equal(format.shortcutCommand(key({ key: 'b', code: 'KeyB', ctrlKey: true }), true), null);
    assert.equal(format.shortcutCommand(key({ key: 'b', code: 'KeyB', metaKey: true }), false), null);
    assert.equal(format.shortcutCommand(key({ key: 'i', code: 'KeyI', metaKey: true }), true), 'italic');
    assert.equal(format.shortcutCommand(key({ key: 'k', code: 'KeyK', metaKey: true }), true), 'link');
    assert.equal(format.shortcutCommand(key({ key: 'x', code: 'KeyX', metaKey: true }), true), null);
    assert.equal(format.shortcutCommand(key({ key: 'b' }), true), null);
});

test('shortcutCommand reads digits from the key pressed, whatever ⇧ and ⌥ type', () => {
    const mac = (init) => format.shortcutCommand(key({ metaKey: true, ...init }), true);
    assert.equal(mac({ key: '*', code: 'Digit8', shiftKey: true }), 'bulletList');
    assert.equal(mac({ key: '&', code: 'Digit7', shiftKey: true }), 'orderedList');
    assert.equal(mac({ key: '(', code: 'Digit9', shiftKey: true }), 'taskList');
    assert.equal(mac({ key: 'X', code: 'KeyX', shiftKey: true }), 'strikethrough');
    assert.equal(mac({ key: 'C', code: 'KeyC', shiftKey: true }), 'code');
    assert.equal(mac({ key: 'º', code: 'Digit0', altKey: true }), 'block:paragraph');
    assert.equal(mac({ key: '¡', code: 'Digit1', altKey: true }), 'block:h1');
    assert.equal(mac({ key: '™', code: 'Digit2', altKey: true }), 'block:h2');
    assert.equal(mac({ key: '£', code: 'Digit3', altKey: true }), 'block:h3');
    assert.equal(mac({ key: '¢', code: 'Digit4', altKey: true }), null);
    // No code (some virtual keyboards): the key itself.
    assert.equal(mac({ key: '2', altKey: true }), 'block:h2');
    // ⌘S, ⌘E and the rest belong to someone else.
    assert.equal(mac({ key: 's', code: 'KeyS' }), null);
    assert.equal(mac({ key: 'e', code: 'KeyE' }), null);
});

test('shortcutCommand leaves AltGr alone', () => {
    const altGr = key({ key: '{', code: 'Digit2', ctrlKey: true, altKey: true, getModifierState: (k) => k === 'AltGraph' });
    assert.equal(format.shortcutCommand(altGr, false), null);
    const ctrlAlt = key({ key: '2', code: 'Digit2', ctrlKey: true, altKey: true, getModifierState: () => false });
    assert.equal(format.shortcutCommand(ctrlAlt, false), 'block:h2');
});

test('shortcutLabel spells each shortcut for tooltips', () => {
    assert.equal(format.shortcutLabel('bold', true), '⌘B');
    assert.equal(format.shortcutLabel('bold', false), 'Ctrl+B');
    assert.equal(format.shortcutLabel('strikethrough', true), '⌘⇧X');
    assert.equal(format.shortcutLabel('block:h2', true), '⌘⌥2');
    assert.equal(format.shortcutLabel('block:h2', false), 'Ctrl+Alt+2');
    assert.equal(format.shortcutLabel('taskList', false), 'Ctrl+Shift+9');
    assert.equal(format.shortcutLabel('block:quote', true), '');
    assert.equal(format.ariaKeyShortcuts('strikethrough', true), 'Meta+Shift+X');
    assert.equal(format.ariaKeyShortcuts('block:h2', false), 'Control+Alt+2');
    assert.equal(format.ariaKeyShortcuts('block:codeBlock', false), '');
});

test('every shortcut label reads back as its command', () => {
    for (const command of Object.keys({ ...LISTS, bold: 1, italic: 1, strikethrough: 1, code: 1, link: 1, 'block:paragraph': 1, 'block:h1': 1, 'block:h2': 1, 'block:h3': 1 })) {
        const label = format.shortcutLabel(command, false);
        const parts = label.split('+');
        const k = parts[parts.length - 1];
        const event = key({
            key: k.toLowerCase(),
            code: /\d/.test(k) ? `Digit${k}` : `Key${k}`,
            ctrlKey: true,
            altKey: parts.includes('Alt'),
            shiftKey: parts.includes('Shift'),
        });
        assert.equal(format.shortcutCommand(event, false), command, label);
    }
});
