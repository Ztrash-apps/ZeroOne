const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const RAIZ_PROYECTO = path.resolve(__dirname, '..');
const ID_LINEA = '77777777-7777-4777-8777-777777777777';

function cargarBackendAislado(rutaDatos, opciones = {}) {
    for (const carpeta of ['sesiones', 'programados', 'uploads', 'historial']) {
        const ruta = path.join(rutaDatos, carpeta);
        fs.mkdirSync(ruta, { recursive: true });
        fs.writeFileSync(path.join(ruta, '.prueba-interna'), '', 'utf8');
    }

    const archivo = path.join(RAIZ_PROYECTO, 'src', 'bot.js');
    const original = fs.readFileSync(archivo, 'utf8');
    const corte = original.indexOf('\napp.listen(');
    assert.ok(corte > 0, 'No se encontró el inicio del servidor');

    const valorAnterior = process.env.AUTOSTATUES_DATA_DIR;
    const timeoutAudienciaAnterior =
        process.env.ZEROONE_AUDIENCE_SYNC_TIMEOUT_MS;
    const timeoutPrivacidadIqAnterior =
        process.env.ZEROONE_AUDIENCE_PRIVACY_IQ_TIMEOUT_MS;
    process.env.AUTOSTATUES_DATA_DIR = rutaDatos;
    if (opciones.audienceTimeoutMs !== undefined) {
        process.env.ZEROONE_AUDIENCE_SYNC_TIMEOUT_MS =
            String(opciones.audienceTimeoutMs);
    }
    if (opciones.privacyIqTimeoutMs !== undefined) {
        process.env.ZEROONE_AUDIENCE_PRIVACY_IQ_TIMEOUT_MS =
            String(opciones.privacyIqTimeoutMs);
    }

    try {
        const fuente = original.slice(0, corte) + `
            module.exports = {
                resincronizarAudienciaEstados,
                cancelarReintentoAudiencia,
                finalizarAudienciaConfirmadaLocalmente,
                obtenerEstadoPublicoAudiencia,
                seleccionarMejorAudiencia,
                registrarVisualizacionesEstadosActivos,
                obtenerVistaEstadosActivos,
                estadosActivos,
                lineas,
                servicioAgendamiento,
                runtimeIALocal
            };
        `;
        const modulo = new Module(archivo, module);
        modulo.filename = archivo;
        modulo.paths = Module._nodeModulePaths(path.dirname(archivo));
        modulo._compile(fuente, archivo);
        return modulo.exports;
    } finally {
        if (valorAnterior === undefined) {
            delete process.env.AUTOSTATUES_DATA_DIR;
        } else {
            process.env.AUTOSTATUES_DATA_DIR = valorAnterior;
        }
        if (timeoutAudienciaAnterior === undefined) {
            delete process.env.ZEROONE_AUDIENCE_SYNC_TIMEOUT_MS;
        } else {
            process.env.ZEROONE_AUDIENCE_SYNC_TIMEOUT_MS =
                timeoutAudienciaAnterior;
        }
        if (timeoutPrivacidadIqAnterior === undefined) {
            delete process.env.ZEROONE_AUDIENCE_PRIVACY_IQ_TIMEOUT_MS;
        } else {
            process.env.ZEROONE_AUDIENCE_PRIVACY_IQ_TIMEOUT_MS =
                timeoutPrivacidadIqAnterior;
        }
    }
}

function crearErrorCdn() {
    const error = new Error(
        'Failed to fetch stream from https://mmg.whatsapp.net/referencia.enc'
    );
    error.output = { statusCode: 403 };
    return error;
}

function crearLinea(socket) {
    return {
        id: ID_LINEA,
        nombre: 'L47',
        ordenConexion: 1,
        etiqueta: 'activa',
        estado: 'conectado',
        socket,
        jid: '595981000000@s.whatsapp.net',
        eliminando: false,
        modoHistorialAgendamiento: false,
        audienciaEstadosCargada: true,
        contactosEstado: new Set(),
        privacidadEstados: null,
        audienciaResincronizada: false,
        resincronizandoAudiencia: false,
        intentosResincronizacionAudiencia: 0,
        temporizadorAudiencia: null,
        promesaContactosEstado: Promise.resolve(),
        actividadContactosCargada: true,
        ultimaInteraccionContactos: new Map(),
        mapeosActividadContactos: new Map(),
        promesaActividadContactos: Promise.resolve(),
        revisionPriorizacionAudiencia: 0,
        cacheResumenPriorizacionAudiencia: null
    };
}

