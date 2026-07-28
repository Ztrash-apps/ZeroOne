const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const RAIZ_PROYECTO = path.resolve(__dirname, '..');
const ID_LINEA = '22222222-2222-4222-8222-222222222222';
const ID_LINEA_SIGUIENTE = '33333333-3333-4333-8333-333333333333';

function cargarBackendAislado(
    rutaDatos,
    {
        tiempoMaximoEnvioMs = null,
        fixturesUi = false
    } = {}
) {
    for (const carpeta of ['sesiones', 'programados', 'uploads', 'historial']) {
        const ruta = path.join(rutaDatos, carpeta);
        fs.mkdirSync(ruta, { recursive: true });
        fs.writeFileSync(path.join(ruta, '.prueba-interna'), '', 'utf8');
    }

    const archivo = path.join(RAIZ_PROYECTO, 'src', 'bot.js');
    const original = fs.readFileSync(archivo, 'utf8');
    const corte = original.indexOf('\napp.listen(');
    assert.ok(corte > 0, 'No se encontró el inicio del servidor');

    const nombreVariable = 'AUTOSTATUES_DATA_DIR';
    const valorAnterior = process.env[nombreVariable];
    const nombreVariableTimeout = 'ZEROONE_SEND_TIMEOUT_MS';
    const valorAnteriorTimeout = process.env[nombreVariableTimeout];
    const nombreVariableFixtures = 'ZEROONE_UI_FIXTURES';
    const valorAnteriorFixtures = process.env[nombreVariableFixtures];
    process.env[nombreVariable] = rutaDatos;
    if (tiempoMaximoEnvioMs !== null) {
        process.env[nombreVariableTimeout] = String(tiempoMaximoEnvioMs);
    }
    if (fixturesUi) {
        process.env[nombreVariableFixtures] = '1';
    } else {
        delete process.env[nombreVariableFixtures];
    }

    try {
        const fuente = original.slice(0, corte) + `
            module.exports = {
                app,
                ejecutarPublicacion,
                encolarPublicacion,
                iniciarSimulacroEnvioIncierto,
                solicitarAltoTotalPublicacion,
                resolverConfirmacionEnvioPendiente,
                registrarCorteDesconexion,
                clasificarErrorPublicacion,
                activarProteccionMiddlewarePorError,
                cargarConfiguracion,
                solicitarReconexionManual,
                solicitarEliminacionEstado,
                lineas,
                estadosActivos,
                historialPublicaciones,
                obtenerProgreso: () => progresoPublicacion,
                obtenerProteccionMiddleware: obtenerVistaProteccionMiddleware,
                establecerCola: valor => { colaPublicaciones = valor; },
                archivoEstadosActivos
            };
        `;
        const modulo = new Module(archivo, module);
        modulo.filename = archivo;
        modulo.paths = Module._nodeModulePaths(path.dirname(archivo));
        modulo._compile(fuente, archivo);
        return modulo.exports;
    } finally {
        if (valorAnterior === undefined) {
            delete process.env[nombreVariable];
        } else {
            process.env[nombreVariable] = valorAnterior;
        }

        if (valorAnteriorTimeout === undefined) {
            delete process.env[nombreVariableTimeout];
        } else {
            process.env[nombreVariableTimeout] = valorAnteriorTimeout;
        }

        if (valorAnteriorFixtures === undefined) {
            delete process.env[nombreVariableFixtures];
        } else {
            process.env[nombreVariableFixtures] = valorAnteriorFixtures;
        }
    }
}

function crearLinea(
    sendMessage,
    {
        id = ID_LINEA,
        nombre = 'Línea de prueba de Alto total',
        jidPropio = '595999999999@s.whatsapp.net',
        contacto = '595111111111@s.whatsapp.net'
    } = {}
) {
    const socket = {
        user: {
            id: jidPropio,
            phoneNumber: jidPropio
        },
        sendMessage
    };

    return {
        id,
        nombre,
        ordenConexion: 1,
        etiqueta: 'activa',
        estado: 'conectado',
        jid: jidPropio,
        socket,
        eliminando: false,
        iniciando: false,
        reconexionManualEnCurso: false,
        conexionEnVerificacion: false,
        reconexionBloqueada: false,
        requiereRevisionEnvio: false,
        fallosRecientes: 0,
        audienciaEstadosCargada: true,
        audienciaResincronizada: true,
        contactosEstado: new Set([contacto]),
        privacidadEstados: {
            modo: 2,
            usuarios: [],
            usuariosInvalidos: 0
        },
        promesaContactosEstado: Promise.resolve(),
        actividadContactosCargada: true,
        ultimaInteraccionContactos: new Map([[contacto, Date.now()]]),
        mapeosActividadContactos: new Map(),
        actividadContactosSucia: false,
        temporizadorActividadContactos: null,
        promesaActividadContactos: Promise.resolve(),
        tareasActividadPendientes: 0,
        fechaUltimaInteraccionContactos: Date.now(),
        ultimaSeleccionAudienciaEstado: null,
        revisionPriorizacionAudiencia: 0,
        cacheResumenPriorizacionAudiencia: null
    };
}

async function esperarHasta(
    condicion,
    {
        timeoutMs = 1500,
        mensaje = 'La condición esperada no se cumplió a tiempo.'
    } = {}
) {
    const inicio = Date.now();
    let ultimoResultado = null;

    while (Date.now() - inicio < timeoutMs) {
        ultimoResultado = condicion();
        if (ultimoResultado) return ultimoResultado;
        await new Promise(resolve => setTimeout(resolve, 5));
    }

    assert.fail(mensaje);
}

async function abrirServidorPrueba(app) {
    const servidor = await new Promise((resolve, reject) => {
        const instancia = app.listen(0, '127.0.0.1', () => {
            resolve(instancia);
        });
        instancia.once('error', reject);
    });
    const direccion = servidor.address();

    return {
        servidor,
        baseUrl: `http://127.0.0.1:${direccion.port}`
    };
}

async function cerrarServidorPrueba(servidor) {
    await new Promise((resolve, reject) => {
        servidor.close(error => {
            if (error) reject(error);
            else resolve();
        });
    });
}

async function solicitarJson(baseUrl, ruta, opciones = {}) {
    const respuesta = await fetch(`${baseUrl}${ruta}`, {
        ...opciones,
        headers: {
            ...(opciones.body ? { 'content-type': 'application/json' } : {}),
            ...(opciones.headers || {})
        }
    });
    const cuerpo = await respuesta.json();
    return { respuesta, cuerpo };
}

function crearImagenPrueba(rutaDatos, nombre) {
    const rutaImagen = path.join(rutaDatos, nombre);
    fs.writeFileSync(
        rutaImagen,
        Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a,
            0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00
        ])
    );
    return rutaImagen;
}

function crearParametrosPublicacion(idsLineas, rutaImagen, texto) {
    return {
        idsLineas,
        rutaImagen,
        texto,
        modoRitmo: 'grupos',
        intervaloSegundos: 10,
        variacionSegundos: 0,
        lineasPorGrupo: idsLineas.length,
        intervaloMinutos: 0,
        maximoDestinatariosPorEstado: 1000,
        origen: 'prueba interna'
    };
}

