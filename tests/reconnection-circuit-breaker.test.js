const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const RAIZ_PROYECTO = path.resolve(__dirname, '..');
const INICIO_SIMULADO = new Date('2026-07-19T12:00:00.000Z');

function prepararCarpetas(rutaDatos) {
    for (const carpeta of ['sesiones', 'programados', 'uploads', 'historial']) {
        const ruta = path.join(rutaDatos, carpeta);
        fs.mkdirSync(ruta, { recursive: true });
        fs.writeFileSync(path.join(ruta, '.prueba-interna'), '', 'utf8');
    }
}

function cargarBackendAislado(rutaDatos) {
    prepararCarpetas(rutaDatos);

    const archivo = path.join(RAIZ_PROYECTO, 'src', 'bot.js');
    const original = fs.readFileSync(archivo, 'utf8');
    const corte = original.indexOf('\napp.listen(');
    assert.ok(corte > 0, 'No se encontró el inicio del servidor');

    const variable = 'ZEROONE_DATA_DIR';
    const anterior = process.env[variable];
    process.env[variable] = rutaDatos;

    try {
        const fuente = original.slice(0, corte) + `
            const llamadasConexionPrueba = [];
            iniciarWhatsApp = async lineaId => {
                llamadasConexionPrueba.push({
                    lineaId,
                    timestamp: Date.now()
                });
            };

            module.exports = {
                agregarLineaPrueba: linea => lineas.set(linea.id, linea),
                obtenerLineaPrueba: lineaId => lineas.get(lineaId),
                obtenerDiferidasPrueba: () =>
                    [...reconexionesDiferidasCircuitBreaker.values()]
                        .map(pendiente => ({ ...pendiente })),
                obtenerDiferidasInicioPrueba: () =>
                    [...reconexionesDiferidasSincronizacionInicial.values()]
                        .map(pendiente => ({ ...pendiente })),
                obtenerLlamadasConexionPrueba: () =>
                    llamadasConexionPrueba.map(llamada => ({ ...llamada })),
                marcarLineaListaPrueba(lineaId) {
                    const linea = lineas.get(lineaId);
                    if (!linea) return false;
                    linea.estado = 'conectado';
                    linea.socket = {};
                    linea.iniciando = false;
                    linea.temporizadorReconexion = null;
                    linea.audienciaEstadosCargada = true;
                    linea.audienciaResincronizada = true;
                    linea.privacidadEstados = {
                        modo: 'todos',
                        usuarios: [],
                        usuariosInvalidos: 0
                    };
                    return true;
                },
                activarSincronizacionInicialPrueba(idsAutorizados = []) {
                    sincronizacionInicialEnEjecucion = true;
                    lineasAutorizadasTandaInicial.clear();
                    for (const lineaId of idsAutorizados) {
                        lineasAutorizadasTandaInicial.add(lineaId);
                    }
                },
                programarReconexionAutomatica,
                registrarDesconexionCircuitBreaker,
                activarCircuitBreakerLimiteTemporal,
                activarProteccionMiddlewarePorError,
                obtenerVistaProteccionMiddleware
            };
        `;
        const modulo = new Module(archivo, module);
        modulo.filename = archivo;
        modulo.paths = Module._nodeModulePaths(path.dirname(archivo));
        modulo._compile(fuente, archivo);
        return modulo.exports;
    } finally {
        if (anterior === undefined) delete process.env[variable];
        else process.env[variable] = anterior;
    }
}

function crearLinea(indice) {
    const sufijo = String(indice).padStart(3, '0');
    return {
        id: `cb-${sufijo}`,
        nombre: `Línea ${sufijo}`,
        ordenConexion: indice,
        etiqueta: 'caida',
        estado: 'desconectado',
        socket: null,
        jid: null,
        eliminando: false,
        iniciando: false,
        reconexionManualEnCurso: false,
        conexionEnVerificacion: false,
        reconexionBloqueada: false,
        requiereRevisionEnvio: false,
        intentosReconexion: 0,
        temporizadorReconexion: null,
        temporizadorIntentoConexion: null,
        temporizadorEstabilidadConexion: null,
        proximoIntentoReconexion: null,
        ultimaConexion: null,
        ultimaPublicacion: null,
        publicacionesRecientes: []
    };
}

function crearEntorno(t) {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-reconnection-breaker-')
    );
    const backend = cargarBackendAislado(rutaDatos);
    t.mock.timers.enable({
        apis: ['Date', 'setTimeout'],
        now: INICIO_SIMULADO
    });
    t.after(() => {
        t.mock.timers.reset();
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    });
    return backend;
}

