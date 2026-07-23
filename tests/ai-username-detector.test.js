'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    crearDetectorUsuarioIA,
    crearSolicitudChatCompletion,
    crearVentanasMensajesSalientes,
    esUsuarioAutomaticoValido,
    normalizarUsuarioAutomatico,
    parsearRespuestaChatCompletion,
    redactarTextoParaIA,
    validarDeteccionLocal
} = require('../src/ai-username-detector');

function mensaje(chatId, texto, segundos, id, fromMe = true) {
    return {
        key: { fromMe, remoteJid: chatId, id },
        messageTimestamp: segundos,
        message: { conversation: texto }
    };
}

function respuesta(usuario, confianza, indicesEvidencia) {
    return {
        choices: [{
            message: {
                content: JSON.stringify({ usuario, confianza, indicesEvidencia })
            }
        }]
    };
}

test('las reglas automaticas aceptan nombres y rechazan palabras, numeros y codigos', () => {
    for (const usuario of ['rositaflor', 'rositaflor77', 'cliente_77', 'María2026']) {
        assert.equal(normalizarUsuarioAutomatico(usuario), usuario);
        assert.equal(esUsuarioAutomaticoValido(usuario), true);
    }
    for (const invalido of [
        'todo', 'todo123', 'final', 'recibido', 'pendiente', '123456',
        'https://greenvip.net', 'rosa@gmail.com', 'REF123', 'cargaABC',
        'pedido123', 'codigo_azul', 'r_o', '1rosita', 'rosa__flor',
        'rosa_flor_', 'perfecto77', 'cliente123', 'cuenta123',
        'correo123', 'mensaje123', 'telefono123'
    ]) {
        assert.equal(normalizarUsuarioAutomatico(invalido), null, invalido);
        assert.equal(esUsuarioAutomaticoValido(invalido), false, invalido);
    }
});

test('redacta secretos, URL, email y telefono sin borrar usuarios alfanumericos', () => {
    const texto = redactarTextoParaIA([
        'Usuario: rositaflor77',
        'Clave: 123456',
        'https://greenvip.net',
        'soporte@greenvip.net',
        '+595 981 123 456'
    ].join('\n'));

    assert.match(texto, /Usuario: rositaflor77/u);
    assert.match(texto, /Clave: \[SECRETO\]/u);
    assert.match(texto, /\[URL\]/u);
    assert.match(texto, /\[EMAIL\]/u);
    assert.match(texto, /\[TELEFONO\]/u);
    assert.doesNotMatch(texto, /123456|greenvip\.net|981 123 456/u);
});

test('agrupa solo salientes del mismo chat y corta por gap, cantidad y caracteres', () => {
    const base = 1_700_000_000;
    const mensajes = [
        mensaje('a@s.whatsapp.net', 'uno valido', base, 'a1'),
        mensaje('b@s.whatsapp.net', 'otro valido', base + 1, 'b1'),
        mensaje('a@s.whatsapp.net', 'dos valido', base + 2, 'a2'),
        mensaje('a@s.whatsapp.net', 'ignorado entrante', base + 3, 'a3', false),
        mensaje('grupo@g.us', 'ignorado grupo', base + 4, 'g1'),
        mensaje('a@s.whatsapp.net', 'despues del gap', base + 603, 'a4')
    ];
    const ventanas = crearVentanasMensajesSalientes(mensajes, {
        maxMensajes: 2,
        maxCaracteres: 200,
        gapMs: 600_000
    });

    assert.equal(ventanas.length, 3);
    assert.deepEqual(
        ventanas.map(ventana => [ventana.chatId, ventana.mensajes.map(item => item.id)]),
        [
            ['a@s.whatsapp.net', ['a1', 'a2']],
            ['a@s.whatsapp.net', ['a4']],
            ['b@s.whatsapp.net', ['b1']]
        ]
    );
    assert.ok(ventanas.every(ventana => ventana.mensajes.length <= 2));
    assert.ok(ventanas.every(ventana => (
        ventana.mensajes.reduce((total, item) => total + item.texto.length, 0) <= 200
    )));
});

