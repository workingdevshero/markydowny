const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = fs.readFileSync(path.join(__dirname, '..', '.supermog.yml'), 'utf8');

test('supermog may push workflow changes, so it can build the release workflow (#33)', () => {
    // A top-level `access:` block with `workflows: true` under it.
    assert.match(config, /^access:\n(?:[ \t]+.*\n|[ \t]*#.*\n)*?[ \t]+workflows:[ \t]*true[ \t]*$/m);
});

test('supermog merges a pull request itself once it verifies', () => {
    assert.match(config, /^merge:[ \t]*auto[ \t]*$/m);
});

test('supermog is told which file holds the notes its workers read and add to', () => {
    assert.match(config, /^learn:\n[ \t]+file:[ \t]*CLAUDE\.md[ \t]*$/m);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'CLAUDE.md')), 'learn.file names a file that is not there');
});

test('supermog files friction it hits here as an issue in this repository', () => {
    assert.match(config, /^report:\n(?:[ \t]+.*\n|[ \t]*#.*\n)*?[ \t]+friction:[ \t]*true[ \t]*$/m);
});
