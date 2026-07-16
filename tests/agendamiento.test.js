'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');

const {
    agregarMarcadorMutuo,
    crearNombreGestionado,
    crearServicioAgendamiento,
    esNombreGestionado,
    indexarConexiones,
    normalizarPalabrasClaveUsuario,
    normalizarTelefono,
    obtenerPrefijoLinea,
    parsearPlantillaGreenvip,
    parsearUsuarioPorPalabrasClave
} = require('../src/agendamiento');

function plantilla(usuario, conCeroAncho = false) {
    const invisible = conCeroAncho ? '\u200b' : '';
    return [
        '¡Genial! 😍💥',
        'Cualquier duda que tengas, estoy para ayudarte 😉🔥',
        `👤${invisible}Usuario: ${usuario}`,
        `🔐${invisible}Clave: 123456`,
        `📡${invisible}Enlace: [https://greenvip.net](https://greenvip.net/) 🌐`
    ].join('\r\n');
}

function mensajeUsuario(numero, usuario) {
    return {
        key: {
            fromMe: true,
            remoteJid: `${numero}@s.whatsapp.net`
        },
        message: { conversation: plantilla(usuario, true) }
    };
}

function mensajeUsuarioConFuente(numero, usuario, messageTimestamp, id) {
    const mensaje = mensajeUsuario(numero, usuario);
    if (messageTimestamp !== undefined) mensaje.messageTimestamp = messageTimestamp;
    if (id !== undefined) mensaje.key.id = id;
    return mensaje;
}

function estadoPublicado(numero) {
    return {
        key: {
            fromMe: false,
            remoteJid: 'status@broadcast',
            participant: `${numero}@s.whatsapp.net`
        },
        message: { imageMessage: { caption: 'Estado normal' } }
    };
}

function respuestaJson(datos, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
            return datos;
        }
    };
}

function metadataContacto(id) {
    return {
        sources: [{ type: 'CONTACT', id, etag: `etag-source-${id}` }]
    };
}

function solicitudHttp(url, metodo = 'GET') {
    return new Promise((resolve, reject) => {
        const peticion = http.request(url, { method: metodo }, respuesta => {
            respuesta.resume();
            respuesta.on('end', () => resolve(respuesta.statusCode));
        });
        peticion.on('error', reject);
        peticion.end();
    });
}

function crearTemporal(t) {
    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'autostatues-agenda-'));
    t.after(() => fs.rmSync(carpeta, { recursive: true, force: true }));
    return path.join(carpeta, 'agendamiento.json');
}

test('el parser reconoce solamente la plantilla acordada y no expone la clave', () => {
    const resultado = parsearPlantillaGreenvip(plantilla('cliente_77', true));
    assert.deepEqual(resultado, { usuario: 'cliente_77' });
    assert.equal(JSON.stringify(resultado).includes('123456'), false);
    assert.equal(JSON.stringify(resultado).toLowerCase().includes('clave'), false);

    assert.equal(
        parsearPlantillaGreenvip(plantilla('cliente_77').replace('123456', '654321')),
        null
    );
    assert.equal(
        parsearPlantillaGreenvip(
            plantilla('cliente_77').replaceAll('greenvip.net', 'sitio-falso.example')
        ),
        null
    );
    assert.equal(
        parsearPlantillaGreenvip(plantilla('cliente 77')),
        null,
        'un texto ambiguo no debe convertirse en usuario'
    );
    assert.deepEqual(
        parsearPlantillaGreenvip(
            plantilla('cliente_78').replace(
                '[https://greenvip.net](https://greenvip.net/)',
                'https://greenvip.net/'
            )
        ),
        { usuario: 'cliente_78' }
    );
});

test('las palabras clave son literales, configurables y se conservan sin guardar chats', async t => {
    assert.deepEqual(
        normalizarPalabrasClaveUsuario(
            ' Usuario: \r\nusuario:\n Cuenta (+): \nTu usuario es:'
        ),
        ['Usuario:', 'Cuenta (+):', 'Tu usuario es:']
    );
    assert.deepEqual(
        parsearUsuarioPorPalabrasClave(
            'Datos\nCuenta (+): jugador_88\nClave: secreta',
            ['Cuenta (+):']
        ),
        { usuario: 'jugador_88' }
    );
    assert.equal(
        parsearUsuarioPorPalabrasClave(
            'Cuenta .*: no_debe_coincidir',
            ['Cuenta (+):']
        ),
        null,
        'las frases configuradas nunca se interpretan como regex'
    );

    const rutaDatos = crearTemporal(t);
    const servicio = crearServicioAgendamiento({ rutaDatos });
    const configuracion = servicio.configurarPalabrasClaveUsuario([
        'Alias del jugador:',
        'Usuario:'
    ]);
    assert.deepEqual(
        configuracion.palabrasClave,
        ['Alias del jugador:', 'Usuario:']
    );

    await servicio.registrarMensajes(
        { id: 'linea-palabras', nombre: 'Línea 31' },
        [{
            key: {
                fromMe: true,
                remoteJid: '595981230031@s.whatsapp.net'
            },
            message: {
                conversation:
                    'Bienvenido\nAlias del jugador: cliente_31\nClave: no-guardar'
            }
        }]
    );

    const vista = servicio.obtenerVista({
        id: 'linea-palabras',
        nombre: 'Línea 31'
    });
    assert.equal(vista.candidatos[0].usuario, 'cliente_31');
    servicio.cerrar();

    const persistido = fs.readFileSync(rutaDatos, 'utf8');
    assert.equal(persistido.includes('Alias del jugador:'), true);
    assert.equal(persistido.includes('Bienvenido'), false);
    assert.equal(persistido.includes('no-guardar'), false);

    const recargado = crearServicioAgendamiento({ rutaDatos });
    assert.deepEqual(
        recargado.obtenerConfiguracionBusqueda().palabrasClave,
        ['Alias del jugador:', 'Usuario:']
    );
    recargado.cerrar();
});

test('normaliza teléfonos y genera nombres idempotentes desde el último número de línea', () => {
    assert.equal(normalizarTelefono('0981 123 456', '595'), '+595981123456');
    assert.equal(normalizarTelefono('595981123456:4@s.whatsapp.net', '595'), '+595981123456');
    assert.equal(normalizarTelefono('595981123456@hosted', '595'), '+595981123456');
    assert.equal(normalizarTelefono('595981123456@lid', '595'), null);
    assert.equal(normalizarTelefono('595981123456@hosted.lid', '595'), null);
    assert.equal(normalizarTelefono('123456789@s.whatsapp.net', '595'), '+123456789');
    assert.equal(normalizarTelefono('123456789', '595'), '+595123456789');
    assert.equal(normalizarTelefono('00 54 9 11 2345-6789', '595'), '+5491123456789');
    assert.equal(normalizarTelefono('123', '595'), null);
    assert.equal(obtenerPrefijoLinea('Sucursal 2 · Línea 028'), 'L28');
    assert.equal(obtenerPrefijoLinea('L1 2.0'), 'L1');
    assert.equal(obtenerPrefijoLinea('Caja · L 0028 · secundaria 7'), 'L28');
    assert.equal(crearNombreGestionado('TT 28', 'cliente_77'), 'L28 cliente_77');
    assert.equal(crearNombreGestionado('TT 28', 'cliente_77', true), 'L28 cliente_77 🟣');
    assert.equal(agregarMarcadorMutuo('María 🟣'), 'María 🟣');
    assert.equal(esNombreGestionado('L28 cliente_77 🟣'), true);
    assert.equal(esNombreGestionado('María 🟣'), false);
});