test('cada ventana respeta como maximo 8 mensajes y 6000 caracteres', () => {
    const mensajes = Array.from({ length: 20 }, (_, indice) => (
        mensaje('chat@s.whatsapp.net', `usuario${indice} ${'x'.repeat(990)}`, 1000 + indice, `m${indice}`)
    ));
    const ventanas = crearVentanasMensajesSalientes(mensajes);
    assert.ok(ventanas.length > 1);
    for (const ventana of ventanas) {
        assert.ok(ventana.mensajes.length <= 8);
        const caracteres = ventana.mensajes
            .reduce((total, item) => total + item.texto.length, 0);
        assert.ok(caracteres <= 6000);
    }

    const borde = Array.from({ length: 9 }, (_, indice) => mensaje(
        'borde@s.whatsapp.net',
        indice === 7 ? 'rositaflor' : indice === 8 ? 'todo listo' : `contexto ${indice}`,
        2000 + indice,
        `b${indice}`
    ));
    const ventanasBorde = crearVentanasMensajesSalientes(borde);
    assert.ok(ventanasBorde.some(ventana => {
        const ids = ventana.mensajes.map(item => item.id);
        return ids.includes('b7') && ids.includes('b8');
    }), 'el solape conserva usuario + confirmación al cruzar el corte de 8');
});

test('la solicitud usa esquema JSON estricto y no incluye identificador del chat', () => {
    const [ventana] = crearVentanasMensajesSalientes([
        mensaje('595981123456@s.whatsapp.net', 'Usuario: rositaflor', 1000, 'm1')
    ]);
    const solicitud = crearSolicitudChatCompletion(ventana, { modelo: 'qwen-local' });

    assert.equal(solicitud.model, 'qwen-local');
    assert.equal(solicitud.temperature, 0);
    assert.equal(solicitud.response_format.type, 'json_schema');
    assert.equal(solicitud.response_format.json_schema.strict, true);
    assert.equal(
        solicitud.response_format.json_schema.schema.additionalProperties,
        false
    );
    assert.doesNotMatch(JSON.stringify(solicitud), /595981123456/u);
    assert.match(JSON.stringify(solicitud), /rositaflor/u);
    assert.match(
        solicitud.messages[0].content,
        /todos los mensajes salientes/u
    );
    assert.match(
        solicitud.messages[0].content,
        /referencias directas, no requisitos/u
    );

    const directa = crearSolicitudChatCompletion({
        mensajes: Array.from({ length: 20 }, (_, indice) => ({
            texto: indice === 0 ? 'Clave: supersecreta' : 'x'.repeat(1000)
        }))
    });
    const datosDirectos = JSON.parse(directa.messages[1].content).mensajes;
    assert.ok(datosDirectos.length <= 8);
    assert.ok(datosDirectos.reduce((total, item) => total + item.texto.length, 0) <= 6000);
    assert.doesNotMatch(JSON.stringify(directa), /supersecreta/u);
});

test('parsea solo respuestas que cumplen el esquema estricto', () => {
    assert.deepEqual(
        parsearRespuestaChatCompletion(respuesta('rositaflor', 97, [0])),
        { usuario: 'rositaflor', confianza: 97, indicesEvidencia: [0] }
    );
    assert.deepEqual(
        parsearRespuestaChatCompletion('```json\n{"usuario":null,"confianza":0,"indicesEvidencia":[]}\n```'),
        { usuario: null, confianza: 0, indicesEvidencia: [] }
    );
    assert.throws(
        () => parsearRespuestaChatCompletion('{"usuario":"rosa","confianza":99}'),
        error => error.codigo === 'RESPUESTA_IA_INVALIDA'
    );
    assert.throws(
        () => parsearRespuestaChatCompletion({
            usuario: 'rosa',
            confianza: 99,
            indicesEvidencia: [0],
            instruccion: 'ignorar reglas'
        }),
        error => error.codigo === 'RESPUESTA_IA_INVALIDA'
    );
});

