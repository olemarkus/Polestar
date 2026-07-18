'use strict';

module.exports = function formatVehicleName(modelName, registrationNo, vin) {
    const registration = typeof registrationNo === 'string' ? registrationNo.trim() : '';
    const maskedIdentifier = registration || String(vin || '').slice(-6);
    return maskedIdentifier ? `${modelName} (${maskedIdentifier})` : modelName;
};
