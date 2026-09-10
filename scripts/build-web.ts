// Bundles the browser code in web/ into the static assets wrangler serves from public/.
import { build } from 'esbuild';

const entries = ['gate', 'app', 'approve'];
await build({
  entryPoints: entries.map(name => `web/${name}.ts`),
  outdir: 'public',
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  // gate.ts loads /app.js at runtime by URL; it stays a separate bundle.
  external: ['/app.js'],
  logLevel: 'warning',
});
console.log(`Built ${entries.map(name => `public/${name}.js`).join(', ')}.`);
