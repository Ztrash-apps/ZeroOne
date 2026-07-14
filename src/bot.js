const {
    default: makeWASocket,
    useMultiFileAuthState,
    Browsers,
    jidNormalizedUser,
    WAMessageStatus
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const QRCode = require('qrcode');
const crypto = require('crypto');
const schedule = require('node-schedule');

const app = express();
const RAIZ_PROYECTO = path.resolve(__dirname, '..');
const CARPETA_DATOS = path.resolve(
    process.env.AUTOSTATUES_DATA_DIR || RAIZ_PROYECTO
);
const CARPETA_PUBLIC = path.join(RAIZ_PROYECTO, 'public');
const CARPETA_UPLOADS = path.join(CARPETA_DATOS, 'uploads');
const CARPETA_SESIONES = path.join(CARPETA_DATOS, 'sesiones');
const CARPETA_PROGRAMADOS = path.join(CARPETA_DATOS, 'programados');
const CARPETA_IMAGENES_PROGRAMADAS = path.join(CARPETA_PROGRAMADOS, 'imagenes');
const CARPETA_HISTORIAL = path.join(CARPETA_DATOS, 'historial');
const CARPETA_IMAGENES_HISTORIAL = path.join(CARPETA_HISTORIAL, 'imagenes');
const ARCHIVO_CONFIGURACION = path.join(CARPETA_DATOS, 'configuracion.json');

function carpetaTieneContenido(ruta) {
    try {
        return fs.existsSync(ruta) && fs.readdirSync(ruta).length > 0;
    } catch {
        return false;
    }
}

function migrarCarpetaAnterior(nombreCarpeta) {
    if (CARPETA_DATOS === RAIZ_PROYECTO) return;

    const origen = path.join(RAIZ_PROYECTO, nombreCarpeta);
    const destino = path.join(CARPETA_DATOS, nombreCarpeta);

    if (!fs.existsSync(origen) || carpetaTieneContenido(destino)) return;

    try {
        fs.cpSync(origen, destino, {
            recursive: true,
            force: false,
            errorOnExist: false
        });

        console.log(`Datos anteriores copiados a la carpeta permanente: ${nombreCarpeta}`);
    } catch (error) {
        console.error(
            `No se pudo migrar la carpeta ${nombreCarpeta}:`,
            error.message
        );
    }
}

fs.mkdirSync(CARPETA_DATOS, { recursive: true });

migrarCarpetaAnterior('sesiones');
migrarCarpetaAnterior('programados');
migrarCarpetaAnterior('uploads');
migrarCarpetaAnterior('historial');

app.use(express.json());
app.use(express.static(CARPETA_PUBLIC));

fs.mkdirSync(CARPETA_UPLOADS, { recursive: true });
fs.mkdirSync(CARPETA_SESIONES, { recursive: true });
fs.mkdirSync(CARPETA_PROGRAMADOS, { recursive: true });
fs.mkdirSync(CARPETA_IMAGENES_PROGRAMADAS, { recursive: true });
fs.mkdirSync(CARPETA_HISTORIAL, { recursive: true });
fs.mkdirSync(CARPETA_IMAGENES_HISTORIAL, { recursive: true });

// No se establece un límite de peso para las imágenes.
const upload = multer({ dest: CARPETA_UPLOADS });

const lineas = new Map();
const programaciones = new Map();
const trabajosProgramados = new Map();
const historialPublicaciones = [];

const archivoLineas = path.join(CARPETA_SESIONES, 'lineas.json');
const archivoProgramaciones = path.join(CARPETA_PROGRAMADOS, 'programaciones.json');
const archivoHistorial = path.join(CARPETA_HISTORIAL, 'publicaciones.json');
const archivoEstadosActivos = path.join(CARPETA_HISTORIAL, 'estados-activos.json');
const NOMBRE_ARCHIVO_AUDIENCIA_ESTADOS = 'audiencia-estados.json';

let colaPublicaciones = Promise.resolve();
let publicacionesPendientes = 0;
let progresoPublicacion = crearProgresoVacio();
const estadosActivos = new Map();
let progresoEliminacionEstados = crearProgresoEliminacionEstadosVacio();

const ETIQUETAS_LINEA = new Set(['activa', 'indefinida', 'caida', 'reposo']);
const DIAS_SEMANA_VALIDOS = new Set([0, 1, 2, 3, 4, 5, 6]);
const MAXIMO_HISTORIAL = 500;
const DURACION_ESTADO_MS = 24 * 60 * 60 * 1000;
const LINEAS_POR_LOTE_ELIMINACION = 3;
const MAXIMOS_INTENTOS_AUDIENCIA = 3;
const EXPRESION_ID_LINEA = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODOS_PRIVACIDAD_ESTADOS = Object.freeze({
    SOLO_COMPARTIR_CON: 0,
    EXCLUIR_CONTACTOS: 1,
    TODOS_LOS_CONTACTOS: 2,
    AMIGOS_CERCANOS: 3
});

let configuracion = {
    umbralFallosSeguridad: 0.8,
    notificaciones: true,
    lineasPorGrupoPredeterminado: 10,
    intervaloMinutosPredeterminado: 5
};

let controlSeguridadPublicacion = {
    pausada: false,
    resolver: null
};

function crearProgresoVacio() {
    return {
        activo: false,
        estado: 'inactivo',
        origen: null,
        total: 0,
        procesadas: 0,
        correctas: 0,
        fallidas: 0,
        grupoActual: 0,
        totalGrupos: 0,
        proximoGrupoSegundos: 0,
        lineasCorrectas: [],
        lineasFallidas: [],
        seguridadActiva: false,
        fallosGrupoActual: 0,
        totalGrupoActual: 0,
        porcentajeFallosGrupo: 0,
        mensajeSeguridad: '',
        mensaje: ''
    };
}

function crearProgresoEliminacionEstadosVacio() {
    return {
        activo: false,
        estado: 'inactivo',
        publicacionId: null,
        total: 0,
        procesadas: 0,
        correctas: 0,
        eliminadas: 0,
        fallidas: 0,
        grupoActual: 0,
        totalGrupos: 0,
        mensaje: 'No hay una eliminación activa.'
    };
}

function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function guardarJSONAtomico(ruta, datos) {
    const temporal = `${ruta}.tmp`;
    fs.writeFileSync(temporal, JSON.stringify(datos, null, 2), 'utf8');

    try {
        fs.renameSync(temporal, ruta);
    } catch {
        fs.copyFileSync(temporal, ruta);
        eliminarArchivoSeguro(temporal);
    }
}

function notificarEscritorio(titulo, cuerpo) {
    if (!configuracion.notificaciones) return;

    try {
        const escritorio = global.autostatuesDesktop;
        if (escritorio && typeof escritorio.notificar === 'function') {
            escritorio.notificar(titulo, cuerpo);
        }
    } catch (error) {
        console.error('No se pudo mostrar la notificación:', error.message);
    }
}

function normalizarDiasSemana(valor) {
    const dias = Array.isArray(valor) ? valor : [];
    const normalizados = [...new Set(
        dias.map(Number).filter(dia => DIAS_SEMANA_VALIDOS.has(dia))
    )].sort((a, b) => a - b);

    return normalizados.length ? normalizados : [0, 1, 2, 3, 4, 5, 6];
}

function cargarConfiguracion() {
    if (!fs.existsSync(ARCHIVO_CONFIGURACION)) return;

    try {
        const datos = JSON.parse(fs.readFileSync(ARCHIVO_CONFIGURACION, 'utf8'));
        configuracion = {
            ...configuracion,
            ...datos,
            umbralFallosSeguridad: Math.min(
                1,
                Math.max(0.1, Number(datos.umbralFallosSeguridad) || 0.8)
            ),
            notificaciones: datos.notificaciones !== false,
            lineasPorGrupoPredeterminado: Math.min(
                50,
                Math.max(1, Number(datos.lineasPorGrupoPredeterminado) || 10)
            ),
            intervaloMinutosPredeterminado: Math.min(
                1440,
                Math.max(0, Number(datos.intervaloMinutosPredeterminado) || 5)
            )
        };
    } catch (error) {
        console.error('No se pudo cargar la configuración:', error.message);
    }
}

function guardarConfiguracion() {
    guardarJSONAtomico(ARCHIVO_CONFIGURACION, configuracion);
}

function detectarTipoImagen(ruta) {
    const descriptor = fs.openSync(ruta, 'r');
    const cabecera = Buffer.alloc(12);

    try {
        fs.readSync(descriptor, cabecera, 0, cabecera.length, 0);
    } finally {
        fs.closeSync(descriptor);
    }

    if (cabecera[0] === 0xff && cabecera[1] === 0xd8 && cabecera[2] === 0xff) {
        return { extension: '.jpg', mime: 'image/jpeg' };
    }

    if (
        cabecera[0] === 0x89 && cabecera[1] === 0x50 &&
        cabecera[2] === 0x4e && cabecera[3] === 0x47
    ) {
        return { extension: '.png', mime: 'image/png' };
    }

    return null;
}

function validarImagenSubida(archivo) {
    if (!archivo?.path || !fs.existsSync(archivo.path)) {
        return { error: 'No se recibió una imagen válida.' };
    }

    try {
        const tipo = detectarTipoImagen(archivo.path);
        if (!tipo) {
            return { error: 'El archivo debe ser una imagen JPG o PNG real.' };
        }
        return { tipo };
    } catch {
        return { error: 'No se pudo verificar la imagen seleccionada.' };
    }
}

function normalizarEtiqueta(valor) {
    const etiqueta = String(valor || '').trim().toLowerCase();
    return ETIQUETAS_LINEA.has(etiqueta) ? etiqueta : 'activa';
}

function esIdLineaValido(valor) {
    return EXPRESION_ID_LINEA.test(String(valor || '').trim());
}

function normalizarIdsLineas(valores) {
    if (!Array.isArray(valores)) return [];

    return [...new Set(
        valores
            .filter(valor => typeof valor === 'string')
            .map(valor => valor.trim())
            .filter(esIdLineaValido)
    )];
}

function resolverCarpetaSesionSegura(lineaId) {
    if (!esIdLineaValido(lineaId)) return null;

    const raizSesiones = path.resolve(CARPETA_SESIONES);
    const carpetaSesion = path.resolve(raizSesiones, lineaId);
    const relativa = path.relative(raizSesiones, carpetaSesion);

    if (!relativa || relativa.startsWith('..') || path.isAbsolute(relativa)) {
        return null;
    }

    return carpetaSesion;
}

function esperarDecisionSeguridad() {
    return new Promise(resolve => {
        controlSeguridadPublicacion.pausada = true;
        controlSeguridadPublicacion.resolver = resolve;
    });
}

function resolverDecisionSeguridad(decision) {
    if (!controlSeguridadPublicacion.pausada || !controlSeguridadPublicacion.resolver) {
        return false;
    }

    const resolver = controlSeguridadPublicacion.resolver;
    controlSeguridadPublicacion.pausada = false;
    controlSeguridadPublicacion.resolver = null;
    resolver(decision);
    return true;
}

function eliminarArchivoSeguro(ruta) {
    try {
        if (ruta && fs.existsSync(ruta)) {
            fs.unlinkSync(ruta);
        }
    } catch (error) {
        console.error(`No se pudo eliminar el archivo ${ruta}:`, error.message);
    }
}

function moverArchivo(origen, destino) {
    try {
        fs.renameSync(origen, destino);
    } catch (error) {
        fs.copyFileSync(origen, destino);
        eliminarArchivoSeguro(origen);
    }
}

function rutaAudienciaEstados(lineaId) {
    const carpetaSesion = resolverCarpetaSesionSegura(lineaId);
    if (!carpetaSesion) {
        throw new Error('El identificador de la línea no es válido.');
    }

    return path.join(
        carpetaSesion,
        NOMBRE_ARCHIVO_AUDIENCIA_ESTADOS
    );
}

function normalizarJidDestinatario(valor) {
    let jid = String(valor || '').trim();

    if (/^\+?\d+$/.test(jid)) {
        jid = `${jid.replace(/\D/g, '')}@s.whatsapp.net`;
    }

    try {
        jid = jidNormalizedUser(jid);
    } catch {
        return null;
    }

    if (
        /^\d+@s\.whatsapp\.net$/.test(jid) ||
        /^\d+@lid$/.test(jid) ||
        /^\d+@hosted$/.test(jid) ||
        /^\d+@hosted\.lid$/.test(jid)
    ) {
        return jid;
    }

    return null;
}

function esJidLid(jid) {
    return Boolean(
        jid?.endsWith('@lid') || jid?.endsWith('@hosted.lid')
    );
}

function esJidNumero(jid) {
    return Boolean(
        jid?.endsWith('@s.whatsapp.net') || jid?.endsWith('@hosted')
    );
}

function normalizarPrivacidadEstados(datos) {
    if (!datos || typeof datos !== 'object') return null;

    const modoOriginal = datos.modo ?? datos.mode;
    if (modoOriginal === null || typeof modoOriginal === 'undefined') {
        return null;
    }

    const modo = Number(modoOriginal);

    if (!Object.values(MODOS_PRIVACIDAD_ESTADOS).includes(modo)) {
        return null;
    }

    const tieneUsuarios = Object.prototype.hasOwnProperty.call(datos, 'usuarios');
    const tieneUserJid = Object.prototype.hasOwnProperty.call(datos, 'userJid');
    const usuariosOriginales = [];
    const usuarios = [];
    let usuariosInvalidos = 0;

    if (tieneUsuarios) {
        if (Array.isArray(datos.usuarios)) {
            usuariosOriginales.push(...datos.usuarios);
        } else {
            usuariosInvalidos += 1;
        }
    }

    if (tieneUserJid) {
        if (Array.isArray(datos.userJid)) {
            usuariosOriginales.push(...datos.userJid);
        } else {
            usuariosInvalidos += 1;
        }
    }

    if (Object.prototype.hasOwnProperty.call(datos, 'usuariosInvalidos')) {
        if (
            typeof datos.usuariosInvalidos === 'number' &&
            Number.isInteger(datos.usuariosInvalidos) &&
            datos.usuariosInvalidos >= 0
        ) {
            usuariosInvalidos += datos.usuariosInvalidos;
        } else {
            usuariosInvalidos += 1;
        }
    }

    for (const usuarioOriginal of usuariosOriginales) {
        const usuario = normalizarJidDestinatario(usuarioOriginal);

        if (usuario) {
            usuarios.push(usuario);
        } else {
            usuariosInvalidos += 1;
        }
    }

    return {
        modo,
        usuarios: [...new Set(usuarios)],
        usuariosInvalidos
    };
}

function privacidadEstadosEsSegura(privacidad) {
    if (!privacidad) return false;

    return !(
        privacidad.modo === MODOS_PRIVACIDAD_ESTADOS.EXCLUIR_CONTACTOS &&
        Number(privacidad.usuariosInvalidos) > 0
    );
}

function audienciaEstadosLista(linea) {
    asegurarAudienciaEstados(linea);

    return (
        linea.audienciaResincronizada === true &&
        privacidadEstadosEsSegura(linea.privacidadEstados)
    );
}

function cargarAudienciaEstados(linea) {
    linea.contactosEstado = new Set();
    linea.privacidadEstados = null;
    linea.audienciaResincronizada = false;
    linea.promesaContactosEstado = Promise.resolve();
    linea.audienciaEstadosCargada = true;

    const ruta = rutaAudienciaEstados(linea.id);
    if (!fs.existsSync(ruta)) return;

    try {
        const datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
        const contactos = Array.isArray(datos.contactos) ? datos.contactos : [];

        linea.contactosEstado = new Set(
            contactos.map(normalizarJidDestinatario).filter(Boolean)
        );
        linea.privacidadEstados = normalizarPrivacidadEstados(datos.privacidad);

        // La instantánea guardada sirve como respaldo, pero no se considera
        // actual hasta que WhatsApp la valide otra vez en este proceso.
        linea.audienciaResincronizada = false;
    } catch (error) {
        console.error(
            `No se pudo cargar la audiencia de estados de ${linea.nombre}:`,
            error.message
        );
    }
}

function asegurarAudienciaEstados(linea) {
    if (!linea.audienciaEstadosCargada) {
        cargarAudienciaEstados(linea);
    }
}

function guardarAudienciaEstados(linea) {
    asegurarAudienciaEstados(linea);

    const ruta = rutaAudienciaEstados(linea.id);
    fs.mkdirSync(path.dirname(ruta), { recursive: true });

    guardarJSONAtomico(ruta, {
        contactos: [...linea.contactosEstado].sort(),
        privacidad: linea.privacidadEstados,
        audienciaResincronizada: linea.audienciaResincronizada === true
    });
}

async function resolverJidDestinatario(socket, valor) {
    const jid = normalizarJidDestinatario(valor);
    if (!jid || !esJidLid(jid)) return jid;

    try {
        const numero = await socket.signalRepository?.lidMapping?.getPNForLID(jid);
        const jidNumero = normalizarJidDestinatario(numero);

        if (esJidNumero(jidNumero)) {
            return jidNumero;
        }
    } catch {
        // Si todavía no existe el mapeo LID, Baileys puede usar el LID original.
    }

    return jid;
}

async function obtenerJidDeContacto(socket, contacto) {
    const candidatos = [
        contacto?.phoneNumber,
        contacto?.id,
        contacto?.lid
    ];
    let jidLid = null;

    for (const candidato of candidatos) {
        const jid = await resolverJidDestinatario(socket, candidato);
        if (!jid) continue;

        if (esJidNumero(jid)) {
            return jid;
        }

        jidLid = jidLid || jid;
    }

    return jidLid;
}

async function actualizarContactosEstado(
    linea,
    socket,
    contactos,
    permitirEliminarSinNombre = false
) {
    if (!Array.isArray(contactos) || contactos.length === 0) return;

    asegurarAudienciaEstados(linea);
    let huboCambios = false;

    for (const contacto of contactos) {
        if (!contacto || typeof contacto !== 'object') continue;

        const incluyeNombre = Object.prototype.hasOwnProperty.call(
            contacto,
            'name'
        );

        // Los eventos generados por mensajes solo traen "notify". No deben
        // convertir números no guardados en destinatarios de los estados.
        if (!incluyeNombre) continue;

        const estaGuardado = Boolean(String(contacto.name || '').trim());

        if (!estaGuardado && !permitirEliminarSinNombre) {
            continue;
        }

        const jid = await obtenerJidDeContacto(socket, contacto);

        if (linea.socket !== socket) return;

        const jidsRelacionados = new Set([
            jid,
            normalizarJidDestinatario(contacto.phoneNumber),
            normalizarJidDestinatario(contacto.id),
            normalizarJidDestinatario(contacto.lid)
        ].filter(Boolean));

        if (estaGuardado && jid) {
            if (!linea.contactosEstado.has(jid)) {
                linea.contactosEstado.add(jid);
                huboCambios = true;
            }

            // Conservamos una sola forma del mismo contacto cuando ya se pudo
            // convertir su identificador privado (LID) al número de WhatsApp.
            if (esJidNumero(jid)) {
                for (const relacionado of jidsRelacionados) {
                    if (
                        esJidLid(relacionado) &&
                        linea.contactosEstado.delete(relacionado)
                    ) {
                        huboCambios = true;
                    }
                }
            }
        } else {
            for (const relacionado of jidsRelacionados) {
                if (linea.contactosEstado.delete(relacionado)) {
                    huboCambios = true;
                }
            }
        }
    }

    if (huboCambios && linea.socket === socket) {
        guardarAudienciaEstados(linea);
    }
}

function actualizarPrivacidadEstados(linea, valor) {
    asegurarAudienciaEstados(linea);

    const privacidad = normalizarPrivacidadEstados(valor);
    if (!privacidad) {
        linea.privacidadEstados = null;
        linea.audienciaResincronizada = false;
        guardarAudienciaEstados(linea);
        return;
    }

    linea.privacidadEstados = privacidad;

    if (!privacidadEstadosEsSegura(privacidad)) {
        linea.audienciaResincronizada = false;
    }

    guardarAudienciaEstados(linea);
}

function cancelarReintentoAudiencia(linea) {
    if (!linea?.temporizadorAudiencia) return;

    clearTimeout(linea.temporizadorAudiencia);
    linea.temporizadorAudiencia = null;
}

function programarResincronizacionAudiencia(linea, socket, retrasoMs) {
    if (
        linea.eliminando ||
        audienciaEstadosLista(linea) ||
        linea.socket !== socket ||
        linea.temporizadorAudiencia ||
        (Number(linea.intentosResincronizacionAudiencia) || 0) >=
            MAXIMOS_INTENTOS_AUDIENCIA
    ) {
        return;
    }

    linea.temporizadorAudiencia = setTimeout(() => {
        linea.temporizadorAudiencia = null;

        resincronizarAudienciaEstados(linea, socket).catch(error => {
            console.error(
                `No se pudo ejecutar la resincronización de ${linea.nombre}:`,
                error.message
            );
        });
    }, Math.max(0, Number(retrasoMs) || 0));
}

async function resincronizarAudienciaEstados(linea, socket) {
    asegurarAudienciaEstados(linea);

    if (
        linea.eliminando ||
        !lineas.has(linea.id) ||
        linea.socket !== socket ||
        audienciaEstadosLista(linea) ||
        linea.resincronizandoAudiencia
    ) {
        return;
    }

    linea.resincronizandoAudiencia = true;
    linea.intentosResincronizacionAudiencia =
        (Number(linea.intentosResincronizacionAudiencia) || 0) + 1;

    try {
        // La instantánea que sigue es autoritativa. Vaciamos primero la
        // audiencia para no conservar contactos eliminados en una sesión
        // anterior ni usar una regla de privacidad desactualizada.
        linea.audienciaResincronizada = false;
        linea.contactosEstado = new Set();
        linea.privacidadEstados = null;

        // Las sesiones creadas con versiones anteriores no guardaban los
        // contactos ni la audiencia privada recibidos al vincularse. Pedimos
        // instantáneas nuevas de ambas colecciones de WhatsApp.
        await socket.authState.keys.transaction(
            async () => {
                await socket.authState.keys.set({
                    'app-state-sync-version': {
                        critical_unblock_low: null,
                        regular_high: null
                    }
                });

                if (linea.socket !== socket) return;

                await socket.resyncAppState(
                    ['critical_unblock_low', 'regular_high'],
                    true
                );
            },
            socket.authState.creds.me?.id || 'resync-app-state'
        );

        if (linea.socket !== socket) return;

        // resyncAppState libera sus eventos en un buffer unos milisegundos
        // después de resolver. Esperamos a que contacts.upsert se haya
        // procesado y persistido antes de marcar la migración como terminada.
        for (let intento = 0; intento < 30 && socket.ev.isBuffering(); intento += 1) {
            await esperar(100);
        }

        if (socket.ev.isBuffering()) {
            throw new Error(
                'La sincronización de WhatsApp sigue procesando la audiencia.'
            );
        }

        await esperar(50);
        await (linea.promesaContactosEstado || Promise.resolve());

        if (linea.socket !== socket) return;

        if (!linea.privacidadEstados) {
            throw new Error(
                'WhatsApp no entregó todavía la privacidad completa de los estados.'
            );
        }

        if (!privacidadEstadosEsSegura(linea.privacidadEstados)) {
            throw new Error(
                'WhatsApp entregó una lista de exclusiones incompleta. La audiencia seguirá bloqueada.'
            );
        }

        linea.audienciaResincronizada = true;
        linea.intentosResincronizacionAudiencia = 0;
        linea.ultimoError = null;
        guardarAudienciaEstados(linea);
        guardarLineas();

        console.log(
            `Audiencia resincronizada para ${linea.nombre}: ` +
            `${linea.contactosEstado.size} contacto(s).`
        );
    } catch (error) {
        linea.audienciaResincronizada = false;
        linea.ultimoError =
            `No se pudo sincronizar la audiencia de estados: ${error.message}`;

        try {
            guardarAudienciaEstados(linea);
            guardarLineas();
        } catch (errorGuardado) {
            console.error(
                `No se pudo guardar el fallo de audiencia de ${linea.nombre}:`,
                errorGuardado.message
            );
        }

        console.error(
            `No se pudo resincronizar la audiencia de ${linea.nombre}:`,
            error.message
        );

        const intento = Number(linea.intentosResincronizacionAudiencia) || 1;
        if (
            intento < MAXIMOS_INTENTOS_AUDIENCIA &&
            linea.socket === socket &&
            !linea.eliminando
        ) {
            programarResincronizacionAudiencia(
                linea,
                socket,
                3000 * (2 ** (intento - 1))
            );
        }
    } finally {
        linea.resincronizandoAudiencia = false;
    }
}

async function normalizarListaDestinatarios(socket, valores) {
    const resultado = new Set();

    for (const valor of valores || []) {
        const jid = await resolverJidDestinatario(socket, valor);
        if (jid) resultado.add(jid);
    }

    return resultado;
}

async function obtenerDestinatariosEstado(linea) {
    asegurarAudienciaEstados(linea);

    if (!audienciaEstadosLista(linea)) {
        const privacidadIncompleta =
            linea.privacidadEstados?.modo ===
                MODOS_PRIVACIDAD_ESTADOS.EXCLUIR_CONTACTOS &&
            Number(linea.privacidadEstados?.usuariosInvalidos) > 0;

        throw new Error(
            privacidadIncompleta
                ? `WhatsApp no pudo interpretar toda la lista de exclusiones de ${linea.nombre}. ` +
                    'La publicación se bloqueó para proteger esa privacidad.'
                : `La audiencia de estados de ${linea.nombre} todavía se está sincronizando. ` +
                    'Esperá unos segundos y volvé a intentar.'
        );
    }

    const socket = linea.socket;
    const contactos = await normalizarListaDestinatarios(
        socket,
        linea.contactosEstado
    );
    const privacidad = linea.privacidadEstados;
    let destinatarios;

    if (
        privacidad?.modo === MODOS_PRIVACIDAD_ESTADOS.SOLO_COMPARTIR_CON ||
        privacidad?.modo === MODOS_PRIVACIDAD_ESTADOS.AMIGOS_CERCANOS
    ) {
        destinatarios = await normalizarListaDestinatarios(
            socket,
            privacidad.usuarios
        );
    } else if (
        privacidad?.modo === MODOS_PRIVACIDAD_ESTADOS.EXCLUIR_CONTACTOS
    ) {
        const excluidos = await normalizarListaDestinatarios(
            socket,
            privacidad.usuarios
        );

        if (
            [...contactos].some(esJidLid) ||
            [...excluidos].some(esJidLid)
        ) {
            throw new Error(
                `WhatsApp no pudo resolver todos los identificadores de la ` +
                `privacidad de ${linea.nombre}. La publicación se bloqueó ` +
                'para no mostrar el estado a un contacto excluido.'
            );
        }

        destinatarios = new Set(
            [...contactos].filter(jid => !excluidos.has(jid))
        );
    } else if (
        privacidad?.modo === MODOS_PRIVACIDAD_ESTADOS.TODOS_LOS_CONTACTOS
    ) {
        destinatarios = contactos;
    } else {
        throw new Error(
            `La privacidad de estados de ${linea.nombre} todavía se está ` +
            'sincronizando. Esperá unos segundos y volvé a intentar.'
        );
    }

    const jidsPropios = await normalizarListaDestinatarios(socket, [
        linea.jid,
        socket.user?.id,
        socket.user?.lid,
        socket.user?.phoneNumber
    ]);

    for (const jidPropio of jidsPropios) {
        destinatarios.delete(jidPropio);
    }

    if (destinatarios.size === 0) {
        throw new Error(
            `La línea ${linea.nombre} todavía no sincronizó contactos ` +
            'para la audiencia de estados. Esperá unos segundos después de ' +
            'conectarla y volvé a intentar.'
        );
    }

    const jidPropio = await resolverJidDestinatario(
        socket,
        linea.jid || socket.user?.phoneNumber || socket.user?.id
    );

    if (jidPropio) {
        // El remitente también debe participar para que el estado se
        // sincronice con su teléfono y sus otros dispositivos vinculados.
        destinatarios.add(jidPropio);
    }

    return [...destinatarios];
}

function contarDestinatariosEstado(linea) {
    asegurarAudienciaEstados(linea);

    if (!audienciaEstadosLista(linea)) return 0;

    const privacidad = linea.privacidadEstados;

    if (
        privacidad.modo === MODOS_PRIVACIDAD_ESTADOS.SOLO_COMPARTIR_CON ||
        privacidad.modo === MODOS_PRIVACIDAD_ESTADOS.AMIGOS_CERCANOS
    ) {
        return new Set(privacidad.usuarios).size;
    }

    if (privacidad.modo === MODOS_PRIVACIDAD_ESTADOS.EXCLUIR_CONTACTOS) {
        const excluidos = new Set(privacidad.usuarios);
        return [...linea.contactosEstado]
            .filter(jid => !excluidos.has(jid))
            .length;
    }

    return linea.contactosEstado.size;
}

function obtenerSiguienteOrdenConexion() {
    const ordenMayor = Array.from(lineas.values()).reduce(
        (mayor, linea) => Math.max(mayor, Number(linea.ordenConexion) || 0),
        0
    );

    return ordenMayor + 1;
}

function guardarLineas() {
    const datos = Array.from(lineas.values()).map(linea => ({
        id: linea.id,
        nombre: linea.nombre,
        ordenConexion: Number(linea.ordenConexion) || 0,
        etiqueta: normalizarEtiqueta(linea.etiqueta),
        ultimaConexion: linea.ultimaConexion || null,
        ultimaPublicacion: linea.ultimaPublicacion || null,
        ultimoError: linea.ultimoError || null,
        fallosRecientes: Number(linea.fallosRecientes) || 0
    }));

    guardarJSONAtomico(archivoLineas, datos);
}

function cargarLineasGuardadas() {
    if (!fs.existsSync(archivoLineas)) {
        console.log('No existe lineas.json todavía.');
        return;
    }

    try {
        const datos = JSON.parse(fs.readFileSync(archivoLineas, 'utf8'));
        if (!Array.isArray(datos)) {
            throw new Error('El archivo no contiene una lista de líneas válida.');
        }

        const ordenesReservados = new Set(
            datos
                .map(item => Number(item?.ordenConexion))
                .filter(orden => Number.isInteger(orden) && orden > 0)
        );
        const ordenesAsignados = new Set();
        let ordenAlternativo = 1;

        for (const datosLinea of datos) {
            if (!datosLinea || typeof datosLinea !== 'object') continue;

            const id = String(datosLinea.id || '').trim();
            const nombre = String(datosLinea.nombre || '').trim();
            if (!esIdLineaValido(id) || !nombre || lineas.has(id)) {
                console.error('Se ignoró una línea guardada con datos inválidos.');
                continue;
            }

            let ordenConexion = Number(datosLinea.ordenConexion);
            if (
                !Number.isInteger(ordenConexion) ||
                ordenConexion < 1 ||
                ordenesAsignados.has(ordenConexion)
            ) {
                while (
                    ordenesReservados.has(ordenAlternativo) ||
                    ordenesAsignados.has(ordenAlternativo)
                ) {
                    ordenAlternativo += 1;
                }
                ordenConexion = ordenAlternativo;
                ordenAlternativo += 1;
            }

            ordenesAsignados.add(ordenConexion);

            lineas.set(id, {
                id,
                nombre,
                ordenConexion,
                etiqueta: normalizarEtiqueta(datosLinea.etiqueta),
                socket: null,
                jid: null,
                qr: null,
                estado: 'iniciando',
                iniciando: false,
                eliminando: false,
                temporizadorReconexion: null,
                temporizadorAudiencia: null,
                reconexionManualEnCurso: false,
                resincronizandoAudiencia: false,
                intentosResincronizacionAudiencia: 0,
                ultimaConexion: datosLinea.ultimaConexion || null,
                ultimaPublicacion: datosLinea.ultimaPublicacion || null,
                ultimoError: datosLinea.ultimoError || null,
                fallosRecientes: Number(datosLinea.fallosRecientes) || 0,
                contactosEstado: new Set(),
                privacidadEstados: null,
                audienciaResincronizada: false,
                promesaContactosEstado: Promise.resolve(),
                audienciaEstadosCargada: false
            });
        }

        try {
            // Persiste la migración de orden para instalaciones anteriores.
            guardarLineas();
        } catch (error) {
            console.error('No se pudo guardar el orden de las líneas:', error.message);
        }

        console.log(`${lineas.size} línea(s) cargada(s).`);
    } catch (error) {
        console.error('No se pudieron cargar las líneas:', error);
    }
}

function guardarProgramaciones() {
    guardarJSONAtomico(
        archivoProgramaciones,
        Array.from(programaciones.values())
    );
}

function obtenerMilisegundosFecha(valor, respaldo = NaN) {
    if (valor && typeof valor.toNumber === 'function') {
        valor = valor.toNumber();
    }

    if (typeof valor === 'string' && valor.trim() && !/^\d+$/.test(valor.trim())) {
        const fecha = new Date(valor).getTime();
        return Number.isFinite(fecha) ? fecha : respaldo;
    }

    const numero = Number(valor);
    if (!Number.isFinite(numero) || numero <= 0) return respaldo;

    const milisegundos = numero < 1e12 ? numero * 1000 : numero;
    return milisegundos <= 8.64e15 ? milisegundos : respaldo;
}

function copiarClaveMensajeEstado(clave) {
    if (!clave || typeof clave !== 'object') return null;

    try {
        const copia = JSON.parse(JSON.stringify(clave));

        if (
            copia.remoteJid !== 'status@broadcast' ||
            copia.fromMe !== true ||
            !String(copia.id || '').trim()
        ) {
            return null;
        }

        return copia;
    } catch {
        return null;
    }
}

function normalizarDestinatariosEstadoGuardados(valores) {
    const destinatarios = [];
    const vistos = new Set();

    for (const valor of Array.isArray(valores) ? valores.slice(0, 10000) : []) {
        const jid = normalizarJidDestinatario(valor);
        if (!jid || vistos.has(jid)) continue;

        vistos.add(jid);
        destinatarios.push(jid);
    }

    return destinatarios;
}

function normalizarMetaEstadoActivo(datos, clave, destinatariosRespaldo = []) {
    const meta = datos && typeof datos === 'object' ? datos : {};
    const statusJidList = Array.isArray(meta.statusJidList)
        ? meta.statusJidList
        : destinatariosRespaldo;

    return {
        // ID real asignado por WhatsApp a la publicación.
        id: clave.id,
        remoteJid: 'status@broadcast',
        statusJidList: normalizarDestinatariosEstadoGuardados(statusJidList)
    };
}

function obtenerClaveEstadoDesdeMeta(registroLinea) {
    const claveGuardada = copiarClaveMensajeEstado(registroLinea?.clave);
    if (!claveGuardada) return null;

    const idMeta = String(registroLinea?.meta?.id || '').trim();

    return copiarClaveMensajeEstado({
        ...claveGuardada,
        remoteJid: 'status@broadcast',
        fromMe: true,
        id: idMeta || claveGuardada.id
    });
}

function normalizarLineaEstadoActivo(datos, fechaInicioGrupo) {
    if (!datos || typeof datos !== 'object') return null;

    const lineaId = String(datos.lineaId || '').trim();
    const clave = copiarClaveMensajeEstado(datos.clave);
    if (!lineaId || !clave) return null;
    const meta = normalizarMetaEstadoActivo(
        datos.meta,
        clave,
        datos.statusJidList || datos.destinatarios
    );

    const fechaGrupoMs = obtenerMilisegundosFecha(fechaInicioGrupo, Date.now());
    const publicadoMs = obtenerMilisegundosFecha(datos.publicadoEn, fechaGrupoMs);
    let expiraMs = obtenerMilisegundosFecha(
        datos.expiraEn,
        publicadoMs + DURACION_ESTADO_MS
    );

    if (expiraMs <= publicadoMs) {
        expiraMs = publicadoMs + DURACION_ESTADO_MS;
    }

    const estadosValidos = new Set([
        'activo',
        'eliminando',
        'solicitud_enviada',
        'error'
    ]);
    let estado = estadosValidos.has(datos.estado) ? datos.estado : 'activo';
    let error = datos.error ? String(datos.error) : null;

    if (estado === 'eliminando') {
        estado = 'error';
        error = 'La eliminación anterior se interrumpió. Podés volver a intentarla.';
    }

    let claveRevocacion = copiarClaveMensajeEstado(datos.claveRevocacion);
    let revocacionConAudiencia = datos.revocacionConAudiencia === true;

    if (
        estado === 'solicitud_enviada' &&
        (!claveRevocacion || !revocacionConAudiencia)
    ) {
        estado = 'error';
        error = revocacionConAudiencia
            ? 'Falta la clave de la solicitud anterior. Podés volver a intentarla.'
            : 'La solicitud anterior no llegó a la audiencia del estado. Podés volver a intentarla.';
        claveRevocacion = null;
        revocacionConAudiencia = false;
    }

    if (estado !== 'solicitud_enviada') {
        claveRevocacion = null;
        revocacionConAudiencia = false;
    }

    return {
        lineaId,
        nombre: String(datos.nombre || 'Línea eliminada'),
        numero: datos.numero ? String(datos.numero) : null,
        clave,
        meta,
        publicadoEn: new Date(publicadoMs).toISOString(),
        expiraEn: new Date(expiraMs).toISOString(),
        estado,
        error,
        eliminadoEn: estado === 'solicitud_enviada' &&
            datos.eliminadoEn &&
            Number.isFinite(new Date(datos.eliminadoEn).getTime())
            ? new Date(datos.eliminadoEn).toISOString()
            : null,
        claveRevocacion,
        revocacionConAudiencia
    };
}

function normalizarGrupoEstadosActivos(datos) {
    if (!datos || typeof datos !== 'object') return null;

    const id = String(datos.id || '').trim();
    if (!id) return null;

    const fechaInicioMs = obtenerMilisegundosFecha(datos.fechaInicio, NaN);
    if (!Number.isFinite(fechaInicioMs)) return null;

    const lineasNormalizadas = [];
    const idsLineas = new Set();

    for (const datosLinea of Array.isArray(datos.lineas)
        ? datos.lineas.slice(0, 10000)
        : []) {
        const linea = normalizarLineaEstadoActivo(
            datosLinea,
            new Date(fechaInicioMs).toISOString()
        );

        if (!linea || idsLineas.has(linea.lineaId)) continue;
        idsLineas.add(linea.lineaId);
        lineasNormalizadas.push(linea);
    }

    if (!lineasNormalizadas.length) return null;

    const expiraEn = new Date(Math.max(
        ...lineasNormalizadas.map(linea => new Date(linea.expiraEn).getTime())
    )).toISOString();

    return {
        id,
        fechaInicio: new Date(fechaInicioMs).toISOString(),
        expiraEn,
        texto: String(datos.texto || ''),
        lineas: lineasNormalizadas
    };
}

function guardarEstadosActivos() {
    guardarJSONAtomico(
        archivoEstadosActivos,
        Array.from(estadosActivos.values())
    );
}

function podarEstadosActivos(guardar = true) {
    const ahora = Date.now();
    let huboCambios = false;

    for (const [id, grupo] of estadosActivos) {
        const vigentes = grupo.lineas.filter(linea =>
            obtenerMilisegundosFecha(linea.expiraEn, 0) > ahora
        );

        if (vigentes.length !== grupo.lineas.length) {
            grupo.lineas = vigentes;
            huboCambios = true;
        }

        if (!grupo.lineas.length) {
            estadosActivos.delete(id);
            huboCambios = true;
            continue;
        }

        const expiraEn = new Date(Math.max(
            ...grupo.lineas.map(linea => new Date(linea.expiraEn).getTime())
        )).toISOString();

        if (grupo.expiraEn !== expiraEn) {
            grupo.expiraEn = expiraEn;
            huboCambios = true;
        }
    }

    if (huboCambios && guardar) {
        guardarEstadosActivos();
    }

    return huboCambios;
}

function cargarEstadosActivos() {
    if (!fs.existsSync(archivoEstadosActivos)) return;

    try {
        const datos = JSON.parse(fs.readFileSync(archivoEstadosActivos, 'utf8'));
        if (!Array.isArray(datos)) {
            throw new Error('El archivo no contiene una lista válida.');
        }

        for (const candidato of datos.slice(0, 10000)) {
            let grupo;

            try {
                grupo = normalizarGrupoEstadosActivos(candidato);
            } catch {
                grupo = null;
            }

            if (!grupo || estadosActivos.has(grupo.id)) continue;
            estadosActivos.set(grupo.id, grupo);
        }
    } catch (error) {
        console.error('No se pudieron cargar los estados activos:', error.message);
        estadosActivos.clear();
        return;
    }

    podarEstadosActivos(false);

    try {
        // Reescribimos solamente los campos validados y completamos datos de
        // versiones anteriores sin dejar de usar la copia válida en memoria.
        guardarEstadosActivos();
    } catch (error) {
        console.error('No se pudo normalizar el archivo de estados activos:', error.message);
    }
}

function grupoProtegeImagenHistorial(id) {
    const grupo = estadosActivos.get(id);
    if (!grupo) return false;

    const ahora = Date.now();
    return grupo.lineas.some(linea =>
        obtenerMilisegundosFecha(linea.expiraEn, 0) > ahora
    );
}

function imagenUsadaPorHistorial(ruta, ignorarId) {
    if (!ruta) return false;

    return historialPublicaciones.some(registro =>
        registro?.id !== ignorarId && registro?.rutaImagen === ruta
    );
}

function registrarEstadoActivo(
    registroHistorial,
    linea,
    mensajeEstado,
    destinatariosEstado
) {
    const clave = copiarClaveMensajeEstado(mensajeEstado?.key);
    if (!clave) {
        throw new Error('WhatsApp no devolvió una clave válida para guardar el estado.');
    }

    const publicadoMs = obtenerMilisegundosFecha(
        mensajeEstado.messageTimestamp,
        Date.now()
    );
    const publicadoEn = new Date(publicadoMs).toISOString();
    const expiraEn = new Date(publicadoMs + DURACION_ESTADO_MS).toISOString();
    let grupo = estadosActivos.get(registroHistorial.id);

    if (!grupo) {
        grupo = {
            id: registroHistorial.id,
            fechaInicio: registroHistorial.fechaInicio,
            expiraEn,
            texto: String(registroHistorial.texto || ''),
            lineas: []
        };
        estadosActivos.set(grupo.id, grupo);
    }

    const registroLinea = {
        lineaId: linea.id,
        nombre: linea.nombre,
        numero: linea.jid ? linea.jid.split('@')[0] : null,
        clave,
        meta: normalizarMetaEstadoActivo(
            { statusJidList: destinatariosEstado },
            clave
        ),
        publicadoEn,
        expiraEn,
        estado: 'activo',
        error: null,
        eliminadoEn: null,
        claveRevocacion: null,
        revocacionConAudiencia: false
    };
    const indiceAnterior = grupo.lineas.findIndex(item => item.lineaId === linea.id);

    if (indiceAnterior >= 0) {
        grupo.lineas[indiceAnterior] = registroLinea;
    } else {
        grupo.lineas.push(registroLinea);
    }

    grupo.expiraEn = new Date(Math.max(
        ...grupo.lineas.map(item => new Date(item.expiraEn).getTime())
    )).toISOString();

    // Se persiste de inmediato: si el proceso se cierra después del envío,
    // conservamos la clave necesaria para solicitar la revocación.
    guardarEstadosActivos();
}

function guardarHistorial() {
    while (historialPublicaciones.length > MAXIMO_HISTORIAL) {
        let indiceEliminable = -1;

        for (let indice = historialPublicaciones.length - 1; indice >= 0; indice -= 1) {
            const candidato = historialPublicaciones[indice];
            if (
                candidato?.estado !== 'ejecutando' &&
                !grupoProtegeImagenHistorial(candidato?.id)
            ) {
                indiceEliminable = indice;
                break;
            }
        }

        // Si todos los registros adicionales siguen activos, es preferible
        // superar temporalmente el límite antes que perder su imagen o ID.
        if (indiceEliminable < 0) break;

        const [eliminado] = historialPublicaciones.splice(indiceEliminable, 1);
        if (!imagenUsadaPorHistorial(eliminado?.rutaImagen, eliminado?.id)) {
            eliminarArchivoSeguro(eliminado?.rutaImagen);
        }
    }

    guardarJSONAtomico(archivoHistorial, historialPublicaciones);
}

function cargarHistorial() {
    if (!fs.existsSync(archivoHistorial)) return;

    try {
        const datos = JSON.parse(fs.readFileSync(archivoHistorial, 'utf8'));
        if (Array.isArray(datos)) {
            historialPublicaciones.push(
                ...datos.filter(item => item && typeof item === 'object')
            );

            if (historialPublicaciones.length > MAXIMO_HISTORIAL) {
                guardarHistorial();
            }
        }
    } catch (error) {
        console.error('No se pudo cargar el historial:', error.message);
    }
}

function crearRegistroHistorial({
    idsLineas,
    rutaImagen,
    texto,
    lineasPorGrupo,
    intervaloMinutos,
    origen
}) {
    const id = crypto.randomUUID();
    const tipo = detectarTipoImagen(rutaImagen) || { extension: '.jpg', mime: 'image/jpeg' };
    const rutaCopia = path.join(CARPETA_IMAGENES_HISTORIAL, `${id}${tipo.extension}`);
    fs.copyFileSync(rutaImagen, rutaCopia);

    const registro = {
        id,
        fechaInicio: new Date().toISOString(),
        fechaFin: null,
        origen,
        texto: String(texto || ''),
        idsLineas: [...idsLineas],
        lineasPorGrupo,
        intervaloMinutos,
        rutaImagen: rutaCopia,
        mimeImagen: tipo.mime,
        estado: 'ejecutando',
        total: idsLineas.length,
        correctas: 0,
        fallidas: 0,
        lineasCorrectas: [],
        lineasFallidas: [],
        error: null
    };

    historialPublicaciones.unshift(registro);
    guardarHistorial();
    return registro;
}

function finalizarRegistroHistorial(registro, estado, error = null) {
    registro.fechaFin = new Date().toISOString();
    registro.estado = estado;
    registro.correctas = progresoPublicacion.correctas;
    registro.fallidas = progresoPublicacion.fallidas;
    registro.lineasCorrectas = [...progresoPublicacion.lineasCorrectas];
    registro.lineasFallidas = [...progresoPublicacion.lineasFallidas];
    registro.error = error;
    guardarHistorial();
}

function obtenerVistaEstadosActivos() {
    podarEstadosActivos(true);

    const ahora = Date.now();
    const publicaciones = [];
    let estadosEnLineas = 0;
    let conErrores = 0;

    for (const grupo of estadosActivos.values()) {
        const lineasVigentes = grupo.lineas.filter(linea =>
            obtenerMilisegundosFecha(linea.expiraEn, 0) > ahora
        );
        const pendientes = lineasVigentes.filter(linea =>
            linea.estado !== 'solicitud_enviada'
        );

        if (!pendientes.length) continue;

        estadosEnLineas += pendientes.length;
        conErrores += pendientes.filter(linea => linea.estado === 'error').length;

        publicaciones.push({
            id: grupo.id,
            fechaInicio: grupo.fechaInicio,
            expiraEn: grupo.expiraEn,
            texto: grupo.texto,
            imagenUrl: `/historial/${encodeURIComponent(grupo.id)}/imagen`,
            lineas: pendientes.map(registroLinea => {
                const lineaActual = lineas.get(registroLinea.lineaId);
                return {
                    lineaId: registroLinea.lineaId,
                    nombre: lineaActual?.nombre || registroLinea.nombre,
                    numero: lineaActual?.jid
                        ? lineaActual.jid.split('@')[0]
                        : registroLinea.numero,
                    estadoId: registroLinea.meta?.id || registroLinea.clave?.id || null,
                    estado: registroLinea.estado,
                    error: registroLinea.error || null
                };
            })
        });
    }

    publicaciones.sort((a, b) =>
        new Date(b.fechaInicio).getTime() - new Date(a.fechaInicio).getTime()
    );

    return {
        resumen: {
            gruposActivos: publicaciones.length,
            estadosEnLineas,
            conErrores,
            eliminadosAhora: progresoEliminacionEstados.eliminadas
        },
        publicaciones,
        progreso: { ...progresoEliminacionEstados }
    };
}

function procesarErroresRevocacion(linea, socket, actualizaciones) {
    if (linea.socket !== socket || !Array.isArray(actualizaciones)) return;

    let huboCambios = false;

    for (const actualizacion of actualizaciones) {
        if (actualizacion?.update?.status !== WAMessageStatus.ERROR) continue;

        const idRevocacion = String(actualizacion.key?.id || '');
        if (!idRevocacion) continue;

        for (const grupo of estadosActivos.values()) {
            const registroLinea = grupo.lineas.find(item =>
                item.lineaId === linea.id &&
                item.estado === 'solicitud_enviada' &&
                item.claveRevocacion?.id === idRevocacion
            );

            if (!registroLinea) continue;

            const codigo = actualizacion.update.messageStubParameters?.[0];
            registroLinea.estado = 'error';
            registroLinea.error = codigo
                ? `WhatsApp rechazó la solicitud de eliminación (${codigo}).`
                : 'WhatsApp rechazó la solicitud de eliminación.';
            registroLinea.eliminadoEn = null;
            registroLinea.claveRevocacion = null;
            registroLinea.revocacionConAudiencia = false;
            huboCambios = true;

            if (
                progresoEliminacionEstados.publicacionId === grupo.id &&
                progresoEliminacionEstados.eliminadas > 0
            ) {
                progresoEliminacionEstados.correctas = Math.max(
                    0,
                    progresoEliminacionEstados.correctas - 1
                );
                progresoEliminacionEstados.eliminadas -= 1;
                progresoEliminacionEstados.fallidas += 1;
                progresoEliminacionEstados.estado = 'completado_con_errores';
                progresoEliminacionEstados.mensaje =
                    'WhatsApp rechazó una solicitud. La línea quedó disponible para reintentar.';
            }
        }
    }

    if (huboCambios) {
        guardarEstadosActivos();
    }
}

async function solicitarEliminacionEstado(grupo, registroLinea) {
    const linea = lineas.get(registroLinea.lineaId);

    try {
        if (!linea || linea.estado !== 'conectado' || !linea.socket) {
            throw new Error('La línea no está conectada. Podés reintentar cuando vuelva a conectarse.');
        }

        const clave = obtenerClaveEstadoDesdeMeta(registroLinea);
        if (!clave) {
            throw new Error('La clave guardada del estado no es válida.');
        }

        if (obtenerMilisegundosFecha(registroLinea.expiraEn, 0) <= Date.now()) {
            throw new Error('El estado ya cumplió 24 horas y no necesita eliminarse.');
        }

        let destinatariosRevocacion = normalizarDestinatariosEstadoGuardados(
            registroLinea.meta?.statusJidList
        );

        // Los registros creados antes de guardar esta metadata usan como
        // respaldo la audiencia actual y quedan actualizados para el reintento.
        if (!destinatariosRevocacion.length) {
            destinatariosRevocacion = await obtenerDestinatariosEstado(linea);
        }

        registroLinea.meta = normalizarMetaEstadoActivo(
            { statusJidList: destinatariosRevocacion },
            clave
        );
        registroLinea.estado = 'eliminando';
        registroLinea.error = null;
        registroLinea.claveRevocacion = null;
        registroLinea.revocacionConAudiencia = false;
        guardarEstadosActivos();

        const mensajeRevocacion = await linea.socket.sendMessage(
            'status@broadcast',
            { delete: clave },
            {
                statusJidList: destinatariosRevocacion,
                broadcast: true
            }
        );
        const claveRevocacion = copiarClaveMensajeEstado(mensajeRevocacion?.key);

        if (!claveRevocacion) {
            throw new Error('WhatsApp no devolvió la clave de la solicitud de eliminación.');
        }

        registroLinea.estado = 'solicitud_enviada';
        registroLinea.error = null;
        registroLinea.eliminadoEn = new Date().toISOString();
        registroLinea.claveRevocacion = claveRevocacion;
        registroLinea.revocacionConAudiencia = true;
        guardarEstadosActivos();
        return true;
    } catch (error) {
        registroLinea.estado = 'error';
        registroLinea.error = error.message || 'No se pudo solicitar la eliminación.';
        registroLinea.eliminadoEn = null;
        registroLinea.claveRevocacion = null;
        registroLinea.revocacionConAudiencia = false;

        try {
            guardarEstadosActivos();
        } catch (errorGuardado) {
            console.error(
                `No se pudo guardar el error de eliminación de ${registroLinea.nombre}:`,
                errorGuardado.message
            );
        }

        console.error(
            `No se pudo solicitar la eliminación en ${registroLinea.nombre}:`,
            registroLinea.error
        );
        return false;
    }
}

async function ejecutarEliminacionEstados(publicacionId) {
    const grupo = estadosActivos.get(publicacionId);
    if (!grupo) return;

    const ahora = Date.now();
    const pendientes = grupo.lineas.filter(linea =>
        linea.estado !== 'solicitud_enviada' &&
        obtenerMilisegundosFecha(linea.expiraEn, 0) > ahora
    );
    const totalGrupos = Math.ceil(
        Math.max(pendientes.length, 1) / LINEAS_POR_LOTE_ELIMINACION
    );

    progresoEliminacionEstados = {
        activo: true,
        estado: 'eliminando',
        publicacionId,
        total: pendientes.length,
        procesadas: 0,
        correctas: 0,
        eliminadas: 0,
        fallidas: 0,
        grupoActual: 0,
        totalGrupos,
        mensaje: 'Solicitando la eliminación de los estados...'
    };

    for (
        let inicio = 0;
        inicio < pendientes.length;
        inicio += LINEAS_POR_LOTE_ELIMINACION
    ) {
        const lote = pendientes.slice(inicio, inicio + LINEAS_POR_LOTE_ELIMINACION);
        progresoEliminacionEstados.grupoActual =
            Math.floor(inicio / LINEAS_POR_LOTE_ELIMINACION) + 1;
        progresoEliminacionEstados.mensaje =
            `Procesando lote ${progresoEliminacionEstados.grupoActual} de ${totalGrupos}.`;

        const resultados = await Promise.all(
            lote.map(registroLinea =>
                solicitarEliminacionEstado(grupo, registroLinea)
            )
        );

        progresoEliminacionEstados.procesadas += lote.length;
        const correctasLote = resultados.filter(Boolean).length;
        progresoEliminacionEstados.correctas += correctasLote;
        progresoEliminacionEstados.eliminadas += correctasLote;
        progresoEliminacionEstados.fallidas +=
            resultados.filter(resultado => !resultado).length;
    }

    progresoEliminacionEstados.activo = false;
    progresoEliminacionEstados.estado = progresoEliminacionEstados.fallidas
        ? 'completado_con_errores'
        : 'completado';
    progresoEliminacionEstados.mensaje = progresoEliminacionEstados.fallidas
        ? `Se enviaron ${progresoEliminacionEstados.eliminadas} solicitud(es) y ` +
            `${progresoEliminacionEstados.fallidas} línea(s) quedaron para reintentar.`
        : `Solicitud de eliminación enviada para ` +
            `${progresoEliminacionEstados.eliminadas} estado(s).`;
}

function obtenerExtensionImagen(nombreOriginal) {
    const extension = path.extname(nombreOriginal || '').toLowerCase();
    return ['.jpg', '.jpeg', '.png'].includes(extension) ? extension : '.jpg';
}

function horaValida(hora) {
    return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(hora || ''));
}

