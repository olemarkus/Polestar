'use strict';

const TOKEN_STORE_KEY = 'polestarToken';
const LEGACY_SETTING_KEYS = [
    'user_email',
    'user_password',
    'polestar_token',
    'c3_backend_disabled',
];

function normalizeToken(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

    const accessToken = typeof value.accessToken === 'string' ? value.accessToken.trim() : '';
    const refreshToken = typeof value.refreshToken === 'string' ? value.refreshToken.trim() : '';
    const expiresAt = Number(value.expiresAt);

    if (!accessToken || !refreshToken || !Number.isFinite(expiresAt) || expiresAt <= 0) {
        return null;
    }

    return { accessToken, refreshToken, expiresAt };
}

function readToken(device) {
    return normalizeToken(device.getStoreValue(TOKEN_STORE_KEY));
}

async function persistToken(device, token) {
    const normalized = normalizeToken(token);
    if (!normalized) {
        throw new Error('Polestar authentication did not return a reusable refresh token');
    }
    await device.setStoreValue(TOKEN_STORE_KEY, normalized);
    return normalized;
}

async function clearLegacySettings(settings) {
    let firstError = null;
    for (const key of LEGACY_SETTING_KEYS) {
        try {
            await settings.unset(key);
        } catch (err) {
            if (!firstError) firstError = err;
        }
    }
    if (firstError) throw firstError;
}

function hasLegacySettings(settings) {
    return LEGACY_SETTING_KEYS.some((key) => {
        const value = settings.get(key);
        return value !== null && value !== undefined;
    });
}

module.exports = {
    LEGACY_SETTING_KEYS,
    TOKEN_STORE_KEY,
    clearLegacySettings,
    hasLegacySettings,
    normalizeToken,
    persistToken,
    readToken,
};
