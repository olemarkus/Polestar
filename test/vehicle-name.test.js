'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const formatVehicleName = require('../lib/vehicle-name');

const TEST_VIN = 'test-ABC123';

test('uses the registration number when one is available', () => {
    assert.equal(formatVehicleName('Polestar 3', 'AB12345', TEST_VIN), 'Polestar 3 (AB12345)');
});

test('uses only a masked VIN suffix when registration is absent', () => {
    assert.equal(formatVehicleName('Polestar 3', null, TEST_VIN), 'Polestar 3 (ABC123)');
});

test('does not render a null identifier', () => {
    assert.equal(formatVehicleName('Polestar 3', null, null), 'Polestar 3');
});
