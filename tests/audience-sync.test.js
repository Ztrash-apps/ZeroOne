const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const RAIZ_PROYECTO = path.resolve(__dirname, '..');
const ID_LINEA = '77777777-7777-4777-8777-777777777777';

function cargarBackendAislado(rutaDatos) {
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
    process.env.AUTOSTATUES_DATA_DIR = rutaDatos;

    try {
        const fuente = original.slice(0, corte) + `
            module.exports = {
                resincronizarAudienciaEstados,
                cancelarReintentoAudiencia,
                finalizarAudienciaConfirmadaLocalmente,
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
            ['critical_unblock_low'],
            ['regular_high']
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

test('el IQ valida la privacidad guardada si falla regular_high', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-audience-iq-')
    );

    let backend = null;

    try {
        backend = cargarBackendAislado(rutaDatos);
        const contacto = '595981234567@s.whatsapp.net';
        const llamadas = [];
        let linea;
        const socket = {
            ev: { isBuffering: () => false },
            resyncAppState: async colecciones => {
                llamadas.push([...colecciones]);
                if (colecciones[0] === 'critical_unblock_low') {
                    linea.contactosEstado.add(contacto);
                    return;
                }
                throw crearErrorCdn();
            },
            fetchPrivacySettings: async () => ({ status: 'contacts' })
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
            ['critical_unblock_low'],
            ['regular_high']
        ]);
        assert.equal(linea.contactosEstado.has(contacto), true);
        assert.equal(linea.privacidadEstados.modo, 2);
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
