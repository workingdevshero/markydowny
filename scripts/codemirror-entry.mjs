// The editor behind Edit, bundled by scripts/vendor.mjs into js/vendor/codemirror.js, which
// exposes this module as window.MarkyCodeMirror. CodeMirror ships only as ES modules, and the
// site has no build step, so the bundle is checked in like marked.umd.js. app.js loads it the
// first time a document is edited.
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
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
 * An editor for `doc` in `parent`. options: { lineSeparator, onChange(update) }: lineSeparator
 * is kept for every line break, so the text reads back with the file's own line endings;
 * onChange runs after each change to the text.
 */
export function createEditor(parent, doc, { lineSeparator = '\n', onChange = () => {} } = {}) {
    const state = EditorState.create({
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
            EditorView.updateListener.of(update => {
                if (update.docChanged) onChange(update);
            }),
        ],
    });
    return new EditorView({ state, parent });
}

export { EditorView, Transaction };
