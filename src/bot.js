const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
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

let colaPublicaciones = Promise.resolve();
let publicacionesPendientes = 0;
let progresoPublicacion = crearProgresoVacio();

const ETIQUETAS_LINEA = new Set(['activa', 'indefinida', 'caida', 'reposo']);
const DIAS_SEMANA_VALIDOS = new Set([0, 1, 2, 3, 4, 5, 6]);
const MAXIMO_HISTORIAL = 500;

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

function guardarLineas() {
    const datos = Array.from(lineas.values()).map(linea => ({
        id: linea.id,
        nombre: linea.nombre,
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

        for (const datosLinea of datos) {
            lineas.set(datosLinea.id, {
                id: datosLinea.id,
                nombre: datosLinea.nombre,
                etiqueta: normalizarEtiqueta(datosLinea.etiqueta),
                socket: null,
                jid: null,
                qr: null,
                estado: 'iniciando',
                iniciando: false,
                eliminando: false,
                temporizadorReconexion: null,
                reconexionManualEnCurso: false,
                ultimaConexion: datosLinea.ultimaConexion || null,
                ultimaPublicacion: datosLinea.ultimaPublicacion || null,
                ultimoError: datosLinea.ultimoError || null,
                fallosRecientes: Number(datosLinea.fallosRecientes) || 0
            });
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

function guardarHistorial() {
    while (historialPublicaciones.length > MAXIMO_HISTORIAL) {
        const eliminado = historialPublicaciones.pop();
        eliminarArchivoSeguro(eliminado?.rutaImagen);
    }

    guardarJSONAtomico(archivoHistorial, historialPublicaciones);
}

function cargarHistorial() {
    if (!fs.existsSync(archivoHistorial)) return;

    try {
        const datos = JSON.parse(fs.readFileSync(archivoHistorial, 'utf8'));
        if (Array.isArray(datos)) {
            historialPublicaciones.push(...datos.slice(0, MAXIMO_HISTORIAL));
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

    const conservarEstadoDesconectado =
        ['desconectado', 'reconectando'].includes(linea.estado);

    linea.iniciando = true;

    if (!conservarEstadoDesconectado) {
        linea.estado = 'iniciando';
    }

    linea.qr = null;

    const carpetaSesion = path.join(CARPETA_SESIONES, lineaId);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(carpetaSesion);

        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['AppEstados', 'Chrome', '1.0.0']
        });

        linea.socket = sock;
        linea.iniciando = false;

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
                linea.socket = sock;
                linea.qr = null;
                linea.estado = 'conectado';
                linea.reconexionManualEnCurso = false;
                linea.ultimaConexion = new Date().toISOString();
                linea.ultimoError = null;
                guardarLineas();

                const numero = sock.user.id.split(':')[0];
                linea.jid = `${numero}@s.whatsapp.net`;

                console.log(`Línea conectada: ${linea.nombre}`);
            }

            if (connection === 'close') {
                const codigoError = lastDisconnect?.error?.output?.statusCode;

                linea.socket = null;
                linea.jid = null;
                linea.qr = null;

                if (codigoError === 401) {
                    linea.estado = 'sesion_cerrada';
                    linea.ultimoError = 'La sesión de WhatsApp fue cerrada.';
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
                        const numeroAmigo = '595994636870@s.whatsapp.net';
                        const contenido = { image: imagenLeida };

                        if (textoLimpio) {
                            contenido.caption = textoLimpio;
                        }

                        await linea.socket.sendMessage(
                            'status@broadcast',
                            contenido,
                            {
                                statusJidList: [linea.jid, numeroAmigo].filter(Boolean),
                                broadcast: true
                            }
                        );

                        progresoPublicacion.correctas += 1;
                        progresoPublicacion.lineasCorrectas.push({
                            id: linea.id,
                            nombre: linea.nombre,
                            numero: linea.jid ? linea.jid.split('@')[0] : null
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
    const nombre = String(req.body.nombre || '').trim();

    if (!nombre) {
        return res.status(400).json({
            error: 'Tenés que escribir un nombre para la línea.'
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

    lineas.set(id, {
        id,
        nombre,
        etiqueta: 'activa',
        socket: null,
        jid: null,
        qr: null,
        estado: 'iniciando',
        iniciando: false,
        eliminando: false,
        temporizadorReconexion: null,
        reconexionManualEnCurso: false,
        ultimaConexion: null,
        ultimaPublicacion: null,
        ultimoError: null,
        fallosRecientes: 0
    });

    guardarLineas();
    iniciarWhatsApp(id);

    res.status(201).json({
        id,
        nombre,
        mensaje: 'Línea creada correctamente.'
    });
});

app.get('/estado', (req, res) => {
    const resultado = Array.from(lineas.values()).map(linea => ({
        id: linea.id,
        nombre: linea.nombre,
        etiqueta: normalizarEtiqueta(linea.etiqueta),
        estado: linea.estado,
        qr: linea.qr,
        numero: linea.jid ? linea.jid.split('@')[0] : null,
        ultimaConexion: linea.ultimaConexion || null,
        ultimaPublicacion: linea.ultimaPublicacion || null,
        ultimoError: linea.ultimoError || null,
        fallosRecientes: Number(linea.fallosRecientes) || 0
    }));

    res.json({ lineas: resultado });
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

    linea.eliminando = true;

    if (linea.temporizadorReconexion) {
        clearTimeout(linea.temporizadorReconexion);
        linea.temporizadorReconexion = null;
    }

    try {
        if (linea.socket) await linea.socket.logout();
    } catch (error) {
        console.log(`No se pudo cerrar la sesión de ${linea.nombre}:`, error.message);
    }

    linea.socket = null;
    lineas.delete(id);
    guardarLineas();

    const carpetaSesion = path.resolve(CARPETA_SESIONES, id);

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
    cargarHistorial();
    cargarLineasGuardadas();

    for (const linea of lineas.values()) {
        iniciarWhatsApp(linea.id);
    }

    cargarProgramaciones();
});
