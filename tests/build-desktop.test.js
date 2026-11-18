const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'build-desktop.sh');

function run(...args) {
    return spawnSync('bash', [script, ...args], { encoding: 'utf8' });
}

test('build-desktop.sh --print-path names the artifact for this OS without building', () => {
    const result = run('--print-path');
    assert.equal(result.status, 0, result.stderr);
    const printed = result.stdout.trim();
    const expected = {
        darwin: 'src-tauri/target/debug/bundle/macos/Markydowny.app',
        linux: 'src-tauri/target/debug/markydowny',
    }[process.platform];
    if (!expected) return; // Windows isn't a desktop target.
    assert.equal(printed, path.join(root, expected));
});

test('build-desktop.sh refuses arguments it does not know', () => {
    const result = run('--release');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown argument: --release/);
});

test("the artifact paths match the app's names in the Tauri config", () => {
    // A rename in tauri.conf.json or Cargo.toml must be made in the script too.
    const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    const cargo = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
    const source = fs.readFileSync(script, 'utf8');
    assert.match(source, new RegExp(`bundle/macos/${conf.productName}\\.app`));
    const crate = cargo.match(/^name = "([^"]+)"/m)[1];
    assert.match(source, new RegExp(`target/debug/${crate}"`));
});

test('the Linux packages the script installs include WebKitGTK 4.1 (Tauri 2) and CMake and Ninja (BugSplat)', () => {
    const source = fs.readFileSync(script, 'utf8');
    const packages = source.match(/LINUX_PACKAGES=\(([^)]*)\)/)[1].split(/\s+/);
    for (const pkg of ['libwebkit2gtk-4.1-dev', 'libgtk-3-dev', 'pkg-config', 'build-essential', 'clang', 'cmake', 'ninja-build']) {
        assert.ok(packages.includes(pkg), `${pkg} is missing`);
    }
});

test('build-desktop.sh is plain ASCII, which macOS bash 3.2 needs', () => {
    // Bash 3.2 read "$NODE_VERSION…" as one long variable name and failed on it.
    const source = fs.readFileSync(script, 'utf8');
    const offending = [...source].findIndex(ch => ch.charCodeAt(0) > 127);
    assert.equal(offending, -1, `non-ASCII character at offset ${offending}`);
});
