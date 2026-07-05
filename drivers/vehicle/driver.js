'use strict';

const { Driver } = require('homey');
const PolestarC3Compat = require('../../clone_modules/polestar-c3/compat');
const HomeyCrypt = require('../../lib/homeycrypt');
const {
    TOKEN_STORE_KEY,
    clearLegacySettings,
    hasLegacySettings,
    normalizeToken,
    persistToken,
    readToken,
} = require('../../lib/polestarAuthStore');

class Vehicle extends Driver {
    async onInit() {
        this.homey.app.log('Polestar Driver has been initialized', 'Polestar Driver', 'DEBUG');
        await this._clearLegacyCredentialsIfMigrated();
        this._registerFlowCards();
    }

    _registerFlowCards() {
        const actionRun = (method) => async (args) => {
            if (!args.device) throw new Error('No device supplied to flow card');
            await args.device[method](args);
            return true;
        };

        this.homey.flow.getActionCard('charge_start').registerRunListener(actionRun('chargeStart'));
        this.homey.flow.getActionCard('charge_stop').registerRunListener(actionRun('chargeStop'));
        this.homey.flow.getActionCard('set_target_soc').registerRunListener(actionRun('setTargetSoc'));
        this.homey.flow.getActionCard('set_amp_limit').registerRunListener(actionRun('setAmpLimit'));

        this.homey.flow.getActionCard('lock_car').registerRunListener(actionRun('lockCar'));
        this.homey.flow.getActionCard('unlock_car').registerRunListener(actionRun('unlockCar'));
        this.homey.flow.getActionCard('unlock_trunk_action').registerRunListener(actionRun('unlockTrunkAction'));
        this.homey.flow.getActionCard('honk_flash').registerRunListener(actionRun('honkFlashAction'));
        this.homey.flow.getActionCard('climate_start').registerRunListener(actionRun('climateStartAction'));
        this.homey.flow.getActionCard('climate_start_simple').registerRunListener(actionRun('climateStartSimpleAction'));
        this.homey.flow.getActionCard('climate_stop').registerRunListener(actionRun('climateStopAction'));
        this.homey.flow.getActionCard('windows_open').registerRunListener(actionRun('windowsOpenAction'));
        this.homey.flow.getActionCard('windows_close').registerRunListener(actionRun('windowsCloseAction'));
        this.homey.flow.getActionCard('get_location').registerRunListener(async (args) => {
            if (!args.device) throw new Error('No device supplied to flow card');
            return args.device.getLocationForFlow();
        });

        this.homey.flow.getConditionCard('target_soc_is').registerRunListener(async (args) => {
            if (!args.device) return false;
            const current = await args.device.getCurrentTargetSoc();
            return Number.isFinite(current) ? current >= args.level : false;
        });
        this.homey.flow.getConditionCard('amp_limit_is').registerRunListener(async (args) => {
            if (!args.device) return false;
            const current = await args.device.getCurrentAmpLimit();
            return Number.isFinite(current) ? current >= args.amperage : false;
        });
        this.homey.flow.getConditionCard('is_locked').registerRunListener(async (args) => {
            return args.device ? args.device.isLocked() : false;
        });

        // Contact-sensor cards: one trigger card per direction (opened/closed)
        // with a dropdown selecting which alarm_contact sub-capability. The
        // device fires the trigger with state.sensor = full sub-cap id; the
        // run-listener gates by matching the user's selected dropdown value.
        this._contactOpenedTrigger = this.homey.flow.getDeviceTriggerCard('contact_opened');
        this._contactOpenedTrigger.registerRunListener(async (args, state) => args.sensor === state.sensor);
        this._contactClosedTrigger = this.homey.flow.getDeviceTriggerCard('contact_closed');
        this._contactClosedTrigger.registerRunListener(async (args, state) => args.sensor === state.sensor);
        this.homey.flow.getConditionCard('contact_is_open').registerRunListener(async (args) => {
            if (!args.device || !args.sensor) return false;
            return args.device.getCapabilityValue(args.sensor) === true;
        });

        // At-home cards: no args; the device fires them from _evaluateAtHome
        // whenever the measure_polestarAtHome boolean transitions. Condition
        // reads the current capability value — invertable by the user in the
        // flow editor via the !{{is|is not}} tokens in the title.
        this._carCameHomeTrigger = this.homey.flow.getDeviceTriggerCard('car_came_home');
        this._carLeftHomeTrigger = this.homey.flow.getDeviceTriggerCard('car_left_home');
        this.homey.flow.getConditionCard('car_is_at_home').registerRunListener(async (args) => {
            return args.device ? args.device.getCapabilityValue('measure_polestarAtHome') === true : false;
        });

        // OTA / tyre-pressure / climate transition triggers. Fired by
        // _setBoolAndTrigger() in device.js from the respective update
        // functions when the boolean value flips.
        this._otaAvailableTrigger = this.homey.flow.getDeviceTriggerCard('ota_update_available');
        this._otaInstalledTrigger = this.homey.flow.getDeviceTriggerCard('ota_update_installed');
        this._tyreWarningRaisedTrigger  = this.homey.flow.getDeviceTriggerCard('tyre_pressure_warning_raised');
        this._tyreWarningClearedTrigger = this.homey.flow.getDeviceTriggerCard('tyre_pressure_warning_cleared');
        this._climateStartedTrigger = this.homey.flow.getDeviceTriggerCard('climate_started');
        this._climateStoppedTrigger = this.homey.flow.getDeviceTriggerCard('climate_stopped');

        // Conditions for the other custom booleans. Each just reads the current
        // capability value; the !{{is|is not}} tokens in the title let the user
        // invert the check in the flow editor.
        const boolCondition = (capId) => async (args) =>
            args.device ? args.device.getCapabilityValue(capId) === true : false;
        this.homey.flow.getConditionCard('is_charging').registerRunListener(boolCondition('measure_vehicleChargeState'));
        this.homey.flow.getConditionCard('is_connected_to_charger').registerRunListener(boolCondition('measure_vehicleConnected'));
        this.homey.flow.getConditionCard('ota_is_available').registerRunListener(boolCondition('alarm_polestarOtaAvailable'));
        this.homey.flow.getConditionCard('tyre_pressure_warning_active').registerRunListener(boolCondition('alarm_polestarTyrePressure'));
        this.homey.flow.getConditionCard('climate_is_running').registerRunListener(boolCondition('onoff.climate'));

        this.homey.app.log('Polestar flow cards registered', 'Polestar Driver', 'DEBUG');
    }

