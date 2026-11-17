const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../js/core.js');

// ---------------------------------------------------------------------------
// changedBlocks
// ---------------------------------------------------------------------------

test('changedBlocks finds a change in the middle', () => {
    assert.deepEqual(core.changedBlocks(['a', 'b', 'c'], ['a', 'B', 'c']),
        { changed: true, start: 1, end: 2, oldEnd: 2, removedBefore: null });
});

test('changedBlocks finds an append', () => {
    assert.deepEqual(core.changedBlocks(['a', 'b'], ['a', 'b', 'c', 'd']),
        { changed: true, start: 2, end: 4, oldEnd: 2, removedBefore: null });
});

test('changedBlocks finds an insert at the top', () => {
    assert.deepEqual(core.changedBlocks(['a', 'b'], ['new', 'a', 'b']),
        { changed: true, start: 0, end: 1, oldEnd: 0, removedBefore: null });
});

test('changedBlocks finds a deletion and where it was', () => {
    assert.deepEqual(core.changedBlocks(['a', 'b', 'c'], ['a', 'c']),
        { changed: true, start: 1, end: 1, oldEnd: 2, removedBefore: 1 });
    // From the end: removed before index === new length.
    assert.deepEqual(core.changedBlocks(['a', 'b', 'c'], ['a', 'b']),
        { changed: true, start: 2, end: 2, oldEnd: 3, removedBefore: 2 });
});

test('changedBlocks reports no change', () => {
    assert.deepEqual(core.changedBlocks(['a', 'b'], ['a', 'b']),
        { changed: false, start: 2, end: 2, oldEnd: 2, removedBefore: null });
    assert.equal(core.changedBlocks([], []).changed, false);
});

test('changedBlocks handles a full rewrite', () => {
    assert.deepEqual(core.changedBlocks(['a', 'b'], ['x', 'y', 'z']),
        { changed: true, start: 0, end: 3, oldEnd: 2, removedBefore: null });
    assert.deepEqual(core.changedBlocks(['a'], []),
        { changed: true, start: 0, end: 0, oldEnd: 1, removedBefore: 0 });
});

test('changedBlocks does not double count repeated identical blocks', () => {
    // Appending a duplicate: the prefix covers all of old, so the suffix must not overlap it.
    assert.deepEqual(core.changedBlocks(['a', 'b', 'a'], ['a', 'b', 'a', 'a']),
        { changed: true, start: 3, end: 4, oldEnd: 3, removedBefore: null });
    // Removing one of two identical blocks.
    assert.deepEqual(core.changedBlocks(['x', 'x'], ['x']),
        { changed: true, start: 1, end: 1, oldEnd: 2, removedBefore: 1 });
    // Inserting between repeats.
    assert.deepEqual(core.changedBlocks(['---', 'p', '---'], ['---', 'p', 'q', '---']),
        { changed: true, start: 2, end: 3, oldEnd: 2, removedBefore: null });
});

test('mapBlockIndex moves block indices past a change', () => {
    const insert = core.changedBlocks(['a', 'b', 'c'], ['a', 'new', 'new2', 'b', 'c']);
    assert.equal(core.mapBlockIndex(0, insert), 0);
    assert.equal(core.mapBlockIndex(1, insert), 3);
    assert.equal(core.mapBlockIndex(2, insert), 4);
    const edit = core.changedBlocks(['a', 'b', 'c'], ['a', 'B', 'c']);
    assert.equal(core.mapBlockIndex(1, edit), 1, 'an edited block keeps its place');
    const removal = core.changedBlocks(['a', 'b', 'c', 'd'], ['a', 'd']);
    assert.equal(core.mapBlockIndex(2, removal), 1, 'inside a removal: the block after it');
    assert.equal(core.mapBlockIndex(3, removal), 1);
    assert.equal(core.mapBlockIndex(5, core.changedBlocks(['a'], ['a'])), 5);
});

