'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    crearAlmacenJsonSeguro
} = require('../src/crash-safe-json-store');
const {
    ESTADO_INTERRUPCION_REINICIO,
    crearCheckpointPublicacion,
    crearSnapshotPublicacionActiva,
    marcarLineaEnCurso,
    actualizarFaseLineaEnCurso,
    reconciliarHistorialInterrumpido,
    obtenerIdsPendientesSeguros,
    obtenerIdsEnvioIncierto
} = require('../src/publication-history-checkpoint');

const FECHA_INICIO = '2026-07-28T18:00:00.000Z';
const FECHA_REINICIO = '2026-07-28T18:05:00.000Z';
const FUENTE_BOT = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'bot.js'),
    'utf8'
);
const SNAPSHOT_PREDETERMINADO = Object.freeze({
    version: 1,
    publicacionId: '__sin_publicacion__',
    fechaInicio: null,
    actualizadoEn: null,
    checkpointPublicacion: null,
    lineasCorrectas: [],
    lineasFallidas: []
});

function crearCarpetaTemporal(t) {
    const carpeta = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-recuperacion-integracion-')
    );
    t.after(() => fs.rmSync(carpeta, { recursive: true, force: true }));
    return carpeta;
}

function crearAlmacenLista(ruta) {
    return crearAlmacenJsonSeguro({
        ruta,
        validar: Array.isArray
    });
}

function crearAlmacenSnapshot(ruta) {
    return crearAlmacenJsonSeguro({
        ruta,
        validar: datos => Boolean(
            datos &&
            typeof datos === 'object' &&
            !Array.isArray(datos) &&
            datos.version === 1 &&
            typeof datos.publicacionId === 'string' &&
            datos.publicacionId
        )
    });
}

