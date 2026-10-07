import { build } from 'esbuild';
import { buildWidget } from './widget-build.mjs';
await buildWidget();
await build({
  entryPoints: ['src/worker.mjs'],
  outfile: 'dist/worker.mjs',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  external: ['node:*'],
});
