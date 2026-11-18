/**
 * Markydowny formatting commands: the editor toolbar and its shortcuts.
 *
 * Every command is a pure function from { text, selection } to { text, selection }, where
 * `selection` is { anchor, head } (offsets in `text`, line breaks as '\n'). They edit the
 * markdown itself, so they work the same wherever the text is shown. Written as a classic
 * script like core.js: app.js loads it with the editor, and Node's tests require it.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.MarkyFormat = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    const INLINE = {
        bold: { kind: 'emphasis', chars: '*_', size: 2 },
        italic: { kind: 'emphasis', chars: '*_', size: 1 },
        strikethrough: { kind: 'emphasis', chars: '~', size: 2 },
        code: { kind: 'code' },
    };
    const BLOCK_STYLES = ['paragraph', 'h1', 'h2', 'h3', 'quote', 'codeBlock'];
    const LISTS = { bulletList: 'bullet', orderedList: 'ordered', taskList: 'task' };
    const COMMANDS = ['bold', 'italic', 'strikethrough', 'code', 'link', 'bulletList', 'orderedList', 'taskList'];

    const WORD = /[\p{L}\p{N}_'’]/u;
    const FENCE = /^ {0,3}(`{3,}|~{3,})/;
    // indent, quote markers, list marker (with a task box), heading marker, then the content.
    const LINE = /^([ \t]*)((?:>[ \t]?)*)((?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?(#{1,6}(?:[ \t]+|$))?/;

    // ------------------------------------------------------------------
    // Positions and edits
    // ------------------------------------------------------------------

    function range(selection) {
        return { from: Math.min(selection.anchor, selection.head), to: Math.max(selection.anchor, selection.head) };
    }

    /**
     * Applies non-overlapping edits { from, to, insert, stick } to `text`. `stick: 'after'`
     * moves a position at an insertion point past the inserted text (an opening marker);
     * otherwise it stays before it (a closing marker).
     */
    function applyEdits(text, edits) {
        const sorted = edits
            .map((edit, order) => ({ ...edit, order }))
            .sort((a, b) => a.from - b.from || a.to - b.to || a.order - b.order);
        let out = '';
        let at = 0;
        for (const edit of sorted) {
            out += text.slice(at, edit.from) + edit.insert;
            at = edit.to;
        }
        out += text.slice(at);
        const map = (pos) => {
            let shift = 0;
            for (const edit of sorted) {
                const size = edit.insert.length - (edit.to - edit.from);
                if (edit.from === edit.to) {
                    if (pos > edit.from || (pos === edit.from && edit.stick === 'after')) shift += size;
                } else if (pos >= edit.to) {
                    shift += size;
                } else if (pos > edit.from) {
                    return edit.from + shift + (edit.stick === 'after' ? edit.insert.length : 0);
                }
            }
            return pos + shift;
        };
        return { text: out, map };
    }

    /** The text after `edits`, and the selection: mapped through them, or from map => selection. */
    function result(text, edits, selection) {
        const applied = applyEdits(text, edits);
        if (typeof selection === 'function') return { text: applied.text, selection: selection(applied.map) };
        return { text: applied.text, selection: { anchor: applied.map(selection.anchor), head: applied.map(selection.head) } };
    }

    /** The lines [from, to] touches: [{ from, to, text }]. A selection ending at a line start skips that line. */
    function touchedLines(text, from, to) {
        let start = text.lastIndexOf('\n', from - 1) + 1;
        let end = to > from && to > 0 && text[to - 1] === '\n' ? to - 1 : to;
        if (end < start) end = start;
        const lines = [];
        let lineFrom = start;
        for (;;) {
            let lineTo = text.indexOf('\n', lineFrom);
            if (lineTo === -1) lineTo = text.length;
            lines.push({ from: lineFrom, to: lineTo, text: text.slice(lineFrom, lineTo) });
            if (lineTo >= end || lineTo === text.length) break;
            lineFrom = lineTo + 1;
        }
        return lines;
    }

    function lineAt(text, pos) {
        return touchedLines(text, pos, pos)[0];
    }

    function parseLine(line) {
        const m = LINE.exec(line);
        const indent = m[1];
        const quote = m[2];
        const list = m[3] || '';
        const heading = m[4] || '';
        let listKind = null;
        if (list) {
            if (/\[[ xX]\]/.test(list)) listKind = 'task';
            else listKind = /^\d/.test(list) ? 'ordered' : 'bullet';
        }
        // "***" or "- - -" is a rule, not a list.
        if (list && /^\s*([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line.slice(indent.length + quote.length))) {
            return { indent, quote, list: '', listKind: null, heading: '', level: 0 };
        }
        const level = heading ? heading.trim().length : 0;
        return { indent, quote, list, listKind, heading, level };
    }

    function quoteDepth(p) {
        return (p.quote.match(/>/g) || []).length;
    }

    /** Length of the first `depth` quote markers at the start of `line` (all it has, if fewer). */
    function quotePrefixLength(line, depth) {
        let at = 0;
        for (let n = 0; n < depth; n++) {
            const m = /^[ \t]{0,3}>[ \t]?/.exec(line.slice(at));
            if (!m) break;
            at += m[0].length;
        }
        return at;
    }

    function leadingSpaces(text) {
        return /^[ \t]*/.exec(text)[0].length;
    }

    /**
     * Each fenced code block, as line indexes: [{ start, end, depth, list, unclosed }]. `end` is
     * the closing fence's line, or (`unclosed`) the block's last line. A fence can follow quote
     * markers (`depth` of them) and a list marker (`list`: the column the item's content starts
     * at); the block then ends with its quote or list item, if it isn't closed first.
     */
    function fencedBlocks(lines) {
        const blocks = [];
        let open = null;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (open) {
                const quoted = quotePrefixLength(line, open.depth);
                const inQuote = open.depth === 0 || quoteDepth(parseLine(line)) >= open.depth;
                const after = line.slice(quoted);
                const inItem = !open.list || after.trim() === '' || leadingSpaces(after) >= open.list;
                if (inQuote && inItem) {
                    const m = FENCE.exec(after.slice(Math.min(open.list, leadingSpaces(after))));
                    if (m && m[1][0] === open.char && m[1].length >= open.size && after.trim() === m[1]) {
                        blocks.push({ start: open.start, end: i, depth: open.depth, list: open.list });
                        open = null;
                    }
                    continue;
                }
                blocks.push({ start: open.start, end: i - 1, depth: open.depth, list: open.list, unclosed: true });
                open = null;
            }
            const p = parseLine(line);
            const depth = p.quote ? quoteDepth(p) : 0;
            const prefix = depth || p.list ? p.indent.length + p.quote.length + p.list.length : 0;
            const m = FENCE.exec(line.slice(prefix));
            if (m) {
                const list = p.list ? (depth ? 0 : p.indent.length) + p.list.length : 0;
                open = { start: i, char: m[1][0], size: m[1].length, depth, list };
            }
        }
        if (open) blocks.push({ start: open.start, end: lines.length - 1, depth: open.depth, list: open.list, unclosed: true });
        return blocks;
    }

    const INDENTED = /^(?: {4}| {0,3}\t)/;
    const ATX = /^ {0,3}#{1,6}(?:[ \t]|$)/;
    const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
    const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;

    /**
     * Each indented code block, as line indexes: [{ start, end }]. It can't interrupt a
     * paragraph, and indented lines in a list are the item's, not code.
     */
    function indentedBlocks(lines, fences) {
        const fenced = new Set();
        for (const b of fences) for (let i = b.start; i <= b.end; i++) fenced.add(i);
        const blocks = [];
        let open = null;
        let prev = -1;
        let inList = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim() === '') continue;
            const indented = !fenced.has(i) && INDENTED.test(line);
            if (open && indented) {
                open.end = i;
            } else {
                if (open) blocks.push(open);
                open = null;
                if (indented && !inList) {
                    const prevEnds = prev < i - 1 || prev === -1 || fenced.has(prev) || ATX.test(lines[prev]) || RULE.test(lines[prev]);
                    if (prevEnds) open = { start: i, end: i };
                }
                if (!indented && !fenced.has(i)) {
                    const p = parseLine(line);
                    inList = Boolean(p.list) && !p.quote;
                }
            }
            prev = i;
        }
        if (open) blocks.push(open);
        return blocks;
    }

    /** Each setext heading, as line indexes: [{ start, end, level }], `end` being its underline. */
    function setextHeadings(lines, code) {
        const headings = [];
        let start = null;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (code.has(i) || line.trim() === '') {
                start = null;
                continue;
            }
            if (start !== null && SETEXT.test(line)) {
                headings.push({ start, end: i, level: line.trim()[0] === '=' ? 1 : 2 });
                start = null;
                continue;
            }
            const p = parseLine(line);
            if (p.quote || p.list || p.level || RULE.test(line)) start = null;
            else if (start === null) start = i;
        }
        return headings;
    }

    /**
     * The document's blocks, as the editor's syntax tree reads them: { fences, indented,
     * setexts, styleOf(i) }, styleOf giving line i's block style ('codeBlock', 'quote',
     * 'h1'-'h6' or 'paragraph', the order a line's style is read in when it has several).
     */
    function blockStructure(lines) {
        const fences = fencedBlocks(lines);
        const indented = indentedBlocks(lines, fences);
        const code = new Set();
        for (const b of [...fences, ...indented]) for (let i = b.start; i <= b.end; i++) code.add(i);
        const setexts = setextHeadings(lines, code);
        const styleOf = (i) => {
            if (code.has(i)) return 'codeBlock';
            const p = parseLine(lines[i]);
            if (p.quote) return 'quote';
            if (p.level) return 'h' + p.level;
            const heading = setexts.find(h => h.start <= i && i <= h.end);
            return heading ? 'h' + heading.level : 'paragraph';
        };
        return { fences, indented, setexts, styleOf };
    }

    /** How many characters make up the first 4 columns of an indented code line. */
    function dedentLength(line) {
        let column = 0;
        let at = 0;
        while (at < line.length && column < 4) {
            if (line[at] === '\t') column += 4 - (column % 4);
            else if (line[at] === ' ') column++;
            else break;
            at++;
        }
        return at;
    }

    // ------------------------------------------------------------------
    // Matching the document's markers
    // ------------------------------------------------------------------

    /** The document's text outside fenced code and code spans, where its markers can be read. */
    function proseOf(text) {
        const lines = text.split('\n');
        const inCode = new Set();
        for (const block of fencedBlocks(lines)) {
            for (let i = block.start; i <= block.end; i++) inCode.add(i);
        }
        return lines
            .map((line, i) => (inCode.has(i) || /^( {4}|\t)/.test(line) ? '' : line.replace(/(`+)[^`]*?\1/g, '')))
            .join('\n');
    }

    /**
     * The markers the document already uses: { bold: '**' | '__', italic: '*' | '_',
     * bullet: '-' | '*' | '+' }, from the first of each found, defaulting to '**', '*' and '-'.
     */
    function documentStyle(text) {
        const style = { bold: '**', italic: '*', bullet: '-' };
        const found = { bold: false, italic: false, bullet: false };
        for (const line of proseOf(String(text)).split('\n')) {
            const p = parseLine(line);
            if (!found.bullet && (p.listKind === 'bullet' || p.listKind === 'task')) {
                style.bullet = p.list[0];
                found.bullet = true;
            }
            for (const span of emphasisSpans(line.slice(contentStart(line)))) {
                if (span.char === '~') continue;
                const name = span.size === 2 ? 'bold' : 'italic';
                if (!found[name]) {
                    style[name] = span.char.repeat(span.size);
                    found[name] = true;
                }
            }
            if (found.bold && found.italic && found.bullet) break;
        }
        return style;
    }

    // ------------------------------------------------------------------
    // Inline styles
    // ------------------------------------------------------------------

    /** [start, end) of each code span in `line`. */
    function codeSpans(line) {
        const spans = [];
        const re = /(?<!\\)(`+)/g;
        let m;
        while ((m = re.exec(line))) {
            const ticks = m[1];
            const open = m.index;
            const closeRe = new RegExp('(?<!`)' + ticks + '(?!`)', 'g');
            closeRe.lastIndex = open + ticks.length;
            const close = closeRe.exec(line);
            if (!close) {
                re.lastIndex = open + ticks.length;
                continue;
            }
            spans.push({
                open: { from: open, to: open + ticks.length },
                close: { from: close.index, to: close.index + ticks.length },
            });
            re.lastIndex = close.index + ticks.length;
        }
        return spans;
    }

    /**
     * Emphasis, strong emphasis and strikethrough spans in `line`, paired the way CommonMark
     * pairs delimiter runs (simplified): [{ char, size, open: {from, to}, close: {from, to} }].
     */
    function emphasisSpans(line) {
        const masked = new Array(line.length).fill(false);
        for (const span of codeSpans(line)) {
            for (let i = span.open.from; i < span.close.to; i++) masked[i] = true;
        }
        const isSpace = (ch) => ch === undefined || /\s/.test(ch);
        const isPunct = (ch) => ch !== undefined && /[\p{P}\p{S}]/u.test(ch);
        const runs = [];
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '\\') {
                i++;
                continue;
            }
            if (masked[i] || (ch !== '*' && ch !== '_' && ch !== '~')) continue;
            let j = i;
            while (j < line.length && line[j] === ch && !masked[j]) j++;
            // Of a longer run of tildes, only the last two are strikethrough's (as the editor reads it).
            const start = ch === '~' && j - i > 2 ? j - 2 : i;
            const before = line[start - 1];
            const after = line[j];
            const leftFlanking = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
            const rightFlanking = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
            let canOpen = leftFlanking;
            let canClose = rightFlanking;
            if (ch === '_') {
                canOpen = leftFlanking && (!rightFlanking || isPunct(before));
                canClose = rightFlanking && (!leftFlanking || isPunct(after));
            }
            runs.push({ char: ch, from: start, to: j, canOpen, canClose, length: j - start });
            i = j - 1;
        }
        const spans = [];
        const stack = [];
        // CommonMark's rule of 3: a run that can both open and close pairs with another only if
        // their lengths don't add up to a multiple of 3, unless both lengths are.
        const pairs = (opener, closer) => {
            // Tildes pair with a run of their own length: two for strikethrough, one for subscript.
            if (opener.char === '~') return opener.length === closer.length;
            if (!(opener.canClose || closer.canOpen)) return true;
            return (opener.length + closer.length) % 3 !== 0 || (opener.length % 3 === 0 && closer.length % 3 === 0);
        };
        for (const run of runs) {
            const rest = { ...run };
            if (run.canClose) {
                while (rest.to > rest.from) {
                    let k = stack.length - 1;
                    while (k >= 0 && !(stack[k].char === run.char && pairs(stack[k], run))) k--;
                    if (k < 0) break;
                    const opener = stack[k];
                    stack.length = k + 1;
                    const openSize = opener.to - opener.from;
                    const closeSize = rest.to - rest.from;
                    // Two at a time (strong emphasis) while both runs have them.
                    const use = openSize >= 2 && closeSize >= 2 ? 2 : 1;
                    spans.push({
                        char: run.char,
                        size: use,
                        open: { from: opener.to - use, to: opener.to },
                        close: { from: rest.from, to: rest.from + use },
                    });
                    opener.to -= use;
                    rest.from += use;
                    if (opener.to === opener.from) stack.pop();
                }
            }
            if (run.canOpen && rest.to > rest.from) stack.push(rest);
        }
        return spans;
    }

    /** The spans of `style` in `line`, positions relative to the line. */
    function inlineSpans(line, style) {
        const spec = INLINE[style];
        if (spec.kind === 'code') return codeSpans(line);
        // A single tilde is subscript, not strikethrough.
        return emphasisSpans(line).filter(span => spec.chars.includes(span.char) && span.size === spec.size);
    }

    /** The innermost span of `style` around [from, to] in the line, or null. */
    function enclosingSpan(line, style, from, to) {
        let best = null;
        for (const span of inlineSpans(line, style)) {
            if (span.open.from <= from && to <= span.close.to && (!best || span.open.from >= best.open.from)) best = span;
        }
        return best;
    }

    function markerFor(style, doc) {
        if (style === 'bold') return doc.bold;
        if (style === 'italic') return doc.italic;
        if (style === 'strikethrough') return '~~';
        return '`';
    }

    /** The word around `pos` in `line` ([from, to), relative to the line), or null. */
    function wordAt(line, pos) {
        let from = pos;
        let to = pos;
        while (from > 0 && WORD.test(line[from - 1])) from--;
        while (to < line.length && WORD.test(line[to])) to++;
        // Apostrophes belong to a word only between letters.
        while (from < to && /['’]/.test(line[from])) from++;
        while (to > from && /['’]/.test(line[to - 1])) to--;
        return from < to ? { from, to } : null;
    }

    /** Where a line's content starts: after its indent, quote, list and heading markers. */
    function contentStart(line) {
        const p = parseLine(line);
        return p.indent.length + p.quote.length + p.list.length + p.heading.length;
    }

    /** Edits that remove a span's markers (`base`: the line's offset in the text). */
    function unwrapEdits(span, base) {
        return [
            { from: base + span.open.from, to: base + span.open.to, insert: '' },
            { from: base + span.close.from, to: base + span.close.to, insert: '' },
        ];
    }

    /** Markers for code around `content`: more backticks than it has in a row, padded if it starts or ends with one. */
    function codeMarkers(content) {
        const longest = Math.max(0, ...(content.match(/`+/g) || []).map(run => run.length));
        const ticks = '`'.repeat(longest + 1);
        const pad = /^`|`$/.test(content) ? ' ' : '';
        return { open: ticks + pad, close: pad + ticks };
    }

    /** Edits that wrap [from, to) of `line` in `style`, removing the same style inside it first. */
    function wrapEdits(line, base, from, to, style, doc) {
        const edits = [];
        let content = line.slice(from, to);
        if (style !== 'code') {
            for (const span of inlineSpans(line, style)) {
                if (span.open.from >= from && span.close.to <= to) {
                    edits.push(...unwrapEdits(span, base));
                    content = content.slice(0, span.open.from - from) + content.slice(span.open.to - from, span.close.from - from) + content.slice(span.close.to - from);
                }
            }
        }
        let open = markerFor(style, doc);
        let close = open;
        if (style === 'code') ({ open, close } = codeMarkers(content));
        edits.push({ from: base + from, to: base + from, insert: open, stick: 'after' });
        edits.push({ from: base + to, to: base + to, insert: close });
        return edits;
    }

    /** Bold, italic, strikethrough or inline code: on, or off when the selection is already in it. */
    function toggleInline(style, input) {
        const text = String(input.text);
        const doc = documentStyle(text);
        const { from, to } = range(input.selection);
        const lines = touchedLines(text, from, to);

        if (lines.length === 1) {
            const line = lines[0];
            const a = from - line.from;
            const b = to - line.from;
            const span = enclosingSpan(line.text, style, a, b);
            if (span) return result(text, unwrapEdits(span, line.from), input.selection);
            if (a === b) {
                const word = wordAt(line.text, a);
                if (word) return result(text, wrapEdits(line.text, line.from, word.from, word.to, style, doc), input.selection);
                const marker = markerFor(style, doc);
                const close = style === 'code' ? '`' : marker;
                return {
                    text: text.slice(0, from) + marker + close + text.slice(from),
                    selection: { anchor: from + marker.length, head: from + marker.length },
                };
            }
            // Spaces at the edges stay outside the markers, or they wouldn't count.
            let s = a;
            let e = b;
            while (s < e && /\s/.test(line.text[s])) s++;
            while (e > s && /\s/.test(line.text[e - 1])) e--;
            if (s === e) return { text, selection: input.selection };
            return result(text, wrapEdits(line.text, line.from, s, e, style, doc), (map) => keepDirection(input.selection, map(line.from + s), map(line.from + e)));
        }

        // Several lines: each line's part of the selection on its own, as paragraphs can't
        // share one pair of markers.
        const parts = lines
            .map(line => {
                const start = Math.max(from - line.from, contentStart(line.text));
                let s = Math.min(start, line.text.length);
                let e = Math.min(to - line.from, line.text.length);
                while (s < e && /\s/.test(line.text[s])) s++;
                while (e > s && /\s/.test(line.text[e - 1])) e--;
                return { line, s, e };
            })
            .filter(part => part.s < part.e);
        if (parts.length === 0) return { text, selection: input.selection };
        const spans = parts.map(part => enclosingSpan(part.line.text, style, part.s, part.e));
        const edits = [];
        if (spans.every(Boolean)) {
            parts.forEach((part, i) => edits.push(...unwrapEdits(spans[i], part.line.from)));
        } else {
            parts.forEach((part, i) => {
                if (!spans[i]) edits.push(...wrapEdits(part.line.text, part.line.from, part.s, part.e, style, doc));
            });
        }
        return result(text, edits, (map) => keepDirection(input.selection, map(from), map(to)));
    }

    function keepDirection(selection, from, to) {
        return selection.anchor <= selection.head ? { anchor: from, head: to } : { anchor: to, head: from };
    }

    // ------------------------------------------------------------------
    // Links
    // ------------------------------------------------------------------

    /** The index just past the `]` closing the bracket at `open` (brackets nest), or -1. */
    function closingBracket(line, open) {
        let depth = 0;
        for (let i = open; i < line.length; i++) {
            if (line[i] === '\\') i++;
            else if (line[i] === '[') depth++;
            else if (line[i] === ']' && --depth === 0) return i + 1;
        }
        return -1;
    }

    /**
     * An inline link's `(destination "title")` starting at `open` (the '('):
     * { url: {from, to}, end } (end: just past the ')'), or null. A bare destination may hold
     * balanced parentheses, as in CommonMark.
     */
    function inlineDestination(line, open) {
        let i = open + 1;
        const skipSpace = () => {
            while (i < line.length && /[ \t]/.test(line[i])) i++;
        };
        skipSpace();
        let url;
        if (line[i] === '<') {
            const from = i + 1;
            for (i = from; i < line.length && line[i] !== '>'; i++) {
                if (line[i] === '\\') i++;
                else if (line[i] === '<') return null;
            }
            if (i >= line.length) return null;
            url = { from, to: i };
            i++;
        } else {
            const from = i;
            let depth = 0;
            for (; i < line.length; i++) {
                const ch = line[i];
                if (ch === '\\') i++;
                else if (/[\s\x00-\x1f]/.test(ch)) break;
                else if (ch === '(') depth++;
                else if (ch === ')' && depth-- === 0) break;
            }
            if (depth > 0) return null;
            i = Math.min(i, line.length);
            url = { from, to: i };
        }
        const beforeTitle = i;
        skipSpace();
        const close = { '"': '"', "'": "'", '(': ')' }[line[i]];
        if (close && (i > beforeTitle || url.from === url.to)) {
            for (i++; i < line.length && line[i] !== close; i++) if (line[i] === '\\') i++;
            if (i >= line.length) return null;
            i++;
            skipSpace();
        }
        return line[i] === ')' ? { url, end: i + 1 } : null;
    }

    /**
     * The links in `line` (relative to the line): [{ from, to, image, text: {from, to},
     * url: {from, to} }]. `url` is what Link selects in it: an inline link's destination, a
     * reference link's label, or (for [text][] and [text]) the text itself.
     */
    function linksIn(line) {
        const links = [];
        const masked = new Array(line.length).fill(false);
        for (const span of codeSpans(line)) {
            for (let i = span.open.from; i < span.close.to; i++) masked[i] = true;
        }
        // Not the list's task box, nor a link reference definition's label.
        const start = contentStart(line);
        if (/^ {0,3}\[(?:\\.|[^\]\\])+\]:/.test(line)) return links;
        for (let i = start; i < line.length; i++) {
            if (line[i] === '\\') {
                i++;
                continue;
            }
            if (line[i] !== '[' || masked[i]) continue;
            const image = line[i - 1] === '!' && line[i - 2] !== '\\';
            const from = image ? i - 1 : i;
            const textEnd = closingBracket(line, i);
            if (textEnd === -1) continue;
            const text = { from: i + 1, to: textEnd - 1 };
            let link = null;
            const inline = line[textEnd] === '(' ? inlineDestination(line, textEnd) : null;
            if (inline) {
                link = { from, to: inline.end, image, text, url: inline.url };
            } else if (line[textEnd] === '[') {
                const labelEnd = line.indexOf(']', textEnd);
                if (labelEnd !== -1) {
                    const label = { from: textEnd + 1, to: labelEnd };
                    link = { from, to: labelEnd + 1, image, text, url: label.from === label.to ? text : label };
                }
            }
            if (!link && text.to > text.from) link = { from, to: textEnd, image, text, url: text };
            if (!link) continue;
            links.push(link);
            i = link.to - 1;
        }
        return links;
    }

    /**
     * Link: a selection becomes [text](url) with `url` selected; in an existing link, its URL
     * (or reference label) is selected; with that already selected, the link is removed and its
     * text kept.
     */
    function toggleLink(input) {
        const text = String(input.text);
        const { from, to } = range(input.selection);
        const line = lineAt(text, from);
        if (to <= line.to) {
            const a = from - line.from;
            const b = to - line.from;
            const link = linksIn(line.text).find(l => l.from <= a && b <= l.to);
            if (link) {
                // An image's URL is selected too, but an image is never turned into its text.
                if (a === link.url.from && b === link.url.to && !link.image) {
                    const edits = [
                        { from: line.from + link.from, to: line.from + link.text.from, insert: '' },
                        { from: line.from + link.text.to, to: line.from + link.to, insert: '' },
                    ];
                    return result(text, edits, () => ({
                        anchor: line.from + link.from,
                        head: line.from + link.from + (link.text.to - link.text.from),
                    }));
                }
                return { text, selection: { anchor: line.from + link.url.from, head: line.from + link.url.to } };
            }
        }
        let s = from;
        let e = to;
        if (s === e) {
            const word = wordAt(line.text, s - line.from);
            if (word) {
                s = line.from + word.from;
                e = line.from + word.to;
            }
        } else {
            while (s < e && /\s/.test(text[s])) s++;
            while (e > s && /\s/.test(text[e - 1])) e--;
        }
        const url = 'url';
        const out = text.slice(0, s) + '[' + text.slice(s, e) + '](' + url + ')' + text.slice(e);
        // Nothing to name the link with: the cursor goes between the brackets.
        if (s === e) return { text: out, selection: { anchor: s + 1, head: s + 1 } };
        const urlFrom = e + 3;
        return { text: out, selection: { anchor: urlFrom, head: urlFrom + url.length } };
    }

    // ------------------------------------------------------------------
    // Block styles and lists
    // ------------------------------------------------------------------

    /** Line indexes of `text` the selection touches, and the text split into lines. */
    function selectedLineIndexes(text, selection) {
        const { from, to } = range(selection);
        const lines = text.split('\n');
        const touched = touchedLines(text, from, to);
        const first = text.slice(0, touched[0].from).split('\n').length - 1;
        return { lines, first, last: first + touched.length - 1 };
    }

    /** Offset in `text` of each line's start. */
    function lineStarts(lines) {
        const starts = [];
        let at = 0;
        for (const line of lines) {
            starts.push(at);
            at += line.length + 1;
        }
        return starts;
    }

    /**
     * The block style of the line at `pos`: 'codeBlock', 'quote', 'h1'..'h6' or 'paragraph'
     * (the order a line's style is read in, when it has several).
     */
    function blockStyleAt(text, pos) {
        const { lines, first } = selectedLineIndexes(String(text), { anchor: pos, head: pos });
        return blockStructure(lines).styleOf(first);
    }

    /**
     * Sets the block style of every line the selection touches: 'paragraph', 'h1'-'h3',
     * 'quote' or 'codeBlock'. A style the lines all have already is toggled off (back to a
     * paragraph). A heading replaces the line's heading marker rather than adding another.
     * Code blocks (fenced or indented) and setext headings touched lose their fences, indent
     * or underline, whatever the lines become.
     */
    function setBlock(style, input) {
        if (!BLOCK_STYLES.includes(style)) throw new Error(`Unknown block style: ${style}`);
        const text = String(input.text);
        const { lines, first, last } = selectedLineIndexes(text, input.selection);
        const starts = lineStarts(lines);
        const blocks = blockStructure(lines);
        const touches = (b) => b.start <= last && first <= b.end;
        const fences = blocks.fences.filter(touches);
        const indented = blocks.indented.filter(touches);
        const setexts = blocks.setexts.filter(touches);
        const isMarker = (i) => fences.some(b => i === b.start || (i === b.end && !b.unclosed)) || setexts.some(h => i === h.end);
        const fenceOf = (i) => fences.find(b => b.start < i && (i < b.end || (b.unclosed && i <= b.end)));
        const indentedOf = (i) => indented.find(b => b.start <= i && i <= b.end);
        const between = (from, to) => {
            const out = [];
            for (let i = from; i <= to; i++) if (!isMarker(i)) out.push(i);
            return out;
        };

        // A setext heading's text goes with its underline.
        let top = Math.min(first, ...setexts.map(h => h.start));
        let bottom = Math.max(last, ...setexts.map(h => h.end));
        let content = between(top, bottom);
        const styled = content.filter(i => lines[i].trim() !== '');
        let target = style;
        const codeTouched = fences.length > 0 || indented.length > 0;
        if (style !== 'paragraph' && styled.every(i => blocks.styleOf(i) === style) && (styled.length > 0 || style === 'codeBlock' && codeTouched)) {
            target = 'paragraph';
        }
        // A code block takes in the whole of any code block it touches.
        if (target === 'codeBlock' && codeTouched) {
            const code = [...fences, ...indented];
            top = Math.min(top, ...code.map(b => b.start));
            bottom = Math.max(bottom, ...code.map(b => b.end));
            content = between(top, bottom);
        }

        const edits = [];
        const removed = setexts.map(heading => heading.end);
        for (const block of fences) {
            if (block.list) {
                // The fence opens a list item, which stays: just the fence goes.
                const line = lines[block.start];
                const p = parseLine(line);
                const marker = p.indent.length + p.quote.length + p.list.trimEnd().length;
                edits.push({ from: starts[block.start] + marker, to: starts[block.start] + line.length, insert: '' });
                if (target !== 'quote' && block.depth) edits.push({ from: starts[block.start], to: starts[block.start] + quotePrefixLength(line, block.depth), insert: '' });
            } else {
                removed.push(block.start);
            }
            if (!block.unclosed) removed.push(block.end);
        }
        edits.push(...removeLines(lines, starts, removed));
        // Indented code is dedented as a whole, so none of it is left as code.
        const inContent = new Set(content);
        for (const block of indented) {
            for (let i = block.start; i <= block.end; i++) {
                if (!inContent.has(i)) edits.push({ from: starts[i], to: starts[i] + dedentLength(lines[i]), insert: '' });
            }
        }

        const nonBlank = content.filter(i => lines[i].trim() !== '');
        for (const i of content) {
            const line = lines[i];
            const p = parseLine(line);
            const base = starts[i];
            const blank = line.trim() === '';
            // The quote keeps the blank lines between its paragraphs.
            const insideQuote = nonBlank[0] < i && i < nonBlank[nonBlank.length - 1];
            const fence = fenceOf(i);
            const block = fence || indentedOf(i);
            if (block) {
                // Code keeps its text exactly as it is: only the quote markers or indent that
                // made it code go (a list item's indent stays).
                const quoted = fence ? quotePrefixLength(line, fence.depth) : 0;
                const strip = fence ? quoted : dedentLength(line);
                const at = base + strip + (fence ? Math.min(fence.list, leadingSpaces(line.slice(quoted))) : 0);
                let marker = '';
                if (target === 'quote') {
                    if (fence && fence.depth) continue;
                    if (blank && !insideQuote) continue;
                    marker = blank ? '>' : '> ';
                } else if (target !== 'paragraph' && target !== 'codeBlock' && !blank) {
                    marker = '#'.repeat(Number(target.slice(1))) + ' ';
                }
                if (strip) edits.push({ from: base, to: base + strip, insert: '' });
                if (marker) edits.push({ from: at, to: at, insert: marker, stick: 'after' });
                continue;
            }
            const quoteEdit = p.quote
                ? [{ from: base + p.indent.length, to: base + p.indent.length + p.quote.length, insert: '' }]
                : [];
            if (target === 'quote') {
                if (p.quote) continue;
                if (blank && !insideQuote) continue;
                edits.push(...dropHeading(p, base), { from: base + p.indent.length, to: base + p.indent.length, insert: blank ? '>' : '> ', stick: 'after' });
            } else if (blank) {
                continue;
            } else if (target === 'paragraph' || target === 'codeBlock') {
                edits.push(...quoteEdit, ...dropHeading(p, base));
            } else {
                const at = base + p.indent.length + p.quote.length + p.list.length;
                edits.push(...quoteEdit, { from: at, to: at + p.heading.length, insert: '#'.repeat(Number(target.slice(1))) + ' ', stick: 'after' });
            }
        }
        if (target === 'codeBlock' && content.length > 0) {
            const fence = '```';
            const top = starts[content[0]];
            const bottom = starts[content[content.length - 1]] + lines[content[content.length - 1]].length;
            edits.push({ from: top, to: top, insert: fence + '\n', stick: 'after' });
            edits.push({ from: bottom, to: bottom, insert: '\n' + fence });
        }
        return result(text, edits, input.selection);
    }

    function dropHeading(p, base) {
        if (!p.heading) return [];
        const at = base + p.indent.length + p.quote.length + p.list.length;
        return [{ from: at, to: at + p.heading.length, insert: '' }];
    }

    /** Edits that remove lines `indexes` with their line breaks, a run of lines in one edit. */
    function removeLines(lines, starts, indexes) {
        const sorted = [...new Set(indexes)].sort((a, b) => a - b);
        const edits = [];
        for (let n = 0; n < sorted.length; n++) {
            const first = sorted[n];
            while (sorted[n + 1] === sorted[n] + 1) n++;
            const last = sorted[n];
            const end = starts[last] + lines[last].length;
            // The break before them, so a position on them ends up at the end of the line above.
            if (first > 0) edits.push({ from: starts[first] - 1, to: end, insert: '' });
            else edits.push({ from: 0, to: last + 1 < lines.length ? starts[last + 1] : end, insert: '' });
        }
        return edits;
    }

    /**
     * Bulleted, numbered or task list on every non-blank line the selection touches. Lines
     * already in another list switch to this one; when they're all in this one, it's removed.
     * Numbers count from 1 (per indent level, for nested lists).
     */
    function toggleList(command, input) {
        const kind = LISTS[command];
        const text = String(input.text);
        const doc = documentStyle(text);
        const { lines, first, last } = selectedLineIndexes(text, input.selection);
        const starts = lineStarts(lines);
        const fences = fencedBlocks(lines);
        const targets = [];
        for (let i = first; i <= last; i++) {
            if (lines[i].trim() === '' || fences.some(b => b.start <= i && i <= b.end)) continue;
            targets.push(i);
        }
        if (targets.length === 0) {
            // A blank line: start a list item there.
            const i = first;
            if (fences.some(b => b.start <= i && i <= b.end)) return { text, selection: input.selection };
            targets.push(i);
        }
        const parsed = targets.map(i => parseLine(lines[i]));
        const remove = parsed.every(p => p.listKind === kind);
        const counters = [];
        const edits = [];
        targets.forEach((i, n) => {
            const p = parsed[n];
            const at = starts[i] + p.indent.length + p.quote.length;
            let marker = '';
            if (!remove) {
                const depth = p.indent.replace(/\t/g, '    ').length;
                while (counters.length && counters[counters.length - 1].depth > depth) counters.pop();
                let counter = counters[counters.length - 1];
                if (!counter || counter.depth !== depth) {
                    counter = { depth, next: 1 };
                    counters.push(counter);
                }
                if (kind === 'ordered') marker = `${counter.next++}. `;
                else if (kind === 'task') marker = `${doc.bullet} [ ] `;
                else marker = `${doc.bullet} `;
                // A task keeps its bullet, and whether it's done.
                if (kind === 'task' && p.listKind === 'task') return;
                if (kind === 'task' && p.listKind === 'bullet') marker = p.list.replace(/[ \t]+$/, ' ') + '[ ] ';
            }
            edits.push({ from: at, to: at + p.list.length, insert: marker, stick: 'after' });
        });
        return result(text, edits, input.selection);
    }

    // ------------------------------------------------------------------
    // Inserting tables, rules and images
    // ------------------------------------------------------------------

    /**
     * Where a block inserted at the selection goes: it replaces [from, to), between `before`
     * and `after`, the line breaks that put it on lines of its own with a blank line on either
     * side. A blank line is taken over; otherwise the block goes after the selection's last
     * line, or after the code block that line is in.
     */
    function blockInsertion(text, selection) {
        const { lines, last } = selectedLineIndexes(text, selection);
        const starts = lineStarts(lines);
        const { fences, indented } = blockStructure(lines);
        let i = last;
        const code = [...fences, ...indented].find(b => b.start <= i && i <= b.end);
        if (code) i = code.end;
        const blank = (n) => n < 0 || n >= lines.length || lines[n].trim() === '';
        const end = starts[i] + lines[i].length;
        if (blank(i) && !code) {
            return { from: starts[i], to: end, before: blank(i - 1) ? '' : '\n', after: blank(i + 1) ? '' : '\n' };
        }
        return { from: end, to: end, before: '\n\n', after: blank(i + 1) ? '' : '\n' };
    }

    /** An empty GFM table, `cols` wide and `rows` tall (the header row counts). */
    function tableMarkdown(cols, rows) {
        const row = '|' + '     |'.repeat(cols);
        const delimiter = '|' + ' --- |'.repeat(cols);
        return [row, delimiter, ...new Array(rows - 1).fill(row)].join('\n');
    }

    function atLeastOne(n) {
        return Math.max(1, Math.floor(Number(n)) || 1);
    }

    /** Inserts an empty table of `cols` × `rows` (header included), the cursor in its first cell. */
    function insertTable(input, cols, rows) {
        const text = String(input.text);
        const table = tableMarkdown(atLeastOne(cols), atLeastOne(rows));
        const { from, to, before, after } = blockInsertion(text, input.selection);
        const cell = from + before.length + 2;
        return {
            text: text.slice(0, from) + before + table + after + text.slice(to),
            selection: { anchor: cell, head: cell },
        };
    }

    /** Inserts a horizontal rule, the cursor on the line after it. */
    function insertRule(input) {
        const text = String(input.text);
        const { from, to, before, after } = blockInsertion(text, input.selection);
        const rest = text.slice(to);
        // At the end of the document there's no line after it yet.
        const tail = after || (rest === '' ? '\n' : '');
        const pos = from + before.length + 3 + 1;
        return {
            text: text.slice(0, from) + before + '---' + tail + rest,
            selection: { anchor: pos, head: pos },
        };
    }

    /**
     * A path as a link destination: characters that would end it or be read as markup
     * (spaces, parentheses, angle brackets, backslashes) and '%' are percent-encoded, which is
     * how the page and other viewers read them back.
     */
    function linkDestination(path) {
        // encodeURIComponent leaves parentheses as they are.
        return String(path).replace(/[%\s()<>\\]/gu, ch => (ch === '(' ? '%28' : ch === ')' ? '%29' : encodeURIComponent(ch)));
    }

    /**
     * Inserts an image at the selection. With options.path (a picked file), `![name](path)`
     * with the alt text selected; without, `![alt](path)` with `path` selected to fill in. A
     * selection on one line becomes the alt text (and the cursor goes after the image).
     */
    function insertImage(input, options = {}) {
        const text = String(input.text);
        let { from, to } = range(input.selection);
        let alt = text.slice(from, to);
        if (/[\r\n]/.test(alt)) {
            from = to;
            alt = '';
        }
        const picked = typeof options.path === 'string' && options.path !== '';
        const fromSelection = alt.trim() !== '';
        if (!fromSelection) {
            alt = picked ? String(options.path).split('/').pop().replace(/\.[^.]+$/, '') : 'alt';
        }
        const destination = picked ? linkDestination(options.path) : 'path';
        const image = `![${alt}](${destination})`;
        const out = text.slice(0, from) + image + text.slice(to);
        if (picked) {
            if (fromSelection) return { text: out, selection: { anchor: from + image.length, head: from + image.length } };
            return { text: out, selection: { anchor: from + 2, head: from + 2 + alt.length } };
        }
        const pathFrom = from + 2 + alt.length + 2;
        return { text: out, selection: { anchor: pathFrom, head: pathFrom + destination.length } };
    }

    // ------------------------------------------------------------------
    // Commands and shortcuts
    // ------------------------------------------------------------------

    /** Runs a toolbar command: one of COMMANDS, or 'block:<style>' with a style from BLOCK_STYLES. */
    function apply(command, input) {
        if (command.startsWith('block:')) return setBlock(command.slice(6), input);
        if (INLINE[command]) return toggleInline(command, input);
        if (command === 'link') return toggleLink(input);
        if (LISTS[command]) return toggleList(command, input);
        throw new Error(`Unknown formatting command: ${command}`);
    }

    /**
     * The command for a keyboard shortcut (⌘ on a Mac, Ctrl elsewhere), or null:
     *   ⌘⌥0-3 paragraph and headings, ⌘B bold, ⌘I italic, ⌘⇧X strikethrough, ⌘⇧C code,
     *   ⌘K link, ⌘⇧8 bulleted, ⌘⇧7 numbered and ⌘⇧9 task list.
     * Digits are read from the physical key: ⌥ and ⇧ change the character typed.
     */
    function shortcutCommand(event, isMac) {
        if (!event) return null;
        const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
        if (!modifier) return null;
        // AltGr arrives as Ctrl+Alt on Windows: it types characters, it isn't a shortcut.
        if (!isMac && typeof event.getModifierState === 'function' && event.getModifierState('AltGraph')) return null;
        const key = String(event.key || '').toLowerCase();
        const code = String(event.code || '');
        const digit = /^Digit(\d)$/.test(code) ? code.slice(5) : /^\d$/.test(key) ? key : null;
        if (event.altKey) {
            if (event.shiftKey) return null;
            return { 0: 'block:paragraph', 1: 'block:h1', 2: 'block:h2', 3: 'block:h3' }[digit] || null;
        }
        if (event.shiftKey) {
            if (digit === '8') return 'bulletList';
            if (digit === '7') return 'orderedList';
            if (digit === '9') return 'taskList';
            const letter = /^Key([A-Z])$/.test(code) ? code.slice(3).toLowerCase() : key;
            if (letter === 'x') return 'strikethrough';
            if (letter === 'c') return 'code';
            return null;
        }
        if (key === 'b') return 'bold';
        if (key === 'i') return 'italic';
        if (key === 'k') return 'link';
        return null;
    }

    /** How a shortcut reads in a tooltip: "⌘⇧X" on a Mac, "Ctrl+Shift+X" elsewhere. */
    const SHORTCUT_KEYS = {
        'block:paragraph': ['alt', '0'],
        'block:h1': ['alt', '1'],
        'block:h2': ['alt', '2'],
        'block:h3': ['alt', '3'],
        bold: ['B'],
        italic: ['I'],
        strikethrough: ['shift', 'X'],
        code: ['shift', 'C'],
        link: ['K'],
        bulletList: ['shift', '8'],
        orderedList: ['shift', '7'],
        taskList: ['shift', '9'],
    };

    function shortcutLabel(command, isMac) {
        const keys = SHORTCUT_KEYS[command];
        if (!keys) return '';
        const key = keys[keys.length - 1];
        const alt = keys.includes('alt');
        const shift = keys.includes('shift');
        if (isMac) return '⌘' + (alt ? '⌥' : '') + (shift ? '⇧' : '') + key;
        return 'Ctrl+' + (alt ? 'Alt+' : '') + (shift ? 'Shift+' : '') + key;
    }

    /** The shortcut in aria-keyshortcuts' terms: "Meta+Shift+X", "Control+Alt+2". */
    function ariaKeyShortcuts(command, isMac) {
        const keys = SHORTCUT_KEYS[command];
        if (!keys) return '';
        const names = { alt: 'Alt', shift: 'Shift' };
        return [isMac ? 'Meta' : 'Control', ...keys.map(k => names[k] || k)].join('+');
    }

    return {
        COMMANDS,
        BLOCK_STYLES,
        apply,
        toggleInline,
        toggleLink,
        setBlock,
        toggleList,
        insertTable,
        insertRule,
        insertImage,
        linkDestination,
        blockStyleAt,
        documentStyle,
        shortcutCommand,
        shortcutLabel,
        ariaKeyShortcuts,
    };
});
