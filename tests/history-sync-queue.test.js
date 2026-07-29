'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const EventEmitter = require('node:events');

const baileysReal = require('@whiskeysockets/baileys');
const RAIZ_PROYECTO = path.resolve(__dirname, '..');
const ID_UNO = '44444444-4444-4444-8444-444444444444';
const ID_DOS = '55555555-5555-4555-8555-555555555555';
const TIPO_FULL = baileysReal.proto.HistorySync.HistorySyncType.FULL;
const TIPO_ON_DEMAND =
    baileysReal.proto.HistorySync.HistorySyncType.ON_DEMAND;
const TIPO_RECIENTE =
    baileysReal.proto.HistorySync.HistorySyncType.RECENT;

function datosLinea(id, nombre, ordenConexion) {
    return {
        id,
        nombre,
        ordenConexion,
        etiqueta: 'activa',
        intentosReconexion: 0,
        conexionEnVerificacion: false,
        reconexionBloqueada: false
    };
}

function cargarBackendAislado(
    rutaDatos,
    sesionesRegistradas = new Map(),
    lineasGuardadas = [
        datosLinea(ID_UNO, 'Línea uno', 1),
        datosLinea(ID_DOS, 'Línea dos', 2)
    ],
    opciones = {}
) {
    for (const carpeta of ['sesiones', 'programados', 'uploads', 'historial']) {
        const ruta = path.join(rutaDatos, carpeta);
        fs.mkdirSync(ruta, { recursive: true });
        fs.writeFileSync(path.join(ruta, '.prueba-interna'), '', 'utf8');
    }
    fs.writeFileSync(
        path.join(rutaDatos, 'sesiones', 'lineas.json'),
        JSON.stringify(lineasGuardadas),
        'utf8'
    );

    const configuraciones = [];
    const sockets = [];
    const listenersExitAnteriores = new Set(process.listeners('exit'));
    const archivo = path.join(RAIZ_PROYECTO, 'src', 'bot.js');
    let original = fs.readFileSync(archivo, 'utf8');
    if (Number.isFinite(Number(opciones.tiempoPreparacionConexionMs))) {
        original = original.replace(
            'const TIEMPO_MAXIMO_PREPARACION_CONEXION_MS = 45000;',
            `const TIEMPO_MAXIMO_PREPARACION_CONEXION_MS = ` +
                `${Math.max(10, Number(opciones.tiempoPreparacionConexionMs))};`
        );
    }
    if (Number.isFinite(Number(opciones.pausaInicialConexion405Ms))) {
        original = original.replace(
            /const PAUSA_INICIAL_CONEXION_405_MS = [^;]+;/u,
            `const PAUSA_INICIAL_CONEXION_405_MS = ` +
                `${Math.max(10, Number(opciones.pausaInicialConexion405Ms))};`
        );
    }
    if (
        Array.isArray(opciones.pausasSistemicasConexion405Ms) &&
        opciones.pausasSistemicasConexion405Ms.length > 0
    ) {
        const pausas = opciones.pausasSistemicasConexion405Ms
            .map(valor => Math.max(10, Number(valor) || 10));
        original = original.replace(
            /const PAUSAS_SISTEMICAS_CONEXION_405_MS = \[[\s\S]*?\];/u,
            `const PAUSAS_SISTEMICAS_CONEXION_405_MS = ` +
                `${JSON.stringify(pausas)};`
        );
    }
    if (Number.isFinite(Number(opciones.ventanaConexion405Ms))) {
        original = original.replace(
            /const VENTANA_CONEXION_405_MS = [^;]+;/u,
            `const VENTANA_CONEXION_405_MS = ` +
                `${Math.max(10, Number(opciones.ventanaConexion405Ms))};`
        );
    }
    if (Number.isFinite(Number(opciones.espaciadoRecuperacion405Ms))) {
        original = original.replace(
            /const ESPACIADO_RECUPERACION_405_MS = [^;]+;/u,
            `const ESPACIADO_RECUPERACION_405_MS = ` +
                `${Math.max(10, Number(opciones.espaciadoRecuperacion405Ms))};`
        );
    }
    if (Number.isFinite(Number(opciones.exitosParaCerrarCircuito405))) {
        original = original.replace(
            /const EXITOS_PARA_CERRAR_CIRCUITO_405 = [^;]+;/u,
            `const EXITOS_PARA_CERRAR_CIRCUITO_405 = ` +
                `${Math.max(1, Number(opciones.exitosParaCerrarCircuito405))};`
        );
    }
    if (Number.isFinite(Number(opciones.ventanaEstabilidadConexionMs))) {
        original = original.replace(
            /const VENTANA_ESTABILIDAD_CONEXION_MS = [^;]+;/u,
            `const VENTANA_ESTABILIDAD_CONEXION_MS = ` +
                `${Math.max(10, Number(opciones.ventanaEstabilidadConexionMs))};`
        );
    }
    if (
        Array.isArray(opciones.retrasosReconexionMs) &&
        opciones.retrasosReconexionMs.length > 0
    ) {
        const retrasos = opciones.retrasosReconexionMs
            .map(valor => Math.max(10, Number(valor) || 10));
        original = original.replace(
            /const RETRASOS_RECONEXION_MS = \[[^\]]+\];/u,
            `const RETRASOS_RECONEXION_MS = ${JSON.stringify(retrasos)};`
        );
    }
    if (Number.isFinite(Number(opciones.jitterMaximoReconexionMs))) {
        original = original.replace(
            /const JITTER_MAXIMO_RECONEXION_MS = [^;]+;/u,
            `const JITTER_MAXIMO_RECONEXION_MS = ` +
                `${Math.max(0, Number(opciones.jitterMaximoReconexionMs))};`
        );
    }
    const corte = original.indexOf('\napp.listen(');
    assert.ok(corte > 0, 'No se encontró el inicio del servidor');

    const cargarOriginal = Module._load;
    const valorAnterior = process.env.AUTOSTATUES_DATA_DIR;
    process.env.AUTOSTATUES_DATA_DIR = rutaDatos;

    Module._load = function cargarModulo(request, parent, isMain) {
        if (request !== '@whiskeysockets/baileys') {
            return cargarOriginal.call(this, request, parent, isMain);
        }

        return {
            ...baileysReal,
            default: configuracion => {
                const ev = new EventEmitter();
                const socket = {
                    ev,
                    lineaId: configuracion.auth?.__lineaId || null,
                    cierres: [],
                    solicitudesHistorialCompleto: 0,
                    user: {
                        id: '595999999999@s.whatsapp.net',
                        phoneNumber: '595999999999@s.whatsapp.net'
                    },
                    signalRepository: {
                        lidMapping: {
                            getPNForLID: async () => null
                        }
                    },
                    sendPeerDataOperationMessage: async () => {
                        socket.solicitudesHistorialCompleto += 1;
                        return 'no-deberia-usarse';
                    },
                    end: error => {
                        socket.cierres.push(error);
                    }
                };
                configuraciones.push(configuracion);
                sockets.push(socket);
                return socket;
            },
            useMultiFileAuthState:
                typeof opciones.useMultiFileAuthState === 'function'
                    ? opciones.useMultiFileAuthState
                    : async carpeta => ({
                        state: {
                            __lineaId: path.basename(carpeta),
                            creds: {
                                registered:
                                    sesionesRegistradas.get(
                                        path.basename(carpeta)
                                    ) === true
                            }
                        },
                        saveCreds: async () => {}
                    })
        };
    };

    try {
        const fuente = original.slice(0, corte) + `
            module.exports = {
                app,
                cargarLineasGuardadas,
                cargarProteccionConexion405,
                colaIniciosWhatsApp,
                encolarInicioWhatsApp,
                iniciarWhatsApp,
                invalidarConexionActual,
                lineas,
                maximosIniciosWhatsAppSimultaneos:
                    MAXIMOS_INICIOS_WHATSAPP_SIMULTANEOS,
                limpiarProteccionConexion405Prueba: () => {
                    cancelarTemporizadorProteccionConexion405();
                    lineasPendientesConexion405.clear();
                    proteccionConexion405 =
                        crearProteccionConexion405Vacia();
                    colaIniciosWhatsApp.splice(0);
                },
                obtenerEstadoProteccionConexion405:
                    typeof obtenerEstadoProteccionConexion405 === 'function'
                        ? obtenerEstadoProteccionConexion405
                        : () => null,
                preparacionAutenticacionLocalPendiente,
                reanalizarMensajesRecientesAgendamiento,
                seleccionarMensajesContextualesIA,
                servicioAgendamiento,
                solicitarReconexionManual,
                turnosInicioWhatsAppActivos,
                cerrar: () => servicioAgendamiento.cerrar()
            };
        `;
        const modulo = new Module(archivo, module);
        modulo.filename = archivo;
        modulo.paths = Module._nodeModulePaths(path.dirname(archivo));
        modulo._compile(fuente, archivo);
        const listenersExitNuevos = process.listeners('exit')
            .filter(listener => !listenersExitAnteriores.has(listener));
        const cerrarOriginal = modulo.exports.cerrar;
        return {
            ...modulo.exports,
            configuraciones,
            sockets,
            cerrar: () => {
                for (const listener of listenersExitNuevos) {
                    process.removeListener('exit', listener);
                }
                return cerrarOriginal();
            }
        };
    } finally {
        Module._load = cargarOriginal;
        if (valorAnterior === undefined) {
            delete process.env.AUTOSTATUES_DATA_DIR;
        } else {
            process.env.AUTOSTATUES_DATA_DIR = valorAnterior;
        }
    }
}

