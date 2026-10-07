import test from 'node:test';
import assert from 'node:assert/strict';
import { ScombClient } from '../src/client.mjs';
const clientWith = (response) => {
  const client = new ScombClient({}, {});
  client.openMaterialFile = async (course, file, range) => {
    assert.equal(course, 'c');
    assert.equal(file, 'material:m:r');
    assert.ok(range.length <= 1024 * 1024);
    return { metadata: { filename: 'a.pdf' }, mime: 'application/pdf', response };
  };
  return client;
};
test('HTTP 206 validates content range and fetches a final short chunk', async () => {
  const client = clientWith(
    new Response(new Uint8Array([4, 5, 6]), {
      status: 206,
      headers: { 'Content-Range': 'bytes 4-6/7' },
    }),
  );
  const file = await client.materialChunk('c', 'material:m:r', 4, 5);
  assert.deepEqual([...file.bytes], [4, 5, 6]);
  assert.equal(file.total_bytes, 7);
  assert.equal(file.eof, true);
});
test('wrong ranges, truncated 206 and oversized totals fail closed', async () => {
  for (const header of ['bytes 3-5/7', 'bytes 4-6/104857601', 'bytes 4-6/7', 'invalid']) {
    const client = clientWith(
      new Response(new Uint8Array([4, 5]), {
        status: 206,
        headers: { 'Content-Range': header },
      }),
    );
    await assert.rejects(
      client.materialChunk('c', 'material:m:r', 4, 5),
      (e) => e.code === 'invalid_range',
    );
  }
});
test('ignored Range response is sliced and an exact boundary detects EOF', async () => {
  const file = await clientWith(new Response(new Uint8Array([0, 1, 2, 3]))).materialChunk(
    'c',
    'material:m:r',
    2,
    2,
  );
  assert.deepEqual([...file.bytes], [2, 3]);
  assert.equal(file.eof, true);
  const empty = await clientWith(new Response(null)).materialChunk('c', 'material:m:r', 0, 2);
  assert.equal(empty.eof, true);
  assert.equal(empty.bytes.length, 0);
});
