'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BACKUP_MAGIC = Buffer.from('Z1SESS01', 'ascii');
const BACKUP_FORMAT = 'zeroone-session-backup';
const BACKUP_VERSION = 1;
const MANIFEST_VERSION = 1;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FILES = 100000;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KEY_WRAP_AAD = Buffer.from('zeroone-session-key-wrap-v1', 'utf8');
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

class SessionSecurityError extends Error {
    constructor(code, message, cause) {
        super(message);
        this.name = 'SessionSecurityError';
        this.code = code;
        if (cause) this.cause = cause;
    }
}

function fail(code, message, cause) {
    throw new SessionSecurityError(code, message, cause);
}

function sha256Buffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256Text(value) {
    return sha256Buffer(Buffer.from(String(value), 'utf8'));
}

function constantTimeEqual(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function decodeBase64Strict(value, field, maximumBytes = MAX_HEADER_BYTES) {
    const text = String(value || '');
    if (!text || !/^[A-Za-z0-9+/]+={0,2}$/u.test(text) || text.length % 4 !== 0) {
        fail('BACKUP_HEADER_INVALID', `El campo ${field} no contiene Base64 válido.`);
    }
    const decoded = Buffer.from(text, 'base64');
    if (
        decoded.length > maximumBytes ||
        decoded.toString('base64') !== text
    ) {
        fail('BACKUP_HEADER_INVALID', `El campo ${field} no es válido.`);
    }
    return decoded;
}

function normalizeLimits(options = {}) {
    const integer = (value, fallback, minimum, maximum) => {
        const number = Number(value);
        return Number.isSafeInteger(number) && number >= minimum && number <= maximum
            ? number
            : fallback;
    };
    return {
        maxFiles: integer(options.maxFiles, DEFAULT_MAX_FILES, 1, 1000000),
        maxFileBytes: integer(
            options.maxFileBytes,
            DEFAULT_MAX_FILE_BYTES,
            1,
            1024 * 1024 * 1024
        ),
        maxTotalBytes: integer(
            options.maxTotalBytes,
            DEFAULT_MAX_TOTAL_BYTES,
            1,
            2 * 1024 * 1024 * 1024
        )
    };
}

function normalizeRelativePath(value) {
    const relative = String(value || '');
    if (
        !relative ||
        relative.includes('\0') ||
        relative.includes('\\') ||
        relative.startsWith('/') ||
        /^[A-Za-z]:/u.test(relative)
    ) {
        fail('SESSION_PATH_INVALID', 'La sesión contiene una ruta no permitida.');
    }

    const parts = relative.split('/');
    if (!parts.length || parts.some(part => {
        return !part ||
            part === '.' ||
            part === '..' ||
            part.endsWith('.') ||
            part.endsWith(' ') ||
            /[<>:"|?*\u0000-\u001f]/u.test(part) ||
            WINDOWS_RESERVED_NAME.test(part);
    })) {
        fail('SESSION_PATH_INVALID', 'La sesión contiene un nombre de archivo no permitido.');
    }

    const normalized = path.posix.normalize(relative);
    if (normalized !== relative || normalized.startsWith('../')) {
        fail('SESSION_PATH_INVALID', 'La sesión contiene una ruta no normalizada.');
    }
    return normalized;
}

function resolveInside(root, relative) {
    const safeRelative = normalizeRelativePath(relative);
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, ...safeRelative.split('/'));
    const relation = path.relative(resolvedRoot, resolved);
    if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
        fail('SESSION_PATH_ESCAPE', 'La copia intentó escribir fuera de su carpeta.');
    }
    return resolved;
}

function canonicalizeExistingOrFuturePath(value) {
    const resolved = path.resolve(value);
    const missingParts = [];
    let cursor = resolved;
    while (!fs.existsSync(cursor)) {
        const parent = path.dirname(cursor);
        if (parent === cursor) {
            fail('PATH_CANONICALIZATION_FAILED', 'No se pudo validar la ruta solicitada.');
        }
        missingParts.unshift(path.basename(cursor));
        cursor = parent;
    }
    let canonicalBase;
    try {
        canonicalBase = fs.realpathSync.native(cursor);
    } catch (error) {
        fail('PATH_CANONICALIZATION_FAILED', 'No se pudo validar la ruta solicitada.', error);
    }
    return path.resolve(canonicalBase, ...missingParts);
}

function isSameOrInside(candidate, parent) {
    const normalizeForComparison = value => process.platform === 'win32'
        ? path.resolve(value).toLowerCase()
        : path.resolve(value);
    const child = normalizeForComparison(candidate);
    const root = normalizeForComparison(parent);
    const relation = path.relative(root, child);
    return relation === '' || (
        relation !== '..' &&
        !relation.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relation)
    );
}

