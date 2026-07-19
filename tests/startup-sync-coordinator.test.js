'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    crearCoordinadorSincronizacionInicial
} = require('../src/startup-sync-coordinator');

test('procesa como maximo diez lineas simultaneas y luego avanza', async () => {
    let activas = 0;
    let maximoActivas = 0;
    const liberar = [];
    const coordinador = crearCoordinadorSincronizacionInicial({
        tamanoLote: 10,
        procesarLinea: linea => new Promise(resolve => {
            activas += 1;
            maximoActivas = Math.max(maximoActivas, activas);
            liberar.push(() => {
                activas -= 1;
                resolve({ lista: true, estado: `lista-${linea.id}` });
            });
        })
    });
    const lineas = Array.from({ length: 21 }, (_, indice) => ({
        id: String(indice + 1),
        nombre: `L${indice + 1}`
    }));

    const ejecucion = coordinador.ejecutar(lineas);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(liberar.length, 10);
    liberar.splice(0, 10).forEach(resolver => resolver());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(liberar.length, 10);
    liberar.splice(0, 10).forEach(resolver => resolver());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(liberar.length, 1);
    liberar.shift()();

    const resultado = await ejecucion;
    assert.equal(maximoActivas, 10);
    assert.equal(resultado.porcentaje, 100);
    assert.equal(resultado.procesadas, 21);
    assert.equal(resultado.listas, 21);
    assert.equal(resultado.activa, false);
});

test('un fallo de una linea no interrumpe las demas', async () => {
    const coordinador = crearCoordinadorSincronizacionInicial({
        tamanoLote: 2,
        procesarLinea: async linea => {
            if (linea.id === '2') throw new Error('fallo aislado');
            return { lista: true };
        }
    });

    const resultado = await coordinador.ejecutar([
        { id: '1', nombre: 'L1' },
        { id: '2', nombre: 'L2' },
        { id: '3', nombre: 'L3' }
    ]);

    assert.equal(resultado.listas, 2);
    assert.equal(resultado.omitidas, 1);
    assert.equal(resultado.completada, true);
});