function mensajeSaliente(jid, texto, timestamp, id, remoteJidAlt) {
    return {
        key: {
            fromMe: true,
            remoteJid: jid,
            remoteJidAlt,
            id
        },
        messageTimestamp: timestamp,
        message: { conversation: texto }
    };
}

function mensajesChatIA(indice, timestampBase) {
    const jid = `595981${String(indice).padStart(6, '0')}@s.whatsapp.net`;
    return [
        mensajeSaliente(jid, 'hola', timestampBase, `c${indice}-0`),
        mensajeSaliente(jid, 'datos de la cuenta', timestampBase + 1, `c${indice}-1`),
        mensajeSaliente(jid, 'clave entregada', timestampBase + 2, `c${indice}-2`),
        mensajeSaliente(jid, `Usuario: jugador${indice}x`, timestampBase + 3, `c${indice}-3`),
        mensajeSaliente(jid, 'fin', timestampBase + 4, `c${indice}-4`)
    ];
}

async function cerrarBackendAislado(backend, rutaDatos) {
    for (const linea of backend.lineas.values()) {
        linea.eliminando = true;
        for (const nombreTemporizador of [
            'temporizadorReconexion',
            'temporizadorIntentoConexion',
            'temporizadorEstabilidadConexion',
            'temporizadorAudiencia',
            'temporizadorActividadContactos',
            'temporizadorResolverPendientesAgendamiento'
        ]) {
            if (linea[nombreTemporizador]) {
                clearTimeout(linea[nombreTemporizador]);
                linea[nombreTemporizador] = null;
            }
        }
        backend.invalidarConexionActual(linea);
    }
    backend.limpiarProteccionConexion405Prueba?.();
    backend.cerrar();
    await new Promise(resolve => setTimeout(resolve, 120));
    fs.rmSync(rutaDatos, { recursive: true, force: true });
}

async function esperarHasta(condicion, mensaje, limiteMs = 1500) {
    const limite = Date.now() + limiteMs;

    while (Date.now() < limite) {
        if (condicion()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }

    assert.fail(mensaje);
}

function emitirCierreConexion(socket, codigo) {
    socket.ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: {
            error: {
                output: {
                    statusCode: codigo
                }
            }
        }
    });
}

async function escucharAplicacion(app) {
    const servidor = await new Promise((resolve, reject) => {
        const iniciado = app.listen(0, '127.0.0.1', () => resolve(iniciado));
        iniciado.once('error', reject);
    });
    const direccion = servidor.address();
    return {
        servidor,
        origen: `http://127.0.0.1:${direccion.port}`
    };
}

async function cerrarServidor(servidor) {
    if (!servidor?.listening) return;
    await new Promise((resolve, reject) => {
        servidor.close(error => error ? reject(error) : resolve());
    });
}

test('la cola limita a 10 sockets y avanza con QR, open o close sin consultar /estado', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-cola-inicios-whatsapp-')
    );
    const lineasGuardadas = Array.from({ length: 13 }, (_, indice) => {
        const numero = indice + 1;
        const sufijo = numero.toString(16).padStart(12, '0');
        return datosLinea(
            `10000000-0000-4000-8000-${sufijo}`,
            `Línea cola ${numero}`,
            numero
        );
    });
    const sesionesRegistradas = new Map(
        lineasGuardadas.map(linea => [linea.id, true])
    );
    const backend = cargarBackendAislado(
        rutaDatos,
        sesionesRegistradas,
        lineasGuardadas
    );
    const fetchAnterior = global.fetch;
    let consultasHttp = 0;
    global.fetch = async () => {
        consultasHttp += 1;
        throw new Error('La cola backend no debe depender de HTTP.');
    };

    t.after(async () => {
        global.fetch = fetchAnterior;
        await cerrarBackendAislado(backend, rutaDatos);
    });

    backend.cargarLineasGuardadas();
    for (const linea of lineasGuardadas) {
        assert.equal(
            backend.encolarInicioWhatsApp(linea.id, {
                motivo: 'prueba de límite'
            }),
            true
        );
    }

    await esperarHasta(
        () => backend.sockets.length === 10,
        'La cola no inició los primeros 10 sockets.'
    );
    await new Promise(resolve => setTimeout(resolve, 30));

    assert.equal(
        backend.maximosIniciosWhatsAppSimultaneos,
        10
    );
    assert.equal(backend.sockets.length, 10);
    assert.equal(backend.turnosInicioWhatsAppActivos.size, 10);
    assert.equal(backend.colaIniciosWhatsApp.length, 3);

    backend.sockets[0].ev.emit('connection.update', {
        qr: 'QR-DE-PRUEBA'
    });
    await esperarHasta(
        () => backend.sockets.length === 11,
        'Un QR no liberó el siguiente turno de conexión.'
    );
    assert.equal(backend.colaIniciosWhatsApp.length, 2);

    backend.sockets[1].ev.emit('connection.update', {
        connection: 'open'
    });
    await esperarHasta(
        () => backend.sockets.length === 12,
        'Un evento open no liberó el siguiente turno de conexión.'
    );
    assert.equal(backend.colaIniciosWhatsApp.length, 1);

    backend.sockets[2].ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: {
            error: {
                output: {
                    statusCode:
                        baileysReal.DisconnectReason.connectionClosed
                }
            }
        }
    });
    await esperarHasta(
        () => backend.sockets.length === 13,
        'Un evento close no liberó el siguiente turno de conexión.'
    );

    assert.equal(backend.colaIniciosWhatsApp.length, 0);
    assert.equal(backend.turnosInicioWhatsAppActivos.size, 10);
    assert.equal(consultasHttp, 0);
});

