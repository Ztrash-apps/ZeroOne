'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ESTADO_INTERRUPCION_REINICIO,
    crearCheckpointPublicacion,
    crearSnapshotPublicacionActiva,
    aplicarSnapshotPublicacionActiva,
    marcarLineaEnCurso,
    actualizarFaseLineaEnCurso,
    registrarResultadoDefinitivo,
    reconciliarRegistroInterrumpido,
    reconciliarHistorialInterrumpido,
    obtenerIdsPendientesSeguros,
    obtenerIdsEnvioIncierto
} = require('../src/publication-history-checkpoint');

const FECHA_INICIO = '2026-07-28T20:00:00.000Z';
const FECHA_RESULTADO = '2026-07-28T20:01:00.000Z';
const FECHA_REINICIO = '2026-07-28T20:02:00.000Z';

function registroBase(idsLineas = ['linea-a', 'linea-b', 'linea-c']) {
    return {
        id: 'campana-1',
        fechaInicio: FECHA_INICIO,
        fechaFin: null,
        origen: 'prueba',
        texto: 'Estado',
        idsLineas,
        modoRitmo: 'secuencial',
        intervaloSegundos: 45,
        variacionSegundos: 0,
        lineasPorGrupo: 1,
        intervaloMinutos: 0,
        maximoDestinatariosPorEstado: 1000,
        rutaImagen: 'imagen.jpg',
        mimeImagen: 'image/jpeg',
        estado: 'ejecutando',
        total: idsLineas.length,
        correctas: 0,
        fallidas: 0,
        noProcesadas: 0,
        lineasCorrectas: [],
        lineasFallidas: [],
        error: null
    };
}

function grupoActivo(lineas) {
    return {
        id: 'campana-1',
        fechaInicio: FECHA_INICIO,
        texto: 'Estado',
        lineas: lineas.map(({ id, estadoId }) => ({
            lineaId: id,
            nombre: `Nombre ${id}`,
            numero: `595${id.length}`,
            clave: {
                remoteJid: 'status@broadcast',
                fromMe: true,
                id: estadoId
            },
            meta: {
                id: estadoId
            },
            estado: 'activo'
        }))
    };
}

test('el checkpoint se actualiza tras cada éxito o fallo definitivo', () => {
    const original = registroBase(['linea-a', 'linea-b']);
    const inicial = crearCheckpointPublicacion(original, FECHA_INICIO);

    assert.deepEqual(
        inicial.checkpointPublicacion.idsPendientesSeguros,
        ['linea-a', 'linea-b']
    );
    assert.equal(original.checkpointPublicacion, undefined);

    const enviandoA = marcarLineaEnCurso(
        inicial,
        { id: 'linea-a', nombre: 'Línea A', numero: '5951' },
        '2026-07-28T20:00:10.000Z'
    );
    assert.equal(enviandoA.checkpointPublicacion.lineaEnCurso.id, 'linea-a');
    assert.equal(
        enviandoA.checkpointPublicacion.lineaEnCurso.fase,
        'preparacion'
    );
    assert.deepEqual(
        enviandoA.checkpointPublicacion.idsPendientesSeguros,
        ['linea-b']
    );

    const despuesDeA = registrarResultadoDefinitivo(
        enviandoA,
        'correcta',
        {
            id: 'linea-a',
            nombre: 'Línea A',
            numero: '5951',
            estadoId: 'ID-ESTADO-A',
            destinatarios: 500
        },
        FECHA_RESULTADO
    );
    assert.equal(despuesDeA.correctas, 1);
    assert.equal(despuesDeA.checkpointPublicacion.lineaEnCurso, null);
    assert.equal(despuesDeA.lineasCorrectas[0].envioConfirmado, true);

    const enviandoB = marcarLineaEnCurso(
        despuesDeA,
        { id: 'linea-b', nombre: 'Línea B' },
        '2026-07-28T20:01:10.000Z'
    );
    const despuesDeB = registrarResultadoDefinitivo(
        enviandoB,
        'fallida',
        {
            id: 'linea-b',
            nombre: 'Línea B',
            error: 'Falló antes del envío.',
            fase: 'preparacion',
            envioConfirmado: false,
            envioIncierto: false,
            reintentoSeguro: true
        },
        '2026-07-28T20:01:20.000Z'
    );

    assert.equal(despuesDeB.correctas, 1);
    assert.equal(despuesDeB.fallidas, 1);
    assert.deepEqual(obtenerIdsPendientesSeguros(despuesDeB), ['linea-b']);
    assert.deepEqual(
        despuesDeB.checkpointPublicacion.idsPendientesSeguros,
        []
    );
});

test('un resultado incierto no puede guardarse como fallo definitivo', () => {
    const registro = marcarLineaEnCurso(
        crearCheckpointPublicacion(registroBase(), FECHA_INICIO),
        { id: 'linea-a', nombre: 'Línea A' },
        FECHA_RESULTADO
    );

    assert.throws(
        () => registrarResultadoDefinitivo(
            registro,
            'fallida',
            {
                id: 'linea-a',
                nombre: 'Línea A',
                envioConfirmado: false,
                envioIncierto: true,
                reintentoSeguro: false
            },
            FECHA_REINICIO
        ),
        /no es definitivo/
    );
});