test('conserva una señal que llega antes que el usuario y persiste sin texto ni contraseña', async t => {
    const rutaDatos = crearTemporal(t);
    const linea = { id: 'linea-28', nombre: 'TT 28' };
    const servicio = crearServicioAgendamiento({ rutaDatos, codigoPais: '595' });

    const primera = await servicio.registrarPublicadoresEstado(
        linea,
        [estadoPublicado('595981111111')]
    );
    assert.equal(primera.detectados, 1);
    let vista = servicio.obtenerVista(linea);
    assert.equal(vista.candidatos[0].usuario, null);
    assert.equal(vista.candidatos[0].mutuo, true);
    assert.ok(vista.candidatos[0].senales.publicoEstado);

    await servicio.registrarMensajes(
        linea,
        [mensajeUsuario('595981111111', 'jugador_1')]
    );
    vista = servicio.obtenerVista(linea);
    assert.equal(vista.candidatos.length, 1);
    assert.equal(vista.candidatos[0].nombreObjetivo, 'L28 jugador_1 🟣');

    servicio.cerrar();
    const persistido = fs.readFileSync(rutaDatos, 'utf8');
    assert.equal(persistido.includes('123456'), false);
    assert.equal(persistido.includes('greenvip.net'), false);
    assert.equal(persistido.includes('Cualquier duda'), false);

    const recargado = crearServicioAgendamiento({ rutaDatos, codigoPais: '595' });
    const vistaRecargada = recargado.obtenerVista(linea);
    assert.equal(vistaRecargada.candidatos[0].usuario, 'jugador_1');
    assert.equal(vistaRecargada.candidatos[0].mutuo, true);
    recargado.cerrar();
});

test('usa el chat remoto, conserva LID pendientes y sólo acepta lecturas reales', async t => {
    const rutaDatos = crearTemporal(t);
    const linea = { id: 'linea-31', nombre: 'Línea 31' };
    const servicio = crearServicioAgendamiento({ rutaDatos, codigoPais: '595' });
    const resolverJid = jid => {
        if (jid === '111111@lid') return '595981999999@s.whatsapp.net';
        if (jid === '222222@hosted.lid') return null;
        if (jid === '333333@lid') return '333333@hosted.lid';
        return null;
    };

    const mensajeConAlternativo = mensajeUsuario('111111', 'usa_chat_remoto');
    mensajeConAlternativo.key.remoteJid = '111111@lid';
    // En mensajes fromMe este campo puede ser el PN propio, no el destinatario.
    mensajeConAlternativo.key.remoteJidAlt = '595981310001@s.whatsapp.net';
    const mensajeLidNoResuelto = mensajeUsuario('222222', 'no_guardar');
    mensajeLidNoResuelto.key.remoteJid = '222222@hosted.lid';
    const mensajeSigueSiendoLid = mensajeUsuario('333333', 'tampoco_guardar');
    mensajeSigueSiendoLid.key.remoteJid = '333333@lid';
    await servicio.registrarMensajes(
        linea,
        [mensajeConAlternativo, mensajeLidNoResuelto, mensajeSigueSiendoLid],
        resolverJid
    );

    await servicio.registrarPublicadoresEstado(linea, [{
        ...estadoPublicado('595981319999'),
        participantAlt: '595981310002@hosted',
        participant: '444444@lid'
    }], resolverJid);
    const estadoLid = estadoPublicado('555555');
    estadoLid.key.participant = '555555@lid';
    await servicio.registrarPublicadoresEstado(linea, [estadoLid], resolverJid);

    let validaciones = 0;
    const actualizacionBase = {
        key: { id: 'estado-propio', remoteJid: 'status@broadcast' },
        receipt: { userJid: '595981310003@s.whatsapp.net' }
    };
    const resultadoVistas = await servicio.registrarVistasEstado(
        linea,
        [
            { ...actualizacionBase, receipt: { ...actualizacionBase.receipt, receiptTimestamp: 10 } },
            { ...actualizacionBase, receipt: { ...actualizacionBase.receipt, readTimestamp: 0 } },
            { ...actualizacionBase, receipt: { ...actualizacionBase.receipt, readTimestamp: { low: 10, high: 0 } } },
            {
                ...actualizacionBase,
                key: { ...actualizacionBase.key, id: 'estado-propio-2' },
                receipt: { userJid: '666666@lid', readTimestamp: 20 }
            }
        ],
        () => {
            validaciones += 1;
            return true;
        },
        resolverJid
    );

    const telefonos = servicio.obtenerVista(linea).candidatos.map(item => item.telefono).sort();
    assert.deepEqual(telefonos, [
        '+595981310002',
        '+595981310003',
        '+595981999999'
    ]);
    assert.equal(telefonos.includes('+595981310001'), false, 'remoteJidAlt propio se ignora');
    assert.equal(resultadoVistas.detectados, 2);
    assert.equal(validaciones, 2, 'entregas y timestamps vacíos ni siquiera validan el ID');
    assert.equal(servicio.obtenerVista(linea).totales.jidsPendientes, 4);

    const mapeos = {
        '222222@hosted.lid': '595981310004@s.whatsapp.net',
        '333333@lid': '595981310005@s.whatsapp.net',
        '555555@lid': '595981310006@s.whatsapp.net',
        '666666@lid': '595981310007@s.whatsapp.net'
    };
    const resueltos = await servicio.resolverPendientesJid(
        linea,
        jid => mapeos[jid] || null
    );
    assert.equal(resueltos.resueltos, 4);
    assert.equal(resueltos.pendientes, 0);
    const vistaResuelta = servicio.obtenerVista(linea);
    assert.equal(
        vistaResuelta.candidatos.find(item => item.telefono === '+595981310004').usuario,
        'no_guardar'
    );
    assert.equal(
        vistaResuelta.candidatos.find(item => item.telefono === '+595981310006').mutuo,
        true
    );
    assert.equal(
        vistaResuelta.candidatos.find(item => item.telefono === '+595981310007').mutuo,
        true
    );
    servicio.cerrar();
});

test('indexa teléfonos canónicos sin esconder contactos duplicados', () => {
    const personas = [
        {
            resourceName: 'people/a',
            phoneNumbers: [{ value: '0981 222 333' }]
        },
        {
            resourceName: 'people/b',
            phoneNumbers: [{ canonicalForm: '+595981222333' }]
        }
    ];
    const indice = indexarConexiones(personas, '595');
    assert.equal(indice.get('+595981222333').length, 2);
});