function assertBackupOutsideSession(sessionDir, backupPath) {
    let canonicalSession;
    try {
        canonicalSession = fs.realpathSync.native(path.resolve(sessionDir));
    } catch (error) {
        fail('SESSION_NOT_FOUND', 'La carpeta de sesión no existe.', error);
    }
    const canonicalBackup = canonicalizeExistingOrFuturePath(backupPath);
    if (isSameOrInside(canonicalBackup, canonicalSession)) {
        fail(
            'BACKUP_INSIDE_SESSION',
            'La copia debe guardarse fuera de la carpeta activa de la sesión.'
        );
    }
    return { canonicalSession, canonicalBackup };
}

function validateManifestPaths(entries) {
    const exact = new Set();
    const caseInsensitive = new Set();
    const paths = [];
    for (const entry of entries) {
        const relative = normalizeRelativePath(entry.path);
        const folded = relative.toLowerCase();
        if (exact.has(relative) || caseInsensitive.has(folded)) {
            fail('MANIFEST_DUPLICATE_PATH', 'El manifiesto contiene rutas duplicadas.');
        }
        exact.add(relative);
        caseInsensitive.add(folded);
        paths.push(relative);
    }
    paths.sort();
    for (let index = 1; index < paths.length; index += 1) {
        if (paths[index].startsWith(`${paths[index - 1]}/`)) {
            fail(
                'MANIFEST_PATH_COLLISION',
                'El manifiesto mezcla un archivo con una carpeta del mismo nombre.'
            );
        }
    }
}

function listRegularFiles(root, maxFiles = DEFAULT_MAX_FILES) {
    const absoluteRoot = path.resolve(root);
    let rootStat;
    try {
        rootStat = fs.lstatSync(absoluteRoot);
    } catch (error) {
        fail('SESSION_NOT_FOUND', 'La carpeta de sesión no existe.', error);
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        fail('SESSION_NOT_DIRECTORY', 'La ruta de sesión debe ser una carpeta real.');
    }

    const files = [];
    const visit = (directory, prefix = '', depth = 0) => {
        if (depth > 64) {
            fail('SESSION_TOO_DEEP', 'La sesión supera la profundidad de carpetas permitida.');
        }
        const children = fs.readdirSync(directory, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name, 'en'));
        for (const child of children) {
            const relative = normalizeRelativePath(
                prefix ? `${prefix}/${child.name}` : child.name
            );
            const absolute = resolveInside(absoluteRoot, relative);
            if (child.isSymbolicLink()) {
                fail('SESSION_SPECIAL_FILE', 'La sesión contiene un enlace no permitido.');
            }
            if (child.isDirectory()) {
                visit(absolute, relative, depth + 1);
                continue;
            }
            if (!child.isFile()) {
                fail('SESSION_SPECIAL_FILE', 'La sesión contiene un archivo especial.');
            }
            files.push({ path: relative, absolute });
            if (files.length > maxFiles) {
                fail('SESSION_TOO_MANY_FILES', 'La sesión supera el límite de archivos.');
            }
        }
    };
    visit(absoluteRoot);
    return { root: absoluteRoot, files };
}

function readSessionSnapshot(sessionDir, options = {}) {
    const limits = normalizeLimits(options);
    const listed = listRegularFiles(sessionDir, limits.maxFiles);
    if (!listed.files.length) {
        fail('SESSION_EMPTY', 'La carpeta de sesión está vacía.');
    }
    if (listed.files.length > limits.maxFiles) {
        fail('SESSION_TOO_MANY_FILES', 'La sesión supera el límite de archivos.');
    }

    const entries = [];
    let totalBytes = 0;
    try {
        for (const item of listed.files) {
            const before = fs.statSync(item.absolute, { bigint: true });
            if (!before.isFile()) {
                fail('SESSION_SPECIAL_FILE', 'La sesión cambió durante la lectura.');
            }
            const size = Number(before.size);
            if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes) {
                fail('SESSION_FILE_TOO_LARGE', 'Un archivo de sesión supera el límite seguro.');
            }
            totalBytes += size;
            if (totalBytes > limits.maxTotalBytes) {
                fail('SESSION_TOO_LARGE', 'La sesión supera el tamaño máximo permitido.');
            }

            const data = fs.readFileSync(item.absolute);
            const after = fs.statSync(item.absolute, { bigint: true });
            if (
                before.size !== after.size ||
                before.mtimeNs !== after.mtimeNs ||
                data.length !== size
            ) {
                data.fill(0);
                fail('SESSION_CHANGED', 'La sesión cambió mientras se preparaba la copia.');
            }
            entries.push({
                path: item.path,
                size,
                sha256: sha256Buffer(data),
                data
            });
        }
    } catch (error) {
        for (const entry of entries) entry.data.fill(0);
        throw error;
    }

    try {
        entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
        validateManifestPaths(entries);
    } catch (error) {
        for (const entry of entries) entry.data.fill(0);
        throw error;
    }
    return { root: listed.root, entries, totalBytes };
}

function wipeSnapshot(snapshot) {
    for (const entry of snapshot?.entries || []) {
        entry.data?.fill?.(0);
    }
}