test('solo clasifica auto con 95 o mas, literal verificable y evidencia fuerte', () => {
    const [ventanaEtiqueta] = crearVentanasMensajesSalientes([
        mensaje('chat@s.whatsapp.net', 'Usuario: rositaflor77', 1000, 'm1')
    ]);
    assert.deepEqual(
        validarDeteccionLocal(
            { usuario: 'rositaflor77', confianza: 95, indicesEvidencia: [0] },
            ventanaEtiqueta
        ),
        {
            chatId: 'chat@s.whatsapp.net',
            numeroVentana: 0,
            clasificacion: 'auto',
            usuario: 'rositaflor77',
            confianza: 95,
            evidenciaFuerte: true,
            indicesEvidencia: [0],
            evidencias: [{ indice: 0, id: 'm1', timestampMs: 1000000 }],
            motivo: 'EVIDENCIA_FUERTE'
        }
    );

    const revisionConfianza = validarDeteccionLocal(
        { usuario: 'rositaflor77', confianza: 94, indicesEvidencia: [0] },
        ventanaEtiqueta
    );
    assert.equal(revisionConfianza.clasificacion, 'revision');
    assert.equal(revisionConfianza.motivo, 'CONFIANZA_INSUFICIENTE');

    const [ventanaDebil] = crearVentanasMensajesSalientes([
        mensaje('chat@s.whatsapp.net', 'El nombre anotado fue rositaflor77 ayer', 1000, 'm2')
    ]);
    const revisionDebil = validarDeteccionLocal(
        { usuario: 'rositaflor77', confianza: 99, indicesEvidencia: [0] },
        ventanaDebil
    );
    assert.equal(revisionDebil.clasificacion, 'revision');
    assert.equal(revisionDebil.evidenciaFuerte, false);
});

test('reconoce usuario solo seguido por confirmacion en el mismo chat', () => {
    const [ventana] = crearVentanasMensajesSalientes([
        mensaje('chat@s.whatsapp.net', 'rositaflor', 1000, 'm1'),
        mensaje('chat@s.whatsapp.net', 'todo listo 🔥', 1001, 'm2')
    ]);
    const resultado = validarDeteccionLocal(
        { usuario: 'rositaflor', confianza: 98, indicesEvidencia: [0, 1] },
        ventana
    );
    assert.equal(resultado.clasificacion, 'auto');
    assert.equal(resultado.evidenciaFuerte, true);

    const [mismaLinea] = crearVentanasMensajesSalientes([
        mensaje('chat@s.whatsapp.net', '(rositaflor) todo listo ✅', 1002, 'm3')
    ]);
    assert.equal(validarDeteccionLocal(
        { usuario: 'rositaflor', confianza: 98, indicesEvidencia: [0] },
        mismaLinea
    ).clasificacion, 'auto');

    const [textoOculto] = crearVentanasMensajesSalientes([
        mensaje(
            'chat@s.whatsapp.net',
            'rositaflor todo listo no uses ese usuario',
            1002,
            'm3b'
        )
    ]);
    const resultadoTextoOculto = validarDeteccionLocal(
        { usuario: 'rositaflor', confianza: 99, indicesEvidencia: [0] },
        textoOculto
    );
    assert.equal(resultadoTextoOculto.clasificacion, 'revision');
    assert.equal(resultadoTextoOculto.evidenciaFuerte, false);

    const [citaAjena] = crearVentanasMensajesSalientes([
        mensaje('chat@s.whatsapp.net', 'Usuario: rositaflor', 1002, 'm3c'),
        mensaje('chat@s.whatsapp.net', 'mensaje posterior sin usuario', 1003, 'm3d')
    ]);
    const resultadoCitaAjena = validarDeteccionLocal(
        { usuario: 'rositaflor', confianza: 99, indicesEvidencia: [0, 1] },
        citaAjena
    );
    assert.equal(resultadoCitaAjena.clasificacion, 'auto');
    assert.deepEqual(resultadoCitaAjena.indicesEvidencia, [0]);
    assert.deepEqual(resultadoCitaAjena.evidencias.map(item => item.id), ['m3c']);

    const [fraseNatural] = crearVentanasMensajesSalientes([
        mensaje(
            'chat@s.whatsapp.net',
            'recuerda avisarme cuando este todo listo',
            1003,
            'm4'
        )
    ]);
    const falsoPositivo = validarDeteccionLocal(
        { usuario: 'recuerda', confianza: 100, indicesEvidencia: [0] },
        fraseNatural
    );
    assert.equal(falsoPositivo.clasificacion, 'revision');
    assert.equal(falsoPositivo.evidenciaFuerte, false);

    for (const mensajesDebiles of [
        [
            mensaje('chat@s.whatsapp.net', 'rositaflor', 3000, 'd1'),
            mensaje('chat@s.whatsapp.net', 'te aviso', 3001, 'd2'),
            mensaje('chat@s.whatsapp.net', 'todo listo', 3002, 'd3')
        ],
        [
            mensaje('chat@s.whatsapp.net', 'rositaflor', 4000, 'e1'),
            mensaje('chat@s.whatsapp.net', 'todo listo cuando puedas', 4001, 'e2')
        ],
        [
            mensaje('chat@s.whatsapp.net', 'rositaflor', 5000, 'f1'),
            mensaje('chat@s.whatsapp.net', 'todo listo', 5201, 'f2')
        ]
    ]) {
        const [ventanaDebil] = crearVentanasMensajesSalientes(mensajesDebiles);
        const resultadoDebil = validarDeteccionLocal(
            {
                usuario: 'rositaflor',
                confianza: 100,
                indicesEvidencia: ventanaDebil.mensajes.map((_, indice) => indice)
            },
            ventanaDebil
        );
        assert.equal(resultadoDebil.clasificacion, 'revision');
        assert.equal(resultadoDebil.evidenciaFuerte, false);
    }
});

