'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const axios = require('axios');
const {
    AuthManager,
    CLIENT_ID,
    REDIRECT_URI,
} = require('../clone_modules/polestar-c3/auth');

const DISCOVERY_URL = 'https://polestarid.eu.polestar.com/.well-known/openid-configuration';
const AUTH_URL = 'https://polestarid.eu.polestar.com/as/authorization.oauth2';
const TOKEN_URL = 'https://polestarid.eu.polestar.com/as/token.oauth2';

function token(overrides = {}) {
    return {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 10 * 60_000,
        ...overrides,
    };
}

async function withAxios(stubs, run) {
    const originalGet = axios.get;
    const originalPost = axios.post;
    if (stubs.get) axios.get = stubs.get;
    if (stubs.post) axios.post = stubs.post;
    try {
        return await run();
    } finally {
        axios.get = originalGet;
        axios.post = originalPost;
    }
}

test('pins the Polestar app OAuth client and registered redirect', () => {
    assert.equal(CLIENT_ID, 'lp8dyrd_10');
    assert.equal(REDIRECT_URI, 'polestar-explore://explore.polestar.com');
});

test('restoreToken validates the public shape and getToken returns snapshots', () => {
    const auth = new AuthManager();
    const restored = token();
    auth.restoreToken(restored);

    restored.accessToken = 'changed-by-caller';
    const first = auth.getToken();
    assert.deepEqual(first, token({
        accessToken: 'access-token',
        expiresAt: first.expiresAt,
    }));

    first.refreshToken = 'changed-snapshot';
    assert.equal(auth.getToken().refreshToken, 'refresh-token');
    assert.deepEqual(Object.keys(auth.getToken()).sort(), [
        'accessToken',
        'expiresAt',
        'refreshToken',
    ]);

    for (const invalid of [
        null,
        [],
        {},
        token({ accessToken: '' }),
        token({ refreshToken: null }),
        token({ expiresAt: Number.NaN }),
        token({ expiresAt: 0 }),
    ]) {
        assert.throws(() => auth.restoreToken(invalid), /Token/);
    }
    assert.throws(() => auth.onTokenChanged(null), /callback must be a function/);
});

test('an unexpired restored token is used without network authentication', async () => {
    const auth = new AuthManager();
    auth.restoreToken(token());
    auth._discover = async () => {
        throw new Error('discovery must not run for an unexpired token');
    };
    auth._refresh = async () => {
        throw new Error('refresh must not run for an unexpired token');
    };

    assert.equal(await auth.ensureValidToken(), 'access-token');
});

test('restored expired token discovers the endpoint, refreshes with app client, and persists replacement', async () => {
    const auth = new AuthManager();
    auth.restoreToken(token({ expiresAt: Date.now() - 1 }));
    const changed = [];
    auth.onTokenChanged(async (next) => {
        await new Promise((resolve) => setImmediate(resolve));
        changed.push(next);
    });

    const startedAt = Date.now();
    await withAxios({
        get: async (url, options) => {
            assert.equal(url, DISCOVERY_URL);
            assert.equal(options.timeout, 30000);
            return {
                data: {
                    authorization_endpoint: AUTH_URL,
                    token_endpoint: TOKEN_URL,
                },
            };
        },
        post: async (url, body, options) => {
            assert.equal(url, TOKEN_URL);
            assert.equal(options.timeout, 30000);
            const form = new URLSearchParams(body);
            assert.equal(form.get('grant_type'), 'refresh_token');
            assert.equal(form.get('refresh_token'), 'refresh-token');
            assert.equal(form.get('client_id'), 'lp8dyrd_10');
            assert.equal(form.has('username'), false);
            assert.equal(form.has('password'), false);
            return {
                status: 200,
                data: {
                    access_token: 'refreshed-access',
                    refresh_token: 'replacement-refresh',
                    expires_in: 1800,
                },
            };
        },
    }, async () => {
        assert.equal(await auth.ensureValidToken(), 'refreshed-access');
    });

    assert.equal(changed.length, 1);
    assert.equal(changed[0].accessToken, 'refreshed-access');
    assert.equal(changed[0].refreshToken, 'replacement-refresh');
    assert.ok(changed[0].expiresAt >= startedAt + 1800 * 1000);
    assert.deepEqual(auth.getToken(), changed[0]);
});