test('el journal pequeño restaura el último checkpoint sin reescribir el historial', () => {
    const historialPersistido = registroBase(['linea-a', 'linea-b']);
    let registroActivo = crearCheckpointPublicacion(
        historialPersistido,
        FECHA_INICIO
    );
    registroActivo = marcarLineaEnCurso(
        registroActivo,
        { id: 'linea-a', nombre: 'Línea A' },
        '2026-07-28T20:00:30.000Z'
    );
    registroActivo = registrarResultadoDefinitivo(
        registroActivo,
        'correcta',
        {
            id: 'linea-a',
            nombre: 'Línea A',
            estadoId: 'ID-JOURNAL-A'
        },
        FECHA_RESULTADO
    );

    const snapshot = crearSnapshotPublicacionActiva(registroActivo);
    const restaurado = aplicarSnapshotPublicacionActiva(
        historialPersistido,
        snapshot
    );

    assert.equal(snapshot.publicacionId, 'campana-1');
    assert.equal(snapshot.lineasCorrectas[0].estadoId, 'ID-JOURNAL-A');
    assert.equal(restaurado.lineasCorrectas[0].estadoId, 'ID-JOURNAL-A');
    assert.deepEqual(
        restaurado.checkpointPublicacion.idsPendientesSeguros,
        ['linea-b']
    );
    assert.equal(historialPersistido.checkpointPublicacion, undefined);
});

test('al reiniciar recupera IDs activos, conserva incertidumbre y separa pendientes seguros', () => {
    let registro = crearCheckpointPublicacion(
        registroBase(['linea-a', 'linea-b', 'linea-c']),
        FECHA_INICIO
    );
    registro = marcarLineaEnCurso(
        registro,
        { id: 'linea-a', nombre: 'Línea A', numero: '5951' },
        '2026-07-28T20:00:20.000Z'
    );

    const resultado = reconciliarRegistroInterrumpido(
        registro,
        [
            grupoActivo([
                { id: 'linea-a', estadoId: 'ID-RECUPERADO-A' }
            ])
        ],
        FECHA_REINICIO
    );
    const recuperado = resultado.registro;

    assert.equal(recuperado.estado, ESTADO_INTERRUPCION_REINICIO);
    assert.equal(recuperado.fechaFin, FECHA_REINICIO);
    assert.equal(
        recuperado.lineasCorrectas[0].estadoId,
        'ID-RECUPERADO-A'
    );
    assert.equal(
        recuperado.lineasCorrectas[0].recuperadaDesdeEstadosActivos,
        true
    );
    assert.deepEqual(resultado.confirmadasDesdeEstadosActivos, ['linea-a']);
    assert.deepEqual(resultado.idsPendientesSeguros, ['linea-b', 'linea-c']);
    assert.deepEqual(resultado.idsEnvioIncierto, []);
    assert.equal(recuperado.recuperacionReinicio.reanudacionAutomatica, false);
    assert.equal(recuperado.noProcesadas, 2);
});

test('una línea en curso sin ID queda incierta y nunca entra al reintento seguro', () => {
    let registro = crearCheckpointPublicacion(
        registroBase(['linea-a', 'linea-b']),
        FECHA_INICIO
    );
    registro = marcarLineaEnCurso(
        registro,
        { id: 'linea-a', nombre: 'Línea A', numero: '5951' },
        FECHA_RESULTADO
    );
    registro = actualizarFaseLineaEnCurso(
        registro,
        'envio',
        '2026-07-28T20:01:10.000Z'
    );

    const resultado = reconciliarRegistroInterrumpido(
        registro,
        [],
        FECHA_REINICIO
    );

    assert.deepEqual(resultado.idsEnvioIncierto, ['linea-a']);
    assert.deepEqual(resultado.idsPendientesSeguros, ['linea-b']);
    assert.equal(
        resultado.registro.lineasFallidas.find(
            linea => linea.id === 'linea-a'
        ).reintentoSeguro,
        false
    );
    assert.equal(
        resultado.registro.lineasFallidas.find(
            linea => linea.id === 'linea-b'
        ).reintentoSeguro,
        true
    );
    assert.deepEqual(
        obtenerIdsPendientesSeguros(resultado.registro),
        ['linea-b']
    );
});

test('un reinicio en preparación mantiene la línea como pendiente segura', () => {
    let registro = crearCheckpointPublicacion(
        registroBase(['linea-a', 'linea-b']),
        FECHA_INICIO
    );
    registro = marcarLineaEnCurso(
        registro,
        { id: 'linea-a', nombre: 'Línea A', numero: '5951' },
        FECHA_RESULTADO
    );

    const resultado = reconciliarRegistroInterrumpido(
        registro,
        [],
        FECHA_REINICIO
    );

    assert.deepEqual(
        resultado.idsPendientesSeguros,
        ['linea-a', 'linea-b']
    );
    assert.deepEqual(resultado.idsEnvioIncierto, []);
    assert.equal(
        resultado.registro.lineasFallidas.find(
            linea => linea.id === 'linea-a'
        ).reintentoSeguro,
        true
    );
});