test('descarta alucinaciones, indices de otro mensaje y palabras invalidas', () => {
    const [ventana] = crearVentanasMensajesSalientes([
        mensaje('chat@s.whatsapp.net', 'Usuario: rositaflor', 1000, 'm1'),
        mensaje('chat@s.whatsapp.net', 'todo listo', 1001, 'm2')
    ]);
    for (const propuesta of [
        { usuario: 'inventado77', confianza: 100, indicesEvidencia: [0] },
        { usuario: 'rositaflor', confianza: 100, indicesEvidencia: [1] },
        { usuario: 'todo', confianza: 100, indicesEvidencia: [1] }
    ]) {
        const resultado = validarDeteccionLocal(propuesta, ventana);
        assert.equal(resultado.clasificacion, 'ninguno');
        assert.equal(resultado.usuario, null);
    }
});

test('un usuario incrustado por el CRM siempre requiere revisión humana', () => {
    const [ventana] = crearVentanasMensajesSalientes([
        mensaje(
            'chat@s.whatsapp.net',
            '¡Genial acreditado rositaflor77! Ya quedó todo actualizado gracias por la confianza ❤️',
            1000,
            'crm-1'
        )
    ]);
    const resultado = validarDeteccionLocal(
        {
            usuario: 'rositaflor77',
            confianza: 99,
            indicesEvidencia: [0]
        },
        ventana
    );
    assert.equal(resultado.clasificacion, 'revision');
    assert.equal(resultado.evidenciaFuerte, false);
    assert.equal(resultado.usuario, 'rositaflor77');
});

test('no toma menciones ni segmentos de rutas como evidencia literal', () => {
    for (const texto of [
        '@rositaflor todo listo',
        '/rositaflor todo listo',
        'https://sitio/rositaflor todo listo',
        'Usuario: rositaflor@servidor',
        'Usuario: rositaflor-casino',
        'Usuario: rositaflor+casino'
    ]) {
        const [ventana] = crearVentanasMensajesSalientes([
            mensaje('chat@s.whatsapp.net', texto, 1000, texto)
        ]);
        const resultado = validarDeteccionLocal(
            { usuario: 'rositaflor', confianza: 100, indicesEvidencia: [0] },
            ventana
        );
        assert.equal(resultado.clasificacion, 'ninguno', texto);
    }
});

test('el detector acepta cliente chat completions y procesa ventanas secuencialmente', async () => {
    let activas = 0;
    let maximoActivas = 0;
    const solicitudes = [];
    const cliente = {
        chat: {
            completions: {
                async create(solicitud) {
                    activas += 1;
                    maximoActivas = Math.max(maximoActivas, activas);
                    solicitudes.push(solicitud);
                    await new Promise(resolve => setTimeout(resolve, 5));
                    activas -= 1;
                    const datos = JSON.parse(solicitud.messages[1].content);
                    const usuario = datos.mensajes[0].texto.split(':').at(-1).trim();
                    return respuesta(usuario, 98, [0]);
                }
            }
        }
    };
    const detector = crearDetectorUsuarioIA({ cliente, timeoutMs: 1000 });
    const progreso = [];
    const resultado = await detector.analizarMensajes([
        mensaje('a@s.whatsapp.net', 'Usuario: rositaflor', 1000, 'a1'),
        mensaje('b@s.whatsapp.net', 'Usuario: cliente_77', 1000, 'b1')
    ], {
        onProgress: dato => progreso.push({
            procesadas: dato.procesadas,
            idsMensajes: dato.idsMensajes
        })
    });

    assert.equal(maximoActivas, 1);
    assert.equal(solicitudes.length, 2);
    assert.equal(resultado.totalVentanas, 2);
    assert.deepEqual(resultado.resultados.map(item => item.clasificacion), ['auto', 'auto']);
    assert.deepEqual(progreso, [
        { procesadas: 1, idsMensajes: ['a1'] },
        { procesadas: 2, idsMensajes: ['b1'] }
    ]);
});

