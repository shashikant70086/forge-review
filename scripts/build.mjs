import { build } from 'esbuild';
import fs from 'node:fs/promises';
const result = await build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], outfile: 'dist/extension.js', sourcemap: true, metafile: true });
await fs.writeFile('dist/extension.meta.json', JSON.stringify(result.metafile));
await import('./notices.mjs');