function obtenerLineasDisponibles(idsLineas) {
    const correctas = [];
    const noDisponibles = [];

    for (const id of idsLineas) {
        const linea = lineas.get(id);

        if (linea && linea.estado === 'conectado' && linea.socket) {
            correctas.push(linea);
        } else {
            noDisponibles.push({
                id,
                nombre: linea?.nombre || 'Línea no encontrada',
                error: 'La línea no está conectada.'
            });
        }
    }

    return { correctas, noDisponibles };
}

async function iniciarWhatsApp(lineaId) {
    const linea = lineas.get(lineaId);

    if (!linea || linea.iniciando) return;

    asegurarAudienciaEstados(linea);

    const conservarEstadoDesconectado =
        ['desconectado', 'reconectando'].includes(linea.estado);

    linea.iniciando = true;

    if (!conservarEstadoDesconectado) {
        linea.estado = 'iniciando';
    }

    linea.qr = null;

    const carpetaSesion = resolverCarpetaSesionSegura(lineaId);

    if (!carpetaSesion) {
        linea.iniciando = false;
        linea.estado = 'error';
        linea.ultimoError = 'El identificador guardado de la línea no es válido.';
        guardarLineas();
        return;
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(carpetaSesion);
        const sesionExistente = state.creds.registered === true;

        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: Browsers.windows('Desktop'),
            syncFullHistory: false
        });

        linea.socket = sock;
        linea.iniciando = false;

        const procesarContactos = (
            contactos,
            permitirEliminarSinNombre = false
        ) => {
            linea.promesaContactosEstado = (
                linea.promesaContactosEstado || Promise.resolve()
            )
                .then(() => actualizarContactosEstado(
                    linea,
                    sock,
                    contactos,
                    permitirEliminarSinNombre
                ))
                .catch(error => {
                    console.error(
                        `No se pudo actualizar la audiencia de ${linea.nombre}:`,
                        error.message
                    );
                });
        };

        // contacts.upsert proviene de la libreta sincronizada. No usamos los
        // contactos del historial de chats porque también contiene personas
        // no guardadas y podría exponerles un estado por error.
        sock.ev.on('contacts.upsert', contactos => {
            procesarContactos(contactos, true);
        });
        sock.ev.on('contacts.update', contactos => {
            procesarContactos(contactos, false);
        });

        sock.ev.on('settings.update', actualizacion => {
            if (
                linea.socket === sock &&
                actualizacion?.setting === 'statusPrivacy'
            ) {
                try {
                    actualizarPrivacidadEstados(linea, actualizacion.value);

                    if (!audienciaEstadosLista(linea)) {
                        programarResincronizacionAudiencia(linea, sock, 1000);
                    }
                } catch (error) {
                    console.error(
                        `No se pudo guardar la privacidad de ${linea.nombre}:`,
                        error.message
                    );
                }
            }
        });

        sock.ev.on('messages.update', actualizaciones => {
            try {
                procesarErroresRevocacion(linea, sock, actualizaciones);
            } catch (error) {
                console.error(
                    `No se pudo actualizar una revocación de ${linea.nombre}:`,
                    error.message
                );
            }
        });

        sock.ev.on('connection.update', async update => {
            const { connection, qr, lastDisconnect } = update;

            if (!lineas.has(lineaId)) return;

            // Si este evento pertenece a un socket viejo, lo ignoramos.
            // Esto evita que una reconexión manual sea pisada por el cierre anterior.
            if (linea.socket !== sock) return;

            if (qr) {
                try {
                    linea.qr = await QRCode.toDataURL(qr);
                    linea.estado = 'esperando_qr';
                } catch (error) {
                    linea.estado = 'error';
                    console.error(`No se pudo convertir el QR de ${linea.nombre}:`, error);
                }
            }

            if (connection === 'open') {
                cancelarReintentoAudiencia(linea);
                linea.socket = sock;
                linea.qr = null;
                linea.estado = 'conectado';
                linea.reconexionManualEnCurso = false;
                linea.resincronizandoAudiencia = false;
                linea.intentosResincronizacionAudiencia = 0;
                linea.ultimaConexion = new Date().toISOString();
                linea.ultimoError = null;
                guardarLineas();

                linea.jid = jidNormalizedUser(sock.user.id);

                console.log(
                    `Línea conectada: ${linea.nombre} ` +
                    `(${linea.contactosEstado.size} contacto(s) sincronizado(s))`
                );

                if (!audienciaEstadosLista(linea)) {
                    programarResincronizacionAudiencia(
                        linea,
                        sock,
                        sesionExistente ? 1500 : 8000
                    );
                }
            }

            if (connection === 'close') {
                const codigoError = lastDisconnect?.error?.output?.statusCode;

                cancelarReintentoAudiencia(linea);
                linea.socket = null;
                linea.jid = null;
                linea.qr = null;

                if (codigoError === 401) {
                    linea.estado = 'sesion_cerrada';
                    linea.ultimoError = 'La sesión de WhatsApp fue cerrada.';
                    linea.contactosEstado = new Set();
                    linea.privacidadEstados = null;
                    linea.audienciaResincronizada = false;
                    linea.promesaContactosEstado = Promise.resolve();
                    linea.audienciaEstadosCargada = true;
                    fs.rmSync(carpetaSesion, { recursive: true, force: true });
                } else {
                    // La linea permanece marcada como desconectada hasta que
                    // una nueva conexion se abra correctamente.
                    linea.estado = 'desconectado';
                    linea.ultimoError = 'La línea se desconectó y está intentando reconectar.';
                }

                guardarLineas();

                if (linea.eliminando || !lineas.has(lineaId)) return;

                linea.temporizadorReconexion = setTimeout(() => {
                    if (lineas.has(lineaId) && !linea.eliminando) {
                        iniciarWhatsApp(lineaId);
                    }
                }, 3000);
            }
        });

        sock.ev.on('creds.update', saveCreds);
    } catch (error) {
        linea.iniciando = false;
        linea.reconexionManualEnCurso = false;
        linea.estado = 'error';
        linea.ultimoError = error.message || 'No se pudo iniciar la línea.';
        guardarLineas();
        console.error(`Error iniciando ${linea.nombre}:`, error);
    }
}

