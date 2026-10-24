// Builds the embeddable widget into web/dist/:
//   connect.html  (static shell)   connect.css   connect.js (bundle incl. Stellar Wallets Kit)
// The backend serves this folder at /widget/. Run with `npm run build:web`.
import { build } from 'esbuild';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(webDir, 'dist');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const result = await build({
  entryPoints: { connect: join(webDir, 'src/main.ts') },
  outdir: outDir,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020', 'chrome100', 'firefox100', 'safari15'],
  minify: true,
  sourcemap: false,
  legalComments: 'eof',
  metafile: true,
  logLevel: 'warning',
  define: {
    'process.env.NODE_ENV': '"production"',
    global: 'globalThis',
  },
});

await copyFile(join(webDir, 'connect.html'), join(outDir, 'connect.html'));
await copyFile(join(webDir, 'connect.css'), join(outDir, 'connect.css'));

for (const name of ['connect.html', 'connect.css', 'connect.js']) {
  const { size } = await stat(join(outDir, name));
  console.log(`web/dist/${name.padEnd(13)} ${(size / 1024).toFixed(1).padStart(8)} KiB`);
}
if (result.warnings.length > 0) console.log(`${result.warnings.length} esbuild warning(s)`);