test('/estado no lee 212 cachés auxiliares ni bloquea las conexiones', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-estado-sin-io-masivo-')
    );
    const lineasGuardadas = Array.from({ length: 212 }, (_, indice) => {
        const numero = indice + 1;
        return datosLinea(
            `20000000-0000-4000-8000-${numero
                .toString(16)
                .padStart(12, '0')}`,
            `Línea estado ${numero}`,
            numero
        );
    });
    const backend = cargarBackendAislado(
        rutaDatos,
        new Map(),
        lineasGuardadas
    );
    let servidor = null;
    const leerOriginal = fs.readFileSync;
    let lecturasAuxiliares = 0;

    t.after(async () => {
        fs.readFileSync = leerOriginal;
        await cerrarServidor(servidor);
        await cerrarBackendAislado(backend, rutaDatos);
    });

    for (const linea of lineasGuardadas) {
        const carpeta = path.join(rutaDatos, 'sesiones', linea.id);
        fs.mkdirSync(carpeta, { recursive: true });
        fs.writeFileSync(
            path.join(carpeta, 'actividad-contactos.json'),
            '[]',
            'utf8'
        );
        fs.writeFileSync(
            path.join(carpeta, 'audiencia-estados.json'),
            JSON.stringify({
                contactos: [],
                contactosWhatsApp: [],
                contactosGoogle: [],
                privacidad: null
            }),
            'utf8'
        );
    }

    backend.cargarLineasGuardadas();
    fs.readFileSync = function leerSinIOAuxiliar(ruta, ...argumentos) {
        const nombre = path.basename(String(ruta));
        if (
            nombre === 'actividad-contactos.json' ||
            nombre === 'audiencia-estados.json'
        ) {
            lecturasAuxiliares += 1;
        }
        return leerOriginal.call(this, ruta, ...argumentos);
    };

    const escucha = await escucharAplicacion(backend.app);
    servidor = escucha.servidor;
    const respuesta = await fetch(`${escucha.origen}/estado`);
    const datos = await respuesta.json();

    assert.equal(respuesta.status, 200);
    assert.equal(datos.lineas.length, 212);
    assert.equal(lecturasAuxiliares, 0);

    for (const linea of lineasGuardadas) {
        backend.encolarInicioWhatsApp(linea.id, {
            motivo: 'prueba de arranque masivo'
        });
    }
    await esperarHasta(
        () => backend.sockets.length === 10,
        'La pantalla de estado impidió iniciar el primer lote.',
        5000
    );
    for (let indice = 0; indice < lineasGuardadas.length; indice += 1) {
        await esperarHasta(
            () => backend.sockets.length > indice,
            `La cola se detuvo antes de la línea ${indice + 1}.`,
            10000
        );
        backend.sockets[indice].ev.emit('connection.update', {
            qr: `QR-MASIVO-${indice}`
        });
    }
    await esperarHasta(
        () =>
            backend.colaIniciosWhatsApp.length === 0 &&
            backend.turnosInicioWhatsAppActivos.size === 0,
        'La cola masiva no liberó todos los turnos.',
        10000
    );
    assert.equal(backend.sockets.length, 212);
});

test('un caché de actividad corrupto no impide crear el socket', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-actividad-corrupta-')
    );
    const lineaGuardada = datosLinea(ID_UNO, 'Línea con caché dañado', 1);
    const backend = cargarBackendAislado(
        rutaDatos,
        new Map([[ID_UNO, true]]),
        [lineaGuardada]
    );
    const carpeta = path.join(rutaDatos, 'sesiones', ID_UNO);
    fs.mkdirSync(carpeta, { recursive: true });
    fs.writeFileSync(
        path.join(carpeta, 'actividad-contactos.json'),
        Buffer.alloc(4096, 0)
    );
    const advertirOriginal = console.warn;
    console.warn = () => {};

    t.after(async () => {
        console.warn = advertirOriginal;
        await cerrarBackendAislado(backend, rutaDatos);
    });

    backend.cargarLineasGuardadas();
    backend.encolarInicioWhatsApp(ID_UNO, {
        motivo: 'prueba de caché corrupto'
    });
    await esperarHasta(
        () => backend.sockets.length === 1,
        'El caché auxiliar impidió crear el socket.'
    );

    const socket = backend.sockets[0];
    socket.ev.emit('messages.upsert', {
        messages: [{
            key: {
                fromMe: false,
                remoteJid: '595981234567@s.whatsapp.net',
                id: 'MENSAJE-PRUEBA'
            },
            messageTimestamp: Math.floor(Date.now() / 1000),
            message: { conversation: 'hola' }
        }]
    });

    await esperarHasta(
        () => backend.lineas.get(ID_UNO).actividadContactosCargada === true,
        'No se aisló el caché corrupto.'
    );
    assert.equal(
        fs.readdirSync(carpeta).some(nombre =>
            nombre.startsWith('actividad-contactos.json.corrupto-')
        ),
        true
    );

    socket.ev.emit('connection.update', { qr: 'QR-CACHE-CORRUPTO' });
});

test('recupera actividad desde .tmp sin modificar credenciales de Baileys', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-recuperacion-actividad-')
    );
    const lineasGuardadas = [
        datosLinea(ID_UNO, 'Línea principal corrupto', 1),
        datosLinea(ID_DOS, 'Línea principal ausente', 2)
    ];
    const backend = cargarBackendAislado(
        rutaDatos,
        new Map([
            [ID_UNO, true],
            [ID_DOS, true]
        ]),
        lineasGuardadas
    );
    const contenidosCredenciales = new Map();
    const actividades = new Map([
        [ID_UNO, [['595981111111@s.whatsapp.net', 1700000000000]]],
        [ID_DOS, [['595982222222@s.whatsapp.net', 1700000100000]]]
    ]);
    const advertirOriginal = console.warn;
    console.warn = () => {};

    t.after(async () => {
        console.warn = advertirOriginal;
        await cerrarBackendAislado(backend, rutaDatos);
    });

    for (const linea of lineasGuardadas) {
        const carpeta = path.join(rutaDatos, 'sesiones', linea.id);
        fs.mkdirSync(carpeta, { recursive: true });
        for (const [nombre, contenido] of [
            ['creds.json', Buffer.from(`{"id":"creds-${linea.id}"}`)],
            ['session-1.json', Buffer.from(`{"id":"session-${linea.id}"}`)],
            ['app-state-sync-key-1.json', Buffer.from(`{"id":"app-${linea.id}"}`)],
            ['sender-key-1.json', Buffer.from(`{"id":"sender-${linea.id}"}`)]
        ]) {
            const ruta = path.join(carpeta, nombre);
            fs.writeFileSync(ruta, contenido);
            contenidosCredenciales.set(ruta, contenido);
        }
        fs.writeFileSync(
            path.join(carpeta, 'actividad-contactos.json.tmp'),
            JSON.stringify(actividades.get(linea.id)),
            'utf8'
        );
    }
    fs.writeFileSync(
        path.join(
            rutaDatos,
            'sesiones',
            ID_UNO,
            'actividad-contactos.json'
        ),
        Buffer.alloc(2048, 0)
    );

    backend.cargarLineasGuardadas();
    for (const linea of lineasGuardadas) {
        backend.encolarInicioWhatsApp(linea.id, {
            motivo: 'prueba de recuperación auxiliar'
        });
    }
    await esperarHasta(
        () => backend.sockets.length === 2,
        'No se crearon ambos sockets.'
    );

    for (const socket of backend.sockets) {
        socket.ev.emit('messages.upsert', { messages: [] });
    }
    await esperarHasta(
        () => lineasGuardadas.every(linea =>
            backend.lineas.get(linea.id).actividadContactosCargada === true
        ),
        'No se cargaron ambos índices recuperados.'
    );

    for (const linea of lineasGuardadas) {
        const carpeta = path.join(rutaDatos, 'sesiones', linea.id);
        const rutaPrincipal = path.join(
            carpeta,
            'actividad-contactos.json'
        );
        assert.deepEqual(
            JSON.parse(fs.readFileSync(rutaPrincipal, 'utf8')),
            actividades.get(linea.id)
        );
        assert.equal(
            backend.lineas.get(linea.id).ultimaInteraccionContactos.size,
            1
        );
    }
    assert.equal(
        fs.readdirSync(path.join(rutaDatos, 'sesiones', ID_UNO))
            .some(nombre =>
                nombre.startsWith(
                    'actividad-contactos.json.corrupto-'
                )
            ),
        true
    );
    for (const [ruta, contenido] of contenidosCredenciales) {
        assert.deepEqual(fs.readFileSync(ruta), contenido);
    }

    for (const socket of backend.sockets) {
        socket.ev.emit('connection.update', {
            qr: `QR-RECUPERACION-${socket.lineaId}`
        });
    }
});