test('ultimoResultado sólo se invalida por usuario, primer mutuo o prefijo diferente', async t => {
    const rutaDatos = crearTemporal(t);
    const linea = { id: 'linea-invalida', nombre: 'Equipo 28' };
    const servicio = crearServicioAgendamiento({ rutaDatos });
    await servicio.registrarMensajes(linea, [
        mensajeUsuario('595983000001', 'personal_uno'),
        mensajeUsuario('595983000002', 'segundo')
    ]);
    const datosLinea = servicio.estado.lineas[linea.id];
    const personal = datosLinea.candidatos['+595983000001'];
    const segundo = datosLinea.candidatos['+595983000002'];
    personal.ultimoResultado = { tipo: 'actualizado', nombre: 'María' };
    segundo.ultimoResultado = { tipo: 'creado', nombre: 'L28 segundo' };

    let vista = servicio.obtenerVista(linea);
    assert.equal(
        vista.candidatos.find(item => item.usuario === 'personal_uno').sincronizado,
        true,
        'un nombre personal actualizado ya está sincronizado aunque no coincida con nombreObjetivo'
    );

    await servicio.registrarPublicadoresEstado(linea, [estadoPublicado('595983000001')]);
    assert.equal(personal.ultimoResultado, null, 'false → true en mutuo invalida una vez');
    personal.ultimoResultado = { tipo: 'actualizado', nombre: 'María 🟣' };

    await servicio.registrarPublicadoresEstado(linea, [estadoPublicado('595983000001')]);
    assert.equal(personal.ultimoResultado.tipo, 'actualizado', 'una señal repetida no invalida');
    await servicio.registrarMensajes(linea, [mensajeUsuario('595983000001', 'personal_uno')]);
    assert.equal(personal.ultimoResultado.tipo, 'actualizado', 'el mismo usuario no invalida');

    vista = servicio.obtenerVista({ id: linea.id, nombre: 'Renombrada 28' });
    assert.equal(
        vista.candidatos.find(item => item.usuario === 'segundo').ultimoResultado.tipo,
        'creado',
        'cambiar el texto manteniendo L28 no invalida'
    );

    await servicio.registrarMensajes(
        { id: linea.id, nombre: 'Renombrada 28' },
        [mensajeUsuario('595983000001', 'personal_nuevo')]
    );
    assert.equal(personal.ultimoResultado, null, 'cambiar usuario invalida');

    servicio.obtenerVista({ id: linea.id, nombre: 'Renombrada 29' });
    assert.equal(segundo.ultimoResultado, null, 'cambiar el prefijo L invalida');
    servicio.cerrar();
});

test('elige el usuario más reciente aunque historial llegue invertido o en chunks tardíos', async t => {
    const rutaDatos = crearTemporal(t);
    const linea = { id: 'linea-history', nombre: 'Línea 15' };
    const servicio = crearServicioAgendamiento({ rutaDatos });

    await servicio.registrarMensajes(linea, [
        mensajeUsuarioConFuente(
            '595984000001',
            'history_nuevo',
            { low: 1700000300, high: 0, unsigned: true },
            'MSG-NUEVO'
        ),
        mensajeUsuarioConFuente('595984000001', 'history_viejo', '1700000100', 'MSG-VIEJO')
    ], { origen: 'historial' });
    let candidato = servicio.estado.lineas[linea.id].candidatos['+595984000001'];
    assert.equal(candidato.usuario, 'history_nuevo');
    assert.equal(candidato.usuarioMensajeTimestamp, 1700000300000);
    assert.equal(candidato.usuarioMensajeId, 'MSG-NUEVO');

    await servicio.registrarMensajes(linea, [
        mensajeUsuarioConFuente('595984000001', 'chunk_mas_viejo', 1700000200, 'MSG-CHUNK')
    ], { origen: 'historial' });
    assert.equal(candidato.usuario, 'history_nuevo', 'un chunk antiguo tardío no revierte');

    await servicio.registrarMensajes(linea, [
        mensajeUsuarioConFuente('595984000001', 'live_nuevo', 1700000400000, 'MSG-LIVE')
    ], { origen: 'vivo' });
    assert.equal(candidato.usuario, 'live_nuevo');

    await servicio.registrarMensajes(linea, [
        mensajeUsuarioConFuente('595984000002', 'id_menor', 1700000500, 'A'),
        mensajeUsuarioConFuente('595984000002', 'id_mayor', 1700000500, 'Z')
    ], { origen: 'historial' });
    assert.equal(
        servicio.estado.lineas[linea.id].candidatos['+595984000002'].usuario,
        'id_menor',
        'timestamp empatado conserva el orden real del chunk, no el ID'
    );

    await servicio.registrarMensajes(linea, [
        mensajeUsuarioConFuente('595984000003', 'sin_fecha_nuevo', undefined, 'UNO'),
        mensajeUsuarioConFuente('595984000003', 'sin_fecha_viejo', undefined, 'DOS')
    ], { origen: 'historial' });
    const sinFecha = servicio.estado.lineas[linea.id].candidatos['+595984000003'];
    assert.equal(sinFecha.usuario, 'sin_fecha_nuevo');
    await servicio.registrarMensajes(linea, [
        mensajeUsuarioConFuente('595984000003', 'chunk_sin_fecha', undefined, 'TRES')
    ], { origen: 'historial' });
    assert.equal(sinFecha.usuario, 'sin_fecha_nuevo');
    await servicio.registrarMensajes(linea, [
        mensajeUsuarioConFuente('595984000003', 'live_sin_fecha', undefined, 'CUATRO')
    ], { origen: 'vivo' });
    assert.equal(sinFecha.usuario, 'live_sin_fecha', 'un evento vivo gana al historial sin fecha');

    servicio.cerrar();
    const persistido = JSON.parse(fs.readFileSync(rutaDatos, 'utf8'));
    const persistidoCandidato = persistido.lineas[linea.id].candidatos['+595984000001'];
    assert.equal(persistidoCandidato.usuarioMensajeTimestamp, 1700000400000);
    assert.equal(persistidoCandidato.usuarioMensajeId, 'MSG-LIVE');
    assert.equal(JSON.stringify(persistido).includes('123456'), false);
});

