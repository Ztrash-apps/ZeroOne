const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const RAIZ_PROYECTO = path.resolve(__dirname, '..');
const ID_LINEA = '11111111-1111-4111-8111-111111111111';
const ID_LINEA_SEGUNDA = '22222222-2222-4222-8222-222222222222';
const ID_LINEA_HISTORICA = '33333333-3333-4333-8333-333333333333';
const ID_LINEA_DESCONOCIDA = '44444444-4444-4444-8444-444444444444';
const ID_PROGRAMACION = 'programacion-prueba-interna';

function escribirJSON(ruta, datos) {
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    fs.writeFileSync(ruta, JSON.stringify(datos, null, 2), 'utf8');
}

function prepararDatos(rutaDatos) {
    escribirJSON(path.join(rutaDatos, 'sesiones', 'lineas.json'), [
        {
            id: ID_LINEA,
            nombre: 'Línea interna bloqueada',
            ordenConexion: 1,
            etiqueta: 'caida',
            intentosReconexion: 5,
            conexionEnVerificacion: false,
            reconexionBloqueada: true,
            requiereRevisionEnvio: true,
            motivoRevisionEnvio: 'Envío anterior sin confirmación.',
            revisionEnvioDesde: new Date().toISOString()
        },
        {
            id: ID_LINEA_SEGUNDA,
            nombre: 'Línea interna secundaria',
            ordenConexion: 2,
            etiqueta: 'caida',
            intentosReconexion: 5,
            conexionEnVerificacion: false,
            reconexionBloqueada: true
        }
    ]);

    escribirJSON(path.join(rutaDatos, 'programados', 'programaciones.json'), [
        {
            id: ID_PROGRAMACION,
            hora: '23:59',
            diasSemana: [0, 1, 2, 3, 4, 5, 6],
            activa: false,
            estado: 'pausado',
            texto: 'Prueba interna; nunca se envía.',
            idsLineas: [ID_LINEA_HISTORICA],
            modoRitmo: 'secuencial',
            intervaloSegundos: 45,
            variacionSegundos: 5,
            lineasPorGrupo: 1,
            intervaloMinutos: 0,
            rutaImagen: path.join(rutaDatos, 'imagen-inexistente.png'),
            nombreArchivo: 'imagen-inexistente.png',
            creadoEn: new Date().toISOString(),
            actualizadoEn: new Date().toISOString(),
            ultimaEjecucion: null,
            ultimoResultado: null
        }
    ]);
}

function escribirProteccion(rutaDatos, bloqueadaHasta) {
    escribirJSON(path.join(rutaDatos, 'proteccion-publicacion.json'), {
        activa: true,
        tipo: 'prueba_interna',
        motivo: 'Enfriamiento simulado por la prueba interna.',
        codigo: 'PRUEBA_COOLDOWN',
        activadaEn: new Date().toISOString(),
        bloqueadaHasta,
        linea: {
            id: ID_LINEA,
            nombre: 'Línea interna bloqueada'
        }
    });
}

async function obtenerPuertoLibre() {
    return new Promise((resolve, reject) => {
        const servidor = net.createServer();
        servidor.once('error', reject);
        servidor.listen(0, '127.0.0.1', () => {
            const direccion = servidor.address();
            servidor.close(error => {
                if (error) reject(error);
                else resolve(direccion.port);
            });
        });
    });
}

