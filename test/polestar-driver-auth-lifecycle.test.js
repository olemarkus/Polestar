'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const driverPath = require.resolve('../drivers/vehicle/driver');
const {
    LEGACY_SETTING_KEYS,
    TOKEN_STORE_KEY,
} = require('../lib/polestarAuthStore');

const cryptFake = {
    async decrypt(value) {
        return value;
    },
};

function loadDriver() {
    const originalLoad = Module._load;
    const originalModule = require.cache[driverPath];

    Module._load = function load(request, parent, isMain) {
        if (request === 'homey') {
            return { Driver: class {} };
        }
        if (request === '../../clone_modules/polestar-c3/compat') {
            return class {};
        }
        if (request === '../../lib/homeycrypt') {
            return cryptFake;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[driverPath];

    try {
        return require(driverPath);
    } finally {
        Module._load = originalLoad;
        if (originalModule) {
            require.cache[driverPath] = originalModule;
        } else {
            delete require.cache[driverPath];
        }
    }
}

const VehicleDriver = loadDriver();

function validToken(overrides = {}) {
    return {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 30 * 60_000,
        ...overrides,
    };
}

function settingsStore(initial = {}, events = []) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        get(key) {
            return values.get(key);
        },
        async set(key, value) {
            events.push(['setting:set', key, value]);
            values.set(key, value);
        },
        async unset(key) {
            events.push(['setting:unset', key]);
            values.delete(key);
        },
    };
}

function storedDevice(vin, events = [], options = {}) {
    const store = new Map();
    return {
        store,
        getData() {
            return { vin };
        },
        getStoreValue(key) {
            return store.get(key);
        },
        async setStoreValue(key, value) {
            events.push(['device:store', vin, key]);
            if (options.failWrite) throw new Error('store write failed');
            store.set(key, value);
        },
    };
}

function pairSession() {
    const handlers = new Map();
    return {
        handlers,
        setHandler(name, handler) {
            handlers.set(name, handler);
        },
    };
}

function createDriver({ settings = settingsStore(), devices = [] } = {}) {
    const driver = new VehicleDriver();
    driver.homey = {
        settings,
        app: {
            log() {},
        },
    };
    driver.getDevices = () => devices;
    return driver;
}

function pairedClient(token, vehicles = []) {
    return {
        closed: false,
        async login() {},
        getToken() {
            return { ...token };
        },
        onTokenChanged() {
            return () => {};
        },
        async getVehicles() {
            return vehicles;
        },
        close() {
            this.closed = true;
        },
    };
}

test('failed one-time authentication closes its temporary client', async () => {
    const client = pairedClient(validToken());
    client.login = async () => {
        throw new Error('Authentication request failed');
    };
    const driver = createDriver();
    driver._createPolestarClient = () => client;

    await assert.rejects(
        () => driver._authenticate('owner@example.com', 'one-time-password'),
        /Authentication request failed/,
    );
    assert.equal(client.closed, true);
});

test('pairing accepts native-login credentials transiently and returns a token in each device store', async () => {
    const events = [];
    const settings = settingsStore({
        user_email: 'legacy@example.com',
        user_password: 'legacy-password',
    }, events);
    const token = validToken();
    const vehicles = [{
        vin: 'pairing-vin',
        registrationNo: 'EV12345',
        internalVehicleIdentifier: 'vehicle-id',
        modelYear: 2025,
        userIsLinked: true,
        userIsOwner: true,
        content: {
            model: { name: 'Polestar 4' },
            images: { studio: { url: 'https://images.example/car.png' } },
        },
    }];
    const client = pairedClient(token, vehicles);
    const driver = createDriver({ settings });
    const suppliedCredentials = [];
    driver._createPolestarClient = (username, password) => {
        suppliedCredentials.push([username, password]);
        return client;
    };

    const session = pairSession();
    await driver.onPair(session);
    assert.deepEqual([...session.handlers.keys()], [
        'login',
        'list_devices',
        'add_devices',
        'disconnect',
    ]);

    assert.equal(await session.handlers.get('login')({
        username: '  owner@example.com  ',
        password: 'one-time-password',
    }), true);

    assert.deepEqual(suppliedCredentials, [['owner@example.com', 'one-time-password']]);
    assert.deepEqual(events, [], 'login must not write or clear global credentials');

    const discovered = await session.handlers.get('list_devices')();
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].data.vin, 'pairing-vin');
    assert.deepEqual(discovered[0].store, {
        [TOKEN_STORE_KEY]: token,
    });
    assert.deepEqual(events, [], 'device discovery must not write global credentials');

    await session.handlers.get('add_devices')(discovered);
    assert.equal(client.closed, true, 'completed pairing must close its C3 client');
});