test('la cola crea y actualiza secuencialmente, preserva puntos y manda conflictos a revisión', async t => {
    const rutaDatos = crearTemporal(t);
    const escrituras = [];
    let escriturasActivas = 0;
    let maximoSimultaneo = 0;
    let personFieldsSolicitados = '';
    let sourcesSolicitadas = [];

    const conexiones = [
        {
            resourceName: 'people/personal',
            etag: 'etag-personal',
            metadata: metadataContacto('personal'),
            names: [{ displayName: 'María' }],
            phoneNumbers: [{ value: '+595981000002' }]
        },
        {
            resourceName: 'people/conflicto',
            etag: 'etag-conflicto',
            metadata: metadataContacto('conflicto'),
            names: [{ displayName: 'Proveedor 🟣' }],
            phoneNumbers: [{ value: '+595981000003' }]
        },
        {
            resourceName: 'people/gestionado',
            etag: 'etag-gestionado',
            metadata: metadataContacto('gestionado'),
            names: [{ displayName: 'L28 usuario_viejo 🟣' }],
            phoneNumbers: [{ value: '+595981000004' }],
            clientData: [
                { key: 'integracion_ajena', value: 'conservar-este-valor' },
                { key: 'autostatues_line', value: 'uuid-interno-anterior' },
                { key: 'autostatues_user', value: 'usuario_viejo' }
            ]
        },
        {
            resourceName: 'people/duplicado-a',
            etag: 'etag-a',
            names: [{ displayName: 'Duplicado A' }],
            phoneNumbers: [{ value: '+595981000005' }]
        },
        {
            resourceName: 'people/duplicado-b',
            etag: 'etag-b',
            names: [{ displayName: 'Duplicado B' }],
            phoneNumbers: [{ value: '+595981000005' }]
        },
        {
            resourceName: 'people/marcado-otra-linea',
            etag: 'etag-otra-linea',
            names: [{ displayName: 'L99 ajeno' }],
            phoneNumbers: [{ value: '+595981000007' }],
            clientData: [
                { key: 'autostatues_line', value: 'linea-99' },
                { key: 'autostatues_user', value: 'ajeno' }
            ]
        },
        {
            resourceName: 'people/legacy-otra-linea',
            etag: 'etag-legacy-otra',
            names: [{ displayName: 'L99 legacy_ajeno' }],
            phoneNumbers: [{ value: '+595981000008' }]
        },
        {
            resourceName: 'people/marcado-actual',
            etag: 'etag-marcado-actual',
            metadata: metadataContacto('marcado-actual'),
            names: [{ displayName: 'Nombre que ya no sigue el patrón' }],
            phoneNumbers: [{ value: '+595981000009' }],
            clientData: [
                { key: 'autostatues_line', value: 'L28' },
                { key: 'autostatues_user', value: 'usuario_anterior' }
            ]
        },
        {
            resourceName: 'people/sin-metadata',
            etag: 'etag-superficial-no-suficiente',
            names: [{ displayName: 'L28 viejo_sin_metadata' }],
            phoneNumbers: [{ value: '+595981000010' }]
        },
        {
            resourceName: 'people/dos-telefonos',
            metadata: metadataContacto('dos-telefonos'),
            names: [{ displayName: 'Contacto con dos números' }],
            phoneNumbers: [
                { value: '+595981000011' },
                { value: '+595981000012' }
            ]
        }
    ];

    const fetchFalso = async (url, opciones = {}) => {
        const direccion = String(url);
        if (direccion === 'https://oauth2.googleapis.com/token') {
            const grantType = opciones.body?.get('grant_type');
            if (grantType === 'authorization_code') {
                return respuestaJson({
                    access_token: 'access-inicial',
                    refresh_token: 'refresh-muy-secreto',
                    expires_in: 3600
                });
            }
            return respuestaJson({ access_token: 'access-renovado', expires_in: 3600 });
        }
        if (direccion === 'https://openidconnect.googleapis.com/v1/userinfo') {
            return respuestaJson({ sub: 'google-sub-1', email: 'uno@example.com', name: 'Cuenta Uno' });
        }
        if (direccion.includes('/people/me/connections')) {
            const urlListado = new URL(direccion);
            personFieldsSolicitados = urlListado.searchParams.get('personFields');
            sourcesSolicitadas = urlListado.searchParams.getAll('sources');
            return respuestaJson({ connections: conexiones });
        }
        if (direccion.includes(':createContact') || direccion.includes(':updateContact')) {
            escriturasActivas += 1;
            maximoSimultaneo = Math.max(maximoSimultaneo, escriturasActivas);
            const cuerpo = JSON.parse(opciones.body);
            escrituras.push({ url: direccion, metodo: opciones.method, cuerpo });
            await new Promise(resolve => setTimeout(resolve, 4));
            escriturasActivas -= 1;
            return respuestaJson({
                resourceName: direccion.includes(':createContact')
                    ? `people/creado-${escrituras.length}`
                    : cuerpo.resourceName,
                etag: `etag-nuevo-${escrituras.length}`,
                names: cuerpo.names,
                phoneNumbers: cuerpo.phoneNumbers,
                clientData: cuerpo.clientData,
                metadata: cuerpo.metadata
            });
        }
        throw new Error(`Solicitud inesperada: ${direccion}`);
    };

    const servicio = crearServicioAgendamiento({
        rutaDatos,
        codigoPais: '595',
        fetch: fetchFalso,
        cifrar: token => `cifrado:${Buffer.from(token).toString('base64')}`,
        descifrar: cifrado => Buffer.from(cifrado.slice('cifrado:'.length), 'base64').toString()
    });
    servicio.configurarCredenciales({
        installed: {
            client_id: 'cliente.apps.googleusercontent.com',
            client_secret: 'secreto-app',
            auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
            token_uri: 'https://oauth2.googleapis.com/token'
        }
    });
    const cuenta = await servicio.completarOAuth('codigo', 'pkce', 'http://127.0.0.1/callback');
    const linea = { id: 'linea-28', nombre: 'TT 28' };
    servicio.asociarCuenta(linea, cuenta.id);

    await servicio.registrarMensajes(linea, [
        mensajeUsuario('595981000001', 'nuevo'),
        mensajeUsuario('595981000002', 'maria_casino'),
        mensajeUsuario('595981000003', 'proveedor_casino'),
        mensajeUsuario('595981000004', 'usuario_nuevo'),
        mensajeUsuario('595981000005', 'duplicado'),
        mensajeUsuario('595981000007', 'no_mover_marcado'),
        mensajeUsuario('595981000008', 'no_mover_legacy'),
        mensajeUsuario('595981000009', 'marcado_nuevo'),
        mensajeUsuario('595981000010', 'nuevo_sin_metadata'),
        mensajeUsuario('595981000011', 'telefono_uno'),
        mensajeUsuario('595981000012', 'telefono_dos')
    ]);
    await servicio.registrarPublicadoresEstado(linea, [
        estadoPublicado('595981000001'),
        estadoPublicado('595981000002'),
        estadoPublicado('595981000006')
    ]);

    const progresos = [];
    servicio.on('progreso', progreso => progresos.push(progreso));
    const resumen = await servicio.iniciarSincronizacion(linea);

    assert.equal(resumen.estado, 'completada');
    assert.equal(resumen.total, 11);
    assert.equal(resumen.procesados, 11);
    assert.equal(resumen.creados, 1);
    assert.equal(resumen.actualizados, 4);
    assert.equal(resumen.revision, 6);
    assert.equal(resumen.pendientes, 0);
    assert.equal(resumen.errores, 0);
    assert.equal(maximoSimultaneo, 1, 'las mutaciones deben ejecutarse una por una');

    const creacion = escrituras.find(item => item.url.includes(':createContact'));
    assert.equal(creacion.cuerpo.names[0].unstructuredName, 'L28 nuevo 🟣');
    assert.equal(creacion.cuerpo.phoneNumbers[0].value, '+595981000001');
    assert.deepEqual(creacion.cuerpo.clientData, [
        { key: 'autostatues_line', value: 'L28' },
        { key: 'autostatues_user', value: 'nuevo' }
    ]);
    assert.ok(personFieldsSolicitados.includes('clientData'));
    assert.ok(personFieldsSolicitados.includes('metadata'));
    assert.deepEqual(sourcesSolicitadas, ['READ_SOURCE_TYPE_CONTACT']);

    const actualizacionPersonal = escrituras.find(
        item => item.cuerpo.resourceName === 'people/personal'
    );
    assert.equal(
        actualizacionPersonal.cuerpo.names[0].unstructuredName,
        'L28 maria_casino 🟣'
    );
    assert.deepEqual(actualizacionPersonal.cuerpo.clientData, [
        { key: 'autostatues_line', value: 'L28' },
        { key: 'autostatues_user', value: 'maria_casino' }
    ]);

    const actualizacionConPuntoPrevio = escrituras.find(
        item => item.cuerpo.resourceName === 'people/conflicto'
    );
    assert.equal(
        actualizacionConPuntoPrevio.cuerpo.names[0].unstructuredName,
        'L28 proveedor_casino 🟣',
        'un punto previo se conserva aunque todavía no haya una señal mutua local'
    );
    assert.equal(
        servicio.obtenerVista(linea).candidatos.find(
            item => item.telefono === '+595981000003'
        ).sincronizado,
        true,
        'el punto preexistente incorporado durante la operación no crea un falso pendiente'
    );

    const actualizacionGestionada = escrituras.find(
        item => item.cuerpo.resourceName === 'people/gestionado'
    );
    assert.equal(
        actualizacionGestionada.cuerpo.names[0].unstructuredName,
        'L28 usuario_nuevo 🟣',
        'un punto existente nunca se debe quitar'
    );
    assert.deepEqual(actualizacionGestionada.cuerpo.clientData, [
        { key: 'integracion_ajena', value: 'conservar-este-valor' },
        { key: 'autostatues_line', value: 'L28' },
        { key: 'autostatues_user', value: 'usuario_nuevo' }
    ], 'al migrar se preservan claves clientData de otros sistemas');
    assert.deepEqual(
        actualizacionGestionada.cuerpo.metadata,
        { sources: [metadataContacto('gestionado').sources[0]] },
        'PATCH incluye la fuente CONTACT y su etag'
    );
    assert.equal('etag' in actualizacionGestionada.cuerpo, false);

    const actualizacionMarcada = escrituras.find(
        item => item.cuerpo.resourceName === 'people/marcado-actual'
    );
    assert.equal(actualizacionMarcada.cuerpo.names[0].unstructuredName, 'L28 marcado_nuevo');
    assert.deepEqual(actualizacionMarcada.cuerpo.clientData, [
        { key: 'autostatues_line', value: 'L28' },
        { key: 'autostatues_user', value: 'marcado_nuevo' }
    ]);

    assert.equal(
        escrituras.some(item => String(item.cuerpo.resourceName).includes('duplicado')),
        false,
        'un teléfono duplicado nunca se modifica automáticamente'
    );
    assert.equal(
        escrituras.some(item => item.cuerpo.resourceName === 'people/marcado-otra-linea'),
        false,
        'clientData de otra línea nunca se reasigna silenciosamente'
    );
    assert.equal(
        escrituras.some(item => item.cuerpo.resourceName === 'people/legacy-otra-linea'),
        false,
        'un nombre legacy de otra línea tampoco se reasigna'
    );
    assert.equal(
        escrituras.some(item => item.cuerpo.resourceName === 'people/sin-metadata'),
        false,
        'sin una fuente CONTACT editable se envía a revisión'
    );
    assert.equal(
        escrituras.some(item => item.cuerpo.resourceName === 'people/dos-telefonos'),
        false,
        'una misma Person vinculada a dos candidatos no se renombra dos veces'
    );
    assert.ok(progresos.length >= 7);
    assert.equal(progresos.at(-1).estado, 'completada');
    assert.equal(
        servicio.obtenerVista(linea).sincronizacion.estado,
        'completada',
        'el último progreso queda disponible para que la interfaz lo renderice'
    );
    assert.equal(servicio.obtenerVista(linea).credencialesConfiguradas, true);
    const cantidadEscriturasPrimera = escrituras.length;
    const segunda = await servicio.iniciarSincronizacion(linea);
    assert.equal(segunda.total, 6, 'sólo reevalúa casos de revisión todavía no sincronizados');
    assert.equal(
        escrituras.length,
        cantidadEscriturasPrimera,
        'una segunda corrida inmediata no duplica altas ni actualizaciones exitosas'
    );
    const vistaRenombrada = servicio.obtenerVista({ id: 'linea-28', nombre: 'Operación 42' });
    assert.equal(vistaRenombrada.linea.nombre, 'Operación 42');
    assert.equal(vistaRenombrada.linea.prefijo, 'L42');
    assert.equal(
        vistaRenombrada.candidatos.find(item => item.usuario === 'nuevo').nombreObjetivo,
        'L42 nuevo 🟣'
    );

    const persistido = fs.readFileSync(rutaDatos, 'utf8');
    assert.equal(persistido.includes('refresh-muy-secreto'), false);
    assert.equal(persistido.includes('123456'), false);
    servicio.cerrar();
});

