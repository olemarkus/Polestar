'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const devicePath = require.resolve('../drivers/vehicle/device');
const { TOKEN_STORE_KEY } = require('../lib/polestarAuthStore');

function loadDevice() {
    const originalLoad = Module._load;
    const originalModule = require.cache[devicePath];

    Module._load = function load(request, parent, isMain) {
        if (request === 'homey') {
            return { Device: class {} };
        }
        if (request === '../../clone_modules/polestar-c3/compat') {
            return class {};
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[devicePath];

    try {
        return require(devicePath);
    } finally {
        Module._load = originalLoad;
        if (originalModule) {
            require.cache[devicePath] = originalModule;
        } else {
            delete require.cache[devicePath];
        }
    }
}

const PolestarVehicle = loadDevice();

function validToken(overrides = {}) {
    return {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 30 * 60_000,
        ...overrides,
    };
}

function lifecycleClient(events, token = validToken()) {
    let tokenChanged = null;
    return {
        get tokenChanged() {
            return tokenChanged;
        },
        restoreToken(value) {
            events.push(['restore', value]);
        },
        onTokenChanged(callback) {
            events.push(['subscribe']);
            tokenChanged = callback;
            return () => {};
        },
        async login() {
            events.push(['login']);
        },
        async setVehicle(vin) {
            events.push(['select', vin]);
        },
        async getVehicles() {
            throw new Error('GetMyCars must not run for an already paired device');
        },
        getToken() {
            return { ...token };
        },
        hasPendingTokenPersistence() {
            return false;
        },
        close() {
            events.push(['close']);
        },
    };
}

function createDevice(events = []) {
    const store = new Map();
    const settingListeners = new Set();
    const timeouts = [];
    const device = new PolestarVehicle();
    device.name = 'Test Polestar';
    device.driver = {};
    device.homey = {
        settings: {
            get() {
                return 'km';
            },
            on(event, callback) {
                if (event === 'set') settingListeners.add(callback);
            },
            off(event, callback) {
                if (event === 'set') settingListeners.delete(callback);
            },
        },
        app: {
            log() {},
        },
        api: {
            realtime() {},
        },
        __(value) {
            return value.en;
        },
        setTimeout(callback, delay) {
            const handle = { callback, delay, cleared: false };
            timeouts.push(handle);
            return handle;
        },
        clearTimeout(handle) {
            handle.cleared = true;
        },
        clearInterval() {},
    };
    device.getData = () => ({ vin: 'stored-vin' });
    device.getStoreValue = (key) => store.get(key);
    device.setStoreValue = async (key, value) => {
        events.push(['store', key, value]);
        store.set(key, value);
    };
    device.setAvailable = async () => {
        events.push(['available']);
    };
    device.setUnavailable = async (message) => {
        events.push(['unavailable', message]);
    };
    device.fixCapabilities = async () => {};
    device.fixEnergy = async () => {};
    device.updateCapabilityUnits = async () => {};
    device._registerWriteCapabilityListeners = () => {};
    device.update_loop_timers = async () => {
        events.push(['start-updates']);
    };
    device.refreshChargingTargets = () => {
        events.push(['refresh-targets']);
    };
    return {
        device,
        settingListeners,
        store,
        timeouts,
    };
}

test('paired-device startup restores a token and selects its stored VIN without garage discovery', async () => {
    const events = [];
    const token = validToken();
    const client = lifecycleClient(events, token);
    const { device, store } = createDevice(events);
    device.driver.getTokenForDevice = async (requestedDevice) => {
        assert.equal(requestedDevice, device);
        events.push(['read-token']);
        return token;
    };
    device._createPolestarClient = () => client;

    await device.onInit();

    assert.equal(device.polestar, client);
    assert.deepEqual(events.slice(0, 6), [
        ['read-token'],
        ['subscribe'],
        ['restore', token],
        ['login'],
        ['select', 'stored-vin'],
        ['available'],
    ]);
    assert.equal(events.some(([kind]) => kind === 'unavailable'), false);

    const refreshed = validToken({
        accessToken: 'refreshed-access',
        refreshToken: 'replacement-refresh',
    });
    await client.tokenChanged(refreshed);
    assert.deepEqual(store.get(TOKEN_STORE_KEY), refreshed);
});

test('repair replacement stores its token and selects the existing VIN without garage discovery', async () => {
    const events = [];
    const token = validToken();
    const client = lifecycleClient(events, token);
    const { device, store } = createDevice(events);
    device._destroyed = false;
    device._startAuthenticatedUpdates = () => {};

    await device.replacePolestarClient(client);

    assert.deepEqual(store.get(TOKEN_STORE_KEY), token);
    assert.equal(device.polestar, client);
    assert.deepEqual(events, [
        ['subscribe'],
        ['store', TOKEN_STORE_KEY, token],
        ['select', 'stored-vin'],
        ['available'],
    ]);
});

test('authentication recovery forces a refresh with a valid expired token snapshot', async () => {
    const events = [];
    const storedToken = validToken();
    const client = lifecycleClient(events);
    const { device, store } = createDevice(events);
    store.set(TOKEN_STORE_KEY, storedToken);
    const previousClient = {
        close() {
            events.push(['close-previous']);
        },
    };
    device.polestar = previousClient;
    device._createPolestarClient = () => client;

    assert.equal(await device.attemptReLogin(), true);

    assert.equal(device.polestar, client);
    assert.deepEqual(events, [
        ['subscribe'],
        ['restore', { ...storedToken, expiresAt: 1 }],
        ['login'],
        ['select', 'stored-vin'],
        ['available'],
        ['close-previous'],
    ]);
    assert.equal(events.some(([kind]) => kind === 'unavailable'), false);
});

test('concurrent authentication recovery callers share one refresh', async () => {
    const events = [];
    const { device, store } = createDevice(events);
    store.set(TOKEN_STORE_KEY, validToken());
    const client = lifecycleClient(events);
    let releaseLogin;
    const loginGate = new Promise((resolve) => {
        releaseLogin = resolve;
    });
    let loginCalls = 0;
    client.login = async () => {
        loginCalls += 1;
        await loginGate;
    };
    device._createPolestarClient = () => client;

    const first = device.attemptReLogin();
    await new Promise((resolve) => setImmediate(resolve));
    const second = device.attemptReLogin();
    releaseLogin();

    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(loginCalls, 1);
});

test('temporary refresh failure stays retryable while rejected tokens require repair', async () => {
    const events = [];
    const { device, store } = createDevice(events);
    store.set(TOKEN_STORE_KEY, validToken());

    const temporaryClient = lifecycleClient(events);
    temporaryClient.login = async () => {
        throw new Error('Token refresh request failed');
    };
    const recoveredClient = lifecycleClient(events);
    const rejectedClient = lifecycleClient(events);
    rejectedClient.login = async () => {
        throw new Error('Refresh failed: 401');
    };
    const clients = [temporaryClient, recoveredClient, rejectedClient];
    device._createPolestarClient = () => clients.shift();

    assert.equal(await device.attemptReLogin(), false);
    assert.equal(device._authenticationRepairRequired, false);
    assert.match(
        events.find(([kind]) => kind === 'unavailable')[1],
        /temporarily unavailable/,
    );

    assert.equal(await device.attemptReLogin(), true);
    assert.equal(device._authenticationRepairRequired, false);
    assert.equal(device.polestar, recoveredClient);

    assert.equal(await device.attemptReLogin(), false);
    assert.equal(device._authenticationRepairRequired, true);
    assert.equal(events.some(([kind]) => kind === 'unavailable'), true);
});

test('a refreshed token whose first store write fails is retried with the same client', async () => {
    const events = [];
    const { device, store } = createDevice(events);
    store.set(TOKEN_STORE_KEY, validToken());
    const refreshedToken = validToken({
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
    });
    const client = lifecycleClient(events);
    let pendingPersistence = false;
    let loginCalls = 0;
    client.login = async () => {
        loginCalls += 1;
        if (!pendingPersistence) pendingPersistence = true;
        await client.tokenChanged(refreshedToken);
        pendingPersistence = false;
    };
    client.hasPendingTokenPersistence = () => pendingPersistence;

    let storeCalls = 0;
    device.setStoreValue = async (key, value) => {
        storeCalls += 1;
        events.push(['store', key, value]);
        if (storeCalls === 1) throw new Error('Homey store temporarily unavailable');
        store.set(key, value);
    };
    let clientCreations = 0;
    device._createPolestarClient = () => {
        clientCreations += 1;
        return client;
    };

    assert.equal(await device.attemptReLogin(), false);
    assert.equal(clientCreations, 1);
    assert.equal(device._authenticationRepairRequired, false);
    assert.equal(events.some(([kind]) => kind === 'close'), false);

    assert.equal(await device.attemptReLogin(), true);
    assert.equal(clientCreations, 1, 'the client holding the pending token must be reused');
    assert.equal(loginCalls, 2);
    assert.deepEqual(store.get(TOKEN_STORE_KEY), refreshedToken);
    assert.equal(device.polestar, client);
});

test('temporary startup authentication failure retries without requiring repair', async () => {
    const events = [];
    const token = validToken();
    const { device, store, timeouts } = createDevice(events);
    store.set(TOKEN_STORE_KEY, token);
    device.driver.getTokenForDevice = async () => token;

    const temporaryClient = lifecycleClient(events);
    temporaryClient.login = async () => {
        events.push(['temporary-login']);
        throw new Error('Token refresh request failed');
    };
    const recoveredClient = lifecycleClient(events);
    const clients = [temporaryClient, recoveredClient];
    device._createPolestarClient = () => clients.shift();

    await device.onInit();

    assert.equal(device._authenticationRepairRequired, false);
    assert.match(
        events.find(([kind]) => kind === 'unavailable')[1],
        /temporarily unavailable/,
    );
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0].delay, 60_000);

    await timeouts[0].callback();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(device.polestar, recoveredClient);
    assert.equal(device._authenticationRepairRequired, false);
    assert.equal(events.some(([kind]) => kind === 'start-updates'), true);
});

