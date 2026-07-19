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

class AlmacenMensajesRecientes {
    constructor(opciones = {}) {
        this.ruta = path.resolve(opciones.ruta);
        this.rutaClave = path.resolve(
            opciones.rutaClave || `${this.ruta}.key`
        );
        this.cifrarClave = opciones.cifrarClave;
        this.descifrarClave = opciones.descifrarClave;
        if (
            typeof this.cifrarClave !== 'function' ||
            typeof this.descifrarClave !== 'function'
        ) throw new Error('El almacén requiere el cifrado seguro del sistema.');
        fs.mkdirSync(path.dirname(this.ruta), { recursive: true });
        this.clave = this.obtenerClave();
        this.db = new DatabaseSync(this.ruta);
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
    }

    obtenerClave() {
        if (fs.existsSync(this.rutaClave)) {
            const protegida = fs.readFileSync(this.rutaClave, 'utf8').trim();
            const abierta = this.descifrarClave(protegida);
            const clave = Buffer.from(String(abierta || ''), 'base64');
            if (clave.length !== 32) throw new Error('La clave local no es válida.');
            return clave;
        }
        const clave = crypto.randomBytes(32);
        const protegida = this.cifrarClave(clave.toString('base64'));
        escribirAtomico(this.rutaClave, `${protegida}\n`);
        return clave;
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

        let eliminados = 0;
        this.db.exec('BEGIN IMMEDIATE');
        try {
            eliminados = Number(this.db.prepare(
                'DELETE FROM mensajes_recientes WHERE linea_id = ?'
            ).run(lineaId).changes) || 0;
            this.db.exec('COMMIT');
        } catch (error) {
            try {
                this.db.exec('ROLLBACK');
            } catch {
                // Se conserva el error original de la eliminación.
            }
            throw error;
        }

        // secure_delete borra el contenido de las celdas en la base principal,
        // pero una transacción anterior todavía puede permanecer en el WAL.
        // TRUNCATE fuerza su checkpoint y deja el archivo en cero bytes. Se
        // comprueba el resultado porque SQLite puede informar un lector activo
        // sin lanzar una excepción; en ese caso el llamador debe reintentar y no
        // anunciar que la limpieza estricta terminó.
        let checkpoint;
        try {
            checkpoint = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        } catch (error) {
            const fallo = new Error(
                'Los mensajes se eliminaron, pero no se pudo purgar el registro WAL.'
            );
            fallo.code = 'ALMACEN_WAL_NO_PURGADO';
            fallo.cause = error;
            throw fallo;
        }

        const ocupado = Number(checkpoint?.busy);
        const paginasPendientes = Number(checkpoint?.log);
        if (
            !checkpoint ||
            !Number.isFinite(ocupado) ||
            ocupado !== 0 ||
            !Number.isFinite(paginasPendientes) ||
            paginasPendientes !== 0
        ) {
            const error = new Error(
                'Los mensajes se eliminaron, pero el registro WAL sigue ocupado.'
            );
            error.code = 'ALMACEN_WAL_NO_PURGADO';
            error.checkpoint = checkpoint || null;
            throw error;
        }

        return eliminados;
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
