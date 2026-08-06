'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    crearProveedorVersionVinculacionWhatsApp,
    extraerVersionDesdeServiceWorker
} = require('../src/whatsapp-link-version');

function crearSolicitudSimulada(alTerminar) {
    const solicitudes = [];
    const solicitar = (url, opciones, responder) => {
        const solicitud = new EventEmitter();
        solicitud.destruida = false;
        solicitud.destroy = error => {
            solicitud.destruida = true;
            queueMicrotask(() => solicitud.emit('error', error));
        };
        solicitud.end = () => alTerminar({
            url,
            opciones,
            responder,
            solicitud
        });
        solicitudes.push(solicitud);
        return solicitud;
    };

    return { solicitar, solicitudes };
}

function responderConRevision(responder, revision = 1044539926) {
    const respuesta = new EventEmitter();
    respuesta.statusCode = 200;
    responder(respuesta);
    respuesta.emit('data', `const x = {"client_revision": ${revision}};`);
    respuesta.emit('end');
}

test('extrae una revision valida del service worker', () => {
    assert.deepEqual(
        extraerVersionDesdeServiceWorker('"client_revision": 1044539926'),
        [2, 3000, 1044539926]
    );
    assert.equal(extraerVersionDesdeServiceWorker('sin revision'), null);
});

test('un cierre de transporte se absorbe y no deja una promesa rechazada', async () => {
    const advertencias = [];
    const transporte = crearSolicitudSimulada(({ solicitud }) => {
        queueMicrotask(() => solicitud.emit('error', new TypeError('terminated')));
    });
    const proveedor = crearProveedorVersionVinculacionWhatsApp({
        solicitar: transporte.solicitar,
        alFallar: error => advertencias.push(error?.message),
        timeoutMs: 100
    });

    const resultado = await proveedor.actualizarEnSegundoPlano();

    assert.equal(resultado, null);
    assert.equal(proveedor.obtenerVersionEnCache(), null);
    assert.equal(transporte.solicitudes.length, 1);
    assert.match(advertencias[0], /terminated/u);
});

test('coalesce la consulta, guarda cache y no vuelve a abrir una conexion', async () => {
    const transporte = crearSolicitudSimulada(({ responder }) => {
        setImmediate(() => responderConRevision(responder));
    });
    const proveedor = crearProveedorVersionVinculacionWhatsApp({
        solicitar: transporte.solicitar,
        timeoutMs: 100
    });

    const primera = proveedor.actualizarEnSegundoPlano();
    const segunda = proveedor.actualizarEnSegundoPlano();
    assert.strictEqual(primera, segunda);

    assert.deepEqual(await primera, [2, 3000, 1044539926]);
    assert.deepEqual(
        proveedor.obtenerVersionEnCache(),
        [2, 3000, 1044539926]
    );
    assert.deepEqual(
        await proveedor.actualizarEnSegundoPlano(),
        [2, 3000, 1044539926]
    );
    assert.equal(transporte.solicitudes.length, 1);
});

test('el timeout se resuelve antes de cerrar la solicitud y queda reintentable', async () => {
    const advertencias = [];
    const transporte = crearSolicitudSimulada(() => {});
    const proveedor = crearProveedorVersionVinculacionWhatsApp({
        solicitar: transporte.solicitar,
        timeoutMs: 50,
        enfriamientoFalloMs: 0,
        alFallar: error => advertencias.push(error?.message)
    });

    assert.equal(await proveedor.actualizarEnSegundoPlano(), null);
    assert.equal(transporte.solicitudes[0].destruida, true);
    assert.match(advertencias[0], /supero el tiempo/u);
});

test('el QR no vuelve a depender de fetchLatestWaWebVersion ni espera la red', () => {
    const fuenteBot = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'bot.js'),
        'utf8'
    );

    assert.doesNotMatch(fuenteBot, /fetchLatestWaWebVersion/u);
    assert.doesNotMatch(fuenteBot, /await obtenerVersionVinculacionWhatsApp/u);
    assert.match(fuenteBot, /obtenerVersionEnCache\(\)/u);
    assert.match(
        fuenteBot,
        /actualizarEnSegundoPlano\(\{\s*forzar:/u
    );
});
