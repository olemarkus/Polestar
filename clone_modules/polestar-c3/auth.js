'use strict';

const crypto = require('crypto');
const axios = require('axios');
const qs = require('qs');

const OIDC_PROVIDER = 'https://polestarid.eu.polestar.com';
const OIDC_DISCOVERY = `${OIDC_PROVIDER}/.well-known/openid-configuration`;
const CLIENT_ID = 'lp8dyrd_10';
const REDIRECT_URI = 'polestar-explore://explore.polestar.com';
const SCOPES = 'openid profile email customer:attributes customer:attributes:write';

function b64url(buf) {
    return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function generatePkce() {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

function generateState() {
    return b64url(crypto.randomBytes(32));
}

class AuthManager {
    constructor() {
        this._tokens = null;
        this._authEndpoint = null;
        this._tokenEndpoint = null;
        this._tokenChangeCallbacks = new Set();
        this._refreshPromise = null;
        this._pendingTokens = null;
        this._persistencePromise = null;
    }

    get accessToken() { return this._tokens ? this._tokens.accessToken : null; }
    get isExpired() {
        if (!this._tokens) return true;
        return Date.now() >= this._tokens.expiresAt - 60_000;
    }

    restoreToken(token) {
        this._tokens = this._validateToken(token);
        this._pendingTokens = null;
    }

    getToken() {
        return this._tokens ? { ...this._tokens } : null;
    }

    hasPendingTokenPersistence() {
        return this._pendingTokens !== null;
    }

    onTokenChanged(callback) {
        if (typeof callback !== 'function') {
            throw new TypeError('Token change callback must be a function');
        }
        this._tokenChangeCallbacks.add(callback);
        return () => this._tokenChangeCallbacks.delete(callback);
    }

    async _discover() {
        if (this._authEndpoint && this._tokenEndpoint) return;
        const r = await axios.get(OIDC_DISCOVERY, { timeout: 30000 });
        this._authEndpoint = r.data.authorization_endpoint;
        this._tokenEndpoint = r.data.token_endpoint;
    }

    async authenticate(email, password) {
        await this._discover();
        await this._fullAuth(email, password);
    }

    async ensureValidToken() {
        await this._persistPendingTokens();
        if (!this._tokens) throw new Error('Not authenticated');
        if (this.isExpired) {
            if (!this._tokens.refreshToken) {
                throw new Error('Token expired and no refresh token is available; repair is required');
            }
            if (!this._refreshPromise) {
                this._refreshPromise = (async () => {
                    try {
                        await this._refresh();
                    } finally {
                        this._refreshPromise = null;
                    }
                })();
            }
            await this._refreshPromise;
        }
        return this._tokens.accessToken;
    }

    async _fullAuth(email, password) {
        const { verifier, challenge } = generatePkce();
        const code = await this._authorize(challenge, email, password);
        await this._exchange(code, verifier);
    }

    async _authorize(codeChallenge, email, password) {
        const state = generateState();
        const params = {
            response_type: 'code',
            client_id: CLIENT_ID,
            redirect_uri: REDIRECT_URI,
            scope: SCOPES,
            state,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            response_mode: 'query',
        };

        // Step 1: follow through to login form, collecting cookies.
        const jar = [];
        const collectCookies = (res) => {
            const sc = res.headers && res.headers['set-cookie'];
            if (sc) for (const c of sc) jar.push(c.split(';')[0]);
        };
        const cookieHeader = () => jar.join('; ');

        let r = await axios.get(this._authEndpoint, {
            params,
            maxRedirects: 0,
            validateStatus: () => true,
        });
        collectCookies(r);
        // Follow redirects manually so we can keep cookies.
        while (r.status >= 300 && r.status < 400 && r.headers.location) {
            const loc = r.headers.location.startsWith('http') ? r.headers.location : OIDC_PROVIDER + r.headers.location;
            r = await axios.get(loc, { maxRedirects: 0, validateStatus: () => true, headers: { cookie: cookieHeader() } });
            collectCookies(r);
        }

        const html = typeof r.data === 'string' ? r.data : '';
        const m = html.match(/(?:url|action)\s*:\s*"([^"]+)"/);
        if (!m) throw new Error(`Auth page did not contain resume URL (status ${r.status})`);
        const resumeUrl = m[1].startsWith('http') ? m[1] : OIDC_PROVIDER + m[1];

        // Step 2: post credentials.
        try {
            r = await axios.post(resumeUrl, qs.stringify({ 'pf.username': email, 'pf.pass': password }), {
                params,
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    cookie: cookieHeader(),
                },
                maxRedirects: 0,
                validateStatus: () => true,
            });
        } catch (_) {
            // Axios errors retain request config, including the form body.
            // Replace them so a caller cannot accidentally log the password.
            throw new Error('Authentication request failed');
        }
        collectCookies(r);

        if (r.status !== 302 && r.status !== 303) {
            const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
            if (body.includes('ERR001')) throw new Error('Invalid username or password');
            throw new Error(`Auth failed with status ${r.status}`);
        }

        let location = r.headers.location || '';
        let parsed;
        try {
            parsed = new URL(location, OIDC_PROVIDER);
        } catch (_) {
            throw new Error('Authentication returned an invalid redirect');
        }
        let code = parsed.searchParams.get('code');
        const uid = parsed.searchParams.get('uid');

        // Terms & Conditions flow.
        if (!code && uid) {
            try {
                r = await axios.post(resumeUrl, qs.stringify({ 'pf.submit': 'true', subject: uid }), {
                    params,
                    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader() },
                    maxRedirects: 0,
                    validateStatus: () => true,
                });
            } catch (_) {
                throw new Error('Authentication continuation request failed');
            }
            collectCookies(r);
            if (r.status === 302 || r.status === 303) {
                location = r.headers.location || '';
                try {
                    parsed = new URL(location, OIDC_PROVIDER);
                } catch (_) {
                    throw new Error('Authentication returned an invalid redirect');
                }
                code = parsed.searchParams.get('code');
            }
        }

        if (!code) throw new Error('Authentication did not return an authorization code');
        return code;
    }

    async _exchange(code, verifier) {
        let r;
        try {
            r = await axios.post(this._tokenEndpoint, qs.stringify({
                grant_type: 'authorization_code',
                code,
                redirect_uri: REDIRECT_URI,
                client_id: CLIENT_ID,
                code_verifier: verifier,
            }), {
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                validateStatus: () => true,
                timeout: 30000,
            });
        } catch (_) {
            throw new Error('Token exchange request failed');
        }
        if (r.status !== 200) throw new Error(`Token exchange failed: ${r.status}`);
        await this._storeTokens(r.data);
    }

    async _refresh() {
        // A restored token has not gone through password authentication, so
        // endpoint discovery may not have run in this process yet.
        await this._discover();
        let r;
        try {
            r = await axios.post(this._tokenEndpoint, qs.stringify({
                grant_type: 'refresh_token',
                refresh_token: this._tokens.refreshToken,
                client_id: CLIENT_ID,
            }), {
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                validateStatus: () => true,
                timeout: 30000,
            });
        } catch (_) {
            throw new Error('Token refresh request failed');
        }
        if (r.status !== 200) throw new Error(`Refresh failed: ${r.status}`);
        await this._storeTokens(r.data);
    }

    async _storeTokens(data) {
        const accessToken = data && data.access_token;
        const expiresIn = Number(data && data.expires_in);
        if (typeof accessToken !== 'string' || accessToken.trim() === '') {
            throw new Error('Token response did not include an access token');
        }
        if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
            throw new Error('Token response did not include a valid expiry');
        }

        const replacementRefreshToken = data && data.refresh_token;
        const refreshToken = typeof replacementRefreshToken === 'string' && replacementRefreshToken.trim() !== ''
            ? replacementRefreshToken
            : (this._tokens && this._tokens.refreshToken);
        if (typeof refreshToken !== 'string' || refreshToken.trim() === '') {
            throw new Error('Token response did not include a refresh token');
        }

        this._pendingTokens = this._validateToken({
            accessToken,
            refreshToken,
            expiresAt: Date.now() + expiresIn * 1000,
        });
        await this._persistPendingTokens();
    }

    async _persistPendingTokens() {
        if (!this._pendingTokens) return;
        if (!this._persistencePromise) {
            this._persistencePromise = (async () => {
                const pending = this._pendingTokens;

                // Persistence callbacks are awaited before the token becomes
                // usable. A failed device-store write remains pending and is
                // retried on the next token check.
                for (const callback of [...this._tokenChangeCallbacks]) {
                    await callback({ ...pending });
                }
                this._tokens = pending;
                if (this._pendingTokens === pending) this._pendingTokens = null;
            })().finally(() => {
                this._persistencePromise = null;
            });
        }
        await this._persistencePromise;
    }

    _validateToken(token) {
        if (!token || typeof token !== 'object' || Array.isArray(token)) {
            throw new TypeError('Token must be an object');
        }
        if (typeof token.accessToken !== 'string' || token.accessToken.trim() === '') {
            throw new TypeError('Token accessToken must be a non-empty string');
        }
        if (typeof token.refreshToken !== 'string' || token.refreshToken.trim() === '') {
            throw new TypeError('Token refreshToken must be a non-empty string');
        }
        if (typeof token.expiresAt !== 'number' || !Number.isFinite(token.expiresAt) || token.expiresAt <= 0) {
            throw new TypeError('Token expiresAt must be a positive finite number');
        }
        return {
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            expiresAt: token.expiresAt,
        };
    }
}

module.exports = { AuthManager, CLIENT_ID, REDIRECT_URI };
