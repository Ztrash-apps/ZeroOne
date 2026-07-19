'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    BufferJSON,
    initAuthCreds,
    useMultiFileAuthState
} = require('@whiskeysockets/baileys');
const {
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
} = require('../src/session-security');

function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-session-security-'));
    const session = path.join(root, 'session-source');
    fs.mkdirSync(path.join(session, 'nested'), { recursive: true });
    const credentials = initAuthCreds();
    Object.assign(credentials, {
        // En Baileys 7 este indicador puede ser false aunque la identidad sea
        // reutilizable; el criterio fiable para esta comprobación es me.id.
        registered: false,
        me: { id: '595000000000@s.whatsapp.net' },
        testOnly: true
    });
    fs.writeFileSync(
        path.join(session, 'creds.json'),
        JSON.stringify(credentials, BufferJSON.replacer)
    );
    fs.writeFileSync(
        path.join(session, 'app-state-sync-key-test.json'),
        JSON.stringify({ keyData: { type: 'Buffer', data: [1, 2, 3, 4] } })
    );
    fs.writeFileSync(
        path.join(session, 'nested', 'binary.dat'),
        Buffer.from([0, 1, 2, 3, 254, 255])
    );
    return {
        root,
        session,
        backup: path.join(root, 'line-test.z1session'),
        restored: path.join(root, 'session-restored'),
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

function createSyntheticWindowsSecurity() {
    const calls = [];
    return {
        calls,
        adapter: {
            platform: 'win32',
            execFileSync(command, args) {
                calls.push({ command, args: [...args] });
                if (command === 'whoami.exe') {
                    return '"equipo\\prueba","S-1-5-21-100-200-300-1001"\r\n';
                }
                if (command === 'icacls.exe') return Buffer.alloc(0);
                throw new Error(`Comando inesperado: ${command}`);
            }
        }
    };
}

test('crea, verifica y restaura una sesión sin modificar la fuente', async () => {
    const fixture = createFixture();
    const windowsSecurity = createSyntheticWindowsSecurity();
    const protector = createPassphraseKeyProtector(
        'prueba-local-muy-larga-2026'
    );
    try {
        const before = await inspectSessionDirectory(fixture.session);
        const created = await createEncryptedSessionBackup({
            sessionDir: fixture.session,
            backupPath: fixture.backup,
            protector
        });
        assert.equal(created.sourceModified, false);
        assert.equal(created.roundTripVerified, true);
        assert.equal(created.loginIdentityPresent, true);
        assert.equal(JSON.stringify(created).includes('595000000000'), false);
        assert.equal(fs.existsSync(fixture.backup), true);
        assert.equal(fs.readFileSync(fixture.backup).includes('595000000000'), false);

        const verified = await verifyEncryptedSessionBackup({
            backupPath: fixture.backup,
            protector
        });
        assert.equal(verified.valid, true);
        assert.equal(verified.manifestSha256, before.manifestSha256);
        assert.equal(
            verified.sessionFingerprintSha256,
            await fingerprintSessionDirectory(fixture.session)
        );

        const restored = await restoreEncryptedSessionBackup({
            backupPath: fixture.backup,
            targetDir: fixture.restored,
            protector,
            platformSecurity: windowsSecurity.adapter
        });
        assert.equal(restored.atomicPublish, true);
        assert.equal(restored.existingSessionReplaced, false);
        assert.equal(windowsSecurity.calls[0].command, 'whoami.exe');
        assert.equal(windowsSecurity.calls[1].command, 'icacls.exe');
        assert.equal(
            windowsSecurity.calls[1].args.includes('/inheritance:r'),
            true
        );
        assert.equal(
            windowsSecurity.calls[1].args.includes(
                '*S-1-5-21-100-200-300-1001:(OI)(CI)F'
            ),
            true
        );

        const comparison = await compareSessionDirectoriesByteForByte(
            fixture.session,
            fixture.restored
        );
        assert.equal(comparison.identical, true);

        // Solo lectura: no se llama saveCreds, keys.set ni se crea socket.
        const { state } = await useMultiFileAuthState(fixture.restored);
        assert.equal(typeof state.creds.me?.id, 'string');
        assert.notEqual(state.creds.me.id.trim(), '');
        assert.equal(state.creds.registered, false);
        assert.equal(Buffer.isBuffer(state.creds.noiseKey.private), true);
        assert.equal(Buffer.isBuffer(state.creds.signedIdentityKey.private), true);

        const after = await inspectSessionDirectory(fixture.session);
        assert.deepEqual(after, before);
    } finally {
        fixture.cleanup();
    }
});

test('rechaza una copia alterada y no publica una restauración parcial', async () => {
    const fixture = createFixture();
    const protector = createPassphraseKeyProtector(
        'otra-prueba-local-larga-2026'
    );
    try {
        await createEncryptedSessionBackup({
            sessionDir: fixture.session,
            backupPath: fixture.backup,
            protector
        });
        const altered = fs.readFileSync(fixture.backup);
        altered[altered.length - 1] ^= 0xff;
        fs.writeFileSync(fixture.backup, altered);

        await assert.rejects(
            verifyEncryptedSessionBackup({
                backupPath: fixture.backup,
                protector
            }),
            error => error instanceof SessionSecurityError &&
                error.code === 'BACKUP_AUTH_FAILED'
        );
        await assert.rejects(
            restoreEncryptedSessionBackup({
                backupPath: fixture.backup,
                targetDir: fixture.restored,
                protector
            }),
            error => error instanceof SessionSecurityError &&
                error.code === 'BACKUP_AUTH_FAILED'
        );
        assert.equal(fs.existsSync(fixture.restored), false);
    } finally {
        fixture.cleanup();
    }
});

test('nunca reemplaza una carpeta de sesión existente', async () => {
    const fixture = createFixture();
    const protector = createPassphraseKeyProtector(
        'proteccion-de-destino-larga-2026'
    );
    try {
        await createEncryptedSessionBackup({
            sessionDir: fixture.session,
            backupPath: fixture.backup,
            protector
        });
        fs.mkdirSync(fixture.restored);
        const marker = path.join(fixture.restored, 'no-reemplazar.txt');
        fs.writeFileSync(marker, 'intacto');

        await assert.rejects(
            restoreEncryptedSessionBackup({
                backupPath: fixture.backup,
                targetDir: fixture.restored,
                protector
            }),
            error => error instanceof SessionSecurityError &&
                error.code === 'RESTORE_TARGET_EXISTS'
        );
        assert.equal(fs.readFileSync(marker, 'utf8'), 'intacto');
    } finally {
        fixture.cleanup();
    }
});

test('una contraseña incorrecta falla cerrada y una copia existente queda intacta', async () => {
    const fixture = createFixture();
    const protector = createPassphraseKeyProtector(
        'contraseña-correcta-local-2026'
    );
    const incorrectProtector = createPassphraseKeyProtector(
        'contraseña-incorrecta-local-2026'
    );
    try {
        await createEncryptedSessionBackup({
            sessionDir: fixture.session,
            backupPath: fixture.backup,
            protector
        });
        const original = fs.readFileSync(fixture.backup);

        await assert.rejects(
            verifyEncryptedSessionBackup({
                backupPath: fixture.backup,
                protector: incorrectProtector
            }),
            error => error instanceof SessionSecurityError &&
                error.code === 'KEY_UNWRAP_FAILED'
        );
        await assert.rejects(
            createEncryptedSessionBackup({
                sessionDir: fixture.session,
                backupPath: fixture.backup,
                protector
            }),
            error => error instanceof SessionSecurityError &&
                error.code === 'BACKUP_EXISTS'
        );
        assert.deepEqual(fs.readFileSync(fixture.backup), original);
    } finally {
        fixture.cleanup();
    }
});

test('el plan de migración es solamente informativo y no crea archivos', async () => {
    const fixture = createFixture();
    try {
        const plan = await planSessionMigration({
            sessionDir: fixture.session,
            backupPath: fixture.backup
        });
        assert.equal(plan.mode, 'encrypted-backup-only');
        assert.equal(plan.automatic, false);
        assert.equal(plan.sourceWillBeModified, false);
        assert.equal(plan.backupAlreadyExists, false);
        assert.equal(plan.loginIdentityPresent, true);
        assert.equal(fs.existsSync(fixture.backup), false);
    } finally {
        fixture.cleanup();
    }
});

test('rechaza guardar la copia dentro de la sesión activa', async () => {
    const fixture = createFixture();
    const protector = createPassphraseKeyProtector(
        'respaldo-fuera-de-sesion-2026'
    );
    const unsafeBackup = path.join(fixture.session, 'copia.z1session');
    try {
        await assert.rejects(
            createEncryptedSessionBackup({
                sessionDir: fixture.session,
                backupPath: unsafeBackup,
                protector
            }),
            error => error instanceof SessionSecurityError &&
                error.code === 'BACKUP_INSIDE_SESSION'
        );
        assert.equal(fs.existsSync(unsafeBackup), false);
    } finally {
        fixture.cleanup();
    }
});

test('rechaza una copia sobredimensionada antes de intentar descifrarla', async () => {
    const fixture = createFixture();
    const protector = createPassphraseKeyProtector(
        'limite-local-de-respaldo-2026'
    );
    let descriptor;
    try {
        descriptor = fs.openSync(fixture.backup, 'wx');
        fs.ftruncateSync(descriptor, 17 * 1024 * 1024);
        fs.closeSync(descriptor);
        descriptor = null;
        await assert.rejects(
            verifyEncryptedSessionBackup({
                backupPath: fixture.backup,
                protector,
                maxTotalBytes: 1
            }),
            error => error instanceof SessionSecurityError &&
                error.code === 'BACKUP_TOO_LARGE'
        );
    } finally {
        if (descriptor !== null && descriptor !== undefined) fs.closeSync(descriptor);
        fixture.cleanup();
    }
});

test('prefiere safeStorage y falla cerrado si no hay protección local', async () => {
    const encryptedValues = new Set();
    const fakeSafeStorage = {
        isEncryptionAvailable: () => true,
        encryptString(value) {
            const encrypted = Buffer.from(`local:${value}`, 'utf8');
            encryptedValues.add(encrypted.toString('base64'));
            return encrypted;
        },
        decryptString(value) {
            assert.equal(encryptedValues.has(Buffer.from(value).toString('base64')), true);
            return Buffer.from(value).toString('utf8').slice('local:'.length);
        }
    };
    const protector = createElectronSafeStorageProtector(fakeSafeStorage);
    assert.equal(protector.id, 'electron-safe-storage-v1');
    assert.equal(
        createLocalKeyProtector({ safeStorage: fakeSafeStorage }).id,
        'electron-safe-storage-v1'
    );

    const key = Buffer.alloc(32, 7);
    const wrapped = await protector.protect(key);
    const opened = await protector.unprotect(wrapped);
    assert.deepEqual(opened, key);
    opened.fill(0);
    key.fill(0);

    assert.throws(
        () => createLocalKeyProtector({
            safeStorage: { isEncryptionAvailable: () => false }
        }),
        error => error instanceof SessionSecurityError &&
            error.code === 'KEY_PROTECTION_UNAVAILABLE'
    );
});
