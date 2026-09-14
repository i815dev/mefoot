import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const target = process.argv[2];
if (!['staging', 'production'].includes(target)) throw new Error('Choose staging or production.');
const expected = process.env.RELEASE_SHA;
if (!/^[a-f0-9]{40}$/.test(expected || '')) throw new Error('A full RELEASE_SHA is required for deployment.');
const manifest = JSON.parse(readFileSync('build/manifest.json', 'utf8'));
if (manifest.format !== 1 || manifest.sha !== expected) throw new Error('Release version does not match the approved commit.');
const root = resolve('build');
for (const [path, digest] of Object.entries(manifest.files)) {
  const absolute = resolve(root, path);
  if (!absolute.startsWith(root + sep) || !lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) {
    throw new Error('Invalid release file.');
  }
  const actual = createHash('sha256').update(readFileSync(absolute)).digest('hex');
  if (actual !== digest) throw new Error(`Release checksum mismatch: ${path}`);
}
function checkUnlisted(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) checkUnlisted(resolve(directory, entry.name), path + '/');
    else if (!entry.isFile() || (path !== 'manifest.json' && !(path in manifest.files))) {
      throw new Error(`Unexpected release file: ${path}`);
    }
  }
}
checkUnlisted(root);
if (manifest.workerFile !== 'worker/index.js' || !manifest.files[manifest.workerFile] || !manifest.files['assets/index.html']) {
  throw new Error('Required release entry points are missing.');
}
if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN) {
  throw new Error('Set the Cloudflare account ID and deployment token in GitHub settings first.');
}
const urlText = process.env[target === 'staging' ? 'STAGING_URL' : 'PRODUCTION_URL'];
if (!urlText) throw new Error('Set the deployment URL in GitHub repository variables first.');
const url = new URL(urlText);
if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
  throw new Error('Deployment URL must be an HTTPS origin.');
}
const customDomain = target === 'production' ? process.env.PRODUCTION_DOMAIN : undefined;
if (customDomain && (url.hostname !== customDomain || !/^[a-z0-9.-]+$/.test(customDomain))) {
  throw new Error('PRODUCTION_DOMAIN must match PRODUCTION_URL.');
}

mkdirSync('.deploy', { recursive: true });
const config = {
  name: target === 'production' ? 'mefoot' : 'mefoot-staging',
  main: resolve('build', manifest.workerFile),
  compatibility_date: manifest.compatibilityDate,
  workers_dev: !customDomain,
  assets: {
    directory: resolve('build/assets'), binding: 'ASSETS',
    not_found_handling: 'single-page-application', run_worker_first: ['/api/*'],
  },
  vars: { APP_ENV: target },
  ...(customDomain ? { routes: [{ pattern: customDomain, custom_domain: true }] } : {}),
};
const configFile = `.deploy/${target}.json`;
writeFileSync(configFile, JSON.stringify(config, null, 2));
execFileSync(process.execPath, [
  'node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', configFile, '--no-bundle',
], { stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
execFileSync(process.execPath, ['scripts/smoke.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, SMOKE_URL: url.origin, EXPECTED_VERSION: expected, EXPECTED_ENV: target },
});