function detectLoginIdentity(entries) {
    const credentials = entries.find(entry => entry.path === 'creds.json');
    if (!credentials) return false;
    try {
        const parsed = JSON.parse(credentials.data.toString('utf8'));
        return typeof parsed?.me?.id === 'string' && parsed.me.id.trim().length > 0;
    } catch {
        return false;
    }
}

function manifestFromSnapshot(snapshot, createdAt = new Date().toISOString()) {
    return {
        version: MANIFEST_VERSION,
        createdAt,
        loginIdentityPresent: detectLoginIdentity(snapshot.entries),
        totalBytes: snapshot.totalBytes,
        entries: snapshot.entries.map(entry => ({
            path: entry.path,
            size: entry.size,
            sha256: entry.sha256
        }))
    };
}

function serializeManifest(manifest) {
    const serialized = Buffer.from(JSON.stringify(manifest), 'utf8');
    if (serialized.length > MAX_MANIFEST_BYTES) {
        fail('MANIFEST_TOO_LARGE', 'El manifiesto supera el tamaño permitido.');
    }
    return serialized;
}

function buildArchive(snapshot, manifest) {
    const manifestBuffer = serializeManifest(manifest);
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(manifestBuffer.length, 0);
    return Buffer.concat([
        length,
        manifestBuffer,
        ...snapshot.entries.map(entry => entry.data)
    ]);
}

function parseArchive(archive, options = {}) {
    const limits = normalizeLimits(options);
    if (!Buffer.isBuffer(archive) || archive.length < 4) {
        fail('ARCHIVE_INVALID', 'El contenido descifrado está incompleto.');
    }
    const manifestLength = archive.readUInt32BE(0);
    if (
        manifestLength < 2 ||
        manifestLength > MAX_MANIFEST_BYTES ||
        4 + manifestLength > archive.length
    ) {
        fail('MANIFEST_INVALID', 'El manifiesto cifrado no es válido.');
    }

    let manifest;
    try {
        manifest = JSON.parse(archive.subarray(4, 4 + manifestLength).toString('utf8'));
    } catch (error) {
        fail('MANIFEST_INVALID', 'El manifiesto no contiene JSON válido.', error);
    }
    if (
        !manifest ||
        manifest.version !== MANIFEST_VERSION ||
        typeof manifest.loginIdentityPresent !== 'boolean' ||
        !Array.isArray(manifest.entries) ||
        manifest.entries.length < 1 ||
        manifest.entries.length > limits.maxFiles
    ) {
        fail('MANIFEST_INVALID', 'La versión o estructura del manifiesto no es válida.');
    }

    const normalizedEntries = [];
    let totalBytes = 0;
    for (const candidate of manifest.entries) {
        const relative = normalizeRelativePath(candidate?.path);
        const size = Number(candidate?.size);
        const hash = String(candidate?.sha256 || '');
        if (
            !Number.isSafeInteger(size) ||
            size < 0 ||
            size > limits.maxFileBytes ||
            !/^[a-f0-9]{64}$/u.test(hash)
        ) {
            fail('MANIFEST_INVALID', 'El manifiesto contiene metadatos no válidos.');
        }
        totalBytes += size;
        if (totalBytes > limits.maxTotalBytes) {
            fail('SESSION_TOO_LARGE', 'La copia supera el tamaño máximo permitido.');
        }
        normalizedEntries.push({ path: relative, size, sha256: hash });
    }
    validateManifestPaths(normalizedEntries);
    if (
        Number(manifest.totalBytes) !== totalBytes ||
        archive.length !== 4 + manifestLength + totalBytes
    ) {
        fail('ARCHIVE_SIZE_MISMATCH', 'El contenido no coincide con el manifiesto.');
    }

    let offset = 4 + manifestLength;
    const entries = normalizedEntries.map(entry => {
        const data = archive.subarray(offset, offset + entry.size);
        offset += entry.size;
        if (!constantTimeEqual(Buffer.from(sha256Buffer(data), 'hex'), Buffer.from(entry.sha256, 'hex'))) {
            fail('ARCHIVE_HASH_MISMATCH', 'Un archivo no coincide con su hash verificado.');
        }
        return { ...entry, data };
    });

    return {
        manifest: {
            version: MANIFEST_VERSION,
            createdAt: String(manifest.createdAt || ''),
            loginIdentityPresent: manifest.loginIdentityPresent === true,
            totalBytes,
            entries: normalizedEntries
        },
        entries
    };
}

function manifestDigest(manifest) {
    return sha256Text(JSON.stringify({
        version: manifest.version,
        loginIdentityPresent: manifest.loginIdentityPresent === true,
        totalBytes: manifest.totalBytes,
        entries: manifest.entries
    }));
}

function compareManifestEntries(left, right) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        const a = left[index];
        const b = right[index];
        if (
            a.path !== b.path ||
            a.size !== b.size ||
            a.sha256 !== b.sha256
        ) return false;
    }
    return true;
}

