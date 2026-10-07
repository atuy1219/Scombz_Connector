import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

// Browser code is bundled separately and served as an inert HTML resource.
export async function buildWidget() {
  const result = await build({
    entryPoints: ['src/file-widget-client.mjs'],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
  });
  await mkdir('dist', { recursive: true });
  await writeFile(
    'dist/file-widget-script.mjs',
    `export default ${JSON.stringify(result.outputFiles[0].text)};\n`,
  );
}