test('errores sistémicos de People conservan httpStatus y cortan inmediatamente la cola', async t => {
    for (const escenario of [
        { nombre: '403 durante el listado', status: 403, fallaEn: 'listado' },
        { nombre: '429 durante una escritura', status: 429, fallaEn: 'escritura' },
        { nombre: '500 durante una escritura', status: 500, fallaEn: 'escritura' }
    ]) {
        await t.test(escenario.nombre, async () => {
            const rutaDatos = crearTemporal(t);
            let listados = 0;
            let escrituras = 0;
            const fetchFalso = async (url, opciones = {}) => {
                const direccion = String(url);
                if (direccion === 'https://oauth2.googleapis.com/token') {
                    return respuestaJson({
                        access_token: `access-${escenario.status}`,
                        refresh_token: `refresh-${escenario.status}`,
                        expires_in: 3600
                    });
                }
                if (direccion === 'https://openidconnect.googleapis.com/v1/userinfo') {
                    return respuestaJson({
                        sub: `sub-${escenario.status}`,
                        email: `${escenario.status}@example.com`
                    });
                }
                if (direccion.includes('/people/me/connections')) {
                    listados += 1;
                    return escenario.fallaEn === 'listado'
                        ? respuestaJson({ error: { message: 'Límite preventivo' } }, escenario.status)
                        : respuestaJson({ connections: [] });
                }
                if (direccion.includes(':createContact')) {
                    escrituras += 1;
                    return respuestaJson(
                        { error: { message: 'Demasiadas solicitudes' } },
                        escenario.status
                    );
                }
                throw new Error(`Solicitud inesperada: ${direccion} ${opciones.method || 'GET'}`);
            };

            const servicio = crearServicioAgendamiento({
                rutaDatos,
                fetch: fetchFalso,
                cifrar: token => `enc:${token}`,
                descifrar: token => token.slice(4)
            });
            servicio.configurarCredenciales({
                client_id: `id-${escenario.status}`,
                client_secret: 'secret',
                auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
                token_uri: 'https://oauth2.googleapis.com/token'
            });
            const cuenta = await servicio.completarOAuth(
                'codigo',
                'pkce',
                'http://127.0.0.1'
            );
            const linea = { id: `linea-${escenario.status}`, nombre: 'Línea 28' };
            servicio.asociarCuenta(linea, cuenta.id);
            await servicio.registrarMensajes(linea, [
                mensajeUsuario('595982000001', 'primero'),
                mensajeUsuario('595982000002', 'segundo')
            ]);

            let errorCapturado;
            try {
                await servicio.iniciarSincronizacion(linea);
            } catch (error) {
                errorCapturado = error;
            }
            assert.ok(errorCapturado);
            assert.equal(errorCapturado.httpStatus, escenario.status);
            assert.equal(errorCapturado.codigo, 'GOOGLE_PEOPLE');
            assert.equal(listados, 1);
            assert.equal(
                escrituras,
                escenario.fallaEn === 'escritura' ? 1 : 0,
                'no debe probar el contacto siguiente después del corte'
            );
            const progreso = servicio.obtenerVista(linea).sincronizacion;
            assert.equal(progreso.estado, 'fallida');
            assert.equal(progreso.httpStatus, escenario.status);
            servicio.cerrar();
        });
    }
});