async function esperarEntreGrupos(ms) {
    let segundos = Math.ceil(ms / 1000);
    progresoPublicacion.proximoGrupoSegundos = segundos;

    while (segundos > 0) {
        await esperar(1000);
        segundos -= 1;
        progresoPublicacion.proximoGrupoSegundos = segundos;
    }
}

async function ejecutarPublicacion({
    idsLineas,
    rutaImagen,
    texto,
    lineasPorGrupo,
    intervaloMinutos,
    origen
}) {
    if (!fs.existsSync(rutaImagen)) {
        throw new Error('No se encontró la imagen que se debía publicar.');
    }

    idsLineas = normalizarIdsLineas(idsLineas);
    if (!idsLineas.length) {
        throw new Error('La publicación no contiene líneas válidas.');
    }

    controlSeguridadPublicacion = {
        pausada: false,
        resolver: null
    };

    const imagenLeida = fs.readFileSync(rutaImagen);
    const textoLimpio = String(texto || '').trim();
    const registroHistorial = crearRegistroHistorial({
        idsLineas,
        rutaImagen,
        texto: textoLimpio,
        lineasPorGrupo,
        intervaloMinutos,
        origen
    });
    const { correctas: lineasDisponibles, noDisponibles } =
        obtenerLineasDisponibles(idsLineas);

    const total = idsLineas.length;
    const totalGrupos = Math.ceil(
        Math.max(lineasDisponibles.length, 1) / lineasPorGrupo
    );

    progresoPublicacion = {
        activo: true,
        estado: 'publicando',
        origen,
        total,
        procesadas: noDisponibles.length,
        correctas: 0,
        fallidas: noDisponibles.length,
        grupoActual: 0,
        totalGrupos,
        proximoGrupoSegundos: 0,
        lineasCorrectas: [],
        lineasFallidas: [...noDisponibles],
        seguridadActiva: false,
        fallosGrupoActual: 0,
        totalGrupoActual: 0,
        porcentajeFallosGrupo: 0,
        mensajeSeguridad: '',
        mensaje: 'Preparando publicación...'
    };

    try {
        if (lineasDisponibles.length === 0) {
            throw new Error('Ninguna de las líneas seleccionadas está conectada.');
        }

        for (
            let inicio = 0;
            inicio < lineasDisponibles.length;
            inicio += lineasPorGrupo
        ) {
            const grupo = lineasDisponibles.slice(inicio, inicio + lineasPorGrupo);

            progresoPublicacion.grupoActual =
                Math.floor(inicio / lineasPorGrupo) + 1;
            progresoPublicacion.estado = 'publicando';
            progresoPublicacion.proximoGrupoSegundos = 0;
            progresoPublicacion.seguridadActiva = false;
            progresoPublicacion.mensajeSeguridad = '';
            progresoPublicacion.mensaje =
                `Publicando grupo ${progresoPublicacion.grupoActual} de ${totalGrupos}.`;

            const resultadosGrupo = await Promise.all(
                grupo.map(async linea => {
                    try {
                        const destinatariosEstado =
                            await obtenerDestinatariosEstado(linea);
                        const contenido = { image: imagenLeida };

                        if (textoLimpio) {
                            contenido.caption = textoLimpio;
                        }

                        const mensajeEstado = await linea.socket.sendMessage(
                            'status@broadcast',
                            contenido,
                            {
                                statusJidList: destinatariosEstado,
                                broadcast: true
                            }
                        );

                        registrarEstadoActivo(
                            registroHistorial,
                            linea,
                            mensajeEstado,
                            destinatariosEstado
                        );

                        progresoPublicacion.correctas += 1;
                        progresoPublicacion.lineasCorrectas.push({
                            id: linea.id,
                            nombre: linea.nombre,
                            numero: linea.jid ? linea.jid.split('@')[0] : null,
                            destinatarios: destinatariosEstado.length
                        });
                        linea.ultimaPublicacion = new Date().toISOString();
                        linea.ultimoError = null;
                        linea.fallosRecientes = 0;

                        return true;
                    } catch (error) {
                        progresoPublicacion.fallidas += 1;
                        progresoPublicacion.lineasFallidas.push({
                            id: linea.id,
                            nombre: linea.nombre,
                            error: error.message || 'Error desconocido'
                        });
                        linea.ultimoError = error.message || 'Error al publicar.';
                        linea.fallosRecientes = (Number(linea.fallosRecientes) || 0) + 1;

                        console.error(`Error publicando en ${linea.nombre}:`, error);
                        return false;
                    } finally {
                        progresoPublicacion.procesadas += 1;
                    }
                })
            );

            guardarLineas();

            const fallosGrupo = resultadosGrupo.filter(resultado => !resultado).length;
            const porcentajeFallos = grupo.length > 0
                ? fallosGrupo / grupo.length
                : 0;
            const quedanGrupos =
                inicio + lineasPorGrupo < lineasDisponibles.length;

            progresoPublicacion.fallosGrupoActual = fallosGrupo;
            progresoPublicacion.totalGrupoActual = grupo.length;
            progresoPublicacion.porcentajeFallosGrupo =
                Math.round(porcentajeFallos * 100);

            let reanudadaTrasSeguridad = false;

            if (
                quedanGrupos &&
                porcentajeFallos >= configuracion.umbralFallosSeguridad
            ) {
                progresoPublicacion.estado = 'detenido_seguridad';
                progresoPublicacion.seguridadActiva = true;
                progresoPublicacion.proximoGrupoSegundos = 0;
                progresoPublicacion.mensajeSeguridad =
                    `Fallaron ${fallosGrupo} de ${grupo.length} líneas ` +
                    `(${Math.round(porcentajeFallos * 100)}%) en el grupo ` +
                    `${progresoPublicacion.grupoActual}.`;
                progresoPublicacion.mensaje =
                    'Publicación detenida por seguridad. Corroborá el problema antes de reanudar.';
                notificarEscritorio(
                    'Publicación detenida',
                    progresoPublicacion.mensajeSeguridad
                );

                const decision = await esperarDecisionSeguridad();

                if (decision === 'cancelar') {
                    const errorCancelacion = new Error(
                        'Publicación cancelada manualmente después del corte de seguridad.'
                    );
                    errorCancelacion.codigo = 'CANCELADA_SEGURIDAD';
                    throw errorCancelacion;
                }

                progresoPublicacion.estado = 'publicando';
                progresoPublicacion.seguridadActiva = false;
                progresoPublicacion.mensajeSeguridad = '';
                progresoPublicacion.mensaje =
                    'Control de seguridad confirmado. Continuando con el próximo grupo.';
                reanudadaTrasSeguridad = true;
            }

            if (
                quedanGrupos &&
                intervaloMinutos > 0 &&
                !reanudadaTrasSeguridad
            ) {
                progresoPublicacion.estado = 'esperando_siguiente_grupo';
                progresoPublicacion.mensaje =
                    'Esperando para comenzar el próximo grupo.';

                await esperarEntreGrupos(intervaloMinutos * 60 * 1000);
            }
        }

        progresoPublicacion.activo = false;
        progresoPublicacion.estado = 'completado';
        progresoPublicacion.seguridadActiva = false;
        progresoPublicacion.proximoGrupoSegundos = 0;
        progresoPublicacion.mensaje =
            `Publicación completada: ${progresoPublicacion.correctas} correctas ` +
            `y ${progresoPublicacion.fallidas} fallidas.`;
        finalizarRegistroHistorial(registroHistorial, 'completado');
        notificarEscritorio('Publicación finalizada', progresoPublicacion.mensaje);

        return {
            correctas: progresoPublicacion.correctas,
            fallidas: progresoPublicacion.fallidas
        };
    } catch (error) {
        progresoPublicacion.activo = false;
        progresoPublicacion.seguridadActiva = false;
        progresoPublicacion.proximoGrupoSegundos = 0;

        if (error.codigo === 'CANCELADA_SEGURIDAD') {
            progresoPublicacion.estado = 'cancelado_seguridad';
        } else {
            progresoPublicacion.estado = 'error';
        }

        progresoPublicacion.mensaje = error.message;
        finalizarRegistroHistorial(
            registroHistorial,
            error.codigo === 'CANCELADA_SEGURIDAD' ? 'cancelado' : 'error',
            error.message
        );
        notificarEscritorio('Error en la publicación', error.message);
        throw error;
    } finally {
        controlSeguridadPublicacion = {
            pausada: false,
            resolver: null
        };
    }
}

