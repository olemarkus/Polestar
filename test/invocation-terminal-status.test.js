'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const codec = require('../clone_modules/polestar-c3/codec');
const grpc = require('../clone_modules/polestar-c3/grpc');
const { PolestarC3 } = require('../clone_modules/polestar-c3/client');
const {
    CarUnlockRequestSchema,
    InvocationResponseEnvelopeSchema,
} = require('../clone_modules/polestar-c3/messages');

const InvocationResponseSchema = {
    id: { num: 1, type: 'string' },
    vin: { num: 2, type: 'string' },
    status: { num: 3, type: 'int32' },
    message: { num: 4, type: 'string' },
};

function invocationFrame(status, message = '') {
    return codec.encode(InvocationResponseEnvelopeSchema, {
        response: codec.encode(InvocationResponseSchema, {
            id: 'request-id',
            vin: 'stored-vin',
            status,
            message,
        }),
    });
}

test('invocation waits past acknowledgements for terminal SUCCESS', async () => {
    const client = new PolestarC3('test@example.com', 'unused');
    client._vin = 'stored-vin';
    client._call = async (method, request, options) => {
        assert.equal(method, '/invocation.InvocationService/Unlock');
        assert.equal(options.timeoutMs, 45000);
        assert.equal(options.retries, 0);
        assert.equal(options.streamUntil(invocationFrame(1)), false, 'SENT is not terminal');
        assert.equal(options.streamUntil(invocationFrame(4)), false, 'DELIVERED is not terminal');
        assert.equal(options.streamUntil(invocationFrame(6)), true, 'SUCCESS is terminal');
        assert.equal(options.streamUntil(invocationFrame(8)), true, 'failure is terminal');
        const decoded = codec.decode(CarUnlockRequestSchema, request);
        assert.equal(decoded.unlock_type, 1, 'trunk-only unlock enum');
        assert.equal(decoded.request.vin, 'stored-vin');
        return invocationFrame(6);
    };

    const result = await client.unlockTrunk();
    assert.equal(result.statusLabel, 'SUCCESS');
    assert.equal(result.ok, true);
    assert.equal('vin' in result, false, 'VIN must not escape into command logs');
    assert.equal('id' in result, false, 'request identifier is not useful command feedback');
});

test('terminal invocation failure is rejected instead of reported as success', async () => {
    const client = new PolestarC3('test@example.com', 'unused');
    client._vin = 'stored-vin';
    client._call = async () => invocationFrame(8, 'car rejected command');

    await assert.rejects(
        () => client.unlockTrunk(),
        /UNKNOWN_CAR_ERROR.*car rejected command/,
    );
});

class FakeRequest extends EventEmitter {
    constructor(chunks, trailers = { 'grpc-status': 0 }) {
        super();
        this.chunks = chunks;
        this.responseTrailers = trailers;
        this.closed = false;
    }

    close() { this.closed = true; }

    end() {
        queueMicrotask(() => {
            this.emit('response', { ':status': 200 });
            for (const chunk of this.chunks) this.emit('data', chunk);
            this.emit('trailers', this.responseTrailers);
            this.emit('end');
        });
    }
}

test('serverStreamUntil handles split chunks and multiple frames', async () => {
    const frames = Buffer.concat([
        grpc.frameMessage(Buffer.from([1])),
        grpc.frameMessage(Buffer.from([4])),
        grpc.frameMessage(Buffer.from([6])),
    ]);
    const request = new FakeRequest([frames.subarray(0, 7), frames.subarray(7)]);
    const result = await grpc.serverStreamUntil(
        { request: () => request },
        '/test/stream',
        Buffer.alloc(0),
        {},
        { isTerminal: (frame) => frame[0] === 6 },
    );

    assert.equal(result[0], 6);
});

test('serverStreamFirst still resolves the first complete frame', async () => {
    const request = new FakeRequest([
        Buffer.concat([
            grpc.frameMessage(Buffer.from([1])),
            grpc.frameMessage(Buffer.from([4])),
        ]),
    ]);
    const result = await grpc.serverStreamFirst(
        { request: () => request },
        '/test/stream',
        Buffer.alloc(0),
    );

    assert.equal(result[0], 1);
});

test('serverStreamUntil rejects a stream that ends after acknowledgement only', async () => {
    const request = new FakeRequest([grpc.frameMessage(Buffer.from([1]))]);
    await assert.rejects(
        () => grpc.serverStreamUntil(
            { request: () => request },
            '/test/stream',
            Buffer.alloc(0),
            {},
            { isTerminal: (frame) => frame[0] === 6 },
        ),
        /ended before a terminal response/,
    );
});

test('serverStreamUntil surfaces nonzero gRPC trailers', async () => {
    const debugEntries = [];
    const request = new FakeRequest(
        [grpc.frameMessage(Buffer.from([1]))],
        {
            'grpc-status': 14,
            'grpc-message': 'BACKEND_SECRET',
            authorization: 'Bearer ACCESS_SECRET',
        },
    );
    const originalConsoleError = console.error;
    console.error = (...args) => debugEntries.push(args);
    try {
        await assert.rejects(
            () => grpc.serverStreamUntil(
                { request: () => request },
                '/test/stream',
                Buffer.alloc(0),
                {},
                { debug: true, isTerminal: () => false },
            ),
            (err) => {
                assert.match(err.message, /status=14.*UNAVAILABLE/);
                assert.doesNotMatch(err.message, /BACKEND_SECRET|ACCESS_SECRET/);
                return true;
            },
        );
    } finally {
        console.error = originalConsoleError;
    }
    assert.doesNotMatch(JSON.stringify(debugEntries), /BACKEND_SECRET|ACCESS_SECRET/);
});

test('serverStreamUntil cancels a stream after its terminal timeout', async () => {
    const request = new FakeRequest([]);
    request.end = () => {};
    await assert.rejects(
        () => grpc.serverStreamUntil(
            { request: () => request },
            '/test/stream',
            Buffer.alloc(0),
            {},
            { timeoutMs: 5, isTerminal: () => false },
        ),
        /timeout waiting for terminal stream response/,
    );
    assert.equal(request.closed, true);
});