test('timeout de una mutación corta la cola y marca el resultado como incierto', async t => {
    const rutaDatos = crearTemporal(t);
    let escrituras = 0;
    const fetchFalso = async (url, opciones = {}) => {
        const direccion = String(url);
        if (direccion === 'https://oauth2.googleapis.com/token') {
            return respuestaJson({
                access_token: 'access-timeout',
                refresh_token: 'refresh-timeout',
                expires_in: 3600
            });
        }
        if (direccion === 'https://openidconnect.googleapis.com/v1/userinfo') {
            return respuestaJson({ sub: 'timeout', email: 'timeout@example.com' });
        }
        if (direccion.includes('/people/me/connections')) return respuestaJson({ connections: [] });
        if (direccion.includes(':createContact')) {
            escrituras += 1;
            return new Promise((resolve, reject) => {
                opciones.signal.addEventListener('abort', () => {
                    reject(new DOMException('Timeout', 'AbortError'));
                }, { once: true });
            });
        }
        throw new Error(`Solicitud inesperada: ${direccion}`);
    };
    const servicio = crearServicioAgendamiento({
        rutaDatos,
        fetch: fetchFalso,
        cifrar: token => `enc:${token}`,
        descifrar: token => token.slice(4),
        requestTimeoutMs: 15
    });
    servicio.configurarCredenciales({
        client_id: 'timeout.apps.googleusercontent.com',
        client_secret: 'secret',
        auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_uri: 'https://oauth2.googleapis.com/token'
    });
    const cuenta = await servicio.completarOAuth('code', 'pkce', 'http://127.0.0.1');
    const linea = { id: 'linea-timeout', nombre: 'Línea 44' };
    servicio.asociarCuenta(linea, cuenta.id);
    await servicio.registrarMensajes(linea, [
        mensajeUsuario('595988000001', 'primero'),
        mensajeUsuario('595988000002', 'segundo')
    ]);

    await assert.rejects(
        servicio.iniciarSincronizacion(linea),
        error => error?.codigo === 'GOOGLE_TIMEOUT' && error?.resultadoIncierto === true
    );
    assert.equal(escrituras, 1);
    const progreso = servicio.obtenerVista(linea).sincronizacion;
    assert.equal(progreso.estado, 'fallida');
    assert.equal(progreso.resultadoIncierto, true);
    const candidatos = servicio.obtenerVista(linea).candidatos;
    assert.equal(candidatos.every(item => !item.sincronizado), true);
    assert.equal(candidatos[0].ultimoResultado.codigo, 'RESULTADO_INCIERTO');
    const candidatoIncierto = servicio.estado.lineas[linea.id]
        .candidatos['+595988000001'];
    const reconciliacion = await servicio.procesarCandidato(
        'access-timeout',
        servicio.estado.lineas[linea.id],
        candidatoIncierto,
        new Map(),
        new Set(),
        new AbortController().signal
    );
    assert.equal(reconciliacion.codigo, 'RESULTADO_INCIERTO');
    assert.equal(escrituras, 1, 'no repite inmediatamente una escritura incierta');
    servicio.cerrar();
});

test('una caída de red durante POST también se considera escritura incierta', async t => {
    const rutaDatos = crearTemporal(t);
    const servicio = crearServicioAgendamiento({
        rutaDatos,
        fetch: async () => {
            throw new TypeError('socket cerrado');
        }
    });

    await assert.rejects(
        servicio.solicitudGoogle(
            'https://people.googleapis.com/v1/people:createContact',
            'access',
            { method: 'POST', body: '{}' }
        ),
        error =>
            error?.codigo === 'GOOGLE_RED' &&
            error?.resultadoIncierto === true
    );
    servicio.cerrar();
});

test('rechaza credenciales OAuth que intentan usar hosts ajenos a Google', t => {
    const rutaDatos = crearTemporal(t);
    const servicio = crearServicioAgendamiento({ rutaDatos });
    assert.throws(
        () => servicio.configurarCredenciales({
            client_id: 'id',
            client_secret: 'secret',
            auth_uri: 'https://accounts.google.com.ejemplo.test/oauth',
            token_uri: 'https://oauth2.googleapis.com/token'
        }),
        error => error?.codigo === 'CREDENCIALES_INVALIDAS'
    );
    assert.throws(
        () => servicio.configurarCredenciales({
            installed: {
                client_id: 'id',
                client_secret: 'secret',
                auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
                token_uri: 'https://recolector.ejemplo.test/token'
            }
        }),
        error => error?.codigo === 'CREDENCIALES_INVALIDAS'
    );
    assert.equal(servicio.obtenerVista({ id: 'l1', nombre: 'Línea 1' }).credencialesConfiguradas, false);
    servicio.cerrar();
});