function encolarPublicacion(configuracion) {
    publicacionesPendientes += 1;

    const tarea = colaPublicaciones.then(async () => {
        publicacionesPendientes -= 1;
        return ejecutarPublicacion(configuracion);
    });

    colaPublicaciones = tarea.catch(() => {});
    return tarea;
}

function cancelarTrabajoProgramado(id) {
    const trabajo = trabajosProgramados.get(id);

    if (trabajo) {
        trabajo.cancel();
        trabajosProgramados.delete(id);
    }
}

function programarTrabajo(programacion) {
    cancelarTrabajoProgramado(programacion.id);

    if (programacion.activa === false) {
        return;
    }

    if (!horaValida(programacion.hora)) {
        throw new Error('La hora programada no es válida.');
    }

    const [hora, minuto] = programacion.hora.split(':').map(Number);
    const regla = new schedule.RecurrenceRule();
    regla.dayOfWeek = normalizarDiasSemana(programacion.diasSemana);
    regla.hour = hora;
    regla.minute = minuto;
    regla.second = 0;

    const trabajo = schedule.scheduleJob(regla, async () => {
        await ejecutarProgramacion(programacion.id);
    });

    if (!trabajo) {
        throw new Error('No se pudo crear la programación.');
    }

    trabajosProgramados.set(programacion.id, trabajo);
}

