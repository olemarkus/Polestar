'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const discoveryPath = require.resolve('../clone_modules/polestar-c3/discovery');
const clientPath = require.resolve('../clone_modules/polestar-c3/client');

function loadClientWithEndpointDiscovery(discoverC3Endpoint) {
    const discovery = require(discoveryPath);
    const originalDiscovery = discovery.discoverC3Endpoint;
    const originalClientModule = require.cache[clientPath];

    discovery.discoverC3Endpoint = discoverC3Endpoint;
    delete require.cache[clientPath];
    const { PolestarC3 } = require(clientPath);
    discovery.discoverC3Endpoint = originalDiscovery;

    if (originalClientModule) {
        require.cache[clientPath] = originalClientModule;
    } else {
        delete require.cache[clientPath];
    }
    return PolestarC3;
}

function token(overrides = {}) {
    return {
        accessToken: 'stored-access',
        refreshToken: 'stored-refresh',
        expiresAt: Date.now() + 10 * 60_000,
        ...overrides,
    };
}

test('token-only login validates the restored token and discovers the C3 endpoint', async () => {
    const discovered = [];
    const PolestarC3 = loadClientWithEndpointDiscovery(async (accessToken) => {
        discovered.push(accessToken);
        return { host: 'c3.example.test', port: 443 };
    });
    const client = new PolestarC3();
    client.restoreToken(token());

    await client.login();

    assert.deepEqual(discovered, ['stored-access']);
    assert.deepEqual(client._endpoint, { host: 'c3.example.test', port: 443 });
    assert.deepEqual(client.getToken(), token({
        expiresAt: client.getToken().expiresAt,
    }));
});

test('password login consumes credentials once and later logins use only the token', async () => {
    const discovered = [];
    const PolestarC3 = loadClientWithEndpointDiscovery(async (accessToken) => {
        discovered.push(accessToken);
        return { host: 'c3.example.test', port: 443 };
    });
    const client = new PolestarC3('owner@example.com', 'one-time-password');
    let passwordAuthCalls = 0;
    let tokenValidationCalls = 0;
    client._auth = {
        accessToken: 'paired-access',
        async authenticate(email, password) {
            passwordAuthCalls += 1;
            assert.equal(email, 'owner@example.com');
            assert.equal(password, 'one-time-password');
        },
        async ensureValidToken() {
            tokenValidationCalls += 1;
            return 'restored-access';
        },
    };

    await client.login();
    assert.equal(client._email, null);
    assert.equal(client._password, null);
    assert.equal(passwordAuthCalls, 1);
    assert.equal(tokenValidationCalls, 0);

    await client.login();
    assert.equal(passwordAuthCalls, 1, 'credentials must never be reused');
    assert.equal(tokenValidationCalls, 1);
    assert.deepEqual(discovered, ['paired-access', 'restored-access']);
});

test('credentials are cleared even when one-time authentication fails', async () => {
    const PolestarC3 = loadClientWithEndpointDiscovery(async () => {
        throw new Error('endpoint discovery must not run');
    });
    const client = new PolestarC3('owner@example.com', 'wrong-password');
    client._auth = {
        async authenticate() {
            throw new Error('Invalid username or password');
        },
    };

    await assert.rejects(() => client.login(), /Invalid username or password/);
    assert.equal(client._email, null);
    assert.equal(client._password, null);
});

test('client forwards token restore, snapshots, callbacks, and unsubscribe', async () => {
    const PolestarC3 = loadClientWithEndpointDiscovery(async () => ({
        host: 'c3.example.test',
        port: 443,
    }));
    const client = new PolestarC3();
    const restored = token();
    client.restoreToken(restored);

    let calls = 0;
    const unsubscribe = client.onTokenChanged(() => {
        calls += 1;
    });
    await client._auth._storeTokens({
        access_token: 'refreshed-access',
        refresh_token: 'refreshed-refresh',
        expires_in: 1800,
    });
    assert.equal(calls, 1);
    assert.equal(client.hasPendingTokenPersistence(), false);
    assert.equal(client.getToken().refreshToken, 'refreshed-refresh');

    unsubscribe();
    await client._auth._storeTokens({
        access_token: 'second-access',
        expires_in: 1800,
    });
    assert.equal(calls, 1);
});
