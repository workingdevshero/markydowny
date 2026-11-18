// markychecky's one-command setup (markychecky.sh, at the site's root) and the SessionStart hook
// that says what's missing. The installer runs against a temporary HOME, with a fake `claude` on
// PATH that records its arguments.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const installer = path.join(root, 'markychecky.sh');
const startHook = path.join(root, 'plugins', 'markychecky', 'scripts', 'session-start.sh');
const COMMAND = 'curl -fsSL https://markydowny.com/markychecky.sh | bash';
const hasPython = spawnSync('python3', ['--version']).status === 0;
const which = name => spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
const bash = which('bash');

function script(file, body) {
    fs.writeFileSync(file, `#!${bash}\n${body}\n`);
    fs.chmodSync(file, 0o755);
}

/**
 * A temporary HOME and a bin folder holding a fake `claude`. The fake logs each call's arguments
 * to claude.log, and `plugin list` shows markychecky once `plugin install` has run.
 */
function sandbox({ version = '2.1.300' } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markychecky-setup-'));
    const home = path.join(dir, 'home');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    const log = path.join(dir, 'claude.log');
    const installed = path.join(dir, 'installed');
    script(path.join(bin, 'claude'), `
echo "$*" >> "${log}"
case "$*" in
    --version) echo "${version} (Claude Code)" ;;
    "plugin list") if [ -e "${installed}" ]; then echo "  ❯ markychecky@markydowny"; echo "    Status: ✔ enabled"; fi ;;
    "plugin install"*) : > "${installed}" ;;
esac
exit 0`);
    return {
        dir, home, bin,
        settings: path.join(home, '.claude', 'settings.json'),
        calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
        pluginCalls() { return this.calls().filter(c => c.startsWith('plugin ') && c !== 'plugin list'); },
    };
}

function install(box, { args = [], path: PATH = `${box.bin}:${process.env.PATH}` } = {}) {
    return spawnSync(bash, [installer, ...args], {
        env: { HOME: box.home, PATH },
        input: '',
        encoding: 'utf8',
    });
}

/** A PATH holding only the fake claude and the few commands the installer needs, no python3. */
function pathWithoutPython(box, extra = {}) {
    const tools = path.join(box.dir, 'tools');
    fs.mkdirSync(tools);
    for (const name of ['uname', 'grep', 'sed', 'head']) fs.symlinkSync(which(name), path.join(tools, name));
    fs.symlinkSync(path.join(box.bin, 'claude'), path.join(tools, 'claude'));
    for (const [name, body] of Object.entries(extra)) {
        fs.rmSync(path.join(tools, name), { force: true });
        script(path.join(tools, name), body);
    }
    return tools;
}

test('the installer installs the plugin and creates settings.json when there is none', { skip: !hasPython }, () => {
    const box = sandbox();
    const run = install(box);
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.deepEqual(box.pluginCalls(), ['plugin install markychecky --marketplace workingdevshero/markydowny']);
    assert.deepEqual(JSON.parse(fs.readFileSync(box.settings, 'utf8')), { env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } });
    assert.match(run.stdout, /Done\. Restart any Claude Code session that was already open \(claude --resume\)\.\n$/);
});

test('the installer merges the setting into an existing settings.json without losing anything', { skip: !hasPython }, () => {
    const box = sandbox();
    const before = { model: 'opus', permissions: { allow: ['Bash(ls:*)'] }, env: { FOO: 'bar' }, hooks: {} };
    fs.mkdirSync(path.dirname(box.settings));
    fs.writeFileSync(box.settings, JSON.stringify(before));
    const run = install(box);
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(box.settings, 'utf8')), { ...before, env: { FOO: 'bar', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } });
});

test('a second run changes nothing, says so, and updates the plugin instead of installing it', { skip: !hasPython }, () => {
    const box = sandbox();
    assert.equal(install(box).status, 0);
    const settings = fs.readFileSync(box.settings, 'utf8');
    const mtime = fs.statSync(box.settings).mtimeMs;
    const again = install(box);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.equal(fs.readFileSync(box.settings, 'utf8'), settings);
    assert.equal(fs.statSync(box.settings).mtimeMs, mtime, 'settings.json isn\'t rewritten');
    assert.match(again.stdout, /markychecky is already installed/);
    assert.match(again.stdout, /The task list is already on/);
    assert.deepEqual(box.pluginCalls(), [
        'plugin install markychecky --marketplace workingdevshero/markydowny',
        'plugin update markychecky@markydowny',
    ]);
});

