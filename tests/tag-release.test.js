const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'tag-release.yml'), 'utf8');

/** The text of the `tag` job: the lines indented under it. */
function tagJob() {
    const body = workflow.split(/^jobs:\n/m)[1];
    assert.match(body, /^ {2}tag:\n/, 'the first job is tag');
    const ids = body.match(/^ {2}[\w-]+:\s*$/gm);
    assert.deepEqual(ids, ['  tag:'], 'tag is the only job');
    return body.split(/^ {2}tag:\n/m)[1];
}

/** The run script of the step named `name`, unindented. */
function stepScript(name) {
    const text = tagJob().split(`- name: ${name}\n`)[1];
    assert.ok(text, `no step named ${name}`);
    return text.split(/^ {6}- /m)[0].match(/run: \|\n((?: {10}.*\n|\n)+)/)[1].replace(/^ {10}/gm, '');
}

test('the workflow runs on pushes to main that change a version file, and by hand', () => {
    const on = workflow.split(/^on:\n/m)[1].split(/^\S/m)[0];
    assert.match(on, /^ {2}push:\n {4}branches: \[main\]\n {4}paths:\n/m);
    const paths = [...on.split(/^ {4}paths:\n/m)[1].matchAll(/^ {6}- (.*)$/gm)].map(m => m[1]);
    assert.deepEqual(paths.sort(), ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json']);
    // The same three files check-release-version.mjs reads.
    assert.match(fs.readFileSync(path.join(root, 'scripts', 'check-release-version.mjs'), 'utf8'),
        /VERSION_FILES = \['package\.json', 'src-tauri\/Cargo\.toml', 'src-tauri\/tauri\.conf\.json'\]/);
    assert.doesNotMatch(on, /tags:|pull_request/);
    assert.match(on, /^ {2}workflow_dispatch:/m);
    // A dispatch on another branch never tags.
    assert.match(tagJob(), /^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
});

test('the job asks only for contents: write and actions: write', () => {
    assert.match(workflow, /^permissions: \{\}$/m);
    const job = tagJob();
    const permissions = job.split(/^ {4}permissions:\n/m)[1].match(/^(?: {6}.*\n)+/)[0];
    assert.equal(permissions, '      contents: write\n      actions: write\n');
    assert.equal(job.match(/permissions:/g).length, 1);
});

test('the version comes from check-release-version.mjs, which fails when the files disagree', () => {
    const job = tagJob();
    assert.match(job, /- id: version\n {8}run: node scripts\/check-release-version\.mjs\n/);
    assert.match(job, /VERSION: \$\{\{ steps\.version\.outputs\.version \}\}/);
    assert.ok(job.indexOf('check-release-version') < job.indexOf('- name: Tag the commit'));
});

/**
 * Runs the tag step with a fake `gh` on the PATH. `existing` is what the fake reports already
 * exists: a `tag`, a `release` (by tag name) or neither. Returns the gh calls and the summary.
 */
function runTagStep({ version = '1.2.0', existing = {} } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markydowny-tag-release-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // Prints what the step's --jq filters would pick out of the API's answer.
    fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
case "$*" in
  "api repos/$GITHUB_REPOSITORY/git/matching-refs/tags/"*) [[ -n "$FAKE_TAG" ]] && echo "refs/tags/$FAKE_TAG" ;;
  "api repos/$GITHUB_REPOSITORY/releases "*) [[ -n "$FAKE_RELEASE" ]] && echo "$FAKE_RELEASE" ;;
esac
exit 0
`, { mode: 0o755 });
    const log = path.join(dir, 'gh.log');
    const summary = path.join(dir, 'summary.md');
    const r = spawnSync('bash', ['-e', '-c', stepScript('Tag the commit and start the release')], {
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            GH_LOG: log,
            GITHUB_STEP_SUMMARY: summary,
            GITHUB_REPOSITORY: 'workingdevshero/markydowny',
            GITHUB_SHA: 'abc123',
            VERSION: version,
            FAKE_TAG: existing.tag ?? '',
            FAKE_RELEASE: existing.release ?? '',
        },
    });
    const read = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
    return { status: r.status, stderr: r.stderr, calls: read(log).trim().split('\n'), summary: read(summary) };
}

test('a new version is tagged on the pushed commit, then release.yml is dispatched on the tag', () => {
    const r = runTagStep({ version: '1.2.0' });
    assert.equal(r.status, 0, r.stderr);
    const create = r.calls.indexOf('api repos/workingdevshero/markydowny/git/refs -f ref=refs/tags/v1.2.0 -f sha=abc123');
    const dispatch = r.calls.indexOf('workflow run release.yml --ref v1.2.0');
    assert.ok(create >= 0, r.calls.join('\n'));
    assert.ok(dispatch > create, 'the release starts after the tag exists');
    assert.match(r.summary, /Tagged abc123 as v1\.2\.0/);
});

test('a prerelease version is tagged as one', () => {
    const r = runTagStep({ version: '1.2.0-beta.1' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.calls.includes('workflow run release.yml --ref v1.2.0-beta.1'));
});

for (const [what, existing] of [['a tag', { tag: 'v1.2.0' }], ['a release', { release: 'v1.2.0' }]]) {
    test(`nothing is tagged or released when v<version> exists as ${what}`, () => {
        const r = runTagStep({ version: '1.2.0', existing });
        assert.equal(r.status, 0, r.stderr);
        assert.ok(!r.calls.some(c => c.includes('git/refs ') || c.startsWith('workflow run')), r.calls.join('\n'));
        assert.match(r.summary, /v1\.2\.0 already exists/);
    });
}

test('the existence checks match the tag exactly, not a longer tag it prefixes', () => {
    const script = stepScript('Tag the commit and start the release');
    // matching-refs/tags/v1.2.0 also lists v1.2.0-beta.1, so the ref is compared in full.
    assert.match(script, /select\(\.ref == \\"refs\/tags\/\$tag\\"\)/);
    assert.match(script, /select\(\.tag_name == \\"\$tag\\"\)/);
    // Drafts are listed too, and a failing API call fails the step rather than reading as "none".
    assert.match(script, /releases" --paginate/);
    assert.doesNotMatch(script, /\|\| true|2>\s*\/dev\/null/);
});