test('cambiar clientId limpia cuentas y cambiar cuenta de línea invalida resultados', async t => {
    const rutaDatos = crearTemporal(t);
    const perfiles = [
        { sub: 'cuenta-a', email: 'a@example.com' },
        { sub: 'cuenta-b', email: 'b@example.com' }
    ];
    const escrituras = [];
    const revocaciones = [];
    const fetchFalso = async (url, opciones = {}) => {
        const direccion = String(url);
        if (direccion === 'https://oauth2.googleapis.com/token') {
            return respuestaJson({
                access_token: `access-${perfiles.length}`,
                refresh_token: `refresh-${perfiles.length}`,
                expires_in: 3600
            });
        }
        if (direccion === 'https://openidconnect.googleapis.com/v1/userinfo') {
            return respuestaJson(perfiles.shift());
        }
        if (direccion.includes('/people/me/connections')) {
            return respuestaJson({ connections: [] });
        }
        if (direccion.includes(':createContact')) {
            const cuerpo = JSON.parse(opciones.body);
            escrituras.push(cuerpo);
            return respuestaJson({
                resourceName: 'people/cuenta-b-creado',
                names: cuerpo.names,
                phoneNumbers: cuerpo.phoneNumbers,
                clientData: cuerpo.clientData
            });
        }
        if (direccion === 'https://oauth2.googleapis.com/revoke') {
            revocaciones.push(opciones.body.get('token'));
            return respuestaJson({});
        }
        throw new Error(`Solicitud inesperada: ${direccion}`);
    };
    const servicio = crearServicioAgendamiento({
        rutaDatos,
        fetch: fetchFalso,
        cifrar: token => `enc:${token}`,
        descifrar: token => token.slice(4)
    });
    const credencialesA = {
        client_id: 'cliente-a.apps.googleusercontent.com',
        client_secret: 'secret-a',
        auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_uri: 'https://oauth2.googleapis.com/token'
    };
    servicio.configurarCredenciales(credencialesA);
    const cuentaA = await servicio.completarOAuth('a', 'pkce-a', 'http://127.0.0.1');
    const cuentaB = await servicio.completarOAuth('b', 'pkce-b', 'http://127.0.0.1');
    const linea = { id: 'linea-cuentas', nombre: 'Línea 18' };
    await servicio.registrarMensajes(linea, [mensajeUsuario('595985000001', 'usuario_cuenta')]);
    const candidato = servicio.estado.lineas[linea.id].candidatos['+595985000001'];

    servicio.asociarCuenta(linea, cuentaA.id);
    candidato.ultimoResultado = { tipo: 'creado', nombre: 'L18 usuario_cuenta', cuentaId: cuentaA.id };
    servicio.asociarCuenta(linea, cuentaA.id);
    assert.equal(candidato.ultimoResultado.tipo, 'creado', 'reasociar la misma cuenta conserva');
    servicio.asociarCuenta(linea, cuentaB.id);
    assert.equal(candidato.ultimoResultado, null, 'A → B vuelve el contacto pendiente');

    const sincronizadaB = await servicio.iniciarSincronizacion(linea, cuentaB.id);
    assert.equal(sincronizadaB.creados, 1);
    assert.equal(escrituras.length, 1);
    assert.equal(candidato.ultimoResultado.cuentaId, cuentaB.id);

    const mismas = servicio.configurarCredenciales({ ...credencialesA, client_secret: 'secret-renovado' });
    assert.equal(mismas.desconectadas, 0);
    assert.equal(servicio.listarCuentas().length, 2);
    assert.equal(candidato.ultimoResultado.tipo, 'creado');
    assert.equal(servicio.tokensAcceso.size, 2, 'el mismo clientId conserva sesiones en memoria');

    assert.equal(await servicio.desconectarCuenta(cuentaB.id), true);
    assert.deepEqual(revocaciones, ['refresh-1']);
    assert.equal(candidato.ultimoResultado, null, 'desconectar la cuenta asociada invalida');
    assert.equal(servicio.estado.asociaciones[linea.id], undefined);

    const distintas = servicio.configurarCredenciales({
        ...credencialesA,
        client_id: 'cliente-nuevo.apps.googleusercontent.com'
    });
    assert.equal(distintas.desconectadas, 1);
    assert.equal(servicio.listarCuentas().length, 0);
    assert.equal(servicio.estado.asociaciones[linea.id], undefined);
    assert.equal(candidato.ultimoResultado, null);
    assert.equal(servicio.tokensAcceso.size, 0);
    servicio.cerrar();
});

test('recupera JSON desde .bak y ambos corruptos arrancan con estado vacío', t => {
    const rutaDatos = crearTemporal(t);
    fs.writeFileSync(rutaDatos, '{principal-corrupto', 'utf8');
    fs.writeFileSync(`${rutaDatos}.bak`, JSON.stringify({
        version: 1,
        oauth: null,
        cuentas: [],
        asociaciones: {},
        lineas: {
            respaldo: {
                id: 'respaldo',
                nombre: 'Línea 22',
                candidatos: {
                    '+595986000001': {
                        telefono: '+595986000001',
                        usuario: 'desde_backup',
                        mutuo: false,
                        senales: {}
                    }
                }
            }
        }
    }), 'utf8');
    const recuperado = crearServicioAgendamiento({ rutaDatos });
    assert.equal(recuperado.obtenerVista({ id: 'respaldo', nombre: 'Línea 22' }).candidatos[0].usuario, 'desde_backup');
    recuperado.cerrar();

    const rutaDoble = crearTemporal(t);
    fs.writeFileSync(rutaDoble, '{mal', 'utf8');
    fs.writeFileSync(`${rutaDoble}.bak`, 'también mal', 'utf8');
    const vacio = crearServicioAgendamiento({ rutaDatos: rutaDoble });
    assert.deepEqual(vacio.listarCuentas(), []);
    assert.equal(vacio.obtenerVista({ id: 'nueva', nombre: 'Línea 1' }).candidatos.length, 0);
    vacio.cerrar();
});

test('reserva sincrónicamente una cola y permite cancelar durante la resolución de línea', async t => {
    const rutaDatos = crearTemporal(t);
    let liberar;
    const espera = new Promise(resolve => { liberar = resolve; });
    const servicio = crearServicioAgendamiento({
        rutaDatos,
        fetch: async () => respuestaJson({}),
        obtenerLinea: async () => {
            await espera;
            return { id: 'linea-lock', nombre: 'Línea 30' };
        }
    });
    const primera = servicio.iniciarSincronizacion('linea-lock');
    assert.equal(servicio.estaOcupado(), true);
    assert.equal(servicio.obtenerProcesoActivo().lineaId, 'linea-lock');
    await assert.rejects(
        servicio.iniciarSincronizacion('linea-lock'),
        error => error?.codigo === 'SINCRONIZACION_ACTIVA'
    );
    assert.equal(servicio.detenerSincronizacion(), true);
    assert.equal(servicio.obtenerProcesoActivo().estado, 'cancelada');
    liberar();
    const cancelada = await primera;
    assert.equal(cancelada.estado, 'cancelada');
    assert.equal(servicio.estaOcupado(), false);
    servicio.cerrar();
});

test('OAuth de escritorio usa PKCE y devuelve al origen raíz del loopback', async t => {
    const rutaDatos = crearTemporal(t);
    let redirectRecibido;
    let authUrl;
    const fetchFalso = async (url, opciones = {}) => {
        const direccion = String(url);
        if (direccion === 'https://oauth2.googleapis.com/token') {
            redirectRecibido = opciones.body.get('redirect_uri');
            assert.ok(opciones.body.get('code_verifier'));
            return respuestaJson({
                access_token: 'access-oauth',
                refresh_token: 'refresh-oauth',
                expires_in: 3600
            });
        }
        if (direccion === 'https://openidconnect.googleapis.com/v1/userinfo') {
            return respuestaJson({ sub: 'oauth-root', email: 'root@example.com' });
        }
        throw new Error(`Solicitud inesperada: ${direccion}`);
    };
    const servicio = crearServicioAgendamiento({
        rutaDatos,
        fetch: fetchFalso,
        cifrar: token => `enc:${token}`,
        descifrar: token => token.slice(4),
        abrirEnlace: async url => {
            authUrl = new URL(url);
            const redirect = authUrl.searchParams.get('redirect_uri');
            const state = authUrl.searchParams.get('state');
            assert.equal(new URL(redirect).pathname, '/');
            assert.equal(redirect.includes('/oauth/callback'), false);
            assert.equal(await solicitudHttp(`${redirect}/ruta-incorrecta`), 404);
            assert.equal(await solicitudHttp(`${redirect}/`, 'POST'), 405);
            assert.equal(await solicitudHttp(`${redirect}/?state=estado-falso&code=ataque`), 400);
            assert.equal(
                await solicitudHttp(`${redirect}/?state=${encodeURIComponent(state)}`),
                400
            );
            assert.equal(
                await solicitudHttp(
                    `${redirect}/?state=${encodeURIComponent(state)}&code=codigo-oauth`
                ),
                200
            );
        }
    });
    servicio.configurarCredenciales({
        client_id: 'id-oauth',
        client_secret: 'secret-oauth',
        auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_uri: 'https://oauth2.googleapis.com/token'
    });
    const cuenta = await servicio.iniciarOAuth();
    assert.equal(cuenta.correo, 'root@example.com');
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(redirectRecibido.includes('/oauth/callback'), false);
    assert.equal(new URL(redirectRecibido).pathname, '/');
    servicio.cerrar();
});