function proximaEjecucionISO(id) {
    const trabajo = trabajosProgramados.get(id);
    const proxima = trabajo?.nextInvocation?.();

    if (!proxima) return null;

    try {
        return new Date(proxima).toISOString();
    } catch {
        return null;
    }
}

function yaSeEjecutoHoy(programacion) {
    if (!programacion.ultimaEjecucion) return false;

    const ultima = new Date(programacion.ultimaEjecucion);
    const ahora = new Date();

    return (
        ultima.getFullYear() === ahora.getFullYear() &&
        ultima.getMonth() === ahora.getMonth() &&
        ultima.getDate() === ahora.getDate()
    );
}

function recuperarEjecucionReciente(programacion) {
    if (programacion.activa === false || yaSeEjecutoHoy(programacion)) return;
    if (!normalizarDiasSemana(programacion.diasSemana).includes(new Date().getDay())) return;

    const [hora, minuto] = programacion.hora.split(':').map(Number);
    const ahora = new Date();
    const horaDeHoy = new Date();
    horaDeHoy.setHours(hora, minuto, 0, 0);

    const retraso = ahora.getTime() - horaDeHoy.getTime();

    if (retraso > 5000 && retraso <= 10 * 60 * 1000) {
        setTimeout(() => ejecutarProgramacion(programacion.id), 2000);
    }
}