function validateProtector(protector) {
    if (
        !protector ||
        typeof protector.protect !== 'function' ||
        typeof protector.unprotect !== 'function' ||
        !/^[a-z0-9._-]{1,80}$/u.test(String(protector.id || ''))
    ) {
        fail('KEY_PROTECTOR_INVALID', 'No se configuró un protector de clave válido.');
    }
    return protector;
}

function createElectronSafeStorageProtector(safeStorageInput) {
    let safeStorage = safeStorageInput;
    if (!safeStorage) {
        try {
            safeStorage = require('electron')?.safeStorage;
        } catch {
            safeStorage = null;
        }
    }
    if (
        !safeStorage ||
        typeof safeStorage.isEncryptionAvailable !== 'function' ||
        safeStorage.isEncryptionAvailable() !== true ||
        typeof safeStorage.encryptString !== 'function' ||
        typeof safeStorage.decryptString !== 'function'
    ) return null;

    if (
        typeof safeStorage.getSelectedStorageBackend === 'function' &&
        safeStorage.getSelectedStorageBackend() === 'basic_text'
    ) return null;

    return Object.freeze({
        id: 'electron-safe-storage-v1',
        async protect(key) {
            const value = Buffer.from(key);
            try {
                if (value.length !== KEY_BYTES) {
                    fail('KEY_INVALID', 'La clave de contenido no tiene 256 bits.');
                }
                return Buffer.from(
                    safeStorage.encryptString(value.toString('base64'))
                );
            } finally {
                value.fill(0);
            }
        },
        async unprotect(wrapped) {
            let text;
            try {
                text = safeStorage.decryptString(Buffer.from(wrapped));
            } catch (error) {
                fail('KEY_UNWRAP_FAILED', 'Windows no pudo abrir la clave de la copia.', error);
            }
            const key = decodeBase64Strict(text, 'clave protegida', KEY_BYTES);
            if (key.length !== KEY_BYTES) {
                key.fill(0);
                fail('KEY_INVALID', 'La clave recuperada no tiene 256 bits.');
            }
            return key;
        }
    });
}

function createPassphraseKeyProtector(passphraseInput, options = {}) {
    const passphrase = String(passphraseInput || '');
    if (passphrase.length < 12) {
        fail('PASSPHRASE_WEAK', 'La contraseña de respaldo debe tener al menos 12 caracteres.');
    }
    const validCost = value => Number.isSafeInteger(value) &&
        value >= 16384 &&
        value <= 262144 &&
        (value & (value - 1)) === 0;
    const cost = validCost(options.cost) ? options.cost : 32768;
    const blockSize = 8;
    const parallelization = 1;
    const derive = (salt, selectedCost) => crypto.scryptSync(
        passphrase,
        salt,
        KEY_BYTES,
        {
            N: selectedCost,
            r: blockSize,
            p: parallelization,
            maxmem: Math.max(
                128 * 1024 * 1024,
                256 * selectedCost * blockSize
            )
        }
    );

    return Object.freeze({
        id: 'passphrase-scrypt-aes256gcm-v1',
        async protect(keyInput) {
            const key = Buffer.from(keyInput);
            if (key.length !== KEY_BYTES) {
                key.fill(0);
                fail('KEY_INVALID', 'La clave de contenido no tiene 256 bits.');
            }
            const salt = crypto.randomBytes(16);
            const iv = crypto.randomBytes(GCM_IV_BYTES);
            const derived = derive(salt, cost);
            try {
                const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv);
                cipher.setAAD(KEY_WRAP_AAD);
                const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
                const payload = {
                    version: 1,
                    cost,
                    salt: salt.toString('base64'),
                    iv: iv.toString('base64'),
                    tag: cipher.getAuthTag().toString('base64'),
                    ciphertext: ciphertext.toString('base64')
                };
                ciphertext.fill(0);
                return Buffer.from(JSON.stringify(payload), 'utf8');
            } finally {
                key.fill(0);
                derived.fill(0);
                salt.fill(0);
                iv.fill(0);
            }
        },
        async unprotect(wrapped) {
            let payload;
            try {
                payload = JSON.parse(Buffer.from(wrapped).toString('utf8'));
            } catch (error) {
                fail('KEY_WRAP_INVALID', 'La clave protegida no tiene un formato válido.', error);
            }
            const storedCost = Number(payload?.cost);
            if (payload?.version !== 1 || !validCost(storedCost)) {
                fail('KEY_WRAP_INVALID', 'La configuración de la clave protegida no coincide.');
            }
            const salt = decodeBase64Strict(payload.salt, 'salt', 16);
            const iv = decodeBase64Strict(payload.iv, 'iv', GCM_IV_BYTES);
            const tag = decodeBase64Strict(payload.tag, 'tag', GCM_TAG_BYTES);
            const ciphertext = decodeBase64Strict(payload.ciphertext, 'ciphertext', KEY_BYTES);
            if (
                salt.length !== 16 ||
                iv.length !== GCM_IV_BYTES ||
                tag.length !== GCM_TAG_BYTES ||
                ciphertext.length !== KEY_BYTES
            ) {
                fail('KEY_WRAP_INVALID', 'La clave protegida está incompleta.');
            }
            // El costo forma parte del sobre para que una copia antigua siga
            // siendo restaurable aunque una versión futura eleve el valor por
            // defecto. Siempre se valida dentro de límites seguros.
            const derived = derive(salt, storedCost);
            try {
                const decipher = crypto.createDecipheriv('aes-256-gcm', derived, iv);
                decipher.setAAD(KEY_WRAP_AAD);
                decipher.setAuthTag(tag);
                const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
                if (key.length !== KEY_BYTES) {
                    key.fill(0);
                    fail('KEY_INVALID', 'La clave recuperada no tiene 256 bits.');
                }
                return key;
            } catch (error) {
                if (error instanceof SessionSecurityError) throw error;
                fail('KEY_UNWRAP_FAILED', 'La contraseña no pudo abrir la clave de la copia.', error);
            } finally {
                derived.fill(0);
                salt.fill(0);
                iv.fill(0);
                tag.fill(0);
                ciphertext.fill(0);
            }
        }
    });
}