test('un 429 pausa toda reconexión y respeta Retry-After', async t => {
    const backend = crearEntorno(t);
    const lineas = Array.from({ length: 23 }, (_, indice) =>
        crearLinea(indice + 1)
    );

    for (const linea of lineas) {
        backend.agregarLineaPrueba(linea);
        assert.equal(
            backend.programarReconexionAutomatica(
                linea.id,
                'Cierre simulado',
                503,
                5000
            ),
            true
        );
        assert.ok(linea.temporizadorReconexion);
    }

    const proteccion = backend.activarCircuitBreakerLimiteTemporal(
        lineas[0],
        { statusCode: 429, retryAfter: 120 }
    );

    assert.equal(proteccion.activa, true);
    assert.equal(proteccion.codigo, '429');
    assert.equal(
        Date.parse(proteccion.bloqueadaHasta) - INICIO_SIMULADO.getTime(),
        120000
    );
    assert.equal(backend.obtenerDiferidasPrueba().length, 23);

    for (const linea of lineas) {
        assert.equal(linea.temporizadorReconexion, null);
        assert.equal(linea.proximoIntentoReconexion, proteccion.bloqueadaHasta);
        assert.equal(linea.intentosReconexion, 0);
    }

    t.mock.timers.tick(119999);
    assert.deepEqual(backend.obtenerLlamadasConexionPrueba(), []);

    t.mock.timers.tick(1);
    const primeraTanda = backend.obtenerLlamadasConexionPrueba();
    assert.equal(primeraTanda.length, 10);
    assert.ok(primeraTanda.every(llamada =>
        llamada.timestamp === INICIO_SIMULADO.getTime() + 120000
    ));

    t.mock.timers.tick(45000);
    assert.equal(backend.obtenerLlamadasConexionPrueba().length, 10);

    for (const linea of lineas.slice(0, 10)) {
        backend.marcarLineaListaPrueba(linea.id);
    }
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(250);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(backend.obtenerLlamadasConexionPrueba().length, 10);
    t.mock.timers.tick(44999);
    assert.equal(backend.obtenerLlamadasConexionPrueba().length, 10);
    t.mock.timers.tick(1);
    for (
        let intento = 0;
        intento < 5 && backend.obtenerLlamadasConexionPrueba().length < 20;
        intento += 1
    ) {
        t.mock.timers.tick(250);
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(backend.obtenerLlamadasConexionPrueba().length, 20);

    for (const linea of lineas.slice(10, 20)) {
        backend.marcarLineaListaPrueba(linea.id);
    }
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(250);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(backend.obtenerLlamadasConexionPrueba().length, 20);
    t.mock.timers.tick(44999);
    assert.equal(backend.obtenerLlamadasConexionPrueba().length, 20);
    t.mock.timers.tick(1);
    for (
        let intento = 0;
        intento < 5 && backend.obtenerLlamadasConexionPrueba().length < 23;
        intento += 1
    ) {
        t.mock.timers.tick(250);
        await new Promise(resolve => setImmediate(resolve));
    }
    const llamadas = backend.obtenerLlamadasConexionPrueba();
    assert.equal(llamadas.length, 23);
    assert.deepEqual(
        llamadas.map(llamada => llamada.lineaId),
        lineas.map(linea => linea.id)
    );
});

test('una reconexión solicitada durante el corte queda diferida', t => {
    const backend = crearEntorno(t);
    const origen = crearLinea(1);
    const tardia = crearLinea(2);
    backend.agregarLineaPrueba(origen);
    backend.agregarLineaPrueba(tardia);

    const proteccion = backend.activarCircuitBreakerLimiteTemporal(
        origen,
        { statusCode: 429, retryAfter: 90 }
    );
    assert.equal(
        backend.programarReconexionAutomatica(
            tardia.id,
            'Solicitud durante el corte',
            429,
            1
        ),
        true
    );

    assert.equal(tardia.temporizadorReconexion, null);
    assert.equal(tardia.proximoIntentoReconexion, proteccion.bloqueadaHasta);
    assert.equal(tardia.intentosReconexion, 0);
    assert.deepEqual(
        backend.obtenerDiferidasPrueba().map(item => item.lineaId),
        [tardia.id]
    );

    t.mock.timers.tick(89999);
    assert.deepEqual(backend.obtenerLlamadasConexionPrueba(), []);
    t.mock.timers.tick(1);
    assert.deepEqual(
        backend.obtenerLlamadasConexionPrueba().map(item => item.lineaId),
        [tardia.id]
    );
});

test('una protección genérica no degrada un circuit breaker 429 activo', t => {
    const backend = crearEntorno(t);
    const linea = crearLinea(1);
    backend.agregarLineaPrueba(linea);

    const circuito = backend.activarCircuitBreakerLimiteTemporal(
        linea,
        { statusCode: 429, retryAfter: 60 }
    );
    assert.equal(circuito.tipo, 'circuit_breaker_limite_temporal');
    assert.equal(circuito.codigo, '429');

    const proteccionPosterior = backend.activarProteccionMiddlewarePorError(
        Object.assign(
            new Error('El mismo envío reportó luego un límite genérico.'),
            {
                codigo: 'DETENIDA_LIMITE_TEMPORAL',
                duracionEnfriamientoMs: 30 * 60 * 1000
            }
        )
    );

    assert.equal(
        proteccionPosterior.tipo,
        'circuit_breaker_limite_temporal'
    );
    assert.equal(proteccionPosterior.codigo, '429');
    assert.equal(
        proteccionPosterior.motivo,
        circuito.motivo,
        'debe conservar la causa global aunque el error genérico dure más'
    );
    assert.ok(
        Date.parse(proteccionPosterior.bloqueadaHasta) >=
            INICIO_SIMULADO.getTime() + 30 * 60 * 1000
    );
});

test('un circuit breaker reemplaza un enfriamiento genérico más largo', t => {
    const backend = crearEntorno(t);
    const linea = crearLinea(1);
    backend.agregarLineaPrueba(linea);

    const generica = backend.activarProteccionMiddlewarePorError(
        Object.assign(new Error('Enfriamiento genérico previo.'), {
            codigo: 'DETENIDA_LIMITE_TEMPORAL',
            duracionEnfriamientoMs: 30 * 60 * 1000
        })
    );
    assert.equal(generica.tipo, 'limite_temporal');

    const circuito = backend.activarCircuitBreakerLimiteTemporal(
        linea,
        { statusCode: 429, retryAfter: 60 }
    );

    assert.equal(circuito.tipo, 'circuit_breaker_limite_temporal');
    assert.equal(circuito.codigo, '429');
    assert.equal(
        circuito.bloqueadaHasta,
        generica.bloqueadaHasta,
        'debe conservar el vencimiento más largo sin perder la causa global'
    );
    assert.equal(
        backend.programarReconexionAutomatica(
            linea.id,
            'Solicitud durante el corte global',
            429,
            1
        ),
        true
    );
    assert.equal(linea.temporizadorReconexion, null);
    assert.deepEqual(
        backend.obtenerDiferidasPrueba().map(item => item.lineaId),
        [linea.id]
    );
});

test('una reconexión fuera de la tanda inicial queda diferida', t => {
    const backend = crearEntorno(t);
    const autorizada = crearLinea(1);
    const fueraDeTanda = crearLinea(2);
    backend.agregarLineaPrueba(autorizada);
    backend.agregarLineaPrueba(fueraDeTanda);
    backend.activarSincronizacionInicialPrueba([autorizada.id]);

    assert.equal(
        backend.programarReconexionAutomatica(
            fueraDeTanda.id,
            'Cierre mientras sincroniza otra tanda',
            503,
            5000
        ),
        true
    );

    assert.equal(fueraDeTanda.temporizadorReconexion, null);
    assert.equal(fueraDeTanda.intentosReconexion, 0);
    assert.equal(
        fueraDeTanda.proximoIntentoReconexion,
        new Date(INICIO_SIMULADO.getTime() + 5000).toISOString()
    );
    assert.deepEqual(
        backend.obtenerDiferidasInicioPrueba().map(item => item.lineaId),
        [fueraDeTanda.id]
    );

    t.mock.timers.tick(60000);
    assert.deepEqual(
        backend.obtenerLlamadasConexionPrueba(),
        [],
        'una línea ajena a la tanda no debe arrancar en paralelo'
    );
});

test('tres desconexiones distintas pausan reconexiones ya programadas', t => {
    const backend = crearEntorno(t);
    const lineas = Array.from({ length: 12 }, (_, indice) =>
        crearLinea(indice + 1)
    );

    for (const linea of lineas) {
        backend.agregarLineaPrueba(linea);
        backend.programarReconexionAutomatica(
            linea.id,
            'Reconexión previa',
            503,
            10000
        );
    }

    assert.equal(
        backend.registrarDesconexionCircuitBreaker(
            lineas[0],
            503,
            'Primera desconexión'
        ),
        false
    );
    assert.equal(
        backend.registrarDesconexionCircuitBreaker(
            lineas[1],
            503,
            'Segunda desconexión'
        ),
        false
    );
    assert.equal(
        backend.registrarDesconexionCircuitBreaker(
            lineas[2],
            503,
            'Tercera desconexión'
        ),
        true
    );

    const proteccion = backend.obtenerVistaProteccionMiddleware();
    assert.equal(proteccion.activa, true);
    assert.equal(proteccion.codigo, 'CIRCUIT_BREAKER_DESCONEXIONES');
    assert.equal(backend.obtenerDiferidasPrueba().length, 12);
    assert.ok(lineas.every(linea => linea.temporizadorReconexion === null));
    assert.ok(lineas.every(linea =>
        linea.proximoIntentoReconexion === proteccion.bloqueadaHasta
    ));
    assert.deepEqual(backend.obtenerLlamadasConexionPrueba(), []);
});
