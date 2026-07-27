'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    ID_PUBLICACION_SIMULADA,
    TOTAL_LINEAS_SIMULADAS,
    TOTAL_VISUALIZACIONES_SIMULADAS,
    crearEstadosActivosSimulados,
    crearLineasSimuladas,
    distribuirVisualizaciones,
    esLineaSimulada
} = require('../src/ui-fixtures');

test('la vista interna crea 20 líneas conectadas sin acciones reales', () => {
    const lineas = crearLineasSimuladas(
        new Date('2026-07-27T12:00:00.000Z')
    );

    assert.equal(lineas.length, TOTAL_LINEAS_SIMULADAS);
    assert.equal(new Set(lineas.map(linea => linea.id)).size, 20);
    assert.equal(lineas.every(linea => linea.estado === 'conectado'), true);
    assert.equal(lineas.every(linea => linea.simulada === true), true);
    assert.equal(lineas.every(linea => linea.listaParaPublicar === false), true);
    assert.equal(lineas.every(linea => esLineaSimulada(linea.id)), true);
});

test('el estado simulado suma exactamente 500 visualizaciones', () => {
    const vista = crearEstadosActivosSimulados(
        new Date('2026-07-27T12:00:00.000Z')
    );
    const [publicacion] = vista.publicaciones;
    const totalLineas = publicacion.lineas.reduce(
        (total, linea) => total + linea.visualizaciones,
        0
    );

    assert.equal(publicacion.id, ID_PUBLICACION_SIMULADA);
    assert.equal(publicacion.lineas.length, TOTAL_LINEAS_SIMULADAS);
    assert.equal(publicacion.visualizaciones, TOTAL_VISUALIZACIONES_SIMULADAS);
    assert.equal(vista.resumen.visualizacionesTotales, 500);
    assert.equal(totalLineas, 500);
    assert.deepEqual(
        publicacion.lineas.map(linea => linea.visualizaciones),
        distribuirVisualizaciones()
    );
    assert.equal(publicacion.simulada, true);
});