test('una preparación local lenta libera la cola y se reanuda sin duplicarse', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-preparacion-colgada-')
    );
    const lineasGuardadas = Array.from({ length: 11 }, (_, indice) => {
        const numero = indice + 1;
        return datosLinea(
            `30000000-0000-4000-8000-${numero
                .toString(16)
                .padStart(12, '0')}`,
            `Línea preparación ${numero}`,
            numero
        );
    });
    const idsColgados = new Set(
        lineasGuardadas.slice(0, 10).map(linea => linea.id)
    );
    const llamadas = new Map();
    const preparacionesPendientes = new Map();
    const backend = cargarBackendAislado(
        rutaDatos,
        new Map(lineasGuardadas.map(linea => [linea.id, true])),
        lineasGuardadas,
        {
            tiempoPreparacionConexionMs: 30,
            useMultiFileAuthState: async carpeta => {
                const id = path.basename(carpeta);
                const cantidad = (llamadas.get(id) || 0) + 1;
                llamadas.set(id, cantidad);
                if (idsColgados.has(id) && cantidad === 1) {
                    return new Promise((resolve, reject) => {
                        preparacionesPendientes.set(id, {
                            resolve,
                            reject
                        });
                    });
                }
                return {
                    state: {
                        __lineaId: id,
                        creds: { registered: true }
                    },
                    saveCreds: async () => {}
                };
            }
        }
    );
    const errorOriginal = console.error;
    const advertirOriginal = console.warn;
    console.error = () => {};
    console.warn = () => {};

    t.after(async () => {
        console.error = errorOriginal;
        console.warn = advertirOriginal;
        await cerrarBackendAislado(backend, rutaDatos);
    });

    backend.cargarLineasGuardadas();
    for (const linea of lineasGuardadas) {
        backend.encolarInicioWhatsApp(linea.id, {
            motivo: 'prueba de preparación colgada'
        });
    }

    const ultima = lineasGuardadas.at(-1);
    await esperarHasta(
        () => backend.sockets.some(socket => socket.lineaId === ultima.id),
        'Los turnos colgados no liberaron la línea siguiente.',
        2000
    );

    const primera = backend.lineas.get(lineasGuardadas[0].id);
    assert.equal(primera.iniciando, false);
    assert.equal(primera.reconexionManualEnCurso, false);
    assert.equal(primera.intentosReconexion, 0);
    assert.equal(primera.reconexionBloqueada, false);
    for (const id of idsColgados) {
        assert.equal(backend.turnosInicioWhatsAppActivos.has(id), false);
    }

    preparacionesPendientes.get(primera.id).resolve({
        state: {
            __lineaId: primera.id,
            creds: { registered: true }
        },
        saveCreds: async () => {}
    });
    await esperarHasta(
        () => backend.sockets.some(socket => socket.lineaId === primera.id),
        'La lectura local no retomó automáticamente la línea.',
        2000
    );
    assert.equal(
        llamadas.get(primera.id),
        1,
        'Reconectar abrió otra lectura simultánea de la misma sesión.'
    );

    const socketManual = backend.sockets.find(
        socket => socket.lineaId === primera.id
    );
    socketManual.ev.emit('connection.update', { connection: 'open' });
    await esperarHasta(
        () => primera.reconexionManualEnCurso === false,
        'La línea quedó marcada como reconexión manual.'
    );
});

test('Reconectar no crea un segundo socket si una preparación agotada termina antes del QR', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-reconexion-sin-socket-duplicado-')
    );
    const lineaGuardada = datosLinea(
        ID_UNO,
        'Línea reconexión sin duplicado',
        1
    );
    let resolverPreparacion = null;
    let llamadasAutenticacion = 0;
    const backend = cargarBackendAislado(
        rutaDatos,
        new Map([[ID_UNO, true]]),
        [lineaGuardada],
        {
            tiempoPreparacionConexionMs: 30,
            useMultiFileAuthState: async carpeta => {
                llamadasAutenticacion += 1;
                if (llamadasAutenticacion === 1) {
                    return new Promise(resolve => {
                        resolverPreparacion = resolve;
                    });
                }
                return {
                    state: {
                        __lineaId: path.basename(carpeta),
                        creds: { registered: true }
                    },
                    saveCreds: async () => {}
                };
            }
        }
    );
    const errorOriginal = console.error;
    const advertirOriginal = console.warn;
    console.error = () => {};
    console.warn = () => {};
    let servidor = null;

    t.after(async () => {
        console.error = errorOriginal;
        console.warn = advertirOriginal;
        await cerrarServidor(servidor);
        await cerrarBackendAislado(backend, rutaDatos);
    });

    backend.cargarLineasGuardadas();
    const escucha = await escucharAplicacion(backend.app);
    servidor = escucha.servidor;
    backend.encolarInicioWhatsApp(ID_UNO, {
        motivo: 'prueba de carrera al reconectar'
    });

    const linea = backend.lineas.get(ID_UNO);
    await esperarHasta(
        () =>
            llamadasAutenticacion === 1 &&
            linea.estado === 'reconectando' &&
            linea.iniciando === false &&
            !backend.turnosInicioWhatsAppActivos.has(ID_UNO),
        'La preparación inicial no agotó su tiempo.',
        2000
    );

    resolverPreparacion({
        state: {
            __lineaId: ID_UNO,
            creds: { registered: true }
        },
        saveCreds: async () => {}
    });
    for (let indice = 0; indice < 10; indice += 1) {
        await Promise.resolve();
    }
    assert.equal(
        backend.preparacionAutenticacionLocalPendiente(ID_UNO),
        true,
        'La lectura dejó de estar protegida antes de que la reanudación la consumiera.'
    );

    // Simula el borde interno en el que una solicitud manual ya había pasado
    // su validación cuando terminó la lectura. Incluso en ese caso, su
    // temporizador no debe crear otro socket después del QR automático.
    assert.equal(backend.solicitarReconexionManual(linea, 500), true);
    assert.equal(linea.reconexionManualEnCurso, true);

    await esperarHasta(
        () => backend.sockets.length === 1,
        'La preparación original no reanudó la conexión.'
    );

    backend.sockets[0].ev.emit('connection.update', {
        qr: 'QR-RECONEXION-SIN-DUPLICADO'
    });
    await esperarHasta(
        () => !backend.turnosInicioWhatsAppActivos.has(ID_UNO),
        'El QR no liberó el turno de la primera conexión.'
    );

    await new Promise(resolve => setTimeout(resolve, 650));

    assert.equal(
        llamadasAutenticacion,
        1,
        'El temporizador de Reconectar volvió a leer la misma sesión.'
    );
    assert.equal(
        backend.sockets.length,
        1,
        'El temporizador de Reconectar creó un segundo socket después del QR.'
    );
});

test('Reconectar explica una lectura local que nunca terminó sin duplicarla', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-preparacion-infinita-')
    );
    const lineaGuardada = datosLinea(ID_UNO, 'Línea lectura pendiente', 1);
    let llamadas = 0;
    const backend = cargarBackendAislado(
        rutaDatos,
        new Map([[ID_UNO, true]]),
        [lineaGuardada],
        {
            tiempoPreparacionConexionMs: 30,
            useMultiFileAuthState: async () => {
                llamadas += 1;
                return new Promise(() => {});
            }
        }
    );
    const errorOriginal = console.error;
    const advertirOriginal = console.warn;
    console.error = () => {};
    console.warn = () => {};
    let servidor = null;

    t.after(async () => {
        console.error = errorOriginal;
        console.warn = advertirOriginal;
        await cerrarServidor(servidor);
        await cerrarBackendAislado(backend, rutaDatos);
    });

    backend.cargarLineasGuardadas();
    const escucha = await escucharAplicacion(backend.app);
    servidor = escucha.servidor;
    backend.encolarInicioWhatsApp(ID_UNO, {
        motivo: 'prueba de lectura pendiente'
    });
    await esperarHasta(
        () =>
            backend.lineas.get(ID_UNO).estado === 'reconectando' &&
            backend.turnosInicioWhatsAppActivos.size === 0,
        'El timeout local no liberó el turno.',
        2000
    );

    const respuesta = await fetch(
        `${escucha.origen}/lineas/${ID_UNO}/reconectar`,
        { method: 'POST' }
    );
    const datos = await respuesta.json();
    assert.equal(respuesta.status, 409);
    assert.equal(datos.codigo, 'PREPARACION_LOCAL_PENDIENTE');
    assert.match(datos.error, /no hace falta vincular nuevamente el QR/u);

    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(llamadas, 1);
    assert.equal(backend.sockets.length, 0);
    assert.equal(backend.lineas.get(ID_UNO).intentosReconexion, 0);
    assert.equal(backend.lineas.get(ID_UNO).reconexionBloqueada, false);
});

