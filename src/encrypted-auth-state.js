'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAGIC = Buffer.from('Z1AUTH01', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_FILE = 'zeroone-auth-key.json';
const MARKER_FILE = 'zeroone-auth-state.json';
const EXCLUDED_JSON = new Set([
    'audiencia-estados.json',
    'actividad-contactos.json',
    KEY_FILE,
    MARKER_FILE
]);
const ALMACENES_ABIERTOS = new Set();

class EncryptedAuthStateError extends Error {
    constructor(code, message, cause) {
        super(message);
        this.name = 'EncryptedAuthStateError';
        this.code = code;
        if (cause) this.cause = cause;
    }
}

function fail(code, message, cause) {
    throw new EncryptedAuthStateError(code, message, cause);
}

function normalizarNombreArchivo(file) {
    const normalizado = String(file || '')
        .replace(/\//gu, '__')
        .replace(/:/gu, '-');
    if (
        !normalizado ||
        normalizado.includes('\\') ||
        normalizado.includes('/') ||
        normalizado.includes('\0') ||
        normalizado === '.' ||
        normalizado === '..'
    ) {
        fail('AUTH_FILE_INVALID', 'Baileys solicitó un nombre de credencial no válido.');
    }
    return normalizado;
}

function bufferBase64Estricto(valor, campo, maximo = 64 * 1024) {
    const texto = String(valor || '');
    if (!texto || !/^[A-Za-z0-9+/]+={0,2}$/u.test(texto) || texto.length % 4 !== 0) {
        fail('AUTH_KEY_FILE_INVALID', `${campo} no contiene Base64 válido.`);
    }
    const buffer = Buffer.from(texto, 'base64');
    if (buffer.length > maximo || buffer.toString('base64') !== texto) {
        buffer.fill(0);
        fail('AUTH_KEY_FILE_INVALID', `${campo} no es válido.`);
    }
    return buffer;
}

function rutaDentro(carpeta, nombre) {
    const raiz = path.resolve(carpeta);
    const destino = path.resolve(raiz, normalizarNombreArchivo(nombre));
    const relativa = path.relative(raiz, destino);
    if (!relativa || relativa.startsWith('..') || path.isAbsolute(relativa)) {
        fail('AUTH_PATH_ESCAPE', 'La credencial intentó salir de su carpeta.');
    }
    return destino;
}

async function escribirAtomico(ruta, datos, { soloNuevo = false } = {}) {
    const destino = path.resolve(ruta);
    const carpeta = path.dirname(destino);
    await fs.promises.mkdir(carpeta, { recursive: true, mode: 0o700 });
    const temporal = path.join(
        carpeta,
        `.${path.basename(destino)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
    );
    let descriptor;
    try {
        descriptor = await fs.promises.open(temporal, 'wx', 0o600);
        await descriptor.writeFile(datos);
        await descriptor.sync();
        await descriptor.close();
        descriptor = null;

        if (soloNuevo) {
            await fs.promises.link(temporal, destino);
            await fs.promises.unlink(temporal);
        } else {
            await fs.promises.rename(temporal, destino);
        }
    } catch (error) {
        try { await descriptor?.close(); } catch {}
        try { await fs.promises.rm(temporal, { force: true }); } catch {}
        if (soloNuevo && error?.code === 'EEXIST') throw error;
        fail('AUTH_ATOMIC_WRITE_FAILED', 'No se pudo guardar una credencial cifrada de forma atómica.', error);
    }
}

async function leerClaveProtegida(ruta, protector) {
    let contenido;
    try {
        contenido = JSON.parse(await fs.promises.readFile(ruta, 'utf8'));
    } catch (error) {
        fail('AUTH_KEY_FILE_INVALID', 'No se pudo leer la clave protegida de la sesión.', error);
    }
    if (
        contenido?.version !== 1 ||
        contenido?.protector !== protector.id
    ) {
        fail('AUTH_KEY_FILE_INVALID', 'La clave de sesión usa un protector incompatible.');
    }
    const wrapped = bufferBase64Estricto(contenido.wrappedKey, 'wrappedKey');
    let key;
    try {
        const recuperada = await protector.unprotect(wrapped);
        key = Buffer.isBuffer(recuperada)
            ? Buffer.from(recuperada)
            : Buffer.from(recuperada || []);
        if (key.length !== KEY_BYTES) {
            key.fill(0);
            fail('AUTH_KEY_INVALID', 'La clave recuperada no tiene 256 bits.');
        }
        return key;
    } finally {
        wrapped.fill(0);
    }
}

async function obtenerOCrearClave(carpeta, protector, { permitirCrear = true } = {}) {
    const ruta = rutaDentro(carpeta, KEY_FILE);
    if (fs.existsSync(ruta)) return leerClaveProtegida(ruta, protector);

    if (!permitirCrear) {
        fail(
            'AUTH_KEY_MISSING',
            'Falta la clave protegida de una sesión cifrada; no se generará una nueva.'
        );
    }

    const key = crypto.randomBytes(KEY_BYTES);
    let wrapped;
    try {
        wrapped = Buffer.from(await protector.protect(Buffer.from(key)));
        const contenido = Buffer.from(JSON.stringify({
            version: 1,
            cipher: 'AES-256-GCM',
            protector: protector.id,
            wrappedKey: wrapped.toString('base64')
        }), 'utf8');
        try {
            await escribirAtomico(ruta, contenido, { soloNuevo: true });
            let confirmada;
            try {
                confirmada = await leerClaveProtegida(ruta, protector);
                if (!crypto.timingSafeEqual(confirmada, key)) {
                    fail(
                        'AUTH_KEY_ROUNDTRIP_FAILED',
                        'Windows no devolvió la misma clave protegida.'
                    );
                }
                return key;
            } catch (error) {
                try { await fs.promises.rm(ruta, { force: true }); } catch {}
                throw error;
            } finally {
                confirmada?.fill?.(0);
            }
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            key.fill(0);
            return leerClaveProtegida(ruta, protector);
        } finally {
            contenido.fill(0);
        }
    } catch (error) {
        key.fill(0);
        throw error;
    } finally {
        wrapped?.fill?.(0);
    }
}

function nombreCifrado(key, nombreLogico) {
    return `auth-${crypto.createHmac('sha256', key)
        .update(`zeroone-auth-file-v1:${nombreLogico}`, 'utf8')
        .digest('hex')}.z1e`;
}

function aad(nombreLogico) {
    return Buffer.from(`zeroone-auth-content-v1:${nombreLogico}`, 'utf8');
}

function cifrarContenido(key, nombreLogico, plano) {
    const iv = crypto.randomBytes(IV_BYTES);
    try {
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(aad(nombreLogico));
        const ciphertext = Buffer.concat([cipher.update(plano), cipher.final()]);
        return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
    } finally {
        iv.fill(0);
    }
}

function descifrarContenido(key, nombreLogico, contenido) {
    if (
        !Buffer.isBuffer(contenido) ||
        contenido.length < MAGIC.length + IV_BYTES + TAG_BYTES ||
        !crypto.timingSafeEqual(contenido.subarray(0, MAGIC.length), MAGIC)
    ) {
        fail('AUTH_CIPHERTEXT_INVALID', 'Una credencial cifrada tiene un formato no válido.');
    }
    const inicioIv = MAGIC.length;
    const inicioTag = inicioIv + IV_BYTES;
    const inicioCiphertext = inicioTag + TAG_BYTES;
    try {
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            key,
            contenido.subarray(inicioIv, inicioTag)
        );
        decipher.setAAD(aad(nombreLogico));
        decipher.setAuthTag(contenido.subarray(inicioTag, inicioCiphertext));
        return Buffer.concat([
            decipher.update(contenido.subarray(inicioCiphertext)),
            decipher.final()
        ]);
    } catch (error) {
        fail(
            'AUTH_DECRYPT_FAILED',
            'Una credencial fue alterada o Windows no pudo recuperar su clave.',
            error
        );
    }
}

function listarArchivosLegados(carpeta) {
    if (!fs.existsSync(carpeta)) return [];
    return fs.readdirSync(carpeta, { withFileTypes: true })
        .filter(entrada =>
            entrada.isFile() &&
            entrada.name.endsWith('.json') &&
            !EXCLUDED_JSON.has(entrada.name)
        )
        .map(entrada => entrada.name)
        .sort();
}

function crearColaPorArchivo() {
    const colas = new Map();
    const ejecutar = async (nombre, operacion) => {
        const anterior = colas.get(nombre) || Promise.resolve();
        const actual = anterior.catch(() => {}).then(operacion);
        colas.set(nombre, actual);
        try {
            return await actual;
        } finally {
            if (colas.get(nombre) === actual) colas.delete(nombre);
        }
    };

    ejecutar.esperar = async () => {
        while (colas.size > 0) {
            await Promise.allSettled([...colas.values()]);
        }
    };
    ejecutar.tienePendientes = () => colas.size > 0;
    return ejecutar;
}

function validarMarcadorCifrado(ruta, { permitirPendiente = false } = {}) {
    let marcador;
    try {
        marcador = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    } catch (error) {
        fail(
            'AUTH_MARKER_INVALID',
            'El marcador de la sesión cifrada no es válido.',
            error
        );
    }
    if (
        marcador?.version !== 1 ||
        marcador?.cipher !== 'AES-256-GCM' ||
        typeof marcador?.loginIdentityPresent !== 'boolean'
    ) {
        fail(
            'AUTH_MARKER_INVALID',
            'El marcador de la sesión cifrada está incompleto.'
        );
    }
    if (!marcador.loginIdentityPresent && !permitirPendiente) {
        fail(
            'AUTH_PENDING_LINK_NOT_AUTHORIZED',
            'La sesión cifrada está pendiente de vinculación y requiere autorización explícita.'
        );
    }
    return marcador;
}

async function crearEstadoAutenticacionCifrado({
    folder,
    protector,
    BufferJSON,
    initAuthCreds,
    proto,
    migrarLegado = false,
    permitirVinculacionInicial = false
} = {}) {
    if (
        !protector ||
        typeof protector.protect !== 'function' ||
        typeof protector.unprotect !== 'function'
    ) {
        fail('AUTH_PROTECTOR_INVALID', 'No hay un protector local para las sesiones.');
    }
    if (!BufferJSON?.replacer || !BufferJSON?.reviver || typeof initAuthCreds !== 'function') {
        fail('AUTH_BAILEYS_UTILS_INVALID', 'Faltan utilidades de autenticación de Baileys.');
    }

    const carpetaSolicitada = path.resolve(String(folder || ''));
    await fs.promises.mkdir(carpetaSolicitada, {
        recursive: true,
        mode: 0o700
    });
    const carpeta = await fs.promises.realpath(carpetaSolicitada);
    const claveCarpeta = process.platform === 'win32'
        ? carpeta.toLocaleLowerCase('en-US')
        : carpeta;
    if (ALMACENES_ABIERTOS.has(claveCarpeta)) {
        fail(
            'AUTH_STATE_ALREADY_OPEN',
            'La sesión cifrada ya está abierta en este proceso.'
        );
    }
    ALMACENES_ABIERTOS.add(claveCarpeta);

    try {
        const markerPath = rutaDentro(carpeta, MARKER_FILE);
        const marcadorExistente = fs.existsSync(markerPath);
        let marcador = marcadorExistente
            ? validarMarcadorCifrado(markerPath, {
                permitirPendiente: permitirVinculacionInicial === true
            })
            : null;
        const key = await obtenerOCrearClave(carpeta, protector, {
            permitirCrear: !marcadorExistente
        });
        const conBloqueo = crearColaPorArchivo();
        let cerrada = false;
        let respaldoPausado = false;
        let resolverPausaRespaldo = null;
        let puertaRespaldo = Promise.resolve();

        const asegurarAbierta = () => {
            if (cerrada) fail('AUTH_STATE_CLOSED', 'El almacén cifrado de la sesión ya se cerró.');
        };
        const rutas = nombreOriginal => {
            const nombre = normalizarNombreArchivo(nombreOriginal);
            return {
                nombre,
                legado: rutaDentro(carpeta, nombre),
                cifrado: rutaDentro(carpeta, nombreCifrado(key, nombre))
            };
        };
        const ejecutarConAcceso = (nombre, operacion) => {
            asegurarAbierta();
            if (!respaldoPausado) {
                return conBloqueo(nombre, operacion);
            }
            const puertaActual = puertaRespaldo;
            return puertaActual.then(() => {
                asegurarAbierta();
                return conBloqueo(nombre, operacion);
            });
        };
        const pausarParaRespaldo = async () => {
            asegurarAbierta();
            if (respaldoPausado) {
                fail(
                    'AUTH_BACKUP_LEASE_ACTIVE',
                    'Ya existe una lectura protegida de esta sesión.'
                );
            }
            respaldoPausado = true;
            puertaRespaldo = new Promise(resolve => {
                resolverPausaRespaldo = resolve;
            });
            await conBloqueo.esperar();

            let liberada = false;
            return () => {
                if (liberada) return;
                liberada = true;
                respaldoPausado = false;
                const resolver = resolverPausaRespaldo;
                resolverPausaRespaldo = null;
                resolver?.();
            };
        };

        const leerPlanoCifrado = async (nombre, ruta) => {
        const contenido = await fs.promises.readFile(ruta);
        try {
            return descifrarContenido(key, nombre, contenido);
        } finally {
            contenido.fill(0);
        }
    };

    const guardarPlano = async (nombreOriginal, plano) => {
        const { nombre, legado, cifrado } = rutas(nombreOriginal);
        const contenido = cifrarContenido(key, nombre, plano);
        try {
            await escribirAtomico(cifrado, contenido);
            const verificacion = await leerPlanoCifrado(nombre, cifrado);
            try {
                if (
                    verificacion.length !== plano.length ||
                    !crypto.timingSafeEqual(verificacion, plano)
                ) {
                    fail('AUTH_ROUNDTRIP_FAILED', 'Una credencial no superó la verificación local.');
                }
            } finally {
                verificacion.fill(0);
            }
            await fs.promises.rm(legado, { force: true });
        } finally {
            contenido.fill(0);
        }
    };

    const readData = nombreOriginal => {
        asegurarAbierta();
        return ejecutarConAcceso(
            normalizarNombreArchivo(nombreOriginal),
            async () => {
            const { nombre, legado, cifrado } = rutas(nombreOriginal);
            let plano;
            try {
                if (fs.existsSync(cifrado)) {
                    plano = await leerPlanoCifrado(nombre, cifrado);
                } else if (!fs.existsSync(markerPath) && fs.existsSync(legado)) {
                    plano = await fs.promises.readFile(legado);
                } else {
                    if (nombre === 'creds.json' && fs.existsSync(markerPath)) {
                        fail('AUTH_CREDS_MISSING', 'Falta la credencial principal de una sesión cifrada.');
                    }
                    return null;
                }
                return JSON.parse(plano.toString('utf8'), BufferJSON.reviver);
            } catch (error) {
                if (error instanceof EncryptedAuthStateError) throw error;
                fail('AUTH_READ_FAILED', `No se pudo leer ${nombre} de forma segura.`, error);
            } finally {
                plano?.fill?.(0);
            }
            }
        );
    };

    const writeData = (data, nombreOriginal) => {
        asegurarAbierta();
        return ejecutarConAcceso(
            normalizarNombreArchivo(nombreOriginal),
            async () => {
            const plano = Buffer.from(
                JSON.stringify(data, BufferJSON.replacer),
                'utf8'
            );
            try {
                await guardarPlano(nombreOriginal, plano);
            } finally {
                plano.fill(0);
            }
            }
        );
    };

    const removeData = nombreOriginal => {
        asegurarAbierta();
        return ejecutarConAcceso(
            normalizarNombreArchivo(nombreOriginal),
            async () => {
            const { legado, cifrado } = rutas(nombreOriginal);
            await Promise.all([
                fs.promises.rm(legado, { force: true }),
                fs.promises.rm(cifrado, { force: true })
            ]);
            }
        );
    };

    const escribirMarcador = (identidadPresente, campos = {}) => {
        asegurarAbierta();
        return ejecutarConAcceso(MARKER_FILE, async () => {
            const contenido = Buffer.from(JSON.stringify({
                version: 1,
                cipher: 'AES-256-GCM',
                loginIdentityPresent: identidadPresente === true,
                ...campos
            }), 'utf8');
            try {
                await escribirAtomico(markerPath, contenido);
                marcador = validarMarcadorCifrado(markerPath, {
                    permitirPendiente: identidadPresente !== true
                });
                return marcador;
            } finally {
                contenido.fill(0);
            }
        });
    };

    const prepararLegadosCifrados = async legados => {
        const preparados = [];
        for (const nombre of legados) {
            const { cifrado, legado } = rutas(nombre);
            const plano = await fs.promises.readFile(legado);
            try {
                JSON.parse(plano.toString('utf8'), BufferJSON.reviver);
                const contenido = cifrarContenido(key, nombre, plano);
                try {
                    await escribirAtomico(cifrado, contenido);
                } finally {
                    contenido.fill(0);
                }
                const verificacion = await leerPlanoCifrado(nombre, cifrado);
                try {
                    if (
                        verificacion.length !== plano.length ||
                        !crypto.timingSafeEqual(verificacion, plano)
                    ) {
                        fail(
                            'AUTH_MIGRATION_VERIFY_FAILED',
                            'La migración cifrada no coincide con el archivo original.'
                        );
                    }
                } finally {
                    verificacion.fill(0);
                }
                preparados.push({ nombre, legado });
            } finally {
                plano.fill(0);
            }
        }
        return preparados;
    };

    const eliminarLegadosConfirmados = async preparados => {
        for (const item of preparados) {
            await fs.promises.rm(item.legado, { force: true });
        }
    };

    const migrar = async () => {
        if (!migrarLegado) return { migrada: false, archivos: 0 };
        const legados = listarArchivosLegados(carpeta);
        if (!legados.length) {
            if (fs.existsSync(markerPath)) {
                return { migrada: true, archivos: 0 };
            }
            fail(
                'AUTH_LEGACY_MISSING',
                'No hay credenciales vinculadas en texto plano para migrar.'
            );
        }

        let preparados = [];
        try {
            preparados = await prepararLegadosCifrados(legados);

            const credenciales = await readData('creds.json');
            if (!credenciales?.me?.id) {
                fail('AUTH_LOGIN_IDENTITY_MISSING', 'La sesión no contiene una identidad vinculada para migrar.');
            }
            await escribirMarcador(true, {
                migratedAt: new Date().toISOString()
            });

            await eliminarLegadosConfirmados(preparados);
            return { migrada: true, archivos: preparados.length };
        } catch (error) {
            // Los originales se conservan hasta que todos los cifrados y la
            // identidad hayan sido verificados. Así cualquier fallo previo al
            // marcador sigue siendo reversible mediante la copia confirmada.
            throw error;
        }
    };

    const migrarVinculacionPendienteLegada = async () => {
        if (
            marcador ||
            migrarLegado ||
            permitirVinculacionInicial !== true
        ) {
            return { migrada: false, archivos: 0 };
        }
        const legados = listarArchivosLegados(carpeta);
        if (!legados.length) return { migrada: false, archivos: 0 };
        if (!legados.includes('creds.json')) {
            fail(
                'AUTH_CREDS_MISSING',
                'La vinculación pendiente no contiene su credencial principal.'
            );
        }

        let preparados = [];
        try {
            preparados = await prepararLegadosCifrados(legados);
            const credenciales = await readData('creds.json');
            if (!credenciales || typeof credenciales !== 'object') {
                fail(
                    'AUTH_CREDS_INVALID',
                    'La credencial principal pendiente no contiene un objeto válido.'
                );
            }
            const identidadPresente =
                typeof credenciales?.me?.id === 'string' &&
                Boolean(credenciales.me.id.trim());
            const ahora = new Date().toISOString();
            await escribirMarcador(identidadPresente, identidadPresente
                ? { linkedAt: ahora, convertedAt: ahora }
                : { pendingSince: ahora, convertedAt: ahora });

            // El marcador verificado es el punto de confirmación. Hasta aquí
            // todos los originales permanecen intactos para poder reintentar.
            await eliminarLegadosConfirmados(preparados);
            return { migrada: true, archivos: preparados.length };
        } catch (error) {
            throw error;
        }
    };

        try {
        await migrar();
        await migrarVinculacionPendienteLegada();
        if (fs.existsSync(markerPath)) {
            for (const nombre of listarArchivosLegados(carpeta)) {
                const { cifrado, legado } = rutas(nombre);
                if (!fs.existsSync(cifrado)) continue;
                const planoVerificado = await leerPlanoCifrado(nombre, cifrado);
                try {
                    JSON.parse(planoVerificado.toString('utf8'), BufferJSON.reviver);
                } finally {
                    planoVerificado.fill(0);
                }
                await fs.promises.rm(legado, { force: true });
            }
        }

        const credencialesLeidas = await readData('creds.json');
        const materialCredenciales = rutas('creds.json');
        let creds = credencialesLeidas;
        if (!creds || typeof creds !== 'object') {
            if (
                fs.existsSync(markerPath) ||
                fs.existsSync(materialCredenciales.cifrado) ||
                fs.existsSync(materialCredenciales.legado)
            ) {
                fail(
                    'AUTH_CREDS_INVALID',
                    'La credencial principal cifrada no contiene un objeto válido.'
                );
            }
            if (permitirVinculacionInicial !== true) {
                fail(
                    'AUTH_INITIAL_LINK_NOT_AUTHORIZED',
                    'Una vinculación nueva cifrada requiere autorización explícita.'
                );
            }
            creds = initAuthCreds();
            if (!creds || typeof creds !== 'object') {
                fail(
                    'AUTH_CREDS_INVALID',
                    'Baileys no generó credenciales iniciales válidas.'
                );
            }
            await writeData(creds, 'creds.json');
            await escribirMarcador(false, {
                pendingSince: new Date().toISOString()
            });
        }
        if (
            !marcador &&
            fs.existsSync(materialCredenciales.cifrado) &&
            permitirVinculacionInicial !== true
        ) {
            fail(
                'AUTH_MARKER_MISSING',
                'Hay credenciales cifradas sin marcador y no se autorizó recuperar la vinculación pendiente.'
            );
        }
        if (!marcador && permitirVinculacionInicial === true) {
            const identidadPresente =
                typeof creds?.me?.id === 'string' && Boolean(creds.me.id.trim());
            await writeData(creds, 'creds.json');
            await escribirMarcador(identidadPresente, identidadPresente
                ? { linkedAt: new Date().toISOString(), recoveredAt: new Date().toISOString() }
                : { pendingSince: new Date().toISOString(), recoveredAt: new Date().toISOString() });
        }
        if (marcador?.loginIdentityPresent && !creds?.me?.id) {
            fail(
                'AUTH_LOGIN_IDENTITY_MISSING',
                'La sesión cifrada no conserva una identidad vinculada.'
            );
        }

        const confirmarIdentidad = async () => {
            asegurarAbierta();
            if (!marcador) {
                fail(
                    'AUTH_MARKER_MISSING',
                    'La sesión no tiene un marcador cifrado para confirmar su identidad.'
                );
            }
            if (typeof creds?.me?.id !== 'string' || !creds.me.id.trim()) {
                fail(
                    'AUTH_LOGIN_IDENTITY_MISSING',
                    'La vinculación todavía no entregó una identidad de WhatsApp.'
                );
            }
            await writeData(creds, 'creds.json');
            if (!marcador.loginIdentityPresent) {
                await escribirMarcador(true, {
                    linkedAt: new Date().toISOString()
                });
            }
            return true;
        };

        const saveCreds = async () => {
            await writeData(creds, 'creds.json');
            if (
                marcador &&
                !marcador.loginIdentityPresent &&
                typeof creds?.me?.id === 'string' &&
                creds.me.id.trim()
            ) {
                await escribirMarcador(true, {
                    linkedAt: new Date().toISOString()
                });
            }
        };

        if (
            marcador &&
            !marcador.loginIdentityPresent &&
            typeof creds?.me?.id === 'string' &&
            creds.me.id.trim()
        ) {
            await confirmarIdentidad();
        }
        return {
            state: {
                creds,
                keys: {
                    get: async (type, ids) => {
                        const data = {};
                        await Promise.all(ids.map(async id => {
                            let value = await readData(`${type}-${id}.json`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        }));
                        return data;
                    },
                    set: async data => {
                        const tasks = [];
                        for (const category in data) {
                            for (const id in data[category]) {
                                const value = data[category][id];
                                const file = `${category}-${id}.json`;
                                tasks.push(value ? writeData(value, file) : removeData(file));
                            }
                        }
                        await Promise.all(tasks);
                    }
                }
            },
            saveCreds,
            confirmarIdentidad,
            encrypted: fs.existsSync(markerPath),
            pausarParaRespaldo,
            async close() {
                if (cerrada) return;
                cerrada = true;
                if (respaldoPausado) {
                    await puertaRespaldo;
                }
                if (conBloqueo.tienePendientes()) {
                    await conBloqueo.esperar();
                }
                key.fill(0);
                ALMACENES_ABIERTOS.delete(claveCarpeta);
            }
        };
        } catch (error) {
            key.fill(0);
            throw error;
        }
    } catch (error) {
        ALMACENES_ABIERTOS.delete(claveCarpeta);
        throw error;
    }
}

async function inspeccionarIdentidadAutenticacionCifrada({
    folder,
    protector
} = {}) {
    if (
        !protector ||
        typeof protector.unprotect !== 'function'
    ) {
        fail('AUTH_PROTECTOR_INVALID', 'No hay un protector local para inspeccionar la sesión.');
    }
    const carpeta = path.resolve(String(folder || ''));
    const markerPath = rutaDentro(carpeta, MARKER_FILE);
    if (!fs.existsSync(markerPath)) {
        return { cifrada: false, identidadPresente: false };
    }

    const marcador = validarMarcadorCifrado(markerPath, {
        permitirPendiente: true
    });
    const key = await obtenerOCrearClave(carpeta, protector, {
        permitirCrear: false
    });
    let contenido;
    let plano;
    try {
        const nombre = 'creds.json';
        const rutaCredenciales = rutaDentro(
            carpeta,
            nombreCifrado(key, nombre)
        );
        if (!fs.existsSync(rutaCredenciales)) {
            fail(
                'AUTH_CREDS_MISSING',
                'Falta la credencial principal de la sesión cifrada.'
            );
        }
        contenido = await fs.promises.readFile(rutaCredenciales);
        plano = descifrarContenido(key, nombre, contenido);
        const credenciales = JSON.parse(plano.toString('utf8'));
        if (!credenciales || typeof credenciales !== 'object') {
            fail(
                'AUTH_CREDS_INVALID',
                'La credencial principal cifrada no contiene un objeto válido.'
            );
        }
        const identidadPresente =
            typeof credenciales?.me?.id === 'string' &&
            credenciales.me.id.trim().length > 0;
        if (marcador.loginIdentityPresent && !identidadPresente) {
            fail(
                'AUTH_LOGIN_IDENTITY_MISSING',
                'La sesión cifrada no conserva una identidad vinculada.'
            );
        }
        return {
            cifrada: true,
            identidadPresente:
                marcador.loginIdentityPresent === true && identidadPresente
        };
    } catch (error) {
        if (error instanceof EncryptedAuthStateError) throw error;
        fail(
            'AUTH_INSPECTION_FAILED',
            'No se pudo inspeccionar la identidad cifrada.',
            error
        );
    } finally {
        contenido?.fill?.(0);
        plano?.fill?.(0);
        key.fill(0);
    }
}

module.exports = {
    EncryptedAuthStateError,
    KEY_FILE,
    MARKER_FILE,
    crearEstadoAutenticacionCifrado,
    inspeccionarIdentidadAutenticacionCifrada,
    listarArchivosLegados
};
