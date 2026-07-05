'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    TOKEN_STORE_KEY,
    hasLegacySettings,
    normalizeToken,
    persistToken,
    readToken,
} = require('../lib/polestarAuthStore');

function validToken(overrides = {}) {
    return {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 30 * 60_000,
        ...overrides,
    };
}

function storedDevice(initialValue = undefined) {
    const store = new Map();
    if (initialValue !== undefined) store.set(TOKEN_STORE_KEY, initialValue);
    const writes = [];

    return {
        store,
        writes,
        getStoreValue(key) {
            return store.get(key);
        },
        async setStoreValue(key, value) {
            writes.push([key, value]);
            store.set(key, value);
        },
    };
}

test('normalizes reusable token snapshots without retaining caller-owned objects', () => {
    const input = validToken({
        accessToken: '  access-token  ',
        refreshToken: '  refresh-token  ',
    });

    const normalized = normalizeToken(input);

    assert.deepEqual(normalized, {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: input.expiresAt,
    });
    assert.notEqual(normalized, input);

    input.accessToken = 'changed-after-normalization';
    assert.equal(normalized.accessToken, 'access-token');
});

test('rejects malformed or non-reusable token values', () => {
    for (const value of [
        null,
        [],
        {},
        validToken({ accessToken: '' }),
        validToken({ refreshToken: '' }),
        validToken({ expiresAt: Number.NaN }),
        validToken({ expiresAt: 0 }),
        validToken({ expiresAt: -1 }),
    ]) {
        assert.equal(normalizeToken(value), null);
    }
});

test('reads and persists only normalized per-device tokens', async () => {
    const input = validToken({
        accessToken: '  access-token  ',
        refreshToken: '  refresh-token  ',
    });
    const device = storedDevice(input);

    const read = readToken(device);
    assert.deepEqual(read, {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: input.expiresAt,
    });
    assert.notEqual(read, input);

    const persisted = await persistToken(device, input);
    assert.deepEqual(persisted, read);
    assert.deepEqual(device.writes, [[TOKEN_STORE_KEY, read]]);
    assert.notEqual(device.writes[0][1], input);

    input.refreshToken = 'changed-after-persist';
    assert.equal(device.store.get(TOKEN_STORE_KEY).refreshToken, 'refresh-token');

    await assert.rejects(
        () => persistToken(device, validToken({ refreshToken: null })),
        /reusable refresh token/,
    );
    assert.equal(device.writes.length, 1);
});

test('detects obsolete global login settings without treating missing keys as present', () => {
    const values = new Map();
    const settings = { get: (key) => values.get(key) };
    assert.equal(hasLegacySettings(settings), false);

    values.set('user_password', '');
    assert.equal(hasLegacySettings(settings), true);
});
