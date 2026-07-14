const {
    default: makeWASocket,
    useMultiFileAuthState,
    Browsers,
    jidNormalizedUser,
    WAMessageStatus,
    DisconnectReason
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
const puertoConfigurado = Number(process.env.AUTOSTATUES_PORT);
const PUERTO_SERVIDOR = Number.isInteger(puertoConfigurado) &&
    puertoConfigurado >= 1 &&
    puertoConfigurado <= 65535
    ? puertoConfigurado
    : 3000;
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
const ARCHIVO_PROTECCION_PUBLICACION = path.join(
    CARPETA_DATOS,
    'proteccion-publicacion.json'
);
const ARCHIVO_IDEMPOTENCIA_PUBLICACION = path.join(
    CARPETA_DATOS,
    'idempotencia-publicacion.json'
);

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
const NOMBRE_ARCHIVO_ACTIVIDAD_CONTACTOS = 'actividad-contactos.json';

let colaPublicaciones = Promise.resolve();
let publicacionesPendientes = 0;
let generacionColaPublicaciones = 0;
const trabajosPendientesPublicacion = new Set();
let progresoPublicacion = crearProgresoVacio();
const estadosActivos = new Map();
let progresoEliminacionEstados = crearProgresoEliminacionEstadosVacio();

const ETIQUETAS_LINEA = new Set(['activa', 'indefinida', 'caida', 'reposo']);
const DIAS_SEMANA_VALIDOS = new Set([0, 1, 2, 3, 4, 5, 6]);
const MAXIMO_HISTORIAL = 500;
const DURACION_ESTADO_MS = 24 * 60 * 60 * 1000;
const MINIMO_DESTINATARIOS_ESTADO = 1;
const MAXIMO_DESTINATARIOS_ESTADO = 1000;
const LINEAS_POR_LOTE_ELIMINACION = 3;
const MAXIMOS_INTENTOS_AUDIENCIA = 3;
const MAXIMOS_INTENTOS_RECONEXION = 5;
const RETRASOS_RECONEXION_MS = [3000, 8000, 15000, 30000, 60000];
const TIEMPO_MAXIMO_INTENTO_CONEXION_MS = 45000;
const VENTANA_ESTABILIDAD_CONEXION_MS = 60000;
const TIEMPO_ESPERA_SINCRONIZACION_AUDIENCIA_MS = 60 * 1000;
const TIEMPO_MAXIMO_AUDIENCIA_MS = 75 * 1000;
const TIEMPO_MAXIMO_ENVIO_MS = 90000;
const ENFRIAMIENTO_DESCONEXION_MS = 5 * 60 * 1000;
const ENFRIAMIENTO_LIMITE_TEMPORAL_MS = 30 * 60 * 1000;
const ENFRIAMIENTO_ENVIO_INCIERTO_MS = 10 * 60 * 1000;
const ENFRIAMIENTO_LIMITE_MINIMO_MS = 60 * 1000;
const ENFRIAMIENTO_LIMITE_MAXIMO_MS = 24 * 60 * 60 * 1000;
const DURACION_IDEMPOTENCIA_MS = 24 * 60 * 60 * 1000;
const MAXIMAS_CLAVES_IDEMPOTENCIA = 1000;
const MAXIMOS_REGISTROS_ACTIVIDAD_CONTACTOS = 50000;
const DEMORA_GUARDADO_ACTIVIDAD_CONTACTOS_MS = 3000;
const TIEMPO_ESPERA_COLA_ACTIVIDAD_CONTACTOS_MS = 10000;
const MARGEN_TIMESTAMP_FUTURO_MS = 5 * 60 * 1000;
const MODOS_RITMO_PUBLICACION = new Set(['secuencial', 'grupos']);
const EXPRESION_ID_LINEA = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODIGOS_DESCONEXION_FATAL = new Set([
    DisconnectReason.loggedOut,
    DisconnectReason.forbidden,
    DisconnectReason.multideviceMismatch,
    DisconnectReason.badSession,
    DisconnectReason.connectionReplaced
].filter(Number.isFinite));
const CODIGOS_ERROR_CONEXION = new Set([
    DisconnectReason.loggedOut,
    DisconnectReason.connectionClosed,
    DisconnectReason.connectionLost,
    DisconnectReason.connectionReplaced,
    DisconnectReason.timedOut,
    DisconnectReason.forbidden,
    DisconnectReason.badSession,
    DisconnectReason.multideviceMismatch,
    DisconnectReason.restartRequired,
    DisconnectReason.unavailableService
].filter(Number.isFinite));
const MODOS_PRIVACIDAD_ESTADOS = Object.freeze({
    SOLO_COMPARTIR_CON: 0,
    EXCLUIR_CONTACTOS: 1,
    TODOS_LOS_CONTACTOS: 2,
    AMIGOS_CERCANOS: 3
});

let configuracion = {
    limiteFallosSeguridad: 1,
    notificaciones: true,
    modoRitmoPredeterminado: 'secuencial',
    intervaloSegundosPredeterminado: 45,
    variacionSegundosPredeterminada: 5,
    lineasPorGrupoPredeterminado: 10,
    intervaloMinutosPredeterminado: 5,
    maximoDestinatariosPorEstado: MAXIMO_DESTINATARIOS_ESTADO
};

let proteccionMiddlewarePublicacion = crearProteccionMiddlewareVacia();
const solicitudesIdempotentes = new Map();

let controlSeguridadPublicacion = crearControlSeguridadPublicacion();

function crearProgresoVacio() {
    return {
        activo: false,
        estado: 'inactivo',
        origen: null,
        total: 0,
        procesadas: 0,
        correctas: 0,
        fallidas: 0,
        noProcesadas: 0,
        grupoActual: 0,
        totalGrupos: 0,
        proximoGrupoSegundos: 0,
        proximaLineaSegundos: 0,
        sincronizacionAudienciaSegundos: 0,
        modoRitmo: null,
        maximoDestinatariosPorEstado: null,
        lineaActual: null,
        lineasCorrectas: [],
        lineasFallidas: [],
        seguridadActiva: false,
        fallosGrupoActual: 0,
        totalGrupoActual: 0,
        limiteFallosSeguridad: 1,
        tipoErrorCorte: null,
        codigoErrorCorte: null,
        lineaCorte: null,
        mensajeErrorCorte: null,
        mensajeSeguridad: '',
        altoTotalSolicitado: false,
        altoTotalSolicitadoEn: null,
        envioEnCurso: false,
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

function guardarJSONAtomico(ruta, datos, espacios = 2) {
    const temporal = `${ruta}.tmp`;
    fs.writeFileSync(
        temporal,
        JSON.stringify(datos, null, espacios),
        'utf8'
    );

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

function limitarNumero(valor, respaldo, minimo, maximo, entero = false) {
    const numero = Number(valor);
    if (!Number.isFinite(numero)) return respaldo;

    const limitado = Math.min(maximo, Math.max(minimo, numero));
    return entero ? Math.round(limitado) : limitado;
}

function normalizarModoRitmo(valor, respaldo = 'secuencial') {
    return MODOS_RITMO_PUBLICACION.has(valor) ? valor : respaldo;
}

function normalizarLimiteDestinatariosEstado(
    valor,
    respaldo = MAXIMO_DESTINATARIOS_ESTADO
) {
    return limitarNumero(
        valor,
        respaldo,
        MINIMO_DESTINATARIOS_ESTADO,
        MAXIMO_DESTINATARIOS_ESTADO,
        true
    );
}

function cargarConfiguracion() {
    if (!fs.existsSync(ARCHIVO_CONFIGURACION)) return;

    try {
        const datos = JSON.parse(fs.readFileSync(ARCHIVO_CONFIGURACION, 'utf8'));
        configuracion = {
            ...configuracion,
            ...datos,
            limiteFallosSeguridad: limitarNumero(
                datos.limiteFallosSeguridad,
                1,
                1,
                10,
                true
            ),
            notificaciones: datos.notificaciones !== false,
            modoRitmoPredeterminado: normalizarModoRitmo(
                datos.modoRitmoPredeterminado,
                'secuencial'
            ),
            intervaloSegundosPredeterminado: limitarNumero(
                datos.intervaloSegundosPredeterminado,
                45,
                10,
                3600,
                true
            ),
            variacionSegundosPredeterminada: limitarNumero(
                datos.variacionSegundosPredeterminada,
                5,
                0,
                30,
                true
            ),
            lineasPorGrupoPredeterminado: limitarNumero(
                datos.lineasPorGrupoPredeterminado,
                10,
                1,
                10,
                true
            ),
            intervaloMinutosPredeterminado: limitarNumero(
                datos.intervaloMinutosPredeterminado,
                5,
                0,
                1440
            ),
            maximoDestinatariosPorEstado: normalizarLimiteDestinatariosEstado(
                datos.maximoDestinatariosPorEstado
            )
        };
        configuracion.variacionSegundosPredeterminada = Math.min(
            configuracion.intervaloSegundosPredeterminado,
            configuracion.variacionSegundosPredeterminada
        );
        delete configuracion.umbralFallosSeguridad;
    } catch (error) {
        console.error('No se pudo cargar la configuración:', error.message);
    }
}

function guardarConfiguracion() {
    guardarJSONAtomico(ARCHIVO_CONFIGURACION, configuracion);
}

function crearProteccionMiddlewareVacia() {
    return {
        activa: false,
        tipo: null,
        motivo: null,
        codigo: null,
        activadaEn: null,
        bloqueadaHasta: null,
        linea: null
    };
}

function guardarProteccionMiddleware() {
    try {
        guardarJSONAtomico(
            ARCHIVO_PROTECCION_PUBLICACION,
            proteccionMiddlewarePublicacion
        );
    } catch (error) {
        console.error(
            'No se pudo guardar el estado del middleware de seguridad:',
            error.message
        );
    }
}

function cargarProteccionMiddleware() {
    if (!fs.existsSync(ARCHIVO_PROTECCION_PUBLICACION)) return;

    try {
        const datos = JSON.parse(
            fs.readFileSync(ARCHIVO_PROTECCION_PUBLICACION, 'utf8')
        );
        const bloqueadaHastaMs = Date.parse(datos?.bloqueadaHasta || '');

        if (!Number.isFinite(bloqueadaHastaMs) || bloqueadaHastaMs <= Date.now()) {
            proteccionMiddlewarePublicacion = crearProteccionMiddlewareVacia();
            guardarProteccionMiddleware();
            return;
        }

        proteccionMiddlewarePublicacion = {
            activa: true,
            tipo: String(datos.tipo || 'seguridad'),
            motivo: String(
                datos.motivo ||
                'La publicación está temporalmente bloqueada por seguridad.'
            ),
            codigo: datos.codigo ? String(datos.codigo) : null,
            activadaEn: Number.isFinite(Date.parse(datos.activadaEn || ''))
                ? new Date(datos.activadaEn).toISOString()
                : new Date().toISOString(),
            bloqueadaHasta: new Date(bloqueadaHastaMs).toISOString(),
            linea: datos.linea && typeof datos.linea === 'object'
                ? {
                    id: datos.linea.id || null,
                    nombre: String(datos.linea.nombre || 'Línea sin nombre')
                }
                : null
        };
    } catch (error) {
        proteccionMiddlewarePublicacion = crearProteccionMiddlewareVacia();
        guardarProteccionMiddleware();
        console.error(
            'No se pudo cargar el middleware de seguridad:',
            error.message
        );
    }
}

function obtenerVistaProteccionMiddleware() {
    const bloqueadaHastaMs = Date.parse(
        proteccionMiddlewarePublicacion.bloqueadaHasta || ''
    );

    if (
        !proteccionMiddlewarePublicacion.activa ||
        !Number.isFinite(bloqueadaHastaMs) ||
        bloqueadaHastaMs <= Date.now()
    ) {
        if (proteccionMiddlewarePublicacion.activa) {
            proteccionMiddlewarePublicacion = crearProteccionMiddlewareVacia();
            guardarProteccionMiddleware();
        }

        return {
            ...crearProteccionMiddlewareVacia(),
            segundosRestantes: 0
        };
    }

    return {
        ...proteccionMiddlewarePublicacion,
        segundosRestantes: Math.max(
            1,
            Math.ceil((bloqueadaHastaMs - Date.now()) / 1000)
        )
    };
}

function activarProteccionMiddleware({
    tipo,
    motivo,
    codigo,
    linea,
    duracionMs
}) {
    const ahora = Date.now();
    const hastaPropuesto = ahora + Math.max(1000, Number(duracionMs) || 0);
    const hastaActual = Date.parse(
        proteccionMiddlewarePublicacion.bloqueadaHasta || ''
    );
    const bloqueadaHastaMs = Number.isFinite(hastaActual)
        ? Math.max(hastaActual, hastaPropuesto)
        : hastaPropuesto;

    proteccionMiddlewarePublicacion = {
        activa: true,
        tipo: String(tipo || 'seguridad'),
        motivo: String(
            motivo || 'La publicación fue pausada temporalmente por seguridad.'
        ),
        codigo: codigo ? String(codigo) : null,
        activadaEn: new Date(ahora).toISOString(),
        bloqueadaHasta: new Date(bloqueadaHastaMs).toISOString(),
        linea: linea
            ? {
                id: linea.id || null,
                nombre: String(linea.nombre || 'Línea sin nombre')
            }
            : null
    };
    guardarProteccionMiddleware();
    return obtenerVistaProteccionMiddleware();
}

function activarProteccionMiddlewarePorError(error) {
    let tipo = null;
    let duracionMs = 0;

    if (
        error?.codigo === 'DETENIDA_DESCONEXION' &&
        error?.envioIncierto === true
    ) {
        tipo = 'envio_incierto';
        duracionMs = ENFRIAMIENTO_ENVIO_INCIERTO_MS;
    } else if (error?.codigo === 'DETENIDA_LIMITE_TEMPORAL') {
        tipo = 'limite_temporal';
        duracionMs = Number(error.duracionEnfriamientoMs) ||
            ENFRIAMIENTO_LIMITE_TEMPORAL_MS;
    } else if (error?.codigo === 'DETENIDA_ENVIO_INCIERTO') {
        tipo = 'envio_incierto';
        duracionMs = ENFRIAMIENTO_ENVIO_INCIERTO_MS;
    } else if (
        error?.codigo === 'DETENIDA_DESCONEXION' &&
        error?.preflight !== true
    ) {
        tipo = 'desconexion';
        duracionMs = ENFRIAMIENTO_DESCONEXION_MS;
    }

    if (!tipo) return null;

    return activarProteccionMiddleware({
        tipo,
        duracionMs,
        motivo: error.message,
        codigo: progresoPublicacion.codigoErrorCorte || error.codigo,
        linea: progresoPublicacion.lineaCorte
    });
}

function crearErrorMiddleware(codigo, mensaje, statusCode, datos = {}) {
    const error = new Error(mensaje);
    error.codigo = codigo;
    error.statusCode = statusCode;
    Object.assign(error, datos);
    return error;
}

function verificarMiddlewarePublicacion({ comprobarOcupacion = true } = {}) {
    const proteccion = obtenerVistaProteccionMiddleware();

    if (proteccion.activa) {
        throw crearErrorMiddleware(
            'MIDDLEWARE_ENFRIAMIENTO',
            `Protección temporal activa: ${proteccion.motivo} ` +
                `Podrás volver a publicar en ${proteccion.segundosRestantes} segundos.`,
            429,
            { proteccionMiddleware: proteccion }
        );
    }

    if (
        comprobarOcupacion &&
        (progresoPublicacion.activo || publicacionesPendientes > 0)
    ) {
        throw crearErrorMiddleware(
            'PUBLICACION_OCUPADA',
            'Ya existe una publicación en curso o en espera.',
            409
        );
    }

    return proteccion;
}

function middlewareSeguridadPublicacion(req, res, next) {
    try {
        req.proteccionMiddleware = verificarMiddlewarePublicacion();
        next();
    } catch (error) {
        eliminarArchivoSeguro(req.file?.path);

        if (error.codigo === 'MIDDLEWARE_ENFRIAMIENTO') {
            res.set(
                'Retry-After',
                String(error.proteccionMiddleware?.segundosRestantes || 1)
            );
        }

        res.status(error.statusCode || 409).json({
            error: error.message,
            codigo: error.codigo || 'MIDDLEWARE_SEGURIDAD',
            proteccionMiddleware: error.proteccionMiddleware ||
                obtenerVistaProteccionMiddleware()
        });
    }
}

function guardarClavesIdempotencia() {
    try {
        guardarJSONAtomico(ARCHIVO_IDEMPOTENCIA_PUBLICACION, {
            version: 1,
            solicitudes: Array.from(solicitudesIdempotentes, ([clave, registradaEn]) => ({
                clave,
                registradaEn
            }))
        });
    } catch (error) {
        console.error(
            'No se pudieron guardar las claves de idempotencia:',
            error.message
        );
    }
}

function cargarClavesIdempotencia() {
    if (!fs.existsSync(ARCHIVO_IDEMPOTENCIA_PUBLICACION)) return;

    try {
        const datos = JSON.parse(
            fs.readFileSync(ARCHIVO_IDEMPOTENCIA_PUBLICACION, 'utf8')
        );
        const solicitudes = Array.isArray(datos?.solicitudes)
            ? datos.solicitudes
            : [];

        solicitudesIdempotentes.clear();
        solicitudes.sort(
            (a, b) => Number(a?.registradaEn) - Number(b?.registradaEn)
        );
        for (const item of solicitudes) {
            const clave = String(item?.clave || '').trim();
            const registradaEn = Number(item?.registradaEn);
            if (!clave || clave.length > 220 || !Number.isFinite(registradaEn)) continue;
            solicitudesIdempotentes.set(clave, registradaEn);
        }

        limpiarClavesIdempotencia({ persistir: false });
    } catch (error) {
        solicitudesIdempotentes.clear();
        guardarClavesIdempotencia();
        console.error(
            'No se pudieron cargar las claves de idempotencia:',
            error.message
        );
    }
}

function limpiarClavesIdempotencia({ persistir = true } = {}) {
    const limiteAntiguedad = Date.now() - DURACION_IDEMPOTENCIA_MS;
    let huboCambios = false;

    for (const [clave, registradaEn] of solicitudesIdempotentes) {
        if (registradaEn < limiteAntiguedad) {
            solicitudesIdempotentes.delete(clave);
            huboCambios = true;
        }
    }

    while (solicitudesIdempotentes.size >= MAXIMAS_CLAVES_IDEMPOTENCIA) {
        const primeraClave = solicitudesIdempotentes.keys().next().value;
        if (!primeraClave) break;
        solicitudesIdempotentes.delete(primeraClave);
        huboCambios = true;
    }

    if (huboCambios && persistir) guardarClavesIdempotencia();
}

function middlewareIdempotencia(ambito) {
    return (req, res, next) => {
        limpiarClavesIdempotencia();

        const claveRecibida = String(req.get('Idempotency-Key') || '').trim();
        if (!claveRecibida) {
            return res.status(400).json({
                error: 'Falta la clave de seguridad de la solicitud. Recargá la aplicación e intentá nuevamente.',
                codigo: 'CLAVE_IDEMPOTENCIA_REQUERIDA'
            });
        }

        if (!/^[A-Za-z0-9._:-]{8,128}$/.test(claveRecibida)) {
            return res.status(400).json({
                error: 'La clave de seguridad de la solicitud no es válida.',
                codigo: 'CLAVE_IDEMPOTENCIA_INVALIDA'
            });
        }

        const claveCompleta = `${ambito}:${claveRecibida}`;
        if (solicitudesIdempotentes.has(claveCompleta)) {
            return res.status(409).json({
                error: 'Esta misma solicitud ya fue recibida. No se volverá a ejecutar.',
                codigo: 'SOLICITUD_DUPLICADA'
            });
        }

        const registradaEn = Date.now();
        solicitudesIdempotentes.set(claveCompleta, registradaEn);
        guardarClavesIdempotencia();
        res.once('finish', () => {
            if (
                res.statusCode >= 400 &&
                solicitudesIdempotentes.get(claveCompleta) === registradaEn
            ) {
                solicitudesIdempotentes.delete(claveCompleta);
                guardarClavesIdempotencia();
            }
        });
        res.set('Idempotency-Key', claveRecibida);
        next();
    };
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
    return ETIQUETAS_LINEA.has(etiqueta) ? etiqueta : 'indefinida';
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

function crearControlSeguridadPublicacion(idsLineas = []) {
    let resolverCorte = null;
    let resolverAltoTotal = null;
    const promesaCorte = new Promise(resolve => {
        resolverCorte = resolve;
    });
    const promesaAltoTotal = new Promise(resolve => {
        resolverAltoTotal = resolve;
    });

    return {
        pausada: false,
        resolver: null,
        idsLineas: new Set(idsLineas),
        corteDesconexion: null,
        promesaCorte,
        resolverCorte,
        altoTotal: null,
        promesaAltoTotal,
        resolverAltoTotal
    };
}

function solicitarAltoTotalPublicacion() {
    const activa = progresoPublicacion.activo === true;
    const pendientesCanceladas = trabajosPendientesPublicacion.size;
    const habiaTrabajo = activa || pendientesCanceladas > 0;

    if (!habiaTrabajo) {
        return {
            habiaTrabajo: false,
            activa: false,
            pendientesCanceladas: 0,
            solicitadoEn: null
        };
    }

    if (pendientesCanceladas > 0) {
        generacionColaPublicaciones += 1;
        for (const trabajo of trabajosPendientesPublicacion) {
            trabajo.cancelado = true;
            trabajo.cancelar?.();
        }
        trabajosPendientesPublicacion.clear();
        publicacionesPendientes = 0;
    }

    const solicitadoEn =
        controlSeguridadPublicacion.altoTotal?.solicitadoEn ||
        new Date().toISOString();
    const mensaje = activa
        ? 'Alto total solicitado. No se iniciará otra línea.'
        : 'La publicación que estaba en espera fue cancelada.';

    if (activa && !controlSeguridadPublicacion.altoTotal) {
        controlSeguridadPublicacion.altoTotal = {
            solicitadoEn,
            mensaje
        };

        if (controlSeguridadPublicacion.resolverAltoTotal) {
            const resolverAltoTotal =
                controlSeguridadPublicacion.resolverAltoTotal;
            controlSeguridadPublicacion.resolverAltoTotal = null;
            resolverAltoTotal(controlSeguridadPublicacion.altoTotal);
        }

    }

    if (
        activa &&
        controlSeguridadPublicacion.pausada &&
        controlSeguridadPublicacion.resolver
    ) {
        const resolver = controlSeguridadPublicacion.resolver;
        controlSeguridadPublicacion.pausada = false;
        controlSeguridadPublicacion.resolver = null;
        resolver('alto_total');
    }

    progresoPublicacion.altoTotalSolicitado = true;
    progresoPublicacion.altoTotalSolicitadoEn = solicitadoEn;
    progresoPublicacion.tipoErrorCorte ||= 'cancelacion_manual';
    progresoPublicacion.codigoErrorCorte ||= 'DETENIDA_ALTO_TOTAL';
    progresoPublicacion.mensajeErrorCorte ||= mensaje;
    progresoPublicacion.proximoGrupoSegundos = 0;
    progresoPublicacion.proximaLineaSegundos = 0;
    progresoPublicacion.sincronizacionAudienciaSegundos = 0;
    progresoPublicacion.estado = activa
        ? 'deteniendo_alto_total'
        : 'detenido_alto_total';
    progresoPublicacion.mensaje = activa && progresoPublicacion.envioEnCurso
        ? 'Alto total solicitado. Esperando la confirmación del envío que ya está en curso para guardar su ID.'
        : mensaje;

    return {
        habiaTrabajo,
        activa,
        pendientesCanceladas,
        solicitadoEn
    };
}

function crearErrorPublicacion(codigo, tipoError, mensaje, datos = {}) {
    const error = new Error(mensaje);
    error.codigo = codigo;
    error.tipoError = tipoError;
    Object.assign(error, datos);
    return error;
}

function obtenerCodigoError(error) {
    const candidatos = [
        error?.output?.statusCode,
        error?.output?.payload?.statusCode,
        error?.statusCode,
        error?.status,
        error?.data?.statusCode,
        error?.data?.status,
        error?.cause?.output?.statusCode,
        error?.cause?.output?.payload?.statusCode,
        error?.cause?.statusCode,
        error?.cause?.status,
        error?.cause?.data?.statusCode
    ];

    return candidatos.map(Number).find(Number.isFinite) ?? null;
}

function obtenerDuracionEnfriamientoLimite(error) {
    const candidatos = [
        error?.retryAfter,
        error?.retry_after,
        error?.data?.retryAfter,
        error?.data?.retry_after,
        error?.output?.headers?.['retry-after'],
        error?.headers?.['retry-after'],
        error?.cause?.retryAfter,
        error?.cause?.data?.retryAfter
    ];

    for (const candidato of candidatos) {
        if (candidato === null || candidato === undefined || candidato === '') continue;

        const numero = Number(candidato);
        let duracionMs = null;

        if (Number.isFinite(numero) && numero > 0) {
            // Retry-After numérico está definido en segundos por HTTP.
            duracionMs = numero * 1000;
        } else {
            const fecha = Date.parse(String(candidato));
            if (Number.isFinite(fecha)) duracionMs = fecha - Date.now();
        }

        if (Number.isFinite(duracionMs) && duracionMs > 0) {
            return Math.min(
                ENFRIAMIENTO_LIMITE_MAXIMO_MS,
                Math.max(ENFRIAMIENTO_LIMITE_MINIMO_MS, duracionMs)
            );
        }
    }

    return ENFRIAMIENTO_LIMITE_TEMPORAL_MS;
}

function clasificarErrorPublicacion(error, linea, socketUsado, fase = 'envio') {
    if (error?.tipoError && error?.codigo) {
        return {
            tipoError: error.tipoError,
            codigoError: error.codigoErrorCorte || error.codigo,
            reintentable: error.reintentable !== false,
            envioConfirmado: error.envioConfirmado === true,
            envioIncierto: error.envioIncierto === true,
            reintentoSeguro: error.reintentoSeguro !== false
        };
    }

    const codigoEstado = obtenerCodigoError(error);
    const mensaje = String(error?.message || '').toLowerCase();
    const mensajeCausa = String(error?.cause?.message || '').toLowerCase();
    const mensajeCompleto = `${mensaje} ${mensajeCausa}`;
    const errorTransporte = /(?:connection|conexi[oó]n)\s+(?:closed|lost|terminated|reset|cerrada|perdida)|socket\s+(?:closed|ended|not connected)|websocket|econn(?:reset|refused|aborted)|stream\s+(?:errored|closed)|timed?\s*out|not\s+connected/i
        .test(mensajeCompleto);

    // Un límite temporal es más específico que el cierre de transporte que
    // puede acompañarlo. Clasificarlo primero permite aplicar su enfriamiento.
    if (
        codigoEstado === 429 ||
        /\brate[\s_-]*limit(?:ed|ing)?\b|too many requests|retry[\s_-]*after/i
            .test(mensajeCompleto)
    ) {
        return {
            tipoError: 'limite_temporal',
            codigoError: codigoEstado ? `WA_${codigoEstado}` : 'LIMITE_TEMPORAL',
            reintentable: false,
            envioConfirmado: false,
            envioIncierto: false,
            reintentoSeguro: true
        };
    }

    const desconectada = !linea ||
        linea.estado !== 'conectado' ||
        !linea.socket ||
        (socketUsado && linea.socket !== socketUsado) ||
        CODIGOS_ERROR_CONEXION.has(codigoEstado) ||
        errorTransporte;

    if (desconectada) {
        const envioIncierto = fase === 'envio';
        return {
            tipoError: 'desconexion',
            codigoError: codigoEstado ? `WA_${codigoEstado}` : 'LINEA_DESCONECTADA',
            reintentable: false,
            envioConfirmado: false,
            envioIncierto,
            reintentoSeguro: !envioIncierto
        };
    }

    if (fase === 'registro') {
        return {
            tipoError: 'registro_local',
            codigoError: 'REGISTRO_LOCAL',
            reintentable: false,
            envioConfirmado: true,
            envioIncierto: false,
            reintentoSeguro: false
        };
    }

    return {
        tipoError: 'envio',
        codigoError: codigoEstado ? `WA_${codigoEstado}` : 'ERROR_ENVIO',
        reintentable: true,
        envioConfirmado: false,
        envioIncierto: false,
        reintentoSeguro: true
    };
}

function formatearCodigoCorte(codigo, respaldo = 'LINEA_DESCONECTADA') {
    if (codigo === null || codigo === undefined || codigo === '') return respaldo;
    return Number.isFinite(Number(codigo)) ? `WA_${Number(codigo)}` : String(codigo);
}

function registrarCorteDesconexion(linea, mensaje, codigo = null) {
    if (
        !progresoPublicacion.activo ||
        !controlSeguridadPublicacion.idsLineas?.has(linea?.id) ||
        controlSeguridadPublicacion.corteDesconexion
    ) {
        return;
    }

    controlSeguridadPublicacion.corteDesconexion = {
        lineaId: linea.id,
        nombre: linea.nombre,
        codigo,
        mensaje: mensaje || 'La línea se desconectó durante la publicación.'
    };

    const esLimiteTemporal = Number(codigo) === 429;
    progresoPublicacion.tipoErrorCorte = esLimiteTemporal
        ? 'limite_temporal'
        : 'desconexion';
    progresoPublicacion.codigoErrorCorte = formatearCodigoCorte(codigo);
    progresoPublicacion.lineaCorte = {
        id: linea.id,
        nombre: linea.nombre
    };
    progresoPublicacion.mensajeErrorCorte =
        controlSeguridadPublicacion.corteDesconexion.mensaje;

    if (controlSeguridadPublicacion.resolverCorte) {
        const resolverCorte = controlSeguridadPublicacion.resolverCorte;
        controlSeguridadPublicacion.resolverCorte = null;
        resolverCorte(controlSeguridadPublicacion.corteDesconexion);
    }

    if (controlSeguridadPublicacion.pausada && controlSeguridadPublicacion.resolver) {
        const resolver = controlSeguridadPublicacion.resolver;
        controlSeguridadPublicacion.pausada = false;
        controlSeguridadPublicacion.resolver = null;
        resolver('desconexion');
    }
}

function verificarCorteDesconexion() {
    // Una desconexión o limitación simultánea tiene prioridad sobre el
    // Alto total: puede dejar un envío incierto y necesita cuarentena.
    const corte = controlSeguridadPublicacion.corteDesconexion;
    if (corte) {
        const esLimiteTemporal = Number(corte.codigo) === 429;

        throw crearErrorPublicacion(
            esLimiteTemporal
                ? 'DETENIDA_LIMITE_TEMPORAL'
                : 'DETENIDA_DESCONEXION',
            esLimiteTemporal ? 'limite_temporal' : 'desconexion',
            corte.mensaje ||
                `Publicación detenida: ${corte.nombre} se desconectó.`,
            {
                lineaId: corte.lineaId,
                lineaNombre: corte.nombre,
                codigoDesconexion: corte.codigo,
                codigoErrorCorte: formatearCodigoCorte(corte.codigo),
                mensajeCorte: corte.mensaje,
                duracionEnfriamientoMs: esLimiteTemporal
                    ? ENFRIAMIENTO_LIMITE_TEMPORAL_MS
                    : undefined,
                reintentable: false,
                envioIncierto:
                    !esLimiteTemporal && corte.envioIncierto === true,
                reintentoSeguro:
                    esLimiteTemporal || corte.envioIncierto !== true
            }
        );
    }

    const altoTotal = controlSeguridadPublicacion.altoTotal;
    if (!altoTotal) return;

    throw crearErrorPublicacion(
        'DETENIDA_ALTO_TOTAL',
        'cancelacion_manual',
        altoTotal.mensaje ||
            'Publicación detenida manualmente con Alto total.',
        {
            solicitadoEn: altoTotal.solicitadoEn,
            reintentable: false,
            envioConfirmado: false,
            envioIncierto: false,
            reintentoSeguro: true
        }
    );
}

async function esperarOperacionPublicacion(
    promesa,
    {
        timeoutMs,
        codigoTimeout,
        tipoTimeout,
        mensajeTimeout,
        envioEnVuelo = false
    }
) {
    let temporizador = null;
    const operacion = Promise.resolve(promesa).then(
        valor => ({ clase: 'resultado', valor }),
        error => ({ clase: 'error', error })
    );
    const timeout = new Promise(resolve => {
        temporizador = setTimeout(
            () => resolve({ clase: 'timeout' }),
            timeoutMs
        );
    });
    const corte = controlSeguridadPublicacion.promesaCorte.then(datos => ({
        clase: 'corte',
        datos
    }));
    const candidatos = [operacion, timeout, corte];

    // Un Alto total interrumpe preparación, audiencias y esperas. Si el
    // envío ya llegó a WhatsApp, esperamos su resultado para poder guardar
    // el ID antes de detener la tanda.
    if (!envioEnVuelo) {
        candidatos.push(
            controlSeguridadPublicacion.promesaAltoTotal.then(datos => ({
                clase: 'alto_total',
                datos
            }))
        );
    }

    const resultado = await Promise.race(candidatos);
    if (temporizador) clearTimeout(temporizador);

    if (resultado.clase === 'resultado') return resultado.valor;
    if (resultado.clase === 'error') throw resultado.error;

    if (resultado.clase === 'corte') {
        try {
            verificarCorteDesconexion();
        } catch (error) {
            if (envioEnVuelo) {
                if (controlSeguridadPublicacion.corteDesconexion) {
                    controlSeguridadPublicacion.corteDesconexion.envioIncierto = true;
                }
                error.envioIncierto = true;
                error.reintentoSeguro = false;
            }
            throw error;
        }
    }

    if (resultado.clase === 'alto_total') {
        verificarCorteDesconexion();
    }

    throw crearErrorPublicacion(
        codigoTimeout,
        tipoTimeout,
        mensajeTimeout,
        {
            reintentable: false,
            envioConfirmado: false,
            envioIncierto: envioEnVuelo,
            reintentoSeguro: !envioEnVuelo
        }
    );
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

function rutaActividadContactos(lineaId) {
    const carpetaSesion = resolverCarpetaSesionSegura(lineaId);
    if (!carpetaSesion) {
        throw new Error('El identificador de la línea no es válido.');
    }

    return path.join(
        carpetaSesion,
        NOMBRE_ARCHIVO_ACTIVIDAD_CONTACTOS
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

function compararJidsActividad(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

function invalidarResumenPriorizacionAudiencia(linea) {
    linea.revisionPriorizacionAudiencia =
        (Number(linea.revisionPriorizacionAudiencia) || 0) + 1;
    linea.cacheResumenPriorizacionAudiencia = null;
}

function normalizarTimestampActividadContactos(valor) {
    let timestamp = valor;

    if (timestamp && typeof timestamp.toNumber === 'function') {
        try {
            timestamp = timestamp.toNumber();
        } catch {
            return 0;
        }
    }

    timestamp = Number(timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;

    // Baileys entrega timestamps Unix en segundos en mensajes y chats.
    if (timestamp < 1e12) timestamp *= 1000;

    timestamp = Math.floor(timestamp);
    const inicioWhatsAppMs = Date.UTC(2009, 0, 1);
    if (
        timestamp < inicioWhatsAppMs ||
        timestamp > Date.now() + MARGEN_TIMESTAMP_FUTURO_MS
    ) {
        return 0;
    }

    return timestamp;
}

function inicializarActividadContactos(linea, cargada = false) {
    linea.ultimaInteraccionContactos = new Map();
    linea.mapeosActividadContactos = new Map();
    linea.actividadContactosCargada = cargada;
    linea.actividadContactosSucia = false;
    linea.temporizadorActividadContactos = null;
    linea.promesaActividadContactos = Promise.resolve();
    linea.tareasActividadPendientes = 0;
    linea.fechaUltimaInteraccionContactos = 0;
    linea.ultimaSeleccionAudienciaEstado = null;
    invalidarResumenPriorizacionAudiencia(linea);
}

function ordenarRegistrosActividadContactos(mapa) {
    return [...mapa.entries()]
        .filter(([jid, timestamp]) => (
            Boolean(normalizarJidDestinatario(jid)) &&
            normalizarTimestampActividadContactos(timestamp) > 0
        ))
        .sort((a, b) => {
            const diferencia = b[1] - a[1];
            return diferencia || compararJidsActividad(a[0], b[0]);
        });
}

function podarActividadContactos(linea) {
    const registros = ordenarRegistrosActividadContactos(
        linea.ultimaInteraccionContactos || new Map()
    ).slice(0, MAXIMOS_REGISTROS_ACTIVIDAD_CONTACTOS);

    linea.ultimaInteraccionContactos = new Map(registros);
    linea.fechaUltimaInteraccionContactos = registros[0]?.[1] || 0;
    return registros;
}

function cargarActividadContactos(linea) {
    inicializarActividadContactos(linea, true);

    const ruta = rutaActividadContactos(linea.id);
    if (!fs.existsSync(ruta)) return;

    try {
        const datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
        if (!Array.isArray(datos)) {
            throw new Error('El archivo no contiene una lista válida.');
        }

        const actividad = new Map();
        const maximoARevisar = MAXIMOS_REGISTROS_ACTIVIDAD_CONTACTOS * 2;

        for (const registro of datos.slice(0, maximoARevisar)) {
            if (!Array.isArray(registro) || registro.length < 2) continue;

            const jid = normalizarJidDestinatario(registro[0]);
            const timestamp = normalizarTimestampActividadContactos(registro[1]);
            if (!jid || !timestamp) continue;

            const anterior = actividad.get(jid) || 0;
            if (timestamp > anterior) actividad.set(jid, timestamp);
        }

        linea.ultimaInteraccionContactos = actividad;
        podarActividadContactos(linea);
    } catch (error) {
        console.error(
            `No se pudo cargar la actividad de contactos de ${linea.nombre}:`,
            error.message
        );
    }
}

function asegurarActividadContactos(linea) {
    if (!linea.actividadContactosCargada) {
        cargarActividadContactos(linea);
    }
}

function guardarActividadContactos(linea, forzar = false) {
    asegurarActividadContactos(linea);
    if (!forzar && !linea.actividadContactosSucia) return;

    try {
        const registros = linea.ultimaInteraccionContactos.size >
            MAXIMOS_REGISTROS_ACTIVIDAD_CONTACTOS
            ? podarActividadContactos(linea)
            : [...linea.ultimaInteraccionContactos.entries()];
        const ruta = rutaActividadContactos(linea.id);
        fs.mkdirSync(path.dirname(ruta), { recursive: true });
        // Este índice puede contener miles de pares JID/fecha. Se escribe
        // compacto para reducir el tiempo de bloqueo del hilo principal.
        guardarJSONAtomico(ruta, registros, 0);
        linea.actividadContactosSucia = false;
    } catch (error) {
        linea.actividadContactosSucia = true;
        console.error(
            `No se pudo guardar la actividad de contactos de ${linea.nombre}:`,
            error.message
        );
    }
}

function programarGuardadoActividadContactos(linea) {
    linea.actividadContactosSucia = true;
    if (linea.temporizadorActividadContactos) return;

    linea.temporizadorActividadContactos = setTimeout(() => {
        linea.temporizadorActividadContactos = null;

        if (lineas.get(linea.id) !== linea || linea.eliminando) return;
        guardarActividadContactos(linea);
    }, DEMORA_GUARDADO_ACTIVIDAD_CONTACTOS_MS);
    linea.temporizadorActividadContactos.unref?.();
}

function cancelarGuardadoActividadContactos(linea, guardarPendiente = true) {
    if (linea.temporizadorActividadContactos) {
        clearTimeout(linea.temporizadorActividadContactos);
        linea.temporizadorActividadContactos = null;
    }

    if (guardarPendiente && linea.actividadContactosSucia) {
        guardarActividadContactos(linea, true);
    }
}

function limpiarActividadContactos(linea) {
    cancelarGuardadoActividadContactos(linea, false);
    inicializarActividadContactos(linea, true);
}

function aplicarMapeoActividadContactos(linea, lidOriginal, pnOriginal) {
    asegurarActividadContactos(linea);

    const lid = normalizarJidDestinatario(lidOriginal);
    const pn = normalizarJidDestinatario(pnOriginal);
    if (!esJidLid(lid) || !esJidNumero(pn)) return false;

    const mapeoAnterior = linea.mapeosActividadContactos.get(lid);

    if (
        !linea.mapeosActividadContactos.has(lid) &&
        linea.mapeosActividadContactos.size >=
            MAXIMOS_REGISTROS_ACTIVIDAD_CONTACTOS
    ) {
        const mapeoMasAntiguo = linea.mapeosActividadContactos.keys().next().value;
        if (mapeoMasAntiguo) {
            linea.mapeosActividadContactos.delete(mapeoMasAntiguo);
        }
    }
    linea.mapeosActividadContactos.set(lid, pn);
    const timestampLid = linea.ultimaInteraccionContactos.get(lid) || 0;
    const timestampPn = linea.ultimaInteraccionContactos.get(pn) || 0;
    let huboCambios = false;

    if (timestampLid > timestampPn) {
        linea.ultimaInteraccionContactos.set(pn, timestampLid);
        linea.fechaUltimaInteraccionContactos = Math.max(
            linea.fechaUltimaInteraccionContactos || 0,
            timestampLid
        );
        huboCambios = true;
    }

    if (linea.ultimaInteraccionContactos.delete(lid)) {
        huboCambios = true;
    }

    if (mapeoAnterior !== pn || huboCambios) {
        invalidarResumenPriorizacionAudiencia(linea);
    }

    return huboCambios;
}

async function resolverLidsActividadContactos(linea, socket, valores) {
    asegurarActividadContactos(linea);

    const lids = [...new Set(
        [...(valores || [])]
            .map(normalizarJidDestinatario)
            .filter(esJidLid)
    )];
    let huboCambios = false;

    for (const lid of lids) {
        const pnGuardado = linea.mapeosActividadContactos.get(lid);
        if (pnGuardado) {
            huboCambios = aplicarMapeoActividadContactos(
                linea,
                lid,
                pnGuardado
            ) || huboCambios;
        }
    }

    const pendientesLote = lids.filter(
        lid => lid.endsWith('@lid') &&
            !linea.mapeosActividadContactos.has(lid)
    );
    const repositorioMapeos = socket?.signalRepository?.lidMapping;
    const obtenerMapeos = repositorioMapeos?.getPNsForLIDs;

    if (pendientesLote.length && typeof obtenerMapeos === 'function') {
        for (let indice = 0; indice < pendientesLote.length; indice += 500) {
            if (linea.socket !== socket || linea.eliminando) break;

            try {
                const mapeos = await obtenerMapeos.call(
                    repositorioMapeos,
                    pendientesLote.slice(indice, indice + 500)
                );

                if (linea.socket !== socket || linea.eliminando) break;
                for (const mapeo of mapeos || []) {
                    huboCambios = aplicarMapeoActividadContactos(
                        linea,
                        mapeo?.lid,
                        mapeo?.pn
                    ) || huboCambios;
                }
            } catch {
                // El mapeo puede no existir todavía; se conserva el LID.
            }
        }
    }

    // El método por lotes de Baileys no siempre resuelve @hosted.lid.
    // Probamos los identificadores que sigan pendientes de forma individual
    // y conservamos el LID cuando WhatsApp todavía no conoce su número.
    const pendientesIndividuales = lids.filter(
        lid => lid.endsWith('@hosted.lid') &&
            !linea.mapeosActividadContactos.has(lid)
    );
    const obtenerMapeoIndividual = repositorioMapeos?.getPNForLID;

    if (
        pendientesIndividuales.length &&
        typeof obtenerMapeoIndividual === 'function'
    ) {
        for (
            let indice = 0;
            indice < pendientesIndividuales.length;
            indice += 50
        ) {
            if (linea.socket !== socket || linea.eliminando) break;

            const lote = pendientesIndividuales.slice(indice, indice + 50);
            const resultados = await Promise.all(lote.map(async lid => {
                try {
                    const pn = await obtenerMapeoIndividual.call(
                        repositorioMapeos,
                        lid
                    );
                    return { lid, pn };
                } catch {
                    return null;
                }
            }));

            if (linea.socket !== socket || linea.eliminando) break;
            for (const mapeo of resultados.filter(Boolean)) {
                huboCambios = aplicarMapeoActividadContactos(
                    linea,
                    mapeo.lid,
                    mapeo.pn
                ) || huboCambios;
            }
        }
    }

    if (huboCambios) programarGuardadoActividadContactos(linea);
    return huboCambios;
}

function obtenerJidsPropiosActividad(linea, socket) {
    return new Set([
        linea.jid,
        socket?.user?.id,
        socket?.user?.lid,
        socket?.user?.phoneNumber
    ].map(normalizarJidDestinatario).filter(Boolean));
}

function registrarInteraccionActividadContactos(
    linea,
    socket,
    jidOriginal,
    timestampOriginal
) {
    asegurarActividadContactos(linea);

    let jid = normalizarJidDestinatario(jidOriginal);
    const timestamp = normalizarTimestampActividadContactos(timestampOriginal);
    if (!jid || !timestamp) return false;

    jid = linea.mapeosActividadContactos.get(jid) || jid;
    if (obtenerJidsPropiosActividad(linea, socket).has(jid)) return false;

    const anterior = linea.ultimaInteraccionContactos.get(jid) || 0;
    if (timestamp <= anterior) return false;

    linea.ultimaInteraccionContactos.set(jid, timestamp);
    linea.fechaUltimaInteraccionContactos = Math.max(
        linea.fechaUltimaInteraccionContactos || 0,
        timestamp
    );
    invalidarResumenPriorizacionAudiencia(linea);
    return true;
}

function timestampConversacionActividad(chat) {
    return Math.max(
        normalizarTimestampActividadContactos(chat?.conversationTimestamp),
        normalizarTimestampActividadContactos(chat?.lastMsgTimestamp),
        normalizarTimestampActividadContactos(chat?.lastMessageRecvTimestamp)
    );
}

function jidsRelacionadosActividad(objeto) {
    return [
        objeto?.remoteJidAlt,
        objeto?.remoteJid,
        objeto?.phoneNumber,
        objeto?.pnJid,
        objeto?.lidJid,
        objeto?.lid,
        objeto?.id
    ].map(normalizarJidDestinatario).filter(Boolean);
}

function encolarActividadContactos(linea, socket, tarea) {
    asegurarActividadContactos(linea);
    linea.tareasActividadPendientes =
        (Number(linea.tareasActividadPendientes) || 0) + 1;
    invalidarResumenPriorizacionAudiencia(linea);

    linea.promesaActividadContactos = Promise.resolve(
        linea.promesaActividadContactos
    )
        .catch(() => {})
        .then(async () => {
            if (
                lineas.get(linea.id) !== linea ||
                linea.socket !== socket ||
                linea.eliminando
            ) return;

            await tarea();
        })
        .catch(error => {
            console.error(
                `No se pudo actualizar la actividad de ${linea.nombre}:`,
                error.message
            );
        })
        .finally(() => {
            linea.tareasActividadPendientes = Math.max(
                0,
                (Number(linea.tareasActividadPendientes) || 0) - 1
            );
            invalidarResumenPriorizacionAudiencia(linea);
        });
}

async function esperarColaActividadContactos(
    linea,
    socket,
    limiteSincronizacion,
    controlPublicacion
) {
    const ahora = Date.now();
    const limiteGeneral = Number(limiteSincronizacion);
    const limite = Math.min(
        ahora + TIEMPO_ESPERA_COLA_ACTIVIDAD_CONTACTOS_MS,
        Number.isFinite(limiteGeneral) && limiteGeneral > ahora
            ? limiteGeneral
            : ahora + TIEMPO_ESPERA_COLA_ACTIVIDAD_CONTACTOS_MS
    );

    while (Date.now() < limite) {
        const promesaObservada =
            linea.promesaActividadContactos || Promise.resolve();
        let termino = false;

        await new Promise(resolve => {
            const temporizador = setTimeout(
                resolve,
                Math.max(1, limite - Date.now())
            );

            Promise.resolve(promesaObservada).then(() => {
                termino = true;
                clearTimeout(temporizador);
                resolve();
            });
        });

        verificarControlAudienciaPublicacion(controlPublicacion);
        if (linea.socket !== socket || linea.eliminando) return false;
        if (!termino) return false;

        if (
            promesaObservada === linea.promesaActividadContactos &&
            (Number(linea.tareasActividadPendientes) || 0) === 0
        ) {
            return true;
        }
    }

    return (Number(linea.tareasActividadPendientes) || 0) === 0;
}

async function procesarActividadContactos(
    linea,
    socket,
    { mensajes = [], chats = [], contactos = [], mapeos = [] } = {}
) {
    asegurarActividadContactos(linea);
    let huboCambios = false;

    const listaMensajes = Array.isArray(mensajes) ? mensajes : [];
    const listaChats = Array.isArray(chats) ? chats : [];
    const listaContactos = Array.isArray(contactos) ? contactos : [];
    const todosLosMapeos = Array.isArray(mapeos) ? [...mapeos] : [];

    for (const contacto of listaContactos) {
        const relacionados = jidsRelacionadosActividad(contacto);
        const pn = relacionados.find(esJidNumero);
        if (!pn) continue;

        for (const lid of relacionados.filter(esJidLid)) {
            todosLosMapeos.push({ lid, pn });
        }
    }

    for (const mapeo of todosLosMapeos) {
        huboCambios = aplicarMapeoActividadContactos(
            linea,
            mapeo?.lid,
            mapeo?.pn
        ) || huboCambios;
    }

    const candidatos = new Map();
    const agregarCandidato = (jids, timestamp) => {
        if (!timestamp || !jids.length) return;

        const pn = jids.find(esJidNumero);
        if (pn) {
            for (const lid of jids.filter(esJidLid)) {
                huboCambios = aplicarMapeoActividadContactos(
                    linea,
                    lid,
                    pn
                ) || huboCambios;
            }
        }

        const jid = pn || jids[0];
        candidatos.set(jid, Math.max(candidatos.get(jid) || 0, timestamp));
    };

    for (const mensaje of listaMensajes) {
        const timestamp = normalizarTimestampActividadContactos(
            mensaje?.messageTimestamp
        );
        agregarCandidato(
            jidsRelacionadosActividad(mensaje?.key || {}),
            timestamp
        );
    }

    for (const chat of listaChats) {
        // ChatUpdate.timestamp es la hora del evento local, no la conversación.
        agregarCandidato(
            jidsRelacionadosActividad(chat),
            timestampConversacionActividad(chat)
        );
    }

    await resolverLidsActividadContactos(linea, socket, candidatos.keys());
    if (
        lineas.get(linea.id) !== linea ||
        linea.socket !== socket ||
        linea.eliminando
    ) return;

    for (const [jid, timestamp] of candidatos) {
        huboCambios = registrarInteraccionActividadContactos(
            linea,
            socket,
            jid,
            timestamp
        ) || huboCambios;
    }

    if (
        linea.ultimaInteraccionContactos.size >
        MAXIMOS_REGISTROS_ACTIVIDAD_CONTACTOS
    ) {
        podarActividadContactos(linea);
        huboCambios = true;
    }

    if (huboCambios) programarGuardadoActividadContactos(linea);
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
    invalidarResumenPriorizacionAudiencia(linea);

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
    asegurarActividadContactos(linea);
    let huboCambios = false;
    let huboCambiosActividad = false;

    for (const contacto of contactos) {
        if (!contacto || typeof contacto !== 'object') continue;

        const jidsContacto = jidsRelacionadosActividad(contacto);
        const jidNumeroContacto = jidsContacto.find(esJidNumero);
        if (jidNumeroContacto) {
            for (const jidLidContacto of jidsContacto.filter(esJidLid)) {
                huboCambiosActividad = aplicarMapeoActividadContactos(
                    linea,
                    jidLidContacto,
                    jidNumeroContacto
                ) || huboCambiosActividad;
            }
        }

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

        if (esJidNumero(jid)) {
            for (const relacionado of jidsRelacionados) {
                if (!esJidLid(relacionado)) continue;
                huboCambiosActividad = aplicarMapeoActividadContactos(
                    linea,
                    relacionado,
                    jid
                ) || huboCambiosActividad;
            }
        }

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
        invalidarResumenPriorizacionAudiencia(linea);
        guardarAudienciaEstados(linea);
    }

    if (huboCambiosActividad && linea.socket === socket) {
        programarGuardadoActividadContactos(linea);
    }
}

function actualizarPrivacidadEstados(linea, valor) {
    asegurarAudienciaEstados(linea);
    invalidarResumenPriorizacionAudiencia(linea);

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

function prepararSincronizacionAudienciasPublicacion(lineasPublicacion) {
    const limites = new Map();
    const limiteComun =
        Date.now() + TIEMPO_ESPERA_SINCRONIZACION_AUDIENCIA_MS;

    for (const linea of lineasPublicacion) {
        limites.set(linea.id, limiteComun);
        if (audienciaEstadosLista(linea)) continue;

        if (
            linea.estado !== 'conectado' ||
            !linea.socket ||
            linea.eliminando
        ) {
            continue;
        }

        // Todas las líneas pendientes comienzan a trabajar en paralelo. Así
        // una publicación con varias audiencias incompletas espera como máximo
        // un minuto total, no un minuto adicional por cada línea.
        cancelarReintentoAudiencia(linea);
        programarResincronizacionAudiencia(linea, linea.socket, 0);
    }

    return limites;
}

async function esperarSincronizacionAudienciaHasta(
    linea,
    socket,
    limiteMs,
    controlPublicacion
) {
    if (audienciaEstadosLista(linea)) return true;

    const limite = Number(limiteMs);
    if (!Number.isFinite(limite) || limite <= Date.now()) return false;

    while (Date.now() < limite) {
        if (
            controlSeguridadPublicacion !== controlPublicacion ||
            !progresoPublicacion.activo
        ) {
            return false;
        }
        if (
            controlPublicacion?.corteDesconexion ||
            controlPublicacion?.altoTotal
        ) {
            verificarCorteDesconexion();
        }
        if (audienciaEstadosLista(linea)) return true;
        if (
            linea.socket !== socket ||
            linea.estado !== 'conectado' ||
            linea.eliminando
        ) {
            return false;
        }

        if (
            !linea.resincronizandoAudiencia &&
            !linea.temporizadorAudiencia &&
            (Number(linea.intentosResincronizacionAudiencia) || 0) <
                MAXIMOS_INTENTOS_AUDIENCIA
        ) {
            programarResincronizacionAudiencia(linea, socket, 0);
        }

        if (
            progresoPublicacion.activo &&
            progresoPublicacion.lineaActual?.id === linea.id
        ) {
            progresoPublicacion.sincronizacionAudienciaSegundos = Math.max(
                0,
                Math.ceil((limite - Date.now()) / 1000)
            );
        }

        await esperar(Math.min(250, Math.max(1, limite - Date.now())));
    }

    return audienciaEstadosLista(linea);
}

function verificarControlAudienciaPublicacion(controlPublicacion) {
    if (!controlPublicacion) return;

    if (
        controlSeguridadPublicacion !== controlPublicacion ||
        !progresoPublicacion.activo
    ) {
        throw crearErrorPublicacion(
            'AUDIENCIA_CANCELADA',
            'sincronizacion_audiencia',
            'La comprobación de audiencia pertenece a una publicación que ya terminó.',
            { reintentable: false }
        );
    }

    if (
        controlPublicacion.corteDesconexion ||
        controlPublicacion.altoTotal
    ) {
        verificarCorteDesconexion();
    }
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
        invalidarResumenPriorizacionAudiencia(linea);

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

function ordenarAudienciaPorActividad(linea, audiencia) {
    const actividad = linea.ultimaInteraccionContactos;

    return [...audiencia].sort((a, b) => {
        const diferenciaActividad =
            (actividad.get(b) || 0) - (actividad.get(a) || 0);

        return diferenciaActividad || compararJidsActividad(a, b);
    });
}

function crearMetricasPriorizacionAudiencia(
    linea,
    audienciaCompleta,
    audienciaBaseReciente,
    audienciaSeleccionada,
    limiteConfigurado
) {
    asegurarActividadContactos(linea);

    const actividad = linea.ultimaInteraccionContactos;
    const contarConActividad = audiencia => audiencia.reduce(
        (total, jid) => total + ((actividad.get(jid) || 0) > 0 ? 1 : 0),
        0
    );
    const audienciaActividadConocida = contarConActividad(audienciaCompleta);
    const actividadConocida = contarConActividad(audienciaBaseReciente);
    const seleccionActividadConocida = contarConActividad(
        audienciaSeleccionada
    );
    const ultimaInteraccion = Number(
        linea.fechaUltimaInteraccionContactos
    ) || 0;

    return {
        criterio: 'actividad_reciente',
        sincronizandoActividad:
            (Number(linea.tareasActividadPendientes) || 0) > 0,
        registrosActividad: actividad.size,
        audienciaEfectiva: audienciaCompleta.length,
        audienciaActividadConocida,
        audienciaActividadDesconocida:
            audienciaCompleta.length - audienciaActividadConocida,
        baseReciente: audienciaBaseReciente.length,
        limiteBaseReciente: MAXIMO_DESTINATARIOS_ESTADO,
        limiteConfigurado,
        actividadConocida,
        actividadDesconocida:
            audienciaBaseReciente.length - actividadConocida,
        seleccionados: audienciaSeleccionada.length,
        seleccionActividadConocida,
        seleccionActividadDesconocida:
            audienciaSeleccionada.length - seleccionActividadConocida,
        ultimaInteraccionRegistrada: ultimaInteraccion
            ? new Date(ultimaInteraccion).toISOString()
            : null
    };
}

function obtenerAudienciaEfectivaGuardada(linea) {
    asegurarAudienciaEstados(linea);
    asegurarActividadContactos(linea);
    if (!audienciaEstadosLista(linea)) return [];

    const privacidad = linea.privacidadEstados;
    const canonizar = valor => {
        const jid = normalizarJidDestinatario(valor);
        return jid
            ? linea.mapeosActividadContactos.get(jid) || jid
            : null;
    };
    let audiencia;

    if (
        privacidad.modo === MODOS_PRIVACIDAD_ESTADOS.SOLO_COMPARTIR_CON ||
        privacidad.modo === MODOS_PRIVACIDAD_ESTADOS.AMIGOS_CERCANOS
    ) {
        audiencia = privacidad.usuarios;
    } else if (
        privacidad.modo === MODOS_PRIVACIDAD_ESTADOS.EXCLUIR_CONTACTOS
    ) {
        const excluidos = new Set(
            privacidad.usuarios.map(canonizar).filter(Boolean)
        );
        audiencia = [...linea.contactosEstado].filter(
            jid => !excluidos.has(canonizar(jid))
        );
    } else {
        audiencia = [...linea.contactosEstado];
    }

    const propios = obtenerJidsPropiosActividad(linea, linea.socket);
    return [...new Set(
        audiencia
            .map(canonizar)
            .filter(Boolean)
            .filter(jid => !propios.has(jid))
    )];
}

function obtenerResumenPriorizacionAudiencia(linea) {
    asegurarActividadContactos(linea);

    const revision = Number(linea.revisionPriorizacionAudiencia) || 0;
    const audienciaLista = audienciaEstadosLista(linea);
    const jidLinea = linea.jid || null;
    const limiteConfigurado = normalizarLimiteDestinatariosEstado(
        configuracion.maximoDestinatariosPorEstado
    );
    const cache = linea.cacheResumenPriorizacionAudiencia;

    if (
        cache?.revision === revision &&
        cache.audienciaLista === audienciaLista &&
        cache.jidLinea === jidLinea &&
        cache.limiteConfigurado === limiteConfigurado
    ) {
        return cache.resumen;
    }

    const audienciaEfectiva = obtenerAudienciaEfectivaGuardada(linea);
    const audienciaOrdenada = ordenarAudienciaPorActividad(
        linea,
        audienciaEfectiva
    );
    const audienciaBaseReciente = audienciaOrdenada.slice(
        0,
        MAXIMO_DESTINATARIOS_ESTADO
    );
    const actividadConocida = audienciaBaseReciente.reduce(
        (total, jid) => total + (
            (linea.ultimaInteraccionContactos.get(jid) || 0) > 0 ? 1 : 0
        ),
        0
    );
    const ultimaInteraccion = Number(
        linea.fechaUltimaInteraccionContactos
    ) || 0;

    const resumen = {
        criterio: 'actividad_reciente',
        sincronizandoActividad:
            (Number(linea.tareasActividadPendientes) || 0) > 0,
        registrosActividad: linea.ultimaInteraccionContactos.size,
        audienciaEfectiva: audienciaEfectiva.length,
        baseReciente: audienciaBaseReciente.length,
        limiteBaseReciente: MAXIMO_DESTINATARIOS_ESTADO,
        limiteConfigurado,
        seleccionados: Math.min(
            audienciaBaseReciente.length,
            limiteConfigurado
        ),
        actividadConocida,
        actividadDesconocida:
            audienciaBaseReciente.length - actividadConocida,
        ultimaInteraccionRegistrada: ultimaInteraccion
            ? new Date(ultimaInteraccion).toISOString()
            : null,
        ultimaSeleccion:
            linea.ultimaSeleccionAudienciaEstado?.priorizacionAudiencia || null
    };

    linea.cacheResumenPriorizacionAudiencia = {
        revision,
        audienciaLista,
        jidLinea,
        limiteConfigurado,
        resumen
    };

    return resumen;
}

async function obtenerDestinatariosEstado(linea, opciones = {}) {
    asegurarAudienciaEstados(linea);
    asegurarActividadContactos(linea);
    linea.ultimaSeleccionAudienciaEstado = null;
    invalidarResumenPriorizacionAudiencia(linea);
    const socket = linea.socket;
    const limiteSincronizacion = Number(opciones.limiteSincronizacion);
    const controlPublicacion = opciones.controlPublicacion;
    const limiteDestinatarios = normalizarLimiteDestinatariosEstado(
        opciones.limiteDestinatarios,
        normalizarLimiteDestinatariosEstado(
            configuracion.maximoDestinatariosPorEstado
        )
    );

    if (
        !audienciaEstadosLista(linea) &&
        Number.isFinite(limiteSincronizacion) &&
        limiteSincronizacion > Date.now()
    ) {
        await esperarSincronizacionAudienciaHasta(
            linea,
            socket,
            limiteSincronizacion,
            controlPublicacion
        );
    }

    if (!audienciaEstadosLista(linea)) {
        const evaluacionConexion = evaluarLineaParaPublicar(linea, socket);
        if (!evaluacionConexion.lista) {
            throw crearErrorPublicacion(
                evaluacionConexion.codigoError,
                evaluacionConexion.tipoError,
                evaluacionConexion.error,
                { reintentable: false, reintentoSeguro: true }
            );
        }

        const privacidadIncompleta =
            linea.privacidadEstados?.modo ===
                MODOS_PRIVACIDAD_ESTADOS.EXCLUIR_CONTACTOS &&
            Number(linea.privacidadEstados?.usuariosInvalidos) > 0;
        const esperaAgotada =
            Number.isFinite(limiteSincronizacion) &&
            Date.now() >= limiteSincronizacion;

        throw crearErrorPublicacion(
            privacidadIncompleta
                ? 'PRIVACIDAD_INCOMPLETA'
                : 'AUDIENCIA_NO_SINCRONIZADA',
            'sincronizacion_audiencia',
            privacidadIncompleta
                ? `WhatsApp no pudo interpretar toda la lista de exclusiones de ${linea.nombre}. ` +
                    'La publicación se bloqueó para proteger esa privacidad.'
                : esperaAgotada
                    ? `La audiencia de estados de ${linea.nombre} no terminó de ` +
                        'sincronizarse dentro de 1 minuto. Esta línea se omitió ' +
                        'y la publicación continuará con la siguiente.'
                : `La audiencia de estados de ${linea.nombre} todavía se está sincronizando. ` +
                    'Esperá unos segundos y volvé a intentar.'
        );
    }

    verificarControlAudienciaPublicacion(controlPublicacion);

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
            throw crearErrorPublicacion(
                'IDENTIFICADORES_INCOMPLETOS',
                'sincronizacion_audiencia',
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
        throw crearErrorPublicacion(
            'PRIVACIDAD_NO_SINCRONIZADA',
            'sincronizacion_audiencia',
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

    // Si WhatsApp ya entregó un bloque de historial, esperamos brevemente a
    // que esa cola termine antes de decidir cuáles son los 1.000 más recientes.
    // Una cola excepcionalmente lenta no bloquea la publicación indefinidamente.
    await esperarColaActividadContactos(
        linea,
        socket,
        limiteSincronizacion,
        controlPublicacion
    );

    await resolverLidsActividadContactos(
        linea,
        socket,
        linea.ultimaInteraccionContactos.keys()
    );
    verificarControlAudienciaPublicacion(controlPublicacion);

    if (linea.socket !== socket || linea.eliminando) {
        const evaluacionConexion = evaluarLineaParaPublicar(linea, socket);
        throw crearErrorPublicacion(
            evaluacionConexion.codigoError || 'CONEXION_CAMBIADA',
            evaluacionConexion.tipoError || 'desconexion',
            evaluacionConexion.error ||
                `La conexión de ${linea.nombre} cambió durante la selección de audiencia.`,
            { reintentable: false, reintentoSeguro: true }
        );
    }

    if (destinatarios.size === 0) {
        throw crearErrorPublicacion(
            'SIN_DESTINATARIOS',
            'sincronizacion_audiencia',
            `La línea ${linea.nombre} todavía no sincronizó contactos ` +
            'para la audiencia de estados. Esperá unos segundos después de ' +
            'conectarla y volvé a intentar.'
        );
    }

    // Primero van los contactos con interacción más reciente. Los empates y
    // contactos sin actividad se ordenan por JID para que el resultado sea
    // determinista después de reiniciar. El JID propio no consume un lugar.
    const audienciaOrdenada = ordenarAudienciaPorActividad(
        linea,
        destinatarios
    );
    const totalAudiencia = audienciaOrdenada.length;
    const audienciaBaseReciente = audienciaOrdenada.slice(
        0,
        MAXIMO_DESTINATARIOS_ESTADO
    );
    const audienciaSeleccionada = audienciaBaseReciente.slice(
        0,
        limiteDestinatarios
    );
    destinatarios = new Set(audienciaSeleccionada);

    const jidPropio = await resolverJidDestinatario(
        socket,
        linea.jid || socket.user?.phoneNumber || socket.user?.id
    );

    verificarControlAudienciaPublicacion(controlPublicacion);
    linea.ultimaSeleccionAudienciaEstado = {
        total: totalAudiencia,
        seleccionados: audienciaSeleccionada.length,
        omitidos: Math.max(0, totalAudiencia - audienciaSeleccionada.length),
        baseReciente: audienciaBaseReciente.length,
        omitidosFueraBase: Math.max(
            0,
            totalAudiencia - audienciaBaseReciente.length
        ),
        omitidosPorLimite: Math.max(
            0,
            audienciaBaseReciente.length - audienciaSeleccionada.length
        ),
        limiteBase: MAXIMO_DESTINATARIOS_ESTADO,
        limite: limiteDestinatarios,
        limiteConfigurado: limiteDestinatarios,
        priorizacionAudiencia: crearMetricasPriorizacionAudiencia(
            linea,
            audienciaOrdenada,
            audienciaBaseReciente,
            audienciaSeleccionada,
            limiteDestinatarios
        )
    };
    invalidarResumenPriorizacionAudiencia(linea);

    if (linea.ultimaSeleccionAudienciaEstado.omitidos > 0) {
        console.log(
            `Audiencia limitada para ${linea.nombre}: ` +
            `${audienciaSeleccionada.length} de la base reciente de ` +
            `${audienciaBaseReciente.length} contacto(s) ` +
            `(audiencia disponible: ${totalAudiencia}).`
        );
    }

    if (jidPropio) {
        // El remitente también debe participar para que el estado se
        // sincronice con su teléfono y sus otros dispositivos vinculados.
        destinatarios.add(jidPropio);
    }

    return [...destinatarios];
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
        fallosRecientes: Number(linea.fallosRecientes) || 0,
        intentosReconexion: Math.min(
            MAXIMOS_INTENTOS_RECONEXION,
            Math.max(0, Number(linea.intentosReconexion) || 0)
        ),
        conexionEnVerificacion: linea.conexionEnVerificacion === true,
        reconexionBloqueada: linea.reconexionBloqueada === true,
        requiereRevisionEnvio: linea.requiereRevisionEnvio === true,
        motivoRevisionEnvio: linea.motivoRevisionEnvio || null,
        revisionEnvioDesde: linea.revisionEnvioDesde || null,
        ultimaDesconexion: linea.ultimaDesconexion || null,
        ultimoCodigoDesconexion: linea.ultimoCodigoDesconexion !== null &&
            linea.ultimoCodigoDesconexion !== undefined &&
            Number.isFinite(Number(linea.ultimoCodigoDesconexion))
            ? Number(linea.ultimoCodigoDesconexion)
            : null,
        proximoIntentoReconexion: linea.proximoIntentoReconexion || null
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

            const intentosReconexion = Math.min(
                MAXIMOS_INTENTOS_RECONEXION,
                Math.max(0, Number(datosLinea.intentosReconexion) || 0)
            );
            const conexionEnVerificacion =
                datosLinea.conexionEnVerificacion === true;
            const reconexionBloqueada =
                datosLinea.reconexionBloqueada === true ||
                (
                    intentosReconexion >= MAXIMOS_INTENTOS_RECONEXION &&
                    !conexionEnVerificacion
                );
            const proximoIntentoGuardado = Date.parse(
                datosLinea.proximoIntentoReconexion || ''
            );
            const proximoIntentoReconexion =
                !reconexionBloqueada && Number.isFinite(proximoIntentoGuardado)
                    ? new Date(proximoIntentoGuardado).toISOString()
                    : null;

            lineas.set(id, {
                id,
                nombre,
                ordenConexion,
                etiqueta: reconexionBloqueada
                    ? 'caida'
                    : normalizarEtiqueta(datosLinea.etiqueta),
                socket: null,
                jid: null,
                qr: null,
                estado: reconexionBloqueada ? 'requiere_intervencion' : 'iniciando',
                iniciando: false,
                eliminando: false,
                temporizadorReconexion: null,
                temporizadorIntentoConexion: null,
                temporizadorEstabilidadConexion: null,
                temporizadorAudiencia: null,
                generacionConexion: 0,
                reconexionManualEnCurso: false,
                resincronizandoAudiencia: false,
                intentosResincronizacionAudiencia: 0,
                ultimaConexion: datosLinea.ultimaConexion || null,
                ultimaPublicacion: datosLinea.ultimaPublicacion || null,
                ultimoError: datosLinea.ultimoError || null,
                fallosRecientes: Number(datosLinea.fallosRecientes) || 0,
                intentosReconexion,
                conexionEnVerificacion,
                reconexionBloqueada,
                requiereRevisionEnvio: datosLinea.requiereRevisionEnvio === true,
                motivoRevisionEnvio: datosLinea.motivoRevisionEnvio || null,
                revisionEnvioDesde: datosLinea.revisionEnvioDesde || null,
                ultimaDesconexion: datosLinea.ultimaDesconexion || null,
                ultimoCodigoDesconexion: datosLinea.ultimoCodigoDesconexion !== null &&
                    datosLinea.ultimoCodigoDesconexion !== undefined &&
                    Number.isFinite(Number(datosLinea.ultimoCodigoDesconexion))
                    ? Number(datosLinea.ultimoCodigoDesconexion)
                    : null,
                proximoIntentoReconexion,
                contactosEstado: new Set(),
                privacidadEstados: null,
                audienciaResincronizada: false,
                promesaContactosEstado: Promise.resolve(),
                audienciaEstadosCargada: false,
                ultimaInteraccionContactos: new Map(),
                mapeosActividadContactos: new Map(),
                actividadContactosCargada: false,
                actividadContactosSucia: false,
                temporizadorActividadContactos: null,
                promesaActividadContactos: Promise.resolve(),
                tareasActividadPendientes: 0,
                fechaUltimaInteraccionContactos: 0,
                ultimaSeleccionAudienciaEstado: null,
                revisionPriorizacionAudiencia: 0,
                cacheResumenPriorizacionAudiencia: null
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
                ...datos
                    .filter(item => item && typeof item === 'object')
                    .map(item => ({
                        ...item,
                        modoRitmo: normalizarModoRitmo(item.modoRitmo, 'grupos'),
                        intervaloSegundos: limitarNumero(
                            item.intervaloSegundos,
                            45,
                            10,
                            3600,
                            true
                        ),
                        variacionSegundos: limitarNumero(
                            item.variacionSegundos,
                            0,
                            0,
                            30,
                            true
                        )
                    }))
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
    modoRitmo,
    intervaloSegundos,
    variacionSegundos,
    lineasPorGrupo,
    intervaloMinutos,
    maximoDestinatariosPorEstado,
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
        modoRitmo,
        intervaloSegundos,
        variacionSegundos,
        lineasPorGrupo,
        intervaloMinutos,
        maximoDestinatariosPorEstado,
        rutaImagen: rutaCopia,
        mimeImagen: tipo.mime,
        estado: 'ejecutando',
        total: idsLineas.length,
        correctas: 0,
        fallidas: 0,
        noProcesadas: 0,
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
    registro.noProcesadas = progresoPublicacion.noProcesadas || 0;
    registro.lineasCorrectas = [...progresoPublicacion.lineasCorrectas];
    registro.lineasFallidas = [...progresoPublicacion.lineasFallidas];
    registro.tipoErrorCorte = progresoPublicacion.tipoErrorCorte || null;
    registro.codigoErrorCorte = progresoPublicacion.codigoErrorCorte || null;
    registro.lineaCorte = progresoPublicacion.lineaCorte || null;
    registro.mensajeErrorCorte = progresoPublicacion.mensajeErrorCorte || null;
    registro.error = error;
    guardarHistorial();
}

function marcarReintentoHistorial(historialOrigenId, idsLineas, historialHijoId) {
    if (!historialOrigenId) return;

    const registroOrigen = historialPublicaciones.find(
        item => item.id === historialOrigenId
    );
    if (!registroOrigen) return;

    const ids = new Set(idsLineas);
    const reintentadaEn = new Date().toISOString();
    let cambio = false;

    for (const fallo of registroOrigen.lineasFallidas || []) {
        if (
            ids.has(fallo?.id) &&
            fallo?.envioConfirmado !== true &&
            fallo?.reintentoSeguro === true &&
            !fallo?.reintentadaEn
        ) {
            fallo.reintentadaEn = reintentadaEn;
            fallo.reintentoHistorialId = historialHijoId;
            cambio = true;
        }
    }

    if (cambio) guardarHistorial();
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
            destinatariosRevocacion = await obtenerDestinatariosEstado(
                linea,
                { limiteDestinatarios: MAXIMO_DESTINATARIOS_ESTADO }
            );
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

function evaluarLineaParaPublicar(linea, socketEsperado = null) {
    if (!linea) {
        return {
            lista: false,
            tipoError: 'desconexion',
            codigoError: 'LINEA_NO_ENCONTRADA',
            error: 'La línea ya no existe.'
        };
    }

    if (linea.requiereRevisionEnvio) {
        return {
            lista: false,
            tipoError: 'seguridad_linea',
            codigoError: 'REVISION_ENVIO_PENDIENTE',
            error: `La línea ${linea.nombre} requiere confirmar manualmente un envío anterior incierto.`
        };
    }

    if (linea.reconexionBloqueada) {
        return {
            lista: false,
            tipoError: 'seguridad_linea',
            codigoError: 'RECONEXION_BLOQUEADA',
            error: `La línea ${linea.nombre} requiere intervención manual para reconectarse.`
        };
    }

    const etiqueta = normalizarEtiqueta(linea.etiqueta);
    if (etiqueta !== 'activa') {
        const nombresEtiquetas = {
            caida: 'caída',
            reposo: 'reposo',
            indefinida: 'indefinida'
        };

        return {
            lista: false,
            tipoError: 'seguridad_linea',
            codigoError: `ETIQUETA_${etiqueta.toUpperCase()}`,
            error: `La línea ${linea.nombre} está marcada como ${nombresEtiquetas[etiqueta] || etiqueta} y no puede publicar estados.`
        };
    }

    if (linea.conexionEnVerificacion) {
        return {
            lista: false,
            tipoError: 'seguridad_linea',
            codigoError: 'LINEA_VERIFICANDO_ESTABILIDAD',
            error: `La línea ${linea.nombre} todavía está verificando la estabilidad de su conexión.`
        };
    }

    if (linea.reconexionManualEnCurso || linea.iniciando) {
        return {
            lista: false,
            tipoError: 'seguridad_linea',
            codigoError: 'CONEXION_EN_PROCESO',
            error: `La conexión de ${linea.nombre} todavía está en proceso.`
        };
    }

    if (linea.estado !== 'conectado' || !linea.socket) {
        return {
            lista: false,
            tipoError: 'desconexion',
            codigoError: 'LINEA_NO_CONECTADA',
            error: `La línea ${linea.nombre} no está conectada.`
        };
    }

    if (socketEsperado && linea.socket !== socketEsperado) {
        return {
            lista: false,
            tipoError: 'desconexion',
            codigoError: 'SOCKET_REEMPLAZADO',
            error: `La conexión de ${linea.nombre} cambió antes de completar el envío.`
        };
    }

    return {
        lista: true,
        tipoError: null,
        codigoError: null,
        error: null
    };
}

function lineaListaParaPublicar(linea, socketEsperado = null) {
    return evaluarLineaParaPublicar(linea, socketEsperado).lista;
}

function obtenerLineasDisponibles(idsLineas) {
    const correctas = [];
    const noDisponibles = [];

    for (const id of idsLineas) {
        const linea = lineas.get(id);
        const evaluacion = evaluarLineaParaPublicar(linea);

        if (evaluacion.lista) {
            correctas.push(linea);
        } else {
            noDisponibles.push({
                id,
                nombre: linea?.nombre || 'Línea no encontrada',
                error: evaluacion.error,
                tipoError: evaluacion.tipoError,
                codigoError: evaluacion.codigoError
            });
        }
    }

    return { correctas, noDisponibles };
}

function cancelarTemporizadorReconexion(linea) {
    if (linea?.temporizadorReconexion) {
        clearTimeout(linea.temporizadorReconexion);
        linea.temporizadorReconexion = null;
    }

    if (linea) linea.proximoIntentoReconexion = null;
}

function cancelarTemporizadorIntentoConexion(linea) {
    if (linea?.temporizadorIntentoConexion) {
        clearTimeout(linea.temporizadorIntentoConexion);
        linea.temporizadorIntentoConexion = null;
    }
}

function cancelarTemporizadorEstabilidadConexion(linea) {
    if (linea?.temporizadorEstabilidadConexion) {
        clearTimeout(linea.temporizadorEstabilidadConexion);
        linea.temporizadorEstabilidadConexion = null;
    }
}

function invalidarConexionActual(linea) {
    cancelarTemporizadorIntentoConexion(linea);
    cancelarTemporizadorEstabilidadConexion(linea);
    cancelarGuardadoActividadContactos(linea, true);
    linea.promesaActividadContactos = Promise.resolve();
    linea.generacionConexion = (Number(linea.generacionConexion) || 0) + 1;
    return linea.generacionConexion;
}

function conexionSigueVigente(lineaId, linea, generacion, socket = null) {
    return lineas.get(lineaId) === linea &&
        linea.generacionConexion === generacion &&
        (!socket || linea.socket === socket);
}

function cerrarSocketSeguro(socket, motivo) {
    try {
        if (socket && typeof socket.end === 'function') {
            socket.end(new Error(motivo));
        }
    } catch (error) {
        console.log(`No se pudo cerrar un socket anterior: ${error.message}`);
    }
}

function programarConfirmacionEstabilidad(lineaId, linea, generacion, socket) {
    cancelarTemporizadorEstabilidadConexion(linea);

    if (!linea.conexionEnVerificacion) return;
    const mensajeAlProgramar = linea.ultimoError;

    linea.temporizadorEstabilidadConexion = setTimeout(() => {
        if (
            !conexionSigueVigente(lineaId, linea, generacion, socket) ||
            linea.estado !== 'conectado'
        ) {
            return;
        }

        linea.temporizadorEstabilidadConexion = null;
        linea.intentosReconexion = 0;
        linea.conexionEnVerificacion = false;
        if (linea.ultimoError === mensajeAlProgramar) {
            linea.ultimoError = null;
        }
        guardarLineas();
    }, VENTANA_ESTABILIDAD_CONEXION_MS);
}

function programarWatchdogConexion(lineaId, linea, generacion, socket) {
    cancelarTemporizadorIntentoConexion(linea);

    linea.temporizadorIntentoConexion = setTimeout(() => {
        if (
            !conexionSigueVigente(lineaId, linea, generacion, socket) ||
            ['conectado', 'esperando_qr'].includes(linea.estado)
        ) {
            return;
        }

        linea.temporizadorIntentoConexion = null;
        const mensaje =
            `La conexión no respondió en ${TIEMPO_MAXIMO_INTENTO_CONEXION_MS / 1000} segundos.`;

        invalidarConexionActual(linea);
        linea.socket = null;
        linea.jid = null;
        linea.qr = null;
        linea.iniciando = false;
        linea.reconexionManualEnCurso = false;
        linea.estado = 'desconectado';
        linea.etiqueta = 'caida';
        linea.conexionEnVerificacion = false;
        linea.ultimaDesconexion = new Date().toISOString();
        linea.ultimoCodigoDesconexion = DisconnectReason.timedOut;
        linea.ultimoError = mensaje;
        registrarCorteDesconexion(linea, mensaje, DisconnectReason.timedOut);
        guardarLineas();
        cerrarSocketSeguro(socket, 'Tiempo de conexión agotado');
        programarReconexionAutomatica(
            lineaId,
            mensaje,
            DisconnectReason.timedOut
        );
    }, TIEMPO_MAXIMO_INTENTO_CONEXION_MS);
}

function bloquearReconexionAutomatica(linea, mensaje, codigo = null, estado = 'requiere_intervencion') {
    cancelarTemporizadorReconexion(linea);
    invalidarConexionActual(linea);
    linea.socket = null;
    linea.jid = null;
    linea.qr = null;
    linea.iniciando = false;
    linea.reconexionManualEnCurso = false;
    linea.estado = estado;
    linea.etiqueta = 'caida';
    linea.conexionEnVerificacion = false;
    linea.reconexionBloqueada = true;
    linea.ultimoCodigoDesconexion = codigo !== null &&
        codigo !== undefined &&
        Number.isFinite(Number(codigo))
        ? Number(codigo)
        : null;
    linea.ultimoError = mensaje ||
        'La reconexión automática se detuvo. Se requiere intervención manual.';
    guardarLineas();
}

function programarReconexionAutomatica(
    lineaId,
    mensaje,
    codigo = null,
    retrasoForzadoMs = null
) {
    const linea = lineas.get(lineaId);
    if (
        !linea ||
        linea.eliminando ||
        linea.reconexionBloqueada ||
        linea.temporizadorReconexion
    ) {
        return false;
    }

    const intentosRealizados = Math.max(0, Number(linea.intentosReconexion) || 0);
    if (intentosRealizados >= MAXIMOS_INTENTOS_RECONEXION) {
        bloquearReconexionAutomatica(
            linea,
            `La línea no pudo reconectarse después de ${MAXIMOS_INTENTOS_RECONEXION} intentos. ` +
                'Usá Reconectar cuando quieras volver a intentarlo.',
            codigo
        );
        return false;
    }

    const siguienteIntento = intentosRealizados + 1;
    const retrasoCalculado = RETRASOS_RECONEXION_MS[intentosRealizados] ||
        RETRASOS_RECONEXION_MS[RETRASOS_RECONEXION_MS.length - 1];
    const retraso = retrasoForzadoMs !== null &&
        retrasoForzadoMs !== undefined &&
        Number.isFinite(Number(retrasoForzadoMs))
        ? Math.max(0, Number(retrasoForzadoMs))
        : retrasoCalculado;
    linea.estado = 'reconectando';
    linea.etiqueta = 'caida';
    linea.conexionEnVerificacion = false;
    linea.ultimoCodigoDesconexion = codigo !== null &&
        codigo !== undefined &&
        Number.isFinite(Number(codigo))
        ? Number(codigo)
        : null;
    linea.proximoIntentoReconexion = new Date(Date.now() + retraso).toISOString();
    linea.ultimoError = `${mensaje || 'La línea se desconectó.'} ` +
        `Reintento automático ${siguienteIntento} de ${MAXIMOS_INTENTOS_RECONEXION}.`;

    linea.temporizadorReconexion = setTimeout(() => {
        const actual = lineas.get(lineaId);
        if (!actual || actual.eliminando || actual.reconexionBloqueada) return;

        actual.temporizadorReconexion = null;
        actual.proximoIntentoReconexion = null;
        actual.intentosReconexion = siguienteIntento;
        actual.conexionEnVerificacion = false;
        guardarLineas();
        iniciarWhatsApp(lineaId);
    }, retraso);

    guardarLineas();
    return true;
}

function solicitarReconexionManual(linea, retrasoMs = 350) {
    const socketAnterior = linea.socket;
    registrarCorteDesconexion(
        linea,
        `La línea ${linea.nombre} fue desconectada para una reconexión manual.`,
        'RECONEXION_MANUAL'
    );

    cancelarTemporizadorReconexion(linea);
    cancelarReintentoAudiencia(linea);
    invalidarConexionActual(linea);

    linea.reconexionManualEnCurso = true;
    linea.reconexionBloqueada = false;
    linea.intentosReconexion = 0;
    linea.ultimoCodigoDesconexion = null;
    linea.proximoIntentoReconexion = null;
    linea.socket = null;
    linea.jid = null;
    linea.qr = null;
    linea.iniciando = false;
    linea.estado = 'reconectando';
    linea.etiqueta = 'caida';
    linea.conexionEnVerificacion = false;
    linea.ultimoError = 'Reconexión manual en curso.';
    guardarLineas();

    cerrarSocketSeguro(socketAnterior, 'Reconexión manual solicitada');

    setTimeout(() => {
        const actual = lineas.get(linea.id);
        if (
            !actual ||
            actual.eliminando ||
            !actual.reconexionManualEnCurso
        ) return;

        iniciarWhatsApp(actual.id);
    }, retrasoMs);
}

function ponerLineaEnCuarentenaPorEnvio(linea, socket, mensaje) {
    if (!linea) return;

    // La desconexión puede haber separado el socket antes de que la promesa de
    // envío termine. La revisión humana debe quedar registrada igualmente.
    linea.requiereRevisionEnvio = true;
    linea.motivoRevisionEnvio = mensaje;
    linea.revisionEnvioDesde = new Date().toISOString();

    if (linea.socket !== socket) {
        guardarLineas();
        return;
    }

    cancelarReintentoAudiencia(linea);
    cancelarTemporizadorReconexion(linea);
    invalidarConexionActual(linea);
    linea.socket = null;
    linea.jid = null;
    linea.qr = null;
    linea.iniciando = false;
    linea.reconexionManualEnCurso = false;
    linea.estado = 'desconectado';
    linea.etiqueta = 'caida';
    linea.conexionEnVerificacion = false;
    linea.ultimaDesconexion = new Date().toISOString();
    linea.ultimoCodigoDesconexion = DisconnectReason.timedOut;
    linea.ultimoError = mensaje;
    guardarLineas();

    cerrarSocketSeguro(socket, 'Envío sin confirmación; socket en cuarentena');
    programarReconexionAutomatica(
        linea.id,
        mensaje,
        DisconnectReason.timedOut
    );
}

async function iniciarWhatsApp(lineaId) {
    const linea = lineas.get(lineaId);

    if (
        !linea ||
        linea.iniciando ||
        (linea.reconexionBloqueada && !linea.reconexionManualEnCurso)
    ) {
        return;
    }

    cancelarTemporizadorIntentoConexion(linea);
    cancelarTemporizadorEstabilidadConexion(linea);
    const generacionConexion = (Number(linea.generacionConexion) || 0) + 1;
    linea.generacionConexion = generacionConexion;

    asegurarAudienciaEstados(linea);
    asegurarActividadContactos(linea);

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
        if (!conexionSigueVigente(lineaId, linea, generacionConexion)) return;

        const sesionExistente = state.creds.registered === true;

        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: Browsers.windows('Desktop'),
            syncFullHistory: false
        });

        linea.socket = sock;
        linea.iniciando = false;
        programarWatchdogConexion(
            lineaId,
            linea,
            generacionConexion,
            sock
        );

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

        const registrarActividad = datos => {
            encolarActividadContactos(linea, sock, () =>
                procesarActividadContactos(linea, sock, datos)
            );
        };

        // contacts.upsert proviene de la libreta sincronizada. No usamos los
        // contactos del historial de chats porque también contiene personas
        // no guardadas y podría exponerles un estado por error.
        sock.ev.on('contacts.upsert', contactos => {
            procesarContactos(contactos, true);
            registrarActividad({ contactos });
        });
        sock.ev.on('contacts.update', contactos => {
            procesarContactos(contactos, false);
            registrarActividad({ contactos });
        });

        sock.ev.on('messages.upsert', actualizacion => {
            registrarActividad({ mensajes: actualizacion?.messages });
        });

        sock.ev.on('messaging-history.set', historial => {
            registrarActividad({
                mensajes: historial?.messages,
                chats: historial?.chats,
                contactos: historial?.contacts,
                mapeos: historial?.lidPnMappings
            });
        });

        sock.ev.on('chats.upsert', chats => {
            registrarActividad({ chats });
        });

        sock.ev.on('chats.update', chats => {
            registrarActividad({ chats });
        });

        sock.ev.on('lid-mapping.update', mapeo => {
            registrarActividad({ mapeos: [mapeo] });
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
            if (
                linea.socket !== sock ||
                linea.generacionConexion !== generacionConexion
            ) return;

            if (qr) {
                try {
                    const qrGenerado = await QRCode.toDataURL(qr);
                    if (
                        !conexionSigueVigente(
                            lineaId,
                            linea,
                            generacionConexion,
                            sock
                        ) ||
                        linea.estado === 'conectado'
                    ) return;

                    cancelarTemporizadorIntentoConexion(linea);
                    linea.qr = qrGenerado;
                    linea.estado = 'esperando_qr';
                } catch (error) {
                    if (
                        !conexionSigueVigente(
                            lineaId,
                            linea,
                            generacionConexion,
                            sock
                        ) ||
                        linea.estado === 'conectado'
                    ) return;
                    linea.estado = 'error';
                    console.error(`No se pudo convertir el QR de ${linea.nombre}:`, error);
                }
            }

            if (connection === 'open') {
                const debeVerificarEstabilidad =
                    linea.conexionEnVerificacion === true ||
                    linea.reconexionManualEnCurso ||
                    (Number(linea.intentosReconexion) || 0) > 0;
                cancelarReintentoAudiencia(linea);
                cancelarTemporizadorReconexion(linea);
                cancelarTemporizadorIntentoConexion(linea);
                cancelarTemporizadorEstabilidadConexion(linea);
                linea.socket = sock;
                linea.qr = null;
                linea.estado = 'conectado';
                linea.etiqueta = 'activa';
                linea.reconexionManualEnCurso = false;
                linea.reconexionBloqueada = false;
                linea.conexionEnVerificacion = debeVerificarEstabilidad;
                linea.ultimoCodigoDesconexion = null;
                linea.proximoIntentoReconexion = null;
                linea.resincronizandoAudiencia = false;
                linea.intentosResincronizacionAudiencia = 0;
                linea.ultimaConexion = new Date().toISOString();
                linea.ultimoError = debeVerificarEstabilidad
                    ? `Conexión restablecida. Verificando estabilidad antes de reiniciar el contador de intentos.`
                    : null;
                linea.jid = jidNormalizedUser(sock.user.id);
                guardarLineas();
                programarConfirmacionEstabilidad(
                    lineaId,
                    linea,
                    generacionConexion,
                    sock
                );

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
                if (linea.eliminando) {
                    cancelarReintentoAudiencia(linea);
                    cancelarTemporizadorReconexion(linea);
                    cancelarTemporizadorIntentoConexion(linea);
                    cancelarTemporizadorEstabilidadConexion(linea);
                    linea.socket = null;
                    linea.jid = null;
                    return;
                }

                const codigoError = obtenerCodigoError(lastDisconnect?.error);
                const mensajeDesconexion = codigoError
                    ? `WhatsApp cerró la conexión (código ${codigoError}).`
                    : 'WhatsApp cerró la conexión.';

                cancelarReintentoAudiencia(linea);
                cancelarTemporizadorReconexion(linea);
                invalidarConexionActual(linea);
                linea.socket = null;
                linea.jid = null;
                linea.qr = null;
                linea.iniciando = false;
                linea.reconexionManualEnCurso = false;
                linea.etiqueta = 'caida';
                linea.conexionEnVerificacion = false;
                linea.ultimaDesconexion = new Date().toISOString();
                linea.ultimoCodigoDesconexion = codigoError;

                registrarCorteDesconexion(
                    linea,
                    mensajeDesconexion,
                    codigoError
                );

                if (codigoError === 401) {
                    linea.estado = 'sesion_cerrada';
                    linea.ultimoError = 'La sesión de WhatsApp fue cerrada.';
                    linea.contactosEstado = new Set();
                    linea.privacidadEstados = null;
                    linea.audienciaResincronizada = false;
                    linea.promesaContactosEstado = Promise.resolve();
                    linea.audienciaEstadosCargada = true;
                    limpiarActividadContactos(linea);
                    try {
                        fs.rmSync(carpetaSesion, { recursive: true, force: true });
                    } catch (error) {
                        console.error(
                            `No se pudo limpiar la sesión cerrada de ${linea.nombre}:`,
                            error.message
                        );
                    }
                    bloquearReconexionAutomatica(
                        linea,
                        'La sesión fue cerrada. Reconectá manualmente la línea para escanear un nuevo QR.',
                        codigoError,
                        'sesion_cerrada'
                    );
                } else if (CODIGOS_DESCONEXION_FATAL.has(codigoError)) {
                    bloquearReconexionAutomatica(
                        linea,
                        `${mensajeDesconexion} La sesión requiere intervención manual.`,
                        codigoError
                    );
                } else {
                    linea.estado = 'desconectado';
                    linea.ultimoError = mensajeDesconexion;
                    guardarLineas();
                    programarReconexionAutomatica(
                        lineaId,
                        mensajeDesconexion,
                        codigoError
                    );
                }
            }
        });

        sock.ev.on('creds.update', actualizacion => {
            if (!conexionSigueVigente(
                lineaId,
                linea,
                generacionConexion,
                sock
            )) return;

            Promise.resolve().then(() => saveCreds(actualizacion)).catch(error => {
                console.error(
                    `No se pudieron guardar las credenciales de ${linea.nombre}:`,
                    error.message
                );
            });
        });
    } catch (error) {
        if (!conexionSigueVigente(lineaId, linea, generacionConexion)) return;

        invalidarConexionActual(linea);
        linea.iniciando = false;
        linea.reconexionManualEnCurso = false;
        linea.socket = null;
        linea.jid = null;
        linea.estado = 'desconectado';
        linea.etiqueta = 'caida';
        linea.conexionEnVerificacion = false;
        linea.ultimaDesconexion = new Date().toISOString();
        linea.ultimoCodigoDesconexion = obtenerCodigoError(error);
        linea.ultimoError = error.message || 'No se pudo iniciar la línea.';
        registrarCorteDesconexion(
            linea,
            linea.ultimoError,
            linea.ultimoCodigoDesconexion
        );
        if (CODIGOS_DESCONEXION_FATAL.has(linea.ultimoCodigoDesconexion)) {
            bloquearReconexionAutomatica(
                linea,
                `${linea.ultimoError} La sesión requiere intervención manual.`,
                linea.ultimoCodigoDesconexion
            );
        } else {
            guardarLineas();
            programarReconexionAutomatica(
                lineaId,
                linea.ultimoError,
                linea.ultimoCodigoDesconexion
            );
        }
        console.error(`Error iniciando ${linea.nombre}:`, error);
    }
}

async function esperarIntervaloPublicacion(ms, esSecuencial = false) {
    let segundos = Math.ceil(ms / 1000);
    progresoPublicacion.proximoGrupoSegundos = segundos;
    progresoPublicacion.proximaLineaSegundos = esSecuencial ? segundos : 0;

    while (segundos > 0) {
        verificarCorteDesconexion();
        await esperar(1000);
        verificarCorteDesconexion();
        segundos -= 1;
        progresoPublicacion.proximoGrupoSegundos = segundos;
        progresoPublicacion.proximaLineaSegundos = esSecuencial ? segundos : 0;
    }
}

function calcularIntervaloSecuencialMs(intervaloSegundos, variacionSegundos) {
    const variacion = Math.max(0, Number(variacionSegundos) || 0);
    const adicional = variacion > 0
        ? crypto.randomInt(0, Math.floor(variacion) + 1)
        : 0;

    return (Math.max(10, Number(intervaloSegundos) || 45) + adicional) * 1000;
}

function registrarLineasOmitidasPorCorte(idsLineas, error) {
    const resueltas = new Set([
        ...progresoPublicacion.lineasCorrectas.map(item => item.id),
        ...progresoPublicacion.lineasFallidas.map(item => item.id)
    ]);
    const codigoError = error?.codigoErrorCorte ||
        (error?.codigoDesconexion !== undefined
            ? formatearCodigoCorte(error.codigoDesconexion)
            : error?.codigo) ||
        'PUBLICACION_INTERRUMPIDA';

    for (const id of idsLineas) {
        if (resueltas.has(id)) continue;

        const linea = lineas.get(id);
        progresoPublicacion.lineasFallidas.push({
            id,
            nombre: linea?.nombre || 'Línea no encontrada',
            error: 'No se procesó porque la publicación se detuvo antes de llegar a esta línea.',
            tipoError: 'omitida_por_corte',
            codigoError,
            fase: 'no_procesada',
            reintentable: true,
            envioConfirmado: false,
            envioIncierto: false,
            reintentoSeguro: true
        });
        progresoPublicacion.noProcesadas += 1;
    }
}

async function ejecutarPublicacion({
    idsLineas,
    rutaImagen,
    texto,
    modoRitmo,
    intervaloSegundos,
    variacionSegundos,
    lineasPorGrupo,
    intervaloMinutos,
    maximoDestinatariosPorEstado,
    origen,
    historialOrigenId = null
}) {
    if (!fs.existsSync(rutaImagen)) {
        throw new Error('No se encontró la imagen que se debía publicar.');
    }

    idsLineas = normalizarIdsLineas(idsLineas);
    if (!idsLineas.length) {
        throw new Error('La publicación no contiene líneas válidas.');
    }

    modoRitmo = normalizarModoRitmo(modoRitmo, 'secuencial');
    intervaloSegundos = limitarNumero(intervaloSegundos, 45, 10, 3600, true);
    variacionSegundos = Math.min(
        intervaloSegundos,
        limitarNumero(variacionSegundos, 0, 0, 30, true)
    );
    lineasPorGrupo = limitarNumero(lineasPorGrupo, 10, 1, 10, true);
    intervaloMinutos = limitarNumero(intervaloMinutos, 5, 0, 1440);
    maximoDestinatariosPorEstado = normalizarLimiteDestinatariosEstado(
        maximoDestinatariosPorEstado
    );
    const tamanoGrupo = modoRitmo === 'secuencial' ? 1 : lineasPorGrupo;

    controlSeguridadPublicacion = crearControlSeguridadPublicacion(idsLineas);
    const total = idsLineas.length;
    let registroHistorial = null;
    progresoPublicacion = {
        ...crearProgresoVacio(),
        activo: true,
        estado: 'preparando',
        origen,
        total,
        modoRitmo,
        maximoDestinatariosPorEstado,
        mensaje: 'Preparando publicación...'
    };

    try {
        const imagenLeida = fs.readFileSync(rutaImagen);
        const textoLimpio = String(texto || '').trim();
        registroHistorial = crearRegistroHistorial({
        idsLineas,
        rutaImagen,
        texto: textoLimpio,
        modoRitmo,
        intervaloSegundos,
        variacionSegundos,
        lineasPorGrupo,
        intervaloMinutos,
        maximoDestinatariosPorEstado,
            origen
        });
        marcarReintentoHistorial(
            historialOrigenId,
            idsLineas,
            registroHistorial.id
        );
    const { correctas: lineasDisponibles, noDisponibles } =
        obtenerLineasDisponibles(idsLineas);

    const totalGrupos = Math.ceil(Math.max(total, 1) / tamanoGrupo);
    const fallosIniciales = noDisponibles.map(linea => ({
        ...linea,
        tipoError: linea.tipoError || 'desconexion',
        codigoError: linea.codigoError || 'LINEA_NO_CONECTADA',
        fase: 'preparacion',
        reintentable: false,
        envioConfirmado: false,
        envioIncierto: false,
        reintentoSeguro: true
    }));

    progresoPublicacion = {
        activo: true,
        estado: 'publicando',
        origen,
        total,
        procesadas: noDisponibles.length,
        correctas: 0,
        fallidas: noDisponibles.length,
        noProcesadas: 0,
        grupoActual: 0,
        totalGrupos,
        proximoGrupoSegundos: 0,
        proximaLineaSegundos: 0,
        sincronizacionAudienciaSegundos: 0,
        modoRitmo,
        maximoDestinatariosPorEstado,
        lineaActual: null,
        lineasCorrectas: [],
        lineasFallidas: fallosIniciales,
        seguridadActiva: false,
        fallosGrupoActual: 0,
        totalGrupoActual: 0,
        limiteFallosSeguridad: configuracion.limiteFallosSeguridad,
        tipoErrorCorte: null,
        codigoErrorCorte: null,
        lineaCorte: null,
        mensajeErrorCorte: null,
        mensajeSeguridad: '',
        altoTotalSolicitado: false,
        altoTotalSolicitadoEn: null,
        envioEnCurso: false,
        mensaje: 'Preparando publicación...'
    };

        if (noDisponibles.length > 0) {
            const primera = noDisponibles[0];
            const esDesconexion = primera.tipoError === 'desconexion';
            progresoPublicacion.tipoErrorCorte = primera.tipoError || 'desconexion';
            progresoPublicacion.codigoErrorCorte =
                primera.codigoError || 'LINEA_NO_CONECTADA';
            progresoPublicacion.lineaCorte = {
                id: primera.id,
                nombre: primera.nombre
            };
            throw crearErrorPublicacion(
                esDesconexion
                    ? 'DETENIDA_DESCONEXION'
                    : 'DETENIDA_SEGURIDAD_LINEA',
                progresoPublicacion.tipoErrorCorte,
                `Publicación detenida antes de comenzar: ${primera.error}`,
                {
                    lineaId: primera.id,
                    lineaNombre: primera.nombre,
                    preflight: true,
                    reintentable: false
                }
            );
        }

        const limitesSincronizacionAudiencia =
            prepararSincronizacionAudienciasPublicacion(lineasDisponibles);
        const controlPublicacionActual = controlSeguridadPublicacion;
        let fallosEvaluablesDesdeCorte = 0;

        for (
            let inicio = 0;
            inicio < lineasDisponibles.length;
            inicio += tamanoGrupo
        ) {
            verificarCorteDesconexion();
            const grupo = lineasDisponibles.slice(inicio, inicio + tamanoGrupo);

            progresoPublicacion.grupoActual =
                Math.floor(inicio / tamanoGrupo) + 1;
            progresoPublicacion.estado = 'publicando';
            progresoPublicacion.proximoGrupoSegundos = 0;
            progresoPublicacion.proximaLineaSegundos = 0;
            progresoPublicacion.seguridadActiva = false;
            progresoPublicacion.mensajeSeguridad = '';
            progresoPublicacion.mensaje =
                modoRitmo === 'secuencial'
                    ? `Publicando línea ${inicio + 1} de ${total}.`
                    : `Publicando tanda ${progresoPublicacion.grupoActual} de ${totalGrupos}.`;

            let fallosTotalesGrupo = 0;
            let huboIntentoEnvioGrupo = false;

            // Incluso el modo por grupos se procesa en serie. Esto permite
            // detener la ejecución antes de que otra línea quede en vuelo.
            for (
                let indiceEnGrupo = 0;
                indiceEnGrupo < grupo.length;
                indiceEnGrupo += 1
            ) {
                const linea = grupo[indiceEnGrupo];
                verificarCorteDesconexion();
                progresoPublicacion.lineaActual = {
                    id: linea.id,
                    nombre: linea.nombre,
                    numero: linea.jid ? linea.jid.split('@')[0] : null,
                    indice: progresoPublicacion.procesadas + 1,
                    total
                };

                const socketUsado = linea.socket;
                let fase = 'preparacion';
                let contabilizarLinea = true;

                try {
                    const evaluacionInicial = evaluarLineaParaPublicar(
                        linea,
                        socketUsado
                    );
                    if (!evaluacionInicial.lista) {
                        throw crearErrorPublicacion(
                            evaluacionInicial.codigoError,
                            evaluacionInicial.tipoError,
                            evaluacionInicial.error,
                            {
                                reintentable: false,
                                reintentoSeguro: true
                            }
                        );
                    }

                    fase = 'audiencia';
                    const limiteSincronizacion =
                        limitesSincronizacionAudiencia.get(linea.id);

                    if (
                        !audienciaEstadosLista(linea) &&
                        Number.isFinite(limiteSincronizacion) &&
                        limiteSincronizacion > Date.now()
                    ) {
                        progresoPublicacion.estado =
                            'esperando_sincronizacion_audiencia';
                        progresoPublicacion.sincronizacionAudienciaSegundos =
                            Math.ceil((limiteSincronizacion - Date.now()) / 1000);
                        progresoPublicacion.mensaje =
                            `Esperando que ${linea.nombre} termine de sincronizar ` +
                            'su audiencia (máximo 1 minuto para toda la publicación).';
                    }

                    const destinatariosEstado = await esperarOperacionPublicacion(
                        obtenerDestinatariosEstado(linea, {
                            limiteSincronizacion,
                            limiteDestinatarios:
                                maximoDestinatariosPorEstado,
                            controlPublicacion: controlPublicacionActual
                        }),
                        {
                            timeoutMs: TIEMPO_MAXIMO_AUDIENCIA_MS,
                            codigoTimeout: 'AUDIENCIA_SIN_RESPUESTA',
                            tipoTimeout: 'sincronizacion_audiencia',
                            mensajeTimeout:
                                `La audiencia de ${linea.nombre} no respondió a tiempo. ` +
                                'La línea se omitió sin detener las demás.'
                        }
                    );
                    progresoPublicacion.estado = 'publicando';
                    progresoPublicacion.sincronizacionAudienciaSegundos = 0;
                    verificarCorteDesconexion();

                    const evaluacionAntesDeEnviar = evaluarLineaParaPublicar(
                        linea,
                        socketUsado
                    );
                    if (!evaluacionAntesDeEnviar.lista) {
                        throw crearErrorPublicacion(
                            evaluacionAntesDeEnviar.codigoError,
                            evaluacionAntesDeEnviar.tipoError,
                            evaluacionAntesDeEnviar.error,
                            {
                                reintentable: false,
                                reintentoSeguro: true
                            }
                        );
                    }

                    verificarCorteDesconexion();
                    const contenido = { image: imagenLeida };
                    if (textoLimpio) contenido.caption = textoLimpio;

                    fase = 'envio';
                    huboIntentoEnvioGrupo = true;
                    const promesaEnvioRegistrado = Promise.resolve(
                        socketUsado.sendMessage(
                            'status@broadcast',
                            contenido,
                            {
                                statusJidList: destinatariosEstado,
                                broadcast: true
                            }
                        )
                    ).then(mensajeEstado => {
                        try {
                            registrarEstadoActivo(
                                registroHistorial,
                                linea,
                                mensajeEstado,
                                destinatariosEstado
                            );
                        } catch (errorRegistro) {
                            throw crearErrorPublicacion(
                                'REGISTRO_ESTADO_FALLIDO',
                                'registro_local',
                                `WhatsApp confirmó el estado en ${linea.nombre}, ` +
                                    `pero no se pudo guardar su ID: ${errorRegistro.message}`,
                                {
                                    fasePublicacion: 'registro',
                                    reintentable: false,
                                    envioConfirmado: true,
                                    envioIncierto: false,
                                    reintentoSeguro: false,
                                    causa: errorRegistro
                                }
                            );
                        }

                        return mensajeEstado;
                    });

                    progresoPublicacion.envioEnCurso = true;
                    try {
                        await esperarOperacionPublicacion(
                            promesaEnvioRegistrado,
                            {
                                timeoutMs: TIEMPO_MAXIMO_ENVIO_MS,
                                codigoTimeout: 'TIEMPO_ENVIO_AGOTADO',
                                tipoTimeout: 'envio_incierto',
                                mensajeTimeout:
                                    `WhatsApp no confirmó a tiempo el envío en ${linea.nombre}. ` +
                                    'No se continuará para evitar publicaciones duplicadas.',
                                envioEnVuelo: true
                            }
                        );
                    } finally {
                        progresoPublicacion.envioEnCurso = false;
                    }

                    fase = 'registro';

                    progresoPublicacion.correctas += 1;
                    progresoPublicacion.lineasCorrectas.push({
                        id: linea.id,
                        nombre: linea.nombre,
                        numero: linea.jid ? linea.jid.split('@')[0] : null,
                        destinatarios:
                            linea.ultimaSeleccionAudienciaEstado?.seleccionados ??
                            destinatariosEstado.length,
                        audienciaTotal:
                            linea.ultimaSeleccionAudienciaEstado?.total ??
                            destinatariosEstado.length,
                        audienciaBase:
                            linea.ultimaSeleccionAudienciaEstado?.baseReciente ??
                            destinatariosEstado.length,
                        limiteDestinatarios:
                            linea.ultimaSeleccionAudienciaEstado
                                ?.limiteConfigurado ??
                            maximoDestinatariosPorEstado,
                        destinatariosOmitidos:
                            linea.ultimaSeleccionAudienciaEstado?.omitidos ?? 0,
                        destinatariosOmitidosPorLimite:
                            linea.ultimaSeleccionAudienciaEstado
                                ?.omitidosPorLimite ?? 0,
                        destinatariosFueraBase:
                            linea.ultimaSeleccionAudienciaEstado
                                ?.omitidosFueraBase ?? 0,
                        priorizacionAudiencia:
                            linea.ultimaSeleccionAudienciaEstado
                                ?.priorizacionAudiencia || null
                    });
                    linea.ultimaPublicacion = new Date().toISOString();
                    linea.ultimoError = null;
                    linea.fallosRecientes = 0;
                } catch (error) {
                    progresoPublicacion.sincronizacionAudienciaSegundos = 0;
                    if (
                        progresoPublicacion.estado ===
                        'esperando_sincronizacion_audiencia'
                    ) {
                        progresoPublicacion.estado = 'publicando';
                    }

                    if (error?.codigo === 'DETENIDA_ALTO_TOTAL') {
                        contabilizarLinea = false;
                        throw error;
                    }

                    const faseFallo = error?.fasePublicacion || fase;

                    const clasificacion = clasificarErrorPublicacion(
                        error,
                        linea,
                        socketUsado,
                        faseFallo
                    );
                    const fallo = {
                        id: linea.id,
                        nombre: linea.nombre,
                        error: error.message || 'Error desconocido',
                        tipoError: clasificacion.tipoError,
                        codigoError: clasificacion.codigoError,
                        fase: faseFallo,
                        reintentable: clasificacion.reintentable,
                        envioConfirmado: clasificacion.envioConfirmado,
                        envioIncierto: clasificacion.envioIncierto,
                        reintentoSeguro: clasificacion.reintentoSeguro
                    };

                    progresoPublicacion.fallidas += 1;
                    progresoPublicacion.lineasFallidas.push(fallo);
                    fallosTotalesGrupo += 1;
                    linea.ultimoError = fallo.error;
                    linea.fallosRecientes = (Number(linea.fallosRecientes) || 0) + 1;
                    console.error(`Error publicando en ${linea.nombre}:`, error);

                    if (clasificacion.tipoError === 'desconexion') {
                        if (clasificacion.envioIncierto) {
                            ponerLineaEnCuarentenaPorEnvio(
                                linea,
                                socketUsado,
                                fallo.error
                            );
                        }
                        registrarCorteDesconexion(
                            linea,
                            fallo.error,
                            obtenerCodigoError(error)
                        );
                        if (
                            clasificacion.envioIncierto &&
                            controlSeguridadPublicacion.corteDesconexion
                        ) {
                            controlSeguridadPublicacion.corteDesconexion.envioIncierto = true;
                        }
                        progresoPublicacion.tipoErrorCorte ||= 'desconexion';
                        progresoPublicacion.codigoErrorCorte ||= fallo.codigoError;
                        progresoPublicacion.lineaCorte ||= {
                            id: linea.id,
                            nombre: linea.nombre
                        };
                        progresoPublicacion.mensajeErrorCorte ||= fallo.error;
                        verificarCorteDesconexion();
                    }

                    if (clasificacion.tipoError === 'limite_temporal') {
                        if (clasificacion.envioIncierto) {
                            ponerLineaEnCuarentenaPorEnvio(
                                linea,
                                socketUsado,
                                fallo.error
                            );
                        }
                        progresoPublicacion.tipoErrorCorte = 'limite_temporal';
                        progresoPublicacion.codigoErrorCorte = fallo.codigoError;
                        progresoPublicacion.lineaCorte = {
                            id: linea.id,
                            nombre: linea.nombre
                        };
                        throw crearErrorPublicacion(
                            'DETENIDA_LIMITE_TEMPORAL',
                            'limite_temporal',
                            `Publicación detenida por una limitación temporal en ${linea.nombre}.`,
                            {
                                lineaId: linea.id,
                                lineaNombre: linea.nombre,
                                duracionEnfriamientoMs:
                                    obtenerDuracionEnfriamientoLimite(error),
                                reintentable: false,
                                envioIncierto: clasificacion.envioIncierto,
                                reintentoSeguro: !clasificacion.envioIncierto
                            }
                        );
                    }

                    if (clasificacion.tipoError === 'envio_incierto') {
                        ponerLineaEnCuarentenaPorEnvio(
                            linea,
                            socketUsado,
                            fallo.error
                        );
                        progresoPublicacion.tipoErrorCorte = 'envio_incierto';
                        progresoPublicacion.codigoErrorCorte = fallo.codigoError;
                        progresoPublicacion.lineaCorte = {
                            id: linea.id,
                            nombre: linea.nombre
                        };
                        progresoPublicacion.mensajeErrorCorte = fallo.error;
                        throw crearErrorPublicacion(
                            'DETENIDA_ENVIO_INCIERTO',
                            'envio_incierto',
                            fallo.error,
                            {
                                lineaId: linea.id,
                                lineaNombre: linea.nombre,
                                reintentable: false,
                                reintentoSeguro: false
                            }
                        );
                    }

                    // Si Alto total se solicitó mientras este error se estaba
                    // resolviendo, no debemos entrar después en una nueva
                    // pausa de seguridad que ya no tendría quién resolver.
                    if (controlSeguridadPublicacion.altoTotal) {
                        verificarCorteDesconexion();
                    }

                    if (![
                        'sincronizacion_audiencia',
                        'limite_audiencia'
                    ].includes(clasificacion.tipoError)) {
                        fallosEvaluablesDesdeCorte += 1;

                        const quedanLineas =
                            inicio + indiceEnGrupo + 1 < lineasDisponibles.length;

                        if (
                            quedanLineas &&
                            fallosEvaluablesDesdeCorte >=
                                configuracion.limiteFallosSeguridad
                        ) {
                            progresoPublicacion.estado = 'detenido_seguridad';
                            progresoPublicacion.seguridadActiva = true;
                            progresoPublicacion.proximoGrupoSegundos = 0;
                            progresoPublicacion.proximaLineaSegundos = 0;
                            progresoPublicacion.fallosGrupoActual =
                                fallosTotalesGrupo;
                            progresoPublicacion.totalGrupoActual = grupo.length;
                            progresoPublicacion.limiteFallosSeguridad =
                                configuracion.limiteFallosSeguridad;
                            progresoPublicacion.mensajeSeguridad =
                                `Se alcanzó el límite de ` +
                                `${configuracion.limiteFallosSeguridad} línea(s) con fallos. ` +
                                `El último error ocurrió en ${linea.nombre}.`;
                            progresoPublicacion.mensaje =
                                'Publicación pausada por seguridad antes de continuar con otra línea.';
                            notificarEscritorio(
                                'Publicación pausada',
                                progresoPublicacion.mensajeSeguridad
                            );
                            guardarLineas();

                            const decision = await esperarDecisionSeguridad();
                            verificarCorteDesconexion();

                            if (decision === 'cancelar') {
                                throw crearErrorPublicacion(
                                    'CANCELADA_SEGURIDAD',
                                    'cancelacion_manual',
                                    'Publicación cancelada manualmente después del corte de seguridad.',
                                    { reintentable: false }
                                );
                            }

                            fallosEvaluablesDesdeCorte = 0;
                            progresoPublicacion.estado = 'publicando';
                            progresoPublicacion.seguridadActiva = false;
                            progresoPublicacion.mensajeSeguridad = '';
                            progresoPublicacion.mensaje =
                                'Control de seguridad confirmado. Continuando con la próxima línea.';
                        }
                    }
                } finally {
                    progresoPublicacion.sincronizacionAudienciaSegundos = 0;
                    if (contabilizarLinea) {
                        progresoPublicacion.procesadas += 1;
                    }
                    guardarLineas();
                }
            }

            verificarCorteDesconexion();
            const quedanGrupos =
                inicio + tamanoGrupo < lineasDisponibles.length;

            progresoPublicacion.fallosGrupoActual = fallosTotalesGrupo;
            progresoPublicacion.totalGrupoActual = grupo.length;
            progresoPublicacion.limiteFallosSeguridad =
                configuracion.limiteFallosSeguridad;

            progresoPublicacion.lineaActual = null;

            if (
                quedanGrupos &&
                modoRitmo === 'secuencial' &&
                huboIntentoEnvioGrupo
            ) {
                const pausaMs = calcularIntervaloSecuencialMs(
                    intervaloSegundos,
                    variacionSegundos
                );
                progresoPublicacion.estado = 'esperando_siguiente_linea';
                progresoPublicacion.mensaje =
                    'Pausa de seguridad antes de publicar en la siguiente línea.';
                await esperarIntervaloPublicacion(pausaMs, true);
            } else if (
                quedanGrupos &&
                intervaloMinutos > 0 &&
                huboIntentoEnvioGrupo
            ) {
                progresoPublicacion.estado = 'esperando_siguiente_grupo';
                progresoPublicacion.mensaje =
                    'Esperando para comenzar la siguiente tanda.';
                await esperarIntervaloPublicacion(intervaloMinutos * 60 * 1000, false);
            }
        }

        progresoPublicacion.activo = false;
        progresoPublicacion.estado = progresoPublicacion.fallidas > 0
            ? 'completado_con_errores'
            : 'completado';
        progresoPublicacion.seguridadActiva = false;
        progresoPublicacion.proximoGrupoSegundos = 0;
        progresoPublicacion.proximaLineaSegundos = 0;
        progresoPublicacion.sincronizacionAudienciaSegundos = 0;
        progresoPublicacion.lineaActual = null;
        progresoPublicacion.mensaje =
            `Publicación completada: ${progresoPublicacion.correctas} correctas ` +
            `y ${progresoPublicacion.fallidas} fallidas.`;
        finalizarRegistroHistorial(
            registroHistorial,
            progresoPublicacion.fallidas > 0 ? 'completado_con_errores' : 'completado'
        );
        notificarEscritorio('Publicación finalizada', progresoPublicacion.mensaje);

        return {
            correctas: progresoPublicacion.correctas,
            fallidas: progresoPublicacion.fallidas
        };
    } catch (error) {
        progresoPublicacion.activo = false;
        progresoPublicacion.seguridadActiva = false;
        progresoPublicacion.proximoGrupoSegundos = 0;
        progresoPublicacion.proximaLineaSegundos = 0;
        progresoPublicacion.sincronizacionAudienciaSegundos = 0;
        progresoPublicacion.envioEnCurso = false;
        progresoPublicacion.lineaActual = null;
        registrarLineasOmitidasPorCorte(idsLineas, error);

        if (error.codigo === 'DETENIDA_ALTO_TOTAL') {
            progresoPublicacion.estado = 'detenido_alto_total';
        } else if (error.codigo === 'CANCELADA_SEGURIDAD') {
            progresoPublicacion.estado = 'cancelado_seguridad';
        } else if (error.codigo === 'DETENIDA_DESCONEXION') {
            progresoPublicacion.estado = 'detenido_desconexion';
        } else if (error.codigo === 'DETENIDA_LIMITE_TEMPORAL') {
            progresoPublicacion.estado = 'detenido_limite_temporal';
        } else if (error.codigo === 'DETENIDA_ENVIO_INCIERTO') {
            progresoPublicacion.estado = 'detenido_envio_incierto';
        } else if (error.codigo === 'DETENIDA_SEGURIDAD_LINEA') {
            progresoPublicacion.estado = 'detenido_seguridad_linea';
        } else {
            progresoPublicacion.estado = 'error';
        }

        progresoPublicacion.tipoErrorCorte =
            progresoPublicacion.tipoErrorCorte || error.tipoError || 'desconocido';
        progresoPublicacion.codigoErrorCorte =
            progresoPublicacion.codigoErrorCorte ||
            error.codigoErrorCorte ||
            (error.codigoDesconexion !== undefined
                ? formatearCodigoCorte(error.codigoDesconexion)
                : error.codigo) ||
            'ERROR_PUBLICACION';
        progresoPublicacion.mensajeErrorCorte =
            progresoPublicacion.mensajeErrorCorte ||
            error.mensajeCorte ||
            error.message;
        if (!progresoPublicacion.lineaCorte && error.lineaId) {
            progresoPublicacion.lineaCorte = {
                id: error.lineaId,
                nombre: error.lineaNombre || 'Línea sin nombre'
            };
        }
        progresoPublicacion.mensaje =
            error.codigo === 'DETENIDA_ALTO_TOTAL'
                ? `Alto total aplicado: ${progresoPublicacion.correctas} ` +
                    `estado(s) confirmado(s) conservaron su ID y ` +
                    `${progresoPublicacion.noProcesadas} línea(s) no se iniciaron.`
                : error.message;
        activarProteccionMiddlewarePorError(error);
        const lineasOmitidas = progresoPublicacion.lineasFallidas.filter(
            item => item.fase === 'no_procesada'
        );
        error.resultadoParcial = {
            total,
            procesadas: progresoPublicacion.procesadas,
            correctas: progresoPublicacion.correctas,
            fallidas: progresoPublicacion.fallidas,
            noProcesadas: progresoPublicacion.noProcesadas,
            lineasOmitidas: lineasOmitidas.map(item => ({
                id: item.id,
                nombre: item.nombre
            })),
            tipoErrorCorte: progresoPublicacion.tipoErrorCorte,
            codigoErrorCorte: progresoPublicacion.codigoErrorCorte,
            lineaCorte: progresoPublicacion.lineaCorte
        };
        const estadoHistorial =
            error.codigo === 'DETENIDA_ALTO_TOTAL'
                ? 'detenido_alto_total'
                : error.codigo === 'CANCELADA_SEGURIDAD'
                ? 'cancelado'
                : error.codigo === 'DETENIDA_DESCONEXION'
                    ? 'detenido_desconexion'
                    : error.codigo === 'DETENIDA_LIMITE_TEMPORAL'
                        ? 'detenido_limite_temporal'
                        : error.codigo === 'DETENIDA_ENVIO_INCIERTO'
                            ? 'detenido_envio_incierto'
                            : error.codigo === 'DETENIDA_SEGURIDAD_LINEA'
                                ? 'detenido_seguridad_linea'
                                : 'error';
        if (registroHistorial) {
            finalizarRegistroHistorial(
                registroHistorial,
                estadoHistorial,
                progresoPublicacion.mensaje
            );
        }
        notificarEscritorio(
            error.codigo === 'DETENIDA_ALTO_TOTAL'
                ? 'Publicación detenida'
                : 'Error en la publicación',
            progresoPublicacion.mensaje
        );
        throw error;
    } finally {
        controlSeguridadPublicacion = crearControlSeguridadPublicacion();
    }
}

function encolarPublicacion(datosPublicacion) {
    try {
        verificarMiddlewarePublicacion();
    } catch (error) {
        return Promise.reject(error);
    }

    const datosEncolados = {
        ...datosPublicacion,
        maximoDestinatariosPorEstado: normalizarLimiteDestinatariosEstado(
            datosPublicacion?.maximoDestinatariosPorEstado,
            normalizarLimiteDestinatariosEstado(
                configuracion.maximoDestinatariosPorEstado
            )
        )
    };
    const generacionEncolada = generacionColaPublicaciones;
    let rechazarCancelacion = null;
    let cancelacionEmitida = false;
    const promesaCancelacion = new Promise((resolve, reject) => {
        rechazarCancelacion = reject;
    });
    const trabajoEncolado = {
        generacion: generacionEncolada,
        cancelado: false,
        cancelar: () => {
            if (cancelacionEmitida) return;
            cancelacionEmitida = true;
            rechazarCancelacion?.(
                crearErrorPublicacion(
                    'CANCELADA_ALTO_TOTAL_EN_COLA',
                    'cancelacion_manual',
                    'La publicación fue cancelada por Alto total antes de comenzar.',
                    {
                        reintentable: false,
                        envioConfirmado: false,
                        envioIncierto: false,
                        reintentoSeguro: true
                    }
                )
            );
        }
    };
    trabajosPendientesPublicacion.add(trabajoEncolado);
    publicacionesPendientes = trabajosPendientesPublicacion.size;

    const tareaSerial = colaPublicaciones.then(async () => {
        trabajosPendientesPublicacion.delete(trabajoEncolado);
        publicacionesPendientes = trabajosPendientesPublicacion.size;

        if (
            trabajoEncolado.cancelado ||
            generacionEncolada !== generacionColaPublicaciones
        ) {
            throw crearErrorPublicacion(
                'CANCELADA_ALTO_TOTAL_EN_COLA',
                'cancelacion_manual',
                'La publicación fue cancelada por Alto total antes de comenzar.',
                {
                    reintentable: false,
                    envioConfirmado: false,
                    envioIncierto: false,
                    reintentoSeguro: true
                }
            );
        }

        return ejecutarPublicacion(datosEncolados);
    });

    colaPublicaciones = tareaSerial.catch(() => {});
    return Promise.race([tareaSerial, promesaCancelacion]);
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
        await ejecutarProgramacion(programacion.id, {
            claveEjecucion: crearClaveEjecucionProgramada(programacion)
        });
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

function obtenerFechaLocalClave(fecha = new Date()) {
    const ano = fecha.getFullYear();
    const mes = String(fecha.getMonth() + 1).padStart(2, '0');
    const dia = String(fecha.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
}

function crearClaveEjecucionProgramada(programacion, fecha = new Date()) {
    return [
        'programada',
        programacion.id,
        obtenerFechaLocalClave(fecha),
        programacion.hora
    ].join(':');
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
        const claveEjecucion = crearClaveEjecucionProgramada(
            programacion,
            horaDeHoy
        );
        setTimeout(
            () => ejecutarProgramacion(programacion.id, { claveEjecucion }),
            2000
        );
    }
}

async function ejecutarProgramacion(id, { claveEjecucion = null } = {}) {
    const programacion = programaciones.get(id);

    if (!programacion || programacion.activa === false) return;
    if (['en_cola', 'ejecutando'].includes(programacion.estado)) return;
    if (claveEjecucion && programacion.ultimaClaveEjecucion === claveEjecucion) {
        return;
    }

    programacion.ultimaClaveEjecucion = claveEjecucion;
    programacion.ultimaClaveReservadaEn = new Date().toISOString();
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
            modoRitmo: programacion.modoRitmo,
            intervaloSegundos: programacion.intervaloSegundos,
            variacionSegundos: programacion.variacionSegundos,
            lineasPorGrupo: programacion.lineasPorGrupo,
            intervaloMinutos: programacion.intervaloMinutos,
            origen: `programación diaria ${programacion.id}`
        });

        programacion.estado = programacion.activa === false ? 'pausado' : 'programado';
        programacion.ultimaEjecucion = new Date().toISOString();
        programacion.ultimoResultado = {
            correctas: resultado.correctas,
            fallidas: resultado.fallidas,
            noProcesadas: 0
        };
        programacion.mensaje =
            `Última ejecución: ${resultado.correctas} correctas y ` +
            `${resultado.fallidas} fallidas.`;
    } catch (error) {
        programacion.estado = programacion.activa === false ? 'pausado' : 'programado';
        programacion.ultimaEjecucion = new Date().toISOString();
        const parcial = error.resultadoParcial || {
            correctas: 0,
            fallidas: 0,
            noProcesadas: programacion.idsLineas.length,
            tipoErrorCorte: error.tipoError || 'desconocido',
            codigoErrorCorte: error.codigo || 'ERROR_PUBLICACION',
            lineaCorte: null
        };
        programacion.ultimoResultado = {
            correctas: parcial.correctas,
            fallidas: parcial.fallidas,
            noProcesadas: parcial.noProcesadas,
            tipoErrorCorte: parcial.tipoErrorCorte,
            codigoErrorCorte: parcial.codigoErrorCorte,
            lineaCorte: parcial.lineaCorte,
            error: error.message
        };
        programacion.mensaje =
            `Último intento: ${parcial.correctas} correctas, ` +
            `${parcial.fallidas} fallidas y ${parcial.noProcesadas} no procesadas. ` +
            error.message;
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
            const modoRitmoOriginal = item.modoRitmo;
            item.modoRitmo = normalizarModoRitmo(item.modoRitmo, 'grupos');
            item.intervaloSegundos = limitarNumero(
                item.intervaloSegundos,
                45,
                10,
                3600,
                true
            );
            item.variacionSegundos = Math.min(
                item.intervaloSegundos,
                limitarNumero(item.variacionSegundos, 0, 0, 30, true)
            );
            item.lineasPorGrupo = limitarNumero(
                item.lineasPorGrupo,
                10,
                1,
                10,
                true
            );
            item.intervaloMinutos = limitarNumero(
                item.intervaloMinutos,
                5,
                0,
                1440
            );
            if (modoRitmoOriginal !== item.modoRitmo) huboMigracion = true;

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

    if (
        req.body.modoRitmo !== undefined &&
        !MODOS_RITMO_PUBLICACION.has(req.body.modoRitmo)
    ) {
        eliminarArchivoSeguro(rutaTemporalFoto);
        return { error: 'El modo de ritmo seleccionado no es válido.' };
    }

    const modoRitmo = normalizarModoRitmo(
        req.body.modoRitmo,
        configuracion.modoRitmoPredeterminado
    );
    const intervaloSegundos = Number(
        req.body.intervaloSegundos ?? configuracion.intervaloSegundosPredeterminado
    );
    const variacionSegundos = Number(
        req.body.variacionSegundos ?? configuracion.variacionSegundosPredeterminada
    );
    const lineasPorGrupo = Number(
        req.body.lineasPorGrupo ?? configuracion.lineasPorGrupoPredeterminado
    );
    const intervaloMinutos = Number(
        req.body.intervaloMinutos ?? configuracion.intervaloMinutosPredeterminado
    );

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
        lineasPorGrupo > 10
    ) {
        eliminarArchivoSeguro(rutaTemporalFoto);
        return { error: 'La cantidad de líneas por grupo debe estar entre 1 y 10.' };
    }

    if (
        !Number.isFinite(intervaloMinutos) ||
        intervaloMinutos < 0 ||
        intervaloMinutos > 1440
    ) {
        eliminarArchivoSeguro(rutaTemporalFoto);
        return { error: 'El intervalo debe estar entre 0 y 1440 minutos.' };
    }

    if (
        !Number.isInteger(intervaloSegundos) ||
        intervaloSegundos < 10 ||
        intervaloSegundos > 3600
    ) {
        eliminarArchivoSeguro(rutaTemporalFoto);
        return { error: 'El intervalo secuencial debe estar entre 10 y 3600 segundos.' };
    }

    if (
        !Number.isInteger(variacionSegundos) ||
        variacionSegundos < 0 ||
        variacionSegundos > 30 ||
        variacionSegundos > intervaloSegundos
    ) {
        eliminarArchivoSeguro(rutaTemporalFoto);
        return {
            error: 'La distribución de carga debe estar entre 0 y 30 segundos y no superar el intervalo base.'
        };
    }

    return {
        idsLineas,
        modoRitmo,
        intervaloSegundos,
        variacionSegundos,
        lineasPorGrupo,
        intervaloMinutos
    };
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
        etiqueta: 'indefinida',
        socket: null,
        jid: null,
        qr: null,
        estado: 'iniciando',
        iniciando: false,
        eliminando: false,
        temporizadorReconexion: null,
        temporizadorIntentoConexion: null,
        temporizadorEstabilidadConexion: null,
        temporizadorAudiencia: null,
        generacionConexion: 0,
        reconexionManualEnCurso: false,
        resincronizandoAudiencia: false,
        intentosResincronizacionAudiencia: 0,
        ultimaConexion: null,
        ultimaPublicacion: null,
        ultimoError: null,
        fallosRecientes: 0,
        intentosReconexion: 0,
        conexionEnVerificacion: false,
        reconexionBloqueada: false,
        requiereRevisionEnvio: false,
        motivoRevisionEnvio: null,
        revisionEnvioDesde: null,
        ultimaDesconexion: null,
        ultimoCodigoDesconexion: null,
        proximoIntentoReconexion: null,
        contactosEstado: new Set(),
        privacidadEstados: null,
        audienciaResincronizada: false,
        promesaContactosEstado: Promise.resolve(),
        audienciaEstadosCargada: true,
        ultimaInteraccionContactos: new Map(),
        mapeosActividadContactos: new Map(),
        actividadContactosCargada: true,
        actividadContactosSucia: false,
        temporizadorActividadContactos: null,
        promesaActividadContactos: Promise.resolve(),
        tareasActividadPendientes: 0,
        fechaUltimaInteraccionContactos: 0,
        ultimaSeleccionAudienciaEstado: null,
        revisionPriorizacionAudiencia: 0,
        cacheResumenPriorizacionAudiencia: null
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
        .map(linea => {
            const evaluacionPublicacion = evaluarLineaParaPublicar(linea);
            const priorizacionAudiencia =
                obtenerResumenPriorizacionAudiencia(linea);
            const destinatariosEstadoTotales =
                Number(priorizacionAudiencia.audienciaEfectiva) || 0;
            const destinatariosEstadoBase =
                Number(priorizacionAudiencia.baseReciente) || 0;
            const limiteDestinatariosEstado =
                Number(priorizacionAudiencia.limiteConfigurado) ||
                MAXIMO_DESTINATARIOS_ESTADO;
            const destinatariosEstado = Math.min(
                destinatariosEstadoBase,
                limiteDestinatariosEstado
            );

            return {
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
            intentosReconexion: Number(linea.intentosReconexion) || 0,
            conexionEnVerificacion: linea.conexionEnVerificacion === true,
            listaParaPublicar: evaluacionPublicacion.lista,
            codigoBloqueoPublicacion: evaluacionPublicacion.codigoError,
            motivoBloqueoPublicacion: evaluacionPublicacion.error,
            requiereRevisionEnvio: linea.requiereRevisionEnvio === true,
            motivoRevisionEnvio: linea.motivoRevisionEnvio || null,
            revisionEnvioDesde: linea.revisionEnvioDesde || null,
            maximosIntentosReconexion: MAXIMOS_INTENTOS_RECONEXION,
            reconexionBloqueada: linea.reconexionBloqueada === true,
            ultimaDesconexion: linea.ultimaDesconexion || null,
            ultimoCodigoDesconexion: linea.ultimoCodigoDesconexion ?? null,
            proximoIntentoReconexion: linea.proximoIntentoReconexion || null,
            contactosEstado: linea.contactosEstado?.size || 0,
            destinatariosEstado,
            destinatariosEstadoBase,
            limiteDestinatariosEstado,
            destinatariosEstadoTotales,
            destinatariosEstadoOmitidos: Math.max(
                0,
                destinatariosEstadoTotales - destinatariosEstado
            ),
            destinatariosEstadoOmitidosPorLimite: Math.max(
                0,
                destinatariosEstadoBase - destinatariosEstado
            ),
            destinatariosEstadoFueraBase: Math.max(
                0,
                destinatariosEstadoTotales - destinatariosEstadoBase
            ),
            audienciaEstadosLista: audienciaEstadosLista(linea),
            priorizacionAudiencia
            };
        });

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

app.post('/lineas/:id/habilitar-publicaciones', (req, res) => {
    const linea = lineas.get(req.params.id);
    if (!linea) {
        return res.status(404).json({ error: 'La línea no existe.' });
    }

    if (req.body?.confirmar !== true) {
        return res.status(400).json({
            error: 'Debés confirmar manualmente que revisaste el envío incierto.'
        });
    }

    linea.requiereRevisionEnvio = false;
    linea.motivoRevisionEnvio = null;
    linea.revisionEnvioDesde = null;
    guardarLineas();

    const evaluacion = evaluarLineaParaPublicar(linea);
    res.json({
        mensaje: evaluacion.lista
            ? `${linea.nombre} quedó habilitada para publicar.`
            : `La revisión fue confirmada. ${evaluacion.error}`,
        listaParaPublicar: evaluacion.lista,
        motivoBloqueoPublicacion: evaluacion.error
    });
});

app.get('/progreso', (req, res) => {
    res.json({
        ...progresoPublicacion,
        publicacionesPendientes,
        ocupada:
            progresoPublicacion.activo === true ||
            publicacionesPendientes > 0,
        proteccionMiddleware: obtenerVistaProteccionMiddleware()
    });
});

app.post('/progreso/alto-total', (req, res) => {
    const resultado = solicitarAltoTotalPublicacion();

    res.json({
        mensaje: resultado.habiaTrabajo
            ? resultado.activa
                ? 'Alto total solicitado. Se detendrá antes de iniciar otra línea.'
                : 'La publicación pendiente fue cancelada antes de comenzar.'
            : 'No hay publicaciones activas ni pendientes para detener.',
        ...resultado
    });
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
        mensaje: 'Publicación reanudada. Se continuará con la próxima línea.'
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

app.post(
    '/subir',
    middlewareIdempotencia('subir'),
    middlewareSeguridadPublicacion,
    upload.single('imagen'),
    middlewareSeguridadPublicacion,
    (req, res) => {
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

    const {
        idsLineas,
        modoRitmo,
        intervaloSegundos,
        variacionSegundos,
        lineasPorGrupo,
        intervaloMinutos
    } = validacion;

    res.status(202).json({
        mensaje: `Publicación iniciada para ${idsLineas.length} línea(s).`
    });

    encolarPublicacion({
        idsLineas,
        rutaImagen: rutaTemporalFoto,
        texto: String(req.body.texto || ''),
        modoRitmo,
        intervaloSegundos,
        variacionSegundos,
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
    }
);

app.post(
    '/programar',
    middlewareIdempotencia('programar'),
    upload.single('imagen'),
    (req, res) => {
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

    const {
        idsLineas,
        modoRitmo,
        intervaloSegundos,
        variacionSegundos,
        lineasPorGrupo,
        intervaloMinutos
    } = validacion;
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
        modoRitmo,
        intervaloSegundos,
        variacionSegundos,
        lineasPorGrupo,
        intervaloMinutos,
        rutaImagen,
        nombreArchivo: req.file.originalname,
        estado: 'programado',
        mensaje: 'Esperando la próxima ejecución programada.',
        creadoEn: new Date().toISOString(),
        actualizadoEn: new Date().toISOString(),
        ultimaEjecucion: null,
        ultimaClaveEjecucion: null,
        ultimaClaveReservadaEn: null,
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
    }
);

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
            modoRitmo: normalizarModoRitmo(item.modoRitmo, 'grupos'),
            intervaloSegundos: item.intervaloSegundos,
            variacionSegundos: item.variacionSegundos,
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

app.post(
    '/programaciones/:id/ejecutar',
    middlewareIdempotencia('ejecutar-programacion'),
    middlewareSeguridadPublicacion,
    (req, res) => {
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

    ejecutarProgramacion(programacion.id, {
        claveEjecucion: `manual:${req.get('Idempotency-Key')}`
    })
        .catch(error => console.error('No se pudo ejecutar la programación:', error))
        .finally(() => {
            programacion.activa = estabaActiva;
            programacion.estado = estabaActiva ? 'programado' : 'pausado';
            if (!estabaActiva) cancelarTrabajoProgramado(programacion.id);
            guardarProgramaciones();
        });
    }
);

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
        ultimaClaveEjecucion: null,
        ultimaClaveReservadaEn: null,
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

app.post(
    '/historial/:id/reintentar-fallidas',
    middlewareIdempotencia('reintentar-historial'),
    middlewareSeguridadPublicacion,
    (req, res) => {
    const registro = historialPublicaciones.find(item => item.id === req.params.id);

    if (!registro) {
        return res.status(404).json({ error: 'El registro no existe.' });
    }

    const idsLineas = [...new Set(
        (registro.lineasFallidas || [])
            .filter(linea =>
                linea?.envioConfirmado !== true &&
                linea?.reintentoSeguro === true &&
                !linea?.reintentadaEn
            )
            .map(linea => linea.id)
            .filter(Boolean)
    )];

    if (!idsLineas.length) {
        return res.status(409).json({
            error: 'Este registro no tiene líneas que sea seguro volver a publicar.'
        });
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
        modoRitmo: normalizarModoRitmo(registro.modoRitmo, 'grupos'),
        intervaloSegundos: limitarNumero(
            registro.intervaloSegundos,
            45,
            10,
            3600,
            true
        ),
        variacionSegundos: limitarNumero(
            registro.variacionSegundos,
            0,
            0,
            30,
            true
        ),
        lineasPorGrupo: Math.min(10, registro.lineasPorGrupo || 10, idsLineas.length),
        intervaloMinutos: registro.intervaloMinutos || 0,
        origen: `reintento del historial ${registro.id}`,
        historialOrigenId: registro.id
    }).catch(error => {
        console.error('Falló el reintento del historial:', error);
    });
    }
);

app.get('/configuracion', (req, res) => {
    res.json(configuracion);
});

app.put('/configuracion', (req, res) => {
    const limiteFallos = Number(req.body.limiteFallosSeguridad);
    const modoRitmo = req.body.modoRitmoPredeterminado;
    const intervaloSegundos = Number(req.body.intervaloSegundosPredeterminado);
    const variacionSegundos = Number(req.body.variacionSegundosPredeterminada);
    const lineasPorGrupo = Number(req.body.lineasPorGrupoPredeterminado);
    const intervalo = Number(req.body.intervaloMinutosPredeterminado);
    const maximoDestinatarios = Number(req.body.maximoDestinatariosPorEstado);

    if (
        !Number.isInteger(limiteFallos) ||
        limiteFallos < 1 ||
        limiteFallos > 10
    ) {
        return res.status(400).json({
            error: 'El corte de seguridad debe estar entre 1 y 10 líneas con fallos.'
        });
    }

    if (!MODOS_RITMO_PUBLICACION.has(modoRitmo)) {
        return res.status(400).json({
            error: 'El modo de ritmo predeterminado no es válido.'
        });
    }

    if (
        !Number.isInteger(intervaloSegundos) ||
        intervaloSegundos < 10 ||
        intervaloSegundos > 3600
    ) {
        return res.status(400).json({
            error: 'El intervalo secuencial debe estar entre 10 y 3600 segundos.'
        });
    }

    if (
        !Number.isInteger(variacionSegundos) ||
        variacionSegundos < 0 ||
        variacionSegundos > 30 ||
        variacionSegundos > intervaloSegundos
    ) {
        return res.status(400).json({
            error: 'La distribución de carga debe estar entre 0 y 30 segundos y no superar el intervalo base.'
        });
    }

    if (!Number.isInteger(lineasPorGrupo) || lineasPorGrupo < 1 || lineasPorGrupo > 10) {
        return res.status(400).json({
            error: 'Las líneas por grupo deben estar entre 1 y 10.'
        });
    }

    if (!Number.isFinite(intervalo) || intervalo < 0 || intervalo > 1440) {
        return res.status(400).json({
            error: 'El intervalo debe estar entre 0 y 1440 minutos.'
        });
    }

    if (
        !Number.isInteger(maximoDestinatarios) ||
        maximoDestinatarios < MINIMO_DESTINATARIOS_ESTADO ||
        maximoDestinatarios > MAXIMO_DESTINATARIOS_ESTADO
    ) {
        return res.status(400).json({
            error: `Los destinatarios por estado deben estar entre ` +
                `${MINIMO_DESTINATARIOS_ESTADO} y ` +
                `${MAXIMO_DESTINATARIOS_ESTADO}.`
        });
    }

    configuracion = {
        ...configuracion,
        limiteFallosSeguridad: limiteFallos,
        notificaciones: req.body.notificaciones !== false,
        modoRitmoPredeterminado: modoRitmo,
        intervaloSegundosPredeterminado: intervaloSegundos,
        variacionSegundosPredeterminada: variacionSegundos,
        lineasPorGrupoPredeterminado: lineasPorGrupo,
        intervaloMinutosPredeterminado: intervalo,
        maximoDestinatariosPorEstado: maximoDestinatarios
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

        solicitarReconexionManual(linea, 250);
        cantidad += 1;
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

    solicitarReconexionManual(linea, 500);

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

    registrarCorteDesconexion(
        linea,
        `La línea ${linea.nombre} fue eliminada durante la publicación.`,
        'LINEA_ELIMINADA'
    );
    linea.eliminando = true;
    invalidarConexionActual(linea);
    limpiarActividadContactos(linea);

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

process.once('exit', () => {
    for (const linea of lineas.values()) {
        if (
            !linea.actividadContactosCargada ||
            !linea.actividadContactosSucia
        ) {
            continue;
        }

        cancelarGuardadoActividadContactos(linea, true);
    }
});

app.listen(PUERTO_SERVIDOR, '127.0.0.1', () => {
    console.log(
        `AutoStatues funcionando en http://127.0.0.1:${PUERTO_SERVIDOR}`
    );

    cargarConfiguracion();
    cargarProteccionMiddleware();
    cargarClavesIdempotencia();
    cargarEstadosActivos();
    cargarHistorial();
    cargarLineasGuardadas();

    for (const linea of lineas.values()) {
        if (linea.reconexionBloqueada) continue;

        const proximoIntento = Date.parse(linea.proximoIntentoReconexion || '');
        if (Number.isFinite(proximoIntento)) {
            programarReconexionAutomatica(
                linea.id,
                linea.ultimoError || 'Reconexión pendiente restaurada.',
                linea.ultimoCodigoDesconexion,
                Math.max(0, proximoIntento - Date.now())
            );
        } else {
            iniciarWhatsApp(linea.id);
        }
    }

    cargarProgramaciones();
});
