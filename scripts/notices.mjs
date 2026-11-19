import fs from 'node:fs/promises';
import path from 'node:path';
const meta = JSON.parse(await fs.readFile('dist/extension.meta.json', 'utf8'));
const roots = new Set();
for (const input of Object.keys(meta.inputs)) {
  if (!input.startsWith('node_modules/')) continue;
  const parts = input.split('/');
  roots.add(parts.slice(0, parts[1].startsWith('@') ? 3 : 2).join('/'));
}
const notices = [];
for (const root of [...roots].sort()) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const files = await fs.readdir(root);
  const license = files.find(file => /^licen[sc]e(?:\.|$)/i.test(file));
  notices.push(`${pkg.name} ${pkg.version}\n${license ? await fs.readFile(path.join(root, license), 'utf8') : `License: ${pkg.license}. See the upstream package for full terms.`}`);
}
await fs.writeFile('THIRD-PARTY-NOTICES.txt', notices.join('\n\n--------------------\n\n'));
