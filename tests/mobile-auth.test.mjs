import test from 'node:test';
import assert from 'node:assert/strict';
import { MobileAuthClient } from '../src/mobile-auth.mjs';
import { ScombClient } from '../src/client.mjs';
import { ScombError } from '../src/errors.mjs';

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
        seen.push({
          url: url.href,
          method: init.method,
          authorization: init.headers?.Authorization,
        });
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
  assert.equal(
    exchanged.diagnostics.some((x) => x.blocked === true),
    true,
  );
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
  await assert.rejects(
    () => client.getOtkey(),
    (error) => error.code === 'mobile_auth_required',
  );
  assert.equal(store.value, null);
});

test('ScombClient refreshes a missing ScombZ web session through OTKEY automatically', async () => {
  let stored = null;
  let exchanges = 0;
  const store = {
    async load() {
      return stored;
    },
    async save(value) {
      stored = structuredClone(value);
    },
  };
  const client = new ScombClient(
    {},
    {
      store,
      mobileClient: {
        async token() {
          return 'fixture-root-token';
        },
        async exchangeOtkey() {
          exchanges++;
          return {
            session: {
              name: 'SESSION',
              value: 'fresh-web-session',
              domain: 'scombz.shibaura-it.ac.jp',
              path: '/',
              secure: true,
              httpOnly: true,
              expires: -1,
            },
          };
        },
      },
      fetch: async (input, init = {}) => {
        assert.equal(new URL(input).origin, 'https://scombz.shibaura-it.ac.jp');
        assert.ok(init.headers.Cookie.includes('SESSION=fresh-web-session'));
        return new Response('<html><div id="page_head"></div><div>home</div></html>');
      },
    },
  );

  const status = await client.connection();
  assert.equal(status.connected, true);
  assert.equal(exchanges, 1);
  assert.equal(stored.cookies[0].value, 'fresh-web-session');
});

test('a cached SESSION cannot authenticate when the Mobile API bearer is missing', async () => {
  let reads = 0;
  const client = new ScombClient(
    {},
    {
      store: {
        async load() {
          assert.fail('cache must not be read without root authentication');
        },
      },
      mobileClient: {
        async token() {
          throw new ScombError('mobile_auth_required', 'missing bearer');
        },
      },
      fetch: async () => {
        reads++;
        assert.fail('upstream must not be accessed');
      },
    },
  );
  const status = await client.connection();
  assert.equal(status.connected, false);
  assert.equal(status.reauthentication_required, true);
  assert.equal(status.authenticated, false);
  assert.equal(reads, 0);
});

test('bridge failure keeps bearer authentication and does not request re-login', async () => {
  const client = new ScombClient(
    {},
    {
      store: new MemoryStore(),
      mobileClient: {
        async token() {
          return 'saved-bearer';
        },
        async exchangeOtkey() {
          return { session: null };
        },
      },
    },
  );
  const status = await client.connection();
  assert.equal(status.code, 'web_session_unavailable');
  assert.equal(status.authenticated, true);
  assert.equal(status.reauthentication_required, false);
});

test('a persistent Web login page has a bounded retry and preserves root authentication', async () => {
  let exchanges = 0;
  const client = new ScombClient(
    {},
    {
      store: new MemoryStore(),
      mobileClient: {
        async token() {
          return 'saved-bearer';
        },
        async exchangeOtkey() {
          exchanges++;
          return {
            session: {
              name: 'SESSION',
              value: 'cookie',
              domain: 'scombz.shibaura-it.ac.jp',
              path: '/',
              secure: true,
              expires: -1,
            },
          };
        },
      },
      fetch: async () => new Response('<form id="loginForm"></form>'),
    },
  );
  const status = await client.connection();
  assert.equal(status.code, 'web_session_unavailable');
  assert.equal(status.reauthentication_required, false);
  assert.equal(exchanges, 2);
});

test('an expired Web SESSION is renewed once without losing the bearer', async () => {
  const store = new MemoryStore();
  store.value = {
    cookies: [
      {
        name: 'SESSION',
        value: 'expired',
        domain: 'scombz.shibaura-it.ac.jp',
        path: '/',
        secure: true,
        expires: -1,
      },
    ],
    origins: [],
  };
  let exchanges = 0,
    requests = 0;
  const client = new ScombClient(
    {},
    {
      store,
      mobileClient: {
        async token() {
          return 'saved-bearer';
        },
        async exchangeOtkey() {
          exchanges++;
          return { session: { ...store.value.cookies[0], value: 'renewed' } };
        },
      },
      fetch: async (input, init) => {
        requests++;
        if (init.headers.Cookie.includes('SESSION=expired'))
          return new Response(null, { status: 401 });
        assert.ok(init.headers.Cookie.includes('SESSION=renewed'));
        return new Response('<div id="page_head"></div>');
      },
    },
  );
  const status = await client.connection();
  assert.equal(status.connected, true);
  assert.equal(status.reauthentication_required, false);
  assert.equal(exchanges, 1);
  assert.equal(requests, 2);
});