test('refresh preserves the existing refresh token when the response omits it', async () => {
    const auth = new AuthManager();
    auth.restoreToken(token({ expiresAt: Date.now() - 1 }));
    auth._discover = async () => {
        auth._tokenEndpoint = TOKEN_URL;
        auth._authEndpoint = AUTH_URL;
    };

    await withAxios({
        post: async () => ({
            status: 200,
            data: {
                access_token: 'next-access',
                expires_in: 1800,
            },
        }),
    }, async () => {
        assert.equal(await auth.ensureValidToken(), 'next-access');
    });

    assert.equal(auth.getToken().refreshToken, 'refresh-token');
});

test('concurrent token checks share one refresh and one persistence notification', async () => {
    const auth = new AuthManager();
    auth.restoreToken(token({ expiresAt: Date.now() - 1 }));
    auth._discover = async () => {
        auth._tokenEndpoint = TOKEN_URL;
        auth._authEndpoint = AUTH_URL;
    };
    let releaseRefresh;
    const refreshGate = new Promise((resolve) => {
        releaseRefresh = resolve;
    });
    let refreshCalls = 0;
    let changeCalls = 0;
    auth.onTokenChanged(() => {
        changeCalls += 1;
    });

    await withAxios({
        post: async () => {
            refreshCalls += 1;
            await refreshGate;
            return {
                status: 200,
                data: {
                    access_token: 'single-flight-access',
                    refresh_token: 'single-flight-refresh',
                    expires_in: 1800,
                },
            };
        },
    }, async () => {
        const checks = [
            auth.ensureValidToken(),
            auth.ensureValidToken(),
            auth.ensureValidToken(),
        ];
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(refreshCalls, 1);

        releaseRefresh();
        assert.deepEqual(await Promise.all(checks), [
            'single-flight-access',
            'single-flight-access',
            'single-flight-access',
        ]);
    });

    assert.equal(changeCalls, 1);
    assert.equal(auth._refreshPromise, null);
});

test('failed refresh propagates without credential fallback', async () => {
    const auth = new AuthManager();
    auth.restoreToken(token({ expiresAt: Date.now() - 1 }));
    let fullAuthCalls = 0;
    auth._fullAuth = async () => {
        fullAuthCalls += 1;
    };
    auth._discover = async () => {
        auth._tokenEndpoint = TOKEN_URL;
        auth._authEndpoint = AUTH_URL;
    };

    await withAxios({
        post: async () => ({ status: 401, data: {} }),
    }, async () => {
        await assert.rejects(() => auth.ensureValidToken(), /Refresh failed: 401/);
    });
    assert.equal(fullAuthCalls, 0);
});

test('authentication errors do not expose token responses or redirect locations', async () => {
    const auth = new AuthManager();
    auth._tokenEndpoint = TOKEN_URL;

    await withAxios({
        post: async () => ({
            status: 400,
            data: {
                access_token: 'secret-response-token',
                refresh_token: 'secret-response-refresh',
            },
        }),
    }, async () => {
        await assert.rejects(
            () => auth._exchange('authorization-code', 'verifier'),
            (err) => {
                assert.equal(err.message, 'Token exchange failed: 400');
                assert.doesNotMatch(err.message, /secret-response/);
                return true;
            },
        );
    });

    auth._authEndpoint = AUTH_URL;
    await withAxios({
        get: async () => ({
            status: 200,
            data: 'url: "/resume"',
            headers: {},
        }),
        post: async () => ({
            status: 302,
            data: '',
            headers: {
                location: 'polestar-explore://explore.polestar.com?error=denied&secret=redirect-secret',
            },
        }),
    }, async () => {
        await assert.rejects(
            () => auth._authorize('challenge', 'owner@example.com', 'one-time-password'),
            (err) => {
                assert.equal(err.message, 'Authentication did not return an authorization code');
                assert.doesNotMatch(err.message, /redirect-secret|polestar-explore/);
                return true;
            },
        );
    });
});

