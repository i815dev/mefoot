import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

let sha = process.env.RELEASE_SHA;
if (!sha) {
  try { sha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { sha = 'local'; }
}
if (sha !== 'local' && !/^[a-f0-9]{40}$/.test(sha)) throw new Error('RELEASE_SHA must be a full commit SHA.');
const env = { ...process.env, RELEASE_SHA: sha, WRANGLER_SEND_METRICS: 'false' };
execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { env, stdio: 'inherit' });
rmSync('build', { recursive: true, force: true });
mkdirSync('build', { recursive: true });
execFileSync(process.execPath, [
  'node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--env', 'staging',
  '--outdir', 'build/worker', '--define', `RELEASE_SHA:${JSON.stringify(sha)}`,
], { env, stdio: 'inherit' });
cpSync('dist', 'build/assets', { recursive: true });
const workerFile = 'worker/index.js';
if (!existsSync(`build/${workerFile}`)) throw new Error('Expected Worker bundle was not generated.');

function hashes(directory, prefix = '') {
  const entries = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) Object.assign(entries, hashes(absolute, `${relative}/`));
    else if (entry.isFile()) entries[relative] = createHash('sha256').update(readFileSync(absolute)).digest('hex');
    else throw new Error('Release contains a non-regular file.');
  }
  return entries;
}

writeFileSync('build/manifest.json', JSON.stringify({
  format: 1,
  sha,
  compatibilityDate: '2026-09-14',
  workerFile,
  files: hashes('build'),
}, null, 2) + '\n');
console.log(`Release ready: ${sha}. No cloud resources changed.`);
