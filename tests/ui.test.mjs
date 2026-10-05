import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { html, script } from '../src/ui.mjs';

function screen(status) {
  const elements = new Map(
    [...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [
      id,
      {
        value: '',
        textContent: '',
        hidden: false,
        open: false,
        disabled: false,
        classList: { toggle() {} },
        focus() {},
      },
    ]),
  );
  const calls = [];
  const context = vm.createContext({
    document: { getElementById: (id) => elements.get(id) },
    location: { origin: 'https://fixture.workers.dev' },
    navigator: {},
    confirm: () => true,
    fetch: async (path, options = {}) => {
      calls.push({ path, options });
      const result =
        path === '/health'
          ? { configured: true }
          : path === '/api/mobile/login'
            ? { connected: true, authenticated: true, reauthentication_required: false }
            : status;
      return {
        ok: true,
        async json() {
          return result;
        },
      };
    },
  });
  vm.runInContext(script, context);
  return { elements, calls };
}

test('connected screen hides credentials until re-login and clears the password after login', async () => {
  const { elements, calls } = screen({
    connected: true,
    authenticated: true,
    reauthentication_required: false,
  });
  const get = (id) => elements.get(id);
  get('key').value = 'fixture-management-key';
  await get('unlock').onclick();
  assert.equal(get('status').textContent, '接続済み');
  assert.equal(get('login-form').open, false);
  get('relogin').onclick();
  assert.equal(get('login-form').open, true);
  get('mobile-user').value = 'AL00000';
  get('mobile-password').value = 'fixture-password';
  await get('mobile-login').onclick();
  assert.equal(get('login-form').open, false);
  assert.equal(get('mobile-password').value, '');
  assert.deepEqual(JSON.parse(calls.find((x) => x.path === '/api/mobile/login').options.body), {
    user: 'AL00000',
    password: 'fixture-password',
  });
  get('mobile-password').value = 'unsent';
  get('lock').onclick();
  assert.equal(get('mobile-password').value, '');
  assert.equal(get('private').hidden, true);
});

test('only missing root authentication automatically opens the login form', async () => {
  for (const authenticated of [true, false]) {
    const { elements } = screen({
      connected: false,
      authenticated,
      reauthentication_required: !authenticated,
      message: authenticated ? '接続を確認してください。' : '再ログインしてください。',
    });
    elements.get('key').value = 'fixture-key';
    await elements.get('unlock').onclick();
    assert.equal(elements.get('login-form').open, !authenticated);
  }
});
