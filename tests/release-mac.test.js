const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'release-mac.sh');

// --dry-run runs anywhere, so these run on the Linux CI job too. `targetDir` stands in for Cargo's
// target directory; by default an empty one, so nothing on this machine is found.
const emptyTargetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-mac-'));
function dryRun(...args) {
    let targetDir = emptyTargetDir;
    if (typeof args[0] === 'object') targetDir = args.shift().targetDir;
    const result = spawnSync('bash', [script, '--dry-run', ...args], {
        encoding: 'utf8',
        env: { ...process.env, SIGNING_IDENTITY: '', ARCH: '', NOTARY_PROFILE: '', CARGO_TARGET_DIR: targetDir },
    });
    const lines = result.stdout.trim().split('\n');
    const steps = lines.filter(l => l.startsWith('step: ')).map(l => l.slice('step: '.length));
    return { ...result, lines, steps };
}

// The index of the first step matching `pattern`, failing the test when there's none.
function at(steps, pattern) {
    const i = steps.findIndex(s => pattern.test(s));
    assert.notEqual(i, -1, `no step matches ${pattern}:\n${steps.join('\n')}`);
    return i;
}

test('release-mac.sh --dry-run builds, signs inside out, packages, notarizes, then staples', () => {
    const { status, stderr, steps, lines } = dryRun();
    assert.equal(status, 0, stderr);
    const build = at(steps, /tauri build --bundles app --target universal-apple-darwin/);
    const monitor = at(steps, /^codesign .*Helpers\/BugSplatMonitor$/);
    const reporter = at(steps, /^codesign .*Helpers\/BugSplatReporter\.app$/);
    const app = at(steps, /^codesign --force .*Markydowny\.app$/);
    const verify = at(steps, /^codesign --verify --deep --strict/);
    const dmg = at(steps, /^hdiutil create /);
    const signDmg = at(steps, /^codesign --force .*\.dmg$/);
    const submit = at(steps, /^xcrun notarytool submit .* --keychain-profile markydowny-notary --wait$/);
    const staple = at(steps, /^xcrun stapler staple /);
    const assess = at(steps, /^spctl --assess /);
    // Signing the app seals its helpers, so they have to be signed first.
    assert.ok(build < monitor && monitor < app && reporter < app, 'helpers are signed after the build, before the app');
    assert.ok(app < verify && verify < dmg && dmg < signDmg, 'the app is verified, then packaged, then the .dmg is signed');
    assert.ok(signDmg < submit && submit < staple && staple < assess, 'notarized, then stapled, then assessed');
    // Hardened runtime and a timestamp are what notarization requires.
    for (const i of [monitor, reporter, app, signDmg]) {
        assert.match(steps[i], /--timestamp --options runtime/);
    }
    assert.match(lines.at(-1), /dist-release\/Markydowny-\d+\.\d+\.\d+-universal\.dmg$/);
});

test("the .dmg is built with hdiutil, never Tauri's Finder-driven dmg bundler", () => {
    const { steps } = dryRun();
    assert.ok(!steps.some(s => /--bundles .*dmg/.test(s)));
    assert.ok(steps.some(s => /^ln -s \/Applications /.test(s)), 'the .dmg has an Applications shortcut');
});

test('--no-notarize stops after packaging, and an ad-hoc identity signs without a timestamp', () => {
    const { status, stderr, steps } = dryRun('--identity', '-', '--no-notarize', '--arch', 'arm64');
    assert.equal(status, 0, stderr);
    assert.ok(steps.some(s => /--target aarch64-apple-darwin/.test(s)));
    assert.ok(!steps.some(s => /notarytool|stapler|spctl/.test(s)));
    const signs = steps.filter(s => /^codesign --force/.test(s));
    assert.ok(signs.length >= 4);
    for (const s of signs) assert.doesNotMatch(s, /--timestamp/);
});

test('release-mac.sh refuses to notarize an ad-hoc signature, and unknown arguments', () => {
    const adHoc = dryRun('--identity', '-');
    assert.notEqual(adHoc.status, 0);
    assert.match(adHoc.stderr, /can't be notarized/);
    const unknown = dryRun('--publish');
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /unknown argument: --publish/);
    const arch = dryRun('--arch', 'ppc');
    assert.notEqual(arch.status, 0);
});

test('release-mac.sh keeps credentials out of the repository', () => {
    const source = fs.readFileSync(script, 'utf8');
    // The identity comes from the keychain or the environment, and notarytool from a keychain profile.
    assert.doesNotMatch(source, /--password|--apple-id|APPLE_PASSWORD=/);
    assert.match(source, /--keychain-profile/);
    assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^dist-release\/$/m);
});

// Writes the bugsplat-link.txt that bugsplat-sys's CMake build leaves under `out/build/`,
// naming helpers in `helpers` (the reporter as its .app bundle, as on macOS), with mtime `time`.
function linkInfo(dir, helpers, time) {
    const build = path.join(dir, 'out', 'build');
    fs.mkdirSync(build, { recursive: true });
    const file = path.join(build, 'bugsplat-link.txt');
    fs.writeFileSync(file, `archive=${build}/libbugsplat_rs.a\nmonitor=${helpers}/BugSplatMonitor\nreporter=${helpers}/BugSplatReporter.app\n`);
    fs.utimesSync(file, time, time);
}

test('a universal release merges both architectures of the BugSplat helpers before signing them', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-mac-'));
    const build = triple => path.join(targetDir, triple, 'release', 'build');
    // Cargo 1.100's layout (build/bugsplat-sys/<hash>/) for arm64, next to a stale build in the
    // older one (build/bugsplat-sys-<hash>/); the older layout alone for Intel.
    linkInfo(path.join(build('aarch64-apple-darwin'), 'bugsplat-sys', 'new'), '/arm/current', 2000);
    linkInfo(path.join(build('aarch64-apple-darwin'), 'bugsplat-sys-old'), '/arm/stale', 1000);
    linkInfo(path.join(build('x86_64-apple-darwin'), 'bugsplat-sys-abc'), '/intel', 1000);
    const { status, stderr, steps } = dryRun({ targetDir });
    assert.equal(status, 0, stderr);
    const tauri = at(steps, /tauri build /);
    const helpers = `${targetDir}/universal-apple-darwin/release/bundle/macos/Markydowny.app/Contents/Helpers`;
    const monitor = steps.indexOf(`lipo -create /arm/current/BugSplatMonitor /intel/BugSplatMonitor -output ${helpers}/BugSplatMonitor`);
    const reporterExe = 'BugSplatReporter.app/Contents/MacOS/BugSplatReporter';
    const reporter = steps.indexOf(`lipo -create /arm/current/${reporterExe} /intel/${reporterExe} -output ${helpers}/${reporterExe}`);
    assert.notEqual(monitor, -1, steps.join('\n'));
    assert.notEqual(reporter, -1, steps.join('\n'));
    const signHelper = at(steps, /^codesign --force .*Helpers\/BugSplatMonitor$/);
    assert.ok(tauri < monitor && tauri < reporter, 'merged after the build');
    assert.ok(monitor < signHelper && reporter < signHelper, 'merged before signing, so the signature covers both');
    // A single-architecture release has nothing to merge.
    assert.ok(!dryRun('--arch', 'arm64').steps.some(s => /^lipo -create/.test(s)));
});
