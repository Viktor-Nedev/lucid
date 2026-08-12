/**
 * Build-time smoke test for the AI layer.
 *
 *   node scripts/check-bundle.mjs      (npm run check)
 *
 * WHY THIS EXISTS. Today every background/handlers/*.ts file is a stub that
 * never calls getAIClient(), so esbuild tree-shakes the whole AI layer - and
 * with it the Anthropic SDK - straight out of background.js. The shipped
 * bundle therefore proves nothing about whether the SDK bundles for an MV3
 * service worker. The first person to fill in a handler would be the one to
 * discover it if it did not.
 *
 * So this bundles a probe entry that deliberately references the AI layer, and
 * asserts three things about the result:
 *
 *   1. it bundles at all for platform:browser (the Anthropic SDK must not drag
 *      in a node builtin that only resolves under platform:node)
 *   2. the Anthropic SDK is really in there, not silently shaken out
 *   3. no unresolved dynamic import() survives - an MV3 service worker cannot
 *      call import() after its initial evaluation, so one would be a runtime
 *      failure that only fires for whichever provider the user selected
 *
 * Run it after touching anything under src/background/ai/.
 */

import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const probe = `
  import { getAIClient, resetAIClient } from './src/background/ai/client.ts';
  // Reference both so nothing can be tree-shaken away.
  globalThis.__lucidProbe = { getAIClient, resetAIClient };
`;

const result = await esbuild.build({
  stdin: { contents: probe, resolveDir: root, sourcefile: 'probe.ts', loader: 'ts' },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: ['chrome116'],
  logLevel: 'silent',
});

const output = result.outputFiles[0];
if (!output) {
  console.error('check-bundle: esbuild produced no output');
  process.exit(1);
}

const code = output.text;
const failures = [];

if (!/anthropic/i.test(code)) {
  failures.push('the Anthropic SDK is not present in the bundle');
}
if (!/generativelanguage\.googleapis\.com/.test(code)) {
  failures.push('the Gemini adapter is not present in the bundle');
}

// esbuild rewrites bundled dynamic imports; anything left is a real runtime one.
//
// Scan with string literals blanked out first. The Anthropic SDK carries the
// text "import('node:buffer').File" inside an error message, and matching that
// as if it were code is a false positive that makes this check useless.
const withoutStrings = code
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``');

const dynamicImports = withoutStrings.match(/\bimport\s*\(/g) ?? [];
if (dynamicImports.length > 0) {
  failures.push(
    `${dynamicImports.length} runtime import() call(s) survived - MV3 service workers cannot use dynamic import`,
  );
}

const sizeKb = (output.contents.byteLength / 1024).toFixed(1);

if (failures.length > 0) {
  console.error('check-bundle FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`check-bundle ok - AI layer bundles cleanly (${sizeKb}kb with both providers)`);
