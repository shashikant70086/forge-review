import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ignore from 'ignore';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 5000;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const EXCLUDED_DIRECTORIES = new Set(['.git', '.svn', '.hg', '.ssh', '.aws', '.azure', '.codex', '.agents', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', 'dist', 'build', 'coverage']);
const STOP_WORDS = new Set('a an and are as at be by can code for from has have in into is it its me new of on or our please that the their this to update use using was we what when where which with you your add'.split(' '));

export interface SearchMatch {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  reason: string;
  score: number;
}

export interface ContextResult {
  text: string;
  items: SearchMatch[];
  usedChars: number;
  budgetChars: number;
  truncated: boolean;
}

export interface CommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface CommandResult {
  exitCode: number | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
}

function isSensitive(relativePath: string): boolean {
  const parts = relativePath.toLowerCase().split('/');
  return parts.some(part => EXCLUDED_DIRECTORIES.has(part) || part === '.env' || part.startsWith('.env.') ||
    /^(credentials|secrets?)(\.|$)/.test(part) || /\.(pem|key|p12|pfx|keystore)$/.test(part) ||
    /^(id_rsa|id_ed25519|id_ecdsa|\.netrc|\.npmrc|\.pypirc)$/.test(part));
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Command cancelled.', 'AbortError');
}

function normalizeRelative(relativePath: string): string {
  if (!relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || relativePath.includes(':')) {
    throw new Error('Use a relative workspace path.');
  }
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized.split('/').some(part => part === '..')) throw new Error('Parent directory traversal is forbidden.');
  return path.posix.normalize(normalized);
}

export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private async allowedPath(relativePath: string, allowMissing = false): Promise<string> {
    const normalized = normalizeRelative(relativePath);
    if (isSensitive(normalized)) throw new Error('This path is excluded from agent access.');
    let current = await fs.realpath(this.root);
    const root = current;
    for (const part of normalized.split('/')) {
      current = path.join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error('Symbolic links are excluded from agent access.');
      } catch (error) {
        if (!(allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
      }
    }
    const relative = path.relative(root, current);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Path escapes the workspace.');
    return current;
  }

  async readFile(relativePath: string): Promise<string> {
    const filename = await this.allowedPath(relativePath);
    const file = await fs.open(filename, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('The requested path is not a regular file.');
      if (stat.size > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES}-byte read limit.`);
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_FILE_BYTES) throw new Error('File grew beyond the read limit.');
      const content = buffer.subarray(0, bytesRead);
      if (content.includes(0)) throw new Error('Binary files cannot be read as context.');
      return new TextDecoder('utf-8', { fatal: true }).decode(content);
    } finally {
      await file.close();
    }
  }

  async listFiles(): Promise<string[]> {
    const root = await fs.realpath(this.root);
    const files: string[] = [];
    const walk = async (directory: string, inherited: Array<{ prefix: string; matcher: ReturnType<typeof ignore> }>, depth: number): Promise<void> => {
      if (depth > 40) throw new Error('Workspace exceeds the directory depth limit.');
      const prefix = path.relative(root, directory).split(path.sep).join('/');
      const rules = [...inherited];
      try {
        const ignoreFile = path.join(directory, '.gitignore');
        const stat = await fs.lstat(ignoreFile);
        if (stat.isFile() && stat.size <= MAX_FILE_BYTES) rules.push({ prefix, matcher: ignore().add(await fs.readFile(ignoreFile, 'utf8')) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink() || isSensitive(relative)) continue;
        const ignored = rules.some(rule => {
          const local = rule.prefix ? relative.slice(rule.prefix.length + 1) : relative;
          return rule.matcher.ignores(local + (entry.isDirectory() ? '/' : ''));
        });
        if (ignored) continue;
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), rules, depth + 1);
        if (entry.isFile()) files.push(relative);
        if (files.length > MAX_FILES) throw new Error(`Workspace exceeds the ${MAX_FILES}-file limit. Open a smaller workspace or extend .gitignore.`);
      }
    };
    await walk(root, [], 0);
    return files;
  }

  async search(query: string): Promise<SearchMatch[]> {
    if (query.length > 16000) throw new Error('Search query exceeds 16,000 characters.');
    const words = [...new Set(query.toLowerCase().match(/[a-z_][a-z0-9_]{1,}/g) ?? [])].filter(word => !STOP_WORDS.has(word)).slice(0, 32);
    if (words.length === 0) return [];
    const matches: SearchMatch[] = [];
    for (const filename of await this.listFiles()) {
      let content: string;
      try { content = await this.readFile(filename); } catch { continue; }
      const lines = content.split(/\r?\n/);
      const pathMatches = words.filter(word => filename.toLowerCase().includes(word));
      let previousEnd = -1;
      let windows = 0;
      for (let index = 0; index < lines.length && windows < 3; index++) {
        if (index <= previousEnd) continue;
        const matched = words.filter(word => lines[index].toLowerCase().includes(word));
        if (matched.length === 0 && !(index === 0 && pathMatches.length > 0)) continue;
        const start = Math.max(0, index - 3);
        const end = Math.min(lines.length - 1, index + 5);
        matches.push({ path: filename, startLine: start + 1, endLine: end + 1, text: lines.slice(start, end + 1).join('\n'),
          reason: `Matched ${[...new Set([...pathMatches, ...matched])].join(', ')}${pathMatches.length ? ' in path and content' : ' in content'}`,
          score: matched.length * 2 + pathMatches.length * 4 });
        previousEnd = end + 3;
        windows++;
      }
    }
    return matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine).slice(0, 60);
  }

  async retrieve(query: string, budgetChars = 12000): Promise<ContextResult> {
    if (!Number.isSafeInteger(budgetChars) || budgetChars < 0 || budgetChars > 64000) throw new Error('Context budget must be an integer between 0 and 64,000 characters.');
    const explicitPaths = [...query.matchAll(/@file\(([^)]+)\)|@file:([^\s]+)|@([\w./\\-]+\.[\w-]+)/g)].map(match => match[1] ?? match[2] ?? match[3]);
    const candidates: SearchMatch[] = [];
    for (const filename of [...new Set(explicitPaths)]) {
      const text = await this.readFile(filename);
      candidates.push({ path: normalizeRelative(filename), startLine: 1, endLine: text.split('\n').length, text, reason: 'Explicit @file reference', score: Number.MAX_SAFE_INTEGER });
    }
    const explicitSet = new Set(candidates.map(item => item.path));
    candidates.push(...(await this.search(query)).filter(item => !explicitSet.has(item.path)));
    let text = '';
    const items: SearchMatch[] = [];
    let truncated = false;
    for (const candidate of candidates) {
      const header = `${candidate.path}:${candidate.startLine}-${candidate.endLine} — ${candidate.reason}\n`;
      const remaining = budgetChars - text.length - header.length - 2;
      if (remaining < 1) { truncated = true; continue; }
      const snippet = candidate.text.slice(0, remaining);
      const item = { ...candidate, text: snippet, endLine: candidate.startLine + snippet.split('\n').length - 1 };
      const accurateHeader = `${item.path}:${item.startLine}-${item.endLine} — ${item.reason}\n`;
      text += accurateHeader + snippet + '\n\n';
      items.push(item);
      if (snippet.length < candidate.text.length) truncated = true;
    }
    return { text, items, usedChars: text.length, budgetChars, truncated };
  }

  async runCommand(command: string, args: string[], staged = new Map<string, string>(), options: CommandOptions = {}): Promise<CommandResult> {
    if (!command || command.includes('\0') || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid executable or arguments.');
    const timeoutMs = options.timeoutMs ?? 60000;
    const maxOutputChars = options.maxOutputChars ?? 24000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Command timeout must be between 1 and 120,000 ms.');
    if (!Number.isInteger(maxOutputChars) || maxOutputChars < 1 || maxOutputChars > 100000) throw new Error('Command output limit must be between 1 and 100,000 characters.');
    abortIfNeeded(options.signal);
    const snapshot = await fs.mkdtemp(path.join(tmpdir(), 'trueforge-workspace-'));
    try {
      let totalBytes = 0;
      for (const filename of await this.listFiles()) {
        abortIfNeeded(options.signal);
        const source = await this.allowedPath(filename);
        const stat = await fs.stat(source);
        totalBytes += stat.size;
        if (totalBytes > MAX_SNAPSHOT_BYTES) throw new Error('Workspace exceeds the 32 MiB command snapshot limit.');
        const destination = path.join(snapshot, filename);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(source, destination);
      }
      for (const [filename, content] of staged) {
        abortIfNeeded(options.signal);
        await this.allowedPath(filename, true);
        totalBytes += Buffer.byteLength(content);
        if (totalBytes > MAX_SNAPSHOT_BYTES) throw new Error('Staged files exceed the command snapshot limit.');
        const destination = path.join(snapshot, normalizeRelative(filename));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, content);
      }
      abortIfNeeded(options.signal);
      return await new Promise<CommandResult>((resolve, reject) => {
        // This working-directory copy is not an OS sandbox. The caller must obtain
        // approval for the exact executable and arguments before invoking it.
        const child = spawn(command, args, { cwd: snapshot, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        let truncated = false;
        let timedOut = false;
        let cancelled = false;
        const terminate = (): void => {
          if (!child.pid) return;
          if (process.platform === 'win32') {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.on('error', () => child.kill());
            killer.on('exit', code => { if (code !== 0) child.kill(); });
          } else {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
          }
        };
        const onAbort = (): void => { cancelled = true; terminate(); };
        const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
        const consume = (chunk: string): void => {
          const available = maxOutputChars - output.length;
          output += chunk.slice(0, available);
          if (chunk.length > available) { truncated = true; terminate(); }
        };
        child.stdout.setEncoding('utf8').on('data', consume);
        child.stderr.setEncoding('utf8').on('data', consume);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted) onAbort();
        const cleanup = (): void => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); };
        child.on('error', error => { cleanup(); reject(error); });
        child.on('close', exitCode => {
          cleanup();
          if (cancelled) reject(new DOMException('Command cancelled.', 'AbortError'));
          else resolve({ exitCode, output, truncated, timedOut });
        });
      });
    } finally {
      // mkdtemp creates this path exclusively for this invocation.
      await fs.rm(snapshot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}