function crearRegistro1512(idsLineas = ['linea-1', 'linea-2']) {
    return {
        id: 'publicacion-1',
        fechaInicio: FECHA_INICIO,
        fechaFin: null,
        origen: 'manual',
        texto: 'Estado compatible con 1.5.12',
        idsLineas,
        modoRitmo: 'secuencial',
        intervaloSegundos: 45,
        variacionSegundos: 5,
        lineasPorGrupo: 1,
        intervaloMinutos: 5,
        maximoDestinatariosPorEstado: 1000,
        rutaImagen: 'C:\\datos\\historial\\estado.jpg',
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

function crearGrupoActivo1512(lineaId, estadoId) {
    return {
        id: 'publicacion-1',
        fechaInicio: FECHA_INICIO,
        expiraEn: '2026-07-29T18:00:00.000Z',
        texto: 'Estado compatible con 1.5.12',
        lineas: [{
            lineaId,
            nombre: `Línea ${lineaId}`,
            numero: '595981000000',
            clave: {
                remoteJid: 'status@broadcast',
                fromMe: true,
                id: estadoId
            },
            meta: {
                id: estadoId,
                statusJidList: ['595981111111@s.whatsapp.net']
            },
            publicadoEn: FECHA_INICIO,
            expiraEn: '2026-07-29T18:00:00.000Z',
            visualizadores: [],
            estado: 'activo',
            error: null,
            eliminadoEn: null,
            claveRevocacion: null,
            revocacionConAudiencia: false
        }]
    };
}

function extraerFuncion(firma, firmaSiguiente) {
    const inicio = FUENTE_BOT.indexOf(firma);
    const fin = FUENTE_BOT.indexOf(firmaSiguiente, inicio + firma.length);
    assert.ok(inicio >= 0, `No se encontró ${firma}`);
    assert.ok(fin > inicio, `No se encontró el final de ${firma}`);
    return FUENTE_BOT.slice(inicio, fin);
}

test('el bot persiste fase envío antes de invocar sendMessage', () => {
    const ejecutar = extraerFuncion(
        'async function ejecutarPublicacion',
        'function obtenerLineasReparandoPrivacidad'
    );
    const marcaCheckpoint = ejecutar.indexOf(
        'marcarCheckpointEnvioEnCurso(registroHistorial)'
    );
    const marcaMemoria = ejecutar.indexOf(
        'progresoPublicacion.envioEnCurso = true'
    );
    const envio = ejecutar.indexOf('socketUsado.sendMessage(');

    assert.ok(marcaCheckpoint >= 0);
    assert.ok(marcaMemoria > marcaCheckpoint);
    assert.ok(envio > marcaMemoria);
});

test('el arranque recupera sin encolar ni reenviar campañas', () => {
    const recuperacion = extraerFuncion(
        'function reconciliarPublicacionesInterrumpidas',
        'function guardarEstadosActivos'
    );
    assert.match(recuperacion, /reconciliarHistorialInterrumpido/);
    assert.doesNotMatch(recuperacion, /encolarPublicacion|sendMessage/);

    const cargaActivos = FUENTE_BOT.lastIndexOf(
        '        cargarEstadosActivos();'
    );
    const cargaHistorial = FUENTE_BOT.lastIndexOf(
        '        cargarHistorial();'
    );
    const cargaLineas = FUENTE_BOT.lastIndexOf(
        '        cargarLineasGuardadas();'
    );
    const reconciliacion = FUENTE_BOT.lastIndexOf(
        '            reconciliarPublicacionesInterrumpidas();'
    );

    assert.ok(cargaActivos >= 0);
    assert.ok(cargaHistorial > cargaActivos);
    assert.ok(cargaLineas > cargaHistorial);
    assert.ok(reconciliacion > cargaLineas);
});

test('el journal se retira solo después de guardar el historial final', () => {
    const finalizar = extraerFuncion(
        'function finalizarRegistroHistorial',
        'function marcarReintentoHistorial'
    );
    const guardado = finalizar.indexOf('guardarHistorial();');
    const limpieza = finalizar.indexOf(
        'limpiarCheckpointPublicacion(registro.id);'
    );

    assert.ok(guardado >= 0);
    assert.ok(limpieza > guardado);
});

test('los arrays de 1.5.12 se recuperan desde .bak sin cambiar su forma', t => {
    const carpeta = crearCarpetaTemporal(t);
    const rutaHistorial = path.join(carpeta, 'publicaciones.json');
    const almacen = crearAlmacenLista(rutaHistorial);
    const historial1512 = [crearRegistro1512()];

    fs.writeFileSync(rutaHistorial, Buffer.alloc(4096, 0));
    fs.writeFileSync(
        almacen.rutas.respaldo,
        JSON.stringify(historial1512),
        'utf8'
    );

    const resultado = almacen.cargar([]);

    assert.equal(resultado.fuente, 'respaldo');
    assert.equal(resultado.recuperado, true);
    assert.deepEqual(resultado.datos, historial1512);
    assert.ok(Array.isArray(JSON.parse(fs.readFileSync(rutaHistorial, 'utf8'))));
    assert.equal(resultado.datos[0].checkpointPublicacion, undefined);
});

test('un .tmp válido recupera estados-activos 1.5.12 y sus IDs de WhatsApp', t => {
    const carpeta = crearCarpetaTemporal(t);
    const rutaActivos = path.join(carpeta, 'estados-activos.json');
    const almacen = crearAlmacenLista(rutaActivos);
    const grupos = [
        crearGrupoActivo1512('linea-1', 'ID-ESTADO-CONFIRMADO')
    ];

    fs.writeFileSync(rutaActivos, '{"grupo":', 'utf8');
    fs.writeFileSync(
        almacen.rutas.temporal,
        JSON.stringify(grupos),
        'utf8'
    );

    const resultado = almacen.cargar([]);

    assert.equal(resultado.fuente, 'temporal');
    assert.equal(resultado.recuperado, true);
    assert.deepEqual(
        resultado.datos[0].lineas[0].clave,
        {
            remoteJid: 'status@broadcast',
            fromMe: true,
            id: 'ID-ESTADO-CONFIRMADO'
        }
    );
});

test('reinicio en preparación deja pendientes seguros, pero no reanuda solo', t => {
    const carpeta = crearCarpetaTemporal(t);
    const almacenHistorial = crearAlmacenLista(
        path.join(carpeta, 'publicaciones.json')
    );
    const almacenJournal = crearAlmacenSnapshot(
        path.join(carpeta, 'publicacion-activa.json')
    );
    const historialPersistido = [crearRegistro1512()];
    let registroEnMemoria = crearCheckpointPublicacion(
        historialPersistido[0],
        FECHA_INICIO
    );
    registroEnMemoria = marcarLineaEnCurso(
        registroEnMemoria,
        {
            id: 'linea-1',
            nombre: 'Línea 1',
            numero: '595981000001'
        },
        '2026-07-28T18:01:00.000Z',
        'preparacion'
    );

    almacenHistorial.guardar(historialPersistido);
    almacenJournal.guardar(
        crearSnapshotPublicacionActiva(registroEnMemoria)
    );

    const historialReabierto = almacenHistorial.cargar([]).datos;
    const journalReabierto = almacenJournal.cargar(
        SNAPSHOT_PREDETERMINADO
    ).datos;
    const resultado = reconciliarHistorialInterrumpido(
        historialReabierto,
        [],
        FECHA_REINICIO,
        journalReabierto
    );
    const recuperado = resultado.historial[0];

    assert.equal(recuperado.estado, ESTADO_INTERRUPCION_REINICIO);
    assert.equal(recuperado.recuperacionReinicio.reanudacionAutomatica, false);
    assert.deepEqual(
        obtenerIdsPendientesSeguros(recuperado),
        ['linea-1', 'linea-2']
    );
    assert.deepEqual(obtenerIdsEnvioIncierto(recuperado), []);
});

test('reinicio durante envío nunca incluye esa línea en el reintento seguro', t => {
    const registro1512 = crearRegistro1512();
    let registroEnMemoria = crearCheckpointPublicacion(
        registro1512,
        FECHA_INICIO
    );
    registroEnMemoria = marcarLineaEnCurso(
        registroEnMemoria,
        {
            id: 'linea-1',
            nombre: 'Línea 1',
            numero: '595981000001'
        },
        '2026-07-28T18:01:00.000Z'
    );
    registroEnMemoria = actualizarFaseLineaEnCurso(
        registroEnMemoria,
        'envio',
        '2026-07-28T18:01:01.000Z'
    );

    const resultado = reconciliarHistorialInterrumpido(
        [registro1512],
        [],
        FECHA_REINICIO,
        crearSnapshotPublicacionActiva(registroEnMemoria)
    );
    const recuperado = resultado.historial[0];

    assert.equal(recuperado.recuperacionReinicio.reanudacionAutomatica, false);
    assert.deepEqual(obtenerIdsEnvioIncierto(recuperado), ['linea-1']);
    assert.deepEqual(obtenerIdsPendientesSeguros(recuperado), ['linea-2']);
    assert.equal(
        recuperado.lineasFallidas.find(
            linea => linea.id === 'linea-1'
        ).reintentoSeguro,
        false
    );
});

test('el respaldo espejado conserva fase envío y nunca habilita duplicado', t => {
    const carpeta = crearCarpetaTemporal(t);
    const almacenJournal = crearAlmacenSnapshot(
        path.join(carpeta, 'publicacion-activa.json')
    );
    const registro1512 = crearRegistro1512(['linea-1']);
    let registro = crearCheckpointPublicacion(
        registro1512,
        FECHA_INICIO
    );
    registro = marcarLineaEnCurso(
        registro,
        {
            id: 'linea-1',
            nombre: 'Línea 1',
            numero: '595981000001'
        },
        '2026-07-28T18:01:00.000Z',
        'preparacion'
    );
    almacenJournal.guardarEspejado(
        crearSnapshotPublicacionActiva(registro)
    );

    registro = actualizarFaseLineaEnCurso(
        registro,
        'envio',
        '2026-07-28T18:01:01.000Z'
    );
    almacenJournal.guardarEspejado(
        crearSnapshotPublicacionActiva(registro)
    );
    fs.writeFileSync(
        almacenJournal.rutas.principal,
        Buffer.alloc(2048, 0)
    );

    const snapshotRecuperado = almacenJournal.cargar(
        SNAPSHOT_PREDETERMINADO
    );
    const resultado = reconciliarHistorialInterrumpido(
        [registro1512],
        [],
        FECHA_REINICIO,
        snapshotRecuperado.datos
    );
    const recuperado = resultado.historial[0];

    assert.equal(snapshotRecuperado.fuente, 'respaldo');
    assert.equal(
        snapshotRecuperado.datos.checkpointPublicacion.lineaEnCurso.fase,
        'envio'
    );
    assert.deepEqual(obtenerIdsPendientesSeguros(recuperado), []);
    assert.deepEqual(obtenerIdsEnvioIncierto(recuperado), ['linea-1']);
});

test('un ID en estados activos confirma el envío tras reiniciar y evita duplicarlo', t => {
    const registro1512 = crearRegistro1512();
    let registroEnMemoria = crearCheckpointPublicacion(
        registro1512,
        FECHA_INICIO
    );
    registroEnMemoria = marcarLineaEnCurso(
        registroEnMemoria,
        {
            id: 'linea-1',
            nombre: 'Línea 1',
            numero: '595981000001'
        },
        '2026-07-28T18:01:00.000Z'
    );
    registroEnMemoria = actualizarFaseLineaEnCurso(
        registroEnMemoria,
        'envio',
        '2026-07-28T18:01:01.000Z'
    );

    const resultado = reconciliarHistorialInterrumpido(
        [registro1512],
        [crearGrupoActivo1512('linea-1', 'ID-RECUPERADO')],
        FECHA_REINICIO,
        crearSnapshotPublicacionActiva(registroEnMemoria)
    );
    const recuperado = resultado.historial[0];

    assert.deepEqual(obtenerIdsEnvioIncierto(recuperado), []);
    assert.deepEqual(obtenerIdsPendientesSeguros(recuperado), ['linea-2']);
    assert.equal(recuperado.lineasCorrectas.length, 1);
    assert.equal(recuperado.lineasCorrectas[0].id, 'linea-1');
    assert.equal(
        recuperado.lineasCorrectas[0].estadoId,
        'ID-RECUPERADO'
    );
    assert.equal(
        recuperado.lineasCorrectas[0].recuperadaDesdeEstadosActivos,
        true
    );
});

test('una campaña 1.5.12 sin journal se conserva de forma conservadora', () => {
    const registro1512 = crearRegistro1512();
    const resultado = reconciliarHistorialInterrumpido(
        [registro1512],
        [],
        FECHA_REINICIO
    );
    const recuperado = resultado.historial[0];

    assert.equal(recuperado.estado, ESTADO_INTERRUPCION_REINICIO);
    assert.equal(recuperado.recuperacionReinicio.reanudacionAutomatica, false);
    assert.deepEqual(obtenerIdsPendientesSeguros(recuperado), []);
    assert.deepEqual(
        obtenerIdsEnvioIncierto(recuperado),
        ['linea-1', 'linea-2']
    );
});
