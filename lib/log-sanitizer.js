'use strict';

const VIN_PATTERN = /(^|[^A-HJ-NPR-Z0-9])([A-HJ-NPR-Z0-9]{3})[A-HJ-NPR-Z0-9]{10}([A-HJ-NPR-Z0-9]{4})(?=$|[^A-HJ-NPR-Z0-9])/gi;
const COORDINATE_PATTERN = /[+-]?\d{1,3}\.\d{4,}\s*,\s*[+-]?\d{1,3}\.\d{4,}/g;
const LABELLED_COORDINATE_PATTERN = /(["']?(?:lat(?:itude)?|lng|lon(?:gitude)?)["']?\s*[:=]\s*)[+-]?\d{1,3}\.\d{4,}/gi;
const AUTHORIZATION_PATTERN = /\b(Bearer|Basic)\s+[^\s,"';}\]]+/gi;
const COOKIE_ASSIGNMENT_PATTERN = /(["']?(?:set[_-]?cookie|cookie)["']?\s*[:=]\s*)[^\n]+/gi;
const SECRET_ASSIGNMENT_PATTERN = /(["']?(?:password|passcode|pf[._-]?pass|secret|api[_-]?key|jwt|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|code[_-]?verifier|(?:authorization|auth)[_-]?code|authorization|user[_-]?name|user[_-]?email|email|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\n,;}\]]+)/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SECRET_KEY_PATTERN = /password|passcode|secret|token|authorization|cookie|email|username|codeverifier|apikey|jwt|credential|privatekey|signingkey|sessionkey|sessionid/i;
const VIN_KEYS = new Set(['vin', 'vehiclevin', 'vehicleidentificationnumber']);
const LOCATION_KEYS = new Set([
    'lat', 'latitude', 'lng', 'lon', 'longitude', 'location', 'coordinates',
    'position', 'point', 'geo', 'gps', 'lastknownlocation',
]);

function normalizeKey(key) {
    return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function sanitizeFreeText(value) {
    return value
        .replace(COOKIE_ASSIGNMENT_PATTERN, '$1[redacted]')
        .replace(SECRET_ASSIGNMENT_PATTERN, '$1[redacted]')
        .replace(AUTHORIZATION_PATTERN, '$1 [redacted]')
        .replace(EMAIL_PATTERN, '[email redacted]')
        .replace(VIN_PATTERN, '$1$2…$3')
        .replace(COORDINATE_PATTERN, '[location redacted]')
        .replace(LABELLED_COORDINATE_PATTERN, '$1[location redacted]');
}

function sanitizeString(value) {
    const stringValue = String(value);
    const trimmed = stringValue.trim();

    // Error messages commonly contain JSON response bodies. Parse them when the
    // entire string is JSON so nested credentials and coordinates are treated as
    // data rather than relying only on free-text patterns.
    if ((trimmed.startsWith('{') && trimmed.endsWith('}'))
        || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
            const sanitized = sanitizeLogData(JSON.parse(trimmed));
            return typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
        } catch (_) {
            // Malformed or non-JSON log text is handled below.
        }
    }

    return sanitizeFreeText(stringValue);
}

function maskVin(value) {
    const vin = String(value || '');
    if (vin.length < 8) return '[vin redacted]';
    return `${vin.slice(0, 3)}…${vin.slice(-4)}`;
}

function isLocationKey(key) {
    const normalized = normalizeKey(key);
    return LOCATION_KEYS.has(normalized)
        || normalized.endsWith('coordinates')
        || normalized.endsWith('location')
        || normalized.endsWith('latitude')
        || normalized.endsWith('longitude');
}

function isPreciseCoordinatePair(value) {
    if (!Array.isArray(value) || value.length !== 2) return false;
    const [first, second] = value;
    if (!Number.isFinite(first) || !Number.isFinite(second)) return false;

    const withinCoordinateBounds = (Math.abs(first) <= 90 && Math.abs(second) <= 180)
        || (Math.abs(first) <= 180 && Math.abs(second) <= 90);
    const hasPreciseFraction = [first, second].some((coordinate) => (
        Math.abs(coordinate * 1000 - Math.round(coordinate * 1000)) > 1e-6
    ));
    return withinCoordinateBounds && hasPreciseFraction;
}

function sanitizeLogData(value, ancestors = new WeakSet()) {
    if (typeof value === 'string') return sanitizeString(value);
    if (typeof value === 'function') return '[function redacted]';
    if (value === null || value === undefined || typeof value !== 'object') return value;

    if (Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        return `[binary data redacted: ${value.byteLength} bytes]`;
    }
    if (value instanceof Date) return value.toISOString();
    if (ancestors.has(value)) return '[circular]';

    ancestors.add(value);
    try {
        if (value instanceof Error) {
            return {
                error: sanitizeString(value.message || String(value)),
                stacktrace: value.stack ? sanitizeString(value.stack) : null,
            };
        }
        if (isPreciseCoordinatePair(value)) return '[location redacted]';
        if (Array.isArray(value)) {
            return value.map((item) => sanitizeLogData(item, ancestors));
        }

        const result = {};
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
            const normalizedKey = normalizeKey(key);
            if (normalizedKey === 'tojson') {
                result[key] = '[redacted]';
            } else if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                result[key] = '[accessor redacted]';
            } else if (SECRET_KEY_PATTERN.test(normalizedKey) || normalizedKey.endsWith('pass')) {
                result[key] = '[redacted]';
            } else if (VIN_KEYS.has(normalizedKey)) {
                result[key] = maskVin(descriptor.value);
            } else if (isLocationKey(key)) {
                result[key] = '[location redacted]';
            } else {
                result[key] = sanitizeLogData(descriptor.value, ancestors);
            }
        }
        return result;
    } finally {
        ancestors.delete(value);
    }
}

module.exports = { sanitizeLogData, sanitizeString };
