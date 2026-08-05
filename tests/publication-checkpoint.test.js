'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    ESTADO_INTERRUPCION_REINICIO,
    crearAlmacenCheckpoint,
    crearCheckpointPublicacion,
    crearSnapshotPublicacionActiva,
    marcarLineaEnCurso,
    actualizarFaseLineaEnCurso,
    registrarResultadoDefinitivo,
    reconciliarRegistroInterrumpido,
    reconciliarRegistroLegadoSinCheckpoint,
    obtenerIdsPendientesSeguros,
    obtenerIdsEnvioIncierto
} = require('../src/publication-checkpoint');

function registroBase(idsLineas = ['linea-a', 'linea-b', 'linea-c']) {
    return {
        id: 'campana-checkpoint',
        fechaInicio: '2026-08-05T12:00:00.000Z',
        fechaFin: null,
        origen: 'prueba interna',
        texto: 'Estado de prueba',
        idsLineas,
        modoRitmo: 'secuencial',
        intervaloSegundos: 45,
        variacionSegundos: 5,
        lineasPorGrupo: 1,
        intervaloMinutos: 0,
        maximoDestinatariosPorEstado: 1000,
        rutaImagen: 'C:\\pruebas\\estado.jpg',
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

function grupoActivo(lineaId, estadoId) {
    return {
        id: 'campana-checkpoint',
        lineas: [{
            lineaId,
            nombre: `Línea ${lineaId}`,
            numero: '595981000000',
            clave: {
                remoteJid: 'status@broadcast',
                fromMe: true,
                id: estadoId
            }
        }]
    };
}

test('un reinicio durante preparación deja solo pendientes seguros', () => {
    let registro = crearCheckpointPublicacion(registroBase());
    registro = marcarLineaEnCurso(registro, {
        id: 'linea-a',
        nombre: 'Línea A'
    });

    const resultado = reconciliarRegistroInterrumpido(
        registro,
        new Map([['campana-checkpoint', grupoActivo('linea-a', 'ESTADO-A')]]),
        '2026-08-05T12:01:00.000Z'
    );

    assert.equal(resultado.registro.estado, ESTADO_INTERRUPCION_REINICIO);
    assert.equal(resultado.registro.lineasCorrectas[0].estadoId, 'ESTADO-A');
    assert.deepEqual(resultado.idsPendientesSeguros, ['linea-b', 'linea-c']);
    assert.deepEqual(resultado.idsEnvioIncierto, []);
    assert.equal(resultado.registro.recuperacionReinicio.reanudacionAutomatica, false);
});

test('un reinicio durante envío conserva incertidumbre y no la reintenta', () => {
    let registro = crearCheckpointPublicacion(registroBase(['linea-a', 'linea-b']));
    registro = marcarLineaEnCurso(registro, {
        id: 'linea-a',
        nombre: 'Línea A'
    });
    registro = actualizarFaseLineaEnCurso(registro, 'envio');

    const resultado = reconciliarRegistroInterrumpido(registro, new Map());

    assert.deepEqual(resultado.idsPendientesSeguros, ['linea-b']);
    assert.deepEqual(resultado.idsEnvioIncierto, ['linea-a']);
    assert.deepEqual(obtenerIdsPendientesSeguros(resultado.registro), ['linea-b']);
    assert.deepEqual(obtenerIdsEnvioIncierto(resultado.registro), ['linea-a']);
    assert.equal(
        resultado.registro.lineasFallidas.find(item => item.id === 'linea-a')
            .reintentoSeguro,
        false
    );
});

test('un fallo confirmado antes del envío queda disponible para reanudar', () => {
    let registro = crearCheckpointPublicacion(registroBase(['linea-a', 'linea-b']));
    registro = marcarLineaEnCurso(registro, {
        id: 'linea-a',
        nombre: 'Línea A'
    });
    registro = registrarResultadoDefinitivo(registro, 'fallida', {
        id: 'linea-a',
        nombre: 'Línea A',
        error: 'La audiencia no respondió.',
        fase: 'audiencia',
        envioConfirmado: false,
        envioIncierto: false,
        reintentoSeguro: true
    });

    const resultado = reconciliarRegistroInterrumpido(registro, new Map());
    assert.deepEqual(resultado.idsPendientesSeguros, ['linea-a', 'linea-b']);
    assert.deepEqual(resultado.idsEnvioIncierto, []);
});

test('un journal con todas las líneas confirmadas se cierra como completado tras un reinicio', () => {
    let registro = crearCheckpointPublicacion(registroBase(['linea-a']));
    registro = marcarLineaEnCurso(registro, {
        id: 'linea-a',
        nombre: 'Línea A'
    });
    registro = actualizarFaseLineaEnCurso(registro, 'envio');
    registro = registrarResultadoDefinitivo(registro, 'correcta', {
        id: 'linea-a',
        nombre: 'Línea A',
        estadoId: 'ESTADO-A'
    });

    const resultado = reconciliarRegistroInterrumpido(registro, new Map());
    assert.equal(resultado.registro.estado, 'completado');
    assert.deepEqual(resultado.idsPendientesSeguros, []);
    assert.deepEqual(resultado.idsEnvioIncierto, []);
});

test('una campaña antigua sin checkpoint se recupera de forma conservadora', () => {
    const resultado = reconciliarRegistroLegadoSinCheckpoint(
        registroBase(['linea-a', 'linea-b']),
        new Map([['campana-checkpoint', grupoActivo('linea-a', 'ESTADO-A')]])
    );

    assert.equal(resultado.registro.estado, ESTADO_INTERRUPCION_REINICIO);
    assert.deepEqual(resultado.idsPendientesSeguros, []);
    assert.deepEqual(resultado.idsEnvioIncierto, ['linea-b']);
    assert.equal(resultado.registro.lineasCorrectas[0].estadoId, 'ESTADO-A');
});

test('el journal recupera el checkpoint más nuevo desde respaldo si el principal se corta', t => {
    const carpeta = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-checkpoint-')
    );
    t.after(() => fs.rmSync(carpeta, { recursive: true, force: true }));

    const almacen = crearAlmacenCheckpoint(
        path.join(carpeta, 'publicacion-activa.json')
    );
    let registro = crearCheckpointPublicacion(registroBase(['linea-a', 'linea-b']));
    const inicial = crearSnapshotPublicacionActiva(registro);
    almacen.guardar(inicial);

    registro = marcarLineaEnCurso(registro, {
        id: 'linea-a',
        nombre: 'Línea A'
    });
    const masNuevo = crearSnapshotPublicacionActiva(registro);
    almacen.guardar(masNuevo);
    fs.writeFileSync(almacen.rutas.principal, '{"registro":', 'utf8');

    const recuperado = almacen.cargar();
    assert.ok(recuperado);
    assert.equal(recuperado.datos.revision, masNuevo.revision);
    assert.equal(
        recuperado.datos.registro.checkpointPublicacion.lineaEnCurso.id,
        'linea-a'
    );
});

test('el envío se marca en checkpoint antes de llamar a WhatsApp y el arranque no reenvía', () => {
    const fuente = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'bot.js'),
        'utf8'
    );
    const inicioPublicacion = fuente.indexOf('async function ejecutarPublicacion');
    const finPublicacion = fuente.indexOf('function obtenerLineasReparandoPrivacidad', inicioPublicacion);
    const publicar = fuente.slice(inicioPublicacion, finPublicacion);
    const marcaEnvio = publicar.indexOf(
        'marcarCheckpointEnvioEnCurso(registroHistorial)'
    );
    const sendMessage = publicar.indexOf("socketUsado.sendMessage(");

    assert.ok(marcaEnvio >= 0);
    assert.ok(sendMessage > marcaEnvio);

    const inicioRecuperacion = fuente.indexOf(
        'function reconciliarPublicacionesInterrumpidas'
    );
    const finRecuperacion = fuente.indexOf('function crearRegistroHistorial', inicioRecuperacion);
    const recuperacion = fuente.slice(inicioRecuperacion, finRecuperacion);
    assert.match(recuperacion, /reconciliarRegistroInterrumpido/);
    assert.doesNotMatch(recuperacion, /encolarPublicacion|sendMessage/);
});