function createLocalKeyProtector(options = {}) {
    const electronProtector = createElectronSafeStorageProtector(options.safeStorage);
    if (electronProtector) return electronProtector;
    if (options.passphrase) {
        return createPassphraseKeyProtector(options.passphrase, options.scrypt);
    }
    fail(
        'KEY_PROTECTION_UNAVAILABLE',
        'No hay cifrado seguro del sistema ni una contraseña de respaldo configurada.'
    );
}

function backupAad(header) {
    return Buffer.from(JSON.stringify({
        format: header.format,
        version: header.version,
        cipher: header.cipher,
        backupId: header.backupId,
        protector: header.protector
    }), 'utf8');
}

async function buildEncryptedContainer(archive, protectorInput) {
    const protector = validateProtector(protectorInput);
    const contentKey = crypto.randomBytes(KEY_BYTES);
    const iv = crypto.randomBytes(GCM_IV_BYTES);
    const backupId = crypto.randomBytes(16).toString('base64url');
    let wrappedKey;
    let keyForProtector;
    let verificationKey;
    let verificationPlaintext;
    try {
        keyForProtector = Buffer.from(contentKey);
        wrappedKey = Buffer.from(await protector.protect(keyForProtector));
        if (!wrappedKey.length || wrappedKey.length > MAX_HEADER_BYTES) {
            fail('KEY_WRAP_INVALID', 'El protector devolvió una clave no válida.');
        }
        const headerBase = {
            format: BACKUP_FORMAT,
            version: BACKUP_VERSION,
            cipher: 'AES-256-GCM',
            backupId,
            protector: protector.id
        };
        const cipher = crypto.createCipheriv('aes-256-gcm', contentKey, iv);
        cipher.setAAD(backupAad(headerBase));
        const ciphertext = Buffer.concat([cipher.update(archive), cipher.final()]);
        const header = {
            ...headerBase,
            wrappedKey: wrappedKey.toString('base64'),
            iv: iv.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
            ciphertextBytes: ciphertext.length
        };
        const headerBuffer = Buffer.from(JSON.stringify(header), 'utf8');
        if (headerBuffer.length > MAX_HEADER_BYTES) {
            ciphertext.fill(0);
            fail('BACKUP_HEADER_TOO_LARGE', 'La cabecera de la copia es demasiado grande.');
        }

        // Roundtrip obligatorio antes de publicar la copia: también valida el
        // protector local, no solamente AES-GCM.
        const unwrapped = await protector.unprotect(wrappedKey);
        verificationKey = Buffer.isBuffer(unwrapped)
            ? unwrapped
            : Buffer.from(unwrapped);
        if (!constantTimeEqual(contentKey, verificationKey)) {
            ciphertext.fill(0);
            fail('KEY_ROUNDTRIP_FAILED', 'La clave local no superó la verificación.');
        }
        const decipher = crypto.createDecipheriv('aes-256-gcm', verificationKey, iv);
        decipher.setAAD(backupAad(headerBase));
        decipher.setAuthTag(Buffer.from(header.tag, 'base64'));
        verificationPlaintext = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final()
        ]);
        if (!constantTimeEqual(archive, verificationPlaintext)) {
            ciphertext.fill(0);
            fail('BACKUP_ROUNDTRIP_FAILED', 'La copia cifrada no coincide byte a byte.');
        }

        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(headerBuffer.length, 0);
        return Buffer.concat([BACKUP_MAGIC, length, headerBuffer, ciphertext]);
    } finally {
        contentKey.fill(0);
        keyForProtector?.fill?.(0);
        iv.fill(0);
        wrappedKey?.fill?.(0);
        verificationKey?.fill?.(0);
        verificationPlaintext?.fill?.(0);
    }
}

