'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const logVehicleCount = require('../lib/vehicle-log');

function captureLog(message, vehicles) {
    let logged;
    const homey = {
        app: {
            log(...args) {
                logged = args;
            },
        },
    };

    logVehicleCount(homey, message, vehicles);
    return logged;
}

test('pairing logs only the vehicle count', () => {
    const logged = captureLog('Vehicles ready to be added', [{ vin: 'pair-vin' }]);

    assert.deepEqual(logged, ['Vehicles ready to be added: 1', 'Polestar Driver', 'DEBUG']);
});

test('pair and repair credential checks log only the vehicle count', () => {
    const logged = captureLog('Credential test ok, vehicle count', [{ vin: 'repair-vin' }]);

    assert.deepEqual(logged, ['Credential test ok, vehicle count: 1', 'Polestar Driver', 'DEBUG']);
});