test('un usuario que cambia durante create deja el resultado remoto pendiente de reconciliar', async t => {
    const rutaDatos = crearTemporal(t);
    let avisarInicio;
    let liberarCreate;
    const createIniciado = new Promise(resolve => { avisarInicio = resolve; });
    const esperaCreate = new Promise(resolve => { liberarCreate = resolve; });
    const fetchFalso = async (url, opciones = {}) => {
        const direccion = String(url);
        if (direccion === 'https://oauth2.googleapis.com/token') {
            return respuestaJson({
                access_token: 'access-race',
                refresh_token: 'refresh-race',
                expires_in: 3600
            });
        }
        if (direccion === 'https://openidconnect.googleapis.com/v1/userinfo') {
            return respuestaJson({ sub: 'race', email: 'race@example.com' });
        }
        if (direccion.includes('/people/me/connections')) return respuestaJson({ connections: [] });
        if (direccion.includes(':createContact')) {
            const cuerpo = JSON.parse(opciones.body);
            avisarInicio();
            await esperaCreate;
            return respuestaJson({
                resourceName: 'people/race',
                names: cuerpo.names,
                phoneNumbers: cuerpo.phoneNumbers,
                clientData: cuerpo.clientData
            });
        }
        throw new Error(`Solicitud inesperada: ${direccion}`);
    };
    const servicio = crearServicioAgendamiento({
        rutaDatos,
        fetch: fetchFalso,
        cifrar: token => `enc:${token}`,
        descifrar: token => token.slice(4),
        requestTimeoutMs: 1000
    });
    servicio.configurarCredenciales({
        client_id: 'race.apps.googleusercontent.com',
        client_secret: 'secret',
        auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_uri: 'https://oauth2.googleapis.com/token'
    });
    const cuenta = await servicio.completarOAuth('code', 'pkce', 'http://127.0.0.1');
    const linea = { id: 'linea-race', nombre: 'Línea 40' };
    servicio.asociarCuenta(linea, cuenta.id);
    await servicio.registrarMensajes(linea, [
        mensajeUsuarioConFuente('595987000001', 'usuario_viejo', 1700000100, 'OLD')
    ], { origen: 'vivo' });

    const proceso = servicio.iniciarSincronizacion(linea);
    await createIniciado;
    await servicio.registrarMensajes(linea, [
        mensajeUsuarioConFuente('595987000001', 'usuario_nuevo', 1700000200, 'NEW')
    ], { origen: 'vivo' });
    liberarCreate();
    await proceso;

    const candidato = servicio.obtenerVista(linea).candidatos[0];
    assert.equal(candidato.usuario, 'usuario_nuevo');
    assert.equal(candidato.ultimoResultado, null);
    assert.equal(candidato.sincronizado, false);
    servicio.cerrar();
});

test('cancelar durante create deja terminar y persistir esa única mutación', async t => {
    const rutaDatos = crearTemporal(t);
    let inicioCreacion;
    const creacionIniciada = new Promise(resolve => { inicioCreacion = resolve; });
    const telefonosCreados = [];

    const fetchFalso = async (url, opciones = {}) => {
        const direccion = String(url);
        if (direccion === 'https://oauth2.googleapis.com/token') {
            if (opciones.body?.get('grant_type') === 'authorization_code') {
                return respuestaJson({
                    access_token: 'access',
                    refresh_token: 'refresh',
                    expires_in: 3600
                });
            }
            return respuestaJson({ access_token: 'access', expires_in: 3600 });
        }
        if (direccion === 'https://openidconnect.googleapis.com/v1/userinfo') {
            return respuestaJson({ sub: 'cancel-user', email: 'cancel@example.com' });
        }
        if (direccion.includes('/people/me/connections')) return respuestaJson({ connections: [] });
        if (direccion.includes(':createContact')) {
            const cuerpo = JSON.parse(opciones.body);
            telefonosCreados.push(cuerpo.phoneNumbers[0].value);
            inicioCreacion();
            await new Promise((resolve, reject) => {
                const temporizador = setTimeout(resolve, 25);
                opciones.signal?.addEventListener('abort', () => {
                    clearTimeout(temporizador);
                    reject(new DOMException('Cancelado', 'AbortError'));
                }, { once: true });
            });
            return respuestaJson({ resourceName: 'people/no-deberia-completarse' });
        }
        throw new Error(`Solicitud inesperada: ${direccion}`);
    };

    const servicio = crearServicioAgendamiento({
        rutaDatos,
        fetch: fetchFalso,
        cifrar: token => `enc:${token}`,
        descifrar: token => token.slice(4)
    });
    servicio.configurarCredenciales({
        client_id: 'id',
        client_secret: 'secret',
        auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_uri: 'https://oauth2.googleapis.com/token'
    });
    const cuenta = await servicio.completarOAuth('codigo', 'pkce', 'http://127.0.0.1/callback');
    const linea = { id: 'l-9', nombre: 'Línea 9' };
    servicio.asociarCuenta(linea, cuenta.id);
    await servicio.registrarMensajes(linea, [
        mensajeUsuario('595981100001', 'primero'),
        mensajeUsuario('595981100002', 'segundo')
    ]);

    const promesa = servicio.iniciarSincronizacion(linea);
    await creacionIniciada;
    assert.equal(servicio.detenerSincronizacion(), true);
    const resumen = await promesa;
    assert.equal(resumen.estado, 'cancelada');
    assert.deepEqual(telefonosCreados, ['+595981100001']);
    const vistaCancelada = servicio.obtenerVista(linea);
    assert.equal(
        vistaCancelada.candidatos.find(item => item.telefono === '+595981100001').sincronizado,
        true,
        'la mutación terminada se persiste aunque el proceso quede cancelado'
    );
    const reanudada = await servicio.iniciarSincronizacion(linea);
    assert.equal(reanudada.total, 1);
    assert.deepEqual(
        telefonosCreados,
        ['+595981100001', '+595981100002'],
        'al reanudar no vuelve a crear el primer contacto'
    );
    servicio.cerrar();
});
