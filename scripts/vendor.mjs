// Copies third-party browser bundles from node_modules into js/vendor/ so the
// site (GitHub Pages, no build step) and the desktop app work offline.
// Run after bumping a dependency: npm run vendor
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(root, 'js', 'vendor');
mkdirSync(vendorDir, { recursive: true });

copyFileSync(join(root, 'node_modules/marked/lib/marked.umd.js'), join(vendorDir, 'marked.umd.js'));
console.log('Vendored marked ->', 'js/vendor/marked.umd.js');