test('on Claude Code older than 2.1.292 it adds the marketplace, then installs', { skip: !hasPython }, () => {
    const box = sandbox({ version: '2.1.100' });
    assert.equal(install(box).status, 0);
    assert.deepEqual(box.pluginCalls(), [
        'plugin marketplace add workingdevshero/markydowny',
        'plugin install markychecky@markydowny',
    ]);
});

test('settings.json that isn\'t valid JSON is left alone, and the installer stops', { skip: !hasPython }, () => {
    const box = sandbox();
    fs.mkdirSync(path.dirname(box.settings));
    fs.writeFileSync(box.settings, '{ "model": "opus", }');
    const run = install(box);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /isn't valid JSON/);
    assert.equal(fs.readFileSync(box.settings, 'utf8'), '{ "model": "opus", }');
});

test('a missing python3 stops the installer with what to install, before it changes anything', () => {
    const box = sandbox();
    const run = install(box, { path: pathWithoutPython(box) });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /markychecky needs python3/);
    assert.match(run.stderr, /Then run this again\./);
    assert.deepEqual(box.pluginCalls(), []);
    assert.ok(!fs.existsSync(box.settings));
});

test('on a Mac, a missing python3 points at the Xcode Command Line Tools', () => {
    const box = sandbox();
    const run = install(box, { path: pathWithoutPython(box, { uname: 'echo Darwin' }) });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /xcode-select --install/);
});

// Apple's /usr/bin/python3 is a stub until the Command Line Tools are installed. These run on a
// /usr/bin/python3 that works, with uname saying Darwin, so only xcode-select decides.
const hasSystemPython = fs.existsSync('/usr/bin/python3');

/** A PATH where python3 is /usr/bin/python3, uname says Darwin and xcode-select exits with `status`. */
function macPath(box, status) {
    const tools = pathWithoutPython(box, { uname: 'echo Darwin', 'xcode-select': `exit ${status}` });
    return `${tools}:/usr/bin`;
}

test('on a Mac, the /usr/bin/python3 stub without the Command Line Tools counts as missing, and isn\'t run', { skip: !hasSystemPython }, () => {
    const box = sandbox();
    const run = install(box, { path: macPath(box, 2) });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /xcode-select --install/);
    assert.deepEqual(box.pluginCalls(), []);
    assert.ok(!fs.existsSync(box.settings));
});

test('on a Mac with the Command Line Tools, /usr/bin/python3 is used', { skip: !hasSystemPython }, () => {
    const box = sandbox();
    const run = install(box, { path: macPath(box, 0), args: ['--no-app'] });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(box.settings, 'utf8')), { env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } });
});

test('a python3 that doesn\'t run counts as missing', () => {
    const box = sandbox();
    const run = install(box, { path: pathWithoutPython(box, { python3: 'exit 1' }) });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /markychecky needs python3/);
    assert.deepEqual(box.pluginCalls(), []);
});

test('settings.json keeps its permissions and leaves no temporary file beside it', { skip: !hasPython }, () => {
    const box = sandbox();
    fs.mkdirSync(path.dirname(box.settings));
    fs.writeFileSync(box.settings, '{"model": "opus"}');
    fs.chmodSync(box.settings, 0o600);
    const run = install(box);
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.equal(fs.statSync(box.settings).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(box.settings)), ['settings.json']);
    assert.deepEqual(JSON.parse(fs.readFileSync(box.settings, 'utf8')), { model: 'opus', env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } });
});

test('a missing claude stops the installer too', () => {
    const box = sandbox();
    const tools = pathWithoutPython(box);
    fs.rmSync(path.join(tools, 'claude'));
    const run = install(box, { path: tools });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /needs Claude Code/);
});

test('on a Mac without a terminal, it never offers or downloads Markydowny', { skip: !hasPython }, () => {
    const box = sandbox();
    const curlLog = path.join(box.dir, 'curl.log');
    script(path.join(box.bin, 'uname'), 'echo Darwin');
    script(path.join(box.bin, 'xcode-select'), 'exit 0');
    script(path.join(box.bin, 'curl'), `echo "$*" >> "${curlLog}"`);
    script(path.join(box.bin, 'open'), `echo "$*" >> "${curlLog}"`);
    const run = install(box);
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.doesNotMatch(run.stdout, /Download Markydowny/);
    assert.ok(!fs.existsSync(curlLog));
});

