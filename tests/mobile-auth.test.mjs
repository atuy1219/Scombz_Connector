import test from 'node:test';
import assert from 'node:assert/strict';
import { MobileAuthClient } from '../src/mobile-auth.mjs';

class MemoryStore {
  constructor() {
    this.value = null;
  }
  async load() {
    return this.value;
  }
  async save(value) {
    this.value = structuredClone(value);
  }
  async clear() {
    this.value = null;
  }
  async exists() {
    return !!this.value;
  }
}

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

test('Mobile API login stores only the bearer token and OTKEY bridge yields SESSION', async () => {
  const store = new MemoryStore();
  const seen = [];
  const client = new MobileAuthClient(
    {},
    {
      store,
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        seen.push({ url: url.href, method: init.method, authorization: init.headers?.Authorization });
        if (url.pathname.endsWith('/smob/api/login')) {
          assert.deepEqual(JSON.parse(init.body), { user: 'AL00000', pass: 'secret-password' });
          return json({ status: 'OK', token: 'mobile-bearer-token', user_type: 'student' });
        }
        if (url.pathname.endsWith('/smob/api/sessionid')) {
          assert.equal(init.headers.Authorization, 'Bearer mobile-bearer-token');
          return json({ sessionid: null });
        }
        if (url.pathname.endsWith('/smob/api/otkey')) {
          assert.equal(init.headers.Authorization, 'Bearer mobile-bearer-token');
          return json({ status: 'OK', otkey: 'one-time-key' });
        }
        if (url.pathname.includes('/smob/api/timetable/')) {
          assert.equal(init.headers.Authorization, 'Bearer mobile-bearer-token');
          return json([{ classId: 'COURSE1' }]);
        }
        if (url.host === 'mobile.scombz.shibaura-it.ac.jp') {
          assert.equal(url.pathname, '/one-time-key/lms/course');
          assert.equal(url.searchParams.get('idnumber'), 'COURSE1');
          return new Response(null, {
            status: 302,
            headers: {
              Location: 'https://scombz.shibaura-it.ac.jp/portal/home',
              'Set-Cookie': 'SESSION=web-session-value; Path=/; Secure; HttpOnly',
            },
          });
        }
        assert.fail('unexpected request: ' + url.href);
      },
    },
  );

  const loggedIn = await client.login(' AL00000 ', 'secret-password');
  assert.deepEqual(loggedIn, {
    authenticated: true,
    user_type: 'student',
    token_stored: true,
    password_stored: false,
  });
  assert.deepEqual(store.value, { token: 'mobile-bearer-token' });
  assert.deepEqual(await client.getSessionIdState(), { available: false, length: 0 });

  const exchanged = await client.exchangeOtkey();
  assert.equal(exchanged.otkey_received, true);
  assert.equal(exchanged.session.value, 'web-session-value');
  assert.equal(exchanged.session.domain, 'scombz.shibaura-it.ac.jp');
  assert.equal(exchanged.diagnostics[0].session_cookie_received, true);
  assert.ok(!JSON.stringify(exchanged.diagnostics).includes('one-time-key'));
  assert.ok(!JSON.stringify(loggedIn).includes('mobile-bearer-token'));
  assert.ok(!JSON.stringify(loggedIn).includes('secret-password'));
  assert.ok(seen.length >= 4);
});

test('OTKEY bridge never follows redirects outside ScombZ hosts', async () => {
  const store = new MemoryStore();
  store.value = { token: 'mobile-bearer-token' };
  const client = new MobileAuthClient(
    {},
    {
      store,
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        if (url.pathname.endsWith('/smob/api/otkey'))
          return json({ status: 'OK', otkey: 'one-time-key' });
        if (url.pathname.includes('/smob/api/timetable/')) return json([{ classId: 'COURSE1' }]);
        if (url.host === 'mobile.scombz.shibaura-it.ac.jp')
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://evil.example/collect' },
          });
        assert.fail('foreign redirect must not be fetched: ' + url.href);
      },
    },
  );

  const exchanged = await client.exchangeOtkey();
  assert.equal(exchanged.session, null);
  assert.equal(exchanged.diagnostics.some((x) => x.blocked === true), true);
});

test('expired Mobile API token is discarded', async () => {
  const store = new MemoryStore();
  store.value = { token: 'expired-token' };
  const client = new MobileAuthClient(
    {},
    {
      store,
      fetch: async () => json({ message: 'expired' }, 401),
    },
  );
  await assert.rejects(() => client.getOtkey(), (error) => error.code === 'mobile_auth_required');
  assert.equal(store.value, null);
});
