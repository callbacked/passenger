import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// Private local secrets live in the ignored .dev.vars file; missing keys are added with random values.
const file = new URL('../.dev.vars', import.meta.url);
const required = ['MEDIA_SIGNING_SECRET', 'BETTER_AUTH_SECRET'];
let current = '';
try { current = await readFile(file, 'utf8'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const missing = required.filter(name => !new RegExp(`^${name}=`, 'm').test(current));
if (missing.length) {
  const lines = missing.map(name => `${name}=${randomBytes(32).toString('hex')}`);
  const separator = current && !current.endsWith('\n') ? '\n' : '';
  await writeFile(file, `${current}${separator}${lines.join('\n')}\n`, { mode: 0o600 });
  console.log(`Created private local keys in .dev.vars: ${missing.join(', ')}.`);
}