test('abandoned pairing closes its authenticated C3 client', async () => {
    const client = pairedClient(validToken());
    const driver = createDriver();
    driver._createPolestarClient = () => client;
    const session = pairSession();
    await driver.onPair(session);

    await session.handlers.get('login')({
        username: 'owner@example.com',
        password: 'one-time-password',
    });
    assert.equal(client.closed, false);

    await session.handlers.get('disconnect')();
    assert.equal(client.closed, true);
});

test('repair hands the authenticated client to the target device', async () => {
    const events = [];
    const settings = settingsStore({
        user_email: 'legacy@example.com',
        user_password: 'legacy-password',
    }, events);
    const token = validToken();
    const client = pairedClient(token, [{ vin: 'stored-vin' }]);
    const device = storedDevice('stored-vin', events);
    let replacement = null;
    device.replacePolestarClient = async (value) => {
        await device.setStoreValue(TOKEN_STORE_KEY, value.getToken());
        events.push(['device:replace']);
        replacement = value;
    };
    const driver = createDriver({ settings, devices: [device] });
    driver._createPolestarClient = () => client;

    const session = pairSession();
    await driver.onRepair(session, device);
    assert.equal(await session.handlers.get('login')({
        username: 'owner@example.com',
        password: 'one-time-password',
    }), true);

    assert.deepEqual(device.store.get(TOKEN_STORE_KEY), token);
    assert.equal(replacement, client);
    assert.equal(settings.values.has('user_email'), false);
    assert.equal(settings.values.has('user_password'), false);
});

test('concurrent legacy migration authenticates once, stores every device token, then clears credentials', async () => {
    const events = [];
    const settings = settingsStore({
        user_email: 'legacy@example.com',
        user_password: 'encrypted-password',
        polestar_token: 'obsolete-token',
        c3_backend_disabled: true,
    }, events);
    const first = storedDevice('first-vin', events);
    const second = storedDevice('second-vin', events);
    const token = validToken();
    const client = pairedClient(token);
    const driver = createDriver({ settings, devices: [first, second] });
    let authenticateCalls = 0;
    let decryptCalls = 0;
    cryptFake.decrypt = async (encrypted, username) => {
        decryptCalls += 1;
        assert.equal(encrypted, 'encrypted-password');
        assert.equal(username, 'legacy@example.com');
        await new Promise((resolve) => setImmediate(resolve));
        return 'decrypted-password';
    };
    driver._authenticate = async (username, password) => {
        authenticateCalls += 1;
        assert.equal(username, 'legacy@example.com');
        assert.equal(password, 'decrypted-password');
        await new Promise((resolve) => setImmediate(resolve));
        return { client, token };
    };

    const [firstToken, secondToken] = await Promise.all([
        driver.getTokenForDevice(first),
        driver.getTokenForDevice(second),
    ]);

    assert.deepEqual(firstToken, token);
    assert.deepEqual(secondToken, token);
    assert.equal(decryptCalls, 1);
    assert.equal(authenticateCalls, 1);
    assert.deepEqual(first.store.get(TOKEN_STORE_KEY), token);
    assert.deepEqual(second.store.get(TOKEN_STORE_KEY), token);

    const firstUnset = events.findIndex(([kind]) => kind === 'setting:unset');
    const tokenWrites = events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event[0] === 'device:store');
    assert.equal(tokenWrites.length, 2);
    assert.ok(tokenWrites.every(({ index }) => index < firstUnset));
    assert.deepEqual(
        events.filter(([kind]) => kind === 'setting:unset').map(([, key]) => key),
        LEGACY_SETTING_KEYS,
    );
    assert.equal(client.closed, true);
});

