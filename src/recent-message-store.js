'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { redactarTextoParaIA } = require('./ai-username-detector');

const VERSION_ALMACEN = 1;
const MAXIMO_POR_LINEA = 5000;
const RETENCION_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_SQLITE_KIB = 2048;
const INTERVALO_LIMPIEZA_MS = 60 * 60 * 1000;

function escribirAtomico(ruta, contenido) {
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    const temporal = `${ruta}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(temporal, contenido, { encoding: 'utf8', mode: 0o600 });
    if (process.platform === 'win32' && fs.existsSync(ruta)) {
        fs.rmSync(ruta, { force: true });
    }
    fs.renameSync(temporal, ruta);
}

function timestampMs(valor) {
    const ahora = Date.now();
    let numero;
    if (typeof valor === 'bigint') numero = Number(valor);
    else if (typeof valor === 'number') numero = valor;
    else if (typeof valor === 'string') numero = Number(valor);
    else if (valor && typeof valor.toNumber === 'function') numero = valor.toNumber();
    else if (valor && Number.isInteger(valor.low)) {
        numero = valor.low + (Number(valor.high) || 0) * 0x100000000;
    }
    if (!Number.isFinite(numero) || numero <= 0) return ahora;
    const normalizado = numero < 1e12
        ? Math.trunc(numero * 1000)
        : Math.trunc(numero);
    return normalizado > ahora + 5 * 60 * 1000 ? ahora : normalizado;
}

function cifrarPayload(clave, datos, aad) {
    const iv = crypto.randomBytes(12);
    const cifrador = crypto.createCipheriv('aes-256-gcm', clave, iv);
    cifrador.setAAD(Buffer.from(aad));
    const contenido = Buffer.concat([
        cifrador.update(JSON.stringify(datos), 'utf8'),
        cifrador.final()
    ]);
    return Buffer.concat([iv, cifrador.getAuthTag(), contenido]);
}

function descifrarPayload(clave, contenido, aad) {
    const buffer = Buffer.from(contenido);
    if (buffer.length < 29) throw new Error('Payload cifrado incompleto.');
    const descifrador = crypto.createDecipheriv(
        'aes-256-gcm',
        clave,
        buffer.subarray(0, 12)
    );
    descifrador.setAAD(Buffer.from(aad));
    descifrador.setAuthTag(buffer.subarray(12, 28));
    return JSON.parse(Buffer.concat([
        descifrador.update(buffer.subarray(28)),
        descifrador.final()
    ]).toString('utf8'));
}

function crearErrorClaveIncompatible(errorOriginal) {
    const error = new Error(
        'La clave del almacén de mensajes recientes no puede abrirse con el cifrado local actual.'
    );
    error.code = 'CLAVE_LOCAL_INCOMPATIBLE';
    error.cause = errorOriginal;
    return error;
}

function calcularHuellaArchivo(ruta) {
    const descriptor = fs.openSync(ruta, 'r');
    const hash = crypto.createHash('sha256');
    const bloque = Buffer.allocUnsafe(64 * 1024);
    try {
        let leidos = 0;
        do {
            leidos = fs.readSync(
                descriptor,
                bloque,
                0,
                bloque.length,
                null
            );
            if (leidos > 0) hash.update(bloque.subarray(0, leidos));
        } while (leidos > 0);
        return hash.digest('hex');
    } finally {
        fs.closeSync(descriptor);
    }
}

function verificarCopiaArchivo(origen, destino) {
    const origenStat = fs.statSync(origen);
    const destinoStat = fs.statSync(destino);
    if (
        !origenStat.isFile() ||
        !destinoStat.isFile() ||
        origenStat.size !== destinoStat.size ||
        calcularHuellaArchivo(origen) !== calcularHuellaArchivo(destino)
    ) {
        throw new Error(
            `El respaldo local no pudo verificarse: ${path.basename(origen)}.`
        );
    }
}

function adjuntarErroresSecundarios(error, propiedad, mensaje, errores) {
    if (!errores.length) return;
    error[propiedad] = new AggregateError(errores, mensaje);
}

class AlmacenMensajesRecientes {
    constructor(opciones = {}) {
        this.ruta = path.resolve(opciones.ruta);
        this.rutaClave = path.resolve(
            opciones.rutaClave || `${this.ruta}.key`
        );
        this.cifrarClave = opciones.cifrarClave;
        this.descifrarClave = opciones.descifrarClave;
        this.cifradoDisponible = opciones.cifradoDisponible;
        this.recuperarCifradoIncompatible =
            opciones.recuperarCifradoIncompatible === true;
        this.recuperacionCifrado = null;
        if (
            typeof this.cifrarClave !== 'function' ||
            typeof this.descifrarClave !== 'function'
        ) throw new Error('El almacén requiere el cifrado seguro del sistema.');
        fs.mkdirSync(path.dirname(this.ruta), { recursive: true });
        this.clave = null;
        this.db = null;
        this.insertar = null;
        try {
            this.clave = this.obtenerClave();
            const crearBaseDatos = typeof opciones.crearBaseDatos === 'function'
                ? opciones.crearBaseDatos
                : ruta => new DatabaseSync(ruta);
            this.db = crearBaseDatos(this.ruta);
            this.db.exec(`
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = NORMAL;
                PRAGMA secure_delete = ON;
                PRAGMA cache_size = -${CACHE_SQLITE_KIB};
                PRAGMA mmap_size = 0;
                PRAGMA temp_store = FILE;
                CREATE TABLE IF NOT EXISTS mensajes_recientes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    linea_id TEXT NOT NULL,
                    chat_hash TEXT NOT NULL,
                    mensaje_hash TEXT NOT NULL,
                    timestamp_ms INTEGER NOT NULL,
                    payload BLOB NOT NULL,
                    UNIQUE(linea_id, mensaje_hash)
                );
                CREATE INDEX IF NOT EXISTS idx_mensajes_linea_fecha
                    ON mensajes_recientes(linea_id, timestamp_ms DESC, id DESC);
            `);
            this.insertar = this.db.prepare(`
                INSERT INTO mensajes_recientes(
                    linea_id, chat_hash, mensaje_hash, timestamp_ms, payload
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(linea_id, mensaje_hash) DO UPDATE SET
                    timestamp_ms = excluded.timestamp_ms,
                    payload = excluded.payload
            `);
            // SQLite cifrado es la única fuente del historial. Esta clase no
            // conserva arreglos ni mapas de mensajes en RAM entre operaciones.
            this.proximaLimpiezaMs = 0;
            this.limpiarVencidos();
            this.limpiarRespaldosIncompatiblesVencidos();
        } catch (error) {
            const erroresLimpieza = [];
            try {
                this.db?.close();
            } catch (errorCierre) {
                erroresLimpieza.push(errorCierre);
            }
            try {
                this.clave?.fill(0);
            } catch (errorLimpiezaClave) {
                erroresLimpieza.push(errorLimpiezaClave);
            }
            this.db = null;
            this.insertar = null;
            this.clave = null;
            if (this.recuperacionCifrado?.realizada) {
                for (const ruta of [
                    this.ruta,
                    `${this.ruta}-wal`,
                    `${this.ruta}-shm`
                ]) {
                    try {
                        fs.rmSync(ruta, { force: true });
                    } catch (errorLimpieza) {
                        erroresLimpieza.push(errorLimpieza);
                    }
                }
            }
            adjuntarErroresSecundarios(
                error,
                'cleanupError',
                'No se pudieron liberar todos los recursos de inicialización.',
                erroresLimpieza
            );
            throw error;
        }
    }

    comprobarCifradoDisponible() {
        if (typeof this.cifradoDisponible !== 'function') return;

        let disponible = false;
        let causa = null;
        try {
            disponible = this.cifradoDisponible() === true;
        } catch (error) {
            causa = error;
        }

        if (!disponible) {
            const error = new Error(
                'El cifrado local del sistema no está disponible temporalmente.'
            );
            error.code = 'CIFRADO_LOCAL_NO_DISPONIBLE';
            if (causa) error.cause = causa;
            throw error;
        }
    }

    crearClaveProtegidaVerificada() {
        this.comprobarCifradoDisponible();
        const clave = crypto.randomBytes(32);
        let comprobacion = null;

        try {
            const protegida = this.cifrarClave(clave.toString('base64'));
            if (typeof protegida !== 'string' || !protegida.trim()) {
                throw new Error('El cifrado local no devolvió una clave protegida válida.');
            }

            const abierta = this.descifrarClave(protegida);
            comprobacion = Buffer.from(String(abierta || ''), 'base64');
            if (
                comprobacion.length !== clave.length ||
                !crypto.timingSafeEqual(comprobacion, clave)
            ) {
                throw new Error(
                    'El cifrado local no pudo verificar una clave nueva.'
                );
            }

            comprobacion.fill(0);
            comprobacion = null;
            return { clave, protegida };
        } catch (error) {
            comprobacion?.fill(0);
            clave.fill(0);
            throw error;
        }
    }

    rutasRecuperables() {
        return [
            this.ruta,
            `${this.ruta}-wal`,
            `${this.ruta}-shm`,
            this.rutaClave
        ];
    }

    limpiarRespaldosIncompatiblesVencidos() {
        const corte = Date.now() - RETENCION_MS;
        const porCarpeta = new Map();

        for (const rutaOriginal of this.rutasRecuperables()) {
            const carpeta = path.dirname(rutaOriginal);
            if (!porCarpeta.has(carpeta)) {
                porCarpeta.set(carpeta, new Set());
            }
            porCarpeta.get(carpeta).add(path.basename(rutaOriginal));
        }

        for (const [carpeta, nombresOriginales] of porCarpeta) {
            let entradas = [];
            try {
                entradas = fs.readdirSync(carpeta, {
                    withFileTypes: true
                });
            } catch {
                continue;
            }

            for (const entrada of entradas) {
                if (!entrada.isFile()) continue;
                const pertenece = [...nombresOriginales].some(nombre =>
                    entrada.name.startsWith(
                        `${nombre}.incompatible-`
                    ) &&
                    entrada.name.endsWith('.bak')
                );
                if (!pertenece) continue;

                const rutaRespaldo = path.join(carpeta, entrada.name);
                try {
                    if (fs.statSync(rutaRespaldo).mtimeMs < corte) {
                        fs.rmSync(rutaRespaldo, { force: true });
                    }
                } catch {
                    // Un antivirus o bloqueo temporal no debe impedir que la
                    // aplicación abra. Se volverá a intentar en otro inicio.
                }
            }
        }
    }

    respaldarArchivosIncompatibles() {
        const sufijo = `${new Date().toISOString().replace(/[:.]/gu, '-')}-` +
            crypto.randomBytes(3).toString('hex');
        const respaldados = [];

        try {
            for (const origen of this.rutasRecuperables()) {
                if (!fs.existsSync(origen)) continue;
                const destino = `${origen}.incompatible-${sufijo}.bak`;
                const item = { origen, destino };
                respaldados.push(item);
                fs.copyFileSync(
                    origen,
                    destino,
                    fs.constants.COPYFILE_EXCL
                );
            }
            for (const item of respaldados) {
                verificarCopiaArchivo(item.origen, item.destino);
            }
            return respaldados;
        } catch (error) {
            const erroresLimpieza = [];
            for (const item of [...respaldados].reverse()) {
                try {
                    fs.rmSync(item.destino, { force: true });
                } catch (errorLimpieza) {
                    erroresLimpieza.push(errorLimpieza);
                }
            }
            adjuntarErroresSecundarios(
                error,
                'cleanupError',
                'No se pudieron limpiar todos los respaldos incompletos.',
                erroresLimpieza
            );
            throw error;
        }
    }

    retirarArchivosOriginales(respaldados) {
        for (const item of respaldados) {
            fs.rmSync(item.origen, { force: true });
        }
    }

    restaurarArchivosOriginales(respaldados) {
        const errores = [];
        for (const item of respaldados) {
            try {
                if (fs.existsSync(item.origen)) {
                    try {
                        verificarCopiaArchivo(item.destino, item.origen);
                        continue;
                    } catch {
                        // El original parcial o nuevo se sustituye por la copia.
                    }
                }
                fs.copyFileSync(item.destino, item.origen);
                verificarCopiaArchivo(item.destino, item.origen);
            } catch (error) {
                errores.push(error);
            }
        }
        return errores;
    }

    recuperarClaveIncompatible() {
        // Primero comprobamos que el cifrado actual pueda proteger y volver a
        // abrir una clave nueva. Luego se copia y verifica el conjunto completo
        // antes de retirar originales; la clave anterior siempre sale al final.
        const nueva = this.crearClaveProtegidaVerificada();
        let respaldados = null;

        try {
            respaldados = this.respaldarArchivosIncompatibles();
            this.retirarArchivosOriginales(respaldados);
            escribirAtomico(this.rutaClave, `${nueva.protegida}\n`);
        } catch (error) {
            if (respaldados !== null) {
                const erroresRestauracion =
                    this.restaurarArchivosOriginales(respaldados);
                adjuntarErroresSecundarios(
                    error,
                    'rollbackError',
                    'No se pudieron restaurar todos los archivos originales.',
                    erroresRestauracion
                );
            }
            nueva.clave.fill(0);
            throw error;
        }

        this.recuperacionCifrado = Object.freeze({
            realizada: true,
            motivo: 'CLAVE_LOCAL_INCOMPATIBLE',
            archivosRespaldados: Object.freeze(
                respaldados.map(item => item.destino)
            )
        });
        return nueva.clave;
    }

    obtenerClave() {
        if (fs.existsSync(this.rutaClave)) {
            const protegida = fs.readFileSync(this.rutaClave, 'utf8').trim();
            this.comprobarCifradoDisponible();
            try {
                const abierta = this.descifrarClave(protegida);
                const clave = Buffer.from(String(abierta || ''), 'base64');
                if (clave.length !== 32) {
                    clave.fill(0);
                    throw new Error('La clave local no es válida.');
                }
                return clave;
            } catch (error) {
                if (!this.recuperarCifradoIncompatible) {
                    throw crearErrorClaveIncompatible(error);
                }
                return this.recuperarClaveIncompatible();
            }
        }

        const nueva = this.crearClaveProtegidaVerificada();
        try {
            escribirAtomico(this.rutaClave, `${nueva.protegida}\n`);
            return nueva.clave;
        } catch (error) {
            nueva.clave.fill(0);
            throw error;
        }
    }

    hash(valor) {
        return crypto.createHmac('sha256', this.clave)
            .update(String(valor || ''))
            .digest('hex');
    }

    guardar(lineaIdEntrada, mensajes) {
        const lineaId = String(lineaIdEntrada || '').trim().slice(0, 180);
        if (!lineaId) return 0;
        let guardados = 0;
        const corteRetencion = Date.now() - RETENCION_MS;
        this.db.exec('BEGIN IMMEDIATE');
        try {
            for (const mensaje of Array.isArray(mensajes) ? mensajes : []) {
                if (mensaje?.key?.fromMe !== true) continue;
                const jid = String(mensaje?.key?.remoteJid || '').trim().slice(0, 240);
                if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us')) continue;
                const textoOriginal = mensaje?.message?.conversation;
                const texto = redactarTextoParaIA(textoOriginal).slice(0, 4000);
                if (!texto) continue;
                const idWhatsapp = String(mensaje?.key?.id || '').trim().slice(0, 240);
                const fecha = timestampMs(mensaje?.messageTimestamp);
                if (fecha < corteRetencion) continue;
                const identidad = idWhatsapp || `${fecha}\u0000${texto}`;
                const chatHash = this.hash(`chat\u0000${jid}`);
                const mensajeHash = this.hash(`mensaje\u0000${jid}\u0000${identidad}`);
                const aad = `${VERSION_ALMACEN}\u0000${lineaId}\u0000${mensajeHash}\u0000${fecha}`;
                const payload = cifrarPayload(this.clave, {
                    jid,
                    idWhatsapp: idWhatsapp || null,
                    texto
                }, aad);
                this.insertar.run(lineaId, chatHash, mensajeHash, fecha, payload);
                guardados += 1;
            }
            this.db.prepare(`
                DELETE FROM mensajes_recientes
                WHERE linea_id = ? AND id NOT IN (
                    SELECT id FROM mensajes_recientes
                    WHERE linea_id = ?
                    ORDER BY timestamp_ms DESC, id DESC
                    LIMIT ?
                )
            `).run(lineaId, lineaId, MAXIMO_POR_LINEA);
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
        if (Date.now() >= this.proximaLimpiezaMs) this.limpiarVencidos();
        return guardados;
    }

    obtener(lineaIdEntrada, limite = MAXIMO_POR_LINEA) {
        const lineaId = String(lineaIdEntrada || '').trim().slice(0, 180);
        if (!lineaId) return [];
        const maximo = Math.min(MAXIMO_POR_LINEA, Math.max(1, Number(limite) || 1));
        const filas = this.db.prepare(`
            SELECT mensaje_hash, timestamp_ms, payload
            FROM mensajes_recientes
            WHERE linea_id = ?
            ORDER BY timestamp_ms DESC, id DESC
            LIMIT ?
        `).all(lineaId, maximo).reverse();
        const mensajes = [];
        for (const fila of filas) {
            try {
                const aad = `${VERSION_ALMACEN}\u0000${lineaId}\u0000${fila.mensaje_hash}\u0000${fila.timestamp_ms}`;
                const datos = descifrarPayload(this.clave, fila.payload, aad);
                mensajes.push({
                    key: {
                        fromMe: true,
                        remoteJid: datos.jid,
                        id: datos.idWhatsapp || undefined
                    },
                    messageTimestamp: fila.timestamp_ms,
                    message: { conversation: datos.texto }
                });
            } catch {
                // Una fila dañada se ignora; nunca invalida el resto del historial.
            }
        }
        return mensajes;
    }

    limpiarVencidos() {
        const corte = Date.now() - RETENCION_MS;
        const eliminados = Number(this.db.prepare(
            'DELETE FROM mensajes_recientes WHERE timestamp_ms < ?'
        ).run(corte).changes) || 0;
        this.proximaLimpiezaMs = Date.now() + INTERVALO_LIMPIEZA_MS;
        return eliminados;
    }

    eliminarLinea(lineaIdEntrada) {
        const lineaId = String(lineaIdEntrada || '').trim().slice(0, 180);
        if (!lineaId) return 0;
        return Number(this.db.prepare(
            'DELETE FROM mensajes_recientes WHERE linea_id = ?'
        ).run(lineaId).changes) || 0;
    }

    cerrar() {
        this.clave?.fill(0);
        this.db?.close();
        this.db = null;
    }
}

function crearAlmacenMensajesRecientes(opciones) {
    return new AlmacenMensajesRecientes(opciones);
}

module.exports = {
    AlmacenMensajesRecientes,
    CACHE_SQLITE_KIB,
    INTERVALO_LIMPIEZA_MS,
    MAXIMO_POR_LINEA,
    RETENCION_MS,
    crearAlmacenMensajesRecientes
};
