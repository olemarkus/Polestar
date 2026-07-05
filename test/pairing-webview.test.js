'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const driverManifest = JSON.parse(read('drivers/vehicle/driver.compose.json'));
const driverSource = read('drivers/vehicle/driver.js');
const settingsHtml = read('settings/index.html');
const authSource = read('clone_modules/polestar-c3/auth.js');

function assertNativeCredentialsView(view, title) {
    assert.equal(view.id, 'login_credentials');
    assert.equal(view.template, 'login_credentials');
    assert.deepEqual(view.options, {
        title: { en: title },
        usernameLabel: { en: 'Polestar ID email' },
        usernamePlaceholder: { en: 'name@example.com' },
        passwordLabel: { en: 'Password' },
        passwordPlaceholder: { en: 'Polestar ID password' },
    });
}

test('pair and repair use the native Homey credentials view', () => {
    assert.deepEqual(driverManifest.pair.map(({ id }) => id), [
        'login_credentials',
        'list_devices',
        'add_devices',
    ]);
    assertNativeCredentialsView(driverManifest.pair[0], 'Sign in to Polestar');

    assert.equal(driverManifest.repair.length, 1);
    assertNativeCredentialsView(driverManifest.repair[0], 'Sign in again to Polestar');
});

test('custom password forms and settings credential access are absent', () => {
    assert.equal(
        fs.existsSync(path.join(root, 'drivers/vehicle/pair/login.html')),
        false,
    );
    assert.equal(
        fs.existsSync(path.join(root, 'drivers/vehicle/repair/login.html')),
        false,
    );

    assert.doesNotMatch(settingsHtml, /type\s*=\s*["']password["']/i);
    assert.doesNotMatch(settingsHtml, /\buser_(?:email|password)\b/);
    assert.match(settingsHtml, /id=["']distanceUnit["']/);
    assert.match(settingsHtml, /Homey\.get\(["']distance_unit["']/);
    assert.match(settingsHtml, /Homey\.set\(["']distance_unit["']/);
});

test('the vehicle driver does not persist Polestar credentials', () => {
    const credentialWrites = driverSource.match(
        /\.settings\.set\(\s*["']user_(?:email|password)["']/g,
    ) || [];

    assert.deepEqual(
        credentialWrites,
        [],
        'pairing and repair must persist tokens instead of account credentials',
    );
});

test('C3 authentication uses the Polestar app OAuth client', () => {
    const clientId = authSource.match(
        /const CLIENT_ID\s*=\s*["']([^"']+)["']/,
    );

    assert.ok(clientId, 'auth module must declare an OAuth client ID');
    assert.equal(clientId[1], 'lp8dyrd_10');
    assert.doesNotMatch(authSource, /\bl3oopkc_10\b/);
});
