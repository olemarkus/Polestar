'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const test = require('node:test');

const axios = require('axios');
const { AuthManager } = require('../clone_modules/polestar-c3/auth');
const grpc = require('../clone_modules/polestar-c3/grpc');
const { sanitizeLogData, sanitizeString } = require('../lib/log-sanitizer');

const originalModuleLoad = Module._load;
let PolestarApp;
let PolestarVehicle;
try {
    Module._load = function loadWithHomeyStub(request, parent, isMain) {
        if (request === 'homey') return { App: class {}, Device: class {} };
        if (request === '../../clone_modules/polestar.js') return class {};
        return originalModuleLoad.call(this, request, parent, isMain);
    };
    PolestarApp = require('../app');
    PolestarVehicle = require('../drivers/vehicle/device');
} finally {
    Module._load = originalModuleLoad;
}

function syntheticVin() {
    return `YSM${'0'.repeat(10)}1234`;
}

test('sanitizer masks VINs and precise coordinates in strings', () => {
    const message = `vehicle ${syntheticVin()} at 59.12345, 10.54321 latitude=59.12345 Bearer token-value`;
    assert.equal(
        sanitizeString(message),
        'vehicle YSM…1234 at [location redacted] latitude=[location redacted] Bearer [redacted]',
    );
    assert.equal(sanitizeString('refresh_token=secret-value'), 'refresh_token=[redacted]');
    assert.equal(sanitizeString('refreshToken=secret-value'), 'refreshToken=[redacted]');
    assert.equal(sanitizeString('password=two words; retained'), 'password=[redacted]; retained');
    assert.equal(sanitizeString('Cookie: sid=alpha; refresh=beta'), 'Cookie: [redacted]');
    assert.equal(sanitizeString('Basic dGVzdDpzZWNyZXQ='), 'Basic [redacted]');
    assert.equal(sanitizeString('username=account-name'), 'username=[redacted]');
    assert.equal(sanitizeString('signed in as test@example.com'), 'signed in as [email redacted]');
    assert.equal(sanitizeString('-33.86882, 151.20929'), '[location redacted]');
    assert.equal(sanitizeString('+59.12345, +10.54321'), '[location redacted]');
    assert.equal(sanitizeString(`vehicle_${syntheticVin()}_status`), 'vehicle_YSM…1234_status');
    assert.equal(
        sanitizeString('Location failed: {"latitude":59.12345,"longitude":10.54321}'),
        'Location failed: {"latitude":[location redacted],"longitude":[location redacted]}',
    );
});

test('sanitizer parses JSON-shaped log messages before storing them', () => {
    const sanitized = JSON.parse(sanitizeString(JSON.stringify({
        access_token: 'ACCESS_SECRET',
        refreshToken: 'REFRESH_SECRET',
        authorization: 'Basic dGVzdDpzZWNyZXQ=',
        nested: { latitude: -33.86882, longitude: 151.20929 },
    })));

    assert.deepEqual(sanitized, {
        access_token: '[redacted]',
        refreshToken: '[redacted]',
        authorization: '[redacted]',
        nested: {
            latitude: '[location redacted]',
            longitude: '[location redacted]',
        },
    });
});

test('sanitizer recursively redacts credentials and location shapes', () => {
    const sanitized = sanitizeLogData({
        vin: syntheticVin(),
        password: 'secret',
        username: 'test@example.com',
        accessToken: 'token-value',
        apiKey: 'API_SECRET',
        'x-api-key': 'HEADER_API_SECRET',
        jwt: 'JWT_SECRET',
        'pf.pass': 'PASSWORD_SECRET',
        auth: { pass: 'NESTED_PASSWORD_SECRET' },
        nested: {
            latitude: 59.12345,
            longitude: 10.54321,
            coordinates: [59.12345, 10.54321],
        },
    });

    assert.deepEqual(sanitized, {
        vin: 'YSM…1234',
        password: '[redacted]',
        username: '[redacted]',
        accessToken: '[redacted]',
        apiKey: '[redacted]',
        'x-api-key': '[redacted]',
        jwt: '[redacted]',
        'pf.pass': '[redacted]',
        auth: { pass: '[redacted]' },
        nested: {
            latitude: '[location redacted]',
            longitude: '[location redacted]',
            coordinates: '[location redacted]',
        },
    });
});

test('sanitizer recognizes precise coordinate arrays without a location key', () => {
    assert.equal(sanitizeString('[59.12345,10.54321]'), '[location redacted]');
    assert.deepEqual(
        sanitizeLogData({ sample: [59.12345, 10.54321], readings: [1, 2] }),
        { sample: '[location redacted]', readings: [1, 2] },
    );
});

test('sanitized objects cannot execute serialization hooks that reveal secrets', () => {
    const rawSecret = 'SERIALIZATION_SECRET';
    const source = {
        safe: 'retained',
        toJSON() { return { accessToken: rawSecret }; },
    };
    Object.defineProperty(source, 'computed', {
        enumerable: true,
        get() { return rawSecret; },
    });

    const serialized = JSON.stringify(sanitizeLogData(source));
    assert.doesNotMatch(serialized, new RegExp(rawSecret));
    assert.deepEqual(JSON.parse(serialized), {
        safe: 'retained',
        toJSON: '[redacted]',
        computed: '[accessor redacted]',
    });
});

test('friendly gRPC errors still map status-only safe error messages', () => {
    assert.equal(
        PolestarVehicle.friendlyGrpcError('gRPC /x status=7 (PERMISSION_DENIED)', 'Unlock'),
        'Unlock: permission denied (VIN not linked to this account)',
    );
    assert.equal(
        PolestarVehicle.friendlyGrpcError('gRPC /x status=14 (UNAVAILABLE)', 'Lock'),
        'Lock: service temporarily unavailable',
    );
});