test('un WA_500 de envío con el socket intacto no se confunde con una desconexión', () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-wa-500-envio-')
    );

    try {
        const backend = cargarBackendAislado(rutaDatos);
        const linea = crearLinea(async () => {});
        const socketUsado = linea.socket;
        const error = new Error('El servidor rechazó temporalmente el envío.');
        error.output = {
            statusCode: 500
        };

        const clasificacion = backend.clasificarErrorPublicacion(
            error,
            linea,
            socketUsado,
            'envio'
        );

        assert.equal(clasificacion.tipoError, 'envio');
        assert.equal(clasificacion.codigoError, 'WA_500');
        assert.equal(clasificacion.envioIncierto, false);
        assert.equal(clasificacion.reintentoSeguro, true);
    } finally {
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('un WA_500 con el socket cerrado sí se conserva como desconexión', () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-wa-500-desconexion-')
    );

    try {
        const backend = cargarBackendAislado(rutaDatos);
        const linea = crearLinea(async () => {});
        const socketUsado = linea.socket;
        linea.estado = 'desconectado';
        linea.socket = null;

        const error = new Error('WhatsApp cerró la sesión.');
        error.output = {
            statusCode: 500
        };

        const clasificacion = backend.clasificarErrorPublicacion(
            error,
            linea,
            socketUsado,
            'envio'
        );

        assert.equal(clasificacion.tipoError, 'desconexion');
        assert.equal(clasificacion.codigoError, 'WA_500');
        assert.equal(clasificacion.envioIncierto, true);
        assert.equal(clasificacion.reintentoSeguro, false);
    } finally {
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('el ajuste configura solo el enfriamiento preventivo de desconexión', () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-enfriamiento-preventivo-')
    );

    try {
        fs.writeFileSync(
            path.join(rutaDatos, 'configuracion.json'),
            JSON.stringify({ enfriamientoPreventivoMinutos: 2 }),
            'utf8'
        );
        const backend = cargarBackendAislado(rutaDatos);
        backend.cargarConfiguracion();
        const error = new Error('Desconexión preventiva simulada.');
        error.codigo = 'DETENIDA_DESCONEXION';
        error.preflight = false;

        const proteccion =
            backend.activarProteccionMiddlewarePorError(error);

        assert.equal(proteccion.tipo, 'desconexion');
        assert.ok(proteccion.segundosRestantes >= 118);
        assert.ok(proteccion.segundosRestantes <= 120);
    } finally {
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('el envío incierto conserva sus 10 minutos de protección propia', () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-enfriamiento-incierto-')
    );

    try {
        fs.writeFileSync(
            path.join(rutaDatos, 'configuracion.json'),
            JSON.stringify({ enfriamientoPreventivoMinutos: 1 }),
            'utf8'
        );
        const backend = cargarBackendAislado(rutaDatos);
        backend.cargarConfiguracion();
        const error = new Error('Resultado del envío incierto.');
        error.codigo = 'DETENIDA_DESCONEXION';
        error.envioIncierto = true;

        const proteccion =
            backend.activarProteccionMiddlewarePorError(error);

        assert.equal(proteccion.tipo, 'envio_incierto');
        assert.ok(proteccion.segundosRestantes >= 598);
        assert.ok(proteccion.segundosRestantes <= 600);
    } finally {
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('un fallo de envío común ofrece omitir la línea y continuar con el resto', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-error-linea-continuar-')
    );
    let servidorPrueba = null;

    try {
        fs.writeFileSync(
            path.join(rutaDatos, 'configuracion.json'),
            JSON.stringify({ limiteFallosSeguridad: 1 }),
            'utf8'
        );
        const backend = cargarBackendAislado(rutaDatos);
        backend.cargarConfiguracion();
        let enviosPrimeraLinea = 0;
        let enviosSegundaLinea = 0;
        const primeraLinea = crearLinea(async () => {
            enviosPrimeraLinea += 1;
            const error = new Error('WhatsApp rechazó este envío sin cerrar el socket.');
            error.statusCode = 500;
            throw error;
        });
        primeraLinea.nombre = 'Línea con fallo recuperable';
        const segundaLinea = crearLinea(
            async () => {
                enviosSegundaLinea += 1;
                return {
                    key: {
                        remoteJid: 'status@broadcast',
                        fromMe: true,
                        id: 'ID-DESPUES-DE-ERROR-RECUPERABLE'
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000)
                };
            },
            {
                id: ID_LINEA_SIGUIENTE,
                nombre: 'Línea posterior al fallo recuperable',
                jidPropio: '595888888888@s.whatsapp.net',
                contacto: '595222222222@s.whatsapp.net'
            }
        );
        backend.lineas.set(primeraLinea.id, primeraLinea);
        backend.lineas.set(segundaLinea.id, segundaLinea);
        servidorPrueba = await abrirServidorPrueba(backend.app);

        const rutaImagen = crearImagenPrueba(
            rutaDatos,
            'error-linea-continuar.png'
        );
        const tarea = backend.ejecutarPublicacion(
            crearParametrosPublicacion(
                [primeraLinea.id, segundaLinea.id],
                rutaImagen,
                'Continuar después de un error recuperable'
            )
        );

        const decision = await esperarHasta(() => {
            const progreso = backend.obtenerProgreso();
            return progreso.estado === 'detenido_seguridad' &&
                progreso.decisionSeguridadPendiente?.tipo === 'error_linea'
                ? progreso.decisionSeguridadPendiente
                : null;
        }, {
            mensaje:
                'El error recuperable no ofreció omitir la línea y continuar.'
        });

        assert.equal(decision.lineaId, primeraLinea.id);
        assert.equal(decision.lineaNombre, primeraLinea.nombre);
        assert.equal(decision.codigo, 'WA_500');
        assert.equal(enviosPrimeraLinea, 1);
        assert.equal(enviosSegundaLinea, 0);

        const reanudacion = await solicitarJson(
            servidorPrueba.baseUrl,
            '/progreso/reanudar',
            { method: 'POST' }
        );
        assert.equal(reanudacion.respuesta.status, 200);
        assert.equal(
            reanudacion.cuerpo.mensaje,
            `Línea ${primeraLinea.nombre} omitida. ` +
                'La publicación continuará con el resto.'
        );

        const resultado = await tarea;
        assert.deepEqual(resultado, { correctas: 1, fallidas: 1 });
        assert.equal(enviosSegundaLinea, 1);
        assert.equal(
            backend.obtenerProgreso().estado,
            'completado_con_errores'
        );
        assert.equal(
            backend.obtenerProgreso().decisionSeguridadPendiente,
            null
        );
        const fallo = backend.obtenerProgreso().lineasFallidas.find(
            item => item.id === primeraLinea.id
        );
        assert.equal(fallo.tipoError, 'envio');
        assert.equal(fallo.codigoError, 'WA_500');
        assert.equal(fallo.envioIncierto, false);
        assert.equal(fallo.reintentoSeguro, true);
    } finally {
        if (servidorPrueba) {
            await cerrarServidorPrueba(servidorPrueba.servidor);
        }
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('Alto total cancela la cola y conserva el ID del envío en curso', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-alto-total-')
    );

    try {
        const backend = cargarBackendAislado(rutaDatos);
        let liberarCola;
        const bloqueoCola = new Promise(resolve => {
            liberarCola = resolve;
        });
        backend.establecerCola(bloqueoCola);
        const tareaEnCola = backend.encolarPublicacion({});
        const altoEnCola = backend.solicitarAltoTotalPublicacion();
        assert.equal(altoEnCola.activa, false);
        assert.equal(altoEnCola.pendientesCanceladas, 1);
        await assert.rejects(
            tareaEnCola,
            error => error?.codigo === 'CANCELADA_ALTO_TOTAL_EN_COLA'
        );
        liberarCola();
        await new Promise(resolve => setImmediate(resolve));

        let resolverEnvio;
        let avisarInicioEnvio;
        const envioIniciado = new Promise(resolve => {
            avisarInicioEnvio = resolve;
        });
        const promesaEnvio = new Promise(resolve => {
            resolverEnvio = resolve;
        });
        const linea = crearLinea(() => {
            avisarInicioEnvio();
            return promesaEnvio;
        });
        let enviosSegundaLinea = 0;
        const segundaLinea = crearLinea(
            () => {
                enviosSegundaLinea += 1;
                throw new Error('La segunda línea no debía comenzar.');
            },
            {
                id: ID_LINEA_SIGUIENTE,
                nombre: 'Línea que debe quedar sin iniciar',
                jidPropio: '595888888888@s.whatsapp.net',
                contacto: '595222222222@s.whatsapp.net'
            }
        );
        backend.lineas.set(linea.id, linea);
        backend.lineas.set(segundaLinea.id, segundaLinea);

        const rutaImagen = path.join(rutaDatos, 'imagen-prueba.png');
        fs.writeFileSync(
            rutaImagen,
            Buffer.from([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a,
                0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00
            ])
        );

        const tarea = backend.ejecutarPublicacion({
            idsLineas: [linea.id, segundaLinea.id],
            rutaImagen,
            texto: 'Prueba interna',
            modoRitmo: 'secuencial',
            intervaloSegundos: 45,
            variacionSegundos: 0,
            lineasPorGrupo: 1,
            intervaloMinutos: 0,
            maximoDestinatariosPorEstado: 1000,
            origen: 'prueba interna'
        });

        await envioIniciado;
        const alto = backend.solicitarAltoTotalPublicacion();
        assert.equal(alto.habiaTrabajo, true);
        assert.equal(alto.activa, true);
        assert.equal(backend.obtenerProgreso().envioEnCurso, true);

        const resultadoTemprano = await Promise.race([
            tarea.then(
                () => 'resuelta',
                () => 'rechazada'
            ),
            new Promise(resolve => setTimeout(() => resolve('pendiente'), 30))
        ]);
        assert.equal(resultadoTemprano, 'pendiente');

        const idEstado = 'ID-ESTADO-ALTO-TOTAL';
        resolverEnvio({
            key: {
                remoteJid: 'status@broadcast',
                fromMe: true,
                id: idEstado
            },
            messageTimestamp: Math.floor(Date.now() / 1000)
        });

        await assert.rejects(
            tarea,
            error => error?.codigo === 'DETENIDA_ALTO_TOTAL'
        );

        assert.equal(backend.obtenerProgreso().estado, 'detenido_alto_total');
        assert.equal(backend.obtenerProgreso().correctas, 1);
        assert.equal(backend.obtenerProgreso().noProcesadas, 1);
        assert.equal(enviosSegundaLinea, 0);
        const grupos = [...backend.estadosActivos.values()];
        assert.equal(grupos.length, 1);
        assert.equal(grupos[0].lineas.length, 1);
        assert.equal(grupos[0].lineas[0].clave.id, idEstado);
        assert.equal(grupos[0].lineas[0].meta.id, idEstado);

        const guardados = JSON.parse(
            fs.readFileSync(backend.archivoEstadosActivos, 'utf8')
        );
        assert.equal(guardados[0].lineas[0].clave.id, idEstado);
        assert.equal(guardados[0].lineas[0].meta.id, idEstado);

        let idSolicitadoParaEliminar = null;
        linea.socket.sendMessage = async (jid, contenido, opciones) => {
            assert.equal(jid, 'status@broadcast');
            idSolicitadoParaEliminar = contenido?.delete?.id || null;
            assert.equal(opciones.broadcast, true);
            assert.ok(opciones.statusJidList.includes(linea.jid));

            return {
                key: {
                    remoteJid: 'status@broadcast',
                    fromMe: true,
                    id: 'ID-SOLICITUD-ELIMINACION'
                }
            };
        };

        await backend.solicitarEliminacionEstado(
            grupos[0],
            grupos[0].lineas[0]
        );
        assert.equal(idSolicitadoParaEliminar, idEstado);
        assert.equal(grupos[0].lineas[0].estado, 'solicitud_enviada');
    } finally {
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('una desconexión simultánea conserva el ID y continúa con la siguiente línea', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-desconexion-resultado-')
    );

    try {
        const backend = cargarBackendAislado(rutaDatos);
        let resolverEnvio;
        let avisarInicioEnvio;
        const envioIniciado = new Promise(resolve => {
            avisarInicioEnvio = resolve;
        });
        const promesaEnvio = new Promise(resolve => {
            resolverEnvio = resolve;
        });
        const linea = crearLinea(() => {
            avisarInicioEnvio();
            return promesaEnvio;
        });
        let enviosSegundaLinea = 0;
        const segundaLinea = crearLinea(
            async () => {
                enviosSegundaLinea += 1;
                return {
                    key: {
                        remoteJid: 'status@broadcast',
                        fromMe: true,
                        id: 'ID-SEGUNDA-LINEA-DESPUES-DEL-CORTE'
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000)
                };
            },
            {
                id: ID_LINEA_SIGUIENTE,
                nombre: 'Línea posterior al corte',
                jidPropio: '595888888888@s.whatsapp.net',
                contacto: '595222222222@s.whatsapp.net'
            }
        );
        backend.lineas.set(linea.id, linea);
        backend.lineas.set(segundaLinea.id, segundaLinea);

        const rutaImagen = path.join(rutaDatos, 'imagen-desconexion.png');
        fs.writeFileSync(
            rutaImagen,
            Buffer.from([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a,
                0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00
            ])
        );

        const tarea = backend.ejecutarPublicacion({
            idsLineas: [linea.id, segundaLinea.id],
            rutaImagen,
            texto: 'Confirmación simultánea',
            modoRitmo: 'secuencial',
            intervaloSegundos: 10,
            variacionSegundos: 0,
            lineasPorGrupo: 1,
            intervaloMinutos: 0,
            maximoDestinatariosPorEstado: 1000,
            origen: 'prueba interna'
        });

        await envioIniciado;
        backend.registrarCorteDesconexion(
            linea,
            'La sesión se cerró mientras se esperaba el resultado.',
            401
        );

        const resultadoTemprano = await Promise.race([
            tarea.then(
                () => 'resuelta',
                () => 'rechazada'
            ),
            new Promise(resolve => setTimeout(() => resolve('pendiente'), 30))
        ]);
        assert.equal(resultadoTemprano, 'pendiente');

        const idEstado = 'ID-ESTADO-DEVUELTO-ANTES-DEL-CORTE';
        resolverEnvio({
            key: {
                remoteJid: 'status@broadcast',
                fromMe: true,
                id: idEstado
            },
            messageTimestamp: Math.floor(Date.now() / 1000)
        });

        const resultado = await tarea;
        assert.deepEqual(resultado, { correctas: 2, fallidas: 0 });
        assert.equal(backend.obtenerProgreso().estado, 'completado');
        assert.equal(backend.obtenerProgreso().correctas, 2);
        assert.equal(backend.obtenerProgreso().codigoErrorCorte, null);
        assert.equal(
            backend.obtenerProgreso().decisionSeguridadPendiente,
            null
        );
        assert.equal(enviosSegundaLinea, 1);
        const grupos = [...backend.estadosActivos.values()];
        assert.equal(grupos.length, 1);
        assert.equal(grupos[0].lineas[0].clave.id, idEstado);
        assert.equal(
            grupos[0].lineas[1].clave.id,
            'ID-SEGUNDA-LINEA-DESPUES-DEL-CORTE'
        );
    } finally {
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('una línea en reconexión espera y publica al recuperar el socket', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-recuperacion-linea-')
    );

    try {
        const backend = cargarBackendAislado(rutaDatos);
        let cantidadEnvios = 0;
        const idEstado = 'ID-ESTADO-DESPUES-DE-RECUPERAR';
        const linea = crearLinea(async () => {
            cantidadEnvios += 1;
            return {
                key: {
                    remoteJid: 'status@broadcast',
                    fromMe: true,
                    id: idEstado
                },
                messageTimestamp: Math.floor(Date.now() / 1000)
            };
        });
        const socketRecuperado = linea.socket;
        linea.socket = null;
        linea.jid = null;
        linea.estado = 'reconectando';
        linea.etiqueta = 'caida';
        linea.iniciando = true;
        backend.lineas.set(linea.id, linea);

        const rutaImagen = path.join(rutaDatos, 'imagen-recuperacion.png');
        fs.writeFileSync(
            rutaImagen,
            Buffer.from([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a,
                0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00
            ])
        );

        const tarea = backend.ejecutarPublicacion({
            idsLineas: [linea.id],
            rutaImagen,
            texto: 'Publicación tras recuperar',
            modoRitmo: 'secuencial',
            intervaloSegundos: 10,
            variacionSegundos: 0,
            lineasPorGrupo: 1,
            intervaloMinutos: 0,
            maximoDestinatariosPorEstado: 1000,
            origen: 'prueba interna'
        });

        await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(cantidadEnvios, 0);
        assert.equal(backend.obtenerProgreso().estado, 'esperando_reconexion');

        linea.socket = socketRecuperado;
        linea.jid = socketRecuperado.user.id;
        linea.estado = 'conectado';
        linea.etiqueta = 'activa';
        linea.iniciando = false;
        linea.conexionEnVerificacion = false;

        const resultado = await tarea;
        assert.deepEqual(resultado, { correctas: 1, fallidas: 0 });
        assert.equal(cantidadEnvios, 1);
        assert.equal(backend.obtenerProgreso().estado, 'completado');
        const grupos = [...backend.estadosActivos.values()];
        assert.equal(grupos[0].lineas[0].clave.id, idEstado);
    } finally {
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('una línea futura en reconexión no bloquea la línea actual y se procesa al recuperarse', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-recuperacion-linea-futura-')
    );

    try {
        const backend = cargarBackendAislado(rutaDatos);
        let enviosPrimeraLinea = 0;
        let enviosSegundaLinea = 0;
        const primeraLinea = crearLinea(async () => {
            enviosPrimeraLinea += 1;
            return {
                key: {
                    remoteJid: 'status@broadcast',
                    fromMe: true,
                    id: 'ID-LINEA-ACTUAL-ANTES-DE-RECUPERAR-FUTURA'
                },
                messageTimestamp: Math.floor(Date.now() / 1000)
            };
        });
        const segundaLinea = crearLinea(
            async () => {
                enviosSegundaLinea += 1;
                return {
                    key: {
                        remoteJid: 'status@broadcast',
                        fromMe: true,
                        id: 'ID-LINEA-FUTURA-RECUPERADA'
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000)
                };
            },
            {
                id: ID_LINEA_SIGUIENTE,
                nombre: 'Línea futura en reconexión',
                jidPropio: '595888888888@s.whatsapp.net',
                contacto: '595222222222@s.whatsapp.net'
            }
        );
        const socketRecuperado = segundaLinea.socket;
        segundaLinea.socket = null;
        segundaLinea.jid = null;
        segundaLinea.estado = 'reconectando';
        segundaLinea.etiqueta = 'caida';
        segundaLinea.iniciando = true;
        backend.lineas.set(primeraLinea.id, primeraLinea);
        backend.lineas.set(segundaLinea.id, segundaLinea);

        const rutaImagen = crearImagenPrueba(
            rutaDatos,
            'linea-futura-en-reconexion.png'
        );
        const tarea = backend.ejecutarPublicacion(
            crearParametrosPublicacion(
                [primeraLinea.id, segundaLinea.id],
                rutaImagen,
                'La línea actual no espera a una línea futura'
            )
        );

        await esperarHasta(
            () => {
                const progreso = backend.obtenerProgreso();
                return enviosPrimeraLinea === 1 &&
                    progreso.correctas === 1 &&
                    progreso.estado === 'esperando_reconexion';
            },
            {
                mensaje:
                    'La primera línea no publicó antes de esperar la recuperación futura.'
            }
        );
        assert.equal(enviosSegundaLinea, 0);

        segundaLinea.socket = socketRecuperado;
        segundaLinea.jid = socketRecuperado.user.id;
        segundaLinea.estado = 'conectado';
        segundaLinea.etiqueta = 'activa';
        segundaLinea.iniciando = false;
        segundaLinea.conexionEnVerificacion = false;

        const resultado = await tarea;
        assert.deepEqual(resultado, { correctas: 2, fallidas: 0 });
        assert.equal(enviosPrimeraLinea, 1);
        assert.equal(enviosSegundaLinea, 1);
        assert.equal(backend.obtenerProgreso().estado, 'completado');
        assert.equal(backend.obtenerProgreso().codigoErrorCorte, null);
    } finally {
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('un corte reportado por una línea ya procesada no detiene las restantes', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-corte-linea-procesada-')
    );

    try {
        const backend = cargarBackendAislado(rutaDatos);
        let enviosPrimeraLinea = 0;
        let enviosSegundaLinea = 0;
        let resolverSegundoEnvio;
        let avisarSegundoEnvio;
        const segundoEnvioIniciado = new Promise(resolve => {
            avisarSegundoEnvio = resolve;
        });
        const segundoEnvio = new Promise(resolve => {
            resolverSegundoEnvio = resolve;
        });
        const primeraLinea = crearLinea(async () => {
            enviosPrimeraLinea += 1;
            return {
                key: {
                    remoteJid: 'status@broadcast',
                    fromMe: true,
                    id: 'ID-LINEA-PROCESADA-ANTES-DEL-CORTE'
                },
                messageTimestamp: Math.floor(Date.now() / 1000)
            };
        });
        const segundaLinea = crearLinea(
            () => {
                enviosSegundaLinea += 1;
                avisarSegundoEnvio();
                return segundoEnvio;
            },
            {
                id: ID_LINEA_SIGUIENTE,
                nombre: 'Línea posterior al corte tardío',
                jidPropio: '595888888888@s.whatsapp.net',
                contacto: '595222222222@s.whatsapp.net'
            }
        );
        backend.lineas.set(primeraLinea.id, primeraLinea);
        backend.lineas.set(segundaLinea.id, segundaLinea);

        const rutaImagen = crearImagenPrueba(
            rutaDatos,
            'corte-de-linea-ya-procesada.png'
        );
        const tarea = backend.ejecutarPublicacion(
            crearParametrosPublicacion(
                [primeraLinea.id, segundaLinea.id],
                rutaImagen,
                'Un corte tardío no afecta las líneas pendientes'
            )
        );

        await segundoEnvioIniciado;
        assert.equal(backend.obtenerProgreso().correctas, 1);
        primeraLinea.socket = null;
        primeraLinea.estado = 'desconectado';
        backend.registrarCorteDesconexion(
            primeraLinea,
            'La línea ya procesada perdió la conexión.',
            408,
            {
                fasePublicacion: 'preparacion',
                preflight: true,
                envioIncierto: false
            }
        );

        resolverSegundoEnvio({
            key: {
                remoteJid: 'status@broadcast',
                fromMe: true,
                id: 'ID-LINEA-POSTERIOR-AL-CORTE-TARDIO'
            },
            messageTimestamp: Math.floor(Date.now() / 1000)
        });

        const resultado = await tarea;
        assert.deepEqual(resultado, { correctas: 2, fallidas: 0 });
        assert.equal(enviosPrimeraLinea, 1);
        assert.equal(enviosSegundaLinea, 1);
        assert.equal(backend.obtenerProgreso().estado, 'completado');
        assert.equal(backend.obtenerProgreso().codigoErrorCorte, null);
        assert.equal(backend.obtenerProgreso().noProcesadas, 0);
    } finally {
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('un WA_408 preflight permite omitir la línea y continuar sin enfriamiento', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-wa-408-continuar-')
    );
    let servidorPrueba = null;

    try {
        const backend = cargarBackendAislado(rutaDatos);
        let enviosPrimeraLinea = 0;
        let enviosSegundaLinea = 0;
        const linea = crearLinea(async () => {
            enviosPrimeraLinea += 1;
            throw new Error('No debía intentar enviar durante el preflight.');
        });
        const segundaLinea = crearLinea(
            async () => {
                enviosSegundaLinea += 1;
                return {
                    key: {
                        remoteJid: 'status@broadcast',
                        fromMe: true,
                        id: 'ID-DESPUES-DE-WA-408'
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000)
                };
            },
            {
                id: ID_LINEA_SIGUIENTE,
                nombre: 'Línea posterior al WA_408',
                jidPropio: '595888888888@s.whatsapp.net',
                contacto: '595222222222@s.whatsapp.net'
            }
        );
        linea.socket = null;
        linea.jid = null;
        linea.estado = 'reconectando';
        linea.etiqueta = 'caida';
        linea.iniciando = true;
        backend.lineas.set(linea.id, linea);
        backend.lineas.set(segundaLinea.id, segundaLinea);
        servidorPrueba = await abrirServidorPrueba(backend.app);

        const rutaImagen = crearImagenPrueba(
            rutaDatos,
            'wa-408-continuar.png'
        );
        const tarea = backend.ejecutarPublicacion(
            crearParametrosPublicacion(
                [linea.id, segundaLinea.id],
                rutaImagen,
                'Continuar después de un corte seguro'
            )
        );

        await esperarHasta(
            () => backend.obtenerProgreso().estado === 'esperando_reconexion',
            {
                mensaje:
                    'La publicación no esperó la recuperación antes del corte preflight.'
            }
        );
        backend.registrarCorteDesconexion(
            linea,
            'La línea no recuperó una conexión estable dentro del tiempo de seguridad.',
            408,
            {
                fasePublicacion: 'preparacion',
                preflight: true,
                envioIncierto: false
            }
        );

        await esperarHasta(
            () => {
                const progreso = backend.obtenerProgreso();
                return progreso.estado === 'detenido_seguridad' &&
                    progreso.decisionSeguridadPendiente?.tipo ===
                        'error_linea' &&
                    progreso.decisionSeguridadPendiente?.permiteOmitir === true;
            },
            {
                mensaje:
                    'El WA_408 preflight no ofreció una decisión segura.'
            }
        );

        const decision = backend.obtenerProgreso()
            .decisionSeguridadPendiente;
        assert.equal(decision.lineaId, linea.id);
        assert.equal(decision.codigo, 'WA_408');
        assert.equal(enviosPrimeraLinea, 0);
        assert.equal(enviosSegundaLinea, 0);

        const reanudacion = await solicitarJson(
            servidorPrueba.baseUrl,
            '/progreso/reanudar',
            { method: 'POST' }
        );
        assert.equal(reanudacion.respuesta.status, 200);

        const resultado = await tarea;
        const proteccion = backend.obtenerProteccionMiddleware();
        assert.deepEqual(resultado, { correctas: 1, fallidas: 1 });
        assert.equal(enviosPrimeraLinea, 0);
        assert.equal(enviosSegundaLinea, 1);
        assert.equal(
            backend.obtenerProgreso().estado,
            'completado_con_errores'
        );
        assert.equal(backend.obtenerProgreso().noProcesadas, 0);
        assert.equal(
            backend.obtenerProgreso().decisionSeguridadPendiente,
            null
        );
        const fallo = backend.obtenerProgreso().lineasFallidas.find(
            item => item.id === linea.id
        );
        assert.equal(fallo.codigoError, 'WA_408');
        assert.equal(fallo.fase, 'preparacion');
        assert.equal(fallo.reintentoSeguro, true);
        assert.equal(proteccion.activa, false);
        assert.equal(proteccion.segundosRestantes, 0);
    } finally {
        if (servidorPrueba) {
            await cerrarServidorPrueba(servidorPrueba.servidor);
        }
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('una desconexión fatal antes del envío se puede omitir porque no deja un resultado incierto', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-wa-401-preflight-continuar-')
    );
    let servidorPrueba = null;

    try {
        const backend = cargarBackendAislado(rutaDatos);
        let enviosPrimeraLinea = 0;
        let enviosSegundaLinea = 0;
        const primeraLinea = crearLinea(async () => {
            enviosPrimeraLinea += 1;
            throw new Error('No debía enviar después de una desconexión fatal.');
        });
        const segundaLinea = crearLinea(
            async () => {
                enviosSegundaLinea += 1;
                return {
                    key: {
                        remoteJid: 'status@broadcast',
                        fromMe: true,
                        id: 'ID-DESPUES-DE-WA-401-PREFLIGHT'
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000)
                };
            },
            {
                id: ID_LINEA_SIGUIENTE,
                nombre: 'Línea posterior al WA_401',
                jidPropio: '595888888888@s.whatsapp.net',
                contacto: '595222222222@s.whatsapp.net'
            }
        );
        primeraLinea.socket = null;
        primeraLinea.jid = null;
        primeraLinea.estado = 'reconectando';
        primeraLinea.etiqueta = 'caida';
        primeraLinea.iniciando = true;
        backend.lineas.set(primeraLinea.id, primeraLinea);
        backend.lineas.set(segundaLinea.id, segundaLinea);
        servidorPrueba = await abrirServidorPrueba(backend.app);

        const rutaImagen = crearImagenPrueba(
            rutaDatos,
            'wa-401-preflight-continuar.png'
        );
        const tarea = backend.ejecutarPublicacion(
            crearParametrosPublicacion(
                [primeraLinea.id, segundaLinea.id],
                rutaImagen,
                'Omitir desconexión fatal previa al envío'
            )
        );

        await esperarHasta(
            () => backend.obtenerProgreso().estado === 'esperando_reconexion',
            {
                mensaje:
                    'La línea fatal no entró en preparación antes de simular el cierre.'
            }
        );
        primeraLinea.reconexionBloqueada = true;
        backend.registrarCorteDesconexion(
            primeraLinea,
            'WhatsApp cerró la sesión antes de intentar el envío.',
            401,
            {
                fasePublicacion: 'preparacion',
                preflight: true,
                envioIncierto: false
            }
        );

        const decision = await esperarHasta(() => {
            const progreso = backend.obtenerProgreso();
            return progreso.estado === 'detenido_seguridad' &&
                progreso.decisionSeguridadPendiente?.tipo ===
                    'error_linea' &&
                progreso.decisionSeguridadPendiente?.permiteOmitir === true
                ? progreso.decisionSeguridadPendiente
                : null;
        }, {
            mensaje:
                'La desconexión fatal preflight no ofreció una omisión segura.'
        });

        assert.equal(decision.lineaId, primeraLinea.id);
        assert.equal(decision.codigo, 'WA_401');
        assert.equal(enviosPrimeraLinea, 0);
        assert.equal(enviosSegundaLinea, 0);
        assert.equal(
            backend.obtenerProgreso().confirmacionEnvioPendiente,
            null
        );

        const reanudacion = await solicitarJson(
            servidorPrueba.baseUrl,
            '/progreso/reanudar',
            { method: 'POST' }
        );
        assert.equal(reanudacion.respuesta.status, 200);

        const resultado = await tarea;
        assert.deepEqual(resultado, { correctas: 1, fallidas: 1 });
        assert.equal(enviosPrimeraLinea, 0);
        assert.equal(enviosSegundaLinea, 1);
        const fallo = backend.obtenerProgreso().lineasFallidas.find(
            item => item.id === primeraLinea.id
        );
        assert.equal(fallo.codigoError, 'WA_401');
        assert.equal(fallo.fase, 'preparacion');
        assert.equal(fallo.envioIncierto, false);
        assert.equal(fallo.reintentoSeguro, true);
        const proteccion = backend.obtenerProteccionMiddleware();
        assert.equal(proteccion.activa, false);
    } finally {
        if (servidorPrueba) {
            await cerrarServidorPrueba(servidorPrueba.servidor);
        }
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('cancelar durante la pausa de un WA_408 detiene las líneas restantes', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-wa-408-cancelar-')
    );
    let servidorPrueba = null;

    try {
        const backend = cargarBackendAislado(rutaDatos);
        let enviosPrimeraLinea = 0;
        let enviosSegundaLinea = 0;
        const linea = crearLinea(async () => {
            enviosPrimeraLinea += 1;
            throw new Error('No debía intentar enviar durante el preflight.');
        });
        const segundaLinea = crearLinea(
            async () => {
                enviosSegundaLinea += 1;
                throw new Error('Cancelar debía impedir el segundo envío.');
            },
            {
                id: ID_LINEA_SIGUIENTE,
                nombre: 'Línea cancelada después del WA_408',
                jidPropio: '595888888888@s.whatsapp.net',
                contacto: '595222222222@s.whatsapp.net'
            }
        );
        linea.socket = null;
        linea.jid = null;
        linea.estado = 'reconectando';
        linea.etiqueta = 'caida';
        linea.iniciando = true;
        backend.lineas.set(linea.id, linea);
        backend.lineas.set(segundaLinea.id, segundaLinea);
        servidorPrueba = await abrirServidorPrueba(backend.app);

        const rutaImagen = crearImagenPrueba(
            rutaDatos,
            'wa-408-cancelar.png'
        );
        const tarea = backend.ejecutarPublicacion(
            crearParametrosPublicacion(
                [linea.id, segundaLinea.id],
                rutaImagen,
                'Cancelar después de un corte seguro'
            )
        );

        await esperarHasta(
            () => backend.obtenerProgreso().estado === 'esperando_reconexion'
        );
        backend.registrarCorteDesconexion(
            linea,
            'La línea no recuperó una conexión estable dentro del tiempo de seguridad.',
            408,
            {
                fasePublicacion: 'preparacion',
                preflight: true,
                envioIncierto: false
            }
        );

        await esperarHasta(
            () => {
                const progreso = backend.obtenerProgreso();
                return progreso.estado === 'detenido_seguridad' &&
                    progreso.decisionSeguridadPendiente?.tipo ===
                        'error_linea' &&
                    progreso.decisionSeguridadPendiente?.permiteOmitir === true;
            }
        );

        const rechazoTarea = assert.rejects(
            tarea,
            error => error?.codigo === 'CANCELADA_SEGURIDAD'
        );
        const cancelacion = await solicitarJson(
            servidorPrueba.baseUrl,
            '/progreso/cancelar',
            { method: 'POST' }
        );
        assert.equal(cancelacion.respuesta.status, 200);

        await rechazoTarea;
        assert.equal(enviosPrimeraLinea, 0);
        assert.equal(enviosSegundaLinea, 0);
        assert.equal(
            backend.obtenerProgreso().estado,
            'cancelado_seguridad'
        );
        assert.equal(backend.obtenerProgreso().noProcesadas, 1);
        const omitida = backend.obtenerProgreso().lineasFallidas.find(
            item => item.id === segundaLinea.id
        );
        assert.equal(omitida.tipoError, 'omitida_por_corte');
    } finally {
        if (servidorPrueba) {
            await cerrarServidorPrueba(servidorPrueba.servidor);
        }
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('un WA_429 mantiene el corte absoluto y no ofrece continuar', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-wa-429-sin-continuar-')
    );
    let servidorPrueba = null;

    try {
        fs.writeFileSync(
            path.join(rutaDatos, 'configuracion.json'),
            JSON.stringify({ enfriamientoPreventivoMinutos: 15 }),
            'utf8'
        );
        const backend = cargarBackendAislado(rutaDatos);
        backend.cargarConfiguracion();
        let enviosPrimeraLinea = 0;
        let enviosSegundaLinea = 0;
        const primeraLinea = crearLinea(async () => {
            enviosPrimeraLinea += 1;
            const error = new Error('Too Many Requests');
            error.statusCode = 429;
            error.retryAfter = 60;
            throw error;
        });
        const segundaLinea = crearLinea(
            async () => {
                enviosSegundaLinea += 1;
                throw new Error('El WA_429 debía impedir el segundo envío.');
            },
            {
                id: ID_LINEA_SIGUIENTE,
                nombre: 'Línea posterior al WA_429',
                jidPropio: '595888888888@s.whatsapp.net',
                contacto: '595222222222@s.whatsapp.net'
            }
        );
        backend.lineas.set(primeraLinea.id, primeraLinea);
        backend.lineas.set(segundaLinea.id, segundaLinea);
        servidorPrueba = await abrirServidorPrueba(backend.app);

        const rutaImagen = crearImagenPrueba(
            rutaDatos,
            'wa-429-sin-continuar.png'
        );
        const tarea = backend.ejecutarPublicacion(
            crearParametrosPublicacion(
                [primeraLinea.id, segundaLinea.id],
                rutaImagen,
                'El límite temporal no se puede omitir'
            )
        );

        await assert.rejects(
            tarea,
            error => error?.codigo === 'DETENIDA_LIMITE_TEMPORAL'
        );

        const progreso = backend.obtenerProgreso();
        const proteccion = backend.obtenerProteccionMiddleware();
        assert.equal(enviosPrimeraLinea, 1);
        assert.equal(enviosSegundaLinea, 0);
        assert.equal(progreso.estado, 'detenido_limite_temporal');
        assert.equal(progreso.codigoErrorCorte, 'WA_429');
        assert.equal(progreso.decisionSeguridadPendiente, null);
        assert.equal(proteccion.activa, true);
        assert.equal(proteccion.tipo, 'limite_temporal');
        assert.ok(proteccion.segundosRestantes >= 58);
        assert.ok(proteccion.segundosRestantes <= 60);

        const intentoContinuar = await solicitarJson(
            servidorPrueba.baseUrl,
            '/progreso/reanudar',
            { method: 'POST' }
        );
        assert.equal(intentoContinuar.respuesta.status, 409);
        assert.match(
            intentoContinuar.cuerpo.error,
            /no hay una publicación detenida por seguridad/i
        );
        assert.equal(enviosSegundaLinea, 0);
    } finally {
        if (servidorPrueba) {
            await cerrarServidorPrueba(servidorPrueba.servidor);
        }
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('dos WA_408 preflight consecutivos pueden omitirse antes de continuar', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-dos-wa-408-consecutivos-')
    );
    let servidorPrueba = null;

    try {
        const backend = cargarBackendAislado(rutaDatos);
        const ID_TERCERA_LINEA =
            '44444444-4444-4444-8444-444444444444';
        let enviosPrimeraLinea = 0;
        let enviosSegundaLinea = 0;
        let enviosTerceraLinea = 0;
        const primeraLinea = crearLinea(async () => {
            enviosPrimeraLinea += 1;
            throw new Error('La primera línea no debía enviar.');
        });
        const segundaLinea = crearLinea(
            async () => {
                enviosSegundaLinea += 1;
                throw new Error('La segunda línea no debía enviar.');
            },
            {
                id: ID_LINEA_SIGUIENTE,
                nombre: 'Segunda línea con WA_408',
                jidPropio: '595888888888@s.whatsapp.net',
                contacto: '595222222222@s.whatsapp.net'
            }
        );
        const terceraLinea = crearLinea(
            async () => {
                enviosTerceraLinea += 1;
                return {
                    key: {
                        remoteJid: 'status@broadcast',
                        fromMe: true,
                        id: 'ID-DESPUES-DE-DOS-WA-408'
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000)
                };
            },
            {
                id: ID_TERCERA_LINEA,
                nombre: 'Tercera línea disponible',
                jidPropio: '595777777777@s.whatsapp.net',
                contacto: '595333333333@s.whatsapp.net'
            }
        );
        for (const linea of [primeraLinea, segundaLinea]) {
            linea.socket = null;
            linea.jid = null;
            linea.estado = 'reconectando';
            linea.etiqueta = 'caida';
            linea.iniciando = true;
        }
        backend.lineas.set(primeraLinea.id, primeraLinea);
        backend.lineas.set(segundaLinea.id, segundaLinea);
        backend.lineas.set(terceraLinea.id, terceraLinea);
        servidorPrueba = await abrirServidorPrueba(backend.app);

        const rutaImagen = crearImagenPrueba(
            rutaDatos,
            'dos-wa-408-consecutivos.png'
        );
        const tarea = backend.ejecutarPublicacion(
            crearParametrosPublicacion(
                [
                    primeraLinea.id,
                    segundaLinea.id,
                    terceraLinea.id
                ],
                rutaImagen,
                'Dos cortes seguros consecutivos'
            )
        );

        for (const linea of [primeraLinea, segundaLinea]) {
            await esperarHasta(
                () => {
                    const progreso = backend.obtenerProgreso();
                    return progreso.estado === 'esperando_reconexion' &&
                        progreso.lineaActual?.id === linea.id;
                },
                {
                    mensaje:
                        `No se esperó la reconexión de ${linea.nombre}.`
                }
            );
            backend.registrarCorteDesconexion(
                linea,
                `${linea.nombre} agotó su espera de conexión.`,
                408,
                {
                    fasePublicacion: 'preparacion',
                    preflight: true,
                    envioIncierto: false
                }
            );
            await esperarHasta(
                () => {
                    const progreso = backend.obtenerProgreso();
                    return progreso.estado === 'detenido_seguridad' &&
                        progreso.decisionSeguridadPendiente?.tipo ===
                            'error_linea' &&
                        progreso.decisionSeguridadPendiente
                            ?.permiteOmitir === true &&
                        progreso.decisionSeguridadPendiente?.lineaId ===
                            linea.id;
                },
                {
                    mensaje:
                        `No se ofreció continuar después del corte de ${linea.nombre}.`
                }
            );
            const reanudacion = await solicitarJson(
                servidorPrueba.baseUrl,
                '/progreso/reanudar',
                { method: 'POST' }
            );
            assert.equal(reanudacion.respuesta.status, 200);
        }

        const resultado = await tarea;
        assert.deepEqual(resultado, { correctas: 1, fallidas: 2 });
        assert.equal(enviosPrimeraLinea, 0);
        assert.equal(enviosSegundaLinea, 0);
        assert.equal(enviosTerceraLinea, 1);
        assert.equal(
            backend.obtenerProgreso().estado,
            'completado_con_errores'
        );
        assert.equal(
            backend.obtenerProgreso().decisionSeguridadPendiente,
            null
        );
    } finally {
        if (servidorPrueba) {
            await cerrarServidorPrueba(servidorPrueba.servidor);
        }
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('repite la preparación si el socket cambia antes de sendMessage', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-reintento-preparacion-')
    );

    try {
        const backend = cargarBackendAislado(rutaDatos);
        const contactoLid = '595111111111@lid';
        const contactoNumero = '595111111111@s.whatsapp.net';
        let cantidadEnvios = 0;
        let cambioIniciado = false;
        let linea;

        linea = crearLinea(
            async () => {
                cantidadEnvios += 1;
                return {
                    key: {
                        remoteJid: 'status@broadcast',
                        fromMe: true,
                        id: 'ID-ESTADO-TRAS-REPETIR-PREPARACION'
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000)
                };
            },
            { contacto: contactoLid }
        );

        const socketInicial = linea.socket;
        const socketRecuperado = {
            ...socketInicial,
            signalRepository: {
                lidMapping: {
                    getPNForLID: async () => contactoNumero
                }
            }
        };
        socketInicial.signalRepository = {
            lidMapping: {
                getPNForLID: async () => {
                    if (!cambioIniciado) {
                        cambioIniciado = true;
                        linea.socket = null;
                        linea.jid = null;
                        linea.estado = 'reconectando';
                        linea.etiqueta = 'caida';
                        linea.iniciando = true;

                        setTimeout(() => {
                            linea.socket = socketRecuperado;
                            linea.jid = socketRecuperado.user.id;
                            linea.estado = 'conectado';
                            linea.etiqueta = 'activa';
                            linea.iniciando = false;
                            linea.conexionEnVerificacion = false;
                        }, 25);
                    }

                    await new Promise(resolve => setTimeout(resolve, 5));
                    return contactoNumero;
                }
            }
        };
        backend.lineas.set(linea.id, linea);

        const rutaImagen = path.join(rutaDatos, 'imagen-reintento.png');
        fs.writeFileSync(
            rutaImagen,
            Buffer.from([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a,
                0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00
            ])
        );

        const resultado = await backend.ejecutarPublicacion({
            idsLineas: [linea.id],
            rutaImagen,
            texto: 'Reintento seguro de preparación',
            modoRitmo: 'secuencial',
            intervaloSegundos: 10,
            variacionSegundos: 0,
            lineasPorGrupo: 1,
            intervaloMinutos: 0,
            maximoDestinatariosPorEstado: 1000,
            origen: 'prueba interna'
        });

        assert.equal(cambioIniciado, true);
        assert.deepEqual(resultado, { correctas: 1, fallidas: 0 });
        assert.equal(cantidadEnvios, 1);
        assert.equal(backend.obtenerProgreso().procesadas, 1);
    } finally {
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('una reconexión manual tardía no corta una publicación activa', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-reconexion-manual-protegida-')
    );

    try {
        const backend = cargarBackendAislado(rutaDatos);
        const primeraLinea = crearLinea(async () => ({
            key: {
                remoteJid: 'status@broadcast',
                fromMe: true,
                id: 'ID-PRIMERA-LINEA-PROTEGIDA'
            },
            messageTimestamp: Math.floor(Date.now() / 1000)
        }));
        const socketPrimeraLinea = primeraLinea.socket;

        let resolverSegundoEnvio;
        let avisarSegundoEnvio;
        const segundoEnvioIniciado = new Promise(resolve => {
            avisarSegundoEnvio = resolve;
        });
        const segundoEnvio = new Promise(resolve => {
            resolverSegundoEnvio = resolve;
        });
        const segundaLinea = crearLinea(
            () => {
                avisarSegundoEnvio();
                return segundoEnvio;
            },
            {
                id: ID_LINEA_SIGUIENTE,
                nombre: 'Segunda línea todavía en publicación',
                jidPropio: '595888888888@s.whatsapp.net',
                contacto: '595222222222@s.whatsapp.net'
            }
        );

        backend.lineas.set(primeraLinea.id, primeraLinea);
        backend.lineas.set(segundaLinea.id, segundaLinea);

        const rutaImagen = path.join(
            rutaDatos,
            'imagen-reconexion-manual-protegida.png'
        );
        fs.writeFileSync(
            rutaImagen,
            Buffer.from([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a,
                0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00
            ])
        );

        const tarea = backend.ejecutarPublicacion({
            idsLineas: [primeraLinea.id, segundaLinea.id],
            rutaImagen,
            texto: 'La reconexión no debe cortar esta publicación',
            modoRitmo: 'grupos',
            intervaloSegundos: 10,
            variacionSegundos: 0,
            lineasPorGrupo: 2,
            intervaloMinutos: 0,
            maximoDestinatariosPorEstado: 1000,
            origen: 'prueba interna'
        });

        await segundoEnvioIniciado;
        assert.equal(backend.obtenerProgreso().activo, true);
        assert.equal(backend.obtenerProgreso().correctas, 1);

        const reconexionIniciada = backend.solicitarReconexionManual(
            primeraLinea,
            100
        );
        if (reconexionIniciada) primeraLinea.eliminando = true;

        assert.equal(reconexionIniciada, false);
        assert.equal(primeraLinea.socket, socketPrimeraLinea);
        assert.equal(primeraLinea.estado, 'conectado');

        resolverSegundoEnvio({
            key: {
                remoteJid: 'status@broadcast',
                fromMe: true,
                id: 'ID-SEGUNDA-LINEA-PROTEGIDA'
            },
            messageTimestamp: Math.floor(Date.now() / 1000)
        });

        const resultado = await tarea;
        assert.deepEqual(resultado, { correctas: 2, fallidas: 0 });
        assert.equal(backend.obtenerProgreso().estado, 'completado');
        assert.equal(backend.obtenerProgreso().codigoErrorCorte, null);
        assert.equal(backend.obtenerProgreso().noProcesadas, 0);
    } finally {
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

for (const escenario of [
    {
        resultado: 'publicado',
        descripcion: 'publicado',
        correctas: 2,
        fallidas: 0
    },
    {
        resultado: 'no_publicado',
        descripcion: 'no publicado',
        correctas: 1,
        fallidas: 1
    }
]) {
    test(`un rechazo WA_408 durante sendMessage espera confirmar ${escenario.descripcion} antes de continuar`, async () => {
        const rutaDatos = fs.mkdtempSync(
            path.join(
                os.tmpdir(),
                `zeroone-wa-408-envio-${escenario.resultado}-`
            )
        );
        let servidorPrueba = null;

        try {
            const backend = cargarBackendAislado(rutaDatos);
            let enviosPrimeraLinea = 0;
            let enviosSegundaLinea = 0;
            let primeraLinea = null;
            primeraLinea = crearLinea(async () => {
                enviosPrimeraLinea += 1;
                primeraLinea.estado = 'desconectado';
                primeraLinea.etiqueta = 'caida';
                primeraLinea.socket = null;
                const error = new Error(
                    'Connection Closed mientras WhatsApp procesaba el estado.'
                );
                error.statusCode = 408;
                throw error;
            });
            primeraLinea.nombre = 'Línea con WA_408 durante el envío';
            const segundaLinea = crearLinea(
                async () => {
                    enviosSegundaLinea += 1;
                    return {
                        key: {
                            remoteJid: 'status@broadcast',
                            fromMe: true,
                            id:
                                `ID-DESPUES-DE-WA-408-${escenario.resultado}`
                        },
                        messageTimestamp: Math.floor(Date.now() / 1000)
                    };
                },
                {
                    id: ID_LINEA_SIGUIENTE,
                    nombre: 'Línea posterior al WA_408 de envío',
                    jidPropio: '595888888888@s.whatsapp.net',
                    contacto: '595222222222@s.whatsapp.net'
                }
            );
            backend.lineas.set(primeraLinea.id, primeraLinea);
            backend.lineas.set(segundaLinea.id, segundaLinea);
            servidorPrueba = await abrirServidorPrueba(backend.app);

            const rutaImagen = crearImagenPrueba(
                rutaDatos,
                `wa-408-envio-${escenario.resultado}.png`
            );
            const tarea = backend.ejecutarPublicacion(
                crearParametrosPublicacion(
                    [primeraLinea.id, segundaLinea.id],
                    rutaImagen,
                    'Confirmar un rechazo ambiguo durante el envío'
                )
            );
            tarea.catch(() => {});

            const solicitud = await esperarHasta(() => {
                const progreso = backend.obtenerProgreso();
                return progreso.estado === 'esperando_confirmacion_envio'
                    ? progreso.confirmacionEnvioPendiente
                    : null;
            }, {
                mensaje:
                    'El rechazo por desconexión durante sendMessage no pidió confirmación.'
            });

            assert.equal(solicitud.lineaId, primeraLinea.id);
            assert.equal(enviosPrimeraLinea, 1);
            assert.equal(enviosSegundaLinea, 0);
            assert.equal(
                backend.obtenerProgreso().decisionSeguridadPendiente,
                null
            );

            const intentoContinuar = await solicitarJson(
                servidorPrueba.baseUrl,
                '/progreso/reanudar',
                { method: 'POST' }
            );
            assert.equal(intentoContinuar.respuesta.status, 409);
            assert.equal(enviosSegundaLinea, 0);

            const confirmacion = await solicitarJson(
                servidorPrueba.baseUrl,
                '/progreso/confirmar-envio',
                {
                    method: 'POST',
                    body: JSON.stringify({
                        solicitudId: solicitud.solicitudId,
                        resultado: escenario.resultado
                    })
                }
            );
            assert.equal(confirmacion.respuesta.status, 200);
            assert.equal(confirmacion.cuerpo.resuelta, true);

            const resultado = await tarea;
            assert.deepEqual(resultado, {
                correctas: escenario.correctas,
                fallidas: escenario.fallidas
            });
            assert.equal(enviosPrimeraLinea, 1);
            assert.equal(enviosSegundaLinea, 1);
            assert.equal(
                backend.obtenerProgreso().estado,
                escenario.fallidas > 0
                    ? 'completado_con_errores'
                    : 'completado'
            );
            assert.equal(
                backend.obtenerProgreso().confirmacionEnvioPendiente,
                null
            );

            if (escenario.resultado === 'publicado') {
                const primeraCorrecta =
                    backend.obtenerProgreso().lineasCorrectas.find(
                        item => item.id === primeraLinea.id
                    );
                assert.equal(primeraCorrecta.confirmacionManual, true);
                assert.equal(primeraCorrecta.estadoId, null);
            } else {
                const fallo = backend.obtenerProgreso().lineasFallidas.find(
                    item => item.id === primeraLinea.id
                );
                assert.equal(fallo.tipoError, 'envio_omitido_manual');
                assert.equal(fallo.codigoError, 'ENVIO_OMITIDO_MANUAL');
                assert.equal(fallo.confirmacionManual, 'no_publicado');
            }
        } finally {
            if (servidorPrueba) {
                await cerrarServidorPrueba(servidorPrueba.servidor);
            }
            fs.rmSync(rutaDatos, { recursive: true, force: true });
        }
    });
}

test('un envío incierto confirmado como publicado continúa sin poner la línea en cuarentena', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-confirmacion-publicado-')
    );
    let servidorPrueba = null;

    try {
        const backend = cargarBackendAislado(rutaDatos, {
            tiempoMaximoEnvioMs: 25
        });
        let enviosPrimeraLinea = 0;
        let enviosSegundaLinea = 0;
        const primeraLinea = crearLinea(() => {
            enviosPrimeraLinea += 1;
            return new Promise(() => {});
        });
        const segundaLinea = crearLinea(
            async () => {
                enviosSegundaLinea += 1;
                return {
                    key: {
                        remoteJid: 'status@broadcast',
                        fromMe: true,
                        id: 'ID-SEGUNDA-LINEA-CONFIRMACION-MANUAL'
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000)
                };
            },
            {
                id: ID_LINEA_SIGUIENTE,
                nombre: 'Segunda línea después de confirmar',
                jidPropio: '595888888888@s.whatsapp.net',
                contacto: '595222222222@s.whatsapp.net'
            }
        );
        backend.lineas.set(primeraLinea.id, primeraLinea);
        backend.lineas.set(segundaLinea.id, segundaLinea);
        servidorPrueba = await abrirServidorPrueba(backend.app);

        const rutaImagen = crearImagenPrueba(
            rutaDatos,
            'confirmacion-publicado.png'
        );
        const tarea = backend.ejecutarPublicacion(
            crearParametrosPublicacion(
                [primeraLinea.id, segundaLinea.id],
                rutaImagen,
                'Confirmación manual positiva'
            )
        );

        const solicitud = await esperarHasta(
            () => {
                const progreso = backend.obtenerProgreso();
                return progreso.estado === 'esperando_confirmacion_envio'
                    ? progreso.confirmacionEnvioPendiente
                    : null;
            },
            {
                mensaje:
                    'La publicación no entró en espera de confirmación.'
            }
        );
        assert.equal(enviosPrimeraLinea, 1);
        assert.equal(enviosSegundaLinea, 0);
        assert.equal(
            backend.obtenerProgreso().decisionSeguridadPendiente,
            null
        );

        const intentoContinuarAntesDeConfirmar = await solicitarJson(
            servidorPrueba.baseUrl,
            '/progreso/reanudar',
            { method: 'POST' }
        );
        assert.equal(intentoContinuarAntesDeConfirmar.respuesta.status, 409);
        assert.equal(enviosSegundaLinea, 0);

        const confirmacion = backend.resolverConfirmacionEnvioPendiente(
            solicitud.solicitudId,
            'publicado'
        );
        assert.equal(confirmacion.resuelta, true);

        const resultado = await tarea;
        assert.deepEqual(resultado, { correctas: 2, fallidas: 0 });
        assert.equal(enviosPrimeraLinea, 1);
        assert.equal(enviosSegundaLinea, 1);
        assert.equal(backend.obtenerProgreso().estado, 'completado');
        assert.equal(
            backend.obtenerProgreso().confirmacionEnvioPendiente,
            null
        );

        const primeraCorrecta = backend.obtenerProgreso().lineasCorrectas.find(
            item => item.id === primeraLinea.id
        );
        assert.equal(primeraCorrecta.confirmacionManual, true);
        assert.equal(primeraCorrecta.estadoId, null);
        assert.equal(primeraLinea.requiereRevisionEnvio, false);
        assert.equal(primeraLinea.reconexionBloqueada, false);
        assert.equal(primeraLinea.estado, 'conectado');
        assert.equal(primeraLinea.etiqueta, 'activa');
    } finally {
        if (servidorPrueba) {
            await cerrarServidorPrueba(servidorPrueba.servidor);
        }
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('un envío confirmado como no publicado se omite sin reenviar y continúa', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-confirmacion-omitido-')
    );

    try {
        const backend = cargarBackendAislado(rutaDatos, {
            tiempoMaximoEnvioMs: 25
        });
        let enviosPrimeraLinea = 0;
        let enviosSegundaLinea = 0;
        const primeraLinea = crearLinea(() => {
            enviosPrimeraLinea += 1;
            return new Promise(() => {});
        });
        const segundaLinea = crearLinea(
            async () => {
                enviosSegundaLinea += 1;
                return {
                    key: {
                        remoteJid: 'status@broadcast',
                        fromMe: true,
                        id: 'ID-SEGUNDA-LINEA-DESPUES-DE-OMITIR'
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000)
                };
            },
            {
                id: ID_LINEA_SIGUIENTE,
                nombre: 'Segunda línea después de omitir',
                jidPropio: '595888888888@s.whatsapp.net',
                contacto: '595222222222@s.whatsapp.net'
            }
        );
        backend.lineas.set(primeraLinea.id, primeraLinea);
        backend.lineas.set(segundaLinea.id, segundaLinea);

        const rutaImagen = crearImagenPrueba(
            rutaDatos,
            'confirmacion-no-publicado.png'
        );
        const tarea = backend.ejecutarPublicacion(
            crearParametrosPublicacion(
                [primeraLinea.id, segundaLinea.id],
                rutaImagen,
                'Confirmación manual negativa'
            )
        );

        const solicitud = await esperarHasta(() => {
            const progreso = backend.obtenerProgreso();
            return progreso.estado === 'esperando_confirmacion_envio'
                ? progreso.confirmacionEnvioPendiente
                : null;
        });
        const confirmacion = backend.resolverConfirmacionEnvioPendiente(
            solicitud.solicitudId,
            'no_publicado'
        );
        assert.equal(confirmacion.resuelta, true);

        const resultado = await tarea;
        assert.deepEqual(resultado, { correctas: 1, fallidas: 1 });
        assert.equal(enviosPrimeraLinea, 1);
        assert.equal(enviosSegundaLinea, 1);
        assert.equal(
            backend.obtenerProgreso().estado,
            'completado_con_errores'
        );
        assert.notEqual(
            backend.obtenerProgreso().estado,
            'detenido_seguridad'
        );

        const fallo = backend.obtenerProgreso().lineasFallidas.find(
            item => item.id === primeraLinea.id
        );
        assert.equal(fallo.tipoError, 'envio_omitido_manual');
        assert.equal(fallo.codigoError, 'ENVIO_OMITIDO_MANUAL');
        assert.equal(fallo.confirmacionManual, 'no_publicado');
        assert.equal(fallo.reintentoSeguro, false);
    } finally {
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('un ID tardío resuelve la espera automáticamente y vuelve obsoleta la decisión manual', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-confirmacion-id-tardio-')
    );

    try {
        const backend = cargarBackendAislado(rutaDatos, {
            tiempoMaximoEnvioMs: 25
        });
        let resolverPrimerEnvio;
        let enviosPrimeraLinea = 0;
        let enviosSegundaLinea = 0;
        const primerEnvio = new Promise(resolve => {
            resolverPrimerEnvio = resolve;
        });
        const primeraLinea = crearLinea(() => {
            enviosPrimeraLinea += 1;
            return primerEnvio;
        });
        const segundaLinea = crearLinea(
            async () => {
                enviosSegundaLinea += 1;
                return {
                    key: {
                        remoteJid: 'status@broadcast',
                        fromMe: true,
                        id: 'ID-SEGUNDA-LINEA-ID-TARDIO'
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000)
                };
            },
            {
                id: ID_LINEA_SIGUIENTE,
                nombre: 'Segunda línea tras ID tardío',
                jidPropio: '595888888888@s.whatsapp.net',
                contacto: '595222222222@s.whatsapp.net'
            }
        );
        backend.lineas.set(primeraLinea.id, primeraLinea);
        backend.lineas.set(segundaLinea.id, segundaLinea);

        const rutaImagen = crearImagenPrueba(
            rutaDatos,
            'confirmacion-id-tardio.png'
        );
        const tarea = backend.ejecutarPublicacion(
            crearParametrosPublicacion(
                [primeraLinea.id, segundaLinea.id],
                rutaImagen,
                'Resolución automática por ID tardío'
            )
        );

        const solicitud = await esperarHasta(() => {
            const progreso = backend.obtenerProgreso();
            return progreso.estado === 'esperando_confirmacion_envio'
                ? progreso.confirmacionEnvioPendiente
                : null;
        });
        const idTardio = 'ID-PRIMERA-LINEA-TARDIO';
        resolverPrimerEnvio({
            key: {
                remoteJid: 'status@broadcast',
                fromMe: true,
                id: idTardio
            },
            messageTimestamp: Math.floor(Date.now() / 1000)
        });

        const resultado = await tarea;
        assert.deepEqual(resultado, { correctas: 2, fallidas: 0 });
        assert.equal(enviosPrimeraLinea, 1);
        assert.equal(enviosSegundaLinea, 1);

        const primeraCorrecta = backend.obtenerProgreso().lineasCorrectas.find(
            item => item.id === primeraLinea.id
        );
        assert.equal(primeraCorrecta.estadoId, idTardio);
        assert.equal(primeraCorrecta.confirmacionManual, false);

        const decisionObsoleta =
            backend.resolverConfirmacionEnvioPendiente(
                solicitud.solicitudId,
                'publicado'
            );
        assert.equal(decisionObsoleta.resuelta, false);
        assert.equal(
            decisionObsoleta.codigo,
            'SOLICITUD_CONFIRMACION_OBSOLETA'
        );
    } finally {
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('Alto total durante la confirmación incierta impide iniciar la siguiente línea', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-confirmacion-alto-total-')
    );

    try {
        const backend = cargarBackendAislado(rutaDatos, {
            tiempoMaximoEnvioMs: 25
        });
        let enviosPrimeraLinea = 0;
        let enviosSegundaLinea = 0;
        const primeraLinea = crearLinea(() => {
            enviosPrimeraLinea += 1;
            return new Promise(() => {});
        });
        const segundaLinea = crearLinea(
            () => {
                enviosSegundaLinea += 1;
                throw new Error('Alto total debió impedir este envío.');
            },
            {
                id: ID_LINEA_SIGUIENTE,
                nombre: 'Línea bloqueada por Alto total',
                jidPropio: '595888888888@s.whatsapp.net',
                contacto: '595222222222@s.whatsapp.net'
            }
        );
        backend.lineas.set(primeraLinea.id, primeraLinea);
        backend.lineas.set(segundaLinea.id, segundaLinea);

        const rutaImagen = crearImagenPrueba(
            rutaDatos,
            'confirmacion-alto-total.png'
        );
        const tarea = backend.ejecutarPublicacion(
            crearParametrosPublicacion(
                [primeraLinea.id, segundaLinea.id],
                rutaImagen,
                'Alto total durante confirmación'
            )
        );

        await esperarHasta(() => {
            const progreso = backend.obtenerProgreso();
            return progreso.estado === 'esperando_confirmacion_envio' &&
                progreso.confirmacionEnvioPendiente;
        });
        const alto = backend.solicitarAltoTotalPublicacion();
        assert.equal(alto.habiaTrabajo, true);
        assert.equal(alto.activa, true);

        await assert.rejects(
            tarea,
            error => error?.codigo === 'DETENIDA_ALTO_TOTAL'
        );
        assert.equal(enviosPrimeraLinea, 1);
        assert.equal(enviosSegundaLinea, 0);
        assert.equal(
            backend.obtenerProgreso().estado,
            'detenido_alto_total'
        );
        assert.equal(
            backend.obtenerProgreso().confirmacionEnvioPendiente,
            null
        );
    } finally {
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('el simulacro visual usa la confirmación real y puede repetirse sin tocar datos', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-simulacro-envio-')
    );
    let servidor = null;

    try {
        const backend = cargarBackendAislado(rutaDatos, {
            fixturesUi: true
        });
        const cantidadesIniciales = {
            lineas: backend.lineas.size,
            estados: backend.estadosActivos.size,
            historial: backend.historialPublicaciones.length
        };
        const servidorPrueba = await abrirServidorPrueba(backend.app);
        servidor = servidorPrueba.servidor;

        const inicio = await solicitarJson(
            servidorPrueba.baseUrl,
            '/progreso/simulacro-envio',
            { method: 'POST' }
        );
        assert.equal(inicio.respuesta.status, 202);
        assert.equal(inicio.cuerpo.iniciado, true);
        assert.equal(inicio.cuerpo.total, 5);

        const ocupado = await solicitarJson(
            servidorPrueba.baseUrl,
            '/progreso/simulacro-envio',
            { method: 'POST' }
        );
        assert.equal(ocupado.respuesta.status, 409);
        assert.equal(ocupado.cuerpo.codigo, 'PUBLICACION_EN_CURSO');

        const primeraSolicitud = await esperarHasta(
            () => {
                const progreso = backend.obtenerProgreso();
                return progreso.estado === 'esperando_confirmacion_envio'
                    ? progreso.confirmacionEnvioPendiente
                    : null;
            },
            {
                timeoutMs: 3000,
                mensaje:
                    'El simulacro no llegó a la confirmación de la segunda línea.'
            }
        );
        assert.match(
            primeraSolicitud.solicitudId,
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
        );
        assert.equal(primeraSolicitud.lineaNombre, 'L02');
        assert.equal(primeraSolicitud.simulada, true);
        assert.equal(backend.obtenerProgreso().correctas, 1);
        assert.equal(backend.obtenerProgreso().procesadas, 1);

        const vista = await solicitarJson(
            servidorPrueba.baseUrl,
            '/progreso'
        );
        assert.equal(vista.respuesta.status, 200);
        assert.equal(vista.cuerpo.simulada, true);
        assert.equal(vista.cuerpo.simulacroDisponible, true);
        assert.equal(
            vista.cuerpo.confirmacionEnvioPendiente.solicitudId,
            primeraSolicitud.solicitudId
        );

        const confirmacion = await solicitarJson(
            servidorPrueba.baseUrl,
            '/progreso/confirmar-envio',
            {
                method: 'POST',
                body: JSON.stringify({
                    solicitudId: primeraSolicitud.solicitudId,
                    resultado: 'publicado'
                })
            }
        );
        assert.equal(confirmacion.respuesta.status, 200);
        assert.equal(confirmacion.cuerpo.resuelta, true);

        await esperarHasta(
            () => backend.obtenerProgreso().estado === 'completado',
            {
                timeoutMs: 6000,
                mensaje: 'El primer simulacro no terminó correctamente.'
            }
        );
        assert.equal(backend.obtenerProgreso().correctas, 5);
        assert.equal(backend.obtenerProgreso().fallidas, 0);
        assert.equal(backend.obtenerProgreso().procesadas, 5);
        assert.equal(backend.obtenerProgreso().lineasCorrectas.length, 5);

        const repeticion = await solicitarJson(
            servidorPrueba.baseUrl,
            '/progreso/simulacro-envio',
            { method: 'POST' }
        );
        assert.equal(repeticion.respuesta.status, 202);
        assert.ok(
            repeticion.cuerpo.generacion > inicio.cuerpo.generacion,
            'La repetición debe invalidar cualquier temporizador anterior.'
        );

        const segundaSolicitud = await esperarHasta(
            () => {
                const progreso = backend.obtenerProgreso();
                return progreso.estado === 'esperando_confirmacion_envio'
                    ? progreso.confirmacionEnvioPendiente
                    : null;
            },
            {
                timeoutMs: 3000,
                mensaje:
                    'La repetición no llegó a la confirmación de la segunda línea.'
            }
        );
        assert.notEqual(
            segundaSolicitud.solicitudId,
            primeraSolicitud.solicitudId
        );

        const omision = await solicitarJson(
            servidorPrueba.baseUrl,
            '/progreso/confirmar-envio',
            {
                method: 'POST',
                body: JSON.stringify({
                    solicitudId: segundaSolicitud.solicitudId,
                    resultado: 'no_publicado'
                })
            }
        );
        assert.equal(omision.respuesta.status, 200);

        await esperarHasta(
            () =>
                backend.obtenerProgreso().estado ===
                'completado_con_errores',
            {
                timeoutMs: 6000,
                mensaje: 'La repetición con omisión no terminó correctamente.'
            }
        );
        assert.equal(backend.obtenerProgreso().correctas, 4);
        assert.equal(backend.obtenerProgreso().fallidas, 1);
        assert.equal(backend.obtenerProgreso().procesadas, 5);
        assert.equal(
            backend.obtenerProgreso().lineasFallidas[0].tipoError,
            'envio_omitido_manual'
        );

        assert.deepEqual(
            {
                lineas: backend.lineas.size,
                estados: backend.estadosActivos.size,
                historial: backend.historialPublicaciones.length
            },
            cantidadesIniciales,
            'El simulacro no debe crear líneas, estados ni historial reales.'
        );
    } finally {
        if (servidor) await cerrarServidorPrueba(servidor);
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('Alto total detiene el simulacro mientras espera confirmación', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-simulacro-alto-total-')
    );
    let servidor = null;

    try {
        const backend = cargarBackendAislado(rutaDatos, {
            fixturesUi: true
        });
        const servidorPrueba = await abrirServidorPrueba(backend.app);
        servidor = servidorPrueba.servidor;

        const inicio = await solicitarJson(
            servidorPrueba.baseUrl,
            '/progreso/simulacro-envio',
            { method: 'POST' }
        );
        assert.equal(inicio.respuesta.status, 202);

        await esperarHasta(
            () => {
                const progreso = backend.obtenerProgreso();
                return progreso.estado === 'esperando_confirmacion_envio' &&
                    progreso.confirmacionEnvioPendiente;
            },
            {
                timeoutMs: 3000,
                mensaje:
                    'El simulacro no quedó esperando confirmación antes del Alto total.'
            }
        );

        const alto = await solicitarJson(
            servidorPrueba.baseUrl,
            '/progreso/alto-total',
            { method: 'POST' }
        );
        assert.equal(alto.respuesta.status, 200);
        assert.equal(alto.cuerpo.habiaTrabajo, true);

        await esperarHasta(
            () =>
                backend.obtenerProgreso().estado ===
                'detenido_alto_total',
            {
                timeoutMs: 1000,
                mensaje: 'Alto total no detuvo el simulacro.'
            }
        );
        assert.equal(backend.obtenerProgreso().correctas, 1);
        assert.equal(backend.obtenerProgreso().procesadas, 1);
        assert.equal(backend.obtenerProgreso().noProcesadas, 4);
        assert.equal(
            backend.obtenerProgreso().confirmacionEnvioPendiente,
            null
        );
    } finally {
        if (servidor) await cerrarServidorPrueba(servidor);
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});

test('la ruta del simulacro no existe fuera de la vista interna', async () => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-simulacro-bloqueado-')
    );
    let servidor = null;

    try {
        const backend = cargarBackendAislado(rutaDatos);
        const progresoAntes = structuredClone(backend.obtenerProgreso());
        const servidorPrueba = await abrirServidorPrueba(backend.app);
        servidor = servidorPrueba.servidor;

        const intento = await solicitarJson(
            servidorPrueba.baseUrl,
            '/progreso/simulacro-envio',
            { method: 'POST' }
        );
        assert.equal(intento.respuesta.status, 404);
        assert.equal(intento.cuerpo.codigo, 'SIMULACRO_NO_DISPONIBLE');
        assert.deepEqual(backend.obtenerProgreso(), progresoAntes);
        assert.equal(backend.lineas.size, 0);
        assert.equal(backend.estadosActivos.size, 0);
        assert.equal(backend.historialPublicaciones.length, 0);
    } finally {
        if (servidor) await cerrarServidorPrueba(servidor);
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});
