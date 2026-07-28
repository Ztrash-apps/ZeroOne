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
    ]
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
    const archivo = path.join(RAIZ_PROYECTO, 'src', 'bot.js');
    const original = fs.readFileSync(archivo, 'utf8');
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
                    end: () => {}
                };
                configuraciones.push(configuracion);
                sockets.push(socket);
                return socket;
            },
            useMultiFileAuthState: async carpeta => ({
                state: {
                    creds: {
                        registered:
                            sesionesRegistradas.get(path.basename(carpeta)) ===
                            true
                    }
                },
                saveCreds: async () => {}
            })
        };
    };

    try {
        const fuente = original.slice(0, corte) + `
            module.exports = {
                cargarLineasGuardadas,
                colaIniciosWhatsApp,
                encolarInicioWhatsApp,
                iniciarWhatsApp,
                invalidarConexionActual,
                lineas,
                maximosIniciosWhatsAppSimultaneos:
                    MAXIMOS_INICIOS_WHATSAPP_SIMULTANEOS,
                reanalizarMensajesRecientesAgendamiento,
                seleccionarMensajesContextualesIA,
                servicioAgendamiento,
                turnosInicioWhatsAppActivos,
                cerrar: () => servicioAgendamiento.cerrar()
            };
        `;
        const modulo = new Module(archivo, module);
        modulo.filename = archivo;
        modulo.paths = Module._nodeModulePaths(path.dirname(archivo));
        modulo._compile(fuente, archivo);
        return {
            ...modulo.exports,
            configuraciones,
            sockets
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
