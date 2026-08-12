/**
 * Lucid build.
 *
 *   node scripts/build.mjs            one-shot production bundle into dist/
 *   node scripts/build.mjs --watch    rebuild on save (unminified, inline sourcemaps)
 *
 * Load the extension from dist/, not from the repo root.
 */
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

/** Files copied verbatim into dist/ on every build. */
const statics = [
  ['public/manifest.json', 'manifest.json'],
  ['public/icons', 'icons'],
  ['src/options/options.html', 'options.html'],
  ['src/offscreen/offscreen.html', 'offscreen.html'],
  // Optional: design-owned overrides, adopted into the panel and overlay shadow
  // roots at runtime when present. Absent in a bare checkout, which is fine.
  ['src/styles', 'styles'],
];

async function copyStatics() {
  for (const [from, to] of statics) {
    const src = path.join(root, from);
    if (!existsSync(src)) continue;
    await cp(src, path.join(outdir, to), { recursive: true });
  }
}

/**
 * The bundles build in parallel, so their onEnd hooks fire concurrently -
 * two overlapping recursive copies of the same directory race and one loses
 * with EEXIST. Chaining them keeps copies serial without serialising builds.
 */
let copyChain = Promise.resolve();
function copyStaticsSerial() {
  copyChain = copyChain.then(copyStatics, copyStatics);
  return copyChain;
}

/** Copy static assets after each (re)build so watch mode picks up manifest edits too. */
const copyPlugin = {
  name: 'lucid-copy-statics',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length) return;
      await copyStaticsSerial();
      if (watch) console.log(`[lucid] rebuilt ${new Date().toLocaleTimeString()}`);
    });
  },
};

const shared = {
  bundle: true,
  target: ['chrome116'],
  platform: 'browser',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  plugins: [copyPlugin],
};

/**
 * Three separate bundles, because Chrome loads them in three different ways:
 *  - the service worker is an ES module (manifest declares "type": "module")
 *  - content scripts are NOT modules, so that bundle must be a self-contained IIFE
 *  - the options page is a normal page script loaded as a module
 */
const targets = [
  { entryPoints: [path.join(root, 'src/background/service-worker.ts')], outfile: path.join(outdir, 'background.js'), format: 'esm' },
  { entryPoints: [path.join(root, 'src/content/index.ts')], outfile: path.join(outdir, 'content.js'), format: 'iife' },
  { entryPoints: [path.join(root, 'src/options/options.ts')], outfile: path.join(outdir, 'options.js'), format: 'esm' },
  { entryPoints: [path.join(root, 'src/offscreen/offscreen.ts')], outfile: path.join(outdir, 'offscreen.js'), format: 'esm' },
];

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

if (watch) {
  const contexts = await Promise.all(targets.map((t) => esbuild.context({ ...shared, ...t })));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[lucid] watching. load unpacked from dist/ and hit reload after each rebuild.');
} else {
  await Promise.all(targets.map((t) => esbuild.build({ ...shared, ...t })));
  await copyStaticsSerial();
  console.log('[lucid] build complete -> dist/');
}
