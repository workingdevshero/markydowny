// The editor behind Edit, bundled by scripts/vendor.mjs into js/vendor/codemirror.js, which
// exposes this module as window.MarkyCodeMirror. CodeMirror ships only as ES modules, and the
// site has no build step, so the bundle is checked in like marked.umd.js. app.js loads it the
// first time a document is edited.
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';

// Colours come from the page's own variables, so the editor follows prefers-color-scheme
// exactly as the rendered view does.
const theme = EditorView.theme({
    '&': {
        color: 'var(--text)',
        backgroundColor: 'transparent',
        fontSize: 'inherit',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
        fontFamily: 'var(--font-sans)',
        lineHeight: 'inherit',
    },
    '.cm-content': {
        padding: '0',
        caretColor: 'var(--text)',
    },
    '.cm-line': { padding: '0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
    '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
        backgroundColor: 'color-mix(in srgb, var(--accent) 24%, transparent)',
    },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
        backgroundColor: 'var(--accent-soft)',
        outline: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)',
    },
});

const highlight = HighlightStyle.define([
    { tag: tags.heading1, fontSize: '1.6em', fontWeight: '700', letterSpacing: '-0.02em' },
    { tag: tags.heading2, fontSize: '1.3em', fontWeight: '700', letterSpacing: '-0.015em' },
    { tag: tags.heading3, fontSize: '1.12em', fontWeight: '700' },
    { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: '700' },
    { tag: tags.strong, fontWeight: '650' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: [tags.link, tags.url], color: 'var(--accent)' },
    { tag: tags.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.9em' },
    { tag: tags.quote, color: 'var(--text-muted)' },
    // The markup itself: #, *, ``` fences, list bullets, link brackets.
    { tag: [tags.processingInstruction, tags.contentSeparator, tags.meta], color: 'var(--text-muted)' },
    { tag: [tags.angleBracket, tags.tagName, tags.attributeName], color: 'var(--coral)' },
    { tag: tags.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
]);

/**
 * An editor for `doc` in `parent`. options: { lineSeparator, onChange(update), onUpdate(update),
 * topInset() }: lineSeparator is kept for every line break, so the text reads back with the file's
 * own line endings; onChange runs after each change to the text, onUpdate after anything that
 * can change the formatting at the cursor (the text, the selection, or more of the document
 * parsed); topInset is how much of the window's top is covered (sticky bars), which scrolling
 * the cursor into view stays clear of.
 */
export function createEditor(parent, doc, options = {}) {
    return new EditorView({ state: createState(doc, options), parent });
}

/** The editor's state for `doc`, with the options createEditor takes (no view needed). */
export function createState(doc, { lineSeparator = '\n', onChange = () => {}, onUpdate = () => {}, topInset = () => 0 } = {}) {
    return EditorState.create({
        doc,
        extensions: [
            EditorState.lineSeparator.of(lineSeparator),
            history(),
            drawSelection(),
            dropCursor(),
            indentOnInput(),
            bracketMatching(),
            EditorView.lineWrapping,
            markdown({ base: markdownLanguage }),
            syntaxHighlighting(highlight),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            theme,
            EditorView.contentAttributes.of({ 'aria-label': 'Markdown source', spellcheck: 'true' }),
            EditorView.scrollMargins.of(() => ({ top: topInset() })),
            EditorView.updateListener.of(update => {
                if (update.docChanged) onChange(update);
                if (update.docChanged || update.selectionSet || syntaxTree(update.state) !== syntaxTree(update.startState)) {
                    onUpdate(update);
                }
            }),
        ],
    });
}

const INLINE_NODES = {
    StrongEmphasis: 'bold',
    Emphasis: 'italic',
    Strikethrough: 'strikethrough',
    InlineCode: 'code',
    Link: 'link',
};

/** The syntax nodes around `pos`, innermost first, looking at the character on `side`. */
function nodesAt(state, pos, side) {
    const nodes = [];
    for (let node = syntaxTree(state).resolveInner(pos, side); node; node = node.parent) nodes.push(node);
    return nodes;
}

function inlineStyles(state, pos, side) {
    return new Set(nodesAt(state, pos, side).map(node => INLINE_NODES[node.name]).filter(Boolean));
}

/**
 * The formatting at the selection, from the markdown syntax tree:
 * { bold, italic, strikethrough, code, link (booleans), block: 'paragraph' | 'h1'-'h6' |
 *   'quote' | 'codeBlock', list: 'bullet' | 'ordered' | 'task' | null }.
 * An inline style counts when the whole selection is in it; a cursor counts on either side of
 * it, as the toolbar's commands do. The block and list are the selection head's.
 */
export function formatState(state) {
    const { from, to, head } = state.selection.main;
    let styles;
    if (from === to) {
        styles = new Set([...inlineStyles(state, from, -1), ...inlineStyles(state, from, 1)]);
    } else {
        const end = inlineStyles(state, to, -1);
        styles = new Set([...inlineStyles(state, from, 1)].filter(style => end.has(style)));
    }
    // Inside the head's line: at its start, the character after; anywhere else, the one before.
    const line = state.doc.lineAt(head);
    const nodes = nodesAt(state, head, head === line.from ? 1 : -1);
    const has = (name) => nodes.some(node => node.name === name);
    let block = 'paragraph';
    if (has('FencedCode') || has('CodeBlock')) {
        block = 'codeBlock';
    } else if (has('Blockquote')) {
        block = 'quote';
    } else {
        const heading = nodes.find(node => /^(ATX|Setext)Heading\d$/.test(node.name));
        if (heading) block = 'h' + heading.name.slice(-1);
    }
    let list = null;
    const item = nodes.find(node => node.name === 'ListItem');
    if (item) {
        if (item.parent && item.parent.name === 'OrderedList') list = 'ordered';
        else list = item.getChild('Task') ? 'task' : 'bullet';
    }
    return {
        bold: styles.has('bold'),
        italic: styles.has('italic'),
        strikethrough: styles.has('strikethrough'),
        code: styles.has('code'),
        link: styles.has('link'),
        block,
        list,
    };
}

export { EditorView, Transaction };
