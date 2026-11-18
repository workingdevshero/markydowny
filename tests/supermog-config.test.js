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
