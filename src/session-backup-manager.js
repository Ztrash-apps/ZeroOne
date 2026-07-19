'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
    createEncryptedSessionBackup,
    fingerprintSessionDirectory,
    verifyEncryptedSessionBackup
} = require('./session-security');
const {
    inspeccionarIdentidadAutenticacionCifrada
} = require('./encrypted-auth-state');

const ID_LINEA_VALIDO = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NOMBRE_RESPALDO_VALIDO = /^session-\d{8}T\d{6}-[a-f0-9]{8}\.z1session$/u;

function dentroDe(raiz, destino) {
    const relativa = path.relative(path.resolve(raiz), path.resolve(destino));
    return Boolean(relativa) && !relativa.startsWith('..') && !path.isAbsolute(relativa);
}

function nombreRespaldo(fecha = new Date()) {
    const marca = fecha.toISOString()
        .replace(/[-:]/gu, '')
        .replace(/\.\d{3}Z$/u, '');
    return `session-${marca}-${crypto.randomBytes(4).toString('hex')}.z1session`;
}

function listarRespaldos(carpeta) {
    if (!fs.existsSync(carpeta)) return [];
    return fs.readdirSync(carpeta, { withFileTypes: true })
        .filter(entrada => entrada.isFile() && NOMBRE_RESPALDO_VALIDO.test(entrada.name))
        .map(entrada => {
            const ruta = path.join(carpeta, entrada.name);
            const stat = fs.lstatSync(ruta);
            return stat.isSymbolicLink()
                ? null
                : { ruta, nombre: entrada.name, mtimeMs: stat.mtimeMs };
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function eliminarRespaldosLineaSeguro({ carpetaRespaldos, id } = {}) {
    const raiz = path.resolve(String(carpetaRespaldos || ''));
    const normalizado = String(id || '').trim();
    if (!ID_LINEA_VALIDO.test(normalizado)) {
        throw new Error('El identificador de la línea no es válido para eliminar respaldos.');
    }
    const destino = path.resolve(raiz, normalizado);
    if (!dentroDe(raiz, destino)) {
        throw new Error('La ruta de respaldos de la línea no es segura.');
    }
    fs.rmSync(destino, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 300
    });
    if (fs.existsSync(destino)) {
        throw new Error('La carpeta de respaldos cifrados no pudo eliminarse por completo.');
    }
    return true;
}

async function sesionTieneIdentidadLocal(carpetaSesion, protector) {
    try {
        const rutaCredenciales = path.join(carpetaSesion, 'creds.json');
        if (fs.existsSync(rutaCredenciales)) {
            const datos = JSON.parse(fs.readFileSync(rutaCredenciales, 'utf8'));
            if (typeof datos?.me?.id === 'string' && datos.me.id.length > 0) {
                return { presente: true, cifrada: false };
            }
        }
    } catch {}

    try {
        const inspeccion = await inspeccionarIdentidadAutenticacionCifrada({
            folder: carpetaSesion,
            protector
        });
        if (inspeccion.cifrada && inspeccion.identidadPresente) {
            return { presente: true, cifrada: true };
        }
    } catch {}

    return { presente: false, cifrada: false };
}

function crearGestorRespaldosSesiones({
    carpetaSesiones,
    carpetaRespaldos,
    protector,
    intervaloMs = 24 * 60 * 60 * 1000,
    retencionPorLinea = 3,
    logger = console,
    alActualizar = () => {}
} = {}) {
    const sesiones = path.resolve(String(carpetaSesiones || ''));
    const respaldos = path.resolve(String(carpetaRespaldos || ''));
    const intervalo = Math.max(60 * 1000, Number(intervaloMs) || 0);
    const retencion = Math.min(10, Math.max(1, Math.round(retencionPorLinea) || 3));
    let tareaActiva = null;
    let temporizador = null;
    const lineasConRespaldoVerificado = new Set();
    const lineasEnEliminacion = new Set();
    const operacionesRespaldoPorLinea = new Map();
    let estado = {
        activo: false,
        total: 0,
        procesadas: 0,
        creadas: 0,
        verificadas: 0,
        omitidas: 0,
        fallidas: 0,
        iniciadaEn: null,
        finalizadaEn: null,
        mensaje: 'Los respaldos cifrados todavía no se comprobaron.'
    };

    if (sesiones === respaldos || dentroDe(sesiones, respaldos)) {
        throw new Error('La carpeta de respaldos debe estar fuera de las sesiones activas.');
    }

    const vista = () => ({ ...estado });
    const actualizar = cambios => {
        estado = { ...estado, ...cambios };
        const actual = vista();
        alActualizar(actual);
        return actual;
    };

    const rutasLinea = id => {
        const normalizado = String(id || '').trim();
        if (!ID_LINEA_VALIDO.test(normalizado)) {
            throw new Error('El identificador de la línea no es válido para respaldar.');
        }
        const origen = path.resolve(sesiones, normalizado);
        const destino = path.resolve(respaldos, normalizado);
        if (!dentroDe(sesiones, origen) || !dentroDe(respaldos, destino)) {
            throw new Error('La ruta de respaldo de la línea no es segura.');
        }
        return { origen, destino };
    };

    const podar = carpeta => {
        const disponibles = listarRespaldos(carpeta);
        for (const antiguo of disponibles.slice(retencion)) {
            if (!dentroDe(respaldos, antiguo.ruta)) continue;
            fs.rmSync(antiguo.ruta, { force: true });
        }
    };

    const respaldarLineaInterna = async (linea, { forzar = false } = {}) => {
        const { origen, destino } = rutasLinea(linea?.id);
        let liberarLectura = null;
        if (typeof linea?.pausarAlmacenAutenticacion === 'function') {
            liberarLectura = await linea.pausarAlmacenAutenticacion();
        } else if (linea?.socket || linea?.iniciando) {
            // El almacén plaintext de Baileys no ofrece un snapshot
            // transaccional. Se copiará en el siguiente arranque, antes de
            // abrir el socket, en lugar de capturar media rotación de claves.
            return { estado: 'omitida', motivo: 'sesion_activa_sin_lease' };
        }

        try {
        const identidad = await sesionTieneIdentidadLocal(origen, protector);
        if (!identidad.presente) {
            lineasConRespaldoVerificado.delete(String(linea?.id || ''));
            return { estado: 'omitida', motivo: 'sin_credenciales' };
        }

        fs.mkdirSync(destino, { recursive: true });
        const existentes = listarRespaldos(destino);
        const reciente = existentes[0];
        if (
            !forzar &&
            reciente &&
            Date.now() - reciente.mtimeMs < intervalo
        ) {
            const huellaSesionActual = await fingerprintSessionDirectory(origen);
            const verificacion = await verifyEncryptedSessionBackup({
                backupPath: reciente.ruta,
                protector
            });
            if (
                !verificacion.valid ||
                (
                    verificacion.loginIdentityPresent !== true &&
                    !identidad.cifrada
                )
            ) {
                throw new Error(
                    'La copia cifrada vigente no conserva una identidad de inicio de sesión válida.'
                );
            }
            if (
                verificacion.sessionFingerprintSha256 === huellaSesionActual
            ) {
                lineasConRespaldoVerificado.add(String(linea.id));
                return {
                    estado: 'verificada',
                    loginIdentityPresent:
                        verificacion.loginIdentityPresent === true ||
                        identidad.cifrada,
                    fileCount: verificacion.fileCount,
                    totalBytes: verificacion.totalBytes,
                    sessionFingerprintSha256:
                        verificacion.sessionFingerprintSha256
                };
            }

            // Un respaldo reciente puede pertenecer a una vinculación anterior.
            // Si no representa byte por byte a la sesión actual, se conserva
            // como historial pero nunca autoriza su migración: se crea uno nuevo.
            lineasConRespaldoVerificado.delete(String(linea?.id || ''));
        }

        const destinoArchivo = path.join(destino, nombreRespaldo());
        const creada = await createEncryptedSessionBackup({
            sessionDir: origen,
            backupPath: destinoArchivo,
            protector
        });
        const verificada = await verifyEncryptedSessionBackup({
            backupPath: destinoArchivo,
            protector
        });
        if (
            !verificada.valid ||
            creada.sessionFingerprintSha256 !==
                verificada.sessionFingerprintSha256 ||
            (
                creada.loginIdentityPresent !== true &&
                !identidad.cifrada
            ) ||
            (
                verificada.loginIdentityPresent !== true &&
                !identidad.cifrada
            )
        ) {
            try { fs.rmSync(destinoArchivo, { force: true }); } catch {}
            throw new Error(
                'La copia cifrada no conservó una identidad de inicio de sesión válida.'
            );
        }
        podar(destino);
        lineasConRespaldoVerificado.add(String(linea.id));
        return {
            estado: 'creada',
            loginIdentityPresent:
                creada.loginIdentityPresent === true || identidad.cifrada,
            fileCount: creada.fileCount,
            totalBytes: creada.totalBytes,
            sessionFingerprintSha256: creada.sessionFingerprintSha256
        };
        } finally {
            liberarLectura?.();
        }
    };

    const respaldarLinea = (linea, opciones = {}) => {
        const id = String(linea?.id || '').trim();
        rutasLinea(id);
        if (lineasEnEliminacion.has(id)) {
            return Promise.resolve({
                estado: 'omitida',
                motivo: 'linea_en_eliminacion'
            });
        }

        const anterior = operacionesRespaldoPorLinea.get(id) ||
            Promise.resolve();
        const actual = anterior
            .catch(() => {})
            .then(() => {
                if (lineasEnEliminacion.has(id)) {
                    return {
                        estado: 'omitida',
                        motivo: 'linea_en_eliminacion'
                    };
                }
                return respaldarLineaInterna(linea, opciones);
            })
            .finally(() => {
                if (operacionesRespaldoPorLinea.get(id) === actual) {
                    operacionesRespaldoPorLinea.delete(id);
                }
            });
        operacionesRespaldoPorLinea.set(id, actual);
        return actual;
    };

    const eliminarLinea = async idOriginal => {
        const id = String(idOriginal || '').trim();
        rutasLinea(id);
        lineasEnEliminacion.add(id);
        lineasConRespaldoVerificado.delete(id);
        await Promise.resolve(operacionesRespaldoPorLinea.get(id))
            .catch(() => {});
        eliminarRespaldosLineaSeguro({
            carpetaRespaldos: respaldos,
            id
        });
        return true;
    };

    const ejecutar = lineas => {
        if (tareaActiva) return tareaActiva;
        const lista = Array.isArray(lineas) ? [...lineas] : [];
        tareaActiva = (async () => {
            actualizar({
                activo: true,
                total: lista.length,
                procesadas: 0,
                creadas: 0,
                verificadas: 0,
                omitidas: 0,
                fallidas: 0,
                iniciadaEn: new Date().toISOString(),
                finalizadaEn: null,
                mensaje: 'Verificando copias cifradas de las sesiones.'
            });

            for (const linea of lista) {
                try {
                    const resultado = await respaldarLinea(linea);
                    actualizar({
                        procesadas: estado.procesadas + 1,
                        creadas: estado.creadas + (resultado.estado === 'creada' ? 1 : 0),
                        verificadas: estado.verificadas + (resultado.estado === 'verificada' ? 1 : 0),
                        omitidas: estado.omitidas + (resultado.estado === 'omitida' ? 1 : 0),
                        mensaje: `Protegiendo ${String(linea?.nombre || 'una línea')}.`
                    });
                } catch (error) {
                    lineasConRespaldoVerificado.delete(String(linea?.id || ''));
                    actualizar({
                        procesadas: estado.procesadas + 1,
                        fallidas: estado.fallidas + 1
                    });
                    logger.warn?.(
                        `No se pudo respaldar ${String(linea?.nombre || 'una línea')}:`,
                        error?.message || error
                    );
                }
            }

            return actualizar({
                activo: false,
                finalizadaEn: new Date().toISOString(),
                mensaje:
                    `Respaldo verificado: ${estado.creadas} nueva(s), ` +
                    `${estado.verificadas} vigente(s), ${estado.fallidas} fallida(s).`
            });
        })().finally(() => {
            tareaActiva = null;
        });
        return tareaActiva;
    };

    const iniciarVerificacionPeriodica = obtenerLineas => {
        if (temporizador) return;
        temporizador = setInterval(() => {
            if (tareaActiva) return;
            Promise.resolve()
                .then(() => obtenerLineas())
                .then(ejecutar)
                .catch(error => logger.error?.(
                    'Falló la verificación periódica de respaldos:',
                    error?.message || error
                ));
        }, Math.max(60 * 60 * 1000, Math.min(intervalo, 6 * 60 * 60 * 1000)));
        temporizador.unref?.();
    };

    return {
        ejecutar,
        respaldarLinea,
        eliminarLinea,
        habilitarLinea(idOriginal) {
            const id = String(idOriginal || '').trim();
            rutasLinea(id);
            lineasEnEliminacion.delete(id);
        },
        tieneRespaldoVerificado: id =>
            lineasConRespaldoVerificado.has(String(id || '')),
        obtenerEstado: vista,
        iniciarVerificacionPeriodica,
        cerrar() {
            if (temporizador) clearInterval(temporizador);
            temporizador = null;
        }
    };
}

module.exports = {
    crearGestorRespaldosSesiones,
    eliminarRespaldosLineaSeguro,
    listarRespaldos,
    nombreRespaldo
};
