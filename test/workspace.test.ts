import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Workspace } from '../src/workspace';

async function fixture(): Promise<{ directory: string; workspace: Workspace; cleanup: () => Promise<void> }> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'forge-workspace-test-'));
  return { directory, workspace: new Workspace(directory), cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test('workspace blocks traversal, absolute paths, secrets and symlinks', async t => {
  const { directory, workspace, cleanup } = await fixture();
  t.after(cleanup);
  await fs.writeFile(path.join(directory, 'safe.ts'), 'export const answer = 42;');
  await fs.writeFile(path.join(directory, '.env'), 'KEY=secret');
  for (const filename of ['../outside', '/etc/passwd', 'C:\\secret', 'safe.ts:stream', '.env']) {
    await assert.rejects(workspace.readFile(filename));
  }
  await fs.mkdir(path.join(directory, 'real'));
  await fs.writeFile(path.join(directory, 'real', 'file.txt'), 'value');
  await fs.symlink(path.join(directory, 'real'), path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(workspace.readFile('linked/file.txt'), /Symbolic links/);
  assert.deepEqual(await workspace.listFiles(), ['real/file.txt', 'safe.ts']);
});

test('index respects nested gitignore and excludes dependency directories', async t => {
  const { directory, workspace, cleanup } = await fixture();
  t.after(cleanup);
  await fs.mkdir(path.join(directory, 'src'));
  await fs.mkdir(path.join(directory, 'node_modules'));
  await fs.writeFile(path.join(directory, '.gitignore'), '*.log\n');
  await fs.writeFile(path.join(directory, 'src', '.gitignore'), 'generated.ts\n');
  await fs.writeFile(path.join(directory, 'src', 'generated.ts'), 'secret');
  await fs.writeFile(path.join(directory, 'src', 'ok.ts'), 'visible');
  await fs.writeFile(path.join(directory, 'debug.log'), 'hidden');
  await fs.writeFile(path.join(directory, 'node_modules', 'index.js'), 'hidden');
  assert.deepEqual(await workspace.listFiles(), ['.gitignore', 'src/.gitignore', 'src/ok.ts']);
});

test('retrieval has a strict total budget and prioritizes explicit files', async t => {
  const { directory, workspace, cleanup } = await fixture();
  t.after(cleanup);
  await fs.writeFile(path.join(directory, 'config.py'), 'def config():\n    return {"secret": "value"}\n'.repeat(100));
  await fs.writeFile(path.join(directory, 'readme.md'), 'Document configuration commands.');
  const result = await workspace.retrieve('Explain config @file(readme.md)', 250);
  assert.equal(result.items[0].path, 'readme.md');
  assert.equal(result.usedChars, result.text.length);
  assert.ok(result.usedChars <= 250);
  assert.equal(result.truncated, true);
  assert.equal((await workspace.retrieve('config', 0)).text, '');
  await assert.rejects(workspace.retrieve('config', -1));
});

test('command sees staged edits and keeps source files intact', async t => {
  const { directory, workspace, cleanup } = await fixture();
  t.after(cleanup);
  await fs.writeFile(path.join(directory, 'input.txt'), 'before');
  const result = await workspace.runCommand(process.execPath, ['-e', 'const fs=require("fs"); console.log(fs.readFileSync("input.txt","utf8")); fs.writeFileSync("input.txt","command wrote");'], new Map([['input.txt', 'staged']]));
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.trim(), 'staged');
  assert.equal(await workspace.readFile('input.txt'), 'before');
});

test('command cancellation, timeout and output bounds terminate execution', async t => {
  const { workspace, cleanup } = await fixture();
  t.after(cleanup);
  const abort = new AbortController();
  const command = workspace.runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], new Map(), { signal: abort.signal });
  setTimeout(() => abort.abort(), 250);
  await assert.rejects(command, { name: 'AbortError' });
  const timedOut = await workspace.runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], new Map(), { timeoutMs: 250 });
  assert.equal(timedOut.timedOut, true);
  const bounded = await workspace.runCommand(process.execPath, ['-e', 'console.log("x".repeat(10000))'], new Map(), { maxOutputChars: 128 });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.output.length, 128);
});