async function ejecutarProgramacion(id) {
    const programacion = programaciones.get(id);

    if (!programacion || programacion.activa === false) return;
    if (['en_cola', 'ejecutando'].includes(programacion.estado)) return;

    programacion.estado = 'en_cola';
    programacion.mensaje = 'Esperando turno para publicar.';
    guardarProgramaciones();

    try {
        programacion.estado = 'ejecutando';
        programacion.mensaje = 'Publicando estado programado.';
        guardarProgramaciones();

        const resultado = await encolarPublicacion({
            idsLineas: programacion.idsLineas,
            rutaImagen: programacion.rutaImagen,
            texto: programacion.texto,
            lineasPorGrupo: programacion.lineasPorGrupo,
            intervaloMinutos: programacion.intervaloMinutos,
            origen: `programación diaria ${programacion.id}`
        });

        programacion.estado = programacion.activa === false ? 'pausado' : 'programado';
        programacion.ultimaEjecucion = new Date().toISOString();
        programacion.ultimoResultado = {
            correctas: resultado.correctas,
            fallidas: resultado.fallidas
        };
        programacion.mensaje =
            `Última ejecución: ${resultado.correctas} correctas y ` +
            `${resultado.fallidas} fallidas.`;
    } catch (error) {
        programacion.estado = programacion.activa === false ? 'pausado' : 'programado';
        programacion.ultimaEjecucion = new Date().toISOString();
        programacion.ultimoResultado = {
            correctas: 0,
            fallidas: programacion.idsLineas.length,
            error: error.message
        };
        programacion.mensaje = `Último intento con error: ${error.message}`;
    } finally {
        guardarProgramaciones();
    }
}

function cargarProgramaciones() {
    if (!fs.existsSync(archivoProgramaciones)) return;

    try {
        const datos = JSON.parse(fs.readFileSync(archivoProgramaciones, 'utf8'));
        let huboMigracion = false;

        for (const itemOriginal of datos) {
            const item = { ...itemOriginal };

            if (!item.hora && item.fechaHora) {
                const fechaAnterior = new Date(item.fechaHora);

                if (
                    !Number.isNaN(fechaAnterior.getTime()) &&
                    ['programado', 'en_cola', 'ejecutando'].includes(item.estado)
                ) {
                    item.hora = [
                        String(fechaAnterior.getHours()).padStart(2, '0'),
                        String(fechaAnterior.getMinutes()).padStart(2, '0')
                    ].join(':');
                    item.estado = 'programado';
                    item.mensaje = 'Programación migrada a repetición diaria.';
                    huboMigracion = true;
                } else {
                    continue;
                }
            }

            if (!horaValida(item.hora)) continue;

            item.texto = String(item.texto || '');

            const idsLineasNormalizados = normalizarIdsLineas(item.idsLineas);
            if (
                !Array.isArray(item.idsLineas) ||
                JSON.stringify(idsLineasNormalizados) !==
                    JSON.stringify(item.idsLineas)
            ) {
                huboMigracion = true;
            }
            item.idsLineas = idsLineasNormalizados;

            item.activa = item.activa !== false;
            item.diasSemana = normalizarDiasSemana(item.diasSemana);
            item.estado = item.activa ? 'programado' : 'pausado';
            item.ultimaEjecucion = item.ultimaEjecucion || item.ejecutadoEn || null;
            item.ultimoResultado = item.ultimoResultado || null;
            item.actualizadoEn = item.actualizadoEn || item.creadoEn || new Date().toISOString();

            if (!fs.existsSync(item.rutaImagen || '') && item.rutaImagen) {
                const posibleRutaMigrada = path.join(
                    CARPETA_IMAGENES_PROGRAMADAS,
                    path.basename(item.rutaImagen)
                );

                if (fs.existsSync(posibleRutaMigrada)) {
                    item.rutaImagen = posibleRutaMigrada;
                    huboMigracion = true;
                }
            }

            if (!fs.existsSync(item.rutaImagen || '')) {
                item.mensaje = 'La imagen programada no existe. Editá la programación.';
            }

            programaciones.set(item.id, item);
            if (item.activa) {
                programarTrabajo(item);
                recuperarEjecucionReciente(item);
            }
        }

        if (huboMigracion) guardarProgramaciones();
    } catch (error) {
        console.error('No se pudieron cargar las programaciones:', error);
    }
}

function validarConfiguracionComun(req, rutaTemporalFoto, imagenObligatoria = true) {
    if (imagenObligatoria && !req.file) {
        return { error: 'Tenés que seleccionar una imagen.' };
    }

    if (req.file) {
        const validacionImagen = validarImagenSubida(req.file);
        if (validacionImagen.error) {
            eliminarArchivoSeguro(rutaTemporalFoto);
            return { error: validacionImagen.error };
        }
    }

    let idsLineas;

    try {
        idsLineas = JSON.parse(req.body.lineas || '[]');
    } catch {
        eliminarArchivoSeguro(rutaTemporalFoto);
        return { error: 'La selección de líneas no es válida.' };
    }

    const lineasPorGrupo = Number(req.body.lineasPorGrupo);
    const intervaloMinutos = Number(req.body.intervaloMinutos);

    if (!Array.isArray(idsLineas) || idsLineas.length === 0) {
        eliminarArchivoSeguro(rutaTemporalFoto);
        return { error: 'Seleccioná al menos una línea.' };
    }

    if (idsLineas.some(id => typeof id !== 'string' || !esIdLineaValido(id))) {
        eliminarArchivoSeguro(rutaTemporalFoto);
        return { error: 'La selección contiene una línea no válida.' };
    }

    idsLineas = normalizarIdsLineas(idsLineas);

    if (
        !Number.isInteger(lineasPorGrupo) ||
        lineasPorGrupo < 1 ||
        lineasPorGrupo > 50
    ) {
        eliminarArchivoSeguro(rutaTemporalFoto);
        return { error: 'La cantidad de líneas por envío debe estar entre 1 y 50.' };
    }

    if (
        !Number.isFinite(intervaloMinutos) ||
        intervaloMinutos < 0 ||
        intervaloMinutos > 1440
    ) {
        eliminarArchivoSeguro(rutaTemporalFoto);
        return { error: 'El intervalo debe estar entre 0 y 1440 minutos.' };
    }

    return { idsLineas, lineasPorGrupo, intervaloMinutos };
}

app.post('/lineas', (req, res) => {
    const nombre = String(req.body.nombre || '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!nombre) {
        return res.status(400).json({
            error: 'Tenés que escribir un nombre para la línea.'
        });
    }

    if (nombre.length > 80) {
        return res.status(400).json({
            error: 'El nombre de la línea no puede superar los 80 caracteres.'
        });
    }

    const nombreRepetido = Array.from(lineas.values()).some(linea =>
        linea.nombre.toLowerCase() === nombre.toLowerCase()
    );

    if (nombreRepetido) {
        return res.status(409).json({
            error: 'Ya existe una línea con ese nombre.'
        });
    }

    const id = crypto.randomUUID();
    const ordenConexion = obtenerSiguienteOrdenConexion();

    lineas.set(id, {
        id,
        nombre,
        ordenConexion,
        etiqueta: 'activa',
        socket: null,
        jid: null,
        qr: null,
        estado: 'iniciando',
        iniciando: false,
        eliminando: false,
        temporizadorReconexion: null,
        temporizadorAudiencia: null,
        reconexionManualEnCurso: false,
        resincronizandoAudiencia: false,
        intentosResincronizacionAudiencia: 0,
        ultimaConexion: null,
        ultimaPublicacion: null,
        ultimoError: null,
        fallosRecientes: 0,
        contactosEstado: new Set(),
        privacidadEstados: null,
        audienciaResincronizada: false,
        promesaContactosEstado: Promise.resolve(),
        audienciaEstadosCargada: true
    });

    guardarLineas();
    iniciarWhatsApp(id);

    res.status(201).json({
        id,
        nombre,
        ordenConexion,
        mensaje: 'Línea creada correctamente.'
    });
});

app.get('/estado', (req, res) => {
    const resultado = Array.from(lineas.values())
        .sort((a, b) =>
            (Number(a.ordenConexion) || 0) - (Number(b.ordenConexion) || 0)
        )
        .map(linea => ({
            id: linea.id,
            nombre: linea.nombre,
            ordenConexion: Number(linea.ordenConexion) || 0,
            etiqueta: normalizarEtiqueta(linea.etiqueta),
            estado: linea.estado,
            qr: linea.qr,
            numero: linea.jid ? linea.jid.split('@')[0] : null,
            ultimaConexion: linea.ultimaConexion || null,
            ultimaPublicacion: linea.ultimaPublicacion || null,
            ultimoError: linea.ultimoError || null,
            fallosRecientes: Number(linea.fallosRecientes) || 0,
            contactosEstado: linea.contactosEstado?.size || 0,
            destinatariosEstado: contarDestinatariosEstado(linea),
            audienciaEstadosLista: audienciaEstadosLista(linea)
        }));

    res.json({ lineas: resultado });
});

