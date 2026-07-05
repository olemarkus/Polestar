'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const PolestarCompat = require('../clone_modules/polestar-c3/compat');

const STORED_VIN = 'stored-vin';

function compatWithStubbedClient(stub = {}) {
    const compat = new PolestarCompat('test@example.com', 'unused');
    compat._client = Object.assign({
        _vin: null,
        async login() {},
        async listVehicles() {
            throw new Error('discovery should not be called');
        },
        async setVehicle(vin) {
            this._vin = vin;
        },
    }, stub);
    return compat;
}

test('compat login authenticates without fetching the garage', async () => {
    let loginCalls = 0;
    let discoveryCalls = 0;
    const compat = compatWithStubbedClient({
        async login() {
            loginCalls += 1;
        },
        async listVehicles() {
            discoveryCalls += 1;
            return [];
        },
    });
    compat._vehicles = [{ vin: 'stale-vin' }];

    assert.equal(await compat.login(), true);
    assert.equal(loginCalls, 1);
    assert.equal(discoveryCalls, 0, 'login must not call GetMyCars');
    assert.equal(compat._vehicles, null, 'login must invalidate cached discovery');
});

test('getVehicles remains the explicit GetMyCars pairing path and caches the result', async () => {
    let discoveryCalls = 0;
    const vehicles = [{ vin: 'linked-vin' }];
    const compat = compatWithStubbedClient({
        async listVehicles() {
            discoveryCalls += 1;
            return vehicles;
        },
    });

    assert.equal(await compat.getVehicles(), vehicles);
    assert.equal(await compat.getVehicles(), vehicles);
    assert.equal(discoveryCalls, 1);
});

test('setVehicle(storedVin) selects the stored VIN without discovery', async () => {
    let discoveryCalls = 0;
    let selectedVin = null;
    const compat = compatWithStubbedClient({
        async listVehicles() {
            discoveryCalls += 1;
            throw new Error('GetMyCars UNAVAILABLE');
        },
        async setVehicle(vin) {
            selectedVin = vin;
            this._vin = vin;
        },
    });

    assert.deepEqual(await compat.setVehicle(STORED_VIN), {
        vin: STORED_VIN,
        id: undefined,
    });
    assert.equal(selectedVin, STORED_VIN);
    assert.equal(discoveryCalls, 0);
});

test('setVehicle(storedVin) does not require the VIN to remain in the linked garage', async () => {
    let discoveryCalls = 0;
    const compat = compatWithStubbedClient({
        async listVehicles() {
            discoveryCalls += 1;
            return [{ vin: 'different-vin' }];
        },
    });

    assert.deepEqual(await compat.setVehicle(STORED_VIN), {
        vin: STORED_VIN,
        id: undefined,
    });
    assert.equal(discoveryCalls, 0);
});

test('setVehicle() with no stored VIN still discovers the first pairing candidate', async () => {
    let discoveryCalls = 0;
    let selectedVin = null;
    const compat = compatWithStubbedClient({
        async listVehicles() {
            discoveryCalls += 1;
            return [{
                vin: 'linked-vin',
                internalVehicleIdentifier: 'internal-id',
            }];
        },
        async setVehicle(vin) {
            selectedVin = vin;
        },
    });

    assert.deepEqual(await compat.setVehicle(), {
        vin: 'linked-vin',
        id: 'internal-id',
    });
    assert.equal(selectedVin, 'linked-vin');
    assert.equal(discoveryCalls, 1);
});

test('setVehicle() with no stored VIN rejects an empty linked garage', async () => {
    const compat = compatWithStubbedClient({
        async listVehicles() {
            return [];
        },
    });

    await assert.rejects(() => compat.setVehicle(), /Vehicle not found/);
});

test('compat forwards the token lifecycle and session close to the C3 client', () => {
    const restored = {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: 123,
    };
    const callback = () => {};
    const unsubscribe = () => {};
    const calls = [];
    const compat = compatWithStubbedClient({
        restoreToken(value) {
            calls.push(['restoreToken', value]);
        },
        getToken() {
            calls.push(['getToken']);
            return restored;
        },
        onTokenChanged(value) {
            calls.push(['onTokenChanged', value]);
            return unsubscribe;
        },
        hasPendingTokenPersistence() {
            calls.push(['hasPendingTokenPersistence']);
            return true;
        },
        close() {
            calls.push(['close']);
            return 'closed';
        },
    });

    compat.restoreToken(restored);
    assert.equal(compat.getToken(), restored);
    assert.equal(compat.onTokenChanged(callback), unsubscribe);
    assert.equal(compat.hasPendingTokenPersistence(), true);
    assert.equal(compat.close(), 'closed');
    assert.deepEqual(calls, [
        ['restoreToken', restored],
        ['getToken'],
        ['onTokenChanged', callback],
        ['hasPendingTokenPersistence'],
        ['close'],
    ]);
});
