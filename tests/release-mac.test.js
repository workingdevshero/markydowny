const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'release-mac.sh');
const onMac = process.platform === 'darwin';

function dryRun(...args) {
    const result = spawnSync('bash', [script, '--dry-run', ...args], {
        encoding: 'utf8',
        env: { ...process.env, SIGNING_IDENTITY: '', ARCH: '', NOTARY_PROFILE: '' },
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

test('release-mac.sh --dry-run builds, signs inside out, packages, notarizes, then staples', { skip: !onMac }, () => {
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

test("the .dmg is built with hdiutil, never Tauri's Finder-driven dmg bundler", { skip: !onMac }, () => {
    const { steps } = dryRun();
    assert.ok(!steps.some(s => /--bundles .*dmg/.test(s)));
    assert.ok(steps.some(s => /^ln -s \/Applications /.test(s)), 'the .dmg has an Applications shortcut');
});

test('--no-notarize stops after packaging, and an ad-hoc identity signs without a timestamp', { skip: !onMac }, () => {
    const { status, stderr, steps } = dryRun('--identity', '-', '--no-notarize', '--arch', 'arm64');
    assert.equal(status, 0, stderr);
    assert.ok(steps.some(s => /--target aarch64-apple-darwin/.test(s)));
    assert.ok(!steps.some(s => /notarytool|stapler|spctl/.test(s)));
    const signs = steps.filter(s => /^codesign --force/.test(s));
    assert.ok(signs.length >= 4);
    for (const s of signs) assert.doesNotMatch(s, /--timestamp/);
});

test('release-mac.sh refuses to notarize an ad-hoc signature, and unknown arguments', { skip: !onMac }, () => {
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

test('a universal release merges both architectures of the BugSplat helpers before signing them', { skip: !onMac }, () => {
    const { steps } = dryRun();
    const build = at(steps, /tauri build /);
    const monitor = at(steps, /^lipo -create .*aarch64-apple-darwin.*BugSplatMonitor .*x86_64-apple-darwin.*BugSplatMonitor -output .*Helpers\/BugSplatMonitor$/);
    const reporter = at(steps, /^lipo -create .*aarch64.*\/BugSplatReporter .*x86_64.*\/BugSplatReporter -output .*Helpers\/BugSplatReporter\.app\/Contents\/MacOS\/BugSplatReporter$/);
    const signHelper = at(steps, /^codesign --force .*Helpers\/BugSplatMonitor$/);
    assert.ok(build < monitor && build < reporter, 'merged after the build');
    assert.ok(monitor < signHelper && reporter < signHelper, 'merged before signing, so the signature covers both');
    // A single-architecture release has nothing to merge.
    assert.ok(!dryRun('--arch', 'arm64').steps.some(s => /^lipo -create/.test(s)));
});