test('--no-app is accepted, and an unknown option stops it', { skip: !hasPython }, () => {
    const box = sandbox();
    assert.equal(install(box, { args: ['--no-app'] }).status, 0);
    const bad = install(sandbox(), { args: ['--nope'] });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /Unknown option: --nope/);
});

test('the installer is bash 3.2 friendly: it parses, and reads all of itself before running', () => {
    assert.equal(spawnSync(bash, ['-n', installer]).status, 0);
    const text = fs.readFileSync(installer, 'utf8');
    // With `curl | bash` the script is bash's stdin, so it all sits in main, called on the last line.
    assert.match(text, /\nmain "\$@"\n$/);
    // No bash 4 features: associative arrays, ${var,,} case changes, mapfile.
    assert.doesNotMatch(text, /declare -A|local -A|\$\{\w+,,\}|\$\{\w+\^\^\}|mapfile|readarray/);
});

function sessionStart(env, PATH = process.env.PATH) {
    const clean = { ...process.env, PATH, ...env };
    if (!('CLAUDE_CODE_ENABLE_TODO_TOOLS' in env)) delete clean.CLAUDE_CODE_ENABLE_TODO_TOOLS;
    return spawnSync(which('sh'), [startHook], {
        input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' }),
        env: clean,
        encoding: 'utf8',
    });
}

test('the SessionStart hook says how to turn on the task list when it\'s off', { skip: !hasPython }, () => {
    for (const env of [{}, { CLAUDE_CODE_ENABLE_TODO_TOOLS: '' }, { CLAUDE_CODE_ENABLE_TODO_TOOLS: '0' }]) {
        const run = sessionStart(env);
        assert.equal(run.status, 0);
        const { systemMessage } = JSON.parse(run.stdout);
        assert.ok(systemMessage.includes(COMMAND), systemMessage);
        assert.ok(systemMessage.includes('"CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"'), systemMessage);
        assert.match(systemMessage, /~\/\.claude\/settings\.json/);
    }
});

test('the SessionStart hook stays silent when the task list is on', () => {
    const run = sessionStart({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, '');
});

test('the SessionStart hook says python3 is missing, and still exits 0', () => {
    const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'markychecky-tools-'));
    fs.symlinkSync(which('uname'), path.join(tools, 'uname'));
    const run = sessionStart({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }, tools);
    assert.equal(run.status, 0);
    assert.match(JSON.parse(run.stdout).systemMessage, /needs python3/);
});

test('on a Mac, the SessionStart hook says python3 is missing when /usr/bin/python3 is the stub', { skip: !hasSystemPython }, () => {
    const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'markychecky-tools-'));
    script(path.join(tools, 'uname'), 'echo Darwin');
    script(path.join(tools, 'xcode-select'), 'exit 2');
    const run = sessionStart({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }, `${tools}:/usr/bin`);
    assert.equal(run.status, 0);
    const { systemMessage } = JSON.parse(run.stdout);
    assert.match(systemMessage, /needs python3/);
    assert.match(systemMessage, /xcode-select --install/);
});

test('the markychecky page, the plugin README and the README all show the same one-line command', () => {
    const docs = {
        'markychecky page': path.join(root, 'docs', 'markychecky.md'),
        'plugin README': path.join(root, 'plugins', 'markychecky', 'README.md'),
        'README': path.join(root, 'README.md'),
        'Watching Claude Code page': path.join(root, 'docs', 'claude-code.md'),
        'installer': installer,
    };
    for (const [name, file] of Object.entries(docs)) {
        assert.ok(fs.readFileSync(file, 'utf8').includes(COMMAND), `${name} doesn't show "${COMMAND}"`);
    }
    // The page leads Set it up with it, and keeps the steps under Or step by step.
    const page = fs.readFileSync(docs['markychecky page'], 'utf8');
    const setUp = page.slice(page.indexOf('## Set it up'), page.indexOf('### Or step by step'));
    assert.ok(setUp.includes(COMMAND), 'the command comes before the steps');
    assert.ok(page.indexOf('### Or step by step') < page.indexOf('#### 1. Check what you need'));
});