function parseContainerHeader(container) {
    if (
        !Buffer.isBuffer(container) ||
        container.length < BACKUP_MAGIC.length + 4 ||
        !constantTimeEqual(
            container.subarray(0, BACKUP_MAGIC.length),
            BACKUP_MAGIC
        )
    ) {
        fail('BACKUP_FORMAT_INVALID', 'El archivo no es una copia de sesión de ZeroOne.');
    }
    const headerLength = container.readUInt32BE(BACKUP_MAGIC.length);
    const headerStart = BACKUP_MAGIC.length + 4;
    const ciphertextStart = headerStart + headerLength;
    if (
        headerLength < 2 ||
        headerLength > MAX_HEADER_BYTES ||
        ciphertextStart > container.length
    ) {
        fail('BACKUP_HEADER_INVALID', 'La cabecera de la copia está incompleta.');
    }
    let header;
    try {
        header = JSON.parse(container.subarray(headerStart, ciphertextStart).toString('utf8'));
    } catch (error) {
        fail('BACKUP_HEADER_INVALID', 'La cabecera no contiene JSON válido.', error);
    }
    if (
        header?.format !== BACKUP_FORMAT ||
        header?.version !== BACKUP_VERSION ||
        header?.cipher !== 'AES-256-GCM' ||
        !/^[A-Za-z0-9_-]{22}$/u.test(String(header?.backupId || '')) ||
        !/^[a-z0-9._-]{1,80}$/u.test(String(header?.protector || '')) ||
        !Number.isSafeInteger(header?.ciphertextBytes) ||
        header.ciphertextBytes < 1 ||
        header.ciphertextBytes !== container.length - ciphertextStart
    ) {
        fail('BACKUP_HEADER_INVALID', 'La cabecera contiene valores no válidos.');
    }
    return {
        header,
        ciphertext: container.subarray(ciphertextStart)
    };
}

async function decryptContainer(container, protectorInput, options = {}) {
    const protector = validateProtector(protectorInput);
    const { header, ciphertext } = parseContainerHeader(container);
    if (header.protector !== protector.id) {
        fail(
            'KEY_PROTECTOR_MISMATCH',
            'La copia requiere otro mecanismo de protección de clave.'
        );
    }
    const wrappedKey = decodeBase64Strict(
        header.wrappedKey,
        'wrappedKey',
        MAX_HEADER_BYTES
    );
    const iv = decodeBase64Strict(header.iv, 'iv', GCM_IV_BYTES);
    const tag = decodeBase64Strict(header.tag, 'tag', GCM_TAG_BYTES);
    if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) {
        fail('BACKUP_HEADER_INVALID', 'Los parámetros AES-GCM no son válidos.');
    }

    let key;
    let plaintext;
    let completed = false;
    try {
        const unwrapped = await protector.unprotect(wrappedKey);
        key = Buffer.isBuffer(unwrapped) ? unwrapped : Buffer.from(unwrapped);
        if (key.length !== KEY_BYTES) {
            fail('KEY_INVALID', 'La clave recuperada no tiene 256 bits.');
        }
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(backupAad(header));
        decipher.setAuthTag(tag);
        try {
            plaintext = Buffer.concat([
                decipher.update(ciphertext),
                decipher.final()
            ]);
        } catch (error) {
            fail('BACKUP_AUTH_FAILED', 'La copia fue alterada o la clave no es correcta.', error);
        }
        const parsed = parseArchive(plaintext, options);
        completed = true;
        return { ...parsed, plaintext, header };
    } finally {
        if (!completed) plaintext?.fill?.(0);
        key?.fill?.(0);
        wrappedKey.fill(0);
        iv.fill(0);
        tag.fill(0);
    }
}

