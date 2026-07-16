'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');

const VERSION_DATOS = 2;
const MARCADOR_MUTUO = '🟣';
const GOOGLE_CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts';
const GOOGLE_SCOPES = [GOOGLE_CONTACTS_SCOPE, 'openid', 'email'];
const GOOGLE_PEOPLE_BASE = 'https://people.googleapis.com/v1';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const CERO_ANCHO = /[\u200B-\u200D\u2060\uFEFF]/gu;
const CLIENT_DATA_LINEA = 'autostatues_line';
const CLIENT_DATA_USUARIO = 'autostatues_user';
const ESPERA_RESULTADO_INCIERTO_MS = 10 * 60 * 1000;
const PALABRAS_CLAVE_USUARIO_PREDETERMINADAS = ['Usuario:'];
const MAXIMO_PALABRAS_CLAVE_USUARIO = 30;
const MAXIMO_CARACTERES_PALABRA_CLAVE = 100;
const MAXIMO_CARACTERES_PALABRAS_CLAVE = 3000;

class ErrorAgendamiento extends Error {
    constructor(codigo, mensaje, causa, httpStatus) {
        super(mensaje);
        this.name = 'ErrorAgendamiento';
        this.codigo = codigo;
        if (causa) this.cause = causa;
        const estadoHttp = Number(httpStatus ?? causa?.httpStatus ?? causa?.status);
        if (Number.isInteger(estadoHttp) && estadoHttp >= 100 && estadoHttp <= 599) {
            this.httpStatus = estadoHttp;
        }
    }
}

function textoSeguro(valor, maximo = 180) {
    if (typeof valor !== 'string') return '';
    return valor.replace(CERO_ANCHO, '').normalize('NFC').trim().slice(0, maximo);
}

function normalizarTextoPlantilla(valor) {
    if (typeof valor !== 'string') return '';
    return valor
        .replace(CERO_ANCHO, '')
        .replace(/\r\n?/g, '\n')
        .normalize('NFC')
        .split('\n')
        .map(linea => linea.trim())
        .filter(Boolean)
        .join('\n')
        .trim();
}

function normalizarUsuario(valor) {
    const usuario = textoSeguro(valor, 80).replace(/\s+/g, ' ');
    if (!usuario || usuario.includes('\n') || /\s/u.test(usuario)) return null;
    if (!/^[\p{L}\p{N}_.-]{1,80}$/u.test(usuario)) return null;
    return usuario;
}

function normalizarPalabraClaveUsuario(valor) {
    if (typeof valor !== 'string') return '';
    return valor
        .replace(CERO_ANCHO, '')
        .replace(/\r\n?/g, '\n')
        .normalize('NFC')
        .replace(/\s+/gu, ' ')
        .trim();
}

function normalizarPalabrasClaveUsuario(entrada, { estricto = false } = {}) {
    const valores = typeof entrada === 'string'
        ? entrada.split(/\r?\n/u)
        : Array.isArray(entrada)
            ? entrada
            : [];
    const palabrasClave = [];
    const vistas = new Set();
    let caracteresTotales = 0;

    for (const valor of valores) {
        if (typeof valor !== 'string') {
            if (estricto) {
                throw new ErrorAgendamiento(
                    'PALABRAS_CLAVE_INVALIDAS',
                    'Cada palabra clave debe ser una frase de texto.'
                );
            }
            continue;
        }

        const palabra = normalizarPalabraClaveUsuario(valor);
        if (!palabra) continue;
        if (
            palabra.length < 2 ||
            palabra.length > MAXIMO_CARACTERES_PALABRA_CLAVE
        ) {
            if (estricto) {
                throw new ErrorAgendamiento(
                    'PALABRA_CLAVE_INVALIDA',
                    `Cada frase debe tener entre 2 y ${MAXIMO_CARACTERES_PALABRA_CLAVE} caracteres.`
                );
            }
            continue;
        }

        const clave = palabra.toLocaleLowerCase('es');
        if (vistas.has(clave)) continue;
        vistas.add(clave);
        palabrasClave.push(palabra);
        caracteresTotales += palabra.length;

        if (
            palabrasClave.length > MAXIMO_PALABRAS_CLAVE_USUARIO ||
            caracteresTotales > MAXIMO_CARACTERES_PALABRAS_CLAVE
        ) {
            if (estricto) {
                throw new ErrorAgendamiento(
                    'DEMASIADAS_PALABRAS_CLAVE',
                    `Podés guardar hasta ${MAXIMO_PALABRAS_CLAVE_USUARIO} frases y ${MAXIMO_CARACTERES_PALABRAS_CLAVE} caracteres en total.`
                );
            }
            palabrasClave.pop();
            break;
        }
    }

    if (!palabrasClave.length) {
        if (estricto) {
            throw new ErrorAgendamiento(
                'PALABRAS_CLAVE_VACIAS',
                'Escribí al menos una frase para localizar el usuario.'
            );
        }
        return [...PALABRAS_CLAVE_USUARIO_PREDETERMINADAS];
    }

    return palabrasClave;
}