test('un rechazo local transitorio permite una lectura nueva al Reconectar', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-preparacion-rechazada-')
    );
    const lineaGuardada = datosLinea(ID_UNO, 'Línea rechazo transitorio', 1);
    let llamadas = 0;
    const backend = cargarBackendAislado(
        rutaDatos,
        new Map([[ID_UNO, true]]),
        [lineaGuardada],
        {
            tiempoPreparacionConexionMs: 100,
            useMultiFileAuthState: async carpeta => {
                llamadas += 1;
                if (llamadas === 1) {
                    throw new Error('Lectura local interrumpida');
                }
                return {
                    state: {
                        __lineaId: path.basename(carpeta),
                        creds: { registered: true }
                    },
                    saveCreds: async () => {}
                };
            }
        }
    );
    const errorOriginal = console.error;
    console.error = () => {};
    let servidor = null;

    t.after(async () => {
        console.error = errorOriginal;
        await cerrarServidor(servidor);
        await cerrarBackendAislado(backend, rutaDatos);
    });

    backend.cargarLineasGuardadas();
    const escucha = await escucharAplicacion(backend.app);
    servidor = escucha.servidor;
    backend.encolarInicioWhatsApp(ID_UNO, {
        motivo: 'prueba de rechazo transitorio'
    });
    await esperarHasta(
        () =>
            llamadas === 1 &&
            backend.turnosInicioWhatsAppActivos.size === 0,
        'El primer rechazo no liberó la cola.',
        2000
    );

    const respuesta = await fetch(
        `${escucha.origen}/lineas/${ID_UNO}/reconectar`,
        { method: 'POST' }
    );
    assert.equal(respuesta.status, 202);
    await esperarHasta(
        () => backend.sockets.some(socket => socket.lineaId === ID_UNO),
        'La segunda lectura local no creó el socket.',
        2500
    );
    assert.equal(llamadas, 2);
    backend.sockets.find(socket => socket.lineaId === ID_UNO)
        .ev.emit('connection.update', { connection: 'open' });
});

test('tres cierres 405 pausan globalmente sin gastar intentos ni tocar credenciales', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-proteccion-global-405-')
    );
    const lineasGuardadas = Array.from({ length: 3 }, (_, indice) => {
        const numero = indice + 1;
        return datosLinea(
            `40500000-0000-4000-8000-${numero
                .toString(16)
                .padStart(12, '0')}`,
            `Linea 405 ${numero}`,
            numero
        );
    });
    const archivosProtegidos = new Map();

    for (const linea of lineasGuardadas) {
        const carpeta = path.join(rutaDatos, 'sesiones', linea.id);
        fs.mkdirSync(carpeta, { recursive: true });
        const credenciales = Buffer.from(
            `{"registered":true,"linea":"${linea.id}"}\n`,
            'utf8'
        );
        const appState = Buffer.from(
            `estado-cifrado-${linea.id}\u0000\u00ff`,
            'latin1'
        );
        fs.writeFileSync(path.join(carpeta, 'creds.json'), credenciales);
        fs.writeFileSync(
            path.join(carpeta, 'app-state-sync-key-1.json'),
            appState
        );
        archivosProtegidos.set(linea.id, { credenciales, appState });
    }

    const backend = cargarBackendAislado(
        rutaDatos,
        new Map(lineasGuardadas.map(linea => [linea.id, true])),
        lineasGuardadas,
        {
            pausaInicialConexion405Ms: 120,
            pausasSistemicasConexion405Ms: [120, 200, 300],
            ventanaConexion405Ms: 500,
            espaciadoRecuperacion405Ms: 10,
            exitosParaCerrarCircuito405: 3,
            ventanaEstabilidadConexionMs: 50
        }
    );
    const advertirOriginal = console.warn;
    console.warn = () => {};

    t.after(async () => {
        console.warn = advertirOriginal;
        await cerrarBackendAislado(backend, rutaDatos);
    });

    backend.cargarLineasGuardadas();
    for (const linea of lineasGuardadas) {
        await backend.iniciarWhatsApp(linea.id);
    }
    assert.equal(backend.sockets.length, 3);

    for (const socket of backend.sockets) {
        emitirCierreConexion(socket, 405);
        await new Promise(resolve => setImmediate(resolve));
    }

    const proteccion = backend.obtenerEstadoProteccionConexion405();
    assert.equal(proteccion?.pausada, true);
    const totalEventos = Array.isArray(proteccion?.eventosRecientes)
        ? proteccion.eventosRecientes.length
        : Number(proteccion?.eventosRecientes);
    assert.ok(
        totalEventos >= 3,
        'La proteccion global no registro las tres lineas distintas.'
    );

    for (const lineaGuardada of lineasGuardadas) {
        const linea = backend.lineas.get(lineaGuardada.id);
        assert.equal(linea.intentosReconexion, 0);
        assert.equal(linea.reconexionBloqueada, false);
        assert.notEqual(linea.estado, 'requiere_intervencion');

        const originales = archivosProtegidos.get(linea.id);
        const carpeta = path.join(rutaDatos, 'sesiones', linea.id);
        assert.deepEqual(
            fs.readFileSync(path.join(carpeta, 'creds.json')),
            originales.credenciales
        );
        assert.deepEqual(
            fs.readFileSync(
                path.join(carpeta, 'app-state-sync-key-1.json')
            ),
            originales.appState
        );
    }

    await esperarHasta(
        () => backend.sockets.length === 4,
        'La recuperacion serial no inicio despues de la pausa 405.',
        2000
    );
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(
        backend.sockets.length,
        4,
        'La recuperacion 405 abrio mas de un socket a la vez.'
    );

    for (let indice = 3; indice < 6; indice += 1) {
        backend.sockets[indice].ev.emit('connection.update', {
            connection: 'open'
        });
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(
            backend.sockets.length,
            indice + 1,
            'La recuperacion avanzo antes de confirmar la estabilidad.'
        );
        if (indice < 5) {
            await esperarHasta(
                () => backend.sockets.length === indice + 2,
                'La recuperacion 405 no avanzo tras confirmar el socket anterior.',
                2000
            );
            await new Promise(resolve => setTimeout(resolve, 60));
            assert.equal(
                backend.sockets.length,
                indice + 2,
                'La recuperacion 405 solapo dos sockets.'
            );
        }
    }

    await esperarHasta(
        () => backend.obtenerEstadoProteccionConexion405()?.pausada === false,
        'Tres recuperaciones estables no cerraron el circuito 405.',
        2000
    );
});

test('Reconectar manual no altera la linea mientras el circuito 405 esta pausado', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-reconexion-manual-pausa-405-')
    );
    const lineasGuardadas = [
        datosLinea(ID_UNO, 'Linea conectada protegida', 1),
        datosLinea(ID_DOS, 'Linea que activa 405', 2)
    ];
    const backend = cargarBackendAislado(
        rutaDatos,
        new Map([
            [ID_UNO, true],
            [ID_DOS, true]
        ]),
        lineasGuardadas,
        {
            pausaInicialConexion405Ms: 500,
            pausasSistemicasConexion405Ms: [500],
            ventanaConexion405Ms: 1000
        }
    );
    const advertirOriginal = console.warn;
    console.warn = () => {};

    t.after(async () => {
        console.warn = advertirOriginal;
        await cerrarBackendAislado(backend, rutaDatos);
    });

    backend.cargarLineasGuardadas();
    await backend.iniciarWhatsApp(ID_UNO);
    await backend.iniciarWhatsApp(ID_DOS);

    const socketProtegido = backend.sockets.find(
        socket => socket.lineaId === ID_UNO
    );
    const socketRechazado = backend.sockets.find(
        socket => socket.lineaId === ID_DOS
    );
    socketProtegido.ev.emit('connection.update', { connection: 'open' });
    await esperarHasta(
        () => backend.lineas.get(ID_UNO).estado === 'conectado',
        'La linea de control no llego a estar conectada.'
    );
    emitirCierreConexion(socketRechazado, 405);
    await esperarHasta(
        () => backend.obtenerEstadoProteccionConexion405()?.pausada === true,
        'El rechazo 405 no activo la pausa de proteccion.'
    );

    const linea = backend.lineas.get(ID_UNO);
    const estadoAnterior = {
        socket: linea.socket,
        generacionConexion: linea.generacionConexion,
        estado: linea.estado,
        etiqueta: linea.etiqueta,
        iniciando: linea.iniciando,
        reconexionManualEnCurso: linea.reconexionManualEnCurso,
        reconexionBloqueada: linea.reconexionBloqueada,
        intentosReconexion: linea.intentosReconexion,
        temporizadorReconexion: linea.temporizadorReconexion,
        temporizadorAudiencia: linea.temporizadorAudiencia,
        jid: linea.jid,
        qr: linea.qr
    };

    assert.equal(backend.solicitarReconexionManual(linea, 0), false);
    assert.deepEqual(
        {
            socket: linea.socket,
            generacionConexion: linea.generacionConexion,
            estado: linea.estado,
            etiqueta: linea.etiqueta,
            iniciando: linea.iniciando,
            reconexionManualEnCurso: linea.reconexionManualEnCurso,
            reconexionBloqueada: linea.reconexionBloqueada,
            intentosReconexion: linea.intentosReconexion,
            temporizadorReconexion: linea.temporizadorReconexion,
            temporizadorAudiencia: linea.temporizadorAudiencia,
            jid: linea.jid,
            qr: linea.qr
        },
        estadoAnterior
    );
    assert.equal(
        socketProtegido.cierres.length,
        0,
        'Reconectar cerro el socket aunque el circuito 405 estaba pausado.'
    );
});