test('temporary legacy migration failure retries token acquisition through the driver', async () => {
    const events = [];
    const token = validToken();
    const client = lifecycleClient(events);
    const { device, timeouts } = createDevice(events);
    let tokenRequests = 0;
    device.driver.getTokenForDevice = async () => {
        tokenRequests += 1;
        if (tokenRequests === 1) {
            throw new Error('Could not migrate Polestar authentication temporarily.');
        }
        return token;
    };
    device._createPolestarClient = () => client;

    await device.onInit();
    assert.equal(device._authenticationRepairRequired, false);
    assert.equal(timeouts.length, 1);

    await timeouts[0].callback();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(tokenRequests, 2);
    assert.equal(device.polestar, client);
    assert.equal(device._authenticationRepairRequired, false);
});

test('manual repair supersedes an in-flight automatic recovery', async () => {
    const events = [];
    const oldToken = validToken();
    const repairedToken = validToken({
        accessToken: 'repaired-access',
        refreshToken: 'repaired-refresh',
    });
    const { device, store } = createDevice(events);
    store.set(TOKEN_STORE_KEY, oldToken);

    const recoveringClient = lifecycleClient(events);
    let releaseRecovery;
    recoveringClient.login = () => new Promise((resolve) => {
        releaseRecovery = resolve;
    });
    const repairedClient = lifecycleClient(events, repairedToken);
    const clients = [recoveringClient];
    device._createPolestarClient = () => clients.shift();

    const recovery = device.attemptReLogin();
    await new Promise((resolve) => setImmediate(resolve));
    await device.replacePolestarClient(repairedClient);
    releaseRecovery();

    assert.equal(await recovery, false);
    assert.equal(device.polestar, repairedClient);
    assert.deepEqual(store.get(TOKEN_STORE_KEY), repairedToken);
    assert.equal(events.some(([kind]) => kind === 'unavailable'), false);
});