test('cambiar de preparación a envío vuelve incierta la línea tras reiniciar', () => {
    let registro = crearCheckpointPublicacion(
        registroBase(['linea-a']),
        FECHA_INICIO
    );
    registro = marcarLineaEnCurso(
        registro,
        { id: 'linea-a', nombre: 'Línea A' },
        FECHA_RESULTADO
    );
    registro = actualizarFaseLineaEnCurso(
        registro,
        'envio',
        '2026-07-28T20:01:10.000Z'
    );

    assert.equal(
        registro.checkpointPublicacion.lineaEnCurso.fase,
        'envio'
    );
    const resultado = reconciliarRegistroInterrumpido(
        registro,
        [],
        FECHA_REINICIO
    );

    assert.deepEqual(resultado.idsPendientesSeguros, []);
    assert.deepEqual(resultado.idsEnvioIncierto, ['linea-a']);
});

test('un historial antiguo sin checkpoint trata líneas sin evidencia como inciertas', () => {
    const registro = registroBase(['linea-a', 'linea-b']);
    registro.lineasCorrectas.push({
        id: 'linea-a',
        nombre: 'Línea A',
        estadoId: 'ID-A'
    });

    const resultado = reconciliarRegistroInterrumpido(
        registro,
        [],
        FECHA_REINICIO
    );

    assert.deepEqual(resultado.idsPendientesSeguros, []);
    assert.deepEqual(resultado.idsEnvioIncierto, ['linea-b']);
    assert.equal(resultado.registro.recuperacionReinicio.requiereRevisionManual, true);
});

test('la reconciliación masiva no modifica campañas ya finalizadas', () => {
    const finalizada = {
        ...registroBase(['linea-a']),
        id: 'campana-finalizada',
        estado: 'completado',
        fechaFin: FECHA_RESULTADO
    };
    const ejecutando = crearCheckpointPublicacion(
        registroBase(['linea-a']),
        FECHA_INICIO
    );

    const resultado = reconciliarHistorialInterrumpido(
        [finalizada, ejecutando],
        new Map([
            [
                'campana-1',
                grupoActivo([
                    { id: 'linea-a', estadoId: 'ID-ACTIVO' }
                ])
            ]
        ]),
        FECHA_REINICIO
    );

    assert.equal(resultado.cambiados, 1);
    assert.equal(resultado.historial[0].estado, 'completado');
    assert.equal(
        resultado.historial[1].estado,
        ESTADO_INTERRUPCION_REINICIO
    );
    assert.deepEqual(resultado.resumen[0].idsPendientesSeguros, []);
});

test('un journal sobrante no modifica una campaña ya finalizada', () => {
    const finalizada = {
        ...registroBase(['linea-a']),
        estado: 'completado',
        fechaFin: FECHA_RESULTADO,
        correctas: 1,
        lineasCorrectas: [{
            id: 'linea-a',
            nombre: 'Línea A',
            estadoId: 'ID-FINAL'
        }]
    };
    const snapshot = crearSnapshotPublicacionActiva(
        crearCheckpointPublicacion(
            registroBase(['linea-a']),
            FECHA_INICIO
        )
    );

    const resultado = reconciliarHistorialInterrumpido(
        [finalizada],
        [],
        FECHA_REINICIO,
        snapshot
    );

    assert.equal(resultado.cambiados, 0);
    assert.equal(
        resultado.historial[0].lineasCorrectas[0].estadoId,
        'ID-FINAL'
    );
});

test('la reconciliación masiva aplica el journal antes de clasificar el reinicio', () => {
    const historialPersistido = registroBase(['linea-a', 'linea-b']);
    let registroActivo = crearCheckpointPublicacion(
        historialPersistido,
        FECHA_INICIO
    );
    registroActivo = marcarLineaEnCurso(
        registroActivo,
        { id: 'linea-a', nombre: 'Línea A' },
        '2026-07-28T20:00:30.000Z'
    );
    registroActivo = registrarResultadoDefinitivo(
        registroActivo,
        'correcta',
        {
            id: 'linea-a',
            nombre: 'Línea A',
            estadoId: 'ID-JOURNAL-A'
        },
        FECHA_RESULTADO
    );
    const snapshot = crearSnapshotPublicacionActiva(registroActivo);

    const resultado = reconciliarHistorialInterrumpido(
        [historialPersistido],
        [],
        FECHA_REINICIO,
        snapshot
    );

    assert.equal(resultado.cambiados, 1);
    assert.equal(
        resultado.historial[0].lineasCorrectas[0].estadoId,
        'ID-JOURNAL-A'
    );
    assert.deepEqual(
        resultado.historial[0].recuperacionReinicio.idsPendientesSeguros,
        ['linea-b']
    );
    assert.deepEqual(
        resultado.historial[0].recuperacionReinicio.idsEnvioIncierto,
        []
    );
});