test('changeTarget points at the first change, or where blocks were removed', () => {
    assert.equal(core.changeTarget(core.changedBlocks(['a', 'b'], ['a', 'B']), 2), 1);
    assert.equal(core.changeTarget(core.changedBlocks(['a', 'b', 'c'], ['a', 'c']), 2), 1);
    assert.equal(core.changeTarget(core.changedBlocks(['a', 'b'], ['a']), 1), 0, 'removed at the end: the last block');
    assert.equal(core.changeTarget(core.changedBlocks(['a'], ['a']), 1), null);
    assert.equal(core.changeTarget(core.changedBlocks(['a'], []), 0), null);
});

// ---------------------------------------------------------------------------
// Follow state machine
// ---------------------------------------------------------------------------

test('followReducer: following scrolls to changes that are out of view', () => {
    const following = { mode: 'following', target: null };
    assert.deepEqual(core.followReducer(following, { type: 'reload', target: 4, visible: false }),
        { state: { mode: 'following', target: 4 }, scrollTo: 4 });
    assert.deepEqual(core.followReducer(following, { type: 'reload', target: 4, visible: true }),
        { state: { mode: 'following', target: 4 }, scrollTo: null });
    assert.deepEqual(core.followReducer(following, { type: 'reload', target: null, visible: false }),
        { state: { mode: 'following', target: null }, scrollTo: null });
});

test('followReducer: scrolling yourself pauses following; off and paused ignore it', () => {
    assert.deepEqual(core.followReducer({ mode: 'following', target: 2 }, { type: 'userScroll' }),
        { state: { mode: 'paused', target: 2 }, scrollTo: null });
    assert.deepEqual(core.followReducer({ mode: 'paused', target: 2 }, { type: 'userScroll' }),
        { state: { mode: 'paused', target: 2 }, scrollTo: null });
    assert.deepEqual(core.followReducer({ mode: 'off', target: 2 }, { type: 'userScroll' }),
        { state: { mode: 'off', target: 2 }, scrollTo: null });
});

test('followReducer: paused and off record changes without scrolling', () => {
    assert.deepEqual(core.followReducer({ mode: 'paused', target: 1 }, { type: 'reload', target: 7, visible: false }),
        { state: { mode: 'paused', target: 7 }, scrollTo: null });
    assert.deepEqual(core.followReducer({ mode: 'off', target: null }, { type: 'reload', target: 7, visible: false }),
        { state: { mode: 'off', target: 7 }, scrollTo: null });
});

test('followReducer: toggle resumes to the latest change, or turns following off', () => {
    assert.deepEqual(core.followReducer({ mode: 'paused', target: 7 }, { type: 'toggle' }),
        { state: { mode: 'following', target: 7 }, scrollTo: 7 });
    assert.deepEqual(core.followReducer({ mode: 'off', target: 3 }, { type: 'toggle' }),
        { state: { mode: 'following', target: 3 }, scrollTo: 3 });
    assert.deepEqual(core.followReducer({ mode: 'off', target: null }, { type: 'toggle' }),
        { state: { mode: 'following', target: null }, scrollTo: null });
    assert.deepEqual(core.followReducer({ mode: 'following', target: 3 }, { type: 'toggle' }),
        { state: { mode: 'off', target: 3 }, scrollTo: null });
});

test('followReducer: a new document forgets the target and un-pauses', () => {
    assert.deepEqual(core.followReducer({ mode: 'paused', target: 3 }, { type: 'reset' }),
        { state: { mode: 'following', target: null }, scrollTo: null });
    assert.deepEqual(core.followReducer({ mode: 'off', target: 3 }, { type: 'reset' }),
        { state: { mode: 'off', target: null }, scrollTo: null });
    assert.deepEqual(core.followReducer({ mode: 'following', target: 3 }, { type: 'nonsense' }),
        { state: { mode: 'following', target: 3 }, scrollTo: null });
});

test('formatUpdated gives relative times', () => {
    assert.equal(core.formatUpdated(0), 'Updated just now');
    assert.equal(core.formatUpdated(4999), 'Updated just now');
    assert.equal(core.formatUpdated(12000), 'Updated 12s ago');
    assert.equal(core.formatUpdated(125000), 'Updated 2 min ago');
    assert.equal(core.formatUpdated(3 * 3600 * 1000), 'Updated 3 h ago');
    assert.equal(core.formatUpdated(50 * 3600 * 1000), 'Updated 2 d ago');
    assert.equal(core.formatUpdated(-50), 'Updated just now');
});
