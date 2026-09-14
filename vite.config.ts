import { defineConfig } from 'vite';

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(process.env.RELEASE_SHA || 'local') },
  plugins: [{
    name: 'release-version',
    transformIndexHtml(html) {
      return html.replace('__RELEASE_SHA__', process.env.RELEASE_SHA || 'local');
    },
  }],
});