test('una rafaga 405 detiene la creacion de sockets para 212 lineas en cola', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-escala-pausa-405-')
    );
    const lineasGuardadas = Array.from({ length: 212 }, (_, indice) => {
        const numero = indice + 1;
        return datosLinea(
            `40521200-0000-4000-8000-${numero
                .toString(16)
                .padStart(12, '0')}`,
            `Linea escala 405 ${numero}`,
            numero
        );
    });
    const backend = cargarBackendAislado(
        rutaDatos,
        new Map(lineasGuardadas.map(linea => [linea.id, true])),
        lineasGuardadas,
        {
            pausaInicialConexion405Ms: 1000,
            pausasSistemicasConexion405Ms: [1000],
            ventanaConexion405Ms: 2000
        }
    );
    const advertirOriginal = console.warn;
    console.warn = () => {};

    t.after(async () => {
        console.warn = advertirOriginal;
        await cerrarBackendAislado(backend, rutaDatos);
    });

    backend.cargarLineasGuardadas();
    for (const linea of lineasGuardadas) {
        backend.encolarInicioWhatsApp(linea.id, {
            motivo: 'prueba de escala 405'
        });
    }
    await esperarHasta(
        () => backend.sockets.length === 10,
        'La cola no inicio sus primeros diez sockets.',
        2000
    );

    for (const socket of backend.sockets.slice(0, 3)) {
        emitirCierreConexion(socket, 405);
        await new Promise(resolve => setImmediate(resolve));
    }
    const proteccion = backend.obtenerEstadoProteccionConexion405();
    assert.equal(proteccion.pausada, true);
    assert.ok(proteccion.eventosRecientes >= 3);

    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(
        backend.sockets.length,
        10,
        'La cola creo sockets nuevos durante la pausa global 405.'
    );
    assert.equal(
        backend.turnosInicioWhatsAppActivos.size,
        7,
        'La pausa modifico turnos que ya estaban iniciados.'
    );
    assert.ok(
        backend.colaIniciosWhatsApp.length >= 202,
        'La pausa descarto lineas que debian permanecer en cola.'
    );
});

test('una pausa 405 persistida demasiado futura se acota y corrige en disco', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-pausa-405-acotada-')
    );
    const maximoMs = 300;
    const rutaProteccion = path.join(
        rutaDatos,
        'proteccion-conexion-405.json'
    );
    fs.mkdirSync(rutaDatos, { recursive: true });
    fs.writeFileSync(
        rutaProteccion,
        JSON.stringify({
            version: 1,
            bloqueadaHasta: '2099-01-01T00:00:00.000Z',
            nivel: 99,
            recuperacion: false,
            motivo: 'rafaga_405'
        }),
        'utf8'
    );

    const backend = cargarBackendAislado(
        rutaDatos,
        new Map(),
        [],
        {
            pausaInicialConexion405Ms: 120,
            pausasSistemicasConexion405Ms: [120, 200, maximoMs]
        }
    );

    t.after(async () => {
        await cerrarBackendAislado(backend, rutaDatos);
    });

    const antes = Date.now();
    backend.cargarProteccionConexion405();
    const estado = backend.obtenerEstadoProteccionConexion405();
    const vencimiento = Date.parse(estado.bloqueadaHasta || '');
    assert.ok(vencimiento >= antes);
    assert.ok(vencimiento <= Date.now() + maximoMs + 50);

    const persistida = JSON.parse(
        fs.readFileSync(rutaProteccion, 'utf8')
    );
    assert.equal(persistida.bloqueadaHasta, estado.bloqueadaHasta);
});

test('un error 405 durante iniciarWhatsApp entra al circuito global', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-catch-inicio-405-')
    );
    const lineaGuardada = datosLinea(
        ID_UNO,
        'Linea con rechazo 405 durante inicio',
        1
    );
    let lecturasAutenticacion = 0;
    const backend = cargarBackendAislado(
        rutaDatos,
        new Map([[ID_UNO, true]]),
        [lineaGuardada],
        {
            pausaInicialConexion405Ms: 500,
            pausasSistemicasConexion405Ms: [500],
            ventanaConexion405Ms: 1000,
            useMultiFileAuthState: async () => {
                lecturasAutenticacion += 1;
                const error = new Error(
                    'WhatsApp rechazo la preparacion del socket'
                );
                error.output = { statusCode: 405 };
                throw error;
            }
        }
    );
    const errorOriginal = console.error;
    const advertirOriginal = console.warn;
    console.error = () => {};
    console.warn = () => {};

    t.after(async () => {
        console.error = errorOriginal;
        console.warn = advertirOriginal;
        await cerrarBackendAislado(backend, rutaDatos);
    });

    backend.cargarLineasGuardadas();
    backend.encolarInicioWhatsApp(ID_UNO, {
        motivo: 'prueba catch 405'
    });
    await esperarHasta(
        () => backend.obtenerEstadoProteccionConexion405()?.pausada === true,
        'El 405 lanzado durante el inicio no activo el circuito.',
        2000
    );

    const linea = backend.lineas.get(ID_UNO);
    const proteccion = backend.obtenerEstadoProteccionConexion405();
    assert.equal(lecturasAutenticacion, 1);
    assert.equal(backend.sockets.length, 0);
    assert.equal(proteccion.eventosRecientes, 1);
    assert.equal(proteccion.pendientes, 1);
    assert.equal(linea.ultimoCodigoDesconexion, 405);
    assert.equal(linea.intentosReconexion, 0);
    assert.equal(linea.reconexionBloqueada, false);
    assert.equal(linea.estado, 'reconectando');
});

test('una sonda 405 que cierra con 428 vuelve al backoff normal', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-sonda-405-falla-428-')
    );
    const lineaGuardada = datosLinea(
        ID_UNO,
        'Linea cuya sonda falla con 428',
        1
    );
    const backend = cargarBackendAislado(
        rutaDatos,
        new Map([[ID_UNO, true]]),
        [lineaGuardada],
        {
            pausaInicialConexion405Ms: 80,
            pausasSistemicasConexion405Ms: [80],
            ventanaConexion405Ms: 500,
            espaciadoRecuperacion405Ms: 10,
            retrasosReconexionMs: [40, 80, 120],
            jitterMaximoReconexionMs: 0
        }
    );
    const advertirOriginal = console.warn;
    console.warn = () => {};

    t.after(async () => {
        console.warn = advertirOriginal;
        await cerrarBackendAislado(backend, rutaDatos);
    });

    backend.cargarLineasGuardadas();
    await backend.iniciarWhatsApp(ID_UNO);
    emitirCierreConexion(backend.sockets[0], 405);
    await esperarHasta(
        () => backend.sockets.length === 2,
        'No se inicio la sonda posterior al 405.',
        2000
    );

    const linea = backend.lineas.get(ID_UNO);
    assert.ok(linea.sondaConexion405);
    emitirCierreConexion(backend.sockets[1], 428);
    await esperarHasta(
        () =>
            linea.sondaConexion405 === null &&
            backend.obtenerEstadoProteccionConexion405().pendientes === 0,
        'La sonda fallida permanecio retenida en el circuito 405.',
        2000
    );

    assert.equal(linea.ultimoCodigoDesconexion, 428);
    assert.equal(linea.reconexionBloqueada, false);
    assert.equal(linea.intentosReconexion, 0);
    assert.ok(linea.temporizadorReconexion);
    assert.ok(Date.parse(linea.proximoIntentoReconexion) > Date.now());

    await esperarHasta(
        () => backend.sockets.length === 3,
        'El backoff normal no ejecuto su primer reintento.',
        2000
    );
    assert.equal(linea.intentosReconexion, 1);
    assert.equal(
        backend.obtenerEstadoProteccionConexion405().pendientes,
        0
    );
});