function escaparExpresionRegular(valor) {
    return String(valor || '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Busca frases literales configuradas por el usuario y toma el primer token
 * válido que aparece inmediatamente después en la misma línea.
 */
function parsearUsuarioPorPalabrasClave(texto, palabrasClave) {
    const normalizado = normalizarTextoPlantilla(texto);
    if (!normalizado) return null;

    const frases = normalizarPalabrasClaveUsuario(palabrasClave);
    const lineas = normalizado.split('\n');

    for (const frase of frases) {
        const expresion = new RegExp(escaparExpresionRegular(frase), 'iu');
        for (const linea of lineas) {
            const coincidencia = expresion.exec(linea);
            if (!coincidencia) continue;

            const resto = linea
                .slice(coincidencia.index + coincidencia[0].length)
                .replace(/^[\s:;=\-–—]+/u, '');
            const token = resto.match(/^[\p{L}\p{N}_.-]{1,80}(?=$|\s)/u)?.[0];
            const usuario = normalizarUsuario(token);
            if (usuario) return { usuario };
        }
    }

    return null;
}

/**
 * Reconoce únicamente la plantilla Greenvip acordada. Devuelve solamente el
 * usuario; nunca devuelve ni conserva la contraseña o el contenido original.
 */
function parsearPlantillaGreenvip(texto) {
    const normalizado = normalizarTextoPlantilla(texto);
    if (!normalizado) return null;

    const lineas = normalizado.split('\n');
    if (lineas.length !== 5) return null;
    if (!/^¡Genial!\s*😍💥$/u.test(lineas[0])) return null;
    if (!/^Cualquier duda que tengas,\s*estoy para ayudarte\s*😉🔥$/u.test(lineas[1])) {
        return null;
    }

    const coincidenciaUsuario = lineas[2].match(/^👤\s*Usuario:\s*(.+)$/u);
    if (!coincidenciaUsuario) return null;
    const usuario = normalizarUsuario(coincidenciaUsuario[1]);
    if (!usuario) return null;

    if (!/^🔐\s*Clave:\s*123456$/u.test(lineas[3])) return null;
    if (!/^📡\s*Enlace:\s*(?:\[https:\/\/greenvip\.net\]\(https:\/\/greenvip\.net\/?\)|https:\/\/greenvip\.net\/?)\s*🌐$/iu.test(lineas[4])) {
        return null;
    }

    return { usuario };
}

function normalizarCodigoPais(valor) {
    const codigo = String(valor || '').replace(/\D/g, '');
    return codigo && codigo.length <= 3 ? codigo : '';
}

/** Devuelve un teléfono canónico E.164 aproximado (`+` y dígitos). */
function normalizarTelefono(valor, codigoPais = '595') {
    if (valor === null || valor === undefined) return null;
    let bruto = String(valor).trim();
    if (!bruto) return null;

    if (/@(?:hosted\.)?lid$/iu.test(bruto)) return null;
    const jidPn = /@(?:s\.whatsapp\.net|c\.us|hosted)$/iu.test(bruto);
    if (bruto.includes('@') && !jidPn) {
        return null;
    }
    if (bruto.includes('@')) bruto = bruto.split('@', 1)[0];
    bruto = bruto.replace(/:\d+$/u, '');
    const internacionalExplicito = jidPn || bruto.startsWith('+') || bruto.startsWith('00');
    let digitos = bruto.replace(/\D/g, '');
    if (bruto.startsWith('00')) digitos = digitos.slice(2);

    const pais = normalizarCodigoPais(codigoPais);
    if (!internacionalExplicito && pais) {
        if (digitos.startsWith('0')) {
            digitos = pais + digitos.slice(1);
        } else if (!digitos.startsWith(pais) && digitos.length <= 10) {
            digitos = pais + digitos;
        }
    }

    digitos = digitos.replace(/^0+/u, '');
    if (!/^[1-9]\d{6,14}$/u.test(digitos)) return null;
    return `+${digitos}`;
}

function obtenerDigitosFinalesLinea(nombre) {
    const coincidencias = String(nombre || '').match(/\d+/g);
    if (!coincidencias?.length) return null;
    const numero = String(Number(coincidencias.at(-1)));
    return numero === 'NaN' ? null : numero;
}

function obtenerPrefijoLinea(nombre) {
    const explicito = String(nombre || '').match(/\bL\s*0*(\d+)\b/iu);
    if (explicito) return `L${Number(explicito[1])}`;
    const numero = obtenerDigitosFinalesLinea(nombre);
    return numero ? `L${numero}` : null;
}

function tieneMarcadorMutuo(nombre) {
    return typeof nombre === 'string' && nombre.includes(MARCADOR_MUTUO);
}

function quitarMarcadoresMutuos(nombre) {
    return textoSeguro(nombre, 180)
        .replace(new RegExp(`\\s*${MARCADOR_MUTUO}`, 'gu'), '')
        .trim();
}

function agregarMarcadorMutuo(nombre) {
    const base = quitarMarcadoresMutuos(nombre);
    return base ? `${base} ${MARCADOR_MUTUO}` : MARCADOR_MUTUO;
}

function crearNombreGestionado(nombreLinea, usuario, mutuo = false, conservarMarcador = false) {
    const prefijo = obtenerPrefijoLinea(nombreLinea);
    const usuarioNormalizado = normalizarUsuario(usuario);
    if (!prefijo || !usuarioNormalizado) return null;
    const base = `${prefijo} ${usuarioNormalizado}`;
    return mutuo || conservarMarcador ? agregarMarcadorMutuo(base) : base;
}

function esNombreGestionado(nombre) {
    const sinPunto = quitarMarcadoresMutuos(nombre);
    return /^L\d+\s+[\p{L}\p{N}_.-]+$/u.test(sinPunto);
}

function obtenerPrefijoNombreGestionado(nombre) {
    const coincidencia = quitarMarcadoresMutuos(nombre).match(/^L(\d+)\s+/u);
    if (!coincidencia) return null;
    return `L${Number(coincidencia[1])}`;
}

function obtenerMarcasAutostatues(persona) {
    const marcas = {};
    for (const dato of Array.isArray(persona?.clientData) ? persona.clientData : []) {
        const clave = textoSeguro(dato?.key, 80);
        if (![CLIENT_DATA_LINEA, CLIENT_DATA_USUARIO].includes(clave)) continue;
        if (Object.hasOwn(marcas, clave)) continue;
        marcas[clave] = textoSeguro(dato?.value, 180);
    }
    return {
        lineaId: marcas[CLIENT_DATA_LINEA] || null,
        usuario: marcas[CLIENT_DATA_USUARIO] || null
    };
}

function crearMarcasAutostatues(lineaId, usuario) {
    return [
        { key: CLIENT_DATA_LINEA, value: textoSeguro(lineaId, 180) },
        { key: CLIENT_DATA_USUARIO, value: normalizarUsuario(usuario) }
    ];
}

function fusionarMarcasAutostatues(persona, lineaId, usuario) {
    const ajenas = [];
    for (const dato of Array.isArray(persona?.clientData) ? persona.clientData : []) {
        const clave = typeof dato?.key === 'string' ? dato.key : '';
        if (!clave || [CLIENT_DATA_LINEA, CLIENT_DATA_USUARIO].includes(clave)) continue;
        // `updatePersonFields=clientData` reemplaza el campo completo; las
        // entradas que pertenecen a otras integraciones vuelven sin cambios.
        ajenas.push(clonarSeguro(dato));
    }
    return [...ajenas, ...crearMarcasAutostatues(lineaId, usuario)];
}

function marcasAutostatuesCoinciden(persona, lineaId, usuario) {
    const marcas = obtenerMarcasAutostatues(persona);
    return marcas.lineaId === textoSeguro(lineaId, 180)
        && marcas.usuario === normalizarUsuario(usuario);
}

function esErrorGoogleDeCorte(error) {
    if (!(error instanceof ErrorAgendamiento)) return false;
    if (['GOOGLE_RED', 'GOOGLE_TIMEOUT'].includes(error.codigo)) return true;
    return [401, 403, 429].includes(error.httpStatus) || error.httpStatus >= 500;
}

function candidatoEstaSincronizado(candidato, cuentaId) {
    const exito = ['creado', 'actualizado', 'sin_cambios'].includes(
        candidato?.ultimoResultado?.tipo
    );
    if (!exito) return false;
    return !cuentaId || candidato.ultimoResultado?.cuentaId === cuentaId;
}

function crearHuellaCandidato(linea, candidato) {
    return JSON.stringify([
        linea?.prefijo || obtenerPrefijoLinea(linea?.nombre),
        candidato?.usuario || null,
        Boolean(candidato?.mutuo)
    ]);
}

function estadoInicial() {
    return {
        version: VERSION_DATOS,
        oauth: null,
        cuentas: [],
        asociaciones: {},
        busqueda: {
            palabrasClaveUsuario: [...PALABRAS_CLAVE_USUARIO_PREDETERMINADAS],
            actualizadaEn: null
        },
        lineas: {}
    };
}

function clonarSeguro(valor) {
    return JSON.parse(JSON.stringify(valor));
}

function fechaIso(ahora) {
    const valor = typeof ahora === 'function' ? ahora() : new Date();
    const fecha = valor instanceof Date ? valor : new Date(valor);
    return Number.isNaN(fecha.getTime()) ? new Date().toISOString() : fecha.toISOString();
}

function escribirJsonAtomico(ruta, datos) {
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    const temporal = `${ruta}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const contenido = `${JSON.stringify(datos, null, 2)}\n`;
    try {
        fs.writeFileSync(temporal, contenido, { encoding: 'utf8', mode: 0o600 });
        const descriptor = fs.openSync(temporal, 'r');
        try {
            try {
                fs.fsyncSync(descriptor);
            } catch (error) {
                // Algunos volúmenes de Windows/Electron no permiten fsync. La
                // escritura temporal + rename sigue evitando JSON parciales.
                if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
            }
        } finally {
            fs.closeSync(descriptor);
        }
        let respaldo = null;
        if (process.platform === 'win32' && fs.existsSync(ruta)) {
            respaldo = `${ruta}.bak`;
            try {
                fs.copyFileSync(ruta, respaldo);
            } catch {
                // El respaldo es auxiliar; el archivo temporal sigue siendo válido.
            }
            fs.rmSync(ruta, { force: true });
        }
        try {
            fs.renameSync(temporal, ruta);
        } catch (error) {
            if (respaldo && fs.existsSync(respaldo) && !fs.existsSync(ruta)) {
                try {
                    fs.copyFileSync(respaldo, ruta);
                } catch {
                    // Se conserva el respaldo para recuperación manual.
                }
            }
            throw error;
        }
    } finally {
        if (fs.existsSync(temporal)) fs.rmSync(temporal, { force: true });
    }
}

function sanitizarEstadoLeido(leido) {
    const limpio = estadoInicial();
    limpio.busqueda = {
        palabrasClaveUsuario: normalizarPalabrasClaveUsuario(
            leido?.busqueda?.palabrasClaveUsuario
        ),
        actualizadaEn:
            textoSeguro(leido?.busqueda?.actualizadaEn, 40) || null
    };
    if (leido.oauth && typeof leido.oauth === 'object') {
        const oauth = {
            clientId: textoSeguro(leido.oauth.clientId, 500),
            clientSecret: textoSeguro(leido.oauth.clientSecret, 500),
            authUri: textoSeguro(leido.oauth.authUri, 500),
            tokenUri: textoSeguro(leido.oauth.tokenUri, 500)
        };
        if (oauth.clientId && oauth.clientSecret && oauth.authUri && oauth.tokenUri) {
            limpio.oauth = oauth;
        }
    }

    for (const cuenta of Array.isArray(leido.cuentas) ? leido.cuentas : []) {
        const id = textoSeguro(cuenta?.id, 100);
        const refreshTokenCifrado = textoSeguro(cuenta?.refreshTokenCifrado, 12000);
        if (!id || !refreshTokenCifrado || limpio.cuentas.some(item => item.id === id)) continue;
        limpio.cuentas.push({
            id,
            correo: textoSeguro(cuenta?.correo, 240),
            nombre: textoSeguro(cuenta?.nombre, 240),
            refreshTokenCifrado,
            creadaEn: textoSeguro(cuenta?.creadaEn, 40) || null,
            actualizadaEn: textoSeguro(cuenta?.actualizadaEn, 40) || null
        });
    }

    if (leido.asociaciones && typeof leido.asociaciones === 'object') {
        for (const [lineaIdBruto, cuentaIdBruto] of Object.entries(leido.asociaciones)) {
            const lineaId = textoSeguro(lineaIdBruto, 180);
            const cuentaId = textoSeguro(cuentaIdBruto, 100);
            if (lineaId && cuentaId) limpio.asociaciones[lineaId] = cuentaId;
        }
    }

    if (leido.lineas && typeof leido.lineas === 'object') {
        for (const [claveLinea, lineaLeida] of Object.entries(leido.lineas)) {
            if (!lineaLeida || typeof lineaLeida !== 'object') continue;
            const id = textoSeguro(lineaLeida.id || claveLinea, 180);
            const nombre = textoSeguro(lineaLeida.nombre || id, 180);
            if (!id || !nombre) continue;
            const linea = {
                id,
                nombre,
                prefijo: obtenerPrefijoLinea(nombre),
                candidatos: {},
                pendientesJid: {},
                secuenciaMensajes: Number.isSafeInteger(lineaLeida.secuenciaMensajes)
                    && lineaLeida.secuenciaMensajes >= 0
                    ? lineaLeida.secuenciaMensajes
                    : 0,
                actualizadaEn: textoSeguro(lineaLeida.actualizadaEn, 40) || null
            };
            for (const candidatoLeido of Object.values(lineaLeida.candidatos || {})) {
                if (!candidatoLeido || typeof candidatoLeido !== 'object') continue;
                const telefono = normalizarTelefono(candidatoLeido.telefono, '');
                if (!telefono) continue;
                const usuario = candidatoLeido.usuario
                    ? normalizarUsuario(candidatoLeido.usuario)
                    : null;
                const ultimo = candidatoLeido.ultimoResultado;
                linea.candidatos[telefono] = {
                    telefono,
                    usuario,
                    usuarioMensajeTimestamp: normalizarTimestampMensaje(
                        candidatoLeido.usuarioMensajeTimestamp
                    ),
                    usuarioMensajeId: textoSeguro(
                        candidatoLeido.usuarioMensajeId,
                        240
                    ) || null,
                    usuarioMensajeOrigen: candidatoLeido.usuarioMensajeOrigen === 'historial'
                        ? 'historial'
                        : (usuario ? 'vivo' : null),
                    usuarioMensajeEvento: Number.isSafeInteger(
                        candidatoLeido.usuarioMensajeEvento
                    ) ? candidatoLeido.usuarioMensajeEvento : 0,
                    usuarioMensajePosicion: Number.isSafeInteger(
                        candidatoLeido.usuarioMensajePosicion
                    ) ? candidatoLeido.usuarioMensajePosicion : 0,
                    mutuo: Boolean(candidatoLeido.mutuo),
                    senales: {
                        vioEstado: textoSeguro(candidatoLeido.senales?.vioEstado, 40) || null,
                        publicoEstado: textoSeguro(
                            candidatoLeido.senales?.publicoEstado,
                            40
                        ) || null
                    },
                    detectadoEn: textoSeguro(candidatoLeido.detectadoEn, 40) || null,
                    usuarioDetectadoEn: textoSeguro(
                        candidatoLeido.usuarioDetectadoEn,
                        40
                    ) || null,
                    actualizadoEn: textoSeguro(candidatoLeido.actualizadoEn, 40) || null,
                    ultimoResultado: ultimo && typeof ultimo === 'object'
                        ? {
                            tipo: textoSeguro(ultimo.tipo, 40),
                            codigo: textoSeguro(ultimo.codigo, 80) || undefined,
                            nombre: textoSeguro(ultimo.nombre, 180) || undefined,
                            nombreActual: textoSeguro(ultimo.nombreActual, 180) || undefined,
                            detalle: textoSeguro(ultimo.detalle, 220) || undefined,
                            cuentaId: textoSeguro(ultimo.cuentaId, 100) || undefined,
                            fecha: textoSeguro(ultimo.fecha, 40) || null
                        }
                        : null
                };
            }
            for (const [jidClave, pendienteLeido] of Object.entries(
                lineaLeida.pendientesJid || {}
            )) {
                if (!pendienteLeido || typeof pendienteLeido !== 'object') continue;
                const jid = textoSeguro(pendienteLeido.jid || jidClave, 240);
                if (!esJidLid(jid)) continue;
                const usuarioPendiente = pendienteLeido.usuario
                    ? normalizarUsuario(pendienteLeido.usuario)
                    : null;
                linea.pendientesJid[jid] = {
                    jid,
                    usuario: usuarioPendiente,
                    usuarioMensajeTimestamp: normalizarTimestampMensaje(
                        pendienteLeido.usuarioMensajeTimestamp
                    ),
                    usuarioMensajeId: textoSeguro(
                        pendienteLeido.usuarioMensajeId,
                        240
                    ) || null,
                    usuarioMensajeOrigen: pendienteLeido.usuarioMensajeOrigen === 'historial'
                        ? 'historial'
                        : (usuarioPendiente ? 'vivo' : null),
                    usuarioMensajeEvento: Number.isSafeInteger(
                        pendienteLeido.usuarioMensajeEvento
                    ) ? pendienteLeido.usuarioMensajeEvento : 0,
                    usuarioMensajePosicion: Number.isSafeInteger(
                        pendienteLeido.usuarioMensajePosicion
                    ) ? pendienteLeido.usuarioMensajePosicion : 0,
                    senales: {
                        vioEstado: textoSeguro(
                            pendienteLeido.senales?.vioEstado,
                            40
                        ) || null,
                        publicoEstado: textoSeguro(
                            pendienteLeido.senales?.publicoEstado,
                            40
                        ) || null
                    },
                    detectadoEn: textoSeguro(pendienteLeido.detectadoEn, 40) || null,
                    actualizadoEn: textoSeguro(pendienteLeido.actualizadoEn, 40) || null
                };
            }
            limpio.lineas[id] = linea;
        }
    }
    return limpio;
}

function leerJsonSeguro(ruta) {
    for (const candidata of [ruta, `${ruta}.bak`]) {
        if (!fs.existsSync(candidata)) continue;
        try {
            const leido = JSON.parse(fs.readFileSync(candidata, 'utf8'));
            if (!leido || typeof leido !== 'object' || Array.isArray(leido)) continue;
            return sanitizarEstadoLeido(leido);
        } catch {
            // Nunca se imprime el contenido ni se bloquea el arranque. Si el
            // principal falla se intenta el respaldo; si ambos fallan, vacío.
        }
    }
    return estadoInicial();
}

function obtenerNombrePersona(persona) {
    const nombres = Array.isArray(persona?.names) ? persona.names : [];
    const principal = nombres.find(nombre => nombre?.metadata?.primary) || nombres[0];
    return textoSeguro(
        principal?.displayName || principal?.unstructuredName || principal?.givenName || '',
        180
    );
}

function obtenerFuenteContacto(persona) {
    const fuentes = Array.isArray(persona?.metadata?.sources)
        ? persona.metadata.sources
        : [];
    const fuente = fuentes.find(item => item?.type === 'CONTACT' && textoSeguro(item?.etag, 500));
    return fuente ? clonarSeguro(fuente) : null;
}

function indexarConexiones(conexiones, codigoPais = '595') {
    const indice = new Map();
    for (const persona of Array.isArray(conexiones) ? conexiones : []) {
        for (const telefono of Array.isArray(persona?.phoneNumbers) ? persona.phoneNumbers : []) {
            const canonico = normalizarTelefono(
                telefono?.canonicalForm || telefono?.value,
                codigoPais
            );
            if (!canonico) continue;
            if (!indice.has(canonico)) indice.set(canonico, []);
            const existentes = indice.get(canonico);
            if (!existentes.some(item => item?.resourceName === persona?.resourceName)) {
                existentes.push(persona);
            }
        }
    }
    return indice;
}

function extraerTextoMensaje(mensaje) {
    let contenido = mensaje?.message || mensaje;
    for (let nivel = 0; nivel < 5 && contenido && typeof contenido === 'object'; nivel += 1) {
        if (typeof contenido.conversation === 'string') return contenido.conversation;
        if (typeof contenido.extendedTextMessage?.text === 'string') {
            return contenido.extendedTextMessage.text;
        }
        if (typeof contenido.imageMessage?.caption === 'string') return contenido.imageMessage.caption;
        if (typeof contenido.videoMessage?.caption === 'string') return contenido.videoMessage.caption;
        contenido = contenido.ephemeralMessage?.message
            || contenido.viewOnceMessage?.message
            || contenido.viewOnceMessageV2?.message
            || contenido.documentWithCaptionMessage?.message;
    }
    return '';
}

function esJidPn(jid) {
    return typeof jid === 'string' && /@(?:s\.whatsapp\.net|c\.us|hosted)$/iu.test(jid);
}

function esJidLid(jid) {
    return typeof jid === 'string' && /@(?:hosted\.)?lid$/iu.test(jid);
}

function obtenerPrimerJidLid(candidatos) {
    for (const valor of Array.isArray(candidatos) ? candidatos : [candidatos]) {
        const jid = textoSeguro(valor, 240);
        if (esJidLid(jid)) return jid;
    }
    return null;
}

function esTimestampLecturaValido(valor) {
    if (typeof valor === 'bigint') return valor > 0n;
    if (typeof valor === 'number') return Number.isFinite(valor) && valor > 0;
    if (typeof valor === 'string') return /^\d+$/u.test(valor) && Number(valor) > 0;
    if (!valor || typeof valor !== 'object') return false;
    if (typeof valor.toNumber === 'function') {
        try {
            return esTimestampLecturaValido(valor.toNumber());
        } catch {
            return false;
        }
    }
    if (Number.isInteger(valor.low) && Number.isInteger(valor.high)) {
        return valor.high > 0 || valor.low > 0;
    }
    return false;
}

function enteroTimestamp(valor) {
    if (typeof valor === 'bigint') return valor > 0n ? valor : null;
    if (typeof valor === 'number') {
        return Number.isFinite(valor) && valor > 0 ? BigInt(Math.trunc(valor)) : null;
    }
    if (typeof valor === 'string' && /^\d+$/u.test(valor)) {
        const numero = BigInt(valor);
        return numero > 0n ? numero : null;
    }
    if (!valor || typeof valor !== 'object') return null;
    if (typeof valor.toString === 'function') {
        const texto = valor.toString();
        if (/^\d+$/u.test(texto) && texto !== '[object Object]') {
            const numero = BigInt(texto);
            if (numero > 0n) return numero;
        }
    }
    if (Number.isInteger(valor.low) && Number.isInteger(valor.high)) {
        const alto = BigInt(valor.high >>> 0);
        const bajo = BigInt(valor.low >>> 0);
        const numero = (alto << 32n) | bajo;
        return numero > 0n ? numero : null;
    }
    return null;
}

/** Normaliza segundos o milisegundos de Baileys a milisegundos Unix. */
function normalizarTimestampMensaje(valor) {
    const numero = enteroTimestamp(valor);
    if (numero === null) return null;
    // Los timestamps Unix en segundos siguen muy por debajo de 10^12.
    const milisegundos = numero < 1000000000000n ? numero * 1000n : numero;
    if (milisegundos > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(milisegundos);
}

function normalizarOrigenMensajes(opciones) {
    const valor = textoSeguro(opciones?.origen || opciones?.source, 30).toLowerCase();
    return ['historial', 'history', 'reciente', 'recent'].includes(valor)
        ? 'historial'
        : 'vivo';
}

function obtenerFuenteUsuarioMensaje(mensaje, origen, evento, posicion) {
    return {
        timestamp: normalizarTimestampMensaje(mensaje?.messageTimestamp),
        id: textoSeguro(mensaje?.key?.id, 240) || null,
        origen,
        evento,
        posicion
    };
}

function fuenteActualCandidato(candidato) {
    return {
        timestamp: normalizarTimestampMensaje(candidato?.usuarioMensajeTimestamp),
        id: textoSeguro(candidato?.usuarioMensajeId, 240) || null,
        origen: candidato?.usuarioMensajeOrigen === 'historial' ? 'historial' : 'vivo',
        evento: Number.isSafeInteger(candidato?.usuarioMensajeEvento)
            ? candidato.usuarioMensajeEvento
            : 0,
        posicion: Number.isSafeInteger(candidato?.usuarioMensajePosicion)
            ? candidato.usuarioMensajePosicion
            : 0
    };
}

function fuenteUsuarioEsMasReciente(candidato, fuenteNueva) {
    if (!candidato?.usuario) return true;
    const fuenteActual = fuenteActualCandidato(candidato);
    if (fuenteNueva.timestamp !== null) {
        if (fuenteActual.timestamp === null) return true;
        if (fuenteNueva.timestamp !== fuenteActual.timestamp) {
            return fuenteNueva.timestamp > fuenteActual.timestamp;
        }
        // Los ID de WhatsApp no expresan orden temporal. Cuando dos mensajes
        // comparten segundo, usamos el orden del evento recibido; un chunk
        // histórico tardío nunca revierte silenciosamente el dato actual.
        if (fuenteNueva.origen !== fuenteActual.origen) {
            return fuenteNueva.origen === 'vivo';
        }
        if (fuenteNueva.evento === fuenteActual.evento) {
            return fuenteNueva.posicion > fuenteActual.posicion;
        }
        return fuenteNueva.origen === 'vivo'
            ? fuenteNueva.evento > fuenteActual.evento
            : false;
    }
    if (fuenteActual.timestamp !== null) return false;

    if (fuenteNueva.origen !== fuenteActual.origen) {
        return fuenteNueva.origen === 'vivo';
    }
    if (fuenteNueva.origen === 'historial' && fuenteNueva.evento !== fuenteActual.evento) {
        // Un chunk histórico que llega tarde no tiene autoridad para revertir
        // otro dato histórico sin fecha conocida.
        return false;
    }
    if (fuenteNueva.evento !== fuenteActual.evento) {
        return fuenteNueva.evento > fuenteActual.evento;
    }
    return fuenteNueva.posicion > fuenteActual.posicion;
}

function crearIdCuenta(identidad) {
    const base = textoSeguro(identidad, 300).toLowerCase();
    return `google-${crypto.createHash('sha256').update(base).digest('hex').slice(0, 20)}`;
}

function base64Url(buffer) {
    return Buffer.from(buffer).toString('base64url');
}

async function leerRespuestaJson(respuesta, codigo) {
    let datos = null;
    try {
        datos = await respuesta.json();
    } catch {
        datos = null;
    }
    if (!respuesta.ok) {
        const detalle = textoSeguro(datos?.error_description || datos?.error?.message || '', 240);
        throw new ErrorAgendamiento(
            codigo,
            detalle ? `Google rechazó la solicitud: ${detalle}` : 'Google rechazó la solicitud.',
            null,
            respuesta.status
        );
    }
    return datos || {};
}

function normalizarCredenciales(datos) {
    let entrada = datos;
    if (typeof entrada === 'string') {
        const texto = entrada.trim();
        entrada = texto.startsWith('{')
            ? JSON.parse(texto)
            : JSON.parse(fs.readFileSync(path.resolve(texto), 'utf8'));
    }
    const credenciales = entrada?.installed || entrada?.web || entrada;
    const clientId = textoSeguro(credenciales?.client_id || credenciales?.clientId, 500);
    const clientSecret = textoSeguro(
        credenciales?.client_secret || credenciales?.clientSecret,
        500
    );
    const authUri = textoSeguro(
        credenciales?.auth_uri || credenciales?.authUri || 'https://accounts.google.com/o/oauth2/v2/auth',
        500
    );
    const tokenUri = textoSeguro(
        credenciales?.token_uri || credenciales?.tokenUri || 'https://oauth2.googleapis.com/token',
        500
    );
    if (!clientId || !clientSecret || !authUri || !tokenUri) {
        throw new ErrorAgendamiento(
            'CREDENCIALES_INVALIDAS',
            'El JSON debe contener client_id, client_secret, auth_uri y token_uri.'
        );
    }
    let urlAuth;
    let urlToken;
    try {
        urlAuth = new URL(authUri);
        urlToken = new URL(tokenUri);
    } catch {
        throw new ErrorAgendamiento(
            'CREDENCIALES_INVALIDAS',
            'Las direcciones OAuth de Google no son válidas.'
        );
    }
    const origenAuthValido = urlAuth.protocol === 'https:'
        && urlAuth.hostname === 'accounts.google.com'
        && !urlAuth.username
        && !urlAuth.password
        && !urlAuth.port;
    const tokenValido = urlToken.protocol === 'https:'
        && urlToken.hostname === 'oauth2.googleapis.com'
        && urlToken.pathname === '/token'
        && !urlToken.username
        && !urlToken.password
        && !urlToken.port
        && !urlToken.search
        && !urlToken.hash;
    if (!origenAuthValido || !tokenValido) {
        throw new ErrorAgendamiento(
            'CREDENCIALES_INVALIDAS',
            'Las credenciales deben usar los endpoints HTTPS oficiales de Google.'
        );
    }
    return { clientId, clientSecret, authUri, tokenUri };
}

function sanitizarCuenta(cuenta) {
    return {
        id: cuenta.id,
        correo: cuenta.correo || '',
        nombre: cuenta.nombre || cuenta.correo || 'Cuenta de Google',
        creadaEn: cuenta.creadaEn || null,
        actualizadaEn: cuenta.actualizadaEn || null
    };
}

class ServicioAgendamiento extends EventEmitter {
    constructor(opciones = {}) {
        super();
        this.rutaDatos = path.resolve(
            opciones.rutaDatos || path.join(process.cwd(), 'agendamiento.json')
        );
        this.codigoPais = normalizarCodigoPais(opciones.codigoPais || '595');
        this.fetch = opciones.fetch || globalThis.fetch;
        this.abrirEnlace = opciones.abrirEnlace || (async () => {});
        this.cifrar = opciones.cifrar;
        this.descifrar = opciones.descifrar;
        this.obtenerLinea = opciones.obtenerLinea;
        this.ahora = opciones.ahora || (() => new Date());
        this.oauthTimeoutMs = Number(opciones.oauthTimeoutMs) || 180000;
        const timeoutSolicitudes = Number(opciones.requestTimeoutMs);
        this.requestTimeoutMs = Number.isFinite(timeoutSolicitudes) && timeoutSolicitudes >= 10
            ? Math.min(timeoutSolicitudes, 120000)
            : 30000;
        this.estado = estadoInicial();
        this.cargado = false;
        this.tokensAcceso = new Map();
        this.sincronizacion = null;
        this.reservaSincronizacion = null;
        this.ultimoProgreso = null;
        this.servidorOAuth = null;
        this.cargar();
    }

    cargar() {
        if (this.cargado) return this;
        this.estado = leerJsonSeguro(this.rutaDatos);
        this.cargado = true;
        return this;
    }

    guardar() {
        escribirJsonAtomico(this.rutaDatos, this.estado);
    }

    async fetchGoogle(url, opciones = {}) {
        const signalExterna = opciones.signal;
        const controlador = new AbortController();
        let vencido = false;
        const cancelarExterno = () => controlador.abort(signalExterna?.reason);
        if (signalExterna?.aborted) cancelarExterno();
        else signalExterna?.addEventListener('abort', cancelarExterno, { once: true });
        const temporizador = setTimeout(() => {
            vencido = true;
            controlador.abort(new DOMException('Timeout', 'TimeoutError'));
        }, this.requestTimeoutMs);
        temporizador.unref?.();
        try {
            return await this.fetch(url, { ...opciones, signal: controlador.signal });
        } catch (error) {
            if (vencido) {
                throw new ErrorAgendamiento(
                    'GOOGLE_TIMEOUT',
                    'Google no respondió dentro del tiempo de seguridad.',
                    error
                );
            }
            if (signalExterna?.aborted || error?.name === 'AbortError') throw error;
            if (error instanceof ErrorAgendamiento) throw error;
            throw new ErrorAgendamiento(
                'GOOGLE_RED',
                'No se pudo comunicar con Google.',
                error
            );
        } finally {
            clearTimeout(temporizador);
            signalExterna?.removeEventListener('abort', cancelarExterno);
        }
    }

    invalidarResultadosLinea(lineaId) {
        const linea = this.estado.lineas[lineaId];
        let invalidados = 0;
        for (const candidato of Object.values(linea?.candidatos || {})) {
            if (candidato?.ultimoResultado) {
                candidato.ultimoResultado = null;
                invalidados += 1;
            }
        }
        return invalidados;
    }

    obtenerConfiguracionBusqueda() {
        return clonarSeguro({
            palabrasClave: normalizarPalabrasClaveUsuario(
                this.estado?.busqueda?.palabrasClaveUsuario
            ),
            actualizadaEn: this.estado?.busqueda?.actualizadaEn || null,
            maximoPalabrasClave: MAXIMO_PALABRAS_CLAVE_USUARIO,
            maximoCaracteresPorFrase: MAXIMO_CARACTERES_PALABRA_CLAVE
        });
    }

    configurarPalabrasClaveUsuario(entrada) {
        if (this.sincronizacion || this.reservaSincronizacion) {
            throw new ErrorAgendamiento(
                'SINCRONIZACION_ACTIVA',
                'Detené el agendamiento antes de cambiar las palabras clave.'
            );
        }

        const palabrasClave = normalizarPalabrasClaveUsuario(entrada, {
            estricto: true
        });
        this.estado.busqueda = {
            palabrasClaveUsuario: palabrasClave,
            actualizadaEn: fechaIso(this.ahora)
        };
        this.guardar();
        return this.obtenerConfiguracionBusqueda();
    }

    configurarCredenciales(datos) {
        const nuevas = normalizarCredenciales(datos);
        const clientIdAnterior = this.estado.oauth?.clientId || null;
        const cambioCliente = clientIdAnterior
            ? clientIdAnterior !== nuevas.clientId
            : this.estado.cuentas.length > 0;
        const desconectadas = cambioCliente ? this.estado.cuentas.length : 0;
        if (cambioCliente) {
            for (const lineaId of Object.keys(this.estado.asociaciones)) {
                this.invalidarResultadosLinea(lineaId);
            }
            this.estado.cuentas = [];
            this.estado.asociaciones = {};
            this.tokensAcceso.clear();
        }
        this.estado.oauth = nuevas;
        this.guardar();
        return {
            configuradas: true,
            clientId: this.estado.oauth.clientId,
            desconectadas
        };
    }

    listarCuentas() {
        return this.estado.cuentas.map(sanitizarCuenta);
    }

    async desconectarCuenta(id) {
        const indice = this.estado.cuentas.findIndex(cuenta => cuenta.id === id);
        if (indice < 0) return false;
        const cuenta = this.estado.cuentas[indice];
        if (this.descifrar && this.fetch && cuenta.refreshTokenCifrado) {
            try {
                const token = await this.descifrar(cuenta.refreshTokenCifrado, { cuentaId: id });
                await this.fetchGoogle('https://oauth2.googleapis.com/revoke', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ token })
                });
            } catch {
                // La desconexión local no depende de que Google responda al revocado.
            }
        }
        this.estado.cuentas.splice(indice, 1);
        for (const [lineaId, cuentaId] of Object.entries(this.estado.asociaciones)) {
            if (cuentaId === id) {
                this.invalidarResultadosLinea(lineaId);
                delete this.estado.asociaciones[lineaId];
            }
        }
        this.tokensAcceso.delete(id);
        this.guardar();
        return true;
    }

    asociarCuenta(linea, cuentaId) {
        const cuenta = this.estado.cuentas.find(item => item.id === cuentaId);
        if (!cuenta) {
            throw new ErrorAgendamiento('CUENTA_NO_EXISTE', 'La cuenta de Google no existe.');
        }
        const info = this.resolverLineaSync(linea);
        const cuentaAnterior = this.estado.asociaciones[info.id];
        if (cuentaAnterior && cuentaAnterior !== cuentaId) {
            this.invalidarResultadosLinea(info.id);
        }
        this.estado.asociaciones[info.id] = cuentaId;
        this.asegurarLinea(info);
        this.guardar();
        return { lineaId: info.id, cuentaId };
    }

    resolverLineaSync(linea) {
        const valor = linea && typeof linea === 'object'
            ? linea
            : { id: String(linea || ''), nombre: String(linea || '') };
        const id = textoSeguro(valor.id || valor.nombre, 180);
        const nombre = textoSeguro(valor.nombre || valor.id, 180);
        if (!id || !nombre) {
            throw new ErrorAgendamiento('LINEA_INVALIDA', 'No se pudo identificar la línea.');
        }
        return { id, nombre };
    }

    async resolverLinea(linea) {
        if (this.obtenerLinea) {
            const resuelta = await this.obtenerLinea(linea);
            if (resuelta) return this.resolverLineaSync(resuelta);
        }
        return this.resolverLineaSync(linea);
    }

    asegurarLinea(info) {
        const actual = this.estado.lineas[info.id];
        if (!actual || typeof actual !== 'object') {
            this.estado.lineas[info.id] = {
                id: info.id,
                nombre: info.nombre,
                prefijo: obtenerPrefijoLinea(info.nombre),
                candidatos: {},
                pendientesJid: {},
                secuenciaMensajes: 0,
                actualizadaEn: fechaIso(this.ahora)
            };
        } else {
            if (!Number.isSafeInteger(actual.secuenciaMensajes)) actual.secuenciaMensajes = 0;
            if (!actual.pendientesJid || typeof actual.pendientesJid !== 'object') {
                actual.pendientesJid = {};
            }
            const prefijoAnterior = actual.prefijo || obtenerPrefijoLinea(actual.nombre);
            const prefijoNuevo = obtenerPrefijoLinea(info.nombre);
            if (prefijoAnterior !== prefijoNuevo) {
                for (const candidato of Object.values(actual.candidatos || {})) {
                    if (candidato && typeof candidato === 'object') {
                        candidato.ultimoResultado = null;
                    }
                }
            }
            actual.nombre = info.nombre;
            actual.prefijo = prefijoNuevo;
        }
        return this.estado.lineas[info.id];
    }

    asegurarCandidato(linea, telefono) {
        if (!linea.candidatos[telefono]) {
            linea.candidatos[telefono] = {
                telefono,
                usuario: null,
                usuarioMensajeTimestamp: null,
                usuarioMensajeId: null,
                usuarioMensajeOrigen: null,
                usuarioMensajeEvento: 0,
                usuarioMensajePosicion: 0,
                mutuo: false,
                senales: { vioEstado: null, publicoEstado: null },
                detectadoEn: fechaIso(this.ahora),
                actualizadoEn: fechaIso(this.ahora),
                ultimoResultado: null
            };
        }
        return linea.candidatos[telefono];
    }

    asegurarPendienteJid(linea, jidEntrada) {
        const jid = textoSeguro(jidEntrada, 240);
        if (!esJidLid(jid)) return null;
        if (!linea.pendientesJid[jid]) {
            linea.pendientesJid[jid] = {
                jid,
                usuario: null,
                usuarioMensajeTimestamp: null,
                usuarioMensajeId: null,
                usuarioMensajeOrigen: null,
                usuarioMensajeEvento: 0,
                usuarioMensajePosicion: 0,
                senales: { vioEstado: null, publicoEstado: null },
                detectadoEn: fechaIso(this.ahora),
                actualizadoEn: fechaIso(this.ahora)
            };
        }
        return linea.pendientesJid[jid];
    }

    async resolverTelefono(jid, resolverJid, contexto) {
        let valor = jid;
        if (esJidLid(valor)) {
            if (!resolverJid) return null;
            valor = await resolverJid(valor, contexto);
        } else if (!esJidPn(valor) && resolverJid) {
            const resuelto = await resolverJid(valor, contexto);
            if (resuelto) valor = resuelto;
        }
        if (valor && typeof valor === 'object') {
            valor = valor.telefono || valor.numero || valor.jid;
        }
        // Un LID no es un teléfono aunque su parte local esté formada por
        // dígitos. Sólo puede continuar después de una resolución real a PN.
        if (esJidLid(valor)) return null;
        return normalizarTelefono(valor, this.codigoPais);
    }

    async resolverPrimerTelefono(candidatos, resolverJid, contexto) {
        const vistos = new Set();
        for (const jid of Array.isArray(candidatos) ? candidatos : [candidatos]) {
            const clave = typeof jid === 'string' ? jid : JSON.stringify(jid || null);
            if (!jid || vistos.has(clave)) continue;
            vistos.add(clave);
            const telefono = await this.resolverTelefono(jid, resolverJid, contexto);
            if (telefono) return telefono;
        }
        return null;
    }

    async registrarMensajes(lineaEntrada, mensajes, resolverJid, opciones = {}) {
        if (resolverJid && typeof resolverJid === 'object') {
            opciones = resolverJid;
            resolverJid = undefined;
        }
        const info = await this.resolverLinea(lineaEntrada);
        const linea = this.asegurarLinea(info);
        linea.secuenciaMensajes += 1;
        const evento = linea.secuenciaMensajes;
        const origen = normalizarOrigenMensajes(opciones);
        const listaMensajes = Array.isArray(mensajes) ? mensajes : [];
        let detectados = 0;
        let actualizados = 0;
        let omitidos = 0;

        for (let indice = 0; indice < listaMensajes.length; indice += 1) {
            const mensaje = listaMensajes[indice];
            if (mensaje?.key?.fromMe !== true) {
                omitidos += 1;
                continue;
            }
            const remoteJid = mensaje?.key?.remoteJid;
            if (
                !remoteJid
                || remoteJid === 'status@broadcast'
                || remoteJid?.endsWith('@g.us')
            ) {
                omitidos += 1;
                continue;
            }
            const resultado = parsearUsuarioPorPalabrasClave(
                extraerTextoMensaje(mensaje),
                this.estado?.busqueda?.palabrasClaveUsuario
            );
            if (!resultado) {
                omitidos += 1;
                continue;
            }
            const fuente = obtenerFuenteUsuarioMensaje(
                mensaje,
                origen,
                evento,
                listaMensajes.length - indice
            );
            const telefono = await this.resolverPrimerTelefono(
                [remoteJid],
                resolverJid,
                mensaje
            );
            if (!telefono) {
                const pendiente = this.asegurarPendienteJid(linea, remoteJid);
                if (!pendiente) {
                    omitidos += 1;
                    continue;
                }
                detectados += 1;
                if (!fuenteUsuarioEsMasReciente(pendiente, fuente)) continue;
                pendiente.usuario = resultado.usuario;
                pendiente.usuarioMensajeTimestamp = fuente.timestamp;
                pendiente.usuarioMensajeId = fuente.id;
                pendiente.usuarioMensajeOrigen = fuente.origen;
                pendiente.usuarioMensajeEvento = fuente.evento;
                pendiente.usuarioMensajePosicion = fuente.posicion;
                pendiente.actualizadoEn = fechaIso(this.ahora);
                actualizados += 1;
                continue;
            }
            const candidato = this.asegurarCandidato(linea, telefono);
            detectados += 1;
            if (!fuenteUsuarioEsMasReciente(candidato, fuente)) continue;
            if (candidato.usuario !== resultado.usuario) {
                candidato.ultimoResultado = null;
            }
            candidato.usuario = resultado.usuario;
            candidato.usuarioMensajeTimestamp = fuente.timestamp;
            candidato.usuarioMensajeId = fuente.id;
            candidato.usuarioMensajeOrigen = fuente.origen;
            candidato.usuarioMensajeEvento = fuente.evento;
            candidato.usuarioMensajePosicion = fuente.posicion;
            candidato.usuarioDetectadoEn = fechaIso(this.ahora);
            candidato.actualizadoEn = fechaIso(this.ahora);
            actualizados += 1;
        }

        linea.actualizadaEn = fechaIso(this.ahora);
        if (detectados) this.guardar();
        return {
            detectados,
            actualizados,
            omitidos,
            total: Object.keys(linea.candidatos).length
        };
    }

    async registrarSenal(linea, jids, tipo, resolverJid, contexto) {
        const telefono = await this.resolverPrimerTelefono(jids, resolverJid, contexto);
        const instante = fechaIso(this.ahora);
        if (!telefono) {
            const jid = obtenerPrimerJidLid(jids);
            const pendiente = this.asegurarPendienteJid(linea, jid);
            if (!pendiente) return false;
            pendiente.senales[tipo] = instante;
            pendiente.actualizadoEn = instante;
            return true;
        }
        const candidato = this.asegurarCandidato(linea, telefono);
        if (!candidato.mutuo) candidato.ultimoResultado = null;
        candidato.senales[tipo] = instante;
        candidato.mutuo = true;
        candidato.actualizadoEn = instante;
        return true;
    }

    async registrarPublicadoresEstado(lineaEntrada, mensajes, resolverJid) {
        const info = await this.resolverLinea(lineaEntrada);
        const linea = this.asegurarLinea(info);
        let detectados = 0;
        for (const mensaje of Array.isArray(mensajes) ? mensajes : []) {
            if (mensaje?.key?.remoteJid !== 'status@broadcast' || mensaje?.key?.fromMe) continue;
            const jids = [
                mensaje?.participantAlt,
                mensaje?.participant,
                mensaje?.key?.participantAlt,
                mensaje?.key?.participant,
                mensaje?.key?.remoteJidAlt
            ];
            if (await this.registrarSenal(linea, jids, 'publicoEstado', resolverJid, mensaje)) {
                detectados += 1;
            }
        }
        linea.actualizadaEn = fechaIso(this.ahora);
        if (detectados) this.guardar();
        return { detectados, total: Object.keys(linea.candidatos).length };
    }

    async registrarVistasEstado(
        lineaEntrada,
        actualizaciones,
        validarId,
        resolverJid
    ) {
        const info = await this.resolverLinea(lineaEntrada);
        const linea = this.asegurarLinea(info);
        let detectados = 0;
        for (const actualizacion of Array.isArray(actualizaciones) ? actualizaciones : []) {
            const id = actualizacion?.key?.id;
            if (!id || actualizacion?.key?.remoteJid !== 'status@broadcast') continue;
            const recibo = actualizacion?.receipt || actualizacion?.update || {};
            if (!esTimestampLecturaValido(recibo.readTimestamp)) continue;
            const valido = typeof validarId === 'function'
                ? await validarId(id, lineaEntrada, actualizacion)
                : false;
            if (!valido) continue;
            const jids = [
                recibo.userJid,
                recibo.participantAlt,
                recibo.participant,
                actualizacion?.participantAlt,
                actualizacion?.participant,
                actualizacion?.key?.participantAlt,
                actualizacion?.key?.participant,
                actualizacion?.key?.remoteJidAlt
            ];
            if (await this.registrarSenal(linea, jids, 'vioEstado', resolverJid, actualizacion)) {
                detectados += 1;
            }
        }
        linea.actualizadaEn = fechaIso(this.ahora);
        if (detectados) this.guardar();
        return { detectados, total: Object.keys(linea.candidatos).length };
    }

    async resolverPendientesJid(lineaEntrada, resolverJid) {
        if (typeof resolverJid !== 'function') {
            throw new ErrorAgendamiento(
                'RESOLVEDOR_JID_REQUERIDO',
                'Se necesita el resolvedor LID → PN de la línea.'
            );
        }
        const info = await this.resolverLinea(lineaEntrada);
        const linea = this.asegurarLinea(info);
        let resueltos = 0;
        for (const [jid, pendiente] of Object.entries(linea.pendientesJid || {})) {
            const telefono = await this.resolverTelefono(
                jid,
                resolverJid,
                { pendiente: true, lineaId: info.id }
            );
            if (!telefono) continue;
            const candidato = this.asegurarCandidato(linea, telefono);
            if (pendiente.usuario) {
                const fuente = fuenteActualCandidato(pendiente);
                if (fuenteUsuarioEsMasReciente(candidato, fuente)) {
                    if (candidato.usuario !== pendiente.usuario) {
                        candidato.ultimoResultado = null;
                    }
                    candidato.usuario = pendiente.usuario;
                    candidato.usuarioMensajeTimestamp = fuente.timestamp;
                    candidato.usuarioMensajeId = fuente.id;
                    candidato.usuarioMensajeOrigen = fuente.origen;
                    candidato.usuarioMensajeEvento = fuente.evento;
                    candidato.usuarioMensajePosicion = fuente.posicion;
                    candidato.usuarioDetectadoEn = pendiente.actualizadoEn;
                }
            }
            const tieneSenal = Boolean(
                pendiente.senales?.vioEstado || pendiente.senales?.publicoEstado
            );
            if (tieneSenal) {
                if (!candidato.mutuo) candidato.ultimoResultado = null;
                candidato.mutuo = true;
                for (const tipo of ['vioEstado', 'publicoEstado']) {
                    const nueva = pendiente.senales?.[tipo];
                    if (nueva && (!candidato.senales[tipo] || nueva > candidato.senales[tipo])) {
                        candidato.senales[tipo] = nueva;
                    }
                }
            }
            candidato.actualizadoEn = fechaIso(this.ahora);
            delete linea.pendientesJid[jid];
            resueltos += 1;
        }
        if (resueltos) {
            linea.actualizadaEn = fechaIso(this.ahora);
            this.guardar();
        }
        return {
            resueltos,
            pendientes: Object.keys(linea.pendientesJid || {}).length,
            totalCandidatos: Object.keys(linea.candidatos || {}).length
        };
    }

    obtenerVista(lineaEntrada) {
        const info = this.resolverLineaSync(lineaEntrada);
        const existente = this.estado.lineas[info.id];
        const infoActual = typeof lineaEntrada === 'object' || !existente
            ? info
            : { id: existente.id, nombre: existente.nombre };
        const linea = this.asegurarLinea(infoActual);
        const cuentaAsociada = this.estado.asociaciones[info.id] || null;
        const candidatos = Object.values(linea.candidatos || {})
            .map(candidato => ({
                telefono: candidato.telefono,
                usuario: candidato.usuario,
                mutuo: Boolean(candidato.mutuo),
                senales: clonarSeguro(candidato.senales || {}),
                nombreObjetivo: candidato.usuario
                    ? crearNombreGestionado(
                        linea.nombre,
                        candidato.usuario,
                        Boolean(candidato.mutuo)
                    )
                    : null,
                ultimoResultado: candidato.ultimoResultado
                    ? clonarSeguro(candidato.ultimoResultado)
                    : null,
                sincronizado: candidatoEstaSincronizado(candidato, cuentaAsociada)
            }))
            .sort((a, b) => (a.usuario || a.telefono).localeCompare(b.usuario || b.telefono));
        const pendientesResolucion = Object.values(linea.pendientesJid || {})
            .filter(item => Boolean(item?.usuario))
            .map(item => ({
                telefono: null,
                usuario: item.usuario,
                mutuo: Boolean(
                    item.senales?.vioEstado || item.senales?.publicoEstado
                ),
                senales: clonarSeguro(item.senales || {}),
                nombreObjetivo: crearNombreGestionado(
                    linea.nombre,
                    item.usuario,
                    Boolean(
                        item.senales?.vioEstado || item.senales?.publicoEstado
                    )
                ),
                ultimoResultado: null,
                sincronizado: false,
                pendienteResolucion: true
            }));
        return {
            linea: { id: linea.id, nombre: linea.nombre, prefijo: linea.prefijo || null },
            cuentaId: cuentaAsociada,
            credencialesConfiguradas: Boolean(this.estado.oauth),
            cuentas: this.listarCuentas(),
            busqueda: this.obtenerConfiguracionBusqueda(),
            candidatos,
            pendientesResolucion,
            totales: {
                candidatos: candidatos.length,
                conUsuario: candidatos.filter(item => item.usuario).length,
                mutuos: candidatos.filter(item => item.mutuo).length,
                pendientes: candidatos.filter(item => !item.usuario).length,
                jidsPendientes: Object.keys(linea.pendientesJid || {}).length,
                usuariosPendientesJid: Object.values(linea.pendientesJid || {})
                    .filter(item => Boolean(item?.usuario)).length
            },
            sincronizacion: this.sincronizacion
                ? clonarSeguro(this.sincronizacion.progreso)
                : (this.ultimoProgreso ? clonarSeguro(this.ultimoProgreso) : null)
        };
    }

    async iniciarOAuth() {
        if (!this.fetch) {
            throw new ErrorAgendamiento('FETCH_NO_DISPONIBLE', 'No hay un cliente HTTP disponible.');
        }
        if (!this.estado.oauth) {
            throw new ErrorAgendamiento(
                'CREDENCIALES_NO_CONFIGURADAS',
                'Primero configurá las credenciales de Google.'
            );
        }
        if (this.servidorOAuth) {
            throw new ErrorAgendamiento('OAUTH_EN_CURSO', 'Ya hay una vinculación en curso.');
        }

        const estadoOAuth = base64Url(crypto.randomBytes(32));
        const verificador = base64Url(crypto.randomBytes(64));
        const desafio = base64Url(crypto.createHash('sha256').update(verificador).digest());
        const { clientId, authUri } = this.estado.oauth;

        return new Promise((resolve, reject) => {
            let finalizado = false;
            let temporizador;
            const terminar = (error, resultado) => {
                if (finalizado) return;
                finalizado = true;
                clearTimeout(temporizador);
                const servidor = this.servidorOAuth;
                this.servidorOAuth = null;
                if (servidor) servidor.close(() => {});
                if (error) reject(error);
                else resolve(resultado);
            };

            const servidor = http.createServer(async (req, res) => {
                try {
                    const direccion = servidor.address();
                    const base = `http://127.0.0.1:${direccion.port}`;
                    const url = new URL(req.url, base);
                    if (url.pathname !== '/') {
                        res.writeHead(404).end('No encontrado');
                        return;
                    }
                    if (req.method !== 'GET') {
                        res.writeHead(405, { Allow: 'GET' }).end('Método no permitido');
                        return;
                    }
                    if (url.searchParams.get('state') !== estadoOAuth) {
                        res.writeHead(400).end('Vinculación no válida');
                        return;
                    }
                    const errorGoogle = url.searchParams.get('error');
                    if (errorGoogle) {
                        throw new ErrorAgendamiento(
                            'OAUTH_CANCELADO',
                            `Google canceló la vinculación: ${textoSeguro(errorGoogle, 80)}`
                        );
                    }
                    const codigo = url.searchParams.get('code');
                    if (!codigo) {
                        res.writeHead(400).end('Falta el código de autorización');
                        return;
                    }
                    const cuenta = await this.completarOAuth(codigo, verificador, base);
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<!doctype html><meta charset="utf-8"><title>AutoStatues</title><p>Cuenta conectada. Ya podés cerrar esta ventana.</p>');
                    terminar(null, sanitizarCuenta(cuenta));
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('No se pudo conectar la cuenta. Volvé a AutoStatues.');
                    terminar(error);
                }
            });

            servidor.on('error', error => terminar(new ErrorAgendamiento(
                'OAUTH_SERVIDOR',
                `No se pudo abrir el retorno local de Google: ${error.message}`,
                error
            )));
            // Bloquea una segunda vinculación también durante el breve lapso
            // anterior al callback de `listen`.
            this.servidorOAuth = servidor;
            servidor.listen(0, '127.0.0.1', async () => {
                const direccion = servidor.address();
                const redirectUri = `http://127.0.0.1:${direccion.port}`;
                const url = new URL(authUri);
                url.search = new URLSearchParams({
                    client_id: clientId,
                    redirect_uri: redirectUri,
                    response_type: 'code',
                    scope: GOOGLE_SCOPES.join(' '),
                    access_type: 'offline',
                    prompt: 'consent select_account',
                    include_granted_scopes: 'true',
                    code_challenge: desafio,
                    code_challenge_method: 'S256',
                    state: estadoOAuth
                }).toString();
                try {
                    await this.abrirEnlace(url.toString());
                    this.emit('oauth-url', url.toString());
                } catch (error) {
                    terminar(new ErrorAgendamiento(
                        'OAUTH_NAVEGADOR',
                        `No se pudo abrir Google: ${error.message}`,
                        error
                    ));
                }
            });
            temporizador = setTimeout(() => terminar(new ErrorAgendamiento(
                'OAUTH_TIMEOUT',
                'La vinculación con Google superó el tiempo disponible.'
            )), this.oauthTimeoutMs);
        });
    }

    async completarOAuth(codigo, verificador, redirectUri) {
        const { clientId, clientSecret, tokenUri } = this.estado.oauth;
        const respuestaToken = await this.fetchGoogle(tokenUri, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code: codigo,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
                code_verifier: verificador
            })
        });
        const tokens = await leerRespuestaJson(respuestaToken, 'OAUTH_TOKEN');
        if (!tokens.access_token) {
            throw new ErrorAgendamiento('OAUTH_TOKEN', 'Google no devolvió un token de acceso.');
        }
        const respuestaPerfil = await this.fetchGoogle(GOOGLE_USERINFO_URL, {
            headers: { Authorization: `Bearer ${tokens.access_token}` }
        });
        const perfil = await leerRespuestaJson(respuestaPerfil, 'OAUTH_PERFIL');
        const identidad = perfil.sub || perfil.email;
        if (!identidad) {
            throw new ErrorAgendamiento('OAUTH_PERFIL', 'No se pudo identificar la cuenta de Google.');
        }
        const id = crearIdCuenta(identidad);
        const existente = this.estado.cuentas.find(cuenta => cuenta.id === id);
        let refreshTokenCifrado = existente?.refreshTokenCifrado;
        if (tokens.refresh_token) {
            if (typeof this.cifrar !== 'function') {
                throw new ErrorAgendamiento(
                    'CIFRADO_NO_CONFIGURADO',
                    'No se configuró el cifrado seguro del token de Google.'
                );
            }
            refreshTokenCifrado = await this.cifrar(tokens.refresh_token, { cuentaId: id });
            if (
                typeof refreshTokenCifrado !== 'string'
                || !refreshTokenCifrado
                || refreshTokenCifrado === tokens.refresh_token
            ) {
                throw new ErrorAgendamiento(
                    'CIFRADO_INVALIDO',
                    'El token de Google no fue cifrado de forma segura.'
                );
            }
        }
        if (!refreshTokenCifrado) {
            throw new ErrorAgendamiento(
                'OAUTH_SIN_REFRESH',
                'Google no devolvió permiso permanente. Intentá vincular la cuenta otra vez.'
            );
        }
        const instante = fechaIso(this.ahora);
        const cuenta = {
            id,
            correo: textoSeguro(perfil.email, 240),
            nombre: textoSeguro(perfil.name || perfil.email, 240),
            refreshTokenCifrado,
            creadaEn: existente?.creadaEn || instante,
            actualizadaEn: instante
        };
        if (existente) Object.assign(existente, cuenta);
        else this.estado.cuentas.push(cuenta);
        this.tokensAcceso.set(id, {
            token: tokens.access_token,
            venceEn: Date.now() + Math.max(30, Number(tokens.expires_in) || 3600) * 1000
        });
        this.guardar();
        return cuenta;
    }

    async obtenerTokenAcceso(cuentaId, signal) {
        const cache = this.tokensAcceso.get(cuentaId);
        if (cache && cache.venceEn - Date.now() > 60000) return cache.token;
        const cuenta = this.estado.cuentas.find(item => item.id === cuentaId);
        if (!cuenta) throw new ErrorAgendamiento('CUENTA_NO_EXISTE', 'La cuenta no existe.');
        if (typeof this.descifrar !== 'function') {
            throw new ErrorAgendamiento(
                'DESCIFRADO_NO_CONFIGURADO',
                'No se configuró el acceso seguro al token de Google.'
            );
        }
        const refreshToken = await this.descifrar(cuenta.refreshTokenCifrado, { cuentaId });
        if (!refreshToken) {
            throw new ErrorAgendamiento('TOKEN_INVALIDO', 'No se pudo abrir el token de Google.');
        }
        const { clientId, clientSecret, tokenUri } = this.estado.oauth || {};
        if (!clientId || !tokenUri) {
            throw new ErrorAgendamiento(
                'CREDENCIALES_NO_CONFIGURADAS',
                'Las credenciales de Google no están configuradas.'
            );
        }
        const respuesta = await this.fetchGoogle(tokenUri, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken,
                grant_type: 'refresh_token'
            }),
            signal
        });
        const datos = await leerRespuestaJson(respuesta, 'TOKEN_REFRESH');
        if (!datos.access_token) {
            throw new ErrorAgendamiento('TOKEN_REFRESH', 'Google no devolvió acceso a Contactos.');
        }
        this.tokensAcceso.set(cuentaId, {
            token: datos.access_token,
            venceEn: Date.now() + Math.max(30, Number(datos.expires_in) || 3600) * 1000
        });
        return datos.access_token;
    }

    async solicitudGoogle(url, token, opciones = {}) {
        let respuesta;
        try {
            respuesta = await this.fetchGoogle(url, {
                ...opciones,
                headers: {
                    Accept: 'application/json',
                    ...(opciones.body ? { 'Content-Type': 'application/json' } : {}),
                    ...(opciones.headers || {}),
                    Authorization: `Bearer ${token}`
                }
            });
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            if (error instanceof ErrorAgendamiento) {
                if (
                    ['GOOGLE_TIMEOUT', 'GOOGLE_RED'].includes(error.codigo)
                    && ['POST', 'PATCH'].includes(String(opciones.method || '').toUpperCase())
                ) {
                    error.resultadoIncierto = true;
                }
                throw error;
            }
            throw new ErrorAgendamiento(
                'GOOGLE_RED',
                'No se pudo comunicar con Google Contacts.',
                error
            );
        }
        return leerRespuestaJson(respuesta, 'GOOGLE_PEOPLE');
    }

    async listarConexionesGoogle(token, signal) {
        const conexiones = [];
        let pageToken = '';
        do {
            const url = new URL(`${GOOGLE_PEOPLE_BASE}/people/me/connections`);
            url.searchParams.set('personFields', 'names,phoneNumbers,clientData,metadata');
            url.searchParams.set('pageSize', '1000');
            url.searchParams.append('sources', 'READ_SOURCE_TYPE_CONTACT');
            if (pageToken) url.searchParams.set('pageToken', pageToken);
            const pagina = await this.solicitudGoogle(url.toString(), token, { signal });
            conexiones.push(...(Array.isArray(pagina.connections) ? pagina.connections : []));
            pageToken = textoSeguro(pagina.nextPageToken, 500);
        } while (pageToken);
        return conexiones;
    }

    async crearContactoGoogle(token, telefono, nombre, lineaId, usuario, signal) {
        const control = this.sincronizacion;
        if (control) control.enMutacion = true;
        try {
            return await this.solicitudGoogle(`${GOOGLE_PEOPLE_BASE}/people:createContact`, token, {
                method: 'POST',
                body: JSON.stringify({
                    names: [{ unstructuredName: nombre }],
                    phoneNumbers: [{ value: telefono }],
                    clientData: crearMarcasAutostatues(lineaId, usuario)
                }),
                signal
            });
        } finally {
            if (this.sincronizacion === control) control.enMutacion = false;
        }
    }

    async actualizarContactoGoogle(token, persona, nombre, clientData, signal) {
        const recurso = textoSeguro(persona?.resourceName, 300);
        if (!/^people\/[A-Za-z0-9._-]+$/u.test(recurso)) {
            throw new ErrorAgendamiento(
                'CONTACTO_INVALIDO',
                'Google devolvió un contacto sin identificador válido.'
            );
        }
        const fuenteContacto = obtenerFuenteContacto(persona);
        if (!fuenteContacto) {
            throw new ErrorAgendamiento(
                'METADATA_CONTACTO_AUSENTE',
                'El contacto no incluye la versión editable exigida por Google.'
            );
        }
        const url = new URL(`${GOOGLE_PEOPLE_BASE}/${recurso}:updateContact`);
        const campos = ['names'];
        if (clientData) campos.push('clientData');
        url.searchParams.set('updatePersonFields', campos.join(','));
        url.searchParams.set('personFields', 'names,phoneNumbers,clientData,metadata');
        const cuerpo = {
            resourceName: recurso,
            metadata: { sources: [fuenteContacto] },
            names: [{ unstructuredName: nombre }]
        };
        if (clientData) cuerpo.clientData = clientData;
        const control = this.sincronizacion;
        if (control) control.enMutacion = true;
        try {
            return await this.solicitudGoogle(url.toString(), token, {
                method: 'PATCH',
                body: JSON.stringify(cuerpo),
                signal
            });
        } finally {
            if (this.sincronizacion === control) control.enMutacion = false;
        }
    }

    emitirProgreso(control, parcial = {}) {
        Object.assign(control.progreso, parcial);
        const copia = clonarSeguro(control.progreso);
        this.ultimoProgreso = copia;
        this.emit('progreso', copia);
        return copia;
    }

    estaOcupado() {
        return Boolean(this.sincronizacion || this.reservaSincronizacion);
    }

    obtenerProcesoActivo() {
        const proceso = this.sincronizacion || this.reservaSincronizacion;
        return proceso?.progreso ? clonarSeguro(proceso.progreso) : null;
    }

    detenerSincronizacion() {
        if (this.sincronizacion) {
            this.sincronizacion.cancelado = true;
            if (!this.sincronizacion.enMutacion) {
                this.sincronizacion.controlador.abort();
            }
            this.emitirProgreso(this.sincronizacion, { estado: 'cancelando' });
            return true;
        }
        if (this.reservaSincronizacion) {
            this.reservaSincronizacion.cancelado = true;
            this.emitirProgreso(this.reservaSincronizacion, { estado: 'cancelada' });
            return true;
        }
        return false;
    }

    async iniciarSincronizacion(lineaEntrada, cuentaIdEntrada) {
        if (this.sincronizacion || this.reservaSincronizacion) {
            throw new ErrorAgendamiento(
                'SINCRONIZACION_ACTIVA',
                'Ya hay un agendamiento en curso.'
            );
        }
        const lineaIdReserva = textoSeguro(
            lineaEntrada && typeof lineaEntrada === 'object'
                ? (lineaEntrada.id || lineaEntrada.nombre)
                : lineaEntrada,
            180
        ) || null;
        const reserva = {
            cancelado: false,
            progreso: {
                estado: 'preparando',
                lineaId: lineaIdReserva,
                cuentaId: cuentaIdEntrada || null,
                total: 0,
                procesados: 0
            }
        };
        this.reservaSincronizacion = reserva;
        let info;
        let linea;
        let cuentaId;
        let candidatos;
        let control;
        try {
            if (!this.fetch) {
                throw new ErrorAgendamiento(
                    'FETCH_NO_DISPONIBLE',
                    'No hay un cliente HTTP disponible.'
                );
            }
            info = await this.resolverLinea(lineaEntrada);
            reserva.progreso.lineaId = info.id;
            if (reserva.cancelado) {
                this.reservaSincronizacion = null;
                return clonarSeguro(reserva.progreso);
            }
            linea = this.asegurarLinea(info);
            if (!linea.prefijo) {
                throw new ErrorAgendamiento(
                    'LINEA_SIN_NUMERO',
                    'El nombre de la línea debe contener un número para formar L(numero).'
                );
            }
            cuentaId = cuentaIdEntrada || this.estado.asociaciones[info.id];
            reserva.progreso.cuentaId = cuentaId || null;
            if (!this.estado.cuentas.some(cuenta => cuenta.id === cuentaId)) {
                throw new ErrorAgendamiento(
                    'CUENTA_NO_ASOCIADA',
                    'Seleccioná una cuenta de Google para esta línea.'
                );
            }

            candidatos = Object.values(linea.candidatos || {})
                .filter(item => (
                    item
                    && item.telefono
                    && normalizarUsuario(item.usuario)
                    && !candidatoEstaSincronizado(item, cuentaId)
                ))
                .sort((a, b) => a.telefono.localeCompare(b.telefono));
            control = {
                cancelado: false,
                enMutacion: false,
                controlador: new AbortController(),
                progreso: {
                    estado: 'preparando',
                    lineaId: info.id,
                    cuentaId,
                    total: candidatos.length,
                    procesados: 0,
                    creados: 0,
                    actualizados: 0,
                    sinCambios: 0,
                    pendientes: 0,
                    revision: 0,
                    errores: 0,
                    actual: null
                }
            };
            this.sincronizacion = control;
            this.reservaSincronizacion = null;
        } catch (error) {
            if (this.reservaSincronizacion === reserva) this.reservaSincronizacion = null;
            if (reserva.cancelado) return clonarSeguro(reserva.progreso);
            throw error;
        }
        try {
            this.emitirProgreso(control);
            const token = await this.obtenerTokenAcceso(cuentaId, control.controlador.signal);
            if (control.cancelado) throw new DOMException('Cancelado', 'AbortError');
            const conexiones = await this.listarConexionesGoogle(
                token,
                control.controlador.signal
            );
            const indice = indexarConexiones(conexiones, this.codigoPais);
            const telefonosPorRecurso = new Map();
            for (const candidato of Object.values(linea.candidatos || {})) {
                const personas = indice.get(candidato.telefono) || [];
                if (personas.length !== 1) continue;
                const recurso = textoSeguro(personas[0]?.resourceName, 300);
                if (!recurso) continue;
                if (!telefonosPorRecurso.has(recurso)) {
                    telefonosPorRecurso.set(recurso, new Set());
                }
                telefonosPorRecurso.get(recurso).add(candidato.telefono);
            }
            const recursosCompartidos = new Set(
                [...telefonosPorRecurso.entries()]
                    .filter(([, telefonos]) => telefonos.size > 1)
                    .map(([recurso]) => recurso)
            );
            this.emitirProgreso(control, { estado: 'procesando' });

            for (const candidato of candidatos) {
                if (control.cancelado) break;
                this.emitirProgreso(control, { actual: candidato.telefono });
                let resultado;
                try {
                    resultado = await this.procesarCandidato(
                        token,
                        linea,
                        candidato,
                        indice,
                        recursosCompartidos,
                        control.controlador.signal
                    );
                } catch (error) {
                    if (error?.name === 'AbortError') break;
                    if (error?.resultadoIncierto) {
                        candidato.ultimoResultado = {
                            tipo: 'revision',
                            codigo: 'RESULTADO_INCIERTO',
                            detalle:
                                'Google pudo aplicar esta escritura, pero no confirmó la respuesta. Se reconciliará antes de reintentar.',
                            cuentaId,
                            fecha: fechaIso(this.ahora)
                        };
                        candidato.actualizadoEn = fechaIso(this.ahora);
                        control.progreso.procesados += 1;
                        control.progreso.revision += 1;
                        this.guardar();
                        this.emitirProgreso(control);
                    }
                    if (esErrorGoogleDeCorte(error)) throw error;
                    if (control.cancelado) break;
                    resultado = {
                        tipo: 'error',
                        codigo: error?.codigo || 'ERROR_CONTACTO',
                        detalle: textoSeguro(error?.message || 'No se pudo procesar.', 220)
                    };
                }
                const esExito = ['creado', 'actualizado', 'sin_cambios'].includes(
                    resultado.tipo
                );
                const huellaOperacion = resultado.huellaOperacion;
                const resultadoPersistible = { ...resultado };
                delete resultadoPersistible.huellaOperacion;
                candidato.ultimoResultado = esExito
                    && (
                        huellaOperacion !== crearHuellaCandidato(linea, candidato)
                        || this.estado.asociaciones[linea.id] !== cuentaId
                    )
                    ? null
                    : {
                        ...resultadoPersistible,
                        cuentaId,
                        fecha: fechaIso(this.ahora)
                    };
                candidato.actualizadoEn = fechaIso(this.ahora);
                control.progreso.procesados += 1;
                if (resultado.tipo === 'creado') control.progreso.creados += 1;
                else if (resultado.tipo === 'actualizado') control.progreso.actualizados += 1;
                else if (resultado.tipo === 'sin_cambios') control.progreso.sinCambios += 1;
                else if (resultado.tipo === 'pendiente') control.progreso.pendientes += 1;
                else if (resultado.tipo === 'revision') control.progreso.revision += 1;
                else control.progreso.errores += 1;
                this.guardar();
                this.emitirProgreso(control);
            }

            const estado = control.cancelado ? 'cancelada' : 'completada';
            return this.emitirProgreso(control, { estado, actual: null });
        } catch (error) {
            if (
                error?.name === 'AbortError'
                || (control.cancelado && !esErrorGoogleDeCorte(error))
            ) {
                return this.emitirProgreso(control, { estado: 'cancelada', actual: null });
            }
            this.emitirProgreso(control, {
                estado: 'fallida',
                actual: null,
                error: textoSeguro(error?.message || 'No se pudo sincronizar.', 240),
                codigo: textoSeguro(error?.codigo, 80) || undefined,
                httpStatus: Number(error?.httpStatus) || undefined,
                resultadoIncierto: Boolean(error?.resultadoIncierto) || undefined
            });
            throw error;
        } finally {
            this.guardar();
            this.sincronizacion = null;
        }
    }

    async procesarCandidato(
        token,
        linea,
        candidato,
        indice,
        recursosCompartidos,
        signal
    ) {
        if (!candidato.usuario) {
            return { tipo: 'pendiente', codigo: 'SIN_USUARIO' };
        }
        const existentes = indice.get(candidato.telefono) || [];
        if (existentes.length > 1) {
            return { tipo: 'revision', codigo: 'TELEFONO_DUPLICADO' };
        }
        if (
            existentes.length === 1
            && recursosCompartidos.has(textoSeguro(existentes[0]?.resourceName, 300))
        ) {
            return { tipo: 'revision', codigo: 'CONTACTO_MULTITELEFONO' };
        }

        if (!existentes.length) {
            const fechaResultadoIncierto = Date.parse(
                candidato.ultimoResultado?.fecha || ''
            );
            const ahoraResultadoIncierto = Date.parse(fechaIso(this.ahora));
            const resultadoInciertoVigente =
                candidato.ultimoResultado?.codigo === 'RESULTADO_INCIERTO' &&
                (
                    !Number.isFinite(fechaResultadoIncierto) ||
                    ahoraResultadoIncierto - fechaResultadoIncierto <
                        ESPERA_RESULTADO_INCIERTO_MS
                );
            if (resultadoInciertoVigente) {
                return {
                    tipo: 'revision',
                    codigo: 'RESULTADO_INCIERTO',
                    detalle:
                        'La escritura anterior sigue sin aparecer en Google. Esperá 10 minutos antes de reintentar para evitar un duplicado.'
                };
            }
            const usuarioSolicitud = candidato.usuario;
            const huellaOperacion = crearHuellaCandidato(linea, candidato);
            const nombre = crearNombreGestionado(
                linea.nombre,
                usuarioSolicitud,
                Boolean(candidato.mutuo)
            );
            const creada = await this.crearContactoGoogle(
                token,
                candidato.telefono,
                nombre,
                linea.prefijo,
                usuarioSolicitud,
                signal
            );
            const marcas = crearMarcasAutostatues(linea.prefijo, usuarioSolicitud);
            const persona = {
                ...creada,
                names: creada.names?.length ? creada.names : [{ unstructuredName: nombre }],
                phoneNumbers: creada.phoneNumbers?.length
                    ? creada.phoneNumbers
                    : [{ value: candidato.telefono }],
                clientData: creada.clientData?.length ? creada.clientData : marcas
            };
            indice.set(candidato.telefono, [persona]);
            return { tipo: 'creado', nombre, huellaOperacion };
        }

        const persona = existentes[0];
        const nombreActual = obtenerNombrePersona(persona);
        const yaTienePunto = tieneMarcadorMutuo(nombreActual);
        const marcasActuales = obtenerMarcasAutostatues(persona);
        const prefijoLegacy = obtenerPrefijoNombreGestionado(nombreActual);
        const marcaEstable = /^L\d+$/u.test(marcasActuales.lineaId || '');
        const marcaAnteriorAdoptable = Boolean(
            marcasActuales.lineaId
            && !marcaEstable
            && prefijoLegacy === linea.prefijo
        );
        const perteneceAOtraLinea = marcasActuales.lineaId
            ? marcasActuales.lineaId !== linea.prefijo && !marcaAnteriorAdoptable
            : Boolean(prefijoLegacy && prefijoLegacy !== linea.prefijo);
        if (perteneceAOtraLinea) {
            return {
                tipo: 'revision',
                codigo: 'CONTACTO_OTRA_LINEA',
                nombreActual
            };
        }
        if (yaTienePunto && !candidato.mutuo) {
            candidato.mutuo = true;
            candidato.ultimoResultado = null;
        }
        let nombreNuevo;
        let clientDataNuevo = null;

        nombreNuevo = crearNombreGestionado(
            linea.nombre,
            candidato.usuario,
            Boolean(candidato.mutuo),
            yaTienePunto
        );
        clientDataNuevo = fusionarMarcasAutostatues(
            persona,
            linea.prefijo,
            candidato.usuario
        );
        const huellaOperacion = crearHuellaCandidato(linea, candidato);

        const marcasYaActualizadas = clientDataNuevo
            ? marcasAutostatuesCoinciden(persona, linea.prefijo, candidato.usuario)
            : true;
        if (!nombreNuevo || (nombreNuevo === nombreActual && marcasYaActualizadas)) {
            return { tipo: 'sin_cambios', nombre: nombreActual, huellaOperacion };
        }
        if (!obtenerFuenteContacto(persona)) {
            return {
                tipo: 'revision',
                codigo: 'METADATA_CONTACTO_AUSENTE',
                nombreActual
            };
        }
        const actualizada = await this.actualizarContactoGoogle(
            token,
            persona,
            nombreNuevo,
            clientDataNuevo,
            signal
        );
        Object.assign(persona, actualizada, {
            names: actualizada.names?.length
                ? actualizada.names
                : [{ unstructuredName: nombreNuevo }],
            clientData: actualizada.clientData?.length
                ? actualizada.clientData
                : (clientDataNuevo || persona.clientData)
        });
        return { tipo: 'actualizado', nombre: nombreNuevo, huellaOperacion };
    }

    cerrar() {
        this.detenerSincronizacion();
        if (this.servidorOAuth) {
            this.servidorOAuth.close(() => {});
            this.servidorOAuth = null;
        }
        if (this.cargado) this.guardar();
    }
}

function crearServicioAgendamiento(opciones) {
    return new ServicioAgendamiento(opciones);
}

module.exports = {
    ErrorAgendamiento,
    GOOGLE_CONTACTS_SCOPE,
    MARCADOR_MUTUO,
    MAXIMO_PALABRAS_CLAVE_USUARIO,
    PALABRAS_CLAVE_USUARIO_PREDETERMINADAS,
    ServicioAgendamiento,
    agregarMarcadorMutuo,
    candidatoEstaSincronizado,
    crearMarcasAutostatues,
    crearNombreGestionado,
    crearServicioAgendamiento,
    esNombreGestionado,
    extraerTextoMensaje,
    fusionarMarcasAutostatues,
    indexarConexiones,
    leerJsonSeguro,
    normalizarTelefono,
    normalizarPalabrasClaveUsuario,
    normalizarTextoPlantilla,
    normalizarTimestampMensaje,
    obtenerFuenteContacto,
    obtenerMarcasAutostatues,
    obtenerNombrePersona,
    obtenerPrefijoLinea,
    parsearPlantillaGreenvip,
    parsearUsuarioPorPalabrasClave,
    quitarMarcadoresMutuos
};