app.patch('/lineas/:id', (req, res) => {
    const linea = lineas.get(req.params.id);
    if (!linea) {
        return res.status(404).json({ error: 'La línea no existe.' });
    }

    const nombre = String(req.body.nombre || '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!nombre) {
        return res.status(400).json({
            error: 'Tenés que escribir un nombre para la línea.'
        });
    }

    if (nombre.length > 80) {
        return res.status(400).json({
            error: 'El nombre de la línea no puede superar los 80 caracteres.'
        });
    }

    const nombreRepetido = Array.from(lineas.values()).some(otraLinea =>
        otraLinea.id !== linea.id &&
        otraLinea.nombre.toLowerCase() === nombre.toLowerCase()
    );

    if (nombreRepetido) {
        return res.status(409).json({
            error: 'Ya existe una línea con ese nombre.'
        });
    }

    linea.nombre = nombre;
    guardarLineas();

    let actualizoEstados = false;
    for (const grupo of estadosActivos.values()) {
        for (const registroLinea of grupo.lineas) {
            if (registroLinea.lineaId === linea.id && registroLinea.nombre !== nombre) {
                registroLinea.nombre = nombre;
                actualizoEstados = true;
            }
        }
    }

    if (actualizoEstados) {
        guardarEstadosActivos();
    }

    res.json({
        mensaje: `La línea ahora se llama ${nombre}.`,
        id: linea.id,
        nombre,
        ordenConexion: Number(linea.ordenConexion) || 0
    });
});

app.get('/progreso', (req, res) => {
    res.json(progresoPublicacion);
});

function obtenerActualizador() {
    const actualizador = global.autostatuesUpdater;

    if (!actualizador || typeof actualizador.obtenerEstado !== 'function') {
        return null;
    }

    return actualizador;
}

app.get('/actualizacion/estado', (req, res) => {
    const actualizador = obtenerActualizador();

    if (!actualizador) {
        return res.status(503).json({
            estado: 'no_disponible',
            mensaje: 'El actualizador no está disponible en este modo de ejecución.'
        });
    }

    res.json(actualizador.obtenerEstado());
});

app.post('/actualizacion/buscar', async (req, res) => {
    const actualizador = obtenerActualizador();

    if (!actualizador) {
        return res.status(503).json({
            error: 'El actualizador no está disponible.'
        });
    }

    try {
        res.json(await actualizador.buscar());
    } catch (error) {
        res.status(500).json({
            error: error.message || 'No se pudo buscar una actualización.'
        });
    }
});

app.post('/actualizacion/descargar', async (req, res) => {
    const actualizador = obtenerActualizador();

    if (!actualizador) {
        return res.status(503).json({
            error: 'El actualizador no está disponible.'
        });
    }

    try {
        res.json(await actualizador.descargar());
    } catch (error) {
        res.status(500).json({
            error: error.message || 'No se pudo descargar la actualización.'
        });
    }
});

app.post('/actualizacion/instalar', (req, res) => {
    const actualizador = obtenerActualizador();

    if (!actualizador) {
        return res.status(503).json({
            error: 'El actualizador no está disponible.'
        });
    }

    try {
        res.json(actualizador.instalar());
    } catch (error) {
        res.status(500).json({
            error: error.message || 'No se pudo iniciar la instalación.'
        });
    }
});


app.post('/progreso/reanudar', (req, res) => {
    if (progresoPublicacion.estado !== 'detenido_seguridad') {
        return res.status(409).json({
            error: 'No hay una publicación detenida por seguridad.'
        });
    }

    if (!resolverDecisionSeguridad('reanudar')) {
        return res.status(409).json({
            error: 'La publicación ya no está esperando una decisión.'
        });
    }

    res.json({
        mensaje: 'Publicación reanudada. Se continuará con el próximo grupo.'
    });
});

app.post('/progreso/cancelar', (req, res) => {
    if (progresoPublicacion.estado !== 'detenido_seguridad') {
        return res.status(409).json({
            error: 'No hay una publicación detenida por seguridad.'
        });
    }

    if (!resolverDecisionSeguridad('cancelar')) {
        return res.status(409).json({
            error: 'La publicación ya no está esperando una decisión.'
        });
    }

    res.json({
        mensaje: 'Publicación cancelada por seguridad.'
    });
});

app.post('/subir', upload.single('imagen'), (req, res) => {
    const rutaTemporalFoto = req.file?.path;
    const validacion = validarConfiguracionComun(req, rutaTemporalFoto, true);

    if (validacion.error) {
        return res.status(400).json({ error: validacion.error });
    }

    if (progresoPublicacion.activo || publicacionesPendientes > 0) {
        eliminarArchivoSeguro(rutaTemporalFoto);
        return res.status(409).json({
            error: 'Ya existe una publicación en curso o en espera.'
        });
    }

    const { idsLineas, lineasPorGrupo, intervaloMinutos } = validacion;

    res.status(202).json({
        mensaje: `Publicación iniciada para ${idsLineas.length} línea(s).`
    });

    encolarPublicacion({
        idsLineas,
        rutaImagen: rutaTemporalFoto,
        texto: String(req.body.texto || ''),
        lineasPorGrupo,
        intervaloMinutos,
        origen: 'publicación manual'
    })
        .catch(error => {
            console.error('Falló la publicación manual:', error);
        })
        .finally(() => {
            eliminarArchivoSeguro(rutaTemporalFoto);
        });
});

app.post('/programar', upload.single('imagen'), (req, res) => {
    const rutaTemporalFoto = req.file?.path;
    const validacion = validarConfiguracionComun(req, rutaTemporalFoto, true);

    if (validacion.error) {
        return res.status(400).json({ error: validacion.error });
    }

    const hora = String(req.body.hora || '').trim();
    let diasSemana;

    try {
        diasSemana = normalizarDiasSemana(JSON.parse(req.body.diasSemana || '[]'));
    } catch {
        eliminarArchivoSeguro(rutaTemporalFoto);
        return res.status(400).json({ error: 'Los días seleccionados no son válidos.' });
    }

    if (!horaValida(hora)) {
        eliminarArchivoSeguro(rutaTemporalFoto);
        return res.status(400).json({
            error: 'Seleccioná una hora válida.'
        });
    }

    const { idsLineas, lineasPorGrupo, intervaloMinutos } = validacion;
    const id = crypto.randomUUID();
    const extension = detectarTipoImagen(rutaTemporalFoto)?.extension ||
        obtenerExtensionImagen(req.file.originalname);
    const rutaImagen = path.join(CARPETA_IMAGENES_PROGRAMADAS, `${id}${extension}`);

    moverArchivo(rutaTemporalFoto, rutaImagen);

    const programacion = {
        id,
        hora,
        diasSemana,
        activa: true,
        texto: String(req.body.texto || ''),
        idsLineas,
        lineasPorGrupo,
        intervaloMinutos,
        rutaImagen,
        nombreArchivo: req.file.originalname,
        estado: 'programado',
        mensaje: 'Esperando la próxima ejecución programada.',
        creadoEn: new Date().toISOString(),
        actualizadoEn: new Date().toISOString(),
        ultimaEjecucion: null,
        ultimoResultado: null
    };

    try {
        programaciones.set(id, programacion);
        programarTrabajo(programacion);
        guardarProgramaciones();

        res.status(201).json({
            mensaje: 'Estado programado correctamente.',
            programacion: {
                id,
                hora,
                cantidadLineas: idsLineas.length
            }
        });
    } catch (error) {
        programaciones.delete(id);
        cancelarTrabajoProgramado(id);
        eliminarArchivoSeguro(rutaImagen);
        guardarProgramaciones();

        res.status(500).json({
            error: error.message || 'No se pudo programar el estado.'
        });
    }
});

app.put('/programaciones/:id', upload.single('imagen'), (req, res) => {
    const id = req.params.id;
    const programacion = programaciones.get(id);
    const rutaTemporalFoto = req.file?.path;

    if (!programacion) {
        eliminarArchivoSeguro(rutaTemporalFoto);
        return res.status(404).json({ error: 'La programación no existe.' });
    }

    if (['en_cola', 'ejecutando'].includes(programacion.estado)) {
        eliminarArchivoSeguro(rutaTemporalFoto);
        return res.status(409).json({
            error: 'No se puede editar mientras la programación se está ejecutando.'
        });
    }

    if (req.file) {
        const validacionImagen = validarImagenSubida(req.file);
        if (validacionImagen.error) {
            eliminarArchivoSeguro(rutaTemporalFoto);
            return res.status(400).json({ error: validacionImagen.error });
        }
    }

    const hora = String(req.body.hora || programacion.hora).trim();
    let diasSemana = programacion.diasSemana;

    if (req.body.diasSemana !== undefined) {
        try {
            diasSemana = normalizarDiasSemana(JSON.parse(req.body.diasSemana));
        } catch {
            eliminarArchivoSeguro(rutaTemporalFoto);
            return res.status(400).json({ error: 'Los días seleccionados no son válidos.' });
        }
    }

    const activa = req.body.activa === undefined
        ? programacion.activa !== false
        : String(req.body.activa) !== 'false';

    if (!horaValida(hora)) {
        eliminarArchivoSeguro(rutaTemporalFoto);
        return res.status(400).json({ error: 'Seleccioná una hora válida.' });
    }

    let nuevaRutaImagen = programacion.rutaImagen;
    let nuevoNombreArchivo = programacion.nombreArchivo;

    if (req.file) {
        const extension = detectarTipoImagen(rutaTemporalFoto)?.extension ||
            obtenerExtensionImagen(req.file.originalname);
        nuevaRutaImagen = path.join(
            CARPETA_IMAGENES_PROGRAMADAS,
            `${id}-${Date.now()}${extension}`
        );
        nuevoNombreArchivo = req.file.originalname;
        moverArchivo(rutaTemporalFoto, nuevaRutaImagen);
    }

    const rutaImagenAnterior = programacion.rutaImagen;
    const horaAnterior = programacion.hora;
    const diasAnteriores = [...normalizarDiasSemana(programacion.diasSemana)];
    const activaAnterior = programacion.activa !== false;

    try {
        programacion.hora = hora;
        programacion.diasSemana = diasSemana;
        programacion.activa = activa;
        programacion.texto = req.body.texto !== undefined
            ? String(req.body.texto)
            : programacion.texto;
        programacion.rutaImagen = nuevaRutaImagen;
        programacion.nombreArchivo = nuevoNombreArchivo;
        programacion.estado = activa ? 'programado' : 'pausado';
        programacion.mensaje = activa
            ? 'Programación actualizada. Esperando la próxima ejecución.'
            : 'Programación pausada.';
        programacion.actualizadoEn = new Date().toISOString();

        if (
            horaAnterior !== hora ||
            JSON.stringify(diasAnteriores) !== JSON.stringify(diasSemana) ||
            activaAnterior !== activa
        ) {
            programarTrabajo(programacion);
        }

        guardarProgramaciones();

        if (req.file && rutaImagenAnterior !== nuevaRutaImagen) {
            eliminarArchivoSeguro(rutaImagenAnterior);
        }

        res.json({
            mensaje: 'Programación actualizada correctamente.'
        });
    } catch (error) {
        if (req.file && nuevaRutaImagen !== rutaImagenAnterior) {
            eliminarArchivoSeguro(nuevaRutaImagen);
        }

        programacion.rutaImagen = rutaImagenAnterior;
        programacion.hora = horaAnterior;
        programacion.diasSemana = diasAnteriores;
        programacion.activa = activaAnterior;
        programarTrabajo(programacion);

        res.status(500).json({
            error: error.message || 'No se pudo actualizar la programación.'
        });
    }
});

app.get('/programaciones', (req, res) => {
    const resultado = Array.from(programaciones.values())
        .map(item => ({
            id: item.id,
            hora: item.hora,
            diasSemana: normalizarDiasSemana(item.diasSemana),
            activa: item.activa !== false,
            texto: item.texto,
            cantidadLineas: item.idsLineas.length,
            nombresLineas: item.idsLineas.map(id =>
                lineas.get(id)?.nombre || 'Línea eliminada'
            ),
            lineasPorGrupo: item.lineasPorGrupo,
            intervaloMinutos: item.intervaloMinutos,
            nombreArchivo: item.nombreArchivo,
            estado: item.estado,
            mensaje: item.mensaje,
            creadoEn: item.creadoEn,
            actualizadoEn: item.actualizadoEn,
            ultimaEjecucion: item.ultimaEjecucion,
            ultimoResultado: item.ultimoResultado,
            proximaEjecucion: proximaEjecucionISO(item.id)
        }))
        .sort((a, b) => a.hora.localeCompare(b.hora));

    res.json({ programaciones: resultado });
});


app.patch('/programaciones/:id/estado', (req, res) => {
    const programacion = programaciones.get(req.params.id);

    if (!programacion) {
        return res.status(404).json({ error: 'La programación no existe.' });
    }

    if (['en_cola', 'ejecutando'].includes(programacion.estado)) {
        return res.status(409).json({
            error: 'No se puede pausar mientras la programación se está ejecutando.'
        });
    }

    programacion.activa = Boolean(req.body.activa);
    programacion.estado = programacion.activa ? 'programado' : 'pausado';
    programacion.mensaje = programacion.activa
        ? 'Programación reanudada.'
        : 'Programación pausada.';
    programacion.actualizadoEn = new Date().toISOString();
    programarTrabajo(programacion);
    guardarProgramaciones();

    res.json({
        mensaje: programacion.mensaje,
        activa: programacion.activa
    });
});

app.post('/programaciones/:id/ejecutar', (req, res) => {
    const programacion = programaciones.get(req.params.id);

    if (!programacion) {
        return res.status(404).json({ error: 'La programación no existe.' });
    }

    if (progresoPublicacion.activo || publicacionesPendientes > 0) {
        return res.status(409).json({
            error: 'Ya existe una publicación en curso o en espera.'
        });
    }

    const estabaActiva = programacion.activa !== false;
    programacion.activa = true;
    res.status(202).json({ mensaje: 'La programación fue enviada a la cola.' });

    ejecutarProgramacion(programacion.id)
        .catch(error => console.error('No se pudo ejecutar la programación:', error))
        .finally(() => {
            programacion.activa = estabaActiva;
            programacion.estado = estabaActiva ? 'programado' : 'pausado';
            if (!estabaActiva) cancelarTrabajoProgramado(programacion.id);
            guardarProgramaciones();
        });
});

