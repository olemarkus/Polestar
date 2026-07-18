'use strict';

module.exports = function logVehicleCount(homey, message, vehicles) {
    const count = Array.isArray(vehicles) ? vehicles.length : 0;
    homey.app.log(`${message}: ${count}`, 'Polestar Driver', 'DEBUG');
};
