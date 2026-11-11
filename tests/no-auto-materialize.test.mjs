import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('sensitive PDF URL tools do not emit MCP resource links that initiate materialization', async () => {
  const source = await readFile(new URL('../src/mcp.mjs', import.meta.url), 'utf8');
  for (const [start, end] of [
    ["'prepare_pdf_relay_url'", "'prepare_otkey_file_url'"],
    ["'prepare_otkey_file_url'", "'prepare_file_download'"],
  ]) {
    const section = source.split(start, 2)[1]?.split(end, 1)[0];
    assert.ok(section, start + ' missing');
    assert.ok(!section.includes("type: 'resource_link'"), start + ' must not return file attachments');
    assert.ok(section.includes('_summary:'), start + ' must return a safe summary');
  }
});