test('dos llamadas concurrentes al mismo detector comparten una sola cola', async () => {
    let activas = 0;
    let maximoActivas = 0;
    const cliente = async solicitud => {
        activas += 1;
        maximoActivas = Math.max(maximoActivas, activas);
        await new Promise(resolve => setTimeout(resolve, 10));
        activas -= 1;
        const datos = JSON.parse(solicitud.messages[1].content);
        const usuario = datos.mensajes[0].texto.split(':').at(-1).trim();
        return respuesta(usuario, 98, [0]);
    };
    const detector = crearDetectorUsuarioIA({ cliente, timeoutMs: 1000 });
    const crearVentana = (chat, usuario) => crearVentanasMensajesSalientes([
        mensaje(chat, `Usuario: ${usuario}`, 1000, chat)
    ])[0];

    const resultados = await Promise.all([
        detector.analizarVentana(crearVentana('a@s.whatsapp.net', 'rositaflor')),
        detector.analizarVentana(crearVentana('b@s.whatsapp.net', 'cliente_77'))
    ]);
    assert.equal(maximoActivas, 1);
    assert.deepEqual(resultados.map(item => item.clasificacion), ['auto', 'auto']);
});

test('AbortSignal cancela incluso si el cliente ignora la señal', async () => {
    const cliente = () => new Promise(() => {});
    const detector = crearDetectorUsuarioIA({ cliente, timeoutMs: 5000 });
    const controlador = new AbortController();
    const promesa = detector.analizarMensajes([
        mensaje('a@s.whatsapp.net', 'Usuario: rositaflor', 1000, 'a1')
    ], { signal: controlador.signal });
    setTimeout(() => controlador.abort(), 10);
    await assert.rejects(promesa, error => error.name === 'AbortError');
});

test('una señal ya abortada no bloquea las inferencias siguientes', async () => {
    let llamadas = 0;
    const detector = crearDetectorUsuarioIA({
        cliente: solicitud => {
            llamadas += 1;
            const datos = JSON.parse(solicitud.messages[1].content);
            const usuario = datos.mensajes[0].texto.split(':').at(-1).trim();
            return respuesta(usuario, 98, [0]);
        },
        timeoutMs: 1000
    });
    const crearVentana = (chat, usuario) => crearVentanasMensajesSalientes([
        mensaje(chat, `Usuario: ${usuario}`, 1000, chat)
    ])[0];
    const controlador = new AbortController();
    controlador.abort();

    await assert.rejects(
        detector.analizarVentana(
            crearVentana('cancelado@s.whatsapp.net', 'rositaflor'),
            { signal: controlador.signal }
        ),
        error => error.name === 'AbortError'
    );

    const siguiente = await Promise.race([
        detector.analizarVentana(
            crearVentana('activo@s.whatsapp.net', 'cliente_77')
        ),
        new Promise((resolve, reject) => {
            const temporizador = setTimeout(
                () => reject(new Error('La cola quedó bloqueada.')),
                250
            );
            temporizador.unref?.();
        })
    ]);

    assert.equal(llamadas, 1);
    assert.equal(siguiente.usuario, 'cliente_77');
    assert.equal(siguiente.clasificacion, 'auto');
});

test('el timeout detiene un cliente bloqueado con un codigo distinguible', async () => {
    const detector = crearDetectorUsuarioIA({
        cliente: () => new Promise(() => {}),
        timeoutMs: 20
    });
    await assert.rejects(
        detector.analizarMensajes([
            mensaje('a@s.whatsapp.net', 'Usuario: rositaflor', 1000, 'a1')
        ]),
        error => error.codigo === 'IA_TIMEOUT'
    );
});