test('elige la audiencia mayor y WhatsApp gana los empates', () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-audience-source-')
    );
    let backend = null;
    try {
        backend = cargarBackendAislado(rutaDatos);
        const linea = crearLinea({});
        linea.contactosEstadoWhatsApp = new Set([
            '595981000001@s.whatsapp.net',
            '595981000002@s.whatsapp.net'
        ]);
        linea.contactosEstadoGoogle = new Set([
            '595981000003@s.whatsapp.net',
            '595981000004@s.whatsapp.net',
            '595981000005@s.whatsapp.net'
        ]);

        let seleccion = backend.seleccionarMejorAudiencia(linea);
        assert.equal(seleccion.origen, 'google');
        assert.equal(seleccion.total, 3);
        assert.equal(linea.origenAudiencia, 'google');

        linea.contactosEstadoWhatsApp.add(
            '595981000006@s.whatsapp.net'
        );
        seleccion = backend.seleccionarMejorAudiencia(linea);
        assert.equal(seleccion.origen, 'whatsapp');
        assert.equal(seleccion.total, 3);
        assert.equal(linea.origenAudiencia, 'whatsapp');
    } finally {
        backend?.runtimeIALocal?.cerrar?.();
        backend?.servicioAgendamiento?.cerrar?.();
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('cuenta una sola visualización por persona y estado', () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-status-views-')
    );
    let backend = null;

    try {
        backend = cargarBackendAislado(rutaDatos);
        const socket = {};
        const linea = crearLinea(socket);
        const ahora = Date.now();
        backend.lineas.set(linea.id, linea);
        backend.estadosActivos.set('publicacion-1', {
            id: 'publicacion-1',
            fechaInicio: new Date(ahora).toISOString(),
            expiraEn: new Date(ahora + 3600000).toISOString(),
            texto: 'Estado de prueba',
            lineas: [{
                lineaId: linea.id,
                nombre: linea.nombre,
                numero: '595981000000',
                clave: {
                    id: 'estado-1',
                    remoteJid: 'status@broadcast',
                    fromMe: true
                },
                meta: {
                    id: 'estado-1',
                    remoteJid: 'status@broadcast',
                    statusJidList: []
                },
                publicadoEn: new Date(ahora).toISOString(),
                expiraEn: new Date(ahora + 3600000).toISOString(),
                visualizadores: [],
                estado: 'activo',
                error: null,
                eliminadoEn: null,
                claveRevocacion: null,
                revocacionConAudiencia: false
            }]
        });

        const vista = {
            key: {
                id: 'estado-1',
                remoteJid: 'status@broadcast'
            },
            receipt: {
                readTimestamp: 123,
                userJid: '595982222222@s.whatsapp.net'
            }
        };

        assert.equal(
            backend.registrarVisualizacionesEstadosActivos(
                linea,
                socket,
                [vista, vista]
            ),
            1
        );
        assert.equal(
            backend.registrarVisualizacionesEstadosActivos(
                linea,
                socket,
                [vista]
            ),
            0
        );

        const estado = backend.obtenerVistaEstadosActivos();
        assert.equal(estado.resumen.visualizacionesTotales, 1);
        assert.equal(estado.publicaciones[0].visualizaciones, 1);
        assert.equal(estado.publicaciones[0].lineas[0].visualizaciones, 1);
        assert.match(
            backend.estadosActivos.get('publicacion-1')
                .lineas[0].visualizadores[0],
            /^[a-f0-9]{64}$/u
        );
    } finally {
        backend?.servicioAgendamiento?.cerrar();
        backend?.runtimeIALocal?.detener();
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

function crearDiferida() {
    let resolver;
    const promesa = new Promise(resolve => {
        resolver = resolve;
    });
    return { promesa, resolver };
}

test('la audiencia aísla colecciones y conserva una recuperación parcial', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-audience-sync-')
    );

    let backend = null;

    try {
        backend = cargarBackendAislado(rutaDatos);
        const llamadas = [];
        const socket = {
            ev: { isBuffering: () => false },
            resyncAppState: async colecciones => {
                llamadas.push([...colecciones]);
                if (colecciones[0] === 'critical_unblock_low') {
                    throw crearErrorCdn();
                }
            },
            fetchPrivacySettings: async () => ({ status: 'contacts' })
        };
        const linea = crearLinea(socket);
        backend.lineas.set(linea.id, linea);

        await backend.resincronizarAudienciaEstados(linea, socket);

        assert.deepEqual(llamadas, [
            ['critical_unblock_low']
        ]);
        assert.equal(linea.privacidadEstados.modo, 2);
        assert.equal(linea.audienciaResincronizada, false);
        assert.match(linea.ultimoErrorAudiencia, /contactos/u);
        assert.ok(linea.temporizadorAudiencia);

        backend.cancelarReintentoAudiencia(linea);
    } finally {
        backend?.servicioAgendamiento?.cerrar();
        backend?.runtimeIALocal?.detener();
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('el IQ valida primero Mis contactos y evita regular_high', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-audience-iq-')
    );

    let backend = null;

    try {
        backend = cargarBackendAislado(rutaDatos);
        const contacto = '595981234567@s.whatsapp.net';
        const orden = [];
        const llamadas = [];
        let linea;
        const socket = {
            ev: { isBuffering: () => false },
            resyncAppState: async colecciones => {
                llamadas.push([...colecciones]);
                orden.push(`appstate:${colecciones[0]}`);
                if (colecciones[0] === 'critical_unblock_low') {
                    linea.contactosEstado.add(contacto);
                    return;
                }
                throw crearErrorCdn();
            },
            fetchPrivacySettings: async () => {
                orden.push('iq');
                return { status: 'contacts' };
            }
        };
        linea = crearLinea(socket);
        linea.privacidadEstados = {
            modo: 2,
            usuarios: [],
            usuariosInvalidos: 0
        };
        backend.lineas.set(linea.id, linea);

        await backend.resincronizarAudienciaEstados(linea, socket);

        assert.deepEqual(llamadas, [
            ['critical_unblock_low']
        ]);
        assert.equal(linea.contactosEstado.has(contacto), true);
        assert.equal(linea.privacidadEstados.modo, 2);
        assert.deepEqual(orden, [
            'iq',
            'appstate:critical_unblock_low'
        ]);
        assert.equal(linea.audienciaResincronizada, true);
        assert.equal(linea.intentosResincronizacionAudiencia, 0);
        assert.equal(linea.temporizadorAudiencia, null);
    } finally {
        backend?.servicioAgendamiento?.cerrar();
        backend?.runtimeIALocal?.detener();
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('conserva contactos confirmados mientras reintenta sólo la privacidad', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-audience-partial-')
    );
    let backend = null;

    try {
        backend = cargarBackendAislado(rutaDatos);
        const contacto = '595981111111@s.whatsapp.net';
        const llamadas = [];
        let intentoPrivacidad = 0;
        let linea;
        const socket = {
            ev: { isBuffering: () => false },
            resyncAppState: async colecciones => {
                const coleccion = colecciones[0];
                llamadas.push(coleccion);

                if (coleccion === 'critical_unblock_low') {
                    linea.contactosEstado.add(contacto);
                    return;
                }

                intentoPrivacidad += 1;
                if (intentoPrivacidad === 1) throw crearErrorCdn();
                linea.privacidadEstados = {
                    modo: 2,
                    usuarios: [],
                    usuariosInvalidos: 0
                };
                linea.privacidadAudienciaConfirmada = true;
            },
            fetchPrivacySettings: async () => ({
                status: 'contact_blacklist'
            })
        };
        linea = crearLinea(socket);
        backend.lineas.set(linea.id, linea);

        await backend.resincronizarAudienciaEstados(linea, socket);
        assert.equal(linea.contactosAudienciaConfirmados, true);
        assert.equal(linea.audienciaResincronizada, false);

        backend.cancelarReintentoAudiencia(linea);
        linea.noReintentarAudienciaAntes = 0;
        await backend.resincronizarAudienciaEstados(linea, socket);

        assert.deepEqual(llamadas, [
            'critical_unblock_low',
            'regular_high',
            'regular_high'
        ]);
        assert.equal(linea.audienciaResincronizada, true);
    } finally {
        backend?.servicioAgendamiento?.cerrar();
        backend?.runtimeIALocal?.detener();
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('una respuesta sin contactos nunca marca una audiencia vacía como lista', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-audience-empty-')
    );
    let backend = null;

    try {
        backend = cargarBackendAislado(rutaDatos);
        const socket = {
            ev: { isBuffering: () => false },
            resyncAppState: async () => {},
            fetchPrivacySettings: async () => ({ status: 'contacts' })
        };
        const linea = crearLinea(socket);
        backend.lineas.set(linea.id, linea);

        await backend.resincronizarAudienciaEstados(linea, socket);

        assert.equal(linea.contactosEstado.size, 0);
        assert.equal(linea.contactosAudienciaConfirmados, false);
        assert.equal(linea.audienciaResincronizada, false);
        assert.match(linea.ultimoErrorAudiencia, /contactos/u);

        backend.cancelarReintentoAudiencia(linea);
    } finally {
        backend?.servicioAgendamiento?.cerrar();
        backend?.runtimeIALocal?.detener();
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('un evento tardío completa la audiencia aunque el ciclo agotó sus intentos', () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-audience-late-')
    );
    let backend = null;

    try {
        backend = cargarBackendAislado(rutaDatos);
        const socket = {};
        const linea = crearLinea(socket);
        linea.contactosEstado.add('595982222222@s.whatsapp.net');
        linea.privacidadEstados = {
            modo: 2,
            usuarios: [],
            usuariosInvalidos: 0
        };
        linea.contactosAudienciaConfirmados = true;
        linea.privacidadAudienciaConfirmada = true;
        linea.intentosResincronizacionAudiencia = 4;
        linea.noReintentarAudienciaAntes = Date.now() + 60000;
        linea.temporizadorAudiencia = setTimeout(() => {}, 60000);
        backend.lineas.set(linea.id, linea);

        assert.equal(
            backend.finalizarAudienciaConfirmadaLocalmente(linea, socket),
            true
        );
        assert.equal(linea.audienciaResincronizada, true);
        assert.equal(linea.intentosResincronizacionAudiencia, 0);
        assert.equal(linea.noReintentarAudienciaAntes, 0);
        assert.equal(linea.temporizadorAudiencia, null);
    } finally {
        backend?.servicioAgendamiento?.cerrar();
        backend?.runtimeIALocal?.detener();
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('un socket anterior no confirma ni libera el trabajo del socket nuevo', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-audience-race-')
    );
    let backend = null;

    try {
        backend = cargarBackendAislado(rutaDatos);
        const bloqueoViejo = crearDiferida();
        const bloqueoNuevo = crearDiferida();
        const inicioViejo = crearDiferida();
        const inicioNuevo = crearDiferida();
        let linea;
        const socketViejo = {
            ev: { isBuffering: () => false },
            resyncAppState: async colecciones => {
                if (colecciones[0] === 'critical_unblock_low') {
                    inicioViejo.resolver();
                    await bloqueoViejo.promesa;
                }
            },
            fetchPrivacySettings: async () => ({ status: 'contacts' })
        };
        const socketNuevo = {
            ev: { isBuffering: () => false },
            resyncAppState: async colecciones => {
                if (colecciones[0] === 'critical_unblock_low') {
                    inicioNuevo.resolver();
                    await bloqueoNuevo.promesa;
                    return;
                }
                linea.privacidadEstados = {
                    modo: 2,
                    usuarios: [],
                    usuariosInvalidos: 0
                };
            },
            fetchPrivacySettings: async () => ({ status: 'contacts' })
        };
        linea = crearLinea(socketViejo);
        backend.lineas.set(linea.id, linea);

        const trabajoViejo = backend.resincronizarAudienciaEstados(
            linea,
            socketViejo
        );
        await inicioViejo.promesa;

        // Simula connection.open del socket nuevo mientras el anterior sigue
        // terminando su descarga.
        linea.socket = socketNuevo;
        linea.controlSincronizacionAudiencia = null;
        linea.resincronizandoAudiencia = false;
        linea.socketValidacionAudiencia = socketNuevo;
        linea.contactosAudienciaConfirmados = false;
        linea.privacidadAudienciaConfirmada = false;

        const trabajoNuevo = backend.resincronizarAudienciaEstados(
            linea,
            socketNuevo
        );
        await inicioNuevo.promesa;
        linea.contactosEstado.add('595983333333@s.whatsapp.net');

        bloqueoViejo.resolver();
        await trabajoViejo;

        assert.equal(linea.contactosAudienciaConfirmados, false);
        assert.equal(linea.resincronizandoAudiencia, true);
        assert.ok(linea.controlSincronizacionAudiencia);

        bloqueoNuevo.resolver();
        await trabajoNuevo;

        assert.equal(linea.contactosAudienciaConfirmados, true);
        assert.equal(linea.audienciaResincronizada, true);
        assert.equal(linea.resincronizandoAudiencia, false);
    } finally {
        backend?.servicioAgendamiento?.cerrar();
        backend?.runtimeIALocal?.detener();
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('una operación de Baileys colgada libera la sincronización por timeout', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-audience-timeout-')
    );
    let backend = null;

    try {
        backend = cargarBackendAislado(rutaDatos, {
            audienceTimeoutMs: 30
        });
        const nuncaTermina = new Promise(() => {});
        const socket = {
            ev: { isBuffering: () => false },
            resyncAppState: async colecciones => {
                if (colecciones[0] === 'critical_unblock_low') {
                    return nuncaTermina;
                }
            },
            fetchPrivacySettings: async () => ({ status: 'contacts' })
        };
        const linea = crearLinea(socket);
        backend.lineas.set(linea.id, linea);
        const inicio = Date.now();

        await backend.resincronizarAudienciaEstados(linea, socket);

        assert.ok(
            Date.now() - inicio < 1000,
            'el ciclo debe terminar y liberar el turno'
        );
        assert.equal(linea.resincronizandoAudiencia, false);
        assert.equal(
            backend.obtenerEstadoPublicoAudiencia(linea),
            'esperando_reintento'
        );
        assert.match(linea.ultimoErrorAudiencia, /sincronizar/u);

        backend.cancelarReintentoAudiencia(linea);
        linea.intentosResincronizacionAudiencia = 4;
        assert.equal(
            backend.obtenerEstadoPublicoAudiencia(linea),
            'requiere_reintento'
        );
    } finally {
        backend?.servicioAgendamiento?.cerrar();
        backend?.runtimeIALocal?.detener();
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('un timeout no duplica la operación real de app-state', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-audience-dedupe-')
    );
    let backend = null;
    const bloqueo = crearDiferida();

    try {
        backend = cargarBackendAislado(rutaDatos, {
            audienceTimeoutMs: 30
        });
        let llamadasContactos = 0;
        const socket = {
            ev: { isBuffering: () => false },
            resyncAppState: async colecciones => {
                if (colecciones[0] !== 'critical_unblock_low') return;
                llamadasContactos += 1;
                await bloqueo.promesa;
            },
            fetchPrivacySettings: async () => ({ status: 'contacts' })
        };
        const linea = crearLinea(socket);
        backend.lineas.set(linea.id, linea);

        await backend.resincronizarAudienciaEstados(linea, socket);
        assert.equal(llamadasContactos, 1);
        backend.cancelarReintentoAudiencia(linea);
        linea.noReintentarAudienciaAntes = 0;

        await backend.resincronizarAudienciaEstados(linea, socket);
        assert.equal(
            llamadasContactos,
            1,
            'el segundo ciclo debe esperar la misma promesa en curso'
        );
        backend.cancelarReintentoAudiencia(linea);
    } finally {
        bloqueo.resolver();
        await new Promise(resolve => setImmediate(resolve));
        backend?.servicioAgendamiento?.cerrar();
        backend?.runtimeIALocal?.detener();
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('una consulta IQ colgada no impide sincronizar contactos y privacidad', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-audience-iq-timeout-')
    );
    let backend = null;

    try {
        backend = cargarBackendAislado(rutaDatos, {
            audienceTimeoutMs: 400,
            privacyIqTimeoutMs: 30
        });
        const nuncaTermina = new Promise(() => {});
        const llamadas = [];
        let linea;
        const socket = {
            ev: { isBuffering: () => false },
            fetchPrivacySettings: async () => nuncaTermina,
            resyncAppState: async colecciones => {
                const coleccion = colecciones[0];
                llamadas.push(coleccion);
                if (coleccion === 'critical_unblock_low') {
                    linea.contactosEstado.add(
                        '595986666666@s.whatsapp.net'
                    );
                } else if (coleccion === 'regular_high') {
                    linea.privacidadEstados = {
                        modo: 2,
                        usuarios: [],
                        usuariosInvalidos: 0
                    };
                    linea.privacidadAudienciaConfirmada = true;
                }
            }
        };
        linea = crearLinea(socket);
        backend.lineas.set(linea.id, linea);
        const inicio = Date.now();

        await backend.resincronizarAudienciaEstados(linea, socket);

        assert.ok(
            Date.now() - inicio < 350,
            'el IQ tiene un límite breve propio'
        );
        assert.deepEqual(llamadas, [
            'critical_unblock_low',
            'regular_high'
        ]);
        assert.equal(linea.audienciaResincronizada, true);
    } finally {
        backend?.servicioAgendamiento?.cerrar();
        backend?.runtimeIALocal?.detener();
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('Google completa la audiencia si la libreta de WhatsApp queda colgada', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-audience-google-fallback-')
    );
    let backend = null;

    try {
        backend = cargarBackendAislado(rutaDatos, {
            audienceTimeoutMs: 400,
            privacyIqTimeoutMs: 30
        });
        const nuncaTermina = new Promise(() => {});
        const socket = {
            ev: { isBuffering: () => false },
            fetchPrivacySettings: async () => ({ status: 'contacts' }),
            resyncAppState: async colecciones => {
                if (colecciones[0] === 'critical_unblock_low') {
                    return nuncaTermina;
                }
            }
        };
        const linea = crearLinea(socket);
        backend.lineas.set(linea.id, linea);
        backend.servicioAgendamiento.obtenerVista = () => ({
            cuentaId: 'cuenta-prueba'
        });
        backend.servicioAgendamiento.obtenerTokenAcceso =
            async () => 'token-prueba';
        backend.servicioAgendamiento.listarConexionesGoogle = async () => [{
            resourceName: 'people/contacto-prueba',
            phoneNumbers: [{
                canonicalForm: '+595989999999'
            }]
        }];
        const inicio = Date.now();

        await backend.resincronizarAudienciaEstados(linea, socket);

        assert.ok(
            Date.now() - inicio < 350,
            'WhatsApp no debe consumir todo el ciclo y bloquear Google'
        );
        assert.equal(linea.origenAudiencia, 'google');
        assert.equal(linea.contactosEstadoGoogle.size, 1);
        assert.equal(linea.audienciaResincronizada, true);
    } finally {
        backend?.servicioAgendamiento?.cerrar();
        backend?.runtimeIALocal?.detener();
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('la espera en cola no consume el minuto asignado a cada línea', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-audience-queue-budget-')
    );
    let backend = null;
    const nuncaTermina = new Promise(() => {});
    let lineasPrueba = [];

    try {
        backend = cargarBackendAislado(rutaDatos, {
            audienceTimeoutMs: 200,
            privacyIqTimeoutMs: 30
        });
        const llamadas = [];
        lineasPrueba = Array.from({ length: 4 }, (_valor, indice) => {
            let linea;
            const socket = {
                ev: { isBuffering: () => false },
                fetchPrivacySettings: async () => ({ status: 'contacts' }),
                resyncAppState: async colecciones => {
                    if (colecciones[0] !== 'critical_unblock_low') return;
                    llamadas.push(indice);
                    if (indice < 3) return nuncaTermina;
                    linea.contactosEstado.add(
                        `59598777777${indice}@s.whatsapp.net`
                    );
                }
            };
            linea = crearLinea(socket);
            linea.id =
                `77777777-7777-4777-8777-77777777777${indice}`;
            linea.nombre = `L${indice + 1}`;
            backend.lineas.set(linea.id, linea);
            return linea;
        });

        const trabajos = lineasPrueba.map(linea =>
            backend.resincronizarAudienciaEstados(linea, linea.socket)
        );
        await trabajos[3];

        assert.deepEqual(
            llamadas,
            [0, 1, 2, 3],
            'la cuarta línea debe iniciar al recibir su turno'
        );
        assert.equal(lineasPrueba[3].audienciaResincronizada, true);

        await Promise.all(trabajos);
        for (const linea of lineasPrueba) {
            backend.cancelarReintentoAudiencia(linea);
        }
    } finally {
        for (const linea of lineasPrueba) {
            backend?.cancelarReintentoAudiencia(linea);
        }
        backend?.servicioAgendamiento?.cerrar();
        backend?.runtimeIALocal?.detener();
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('el modo all valida la audiencia sin pedir una lista personalizada', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-audience-non-custom-mode-')
    );
    let backend = null;

    try {
        backend = cargarBackendAislado(rutaDatos);
        let linea;
        const colecciones = [];
        const socket = {
            ev: { isBuffering: () => false },
            fetchPrivacySettings: async () => ({ status: 'all' }),
            resyncAppState: async solicitadas => {
                colecciones.push(solicitadas[0]);
                if (solicitadas[0] === 'critical_unblock_low') {
                    linea.contactosEstado.add(
                        '595988888888@s.whatsapp.net'
                    );
                    return;
                }
                throw crearErrorCdn();
            }
        };
        linea = crearLinea(socket);
        backend.lineas.set(linea.id, linea);

        await backend.resincronizarAudienciaEstados(linea, socket);

        assert.equal(linea.fallosPrivacidadPersonalizada, 0);
        assert.equal(linea.audienciaResincronizada, true);
        assert.equal(linea.privacidadEstados.modo, 2);
        assert.equal(
            backend.obtenerEstadoPublicoAudiencia(linea),
            'lista'
        );
        assert.deepEqual(colecciones, ['critical_unblock_low']);
    } finally {
        backend?.servicioAgendamiento?.cerrar();
        backend?.runtimeIALocal?.detener();
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('una privacidad custom no acepta una regla cacheada sin evento nuevo', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-audience-custom-stale-cache-')
    );
    let backend = null;

    try {
        backend = cargarBackendAislado(rutaDatos);
        let linea;
        const socket = {
            ev: { isBuffering: () => false },
            fetchPrivacySettings: async () => ({
                status: 'contact_blacklist'
            }),
            resyncAppState: async colecciones => {
                if (colecciones[0] === 'critical_unblock_low') {
                    linea.contactosEstado.add(
                        '595980000010@s.whatsapp.net'
                    );
                }
                // regular_high termina, pero no emitió settings.update.
            }
        };
        linea = crearLinea(socket);
        linea.privacidadEstados = {
            modo: 2,
            usuarios: [],
            usuariosInvalidos: 0
        };
        backend.lineas.set(linea.id, linea);

        await backend.resincronizarAudienciaEstados(linea, socket);

        assert.equal(linea.privacidadAudienciaConfirmada, false);
        assert.equal(linea.audienciaResincronizada, false);
        assert.equal(linea.fallosPrivacidadPersonalizada, 1);
        assert.match(linea.ultimoErrorAudiencia, /sincronizar privacidad/u);
        backend.cancelarReintentoAudiencia(linea);
    } finally {
        backend?.servicioAgendamiento?.cerrar();
        backend?.runtimeIALocal?.detener();
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('un evento válido gana aunque regular_high termine con error', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-audience-custom-event-race-')
    );
    let backend = null;

    try {
        backend = cargarBackendAislado(rutaDatos);
        let linea;
        const socket = {
            ev: { isBuffering: () => false },
            fetchPrivacySettings: async () => ({
                status: 'contact_blacklist'
            }),
            resyncAppState: async colecciones => {
                if (colecciones[0] === 'critical_unblock_low') {
                    linea.contactosEstado.add(
                        '595980000020@s.whatsapp.net'
                    );
                    return;
                }
                linea.privacidadEstados = {
                    modo: 1,
                    usuarios: ['595980000021@s.whatsapp.net'],
                    usuariosInvalidos: 0
                };
                linea.privacidadAudienciaConfirmada = true;
                throw crearErrorCdn();
            }
        };
        linea = crearLinea(socket);
        backend.lineas.set(linea.id, linea);

        await backend.resincronizarAudienciaEstados(linea, socket);

        assert.equal(linea.privacidadAudienciaConfirmada, true);
        assert.equal(linea.audienciaResincronizada, true);
        assert.equal(linea.temporizadorAudiencia, null);
    } finally {
        backend?.servicioAgendamiento?.cerrar();
        backend?.runtimeIALocal?.detener();
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('una operación custom colgada cuenta una sola llamada real', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-audience-custom-dedupe-')
    );
    let backend = null;
    const bloqueo = crearDiferida();

    try {
        backend = cargarBackendAislado(rutaDatos, {
            audienceTimeoutMs: 200,
            privacyIqTimeoutMs: 30
        });
        let llamadasPrivacidad = 0;
        let linea;
        const socket = {
            ev: { isBuffering: () => false },
            fetchPrivacySettings: async () => ({
                status: 'contact_blacklist'
            }),
            resyncAppState: async colecciones => {
                if (colecciones[0] === 'critical_unblock_low') {
                    linea.contactosEstado.add(
                        '595980000001@s.whatsapp.net'
                    );
                    return;
                }
                llamadasPrivacidad += 1;
                await bloqueo.promesa;
            }
        };
        linea = crearLinea(socket);
        linea.privacidadEstados = {
            modo: 1,
            usuarios: ['595980000002@s.whatsapp.net'],
            usuariosInvalidos: 0
        };
        backend.lineas.set(linea.id, linea);

        await backend.resincronizarAudienciaEstados(linea, socket);
        assert.equal(linea.fallosPrivacidadPersonalizada, 1);
        backend.cancelarReintentoAudiencia(linea);
        linea.noReintentarAudienciaAntes = 0;

        await backend.resincronizarAudienciaEstados(linea, socket);

        assert.equal(llamadasPrivacidad, 1);
        assert.equal(linea.fallosPrivacidadPersonalizada, 1);
        assert.equal(
            backend.obtenerEstadoPublicoAudiencia(linea),
            'esperando_reintento'
        );
        backend.cancelarReintentoAudiencia(linea);
    } finally {
        bloqueo.resolver();
        await new Promise(resolve => setImmediate(resolve));
        backend?.servicioAgendamiento?.cerrar();
        backend?.runtimeIALocal?.detener();
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('una lista personalizada sin detalle termina bloqueada y accionable', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-audience-custom-terminal-')
    );
    let backend = null;

    try {
        backend = cargarBackendAislado(rutaDatos);
        const contacto = '595984444444@s.whatsapp.net';
        const excluido = '595985555555@s.whatsapp.net';
        const llamadas = [];
        let linea;
        const socket = {
            ev: { isBuffering: () => false },
            resyncAppState: async colecciones => {
                const coleccion = colecciones[0];
                llamadas.push(coleccion);
                if (coleccion === 'critical_unblock_low') {
                    linea.contactosEstado.add(contacto);
                    return;
                }
                throw crearErrorCdn();
            },
            fetchPrivacySettings: async () => ({
                status: 'contact_blacklist'
            })
        };
        linea = crearLinea(socket);
        linea.privacidadEstados = {
            modo: 1,
            usuarios: [excluido],
            usuariosInvalidos: 0
        };
        backend.lineas.set(linea.id, linea);

        await backend.resincronizarAudienciaEstados(linea, socket);
        assert.equal(linea.privacidadEstados.modo, 1);
        assert.deepEqual(linea.privacidadEstados.usuarios, [excluido]);
        assert.equal(linea.fallosPrivacidadPersonalizada, 1);
        assert.ok(linea.temporizadorAudiencia);

        backend.cancelarReintentoAudiencia(linea);
        linea.noReintentarAudienciaAntes = 0;
        await backend.resincronizarAudienciaEstados(linea, socket);

        assert.deepEqual(llamadas, [
            'critical_unblock_low',
            'regular_high',
            'regular_high'
        ]);
        assert.equal(linea.audienciaResincronizada, false);
        assert.equal(linea.fallosPrivacidadPersonalizada, 2);
        assert.equal(linea.temporizadorAudiencia, null);
        assert.equal(
            backend.obtenerEstadoPublicoAudiencia(linea),
            'requiere_reintento'
        );
        assert.match(linea.ultimoErrorAudiencia, /personalizada/u);
    } finally {
        backend?.servicioAgendamiento?.cerrar();
        backend?.runtimeIALocal?.detener();
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});
