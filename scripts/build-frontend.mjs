// Assembles the files the desktop app ships into dist/. The website is served
// straight from the repo root by GitHub Pages, so this only selects what the
// app needs (no CNAME, sitemap, social images, etc.).
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

export const FILES = ['index.html', 'js', 'favicon.ico', 'marky.png', 'web.svg', 'discord.svg', 'github.svg', 'x.svg'];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const file of FILES) {
    cpSync(join(root, file), join(dist, file), { recursive: true });
}
console.log(`Built frontend into dist/ (${FILES.length} entries)`);
