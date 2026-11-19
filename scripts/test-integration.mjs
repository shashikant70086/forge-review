import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import path from 'node:path';
await build({ entryPoints: ['test/editor.integration.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: 'dist/editor.integration.js' });
await runTests({ extensionDevelopmentPath: process.cwd(), extensionTestsPath: path.resolve('dist/editor.integration.js'), launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes'], ...(process.env.VSCODE_EXECUTABLE ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE } : {}) });
