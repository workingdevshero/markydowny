// The editor behind Edit, bundled by scripts/vendor.mjs into js/vendor/codemirror.js, which
// exposes this module as window.MarkyCodeMirror. CodeMirror ships only as ES modules, and the
// site has no build step, so the bundle is checked in like marked.umd.js. app.js loads it the
// first time a document is edited.
import { Compartment, EditorState, Facet, StateField, Transaction } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, drawSelection, dropCursor, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undoDepth } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
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
    // Find and replace. '&.cm-editor' outweighs the light/dark defaults of CodeMirror's base
    // theme ('.cm-light .cm-panels' and so on), which would otherwise paint it grey on white.
    '&.cm-editor .cm-panels': {
        backgroundColor: 'var(--surface)',
        color: 'var(--text)',
        fontFamily: 'var(--font-sans)',
    },
    '&.cm-editor .cm-panels-bottom': {
        borderTop: '1px solid var(--border)',
        boxShadow: '0 -8px 24px color-mix(in srgb, var(--text) 6%, transparent)',
    },
    '&.cm-editor .cm-panels-top': { borderBottom: '1px solid var(--border)' },
    '.cm-panel.cm-search': {
        padding: '10px 36px 10px 0',
        fontSize: '0.9rem',
        lineHeight: '1.4',
    },
    '.cm-panel.cm-search label': {
        fontSize: '0.85rem',
        color: 'var(--text-muted)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
    },
    '.cm-panel.cm-search input[type=checkbox]': { accentColor: 'var(--accent)', margin: '0' },
    '&.cm-editor .cm-textfield': {
        font: 'inherit',
        fontSize: '0.9rem',
        color: 'var(--text)',
        backgroundColor: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        padding: '5px 10px',
        minWidth: '12em',
        '&:focus': {
            outline: 'none',
            borderColor: 'var(--accent)',
            boxShadow: '0 0 0 3px var(--accent-soft)',
        },
    },
    '&.cm-editor .cm-button': {
        font: 'inherit',
        fontSize: '0.85rem',
        fontWeight: '600',
        color: 'var(--text-muted)',
        backgroundColor: 'transparent',
        backgroundImage: 'none',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        padding: '5px 12px',
        cursor: 'pointer',
        '&:hover': { color: 'var(--text)', backgroundColor: 'var(--surface-2)' },
        '&:active': { backgroundImage: 'none', backgroundColor: 'var(--accent-soft)' },
    },
    '.cm-panel.cm-search [name=close]': {
        top: '8px',
        right: '6px',
        width: '28px',
        height: '28px',
        borderRadius: '8px',
        fontSize: '20px',
        lineHeight: '1',
        color: 'var(--text-muted)',
        cursor: 'pointer',
        '&:hover': { color: 'var(--text)', backgroundColor: 'var(--surface-2)' },
    },
    '&.cm-editor .cm-searchMatch': {
        backgroundColor: 'color-mix(in srgb, var(--coral) 28%, transparent)',
        borderRadius: '2px',
    },
    '&.cm-editor .cm-searchMatch-selected, &.cm-editor .cm-searchMatch-selected *': {
        backgroundColor: 'color-mix(in srgb, var(--coral) 60%, transparent)',
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

// Rich mode styles the markup through classes (index.html styles them like the rendered view),
// so it highlights without the heading sizes, which would compound with the heading lines'.
const richHighlight = HighlightStyle.define([
    { tag: tags.strong, fontWeight: '650' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: tags.url, color: 'var(--accent)' },
    { tag: tags.monospace, fontFamily: 'var(--font-mono)' },
    { tag: [tags.processingInstruction, tags.contentSeparator, tags.meta], color: 'var(--text-muted)' },
    { tag: [tags.angleBracket, tags.tagName, tags.attributeName], color: 'var(--coral)' },
    { tag: tags.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
]);

/**
 * An editor for `doc` in `parent`. options: { lineSeparator, onChange(update), onSelect(update),
 * onUpdate(update), topInset(), mode, isMac, resolveImage(src), openLink(href),
 * renderInline(markdown) }: lineSeparator is kept for every line break, so the text reads back
 * with the file's own line endings; onChange runs after each change to the text, onSelect after
 * each change to the selection alone, onUpdate after anything that can change the formatting at
 * the cursor (the text, the selection, or more of the document parsed); topInset is how much of
 * the window's top is covered (sticky bars), which scrolling the cursor into view stays clear of.
 * mode is 'rich' or 'markdown' (setMode switches it); the rest is for Rich mode: resolveImage
 * gives an image's URL (or a promise of it), openLink opens a link ⌘-clicked (Ctrl-clicked off a
 * Mac), renderInline renders a table cell's markdown as HTML.
 */
export function createEditor(parent, doc, options = {}) {
    return new EditorView({ state: createState(doc, options), parent });
}

/** The editor's state for `doc`, with the options createEditor takes (no view needed). */
export function createState(doc, options = {}) {
    const { lineSeparator = '\n', onChange = () => {}, onSelect = () => {}, onUpdate = () => {}, topInset = () => 0, mode = 'markdown' } = options;
    return EditorState.create({
        doc,
        extensions: [
            editorOptions.of(options),
            EditorState.lineSeparator.of(lineSeparator),
            history(),
            drawSelection(),
            dropCursor(),
            indentOnInput(),
            bracketMatching(),
            EditorView.lineWrapping,
            markdown({ base: markdownLanguage }),
            modeCompartment.of(modeExtension(mode, options)),
            search(),
            keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap]),
            theme,
            EditorView.contentAttributes.of({ 'aria-label': 'Markdown source', spellcheck: 'true' }),
            EditorView.scrollMargins.of(() => ({ top: topInset() })),
            EditorView.updateListener.of(update => {
                if (update.docChanged) onChange(update);
                else if (update.selectionSet) onSelect(update);
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
 * it, as the toolbar's commands do. The block and list are those of the selection head's line.
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
    // The head's line, read at its last character: the line's indent and quote or list markers
    // can sit outside the block they open (a code block starts after its indent). A blank line
    // is read at its start, from the character after.
    const line = state.doc.lineAt(head);
    const end = line.from + line.text.trimEnd().length;
    const nodes = end > line.from ? nodesAt(state, end, -1) : nodesAt(state, line.from, 1);
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

// ------------------------------------------------------------------
// Rich mode: the same document, with the markup styled and its markers hidden off the lines
// that have a cursor or selection. Switching modes reconfigures one compartment, so the text,
// selection and undo history are untouched.
// ------------------------------------------------------------------

const modeCompartment = new Compartment();
const editorOptions = Facet.define({ combine: values => values[0] || {} });

function modeExtension(mode, options) {
    return mode === 'rich' ? richMode(options) : syntaxHighlighting(highlight);
}

/** Switches `view` to 'rich' or 'markdown'. */
export function setMode(view, mode) {
    view.dispatch({ effects: modeCompartment.reconfigure(modeExtension(mode, view.state.facet(editorOptions))) });
}

/** Whether a line (by number) has a cursor or selection on it. */
function activeLines(state) {
    const spans = state.selection.ranges.map(r => [state.doc.lineAt(r.from).number, state.doc.lineAt(r.to).number]);
    return (pos) => {
        const n = state.doc.lineAt(pos).number;
        return spans.some(([first, last]) => n >= first && n <= last);
    };
}

const LINK_PARENTS = new Set(['Link', 'Image', 'Autolink', 'LinkReference']);

/** The label a link reference definition is matched by. */
function normalizeLabel(label) {
    return label.slice(1, -1).trim().replace(/\s+/g, ' ').toLowerCase();
}

// Blocks that can hold other blocks (tables, headings, link reference definitions).
const BLOCK_CONTAINERS = new Set(['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem']);

/** The URL of a [text][label] or [label] link, from its definition (if parsed). */
function referenceUrl(state, label) {
    const wanted = normalizeLabel(label);
    let found = null;
    syntaxTree(state).iterate({
        enter(ref) {
            if (found !== null) return false;
            if (ref.name !== 'LinkReference') return BLOCK_CONTAINERS.has(ref.name);
            const name = ref.node.getChild('LinkLabel');
            const url = ref.node.getChild('URL');
            if (name && url && normalizeLabel(state.sliceDoc(name.from, name.to)) === wanted) found = state.sliceDoc(url.from, url.to);
            return false;
        },
    });
    return found;
}

function linkHref(state, node, marks) {
    const url = node.getChild('URL');
    if (url) return state.sliceDoc(url.from, url.to).replace(/^<|>$/g, '');
    const label = node.getChild('LinkLabel');
    // [text][label]; [label][] and [label] on their own use the text.
    if (label && normalizeLabel(state.sliceDoc(label.from, label.to))) return referenceUrl(state, state.sliceDoc(label.from, label.to));
    if (marks.length >= 2) return referenceUrl(state, state.sliceDoc(marks[0].from, marks[1].to));
    return null;
}

/** An autolink's target as the rendered view has it: www. gets http://, an email mailto:. */
function autolinkHref(text) {
    if (/^www\./i.test(text)) return `http://${text}`;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(text) && text.includes('@')) return `mailto:${text}`;
    return text;
}

const BULLETS = ['•', '◦', '▪'];

/**
 * What Rich mode draws over `ranges` of the document (all of it by default), as plain data:
 *   { kind: 'hide', from, to }                     markup hidden
 *   { kind: 'replace', from, to, widget }          markup drawn as a widget
 *   { kind: 'widget', from, widget }               a widget inserted after `from`
 *   { kind: 'mark', from, to, className, href? }   styled text (href: a link's target)
 *   { kind: 'line', from, className }              a styled line (from: the line's start)
 * Widgets are { type: 'bullet', text } | { type: 'task', checked } | { type: 'image', src, alt }
 * | { type: 'hr' } | { type: 'codeLabel', lang }. Tables off the cursor are richTables'.
 */
export function richDecorations(state, ranges = [{ from: 0, to: state.doc.length }]) {
    const doc = state.doc;
    const active = activeLines(state);
    const out = [];
    const seen = new Set();
    const add = (spec) => {
        // An empty mark (a link with no text) would throw when the decorations are built.
        if (spec.kind === 'mark' && !(spec.to > spec.from)) return;
        const key = `${spec.kind}:${spec.from}:${spec.to}:${spec.className || ''}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(spec);
    };
    // Hidden markup never crosses a line break (a plugin's decorations can't).
    const hide = (from, to) => {
        if (to > from && doc.lineAt(from).number === doc.lineAt(to).number) add({ kind: 'hide', from, to });
    };
    const replace = (from, to, widget) => {
        if (to > from && doc.lineAt(from).number === doc.lineAt(to).number) add({ kind: 'replace', from, to, widget });
    };
    const lines = (from, to, className, rangeFrom, rangeTo, ends = false) => {
        const first = doc.lineAt(Math.max(from, rangeFrom)).number;
        const last = doc.lineAt(Math.min(to, rangeTo)).number;
        const top = doc.lineAt(from).number;
        const bottom = doc.lineAt(to).number;
        for (let n = first; n <= last; n++) {
            let name = className;
            if (ends && n === top) name += ` ${className}-first`;
            if (ends && n === bottom) name += ` ${className}-last`;
            add({ kind: 'line', from: doc.line(n).from, className: name });
        }
    };
    const spaceAfter = (pos) => {
        const line = doc.lineAt(pos);
        let end = pos;
        while (end < line.to && (doc.sliceString(end, end + 1) === ' ' || doc.sliceString(end, end + 1) === '\t')) end++;
        return end;
    };
    const children = (node, name) => node.getChildren(name);

    for (const { from: rangeFrom, to: rangeTo } of ranges) {
        syntaxTree(state).iterate({
            from: rangeFrom,
            to: rangeTo,
            enter(ref) {
                const name = ref.name;
                const node = ref.node;
                const heading = /^ATXHeading(\d)$/.exec(name);
                if (heading) {
                    add({ kind: 'line', from: doc.lineAt(ref.from).from, className: `cm-rich-h${heading[1]}` });
                    if (active(ref.from)) return;
                    const marks = children(node, 'HeaderMark');
                    marks.forEach((mark, i) => {
                        if (i === 0) {
                            hide(mark.from, spaceAfter(mark.to));
                        } else {
                            let start = mark.from;
                            while (start > ref.from && /[ \t]/.test(doc.sliceString(start - 1, start))) start--;
                            hide(start, mark.to);
                        }
                    });
                    return;
                }
                const setext = /^SetextHeading(\d)$/.exec(name);
                if (setext) {
                    const mark = node.getChild('HeaderMark');
                    const underline = mark ? doc.lineAt(mark.from).number : doc.lineAt(ref.to).number + 1;
                    for (let n = doc.lineAt(ref.from).number; n < underline; n++) {
                        add({ kind: 'line', from: doc.line(n).from, className: `cm-rich-h${setext[1]}` });
                    }
                    if (mark && !active(mark.from)) {
                        add({ kind: 'line', from: doc.lineAt(mark.from).from, className: 'cm-rich-setext-underline' });
                        hide(doc.lineAt(mark.from).from, doc.lineAt(mark.from).to);
                    }
                    return;
                }
                switch (name) {
                    case 'StrongEmphasis':
                    case 'Emphasis':
                    case 'Strikethrough':
                    case 'InlineCode': {
                        const style = { StrongEmphasis: 'strong', Emphasis: 'em', Strikethrough: 'strike', InlineCode: 'code' }[name];
                        add({ kind: 'mark', from: ref.from, to: ref.to, className: `cm-rich-${style}` });
                        const markName = { StrongEmphasis: 'EmphasisMark', Emphasis: 'EmphasisMark', Strikethrough: 'StrikethroughMark', InlineCode: 'CodeMark' }[name];
                        for (const mark of children(node, markName)) {
                            if (!active(mark.from)) hide(mark.from, mark.to);
                        }
                        return name !== 'InlineCode';
                    }
                    case 'Link': {
                        const marks = children(node, 'LinkMark');
                        if (marks.length < 2) return;
                        add({ kind: 'mark', from: marks[0].to, to: marks[1].from, className: 'cm-rich-link', href: linkHref(state, node, marks) });
                        if (!active(marks[0].from)) hide(marks[0].from, marks[0].to);
                        if (!active(marks[1].from)) hide(marks[1].from, ref.to);
                        return;
                    }
                    case 'Image': {
                        const marks = children(node, 'LinkMark');
                        const url = node.getChild('URL');
                        const src = url ? doc.sliceString(url.from, url.to).replace(/^<|>$/g, '') : linkHref(state, node, marks);
                        if (!active(ref.from)) add({ kind: 'mark', from: ref.from, to: ref.to, className: 'cm-rich-image-source' });
                        if (src) {
                            const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : '';
                            add({ kind: 'widget', from: ref.to, widget: { type: 'image', src, alt } });
                        }
                        return false;
                    }
                    case 'Autolink': {
                        const url = node.getChild('URL');
                        if (!url) return false;
                        add({ kind: 'mark', from: url.from, to: url.to, className: 'cm-rich-link', href: autolinkHref(doc.sliceString(url.from, url.to)) });
                        if (!active(ref.from)) {
                            for (const mark of children(node, 'LinkMark')) hide(mark.from, mark.to);
                        }
                        return false;
                    }
                    case 'URL': {
                        if (node.parent && LINK_PARENTS.has(node.parent.name)) return;
                        add({ kind: 'mark', from: ref.from, to: ref.to, className: 'cm-rich-link', href: autolinkHref(doc.sliceString(ref.from, ref.to)) });
                        return;
                    }
                    case 'ListMark': {
                        if (active(ref.from)) return;
                        const item = node.parent;
                        const task = item && item.getChild('Task');
                        const marker = task && task.getChild('TaskMarker');
                        if (marker) {
                            hide(ref.from, marker.from);
                        } else if (item && item.parent && item.parent.name === 'BulletList') {
                            let depth = 0;
                            for (let p = item.parent; p; p = p.parent) if (p.name === 'BulletList') depth++;
                            replace(ref.from, ref.to, { type: 'bullet', text: BULLETS[Math.min(depth, BULLETS.length) - 1] });
                        } else {
                            add({ kind: 'mark', from: ref.from, to: ref.to, className: 'cm-rich-list-mark' });
                        }
                        return;
                    }
                    case 'TaskMarker': {
                        const checked = /x/i.test(doc.sliceString(ref.from, ref.to));
                        if (checked && node.parent) add({ kind: 'mark', from: ref.to, to: node.parent.to, className: 'cm-rich-task-done' });
                        if (!active(ref.from)) replace(ref.from, ref.to, { type: 'task', checked });
                        return;
                    }
                    case 'Blockquote':
                        lines(ref.from, ref.to, 'cm-rich-quote', rangeFrom, rangeTo);
                        return;
                    case 'QuoteMark':
                        if (!active(ref.from)) hide(ref.from, Math.min(spaceAfter(ref.to), ref.to + 1));
                        return;
                    case 'FencedCode': {
                        lines(ref.from, ref.to, 'cm-rich-codeblock', rangeFrom, rangeTo, true);
                        const marks = children(node, 'CodeMark');
                        const open = marks[0];
                        if (open && !active(open.from)) {
                            const info = node.getChild('CodeInfo');
                            replace(open.from, doc.lineAt(open.from).to, { type: 'codeLabel', lang: info ? doc.sliceString(info.from, info.to) : '' });
                        }
                        const close = marks.length > 1 ? marks[marks.length - 1] : null;
                        if (close && !active(close.from)) {
                            add({ kind: 'line', from: doc.lineAt(close.from).from, className: 'cm-rich-fence-hidden' });
                            hide(close.from, close.to);
                        }
                        return false;
                    }
                    case 'CodeBlock':
                        lines(ref.from, ref.to, 'cm-rich-codeblock', rangeFrom, rangeTo, true);
                        return false;
                    case 'HorizontalRule':
                        if (!active(ref.from)) replace(ref.from, ref.to, { type: 'hr' });
                        return false;
                    case 'Table': {
                        // Off the cursor it's drawn whole (richTables); on it, its markdown shows.
                        const from = doc.lineAt(ref.from).from;
                        const to = doc.lineAt(ref.to).to;
                        if (!state.selection.ranges.some(r => r.to >= from && r.from <= to)) return false;
                        lines(ref.from, ref.to, 'cm-rich-table-source', rangeFrom, rangeTo);
                        return;
                    }
                    case 'HTMLBlock':
                    case 'CommentBlock':
                    case 'ProcessingInstructionBlock':
                        return false;
                }
            },
        });
    }
    return out;
}

/** A table row's cells, as markdown: split at unescaped pipes, without the outer ones. */
function tableCells(text) {
    let row = text.trim();
    if (row.startsWith('|')) row = row.slice(1);
    if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
    return row.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}

/**
 * The document's tables: { from, to (their whole lines), active (a cursor or selection touches
 * it), align: [null | 'left' | 'center' | 'right'], header: [cell], rows: [[cell]] }, cells as
 * markdown.
 */
export function richTables(state) {
    const doc = state.doc;
    const tables = [];
    syntaxTree(state).iterate({
        enter(ref) {
            if (ref.name !== 'Table') return BLOCK_CONTAINERS.has(ref.name);
            const node = ref.node;
            const headerNode = node.getChild('TableHeader');
            const delimiter = node.getChildren('TableDelimiter').find(d => d.from > (headerNode ? headerNode.to : ref.from));
            const header = headerNode ? tableCells(doc.sliceString(headerNode.from, headerNode.to)) : [];
            const align = delimiter
                ? tableCells(doc.sliceString(delimiter.from, delimiter.to)).map(spec => {
                    const left = spec.startsWith(':');
                    const right = spec.endsWith(':');
                    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
                })
                : [];
            const rows = node.getChildren('TableRow').map(row => tableCells(doc.sliceString(row.from, row.to)));
            const from = doc.lineAt(ref.from).from;
            const to = doc.lineAt(ref.to).to;
            const active = state.selection.ranges.some(r => r.to >= from && r.from <= to);
            tables.push({ from, to, active, align, header, rows });
            return false;
        },
    });
    return tables;
}

/** The Table node around `pos` (looking at the characters on either side), or null. */
function tableNodeAt(state, pos) {
    for (const side of [-1, 1]) {
        for (let node = syntaxTree(state).resolveInner(pos, side); node; node = node.parent) {
            if (node.name === 'Table') return node;
        }
    }
    return null;
}

/**
 * A table's rows (header first, then the body; not the delimiter row) as their cells, read
 * from the syntax tree: [[{ from, to }]]. A cell runs from just after one pipe to the next;
 * the text before a row's first pipe and after its last is a cell only when there's some, as
 * the table parser counts them.
 */
function tableRows(state, table) {
    const rows = [];
    for (let row = table.firstChild; row; row = row.nextSibling) {
        if (row.name !== 'TableHeader' && row.name !== 'TableRow') continue;
        const cells = [];
        let start = row.from;
        const pipes = row.getChildren('TableDelimiter');
        const filled = (from, to) => state.sliceDoc(from, to).trim() !== '';
        pipes.forEach((pipe, i) => {
            if (i > 0 || filled(start, pipe.from)) cells.push({ from: start, to: pipe.from });
            start = pipe.to;
        });
        if (pipes.length === 0 || filled(start, row.to)) cells.push({ from: start, to: row.to });
        rows.push(cells);
    }
    return rows;
}

/** A cell's text selected (to type over), or with none, the cursor a space in from its pipe. */
function cellSelection(state, cell) {
    const text = state.sliceDoc(cell.from, cell.to);
    const from = cell.from + (text.length - text.trimStart().length);
    const to = cell.to - (text.length - text.trimEnd().length);
    if (from < to) return { anchor: from, head: to };
    const pos = Math.min(cell.from + 1, cell.to);
    return { anchor: pos, head: pos };
}

/**
 * Tab (direction 1) or Shift-Tab (-1) in a table: the transaction that moves to the next or
 * previous cell, or null outside a table. Tab in the last cell adds an empty row and moves
 * into it; Shift-Tab in the first cell stays there.
 */
export function tableCellMove(state, direction) {
    const { from, to } = state.selection.main;
    const table = tableNodeAt(state, direction > 0 ? to : from);
    if (!table) return null;
    const rows = tableRows(state, table);
    const cells = rows.flat();
    if (direction < 0) {
        const previous = cells.filter(cell => cell.to < from).pop();
        return { selection: previous ? cellSelection(state, previous) : state.selection.main, scrollIntoView: true, userEvent: 'select' };
    }
    const next = cells.find(cell => cell.from > to);
    if (next) return { selection: cellSelection(state, next), scrollIntoView: true, userEvent: 'select' };
    // A new row as wide as the header, under the last line (in the same quote, if any).
    const last = state.doc.lineAt(table.to);
    const prefix = state.sliceDoc(last.from, table.lastChild ? table.lastChild.from : last.from);
    const columns = Math.max(1, rows.length ? rows[0].length : 1);
    const row = prefix + '|' + '     |'.repeat(columns);
    const pos = last.to + 1 + prefix.length + 2;
    return {
        changes: { from: last.to, insert: state.lineBreak + row },
        selection: { anchor: pos, head: pos },
        scrollIntoView: true,
        userEvent: 'input',
    };
}

function moveCell(direction) {
    return (view) => {
        const spec = tableCellMove(view.state, direction);
        if (!spec) return false;
        view.dispatch(spec);
        return true;
    };
}

/** Toggles the task box `[ ]` / `[x]` at `pos` in `text`: the change, or null when there's none there. */
export function toggleTask(text, pos) {
    const marker = text.slice(pos, pos + 3);
    if (!/^\[[ xX]\]$/.test(marker)) return null;
    return { from: pos + 1, to: pos + 2, insert: marker[1] === ' ' ? 'x' : ' ' };
}

// What a rendered heading's textContent leaves out: markup, raw HTML tags, images.
const HEADING_DROPPED = new Set(['HeaderMark', 'QuoteMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LinkMark', 'LinkTitle', 'LinkLabel', 'HTMLTag', 'Comment', 'ProcessingInstruction', 'Image']);

/**
 * The document's headings, { from, level, text }, for #anchors: text as the rendered heading's
 * textContent reads, with entities (&amp;) passed through `decodeEntity`.
 */
export function headings(state, decodeEntity = (entity) => entity) {
    const out = [];
    syntaxTree(state).iterate({
        enter(ref) {
            const match = /^(?:ATX|Setext)Heading(\d)$/.exec(ref.name);
            if (!match) return BLOCK_CONTAINERS.has(ref.name);
            let text = '';
            let pos = ref.from;
            ref.node.toTree().iterate({
                enter(child) {
                    const from = ref.from + child.from;
                    let to = ref.from + child.to;
                    // Inside what was already dropped.
                    if (from < pos) return false;
                    let replacement;
                    if (child.name === 'Entity') {
                        replacement = decodeEntity(state.sliceDoc(from, to));
                    } else if (child.name === 'Escape') {
                        replacement = state.sliceDoc(from + 1, to);
                    } else if (child.name === 'URL' && child.node.parent && child.node.parent.name === 'Link') {
                        // A link's (url "title") goes as a whole.
                        replacement = '';
                        to = ref.from + child.node.parent.to;
                    } else if (HEADING_DROPPED.has(child.name)) {
                        replacement = '';
                    } else {
                        return;
                    }
                    text += state.sliceDoc(pos, from) + replacement;
                    pos = to;
                    return false;
                },
            });
            text += state.sliceDoc(pos, ref.to);
            out.push({ from: ref.from, level: Number(match[1]), text: text.trim() });
            return false;
        },
    });
    return out;
}

class BulletWidget extends WidgetType {
    constructor(text) {
        super();
        this.text = text;
    }
    eq(other) {
        return other.text === this.text;
    }
    toDOM() {
        const span = document.createElement('span');
        span.className = 'cm-rich-bullet';
        span.textContent = this.text;
        return span;
    }
}

class TaskWidget extends WidgetType {
    constructor(checked) {
        super();
        this.checked = checked;
    }
    eq(other) {
        return other.checked === this.checked;
    }
    toDOM(view) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'cm-rich-task';
        box.checked = this.checked;
        box.tabIndex = -1;
        box.setAttribute('aria-label', this.checked ? 'Done: mark as not done' : 'Mark as done');
        // Toggled on press, without moving the cursor (which would show the line's markup).
        box.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const pos = view.posAtDOM(box);
            const change = toggleTask(view.state.sliceDoc(pos, pos + 3), 0);
            if (change) {
                view.dispatch({ changes: { from: pos + change.from, to: pos + change.to, insert: change.insert }, userEvent: 'input.toggle' });
            }
        });
        box.addEventListener('click', (e) => e.preventDefault());
        return box;
    }
    ignoreEvent() {
        return true;
    }
}

class ImageWidget extends WidgetType {
    constructor(src, alt, resolve) {
        super();
        this.src = src;
        this.alt = alt;
        this.resolve = resolve;
    }
    eq(other) {
        return other.src === this.src && other.alt === this.alt;
    }
    toDOM(view) {
        const wrap = document.createElement('span');
        wrap.className = 'cm-rich-image-wrap';
        const img = document.createElement('img');
        img.className = 'cm-rich-image';
        img.alt = this.alt;
        img.addEventListener('load', () => view.requestMeasure());
        img.addEventListener('error', () => {
            wrap.hidden = true;
            view.requestMeasure();
        });
        Promise.resolve(this.resolve ? this.resolve(this.src) : this.src).then(url => {
            if (url) img.src = url;
        }, () => {});
        wrap.appendChild(img);
        return wrap;
    }
}

class RuleWidget extends WidgetType {
    eq() {
        return true;
    }
    toDOM() {
        const span = document.createElement('span');
        span.className = 'cm-rich-hr';
        return span;
    }
}

class CodeLabelWidget extends WidgetType {
    constructor(lang) {
        super();
        this.lang = lang;
    }
    eq(other) {
        return other.lang === this.lang;
    }
    toDOM() {
        const span = document.createElement('span');
        span.className = 'cm-rich-code-label';
        span.textContent = this.lang;
        return span;
    }
}

class TableWidget extends WidgetType {
    constructor(table, renderInline) {
        super();
        this.table = table;
        this.key = JSON.stringify([table.align, table.header, table.rows]);
        this.renderInline = renderInline;
    }
    eq(other) {
        return other.key === this.key;
    }
    toDOM() {
        const wrap = document.createElement('div');
        wrap.className = 'cm-rich-table';
        const table = document.createElement('table');
        const fill = (el, markdown, i) => {
            if (this.renderInline) el.innerHTML = this.renderInline(markdown);
            else el.textContent = markdown;
            if (this.table.align[i]) el.style.textAlign = this.table.align[i];
        };
        const head = table.createTHead().insertRow();
        this.table.header.forEach((cell, i) => {
            const th = document.createElement('th');
            fill(th, cell, i);
            head.appendChild(th);
        });
        const body = table.createTBody();
        for (const row of this.table.rows) {
            const tr = body.insertRow();
            this.table.header.forEach((_, i) => fill(tr.insertCell(), row[i] || '', i));
        }
        // A click places the cursor in the table (showing its markdown); links in it don't navigate.
        table.addEventListener('click', (e) => e.preventDefault());
        wrap.appendChild(table);
        return wrap;
    }
    ignoreEvent() {
        return false;
    }
}

function widgetFor(spec, options) {
    switch (spec.type) {
        case 'bullet': return new BulletWidget(spec.text);
        case 'task': return new TaskWidget(spec.checked);
        case 'image': return new ImageWidget(spec.src, spec.alt, options.resolveImage);
        case 'hr': return new RuleWidget();
        default: return new CodeLabelWidget(spec.lang);
    }
}

function toDecorations(specs, options) {
    const hidden = Decoration.replace({});
    const decorations = specs.map(spec => {
        switch (spec.kind) {
            case 'hide': return hidden.range(spec.from, spec.to);
            case 'replace': return Decoration.replace({ widget: widgetFor(spec.widget, options) }).range(spec.from, spec.to);
            case 'widget': return Decoration.widget({ widget: widgetFor(spec.widget, options), side: 1 }).range(spec.from);
            case 'line': return Decoration.line({ class: spec.className }).range(spec.from);
            default: {
                const attributes = spec.href ? { 'data-href': spec.href, title: `${options.isMac ? '⌘' : 'Ctrl'}-click to open ${spec.href}` } : undefined;
                return Decoration.mark({ class: spec.className, attributes }).range(spec.from, spec.to);
            }
        }
    });
    return Decoration.set(decorations, true);
}

function richMode(options) {
    const plugin = ViewPlugin.fromClass(class {
        constructor(view) {
            this.decorations = toDecorations(richDecorations(view.state, view.visibleRanges), options);
        }
        update(update) {
            if (update.docChanged || update.viewportChanged || update.selectionSet || syntaxTree(update.state) !== syntaxTree(update.startState)) {
                this.decorations = toDecorations(richDecorations(update.state, update.view.visibleRanges), options);
            }
        }
    }, { decorations: plugin => plugin.decorations });

    // Tables replace whole lines, which only a state field may do. The tables are found again
    // when the text (or its parse) changes; a cursor move only redraws.
    const tableDecorations = (tables) => Decoration.set(tables.filter(table => !table.active).map(table =>
        Decoration.replace({ widget: new TableWidget(table, options.renderInline), block: true }).range(table.from, table.to)));
    const tableField = StateField.define({
        create(state) {
            const tables = richTables(state);
            return { tables, decorations: tableDecorations(tables) };
        },
        update(value, tr) {
            if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
                const tables = richTables(tr.state);
                return { tables, decorations: tableDecorations(tables) };
            }
            if (!tr.selection) return value;
            const ranges = tr.state.selection.ranges;
            const tables = value.tables.map(table => ({ ...table, active: ranges.some(r => r.to >= table.from && r.from <= table.to) }));
            if (tables.every((table, i) => table.active === value.tables[i].active)) return value;
            return { tables, decorations: tableDecorations(tables) };
        },
        provide: field => EditorView.decorations.from(field, value => value.decorations),
    });

    const links = EditorView.domEventHandlers({
        mousedown(event) {
            const modifier = options.isMac ? event.metaKey : event.ctrlKey;
            if (!modifier || event.button !== 0) return false;
            const link = event.target.closest && event.target.closest('.cm-rich-link[data-href]');
            if (!link) return false;
            event.preventDefault();
            if (options.openLink) options.openLink(link.getAttribute('data-href'));
            return true;
        },
    });

    // Tab and Shift-Tab move between a table's cells (elsewhere they're left to the browser).
    const cells = keymap.of([
        { key: 'Tab', run: moveCell(1) },
        { key: 'Shift-Tab', run: moveCell(-1) },
    ]);

    return [
        syntaxHighlighting(richHighlight),
        plugin,
        tableField,
        links,
        cells,
        EditorView.editorAttributes.of({ class: 'cm-rich' }),
    ];
}

export { EditorView, Transaction, openSearchPanel, undoDepth };