test('obsolete credentials are removed when no paired devices need migration', async () => {
    const events = [];
    const settings = settingsStore({
        user_email: 'orphaned@example.com',
        user_password: 'orphaned-password',
    }, events);
    const driver = createDriver({ settings, devices: [] });

    assert.equal(await driver._clearLegacyCredentialsIfMigrated(), true);
    assert.equal(settings.values.has('user_email'), false);
    assert.equal(settings.values.has('user_password'), false);
});

test('terminal legacy migration failures remove rejected or partial credentials', async (t) => {
    const originalDecrypt = cryptFake.decrypt;
    cryptFake.decrypt = async () => 'decrypted-password';
    t.after(() => {
        cryptFake.decrypt = originalDecrypt;
    });

    await t.test('rejected password', async () => {
        const settings = settingsStore({
            user_email: 'legacy@example.com',
            user_password: 'encrypted-password',
        });
        const device = storedDevice('stored-vin');
        const driver = createDriver({ settings, devices: [device] });
        driver._authenticate = async () => {
            throw new Error('Invalid username or password');
        };

        await assert.rejects(
            () => driver.getTokenForDevice(device),
            /Repair the device/,
        );
        assert.equal(settings.values.has('user_email'), false);
        assert.equal(settings.values.has('user_password'), false);
    });

    await t.test('partial saved login', async () => {
        const settings = settingsStore({
            user_email: 'legacy@example.com',
        });
        const device = storedDevice('stored-vin');
        const driver = createDriver({ settings, devices: [device] });

        await assert.rejects(
            () => driver.getTokenForDevice(device),
            /Repair the device/,
        );
        assert.equal(settings.values.has('user_email'), false);
    });
});

test('legacy credentials remain available when authentication or a token write fails', async (t) => {
    const originalDecrypt = cryptFake.decrypt;
    cryptFake.decrypt = async () => 'decrypted-password';
    t.after(() => {
        cryptFake.decrypt = originalDecrypt;
    });

    await t.test('authentication failure', async () => {
        const events = [];
        const settings = settingsStore({
            user_email: 'legacy@example.com',
            user_password: 'encrypted-password',
        }, events);
        const device = storedDevice('stored-vin', events);
        const driver = createDriver({ settings, devices: [device] });
        driver._authenticate = async () => {
            throw new Error('provider unavailable');
        };

        await assert.rejects(
            () => driver.getTokenForDevice(device),
            /Could not migrate Polestar authentication/,
        );
        assert.equal(settings.values.get('user_email'), 'legacy@example.com');
        assert.equal(settings.values.get('user_password'), 'encrypted-password');
        assert.equal(events.some(([kind]) => kind === 'setting:unset'), false);
    });

    await t.test('per-device token write failure', async () => {
        const events = [];
        const settings = settingsStore({
            user_email: 'legacy@example.com',
            user_password: 'encrypted-password',
        }, events);
        const first = storedDevice('first-vin', events);
        const second = storedDevice('second-vin', events, { failWrite: true });
        const token = validToken();
        const client = pairedClient(token);
        const driver = createDriver({ settings, devices: [first, second] });
        driver._authenticate = async () => ({ client, token });

        await assert.rejects(
            () => driver.getTokenForDevice(first),
            /Could not migrate Polestar authentication/,
        );
        assert.deepEqual(first.store.get(TOKEN_STORE_KEY), token);
        assert.equal(second.store.has(TOKEN_STORE_KEY), false);
        assert.equal(settings.values.get('user_email'), 'legacy@example.com');
        assert.equal(settings.values.get('user_password'), 'encrypted-password');
        assert.equal(events.some(([kind]) => kind === 'setting:unset'), false);
        assert.equal(client.closed, true);
    });
});