function writeAtomicNewFile(destination, data) {
    const target = path.resolve(destination);
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (fs.existsSync(target)) {
        fail('BACKUP_EXISTS', 'La copia de seguridad ya existe y no será reemplazada.');
    }
    const temporary = path.join(
        parent,
        `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
    );
    let descriptor;
    let failure;
    try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, data);
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = null;
        // Un hard-link publica el archivo completo de forma atómica y nunca
        // sustituye silenciosamente un destino creado por otra operación.
        fs.linkSync(temporary, target);
    } catch (error) {
        failure = error;
    } finally {
        if (descriptor !== null && descriptor !== undefined) {
            try { fs.closeSync(descriptor); } catch { }
        }
        try { fs.rmSync(temporary, { force: true }); } catch { }
    }
    if (failure) {
        if (failure instanceof SessionSecurityError) throw failure;
        if (failure?.code === 'EEXIST') {
            fail('BACKUP_EXISTS', 'La copia de seguridad ya existe y no será reemplazada.', failure);
        }
        fail(
            'BACKUP_ATOMIC_WRITE_FAILED',
            'El sistema de archivos no pudo publicar la copia de forma atómica y segura.',
            failure
        );
    }
    return target;
}

function readBackupContainer(backupPath, options = {}) {
    const source = path.resolve(backupPath);
    const limits = normalizeLimits(options);
    let stat;
    try {
        stat = fs.lstatSync(source);
    } catch (error) {
        fail('BACKUP_NOT_FOUND', 'La copia de seguridad no existe.', error);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
        fail('BACKUP_NOT_FILE', 'La copia debe ser un archivo regular.');
    }
    const maximum = limits.maxTotalBytes +
        MAX_MANIFEST_BYTES +
        MAX_HEADER_BYTES +
        BACKUP_MAGIC.length +
        8;
    if (!Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maximum) {
        fail('BACKUP_TOO_LARGE', 'La copia supera el tamaño máximo permitido.');
    }
    return fs.readFileSync(source);
}

function currentWindowsUserSid(runCommand) {
    let output;
    try {
        output = runCommand(
            'whoami.exe',
            ['/user', '/fo', 'csv', '/nh'],
            { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
        );
    } catch (error) {
        fail('RESTORE_ACL_FAILED', 'Windows no pudo identificar al usuario local.', error);
    }
    const match = String(output).match(/"(S-\d+(?:-\d+)+)"/iu);
    if (!match) {
        fail('RESTORE_ACL_FAILED', 'Windows no devolvió un SID de usuario válido.');
    }
    return match[1];
}

function restrictRestoredDirectoryAccess(directory, platformSecurity = {}) {
    const platform = platformSecurity.platform || process.platform;
    const runCommand = platformSecurity.execFileSync || execFileSync;
    if (typeof runCommand !== 'function') {
        fail('RESTORE_ACL_FAILED', 'No se configuró un ejecutor de seguridad válido.');
    }
    if (platform === 'win32') {
        const sid = currentWindowsUserSid(runCommand);
        try {
            runCommand(
                'icacls.exe',
                [
                    directory,
                    '/inheritance:r',
                    '/grant:r',
                    `*${sid}:(OI)(CI)F`,
                    '*S-1-5-18:(OI)(CI)F'
                ],
                { windowsHide: true, stdio: 'ignore' }
            );
        } catch (error) {
            fail(
                'RESTORE_ACL_FAILED',
                'Windows no pudo restringir la carpeta restaurada al usuario actual.',
                error
            );
        }
        return;
    }
    try {
        fs.chmodSync(directory, 0o700);
        if ((fs.statSync(directory).mode & 0o077) !== 0) {
            fail('RESTORE_ACL_FAILED', 'La carpeta restaurada no quedó en modo privado.');
        }
    } catch (error) {
        if (error instanceof SessionSecurityError) throw error;
        fail('RESTORE_ACL_FAILED', 'No se pudo proteger la carpeta restaurada.', error);
    }
}

function writeRestoredEntries(staging, entries, platformSecurity) {
    fs.mkdirSync(staging, { recursive: false, mode: 0o700 });
    restrictRestoredDirectoryAccess(staging, platformSecurity);
    for (const entry of entries) {
        const destination = resolveInside(staging, entry.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        const descriptor = fs.openSync(destination, 'wx', 0o600);
        try {
            fs.writeFileSync(descriptor, entry.data);
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
    }
}

function summaryFromManifest(manifest) {
    // No incluye createdAt: la misma sesión produce siempre la misma huella,
    // aunque el respaldo se haya creado en otro momento.
    const sessionFingerprintSha256 = manifestDigest(manifest);
    return Object.freeze({
        version: manifest.version,
        loginIdentityPresent: manifest.loginIdentityPresent === true,
        fileCount: manifest.entries.length,
        totalBytes: manifest.totalBytes,
        manifestSha256: sessionFingerprintSha256,
        sessionFingerprintSha256
    });
}

async function inspectSessionDirectory(sessionDir, options = {}) {
    const snapshot = readSessionSnapshot(sessionDir, options);
    try {
        return summaryFromManifest(manifestFromSnapshot(snapshot, ''));
    } finally {
        wipeSnapshot(snapshot);
    }
}

async function fingerprintSessionDirectory(sessionDir, options = {}) {
    const inspection = await inspectSessionDirectory(sessionDir, options);
    return inspection.sessionFingerprintSha256;
}

async function planSessionMigration({ sessionDir, backupPath, ...options }) {
    assertBackupOutsideSession(sessionDir, backupPath);
    const summary = await inspectSessionDirectory(sessionDir, options);
    return Object.freeze({
        mode: 'encrypted-backup-only',
        automatic: false,
        sourceWillBeModified: false,
        backupAlreadyExists: fs.existsSync(path.resolve(backupPath)),
        ...summary
    });
}

async function createEncryptedSessionBackup({
    sessionDir,
    backupPath,
    protector,
    ...options
}) {
    validateProtector(protector);
    assertBackupOutsideSession(sessionDir, backupPath);
    const destination = path.resolve(backupPath);
    if (fs.existsSync(destination)) {
        fail('BACKUP_EXISTS', 'La copia de seguridad ya existe y no será reemplazada.');
    }

    let snapshot;
    let verificationSnapshot;
    let archive;
    let container;
    try {
        snapshot = readSessionSnapshot(sessionDir, options);
        const manifest = manifestFromSnapshot(snapshot);
        archive = buildArchive(snapshot, manifest);
        container = await buildEncryptedContainer(archive, protector);

        // La fuente debe seguir siendo exactamente la fotografiada. Si Baileys
        // escribió mientras se copiaba, se aborta sin publicar el respaldo.
        verificationSnapshot = readSessionSnapshot(sessionDir, options);
        const verificationManifest = manifestFromSnapshot(verificationSnapshot, '');
        if (!compareManifestEntries(manifest.entries, verificationManifest.entries)) {
            fail('SESSION_CHANGED', 'La sesión cambió antes de finalizar la copia.');
        }

        // Se repite justo antes de publicar para reducir el riesgo de que una
        // ruta futura haya sido redirigida hacia la sesión durante el proceso.
        assertBackupOutsideSession(sessionDir, destination);
        writeAtomicNewFile(destination, container);
        return Object.freeze({
            path: destination,
            sourceModified: false,
            roundTripVerified: true,
            ...summaryFromManifest(manifest)
        });
    } finally {
        wipeSnapshot(snapshot);
        wipeSnapshot(verificationSnapshot);
        archive?.fill?.(0);
        container?.fill?.(0);
    }
}

async function verifyEncryptedSessionBackup({ backupPath, protector, ...options }) {
    const container = readBackupContainer(backupPath, options);
    let decrypted;
    try {
        decrypted = await decryptContainer(container, protector, options);
        return Object.freeze({
            valid: true,
            protector: decrypted.header.protector,
            ...summaryFromManifest(decrypted.manifest)
        });
    } finally {
        decrypted?.plaintext?.fill?.(0);
        container.fill(0);
    }
}

async function restoreEncryptedSessionBackup({
    backupPath,
    targetDir,
    protector,
    platformSecurity,
    ...options
}) {
    const target = path.resolve(targetDir);
    if (fs.existsSync(target)) {
        fail(
            'RESTORE_TARGET_EXISTS',
            'La restauración no reemplaza sesiones existentes. Elegí una carpeta nueva.'
        );
    }
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const staging = path.join(
        parent,
        `.${path.basename(target)}.restore-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
    );
    const container = readBackupContainer(backupPath, options);
    let decrypted;
    let verificationSnapshot;
    try {
        decrypted = await decryptContainer(container, protector, options);
        if (fs.existsSync(staging)) {
            fail('RESTORE_STAGING_EXISTS', 'La carpeta temporal de restauración ya existe.');
        }
        writeRestoredEntries(staging, decrypted.entries, platformSecurity);
        verificationSnapshot = readSessionSnapshot(staging, options);
        const verificationManifest = manifestFromSnapshot(verificationSnapshot, '');
        if (!compareManifestEntries(
            decrypted.manifest.entries,
            verificationManifest.entries
        )) {
            fail('RESTORE_VERIFY_FAILED', 'La restauración no coincide con el manifiesto.');
        }
        if (fs.existsSync(target)) {
            fail(
                'RESTORE_TARGET_EXISTS',
                'La carpeta destino apareció durante la restauración y no fue reemplazada.'
            );
        }
        fs.renameSync(staging, target);
        return Object.freeze({
            path: target,
            atomicPublish: true,
            existingSessionReplaced: false,
            ...summaryFromManifest(decrypted.manifest)
        });
    } catch (error) {
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch { }
        throw error;
    } finally {
        wipeSnapshot(verificationSnapshot);
        decrypted?.plaintext?.fill?.(0);
        container.fill(0);
    }
}