app.post('/programaciones/:id/duplicar', (req, res) => {
    const original = programaciones.get(req.params.id);

    if (!original) {
        return res.status(404).json({ error: 'La programación no existe.' });
    }

    if (!fs.existsSync(original.rutaImagen)) {
        return res.status(409).json({ error: 'La imagen original ya no existe.' });
    }

    const id = crypto.randomUUID();
    const extension = path.extname(original.rutaImagen) || '.jpg';
    const rutaImagen = path.join(CARPETA_IMAGENES_PROGRAMADAS, `${id}${extension}`);
    fs.copyFileSync(original.rutaImagen, rutaImagen);

    const copia = {
        ...original,
        id,
        rutaImagen,
        activa: false,
        estado: 'pausado',
        mensaje: 'Copia creada en pausa. Editala y activala cuando quieras.',
        creadoEn: new Date().toISOString(),
        actualizadoEn: new Date().toISOString(),
        ultimaEjecucion: null,
        ultimoResultado: null
    };

    programaciones.set(id, copia);
    guardarProgramaciones();

    res.status(201).json({
        mensaje: 'Programación duplicada en pausa.',
        id
    });
});

app.get('/programaciones/:id/imagen', (req, res) => {
    const programacion = programaciones.get(req.params.id);

    if (!programacion || !fs.existsSync(programacion.rutaImagen)) {
        return res.status(404).send('Imagen no encontrada.');
    }

    res.sendFile(path.resolve(programacion.rutaImagen));
});

app.delete('/programaciones/:id', (req, res) => {
    const id = req.params.id;
    const programacion = programaciones.get(id);

    if (!programacion) {
        return res.status(404).json({ error: 'La programación no existe.' });
    }

    if (['en_cola', 'ejecutando'].includes(programacion.estado)) {
        return res.status(409).json({
            error: 'La programación está en ejecución y no se puede eliminar.'
        });
    }

    cancelarTrabajoProgramado(id);
    eliminarArchivoSeguro(programacion.rutaImagen);
    programaciones.delete(id);
    guardarProgramaciones();

    res.json({ mensaje: 'Programación eliminada correctamente.' });
});



app.get('/resumen', (req, res) => {
    const ahora = new Date();
    const inicioHoy = new Date(
        ahora.getFullYear(),
        ahora.getMonth(),
        ahora.getDate()
    ).getTime();

    const historialHoy = historialPublicaciones.filter(item => {
        const fecha = new Date(item.fechaInicio).getTime();
        return Number.isFinite(fecha) && fecha >= inicioHoy;
    });

    const correctasHoy = historialHoy.reduce(
        (total, item) => total + (Number(item.correctas) || 0),
        0
    );
    const procesadasHoy = historialHoy.reduce(
        (total, item) => total + (Number(item.correctas) || 0) + (Number(item.fallidas) || 0),
        0
    );

    const proximas = Array.from(programaciones.values())
        .filter(item => item.activa !== false)
        .map(item => ({
            id: item.id,
            hora: item.hora,
            proximaEjecucion: proximaEjecucionISO(item.id)
        }))
        .filter(item => item.proximaEjecucion)
        .sort((a, b) => new Date(a.proximaEjecucion) - new Date(b.proximaEjecucion));

    res.json({
        lineas: {
            total: lineas.size,
            conectadas: Array.from(lineas.values()).filter(linea => linea.estado === 'conectado').length,
            conProblemas: Array.from(lineas.values()).filter(linea => linea.estado !== 'conectado').length
        },
        publicacionesHoy: historialHoy.length,
        correctasHoy,
        fallidasHoy: Math.max(0, procesadasHoy - correctasHoy),
        porcentajeExitoHoy: procesadasHoy
            ? Math.round((correctasHoy / procesadasHoy) * 100)
            : 0,
        proximaProgramacion: proximas[0] || null,
        publicacionActiva: progresoPublicacion.activo,
        progreso: progresoPublicacion
    });
});

app.get('/historial', (req, res) => {
    const limite = Math.min(200, Math.max(1, Number(req.query.limite) || 100));
    res.json({
        historial: historialPublicaciones.slice(0, limite).map(item => ({
            ...item,
            rutaImagen: undefined
        }))
    });
});

app.get('/historial/:id/imagen', (req, res) => {
    const registro = historialPublicaciones.find(item => item.id === req.params.id);

    if (!registro || !fs.existsSync(registro.rutaImagen)) {
        return res.status(404).send('Imagen no encontrada.');
    }

    res.type(registro.mimeImagen || 'image/jpeg');
    res.sendFile(path.resolve(registro.rutaImagen));
});

app.get('/estados-activos', (req, res) => {
    res.json(obtenerVistaEstadosActivos());
});

app.delete('/estados-activos/:id', (req, res) => {
    podarEstadosActivos(true);

    if (progresoEliminacionEstados.activo) {
        return res.status(409).json({
            error: 'Ya hay una eliminación de estados en curso.',
            progreso: progresoEliminacionEstados
        });
    }

    const grupo = estadosActivos.get(req.params.id);
    if (!grupo) {
        return res.status(404).json({
            error: 'La publicación ya no tiene estados activos guardados.'
        });
    }

    const pendientes = grupo.lineas.filter(linea =>
        linea.estado !== 'solicitud_enviada' &&
        obtenerMilisegundosFecha(linea.expiraEn, 0) > Date.now()
    );

    if (!pendientes.length) {
        return res.status(409).json({
            error: 'Esta publicación no tiene solicitudes pendientes.'
        });
    }

    const tarea = ejecutarEliminacionEstados(grupo.id);

    res.status(202).json({
        mensaje: `Se inició la solicitud de eliminación para ${pendientes.length} estado(s).`,
        progreso: progresoEliminacionEstados
    });

    tarea.catch(error => {
        progresoEliminacionEstados.activo = false;
        progresoEliminacionEstados.estado = 'error';
        progresoEliminacionEstados.mensaje =
            error.message || 'La eliminación se interrumpió.';
        console.error('Falló la eliminación de estados activos:', error);
    });
});

app.post('/historial/:id/reintentar-fallidas', (req, res) => {
    const registro = historialPublicaciones.find(item => item.id === req.params.id);

    if (!registro) {
        return res.status(404).json({ error: 'El registro no existe.' });
    }

    const idsLineas = [...new Set(
        (registro.lineasFallidas || []).map(linea => linea.id).filter(Boolean)
    )];

    if (!idsLineas.length) {
        return res.status(409).json({ error: 'Este registro no tiene líneas fallidas.' });
    }

    if (!fs.existsSync(registro.rutaImagen)) {
        return res.status(409).json({ error: 'La imagen del historial ya no existe.' });
    }

    if (progresoPublicacion.activo || publicacionesPendientes > 0) {
        return res.status(409).json({
            error: 'Ya existe una publicación en curso o en espera.'
        });
    }

    res.status(202).json({
        mensaje: `Reintento iniciado para ${idsLineas.length} línea(s).`
    });

    encolarPublicacion({
        idsLineas,
        rutaImagen: registro.rutaImagen,
        texto: registro.texto,
        lineasPorGrupo: Math.min(registro.lineasPorGrupo || 10, idsLineas.length),
        intervaloMinutos: registro.intervaloMinutos || 0,
        origen: `reintento del historial ${registro.id}`
    }).catch(error => {
        console.error('Falló el reintento del historial:', error);
    });
});

app.get('/configuracion', (req, res) => {
    res.json(configuracion);
});

app.put('/configuracion', (req, res) => {
    const umbral = Number(req.body.umbralFallosSeguridad);
    const lineasPorGrupo = Number(req.body.lineasPorGrupoPredeterminado);
    const intervalo = Number(req.body.intervaloMinutosPredeterminado);

    if (!Number.isFinite(umbral) || umbral < 0.1 || umbral > 1) {
        return res.status(400).json({
            error: 'El corte de seguridad debe estar entre 10% y 100%.'
        });
    }

    if (!Number.isInteger(lineasPorGrupo) || lineasPorGrupo < 1 || lineasPorGrupo > 50) {
        return res.status(400).json({
            error: 'Las líneas por grupo deben estar entre 1 y 50.'
        });
    }

    if (!Number.isFinite(intervalo) || intervalo < 0 || intervalo > 1440) {
        return res.status(400).json({
            error: 'El intervalo debe estar entre 0 y 1440 minutos.'
        });
    }

    configuracion = {
        umbralFallosSeguridad: umbral,
        notificaciones: req.body.notificaciones !== false,
        lineasPorGrupoPredeterminado: lineasPorGrupo,
        intervaloMinutosPredeterminado: intervalo
    };
    guardarConfiguracion();

    res.json({ mensaje: 'Configuración guardada.', configuracion });
});

app.post('/lineas/reconectar-todas', (req, res) => {
    let cantidad = 0;

    for (const linea of lineas.values()) {
        if (linea.estado === 'conectado' || linea.eliminando || linea.reconexionManualEnCurso) {
            continue;
        }

        linea.reconexionManualEnCurso = true;
        linea.estado = 'reconectando';
        cantidad += 1;

        setTimeout(() => {
            const actual = lineas.get(linea.id);
            if (!actual || actual.eliminando) return;
            actual.reconexionManualEnCurso = false;
            iniciarWhatsApp(actual.id);
        }, 250);
    }

    res.status(202).json({
        mensaje: cantidad
            ? `Reconexión iniciada para ${cantidad} línea(s).`
            : 'No hay líneas pendientes de reconexión.'
    });
});

app.patch('/lineas/:id/etiqueta', (req, res) => {
    const id = req.params.id;
    const linea = lineas.get(id);

    if (!linea) {
        return res.status(404).json({ error: 'La línea no existe.' });
    }

    const etiqueta = normalizarEtiqueta(req.body.etiqueta);

    if (!ETIQUETAS_LINEA.has(String(req.body.etiqueta || '').toLowerCase())) {
        return res.status(400).json({
            error: 'La etiqueta debe ser activa, indefinida, caida o reposo.'
        });
    }

    linea.etiqueta = etiqueta;
    guardarLineas();

    res.json({
        mensaje: `Etiqueta de ${linea.nombre} actualizada.`,
        etiqueta
    });
});

app.post('/lineas/:id/reconectar', (req, res) => {
    const id = req.params.id;
    const linea = lineas.get(id);

    if (!linea) {
        return res.status(404).json({ error: 'La línea no existe.' });
    }

    if (linea.eliminando) {
        return res.status(409).json({
            error: 'La línea se está eliminando y no se puede reconectar.'
        });
    }

    if (linea.reconexionManualEnCurso) {
        return res.status(409).json({
            error: 'La reconexión de esta línea ya está en proceso.'
        });
    }

    linea.reconexionManualEnCurso = true;

    if (linea.temporizadorReconexion) {
        clearTimeout(linea.temporizadorReconexion);
        linea.temporizadorReconexion = null;
    }

    cancelarReintentoAudiencia(linea);

    const socketAnterior = linea.socket;

    // Desvinculamos el socket anterior sin cerrar la sesión de WhatsApp.
    // No usamos logout(), porque eso borraría la vinculación guardada.
    linea.socket = null;
    linea.jid = null;
    linea.qr = null;
    linea.iniciando = false;
    linea.estado = 'reconectando';

    try {
        if (socketAnterior && typeof socketAnterior.end === 'function') {
            socketAnterior.end(new Error('Reconexión manual solicitada'));
        }
    } catch (error) {
        console.log(
            `No se pudo cerrar el socket anterior de ${linea.nombre}:`,
            error.message
        );
    }

    setTimeout(() => {
        const lineaActual = lineas.get(id);

        if (!lineaActual || lineaActual.eliminando) return;

        lineaActual.reconexionManualEnCurso = false;
        iniciarWhatsApp(id);
    }, 500);

    res.status(202).json({
        mensaje: `Reconectando la línea ${linea.nombre}.`
    });
});

app.delete('/lineas/:id', async (req, res) => {
    const id = req.params.id;
    const linea = lineas.get(id);

    if (!linea) {
        return res.status(404).json({ error: 'La línea no existe.' });
    }

    const carpetaSesion = resolverCarpetaSesionSegura(id);
    if (!carpetaSesion) {
        return res.status(400).json({
            error: 'El identificador guardado de la línea no es válido.'
        });
    }

    linea.eliminando = true;

    if (linea.temporizadorReconexion) {
        clearTimeout(linea.temporizadorReconexion);
        linea.temporizadorReconexion = null;
    }

    cancelarReintentoAudiencia(linea);

    try {
        if (linea.socket) await linea.socket.logout();
    } catch (error) {
        console.log(`No se pudo cerrar la sesión de ${linea.nombre}:`, error.message);
    }

    linea.socket = null;
    lineas.delete(id);
    guardarLineas();

    try {
        fs.rmSync(carpetaSesion, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 300
        });
    } catch (error) {
        console.error('No se pudo borrar la carpeta:', error);
    }

    res.json({ mensaje: `La línea ${linea.nombre} fue eliminada.` });
});

app.listen(3000, '127.0.0.1', () => {
    console.log('AutoStatues funcionando en http://127.0.0.1:3000');

    cargarConfiguracion();
    cargarEstadosActivos();
    cargarHistorial();
    cargarLineasGuardadas();

    for (const linea of lineas.values()) {
        iniciarWhatsApp(linea.id);
    }

    cargarProgramaciones();
});
