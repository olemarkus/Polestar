'use strict';

const axios = require('axios');
const { randomUUID } = require('crypto');

const C3_DISCOVERY_URL = 'https://cnepmob.volvocars.com/';
const C3_ACCEPT_HEADER = 'application/volvo.cloud.cnepmob.v1+json';

// Consumer car list — the same endpoint + query the Polestar website uses. The
// previous app-backend `getVehiclesInformation` query returns an empty list for
// newer cars (e.g. Polestar 3), so we query the consumer API instead.
// getConsumerCarsV2 returns a flat VehicleInformation (no nested content{}), so
// we re-nest modelName into content.model.name for the driver's mapping.
// NB: this type has no `content`/`hasPerformancePackage`/`images` fields — the
// server rejects the whole query (FieldUndefined) if you ask for them, which
// reads downstream as "no vehicles". Keep the field set flat.
const MYSTAR_V2_URL = 'https://pc-api.polestar.com/eu-north-1/mystar-v2/';

const GET_VEHICLES_QUERY = `
query getCars {
    getConsumerCarsV2 {
        vin
        internalVehicleIdentifier
        registrationNo
        modelName
        modelYear
        deliveryDate
        userIsPrimaryDriver
    }
}
`;

async function discoverC3Endpoint(accessToken) {
    const r = await axios.get(C3_DISCOVERY_URL, {
        headers: {
            authorization: `Bearer ${accessToken}`,
            accept: C3_ACCEPT_HEADER,
        },
        timeout: 30000,
        validateStatus: () => true,
    });
    if (r.status !== 200) throw new Error(`C3 discovery failed: ${r.status}`);
    const c3 = r.data.c3 || {};
    if (!c3.grpcHost) throw new Error('C3 discovery response missing grpcHost');
    return {
        host: c3.grpcHost,
        port: Number(c3.grpcPort || 443),
        keepAliveTime: c3.grpcKeepAliveTime || null,
    };
}

async function getVehicles(accessToken) {
    const r = await axios.post(MYSTAR_V2_URL, {
        operationName: 'getCars',
        variables: {},
        query: GET_VEHICLES_QUERY,
    }, {
        headers: {
            authorization: `Bearer ${accessToken}`,
            'x-apollo-request-uuid': randomUUID(),
            accept: 'application/json',
            'content-type': 'application/json',
        },
        timeout: 30000,
        validateStatus: () => true,
    });
    if (r.status !== 200) throw new Error(`Vehicle list failed: ${r.status} ${JSON.stringify(r.data)}`);
    // A GraphQL endpoint returns HTTP 200 even on query errors — surface them
    // instead of silently returning an empty list (which reads as "no cars").
    const errors = (r.data || {}).errors;
    if (errors && errors.length) throw new Error(`Vehicle list error: ${errors.map((e) => e.message).join('; ')}`);
    const cars = ((r.data || {}).data || {}).getConsumerCarsV2 || [];
    // Re-shape the flat VehicleInformation into the nested form the driver
    // expects (bev.content.model.name, bev.registrationNo, …); fields the API
    // no longer returns (images, hasPerformancePackage) stay undefined and the
    // driver falls back to null.
    return cars.map((c) => ({
        vin: c.vin,
        internalVehicleIdentifier: c.internalVehicleIdentifier,
        registrationNo: c.registrationNo,
        modelYear: c.modelYear,
        deliveryDate: c.deliveryDate,
        userIsPrimaryDriver: c.userIsPrimaryDriver,
        content: { model: { name: c.modelName } },
    }));
}

module.exports = { discoverC3Endpoint, getVehicles };