    _createPolestarClient(username = null, password = null) {
        return new PolestarC3Compat(username, password);
    }

    async _authenticate(username, password) {
        if (typeof username !== 'string' || username.trim() === ''
            || typeof password !== 'string' || password === '') {
            throw new Error('Email and password are required');
        }

        const client = this._createPolestarClient(username.trim(), password);
        try {
            await client.login();
            const token = normalizeToken(client.getToken());
            if (!token) {
                throw new Error('Polestar did not return a reusable refresh token');
            }
            return { client, token };
        } catch (err) {
            if (typeof client.close === 'function') client.close();
            throw err;
        }
    }

    _mapVehicle(bev, token) {
        const modelName = bev && bev.content && bev.content.model && bev.content.model.name
            ? bev.content.model.name
            : 'Polestar';
        const registration = bev.registrationNo || null;
        const linked = bev.userIsLinked === true ? 'yes' : (bev.userIsLinked === false ? 'no' : '?');
        const owner = bev.userIsOwner === true ? 'yes' : (bev.userIsOwner === false ? 'no' : '?');
        this.homey.app.log(`Located ${modelName} — linked:${linked} owner:${owner}`, 'Polestar Driver', 'DEBUG');

        return {
            id: bev.vin,
            name: registration ? `${modelName} (${registration})` : modelName,
            data: {
                vin: bev.vin,
                registration,
                internalVehicleIdentifier: bev.internalVehicleIdentifier,
                modelName,
                modelYear: bev.modelYear,
                carImage: bev.content && bev.content.images && bev.content.images.studio
                    ? bev.content.images.studio.url
                    : null,
                deliveryDate: bev.deliveryDate,
                hasPerformancePackage: bev.hasPerformancePackage,
            },
            store: {
                [TOKEN_STORE_KEY]: token,
            },
        };
    }

    async onRepair(session, device) {
        session.setHandler('login', async ({ username, password }) => {
            let client;
            try {
                const authenticated = await this._authenticate(username, password);
                client = authenticated.client;

                const vehicles = await client.getVehicles();
                const storedVin = device.getData().vin;
                if (!Array.isArray(vehicles) || !vehicles.some((vehicle) => vehicle.vin === storedVin)) {
                    throw new Error('This vehicle is not linked to that Polestar account');
                }

                await device.replacePolestarClient(client);
                client = null;
                await this._clearLegacyCredentialsIfMigrated();
                this.homey.app.log('Polestar authentication repaired', 'Polestar Driver', 'DEBUG');
                return true;
            } catch (err) {
                if (client && typeof client.close === 'function') client.close();
                this.homey.app.log('Polestar repair authentication failed', 'Polestar Driver', 'ERROR');
                throw new Error(err && err.message === 'This vehicle is not linked to that Polestar account'
                    ? err.message
                    : 'Authentication failed. Check your Polestar ID and password.');
            }
        });
    }

