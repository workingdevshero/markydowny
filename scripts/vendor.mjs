// Copies third-party browser bundles from node_modules into js/vendor/ so the
// site (GitHub Pages, no build step) and the desktop app work offline.
// Run after bumping a dependency: npm run vendor
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(root, 'js', 'vendor');
mkdirSync(vendorDir, { recursive: true });

copyFileSync(join(root, 'node_modules/marked/lib/marked.umd.js'), join(vendorDir, 'marked.umd.js'));
console.log('Vendored marked ->', 'js/vendor/marked.umd.js');

// CodeMirror ships only as ES modules: bundle what the editor uses into one classic script
// that sets window.MarkyCodeMirror. app.js loads it on first edit, never on page load.
await build({
    entryPoints: [join(root, 'scripts/codemirror-entry.mjs')],
    outfile: join(vendorDir, 'codemirror.js'),
    bundle: true,
    format: 'iife',
    globalName: 'MarkyCodeMirror',
    minify: true,
    target: ['es2020'],
    legalComments: 'eof',
    logLevel: 'warning',
});
console.log('Vendored CodeMirror ->', 'js/vendor/codemirror.js');