test('a delayed callback from a replaced client cannot overwrite the repaired token', async () => {
    const events = [];
    const originalToken = validToken();
    const staleToken = validToken({
        accessToken: 'stale-access',
        refreshToken: 'stale-refresh',
    });
    const repairedToken = validToken({
        accessToken: 'repaired-access',
        refreshToken: 'repaired-refresh',
    });
    const originalClient = lifecycleClient(events, originalToken);
    const repairedClient = lifecycleClient(events, repairedToken);
    const { device, store } = createDevice(events);
    store.set(TOKEN_STORE_KEY, originalToken);
    device.driver.getTokenForDevice = async () => originalToken;
    device._createPolestarClient = () => originalClient;

    await device.onInit();
    const delayedOriginalCallback = originalClient.tokenChanged;
    await device.replacePolestarClient(repairedClient);

    await assert.rejects(
        () => delayedOriginalCallback(staleToken),
        /superseded/,
    );
    assert.deepEqual(store.get(TOKEN_STORE_KEY), repairedToken);
    assert.equal(device.polestar, repairedClient);
});

test('terminal refresh rejection stops authenticated polling until repair', async () => {
    const events = [];
    const { device, store } = createDevice(events);
    store.set(TOKEN_STORE_KEY, validToken());
    const rejectedClient = lifecycleClient(events);
    rejectedClient.login = async () => {
        throw new Error('Refresh failed: 401');
    };
    device._createPolestarClient = () => rejectedClient;
    device._timerTimers = { name: 'fast' };
    device._timerHealth = { name: 'slow' };
    const cleared = [];
    device.homey.clearInterval = (handle) => {
        cleared.push(handle.name);
    };

    assert.equal(await device.attemptReLogin(), false);

    assert.equal(device._authenticationRepairRequired, true);
    assert.deepEqual(cleared.sort(), ['fast', 'slow']);
    assert.equal(device._timerTimers, null);
    assert.equal(device._timerHealth, null);
});