async function iniciarServidor(rutaDatos) {
    const puerto = await obtenerPuertoLibre();
    const proceso = spawn(process.execPath, ['src/bot.js'], {
        cwd: RAIZ_PROYECTO,
        env: {
            ...process.env,
            AUTOSTATUES_DATA_DIR: rutaDatos,
            AUTOSTATUES_PORT: String(puerto)
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    let salida = '';

    await new Promise((resolve, reject) => {
        const temporizador = setTimeout(() => {
            reject(new Error(`El servidor no inició a tiempo. Salida: ${salida}`));
        }, 10000);

        const revisarInicio = fragmento => {
            salida += fragmento.toString();
            if (salida.includes('ZeroOne está listo.')) {
                clearTimeout(temporizador);
                resolve();
            }
        };

        proceso.stdout.on('data', revisarInicio);
        proceso.stderr.on('data', fragmento => {
            salida += fragmento.toString();
        });
        proceso.once('exit', codigo => {
            clearTimeout(temporizador);
            reject(new Error(`El servidor terminó antes de iniciar (código ${codigo}). ${salida}`));
        });
        proceso.once('error', error => {
            clearTimeout(temporizador);
            reject(error);
        });
    });

    return {
        proceso,
        baseURL: `http://127.0.0.1:${puerto}`,
        salida: () => salida
    };
}

async function detenerServidor(servidor) {
    if (!servidor?.proceso || servidor.proceso.exitCode !== null) return;

    await new Promise(resolve => {
        const temporizador = setTimeout(resolve, 5000);
        servidor.proceso.once('exit', () => {
            clearTimeout(temporizador);
            resolve();
        });
        servidor.proceso.kill();
    });
}

async function solicitarJSON(baseURL, ruta, opciones) {
    const respuesta = await fetch(`${baseURL}${ruta}`, opciones);
    const texto = await respuesta.text();
    let datos = null;

    try {
        datos = texto ? JSON.parse(texto) : {};
    } catch {
        datos = { texto };
    }

    return { respuesta, datos };
}

function eliminarTemporalSeguro(rutaTemporal) {
    const raizTemporal = path.resolve(os.tmpdir());
    const objetivo = path.resolve(rutaTemporal);
    const relativa = path.relative(raizTemporal, objetivo);

    if (
        !path.basename(objetivo).startsWith('autostatues-internal-') ||
        !relativa ||
        relativa.startsWith('..') ||
        path.isAbsolute(relativa)
    ) {
        throw new Error(`Se rechazó limpiar una ruta temporal insegura: ${objetivo}`);
    }

    fs.rmSync(objetivo, { recursive: true, force: true });
}

test('middleware defensivo de ZeroOne (sin WhatsApp real)', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'autostatues-internal-')
    );
    let servidor = null;

    prepararDatos(rutaDatos);
    escribirProteccion(
        rutaDatos,
        new Date(Date.now() + 2 * 60 * 1000).toISOString()
    );

    try {
        servidor = await iniciarServidor(rutaDatos);

        await t.test('restaura y expone un enfriamiento persistente', async () => {
            const { respuesta, datos } = await solicitarJSON(
                servidor.baseURL,
                '/progreso'
            );

            assert.equal(respuesta.status, 200);
            assert.equal(datos.proteccionMiddleware.activa, true);
            assert.equal(datos.proteccionMiddleware.codigo, 'PRUEBA_COOLDOWN');
            assert.ok(datos.proteccionMiddleware.segundosRestantes > 0);
        });

        await t.test('bloquea una subida con 429 y Retry-After', async () => {
            const formulario = new FormData();
            formulario.append(
                'imagen',
                new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], {
                    type: 'image/png'
                }),
                'prueba.png'
            );
            const { respuesta, datos } = await solicitarJSON(
                servidor.baseURL,
                '/subir',
                {
                    method: 'POST',
                    headers: {
                        'Idempotency-Key': 'prueba-cooldown-0001'
                    },
                    body: formulario
                }
            );

            assert.equal(respuesta.status, 429);
            assert.equal(datos.codigo, 'MIDDLEWARE_ENFRIAMIENTO');
            assert.ok(Number(respuesta.headers.get('retry-after')) > 0);
            assert.equal(
                fs.readdirSync(path.join(rutaDatos, 'uploads')).length,
                0
            );
        });

        await detenerServidor(servidor);
        servidor = null;
        escribirProteccion(
            rutaDatos,
            new Date(Date.now() - 60 * 1000).toISOString()
        );
        servidor = await iniciarServidor(rutaDatos);

        await t.test('limpia un enfriamiento vencido al reiniciar', async () => {
            const { datos } = await solicitarJSON(servidor.baseURL, '/progreso');
            assert.equal(datos.proteccionMiddleware.activa, false);
            assert.equal(datos.proteccionMiddleware.segundosRestantes, 0);
        });

        await t.test('exige Idempotency-Key para iniciar publicaciones', async () => {
            const { respuesta, datos } = await solicitarJSON(
                servidor.baseURL,
                '/subir',
                { method: 'POST' }
            );

            assert.equal(respuesta.status, 400);
            assert.equal(datos.codigo, 'CLAVE_IDEMPOTENCIA_REQUERIDA');
        });

        await t.test('libera la clave si una solicitud fue rechazada', async () => {
            const opciones = {
                method: 'POST',
                headers: { 'Idempotency-Key': 'prueba-cooldown-0001' }
            };
            const primerIntento = await solicitarJSON(
                servidor.baseURL,
                '/subir',
                opciones
            );
            const segundoIntento = await solicitarJSON(
                servidor.baseURL,
                '/subir',
                opciones
            );

            assert.equal(primerIntento.respuesta.status, 400);
            assert.equal(segundoIntento.respuesta.status, 400);
            assert.notEqual(segundoIntento.datos.codigo, 'SOLICITUD_DUPLICADA');
        });

        await t.test('optimiza y almacena la imagen de una programación', async () => {
            const imagenOriginal = await sharp({
                create: {
                    width: 1600,
                    height: 3200,
                    channels: 3,
                    background: { r: 29, g: 78, b: 216 }
                }
            }).png().toBuffer();
            const formulario = new FormData();
            formulario.append(
                'imagen',
                new Blob([imagenOriginal], { type: 'image/png' }),
                'estado-grande.png'
            );
            formulario.append('texto', 'Prueba de compresión');
            formulario.append('lineas', JSON.stringify([ID_LINEA]));
            formulario.append('modoRitmo', 'secuencial');
            formulario.append('intervaloSegundos', '45');
            formulario.append('variacionSegundos', '5');
            formulario.append('lineasPorGrupo', '1');
            formulario.append('intervaloMinutos', '0');
            formulario.append('hora', '12:34');
            formulario.append('diasSemana', JSON.stringify([1]));

            const creacion = await solicitarJSON(
                servidor.baseURL,
                '/programar',
                {
                    method: 'POST',
                    headers: {
                        'Idempotency-Key': 'prueba-compresion-programada-0001'
                    },
                    body: formulario
                }
            );

            assert.equal(creacion.respuesta.status, 201);
            const id = creacion.datos.programacion.id;
            const respuestaImagen = await fetch(
                `${servidor.baseURL}/programaciones/${id}/imagen`
            );
            const imagenOptimizada = Buffer.from(
                await respuestaImagen.arrayBuffer()
            );
            const metadatos = await sharp(imagenOptimizada).metadata();

            assert.equal(respuestaImagen.status, 200);
            assert.equal(metadatos.format, 'jpeg');
            assert.equal(metadatos.width, 960);
            assert.equal(metadatos.height, 1920);
            assert.ok(imagenOptimizada.length <= Math.floor(1.5 * 1024 * 1024));

            const lista = await solicitarJSON(
                servidor.baseURL,
                '/programaciones'
            );
            const guardada = lista.datos.programaciones.find(
                item => item.id === id
            );
            assert.equal(guardada.nombreArchivo, 'estado-grande.jpg');
        });

        await t.test(
            'expone y actualiza líneas y ritmo de una programación',
            async () => {
                const listaInicial = await solicitarJSON(
                    servidor.baseURL,
                    '/programaciones'
                );
                const inicial = listaInicial.datos.programaciones.find(
                    item => item.id === ID_PROGRAMACION
                );

                assert.equal(listaInicial.respuesta.status, 200);
                assert.deepEqual(inicial.idsLineas, [ID_LINEA_HISTORICA]);
                assert.deepEqual(inicial.lineasProgramadas, [
                    {
                        id: ID_LINEA_HISTORICA,
                        nombre: 'Línea eliminada',
                        existe: false
                    }
                ]);

                const formulario = new FormData();
                formulario.append(
                    'lineas',
                    JSON.stringify([
                        ID_LINEA_HISTORICA,
                        ID_LINEA_SEGUNDA,
                        ID_LINEA,
                        ID_LINEA_SEGUNDA
                    ])
                );
                formulario.append('modoRitmo', 'grupos');
                formulario.append('intervaloSegundos', '60');
                formulario.append('variacionSegundos', '8');
                formulario.append('lineasPorGrupo', '2');
                formulario.append('intervaloMinutos', '7');

                const actualizacion = await solicitarJSON(
                    servidor.baseURL,
                    `/programaciones/${ID_PROGRAMACION}`,
                    {
                        method: 'PUT',
                        body: formulario
                    }
                );
                assert.equal(actualizacion.respuesta.status, 200);

                const listaActualizada = await solicitarJSON(
                    servidor.baseURL,
                    '/programaciones'
                );
                const actualizada = listaActualizada.datos.programaciones.find(
                    item => item.id === ID_PROGRAMACION
                );

                assert.deepEqual(actualizada.idsLineas, [
                    ID_LINEA_HISTORICA,
                    ID_LINEA_SEGUNDA,
                    ID_LINEA
                ]);
                assert.deepEqual(actualizada.lineasProgramadas, [
                    {
                        id: ID_LINEA_HISTORICA,
                        nombre: 'Línea eliminada',
                        existe: false
                    },
                    {
                        id: ID_LINEA_SEGUNDA,
                        nombre: 'Línea interna secundaria',
                        existe: true
                    },
                    {
                        id: ID_LINEA,
                        nombre: 'Línea interna bloqueada',
                        existe: true
                    }
                ]);
                assert.equal(actualizada.modoRitmo, 'grupos');
                assert.equal(actualizada.intervaloSegundos, 60);
                assert.equal(actualizada.variacionSegundos, 8);
                assert.equal(actualizada.lineasPorGrupo, 2);
                assert.equal(actualizada.intervaloMinutos, 7);

                const persistidas = JSON.parse(
                    fs.readFileSync(
                        path.join(
                            rutaDatos,
                            'programados',
                            'programaciones.json'
                        ),
                        'utf8'
                    )
                );
                const persistida = persistidas.find(
                    item => item.id === ID_PROGRAMACION
                );
                assert.deepEqual(
                    persistida.idsLineas,
                    actualizada.idsLineas
                );
                assert.equal(persistida.modoRitmo, 'grupos');
                assert.equal(persistida.intervaloMinutos, 7);
            }
        );

        await t.test(
            'rechaza líneas nuevas desconocidas y ritmos inválidos sin mutar',
            async () => {
                const formularioLinea = new FormData();
                formularioLinea.append(
                    'lineas',
                    JSON.stringify([ID_LINEA, ID_LINEA_DESCONOCIDA])
                );
                const lineaInvalida = await solicitarJSON(
                    servidor.baseURL,
                    `/programaciones/${ID_PROGRAMACION}`,
                    {
                        method: 'PUT',
                        body: formularioLinea
                    }
                );

                assert.equal(lineaInvalida.respuesta.status, 400);
                assert.match(
                    lineaInvalida.datos.error,
                    /línea que ya no existe/i
                );

                const formularioRitmo = new FormData();
                formularioRitmo.append('variacionSegundos', '31');
                const ritmoInvalido = await solicitarJSON(
                    servidor.baseURL,
                    `/programaciones/${ID_PROGRAMACION}`,
                    {
                        method: 'PUT',
                        body: formularioRitmo
                    }
                );

                assert.equal(ritmoInvalido.respuesta.status, 400);

                const lista = await solicitarJSON(
                    servidor.baseURL,
                    '/programaciones'
                );
                const programacion = lista.datos.programaciones.find(
                    item => item.id === ID_PROGRAMACION
                );
                assert.deepEqual(programacion.idsLineas, [
                    ID_LINEA_HISTORICA,
                    ID_LINEA_SEGUNDA,
                    ID_LINEA
                ]);
                assert.equal(programacion.variacionSegundos, 8);
            }
        );

        await t.test(
            'conserva líneas y ritmo cuando la edición no los incluye',
            async () => {
                const formulario = new FormData();
                formulario.append(
                    'texto',
                    'Edición compatible sin selector de líneas.'
                );

                const actualizacion = await solicitarJSON(
                    servidor.baseURL,
                    `/programaciones/${ID_PROGRAMACION}`,
                    {
                        method: 'PUT',
                        body: formulario
                    }
                );
                assert.equal(actualizacion.respuesta.status, 200);

                const lista = await solicitarJSON(
                    servidor.baseURL,
                    '/programaciones'
                );
                const programacion = lista.datos.programaciones.find(
                    item => item.id === ID_PROGRAMACION
                );
                assert.deepEqual(programacion.idsLineas, [
                    ID_LINEA_HISTORICA,
                    ID_LINEA_SEGUNDA,
                    ID_LINEA
                ]);
                assert.equal(programacion.modoRitmo, 'grupos');
                assert.equal(programacion.intervaloSegundos, 60);
                assert.equal(programacion.variacionSegundos, 8);
                assert.equal(programacion.lineasPorGrupo, 2);
                assert.equal(programacion.intervaloMinutos, 7);
                assert.equal(
                    programacion.texto,
                    'Edición compatible sin selector de líneas.'
                );
            }
        );

        await t.test('Alto total es seguro aunque no haya una publicación activa', async () => {
            const { respuesta, datos } = await solicitarJSON(
                servidor.baseURL,
                '/progreso/alto-total',
                { method: 'POST' }
            );

            assert.equal(respuesta.status, 200);
            assert.equal(datos.habiaTrabajo, false);
            assert.equal(datos.pendientesCanceladas, 0);
        });

        await t.test('rechaza confirmaciones de envío obsoletas', async () => {
            const { respuesta, datos } = await solicitarJSON(
                servidor.baseURL,
                '/progreso/confirmar-envio',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        solicitudId:
                            '11111111-1111-4111-8111-111111111111',
                        resultado: 'publicado'
                    })
                }
            );

            assert.equal(respuesta.status, 409);
            assert.equal(
                datos.codigo,
                'SOLICITUD_CONFIRMACION_OBSOLETA'
            );
        });

        await t.test('mantiene los valores seguros predeterminados', async () => {
            const { respuesta, datos } = await solicitarJSON(
                servidor.baseURL,
                '/configuracion'
            );

            assert.equal(respuesta.status, 200);
            assert.equal(datos.modoRitmoPredeterminado, 'secuencial');
            assert.equal(datos.intervaloSegundosPredeterminado, 45);
            assert.equal(datos.variacionSegundosPredeterminada, 5);
            assert.equal(datos.maximoDestinatariosPorEstado, 1000);
            assert.equal(datos.limiteFallosSeguridad, 1);
            assert.equal(datos.temaVisual, 'eva-01');
            assert.equal(datos.mantenerEnSegundoPlano, true);
            assert.equal(datos.iniciarConWindows, true);
            assert.equal(datos.agendarMutuosSinUsuario, false);
        });

        await t.test('guarda las preferencias de ejecución en segundo plano', async () => {
            const guardado = await solicitarJSON(
                servidor.baseURL,
                '/configuracion',
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        modoRitmoPredeterminado: 'secuencial',
                        intervaloSegundosPredeterminado: 45,
                        variacionSegundosPredeterminada: 5,
                        lineasPorGrupoPredeterminado: 10,
                        intervaloMinutosPredeterminado: 5,
                        maximoDestinatariosPorEstado: 1000,
                        limiteFallosSeguridad: 1,
                        notificaciones: true,
                        mantenerEnSegundoPlano: false,
                        iniciarConWindows: false,
                        agendarMutuosSinUsuario: true
                    })
                }
            );

            assert.equal(guardado.respuesta.status, 200);
            assert.equal(
                guardado.datos.configuracion.mantenerEnSegundoPlano,
                false
            );
            assert.equal(
                guardado.datos.configuracion.iniciarConWindows,
                false
            );
            assert.equal(
                guardado.datos.configuracion.agendarMutuosSinUsuario,
                true
            );
        });

        await t.test('permite limitar la base reciente a 500 destinatarios', async () => {
            const { respuesta, datos } = await solicitarJSON(
                servidor.baseURL,
                '/configuracion',
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        modoRitmoPredeterminado: 'secuencial',
                        intervaloSegundosPredeterminado: 45,
                        variacionSegundosPredeterminada: 5,
                        lineasPorGrupoPredeterminado: 10,
                        intervaloMinutosPredeterminado: 5,
                        maximoDestinatariosPorEstado: 500,
                        limiteFallosSeguridad: 1,
                        notificaciones: true
                    })
                }
            );

            assert.equal(respuesta.status, 200);
            assert.equal(datos.configuracion.maximoDestinatariosPorEstado, 500);

            const configuracionGuardada = await solicitarJSON(
                servidor.baseURL,
                '/configuracion'
            );
            assert.equal(
                configuracionGuardada.datos.maximoDestinatariosPorEstado,
                500
            );
        });

        await t.test('guarda únicamente temas visuales permitidos', async () => {
            const guardado = await solicitarJSON(
                servidor.baseURL,
                '/configuracion',
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        modoRitmoPredeterminado: 'secuencial',
                        intervaloSegundosPredeterminado: 45,
                        variacionSegundosPredeterminada: 5,
                        lineasPorGrupoPredeterminado: 10,
                        intervaloMinutosPredeterminado: 5,
                        maximoDestinatariosPorEstado: 500,
                        limiteFallosSeguridad: 1,
                        notificaciones: true,
                        temaVisual: 'eva-05'
                    })
                }
            );

            assert.equal(guardado.respuesta.status, 200);
            assert.equal(guardado.datos.configuracion.temaVisual, 'eva-05');

            const invalido = await solicitarJSON(
                servidor.baseURL,
                '/configuracion',
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        modoRitmoPredeterminado: 'secuencial',
                        intervaloSegundosPredeterminado: 45,
                        variacionSegundosPredeterminada: 5,
                        lineasPorGrupoPredeterminado: 10,
                        intervaloMinutosPredeterminado: 5,
                        maximoDestinatariosPorEstado: 500,
                        limiteFallosSeguridad: 1,
                        notificaciones: true,
                        temaVisual: 'eva-03'
                    })
                }
            );

            assert.equal(invalido.respuesta.status, 400);
            assert.match(invalido.datos.error, /tema visual/i);
        });

        await t.test('rechaza límites fuera de 1 a 1.000 o decimales', async () => {
            for (const limite of [0, 1001, 500.5]) {
                const { respuesta, datos } = await solicitarJSON(
                    servidor.baseURL,
                    '/configuracion',
                    {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            modoRitmoPredeterminado: 'secuencial',
                            intervaloSegundosPredeterminado: 45,
                            variacionSegundosPredeterminada: 5,
                            lineasPorGrupoPredeterminado: 10,
                            intervaloMinutosPredeterminado: 5,
                            maximoDestinatariosPorEstado: limite,
                            limiteFallosSeguridad: 1,
                            notificaciones: true
                        })
                    }
                );

                assert.equal(respuesta.status, 400);
                assert.match(datos.error, /entre 1 y 1000/i);
            }
        });

        await t.test('limita el corte de seguridad a un máximo de 10 líneas', async () => {
            const { respuesta, datos } = await solicitarJSON(
                servidor.baseURL,
                '/configuracion',
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        modoRitmoPredeterminado: 'secuencial',
                        intervaloSegundosPredeterminado: 45,
                        variacionSegundosPredeterminada: 5,
                        lineasPorGrupoPredeterminado: 10,
                        intervaloMinutosPredeterminado: 5,
                        maximoDestinatariosPorEstado: 1000,
                        limiteFallosSeguridad: 11,
                        notificaciones: true
                    })
                }
            );

            assert.equal(respuesta.status, 400);
            assert.match(datos.error, /entre 1 y 10 líneas/i);
        });

        await t.test('excluye una línea pendiente de revisión', async () => {
            const { respuesta, datos } = await solicitarJSON(
                servidor.baseURL,
                '/estado'
            );
            const linea = datos.lineas.find(item => item.id === ID_LINEA);

            assert.equal(respuesta.status, 200);
            assert.equal(linea.requiereRevisionEnvio, true);
            assert.equal(linea.listaParaPublicar, false);
            assert.equal(linea.codigoBloqueoPublicacion, 'REVISION_ENVIO_PENDIENTE');
        });

        await t.test('requiere confirmación humana y conserva otros bloqueos', async () => {
            const rechazo = await solicitarJSON(
                servidor.baseURL,
                `/lineas/${ID_LINEA}/habilitar-publicaciones`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ confirmar: false })
                }
            );
            assert.equal(rechazo.respuesta.status, 400);

            const confirmacion = await solicitarJSON(
                servidor.baseURL,
                `/lineas/${ID_LINEA}/habilitar-publicaciones`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ confirmar: true })
                }
            );
            assert.equal(confirmacion.respuesta.status, 200);
            assert.equal(confirmacion.datos.listaParaPublicar, false);

            const estado = await solicitarJSON(servidor.baseURL, '/estado');
            const linea = estado.datos.lineas.find(item => item.id === ID_LINEA);
            assert.equal(linea.requiereRevisionEnvio, false);
            assert.equal(linea.listaParaPublicar, false);
            assert.equal(linea.codigoBloqueoPublicacion, 'RECONEXION_BLOQUEADA');
        });

        const clavePersistente = 'prueba-ejecucion-persistente-0001';

        await t.test('rechaza una ejecución HTTP duplicada', async () => {
            const ruta = `/programaciones/${ID_PROGRAMACION}/ejecutar`;
            const opciones = {
                method: 'POST',
                headers: { 'Idempotency-Key': clavePersistente }
            };
            const primera = await solicitarJSON(servidor.baseURL, ruta, opciones);
            const duplicada = await solicitarJSON(servidor.baseURL, ruta, opciones);

            assert.equal(primera.respuesta.status, 202);
            assert.equal(duplicada.respuesta.status, 409);
            assert.equal(duplicada.datos.codigo, 'SOLICITUD_DUPLICADA');
        });

        await t.test('no consume una clave cuando el recurso no existe', async () => {
            const opciones = {
                method: 'POST',
                headers: { 'Idempotency-Key': 'prueba-recurso-inexistente-0001' }
            };
            const primera = await solicitarJSON(
                servidor.baseURL,
                '/programaciones/no-existe/ejecutar',
                opciones
            );
            const segunda = await solicitarJSON(
                servidor.baseURL,
                '/programaciones/no-existe/ejecutar',
                opciones
            );

            assert.equal(primera.respuesta.status, 404);
            assert.equal(segunda.respuesta.status, 404);
        });

        await detenerServidor(servidor);
        servidor = null;
        servidor = await iniciarServidor(rutaDatos);

        await t.test('recuerda la idempotencia después de reiniciar', async () => {
            const { respuesta, datos } = await solicitarJSON(
                servidor.baseURL,
                `/programaciones/${ID_PROGRAMACION}/ejecutar`,
                {
                    method: 'POST',
                    headers: { 'Idempotency-Key': clavePersistente }
                }
            );

            assert.equal(respuesta.status, 409);
            assert.equal(datos.codigo, 'SOLICITUD_DUPLICADA');
        });

        await t.test('recuerda el límite de 500 después de reiniciar', async () => {
            const { respuesta, datos } = await solicitarJSON(
                servidor.baseURL,
                '/configuracion'
            );

            assert.equal(respuesta.status, 200);
            assert.equal(datos.maximoDestinatariosPorEstado, 500);
            assert.equal(datos.temaVisual, 'eva-05');
            assert.equal(datos.agendarMutuosSinUsuario, true);
        });
    } finally {
        await detenerServidor(servidor);
        eliminarTemporalSeguro(rutaDatos);
    }
});