test('network errors do not retain credential or refresh-token request bodies', async () => {
    const auth = new AuthManager();
    auth._authEndpoint = AUTH_URL;
    await withAxios({
        get: async () => ({
            status: 200,
            data: 'url: "/resume"',
            headers: {},
        }),
        post: async () => {
            const err = new Error('request failed with one-time-password');
            err.config = { data: 'pf.pass=one-time-password' };
            throw err;
        },
    }, async () => {
        await assert.rejects(
            () => auth._authorize('challenge', 'owner@example.com', 'one-time-password'),
            (err) => {
                assert.equal(err.message, 'Authentication request failed');
                assert.equal(Object.hasOwn(err, 'config'), false);
                assert.doesNotMatch(err.message, /one-time-password/);
                return true;
            },
        );
    });

    const refreshAuth = new AuthManager();
    refreshAuth.restoreToken(token({ expiresAt: Date.now() - 1 }));
    refreshAuth._discover = async () => {
        refreshAuth._authEndpoint = AUTH_URL;
        refreshAuth._tokenEndpoint = TOKEN_URL;
    };
    await withAxios({
        post: async () => {
            const err = new Error('request failed with refresh-token');
            err.config = { data: 'refresh_token=refresh-token' };
            throw err;
        },
    }, async () => {
        await assert.rejects(
            () => refreshAuth.ensureValidToken(),
            (err) => {
                assert.equal(err.message, 'Token refresh request failed');
                assert.equal(Object.hasOwn(err, 'config'), false);
                assert.doesNotMatch(err.message, /refresh-token/);
                return true;
            },
        );
    });
});

test('initial authentication emits the public token and never retains credentials', async () => {
    const auth = new AuthManager();
    const notifications = [];
    auth.onTokenChanged(async (next) => {
        await new Promise((resolve) => setImmediate(resolve));
        notifications.push(next);
    });
    auth._authorize = async (challenge, email, password) => {
        assert.ok(challenge.length > 0);
        assert.equal(email, 'owner@example.com');
        assert.equal(password, 'one-time-password');
        return 'authorization-code';
    };

    await withAxios({
        get: async () => ({
            data: {
                authorization_endpoint: AUTH_URL,
                token_endpoint: TOKEN_URL,
            },
        }),
        post: async (url, body) => {
            assert.equal(url, TOKEN_URL);
            const form = new URLSearchParams(body);
            assert.equal(form.get('grant_type'), 'authorization_code');
            assert.equal(form.get('client_id'), 'lp8dyrd_10');
            assert.equal(form.get('redirect_uri'), REDIRECT_URI);
            assert.equal(form.get('code'), 'authorization-code');
            return {
                status: 200,
                data: {
                    access_token: 'paired-access',
                    refresh_token: 'paired-refresh',
                    expires_in: 1800,
                },
            };
        },
    }, async () => {
        await auth.authenticate('owner@example.com', 'one-time-password');
    });

    assert.equal(Object.hasOwn(auth, '_email'), false);
    assert.equal(Object.hasOwn(auth, '_password'), false);
    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0], auth.getToken());
});

test('token change callbacks are awaited, receive snapshots, and can unsubscribe', async () => {
    const auth = new AuthManager();
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    let callbackStarted = false;
    let storeCompleted = false;
    const unsubscribe = auth.onTokenChanged(async (next) => {
        callbackStarted = true;
        next.accessToken = 'mutated-by-callback';
        await gate;
    });

    const storing = auth._storeTokens({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 1800,
    }).then(() => {
        storeCompleted = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(callbackStarted, true);
    assert.equal(storeCompleted, false);
    assert.equal(auth.getToken(), null, 'a token is not usable until persistence finishes');

    release();
    await storing;
    assert.equal(storeCompleted, true);
    assert.equal(auth.getToken().accessToken, 'new-access');

    unsubscribe();
    callbackStarted = false;
    await auth._storeTokens({
        access_token: 'another-access',
        expires_in: 1800,
    });
    assert.equal(callbackStarted, false);
    assert.equal(auth.getToken().refreshToken, 'new-refresh');
});

test('persistence callback failure leaves the replacement pending and retries before use', async () => {
    const auth = new AuthManager();
    auth.restoreToken(token());
    let attempts = 0;
    auth.onTokenChanged(async (next) => {
        attempts += 1;
        assert.equal(next.refreshToken, 'replacement-refresh');
        if (attempts === 1) throw new Error('persistence failed');
    });

    await assert.rejects(() => auth._storeTokens({
        access_token: 'replacement-access',
        refresh_token: 'replacement-refresh',
        expires_in: 1800,
    }), /persistence failed/);

    assert.equal(auth.getToken().refreshToken, 'refresh-token');
    assert.equal(await auth.ensureValidToken(), 'replacement-access');
    assert.equal(attempts, 2);
    assert.equal(auth.getToken().refreshToken, 'replacement-refresh');
});