async function compareSessionDirectoriesByteForByte(leftDir, rightDir, options = {}) {
    const left = readSessionSnapshot(leftDir, options);
    const right = readSessionSnapshot(rightDir, options);
    try {
        if (!compareManifestEntries(left.entries, right.entries)) {
            fail('DIRECTORY_MISMATCH', 'Las carpetas no tienen el mismo manifiesto.');
        }
        for (let index = 0; index < left.entries.length; index += 1) {
            if (!constantTimeEqual(left.entries[index].data, right.entries[index].data)) {
                fail('DIRECTORY_MISMATCH', 'Las carpetas no coinciden byte a byte.');
            }
        }
        const manifest = manifestFromSnapshot(left, '');
        return Object.freeze({
            identical: true,
            ...summaryFromManifest(manifest)
        });
    } finally {
        wipeSnapshot(left);
        wipeSnapshot(right);
    }
}

module.exports = {
    BACKUP_FORMAT,
    BACKUP_VERSION,
    DEFAULT_MAX_FILE_BYTES,
    DEFAULT_MAX_FILES,
    DEFAULT_MAX_TOTAL_BYTES,
    SessionSecurityError,
    compareSessionDirectoriesByteForByte,
    createElectronSafeStorageProtector,
    createEncryptedSessionBackup,
    createLocalKeyProtector,
    createPassphraseKeyProtector,
    fingerprintSessionDirectory,
    inspectSessionDirectory,
    planSessionMigration,
    restoreEncryptedSessionBackup,
    verifyEncryptedSessionBackup
};