    async onPair(session) {
        let pairedClient = null;
        let pairedToken = null;
        const closePairedClient = () => {
            if (pairedClient && typeof pairedClient.close === 'function') pairedClient.close();
            pairedClient = null;
            pairedToken = null;
        };

        session.setHandler('login', async ({ username, password }) => {
            closePairedClient();

            try {
                const authenticated = await this._authenticate(username, password);
                pairedClient = authenticated.client;
                pairedToken = authenticated.token;
                pairedClient.onTokenChanged(async (token) => {
                    const normalized = normalizeToken(token);
                    if (!normalized) throw new Error('Polestar returned an invalid token');
                    pairedToken = normalized;
                });
                this.homey.app.log('Polestar pairing authentication succeeded', 'Polestar Driver', 'DEBUG');
                return true;
            } catch (_) {
                closePairedClient();
                this.homey.app.log('Polestar pairing authentication failed', 'Polestar Driver', 'ERROR');
                throw new Error('Authentication failed. Check your Polestar ID and password.');
            }
        });

        session.setHandler('list_devices', async () => {
            if (!pairedClient || !pairedToken) {
                throw new Error('Not authenticated. Please log in first.');
            }

            const vehicles = await pairedClient.getVehicles();
            pairedToken = normalizeToken(pairedClient.getToken());
            if (!pairedToken) throw new Error('Polestar returned an invalid token');
            this.homey.app.log('Polestar vehicles discovered', 'Polestar Driver', 'DEBUG', {
                count: Array.isArray(vehicles) ? vehicles.length : 0,
            });
            return Array.isArray(vehicles)
                ? vehicles.map((vehicle) => this._mapVehicle(vehicle, pairedToken))
                : [];
        });

        session.setHandler('add_devices', async (devices) => {
            try {
                this.homey.app.log(
                    Array.isArray(devices) && devices.length > 0
                        ? `${devices.length} Polestar vehicle(s) added`
                        : 'No Polestar vehicle added',
                    'Polestar Driver',
                    Array.isArray(devices) && devices.length > 0 ? 'DEBUG' : 'WARNING',
                );
                await this._clearLegacyCredentialsIfMigrated();
            } finally {
                closePairedClient();
            }
        });

        session.setHandler('disconnect', async () => {
            closePairedClient();
        });
    }

    async getTokenForDevice(device) {
        const stored = readToken(device);
        if (stored) {
            await this._clearLegacyCredentialsIfMigrated();
            return stored;
        }

        if (!this._legacyMigrationPromise) {
            this._legacyMigrationPromise = this._migrateLegacyCredentials()
                .finally(() => {
                    this._legacyMigrationPromise = null;
                });
        }

        await this._legacyMigrationPromise;
        const migrated = readToken(device);
        if (!migrated) {
            throw new Error('Polestar authentication is missing. Repair the device to sign in again.');
        }
        return migrated;
    }

    async _migrateLegacyCredentials() {
        let username;
        let encryptedPassword;
        let password;
        let client;
        let passwordDecrypted = false;
        try {
            username = this.homey.settings.get('user_email');
            encryptedPassword = this.homey.settings.get('user_password');
            if (typeof username !== 'string' || username === '' || !encryptedPassword) {
                throw new Error('Saved Polestar authentication is incomplete');
            }

            password = await HomeyCrypt.decrypt(encryptedPassword, username);
            passwordDecrypted = true;
            const authenticated = await this._authenticate(username, password);
            client = authenticated.client;

            const devices = this.getDevices();
            for (const device of devices) {
                if (!readToken(device)) {
                    await persistToken(device, authenticated.token);
                }
            }

            await this._clearLegacyCredentialsIfMigrated();
            this.homey.app.log('Migrated saved Polestar login to refreshable tokens', 'Polestar Driver', 'DEBUG');
        } catch (err) {
            const repairRequired = !passwordDecrypted
                || /Invalid username or password|(?:Auth failed with status|Token exchange failed:) (400|401|403)|reusable refresh token/i.test(err && err.message);
            if (repairRequired) {
                try {
                    await clearLegacySettings(this.homey.settings);
                } catch (_) {
                    this.homey.app.log('Could not remove rejected Polestar login settings', 'Polestar Driver', 'WARNING');
                }
            }
            this.homey.app.log(
                repairRequired
                    ? 'Could not migrate the saved Polestar login; repair is required'
                    : 'Could not migrate the saved Polestar login temporarily; will retry later',
                'Polestar Driver',
                repairRequired ? 'ERROR' : 'WARNING',
            );
            throw new Error(repairRequired
                ? 'Could not migrate Polestar authentication. Repair the device to sign in again.'
                : 'Could not migrate Polestar authentication temporarily.');
        } finally {
            password = null;
            if (client && typeof client.close === 'function') client.close();
        }
    }

    async _clearLegacyCredentialsIfMigrated() {
        const devices = this.getDevices();
        if (!devices.every((device) => readToken(device))
            || !hasLegacySettings(this.homey.settings)) return false;
        try {
            await clearLegacySettings(this.homey.settings);
            return true;
        } catch (_) {
            this.homey.app.log('Could not remove obsolete Polestar login settings; will retry later', 'Polestar Driver', 'WARNING');
            return false;
        }
    }

}

module.exports = Vehicle;