test('sanitizer handles errors, aliases, cycles, binary data, and falsy data', () => {
    const shared = { authorization: 'Bearer secret' };
    const cycle = {};
    cycle.self = cycle;
    const sanitized = sanitizeLogData({
        error: new Error(`vehicle ${syntheticVin()} failed`),
        first: shared,
        second: shared,
        cycle,
        bytes: Buffer.from(syntheticVin()),
        zero: 0,
        disabled: false,
        empty: '',
    });

    assert.match(sanitized.error.error, /vehicle YSM…1234 failed/);
    assert.doesNotMatch(sanitized.error.stacktrace, new RegExp(syntheticVin()));
    assert.deepEqual(sanitized.first, { authorization: '[redacted]' });
    assert.deepEqual(sanitized.second, { authorization: '[redacted]' });
    assert.deepEqual(sanitized.cycle, { self: '[circular]' });
    assert.equal(sanitized.bytes, '[binary data redacted: 17 bytes]');
    assert.equal(sanitized.zero, 0);
    assert.equal(sanitized.disabled, false);
    assert.equal(sanitized.empty, '');
});

test('Chronos request diagnostics never print a VIN or raw request bytes', async () => {
    const { PolestarC3 } = require('../clone_modules/polestar-c3/client');
    const vin = syntheticVin();
    const consoleEntries = [];
    const client = new PolestarC3('test@example.com', 'unused');
    client._vin = vin;
    client._call = async () => Buffer.alloc(0);

    const originalConsoleLog = console.log;
    console.log = (...args) => consoleEntries.push(args);
    try {
        await client._chronosCall('/test.Service/Method', Buffer.from('request body'), { debug: true });
    } finally {
        console.log = originalConsoleLog;
    }

    const output = JSON.stringify(consoleEntries);
    assert.match(output, /REQUEST size=/);
    assert.doesNotMatch(output, new RegExp(vin));
    assert.doesNotMatch(output, new RegExp(Buffer.from(vin).toString('hex'), 'i'));
    assert.doesNotMatch(output, /request body/);
});

test('token exchange errors do not retain response credentials', async () => {
    const originalPost = axios.post;
    axios.post = async () => ({
        status: 400,
        data: { access_token: 'ACCESS_SECRET', refresh_token: 'REFRESH_SECRET' },
    });
    try {
        const auth = new AuthManager();
        auth._tokenEndpoint = 'https://example.invalid/token';
        await assert.rejects(
            () => auth._exchange('auth-code', 'verifier'),
            (err) => {
                assert.equal(err.message, 'Token exchange failed: 400');
                assert.doesNotMatch(err.message, /ACCESS_SECRET|REFRESH_SECRET/);
                return true;
            },
        );
    } finally {
        axios.post = originalPost;
    }
});

class FakeUnaryRequest extends EventEmitter {
    close() {}

    end() {
        queueMicrotask(() => {
            this.emit('response', {
                ':status': 200,
                authorization: 'Bearer ACCESS_SECRET',
                'x-vehicle': syntheticVin(),
            });
            this.emit('data', Buffer.from(syntheticVin()));
            this.emit('trailers', {
                'grpc-status': 0,
                'set-cookie': 'session=COOKIE_SECRET',
            });
            this.emit('end');
        });
    }
}

test('gRPC diagnostics and parse errors never expose headers or raw response bytes', async () => {
    const request = new FakeUnaryRequest();
    const consoleEntries = [];
    const originalConsoleError = console.error;
    console.error = (...args) => consoleEntries.push(args);
    try {
        await assert.rejects(
            () => grpc.unaryUnary(
                { request: () => request },
                '/test.Service/Method',
                Buffer.alloc(0),
                {},
                { debug: true },
            ),
            (err) => {
                assert.match(err.message, /not parseable as gRPC frames/);
                assert.doesNotMatch(err.message, /hex=/);
                assert.doesNotMatch(err.message, new RegExp(Buffer.from(syntheticVin()).toString('hex'), 'i'));
                return true;
            },
        );
    } finally {
        console.error = originalConsoleError;
    }

    const output = JSON.stringify(consoleEntries);
    assert.doesNotMatch(output, new RegExp(syntheticVin()));
    assert.doesNotMatch(output, /ACCESS_SECRET|COOKIE_SECRET/);
    assert.match(output, /\[redacted\]/);
});

test('app logger stores and publishes only sanitized data', () => {
    const debugWrites = [];
    const realtimeEntries = [];
    const consoleEntries = [];
    const app = Object.create(PolestarApp.prototype);
    app.userLanguage = 'en';
    app.homey = {
        settings: {
            get: () => [],
            set: (key, value) => debugWrites.push({ key, value }),
        },
        api: {
            realtime: (event, value) => realtimeEntries.push({ event, value }),
        },
    };

    const originalConsoleLog = console.log;
    console.log = (...args) => consoleEntries.push(args);
    try {
        app.log(
            `vehicle ${syntheticVin()}`,
            `device ${syntheticVin()}`,
            'DEBUG',
            {
                vin: syntheticVin(),
                password: 'secret',
                location: '59.12345, 10.54321',
            },
        );
    } finally {
        console.log = originalConsoleLog;
    }

    const storedEntry = debugWrites.at(-1).value[0];
    assert.equal(storedEntry.message, 'vehicle YSM…1234');
    assert.deepEqual(storedEntry.data, {
        vin: 'YSM…1234',
        password: '[redacted]',
        location: '[location redacted]',
    });
    assert.deepEqual(realtimeEntries[0], { event: 'debugLog', value: storedEntry });
    assert.match(consoleEntries[0][0], /\[device YSM…1234\]/);
    assert.deepEqual(consoleEntries[0][1], storedEntry.data);
});