test('una linea persistida como bloqueada por 405 se rehabilita al cargar', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-migracion-bloqueo-405-')
    );
    const mensajeBloqueoLegacy =
        'La línea no pudo reconectarse después de 5 intentos. ' +
        'Usá Reconectar cuando quieras volver a intentarlo.';
    const lineaGuardadaLegacy = {
        ...datosLinea(ID_UNO, 'Linea bloqueada por 405', 1),
        etiqueta: 'caida',
        intentosReconexion: 5,
        reconexionBloqueada: true,
        conexionEnVerificacion: false,
        ultimoCodigoDesconexion: 405,
        ultimoError: mensajeBloqueoLegacy
    };
    const lineaBloqueadaManualmente = {
        ...datosLinea(ID_DOS, 'Linea 405 bloqueada manualmente', 2),
        etiqueta: 'caida',
        intentosReconexion: 5,
        reconexionBloqueada: true,
        origenBloqueoReconexion: 'manual',
        conexionEnVerificacion: false,
        ultimoCodigoDesconexion: 405,
        ultimoError: mensajeBloqueoLegacy
    };
    const backend = cargarBackendAislado(
        rutaDatos,
        new Map([
            [ID_UNO, true],
            [ID_DOS, true]
        ]),
        [lineaGuardadaLegacy, lineaBloqueadaManualmente]
    );

    t.after(async () => {
        await cerrarBackendAislado(backend, rutaDatos);
    });

    backend.cargarLineasGuardadas();
    const linea = backend.lineas.get(ID_UNO);
    assert.equal(linea.intentosReconexion, 0);
    assert.equal(linea.reconexionBloqueada, false);
    assert.notEqual(linea.estado, 'requiere_intervencion');

    const lineaManual = backend.lineas.get(ID_DOS);
    assert.equal(lineaManual.intentosReconexion, 5);
    assert.equal(lineaManual.reconexionBloqueada, true);
    assert.equal(lineaManual.estado, 'requiere_intervencion');
    assert.equal(lineaManual.origenBloqueoReconexion, 'manual');

    const lineasPersistidas = JSON.parse(
        fs.readFileSync(
            path.join(rutaDatos, 'sesiones', 'lineas.json'),
            'utf8'
        )
    );
    const legacyPersistida = lineasPersistidas.find(item => item.id === ID_UNO);
    const manualPersistida = lineasPersistidas.find(item => item.id === ID_DOS);
    assert.equal(legacyPersistida.intentosReconexion, 0);
    assert.equal(legacyPersistida.reconexionBloqueada, false);
    assert.equal(manualPersistida.reconexionBloqueada, true);
    assert.equal(manualPersistida.origenBloqueoReconexion, 'manual');

    assert.equal(
        backend.encolarInicioWhatsApp(ID_UNO, {
            motivo: 'prueba de migracion 405'
        }),
        true
    );
    await esperarHasta(
        () => backend.sockets.some(socket => socket.lineaId === ID_UNO),
        'La linea rehabilitada no pudo volver a la cola de conexion.',
        2000
    );
});

test('un origen de bloqueo desconocido nunca se migra automaticamente', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-origen-bloqueo-desconocido-')
    );
    const lineaGuardada = {
        ...datosLinea(ID_UNO, 'Linea con origen desconocido', 1),
        etiqueta: 'caida',
        intentosReconexion: 5,
        reconexionBloqueada: true,
        origenBloqueoReconexion: 'sistema_externo_no_reconocido',
        conexionEnVerificacion: false,
        ultimoCodigoDesconexion: 405,
        ultimoError:
            'La linea quedo bloqueada por una causa externa desconocida.'
    };
    const backend = cargarBackendAislado(
        rutaDatos,
        new Map([[ID_UNO, true]]),
        [lineaGuardada]
    );

    t.after(async () => {
        await cerrarBackendAislado(backend, rutaDatos);
    });

    backend.cargarLineasGuardadas();
    const linea = backend.lineas.get(ID_UNO);
    assert.equal(linea.intentosReconexion, 5);
    assert.equal(linea.reconexionBloqueada, true);
    assert.equal(linea.estado, 'requiere_intervencion');
    assert.equal(linea.origenBloqueoReconexion, 'desconocido');
    assert.equal(
        backend.obtenerEstadoProteccionConexion405().pendientes,
        0
    );

    const persistida = JSON.parse(
        fs.readFileSync(
            path.join(rutaDatos, 'sesiones', 'lineas.json'),
            'utf8'
        )
    ).find(item => item.id === ID_UNO);
    assert.equal(persistida.reconexionBloqueada, true);
    assert.equal(persistida.intentosReconexion, 5);
    assert.equal(persistida.origenBloqueoReconexion, 'desconocido');
});

test('el cierre 401 conserva el bloqueo y borrado de sesion actual', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-cierre-fatal-401-')
    );
    const lineaGuardada = datosLinea(ID_UNO, 'Linea con cierre 401', 1);
    const carpetaSesion = path.join(rutaDatos, 'sesiones', ID_UNO);
    fs.mkdirSync(carpetaSesion, { recursive: true });
    fs.writeFileSync(
        path.join(carpetaSesion, 'creds.json'),
        '{"registered":true,"secreto":"prueba"}',
        'utf8'
    );
    const backend = cargarBackendAislado(
        rutaDatos,
        new Map([[ID_UNO, true]]),
        [lineaGuardada]
    );
    const advertirOriginal = console.warn;
    console.warn = () => {};

    t.after(async () => {
        console.warn = advertirOriginal;
        await cerrarBackendAislado(backend, rutaDatos);
    });

    backend.cargarLineasGuardadas();
    await backend.iniciarWhatsApp(ID_UNO);
    emitirCierreConexion(backend.sockets[0], 401);

    await esperarHasta(
        () => backend.lineas.get(ID_UNO).estado === 'sesion_cerrada',
        'El cierre 401 no conservo el estado fatal existente.'
    );
    const linea = backend.lineas.get(ID_UNO);
    assert.equal(linea.reconexionBloqueada, true);
    assert.equal(linea.etiqueta, 'caida');
    assert.equal(fs.existsSync(carpetaSesion), false);
});

test('todas las conexiones aceptan solo historial reciente y nunca solicitan FULL', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-recent-only-')
    );
    const backend = cargarBackendAislado(
        rutaDatos,
        new Map([[ID_UNO, true]])
    );
    t.after(() => cerrarBackendAislado(backend, rutaDatos));

    backend.cargarLineasGuardadas();
    await backend.iniciarWhatsApp(ID_UNO);
    await backend.iniciarWhatsApp(ID_DOS);

    assert.equal(backend.configuraciones.length, 2);
    for (const configuracion of backend.configuraciones) {
        assert.equal(configuracion.syncFullHistory, false);
        assert.equal(
            configuracion.shouldSyncHistoryMessage({ syncType: TIPO_FULL }),
            false
        );
        assert.equal(
            configuracion.shouldSyncHistoryMessage({
                syncType: TIPO_ON_DEMAND
            }),
            false
        );
        assert.equal(
            configuracion.shouldSyncHistoryMessage({
                syncType: TIPO_RECIENTE
            }),
            true
        );
    }
    assert.deepEqual(
        backend.sockets.map(socket => socket.solicitudesHistorialCompleto),
        [0, 0]
    );
});

