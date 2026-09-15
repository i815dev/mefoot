import { resolve } from 'node:path';

export function deploymentConfig({ target, manifest, customDomain, apiOriginText }) {
  let apiOrigin;
  if (apiOriginText) {
    const url = new URL(apiOriginText);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('API_ORIGIN must be an HTTPS origin without credentials or a path.');
    }
    apiOrigin = url.origin;
  }
  return {
    name: target === 'production' ? 'mefoot' : 'mefoot-staging',
    main: resolve('build', manifest.workerFile),
    compatibility_date: manifest.compatibilityDate,
    workers_dev: !customDomain,
    assets: {
      directory: resolve('build/assets'), binding: 'ASSETS',
      not_found_handling: 'single-page-application', run_worker_first: ['/api/*'],
    },
    vars: { APP_ENV: target, ...(apiOrigin ? { API_ORIGIN: apiOrigin } : {}) },
    ...(customDomain ? { routes: [{ pattern: customDomain, custom_domain: true }] } : {}),
  };
}
