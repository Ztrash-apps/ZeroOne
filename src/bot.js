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

app.use(express.json());
app.use(express.static(CARPETA_PUBLIC));

fs.mkdirSync(CARPETA_UPLOADS, { recursive: true });
fs.mkdirSync(CARPETA_SESIONES, { recursive: true });
fs.mkdirSync(CARPETA_PROGRAMADOS, { recursive: true });
fs.mkdirSync(CARPETA_IMAGENES_PROGRAMADAS, { recursive: true });

const upload = multer({ dest: CARPETA_UPLOADS });

const lineas = new Map();
const programaciones = new Map();
const trabajosProgramados = new Map();

const archivoLineas = path.join(CARPETA_SESIONES, 'lineas.json');
const archivoProgramaciones = path.join(CARPETA_PROGRAMADOS, 'programaciones.json');

let colaPublicaciones = Promise.resolve();
let publicacionesPendientes = 0;
let progresoPublicacion = crearProgresoVacio();

const ETIQUETAS_LINEA = new Set(['activa', 'indefinida', 'caida', 'reposo']);
const UMBRAL_FALLOS_SEGURIDAD = 0.8;

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
        etiqueta: normalizarEtiqueta(linea.etiqueta)
    }));

    fs.writeFileSync(
        archivoLineas,
        JSON.stringify(datos, null, 2),
        'utf8'
    );
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
                reconexionManualEnCurso: false
            });
        }

        console.log(`${lineas.size} línea(s) cargada(s).`);
    } catch (error) {
        console.error('No se pudieron cargar las líneas:', error);
    }
}

function guardarProgramaciones() {
    fs.writeFileSync(
        archivoProgramaciones,
        JSON.stringify(Array.from(programaciones.values()), null, 2),
        'utf8'
    );
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
                    fs.rmSync(carpetaSesion, { recursive: true, force: true });
                } else {
                    // La linea permanece marcada como desconectada hasta que
                    // una nueva conexion se abra correctamente.
                    linea.estado = 'desconectado';
                }

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

                        return true;
                    } catch (error) {
                        progresoPublicacion.fallidas += 1;
                        progresoPublicacion.lineasFallidas.push({
                            id: linea.id,
                            nombre: linea.nombre,
                            error: error.message || 'Error desconocido'
                        });

                        console.error(`Error publicando en ${linea.nombre}:`, error);
                        return false;
                    } finally {
                        progresoPublicacion.procesadas += 1;
                    }
                })
            );

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

            if (quedanGrupos && porcentajeFallos >= UMBRAL_FALLOS_SEGURIDAD) {
                progresoPublicacion.estado = 'detenido_seguridad';
                progresoPublicacion.seguridadActiva = true;
                progresoPublicacion.proximoGrupoSegundos = 0;
                progresoPublicacion.mensajeSeguridad =
                    `Fallaron ${fallosGrupo} de ${grupo.length} líneas ` +
                    `(${Math.round(porcentajeFallos * 100)}%) en el grupo ` +
                    `${progresoPublicacion.grupoActual}.`;
                progresoPublicacion.mensaje =
                    'Publicación detenida por seguridad. Corroborá el problema antes de reanudar.';

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

    if (!horaValida(programacion.hora)) {
        throw new Error('La hora programada no es válida.');
    }

    const [hora, minuto] = programacion.hora.split(':').map(Number);
    const regla = new schedule.RecurrenceRule();
    regla.hour = hora;
    regla.minute = minuto;
    regla.second = 0;

    const trabajo = schedule.scheduleJob(regla, async () => {
        await ejecutarProgramacion(programacion.id);
    });

    if (!trabajo) {
        throw new Error('No se pudo crear la programación diaria.');
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
    if (yaSeEjecutoHoy(programacion)) return;

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

    if (!programacion) return;
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

        programacion.estado = 'programado';
        programacion.ultimaEjecucion = new Date().toISOString();
        programacion.ultimoResultado = {
            correctas: resultado.correctas,
            fallidas: resultado.fallidas
        };
        programacion.mensaje =
            `Última ejecución: ${resultado.correctas} correctas y ` +
            `${resultado.fallidas} fallidas.`;
    } catch (error) {
        programacion.estado = 'programado';
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
            item.estado = 'programado';
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
            programarTrabajo(item);
            recuperarEjecucionReciente(item);
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
        reconexionManualEnCurso: false
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
        numero: linea.jid ? linea.jid.split('@')[0] : null
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

    if (!horaValida(hora)) {
        eliminarArchivoSeguro(rutaTemporalFoto);
        return res.status(400).json({
            error: 'Seleccioná una hora válida.'
        });
    }

    const { idsLineas, lineasPorGrupo, intervaloMinutos } = validacion;
    const id = crypto.randomUUID();
    const extension = obtenerExtensionImagen(req.file.originalname);
    const rutaImagen = path.join(CARPETA_IMAGENES_PROGRAMADAS, `${id}${extension}`);

    moverArchivo(rutaTemporalFoto, rutaImagen);

    const programacion = {
        id,
        hora,
        texto: String(req.body.texto || ''),
        idsLineas,
        lineasPorGrupo,
        intervaloMinutos,
        rutaImagen,
        nombreArchivo: req.file.originalname,
        estado: 'programado',
        mensaje: 'Esperando la próxima ejecución diaria.',
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
            mensaje: '✅ Estado diario programado correctamente.',
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

    const hora = String(req.body.hora || programacion.hora).trim();

    if (!horaValida(hora)) {
        eliminarArchivoSeguro(rutaTemporalFoto);
        return res.status(400).json({ error: 'Seleccioná una hora válida.' });
    }

    let nuevaRutaImagen = programacion.rutaImagen;
    let nuevoNombreArchivo = programacion.nombreArchivo;

    if (req.file) {
        const extension = obtenerExtensionImagen(req.file.originalname);
        nuevaRutaImagen = path.join(
            CARPETA_IMAGENES_PROGRAMADAS,
            `${id}-${Date.now()}${extension}`
        );
        nuevoNombreArchivo = req.file.originalname;
        moverArchivo(rutaTemporalFoto, nuevaRutaImagen);
    }

    const rutaImagenAnterior = programacion.rutaImagen;
    const horaAnterior = programacion.hora;

    try {
        programacion.hora = hora;
        programacion.texto = req.body.texto !== undefined
            ? String(req.body.texto)
            : programacion.texto;
        programacion.rutaImagen = nuevaRutaImagen;
        programacion.nombreArchivo = nuevoNombreArchivo;
        programacion.estado = 'programado';
        programacion.mensaje = 'Programación actualizada. Esperando la próxima hora.';
        programacion.actualizadoEn = new Date().toISOString();

        if (horaAnterior !== hora) {
            programarTrabajo(programacion);
        }

        guardarProgramaciones();

        if (req.file && rutaImagenAnterior !== nuevaRutaImagen) {
            eliminarArchivoSeguro(rutaImagenAnterior);
        }

        res.json({
            mensaje: '✅ Programación actualizada correctamente.'
        });
    } catch (error) {
        if (req.file && nuevaRutaImagen !== rutaImagenAnterior) {
            eliminarArchivoSeguro(nuevaRutaImagen);
        }

        programacion.rutaImagen = rutaImagenAnterior;
        programacion.hora = horaAnterior;
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

    cargarLineasGuardadas();

    for (const linea of lineas.values()) {
        iniciarWhatsApp(linea.id);
    }

    cargarProgramaciones();
});
