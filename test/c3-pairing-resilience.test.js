'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const PolestarCompat = require('../clone_modules/polestar-c3/compat');

const STORED_VIN = 'stored-vin';
const OTHER_VIN = 'other-vin';

function compatWithStubbedClient(stub) {
    const compat = new PolestarCompat('test@example.com', 'unused');
    compat._client = Object.assign({
        _vin: null,
        async login() {},
        async listVehicles() { throw new Error('discovery should not be called'); },
        async setVehicle(vin) { this._vin = vin; },
    }, stub);
    return compat;
}

test('login() does not fetch the garage (independent of GetMyCars)', async () => {
    let discoveryCalls = 0;
    const compat = compatWithStubbedClient({
        async listVehicles() { discoveryCalls += 1; return []; },
    });
    compat._vehicles = [{ vin: 'stale-vin' }];
    await compat.login();
    assert.equal(discoveryCalls, 0, 'login must not call listVehicles/GetMyCars');
    assert.equal(compat._vehicles, null, 'successful login must invalidate a stale garage cache');
});

test('setVehicle(storedVin) selects the stored VIN without discovery', async () => {
    let discoveryCalls = 0;
    let vinSet = null;
    const compat = compatWithStubbedClient({
        async listVehicles() {
            discoveryCalls += 1;
            throw new Error('GetMyCars UNAVAILABLE');
        },
        async setVehicle(vin) { vinSet = vin; this._vin = vin; },
    });
    const result = await compat.setVehicle(STORED_VIN);
    assert.equal(vinSet, STORED_VIN, 'stored VIN must be selected directly');
    assert.equal(discoveryCalls, 0, 'stored VIN must not call listVehicles/GetMyCars');
    assert.deepEqual(result, { vin: STORED_VIN, id: undefined });
});

test('setVehicle(storedVin) does not discover when the garage would omit the VIN', async () => {
    let discoveryCalls = 0;
    const compat = compatWithStubbedClient({
        async listVehicles() {
            discoveryCalls += 1;
            return [{ vin: OTHER_VIN }];
        },
        async setVehicle(vin) { this._vin = vin; },
    });

    const result = await compat.setVehicle(STORED_VIN);
    assert.equal(discoveryCalls, 0, 'stored VIN must not fetch the garage');
    assert.deepEqual(result, { vin: STORED_VIN, id: undefined });
});

test('setVehicle() with no VIN (pairing) still needs a non-empty list', async () => {
    let discoveryCalls = 0;
    const compat = compatWithStubbedClient({
        async listVehicles() { discoveryCalls += 1; return []; },
    });
    await assert.rejects(() => compat.setVehicle(), /Vehicle not found/);
    assert.equal(discoveryCalls, 1, 'pairing must discover the linked garage');
});