test('Agendamiento procesa RECENT con frases configuradas e ignora FULL', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-recent-keywords-')
    );
    const backend = cargarBackendAislado(
        rutaDatos,
        new Map([[ID_UNO, true]])
    );
    t.after(() => cerrarBackendAislado(backend, rutaDatos));

    backend.cargarLineasGuardadas();
    await backend.iniciarWhatsApp(ID_UNO);

    backend.sockets[0].ev.emit('messaging-history.set', {
        syncType: TIPO_RECIENTE,
        messages: [{
            key: {
                fromMe: true,
                remoteJid: '595981111111@s.whatsapp.net',
                id: 'RECENT-1'
            },
            messageTimestamp: 1700000000,
            message: {
                conversation: 'Alta correcta\nAlias: reciente_1\nClave: privada'
            }
        }],
        chats: [],
        contacts: [],
        lidPnMappings: []
    });
    backend.sockets[0].ev.emit('messaging-history.set', {
        syncType: TIPO_FULL,
        messages: [{
            key: {
                fromMe: true,
                remoteJid: '595982222222@s.whatsapp.net',
                id: 'FULL-1'
            },
            messageTimestamp: 1700000001,
            message: { conversation: 'Alias: no_importar_full' }
        }],
        chats: [],
        contacts: [],
        lidPnMappings: []
    });

    for (let intento = 0; intento < 8; intento += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }

    let vista = backend.servicioAgendamiento.obtenerVista({
        id: ID_UNO,
        nombre: 'Línea uno'
    });
    assert.deepEqual(vista.candidatos, []);

    backend.servicioAgendamiento.configurarPalabrasClaveUsuario(['Alias:']);
    const revision = await backend.reanalizarMensajesRecientesAgendamiento(
        backend.lineas.get(ID_UNO)
    );
    assert.equal(revision.disponibles, 1);

    vista = backend.servicioAgendamiento.obtenerVista({
        id: ID_UNO,
        nombre: 'Línea uno'
    });
    assert.deepEqual(
        vista.candidatos.map(item => item.usuario),
        ['reciente_1']
    );
    const persistido = fs.readFileSync(
        path.join(rutaDatos, 'agendamiento', 'datos.json'),
        'utf8'
    );
    assert.equal(persistido.includes('privada'), false);
    assert.equal(persistido.includes('no_importar_full'), false);
});

test('el selector une hosted LID y PN antes de crear contexto para Qwen', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-ai-hosted-lid-')
    );
    const backend = cargarBackendAislado(rutaDatos);
    t.after(() => cerrarBackendAislado(backend, rutaDatos));
    const pn = '595981230099@s.whatsapp.net';
    const lid = '1230099@hosted.lid';
    const linea = {
        mapeosActividadContactos: new Map([[lid, pn]]),
        marcaAnalisisIA: null
    };

    const lote = backend.seleccionarMensajesContextualesIA([
        mensajeSaliente(lid, 'rositaflor77', 1700000000, 'lid-usuario'),
        mensajeSaliente(pn, 'todo listo', 1700000001, 'pn-confirmacion')
    ], ['todo listo'], linea);

    assert.equal(lote.mensajes.length, 2);
    assert.deepEqual(
        [...new Set(lote.mensajes.map(item => item.key.remoteJid))],
        [pn]
    );
});

test('el selector entrega todos los mensajes salientes aunque no tengan referencias', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-ai-sin-prefiltro-')
    );
    const backend = cargarBackendAislado(rutaDatos);
    t.after(() => cerrarBackendAislado(backend, rutaDatos));
    const jid = '595981230100@s.whatsapp.net';
    const mensajes = Array.from({ length: 10 }, (_, indice) =>
        mensajeSaliente(
            jid,
            `conversación libre número ${indice}`,
            1700001000 + indice,
            `libre-${indice}`
        )
    );
    const entrante = {
        ...mensajeSaliente(
            jid,
            'este mensaje recibido no debe analizarse',
            1700001011,
            'recibido'
        ),
        key: {
            fromMe: false,
            remoteJid: jid,
            id: 'recibido'
        }
    };
    const sinIdA = mensajeSaliente(
        jid,
        'primer mensaje sin identificador',
        1700001010,
        undefined
    );
    const sinIdB = mensajeSaliente(
        jid,
        'segundo mensaje sin identificador',
        1700001010,
        undefined
    );

    const lote = backend.seleccionarMensajesContextualesIA(
        [...mensajes, sinIdA, sinIdB, entrante],
        ['Usuario:'],
        {
            mapeosActividadContactos: new Map(),
            marcaAnalisisIA: null
        }
    );

    assert.equal(lote.mensajes.length, 12);
    assert.equal(lote.mensajesDisponibles, 12);
    assert.equal(lote.marcasLote.length, 2);
    assert.deepEqual(
        lote.mensajes.filter(item => item.key.id).map(item => item.key.id),
        mensajes.map(item => item.key.id)
    );
});

test('la marca estable continúa la tanda aunque entren chats más nuevos', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-ai-cursor-estable-')
    );
    const backend = cargarBackendAislado(rutaDatos);
    t.after(() => cerrarBackendAislado(backend, rutaDatos));
    const linea = {
        mapeosActividadContactos: new Map(),
        marcaAnalisisIA: null
    };
    const anteriores = Array.from({ length: 100 }, (_, indice) => (
        mensajesChatIA(indice, 1700000000 + indice * 10)
    )).flat();
    const primera = backend.seleccionarMensajesContextualesIA(
        anteriores,
        ['Usuario:'],
        linea
    );
    assert.equal(primera.mensajes.length, 400);
    assert.equal(primera.mensajesPendientes, 100);
    assert.match(primera.marcaSiguiente, /^[a-f0-9]{64}$/u);

    linea.marcaAnalisisIA = primera.marcaSiguiente;
    const nuevos = Array.from({ length: 50 }, (_, desplazamiento) => {
        const indice = 100 + desplazamiento;
        return mensajesChatIA(indice, 1700000000 + indice * 10);
    }).flat();
    const segunda = backend.seleccionarMensajesContextualesIA(
        [...anteriores, ...nuevos],
        ['Usuario:'],
        linea
    );
    const ids = new Set(segunda.mensajes.map(item => item.key.id));

    assert.equal(segunda.mensajes.length, 400);
    assert.equal(ids.has('c10-3'), true, 'continúa después de la marca estable');
    assert.equal(ids.has('c50-3'), false, 'no vuelve al antiguo índice posicional');
});

test('una tanda en cuarentena no bloquea contextos nuevos', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-ai-cuarentena-')
    );
    const backend = cargarBackendAislado(rutaDatos);
    t.after(() => cerrarBackendAislado(backend, rutaDatos));
    const linea = {
        mapeosActividadContactos: new Map(),
        marcaAnalisisIA: null,
        cuarentenaAnalisisIA: []
    };
    const anterior = mensajesChatIA(1, 1700000000);
    const primera = backend.seleccionarMensajesContextualesIA(
        anterior,
        ['Usuario:'],
        linea
    );
    linea.cuarentenaAnalisisIA = primera.marcasLote.map(marca => ({
        marca,
        hasta: Date.now() + 30 * 60 * 1000
    }));

    const segunda = backend.seleccionarMensajesContextualesIA(
        [...anterior, ...mensajesChatIA(2, 1700000100)],
        ['Usuario:'],
        linea
    );
    const ids = new Set(segunda.mensajes.map(item => item.key.id));

    assert.equal(segunda.mensajesEnCuarentena, 5);
    assert.equal(segunda.mensajes.length, 5);
    assert.equal(ids.has('c1-3'), false);
    assert.equal(ids.has('c2-3'), true);
});

test('la marca y la cuarentena sobreviven timestamps en segundos o milisegundos', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-ai-timestamp-estable-')
    );
    const backend = cargarBackendAislado(rutaDatos);
    t.after(() => cerrarBackendAislado(backend, rutaDatos));
    const linea = {
        mapeosActividadContactos: new Map(),
        marcaAnalisisIA: null,
        cuarentenaAnalisisIA: []
    };
    const mensajesSegundos = mensajesChatIA(3, 1700000200);
    const primera = backend.seleccionarMensajesContextualesIA(
        mensajesSegundos,
        ['Usuario:'],
        linea
    );
    const mensajesMilisegundos = mensajesSegundos.map(mensaje => ({
        ...mensaje,
        messageTimestamp: Number(mensaje.messageTimestamp) * 1000
    }));
    const segunda = backend.seleccionarMensajesContextualesIA(
        mensajesMilisegundos,
        ['Usuario:'],
        linea
    );

    assert.deepEqual(segunda.marcasLote, primera.marcasLote);
    assert.equal(segunda.marcaSiguiente, primera.marcaSiguiente);

    linea.cuarentenaAnalisisIA = primera.marcasLote.map(marca => ({
        marca,
        hasta: Date.now() + 30 * 60 * 1000
    }));
    const tercera = backend.seleccionarMensajesContextualesIA(
        mensajesMilisegundos,
        ['Usuario:'],
        linea
    );

    assert.equal(tercera.mensajes.length, 0);
    assert.equal(tercera.mensajesEnCuarentena, 5);
});