test('pre-adoption availability failure closes the authenticated candidate', async () => {
    const events = [];
    const { device, store } = createDevice(events);
    store.set(TOKEN_STORE_KEY, validToken());
    const client = lifecycleClient(events);
    device._createPolestarClient = () => client;
    device.setAvailable = async () => {
        throw new Error('Homey availability update failed');
    };

    assert.equal(await device.attemptReLogin(), false);
    assert.equal(device.polestar, null);
    assert.equal(events.filter(([kind]) => kind === 'close').length, 1);
});

test('successful repair cancels a scheduled startup authentication retry', async () => {
    const events = [];
    const token = validToken();
    const client = lifecycleClient(events, token);
    const { device, timeouts } = createDevice(events);
    device._destroyed = false;
    device._authGeneration = 1;
    device._authenticationRepairRequired = false;
    device._scheduleAuthenticationRetry();
    assert.equal(timeouts.length, 1);

    await device.replacePolestarClient(client);

    assert.equal(timeouts[0].cleared, true);
    assert.equal(device._authenticationRetryTimer, null);
    assert.equal(device.polestar, client);
});

test('authentication recovery cannot install a client after device teardown', async () => {
    const events = [];
    const { device, store } = createDevice(events);
    store.set(TOKEN_STORE_KEY, validToken());
    const client = lifecycleClient(events);
    let releaseLogin;
    client.login = () => new Promise((resolve) => {
        releaseLogin = resolve;
    });
    device._createPolestarClient = () => client;

    const recovery = device.attemptReLogin();
    await new Promise((resolve) => setImmediate(resolve));
    device._cleanup();
    releaseLogin();

    assert.equal(await recovery, false);
    assert.equal(device.polestar, undefined);
    assert.equal(events.filter(([kind]) => kind === 'close').length, 1);
    assert.equal(events.some(([kind]) => kind === 'available'), false);
});

test('device teardown closes a client whose pending token write fails afterward', async () => {
    const events = [];
    const { device, store } = createDevice(events);
    store.set(TOKEN_STORE_KEY, validToken());
    const client = lifecycleClient(events);
    let rejectLogin;
    client.login = () => new Promise((resolve, reject) => {
        rejectLogin = reject;
    });
    client.hasPendingTokenPersistence = () => true;
    device._createPolestarClient = () => client;

    const recovery = device.attemptReLogin();
    await new Promise((resolve) => setImmediate(resolve));
    device._cleanup();
    rejectLogin(new Error('Homey store temporarily unavailable'));

    assert.equal(await recovery, false);
    assert.equal(device._pendingPolestarClient, null);
    assert.equal(events.filter(([kind]) => kind === 'close').length, 1);
});

test('failed startup authentication does not mutate Homey after device teardown', async () => {
    const events = [];
    const token = validToken();
    const client = lifecycleClient(events);
    const {
        device,
        settingListeners,
        store,
    } = createDevice(events);
    store.set(TOKEN_STORE_KEY, token);
    device.driver.getTokenForDevice = async () => token;
    let rejectLogin;
    client.login = () => new Promise((resolve, reject) => {
        rejectLogin = reject;
    });
    device._createPolestarClient = () => client;

    const initialization = device.onInit();
    await new Promise((resolve) => setImmediate(resolve));
    device._cleanup();
    rejectLogin(new Error('Token refresh request failed'));
    await initialization;

    assert.equal(events.filter(([kind]) => kind === 'close').length, 1);
    assert.equal(events.some(([kind]) => kind === 'unavailable'), false);
    assert.equal(settingListeners.size, 0);
});

test('device teardown removes its distance-unit settings listener', async () => {
    const events = [];
    const token = validToken();
    const client = lifecycleClient(events);
    const { device, settingListeners } = createDevice(events);
    device.driver.getTokenForDevice = async () => token;
    device._createPolestarClient = () => client;

    await device.onInit();
    assert.equal(settingListeners.size, 1);

    device._cleanup();
    assert.equal(settingListeners.size, 0);
});
