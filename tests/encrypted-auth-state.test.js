'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    BufferJSON,
    initAuthCreds,
    proto
} = require('@whiskeysockets/baileys');
const {
    createPassphraseKeyProtector
} = require('../src/session-security');
const {
    KEY_FILE,
    MARKER_FILE,
    crearEstadoAutenticacionCifrado,
    inspeccionarIdentidadAutenticacionCifrada
} = require('../src/encrypted-auth-state');

function escribirJson(ruta, datos) {
    fs.writeFileSync(ruta, JSON.stringify(datos, BufferJSON.replacer));
}

test('cifra una vinculación nueva desde el inicio y exige autorización mientras está pendiente', async () => {
    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-auth-new-link-'));
    const protector = createPassphraseKeyProtector(
        'frase de prueba para vinculacion inicial cifrada'
    );

    try {
        const inicial = await crearEstadoAutenticacionCifrado({
            folder: carpeta,
            protector,
            BufferJSON,
            initAuthCreds,
            proto,
            permitirVinculacionInicial: true
        });
        const registrationId = inicial.state.creds.registrationId;
        assert.equal(inicial.encrypted, true);
        assert.equal(fs.existsSync(path.join(carpeta, 'creds.json')), false);
        assert.equal(fs.existsSync(path.join(carpeta, KEY_FILE)), true);
        assert.deepEqual(
            JSON.parse(fs.readFileSync(path.join(carpeta, MARKER_FILE), 'utf8')),
            {
                version: 1,
                cipher: 'AES-256-GCM',
                loginIdentityPresent: false,
                pendingSince: JSON.parse(
                    fs.readFileSync(path.join(carpeta, MARKER_FILE), 'utf8')
                ).pendingSince
            }
        );
        assert.deepEqual(
            await inspeccionarIdentidadAutenticacionCifrada({
                folder: carpeta,
                protector
            }),
            { cifrada: true, identidadPresente: false }
        );
        await inicial.close();

        await assert.rejects(
            () => crearEstadoAutenticacionCifrado({
                folder: carpeta,
                protector,
                BufferJSON,
                initAuthCreds,
                proto
            }),
            error => error?.code === 'AUTH_PENDING_LINK_NOT_AUTHORIZED'
        );

        const reiniciada = await crearEstadoAutenticacionCifrado({
            folder: carpeta,
            protector,
            BufferJSON,
            initAuthCreds,
            proto,
            permitirVinculacionInicial: true
        });
        assert.equal(reiniciada.state.creds.registrationId, registrationId);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(carpeta, MARKER_FILE), 'utf8'))
                .loginIdentityPresent,
            false
        );

        reiniciada.state.creds.me = {
            id: '595000000099:1@s.whatsapp.net',
            name: 'Nueva'
        };
        await reiniciada.confirmarIdentidad();
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(carpeta, MARKER_FILE), 'utf8'))
                .loginIdentityPresent,
            true
        );
        assert.deepEqual(
            await inspeccionarIdentidadAutenticacionCifrada({
                folder: carpeta,
                protector
            }),
            { cifrada: true, identidadPresente: true }
        );
        await reiniciada.close();

        const vinculada = await crearEstadoAutenticacionCifrado({
            folder: carpeta,
            protector,
            BufferJSON,
            initAuthCreds,
            proto
        });
        assert.equal(
            vinculada.state.creds.me.id,
            '595000000099:1@s.whatsapp.net'
        );
        await vinculada.close();
    } finally {
        fs.rmSync(carpeta, { recursive: true, force: true });
    }
});

test('convierte todo el material plaintext de una vinculación pendiente antes de confirmar el marcador', async () => {
    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-auth-pending-legacy-'));
    const protector = createPassphraseKeyProtector(
        'frase para convertir una vinculacion pendiente completa'
    );
    const creds = initAuthCreds();
    const archivosLegados = [
        'creds.json',
        'pre-key-7.json',
        'session-contacto.json'
    ];
    escribirJson(path.join(carpeta, 'creds.json'), creds);
    escribirJson(path.join(carpeta, 'pre-key-7.json'), {
        keyPair: { public: Buffer.from('clave-publica') }
    });
    fs.writeFileSync(path.join(carpeta, 'session-contacto.json'), '{');

    try {
        await assert.rejects(() => crearEstadoAutenticacionCifrado({
            folder: carpeta,
            protector,
            BufferJSON,
            initAuthCreds,
            proto,
            permitirVinculacionInicial: true
        }));
        assert.equal(fs.existsSync(path.join(carpeta, MARKER_FILE)), false);
        for (const nombre of archivosLegados) {
            assert.equal(fs.existsSync(path.join(carpeta, nombre)), true);
        }

        escribirJson(path.join(carpeta, 'session-contacto.json'), {
            cadena: Buffer.from('sesion-pendiente')
        });
        const convertida = await crearEstadoAutenticacionCifrado({
            folder: carpeta,
            protector,
            BufferJSON,
            initAuthCreds,
            proto,
            permitirVinculacionInicial: true
        });
        assert.equal(convertida.encrypted, true);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(carpeta, MARKER_FILE), 'utf8'))
                .loginIdentityPresent,
            false
        );
        for (const nombre of archivosLegados) {
            assert.equal(fs.existsSync(path.join(carpeta, nombre)), false);
        }
        const preKey = await convertida.state.keys.get('pre-key', ['7']);
        assert.deepEqual(preKey['7'].keyPair.public, Buffer.from('clave-publica'));
        const sesion = await convertida.state.keys.get('session', ['contacto']);
        assert.deepEqual(sesion.contacto.cadena, Buffer.from('sesion-pendiente'));
        await convertida.close();

        await assert.rejects(
            () => crearEstadoAutenticacionCifrado({
                folder: carpeta,
                protector,
                BufferJSON,
                initAuthCreds,
                proto
            }),
            error => error?.code === 'AUTH_PENDING_LINK_NOT_AUTHORIZED'
        );
        const reiniciada = await crearEstadoAutenticacionCifrado({
            folder: carpeta,
            protector,
            BufferJSON,
            initAuthCreds,
            proto,
            permitirVinculacionInicial: true
        });
        assert.equal(reiniciada.state.creds.registrationId, creds.registrationId);
        await reiniciada.close();
    } finally {
        fs.rmSync(carpeta, { recursive: true, force: true });
    }
});

test('migra y reutiliza una sesión Baileys sin credenciales legibles', async () => {
    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-auth-encrypted-'));
    const protector = createPassphraseKeyProtector(
        'frase de prueba para cifrado de autenticacion'
    );
    const creds = initAuthCreds();
    creds.me = { id: '595000000000:1@s.whatsapp.net', name: 'L1' };
    creds.registered = false;
    escribirJson(path.join(carpeta, 'creds.json'), creds);
    escribirJson(path.join(carpeta, 'session-contacto@s.whatsapp.net.json'), {
        cadena: Buffer.from('secreto')
    });
    fs.writeFileSync(
        path.join(carpeta, 'audiencia-estados.json'),
        JSON.stringify({ contactos: ['595000000001@s.whatsapp.net'] })
    );

    try {
        const primero = await crearEstadoAutenticacionCifrado({
            folder: carpeta,
            protector,
            BufferJSON,
            initAuthCreds,
            proto,
            migrarLegado: true
        });
        assert.equal(primero.encrypted, true);
        assert.equal(primero.state.creds.me.id, creds.me.id);
        const recuperada = await primero.state.keys.get('session', [
            'contacto@s.whatsapp.net'
        ]);
        assert.deepEqual(
            recuperada['contacto@s.whatsapp.net'].cadena,
            Buffer.from('secreto')
        );
        await assert.rejects(
            () => crearEstadoAutenticacionCifrado({
                folder: carpeta,
                protector,
                BufferJSON,
                initAuthCreds,
                proto
            }),
            error => error?.code === 'AUTH_STATE_ALREADY_OPEN'
        );
        await primero.state.keys.set({
            'pre-key': {
                '7': { keyPair: { public: Buffer.from('publica') } }
            }
        });
        await primero.saveCreds();
        await primero.close();

        const nombres = fs.readdirSync(carpeta);
        assert.equal(nombres.includes('creds.json'), false);
        assert.equal(
            nombres.includes('session-contacto@s.whatsapp.net.json'),
            false
        );
        assert.equal(nombres.includes(KEY_FILE), true);
        assert.equal(nombres.includes(MARKER_FILE), true);
        assert.ok(nombres.some(nombre => /^auth-[a-f0-9]{64}\.z1e$/u.test(nombre)));
        assert.equal(
            fs.readFileSync(path.join(carpeta, 'audiencia-estados.json'), 'utf8')
                .includes('595000000001'),
            true
        );

        const segundo = await crearEstadoAutenticacionCifrado({
            folder: carpeta,
            protector,
            BufferJSON,
            initAuthCreds,
            proto,
            migrarLegado: false
        });
        assert.equal(segundo.state.creds.me.id, creds.me.id);
        assert.deepEqual(
            await inspeccionarIdentidadAutenticacionCifrada({
                folder: carpeta,
                protector
            }),
            { cifrada: true, identidadPresente: true }
        );
        const nueva = await segundo.state.keys.get('pre-key', ['7']);
        assert.deepEqual(nueva['7'].keyPair.public, Buffer.from('publica'));
        await segundo.close();

        for (const nombre of fs.readdirSync(carpeta)) {
            if (!/^auth-[a-f0-9]{64}\.z1e$/u.test(nombre)) continue;
            const ruta = path.join(carpeta, nombre);
            const contenido = fs.readFileSync(ruta);
            contenido[contenido.length - 1] ^= 0xff;
            fs.writeFileSync(ruta, contenido);
        }
        await assert.rejects(
            () => crearEstadoAutenticacionCifrado({
                folder: carpeta,
                protector,
                BufferJSON,
                initAuthCreds,
                proto
            }),
            error => error?.code === 'AUTH_DECRYPT_FAILED'
        );
    } finally {
        fs.rmSync(carpeta, { recursive: true, force: true });
    }
});

test('una sesión marcada nunca genera otra clave ni vuelve al texto plano', async () => {
    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-auth-fail-closed-'));
    const protector = createPassphraseKeyProtector(
        'otra frase de prueba para apertura cerrada'
    );
    const creds = initAuthCreds();
    creds.me = { id: '595000000002:1@s.whatsapp.net', name: 'L2' };
    escribirJson(path.join(carpeta, 'creds.json'), creds);

    try {
        const inicial = await crearEstadoAutenticacionCifrado({
            folder: carpeta,
            protector,
            BufferJSON,
            initAuthCreds,
            proto,
            migrarLegado: true
        });
        await inicial.close();
        fs.rmSync(path.join(carpeta, KEY_FILE));

        await assert.rejects(
            () => crearEstadoAutenticacionCifrado({
                folder: carpeta,
                protector,
                BufferJSON,
                initAuthCreds,
                proto
            }),
            error => error?.code === 'AUTH_KEY_MISSING'
        );
        assert.equal(fs.existsSync(path.join(carpeta, KEY_FILE)), false);
    } finally {
        fs.rmSync(carpeta, { recursive: true, force: true });
    }
});

test('el cierre drena escrituras aceptadas y rechaza operaciones posteriores', async () => {
    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-auth-close-'));
    const protector = createPassphraseKeyProtector(
        'frase de prueba para cierre concurrente seguro'
    );
    const creds = initAuthCreds();
    creds.me = { id: '595000000003:1@s.whatsapp.net', name: 'L3' };
    escribirJson(path.join(carpeta, 'creds.json'), creds);

    try {
        const inicial = await crearEstadoAutenticacionCifrado({
            folder: carpeta,
            protector,
            BufferJSON,
            initAuthCreds,
            proto,
            migrarLegado: true
        });
        const escritura = inicial.state.keys.set({
            session: { contacto: { valor: Buffer.from('confirmado') } }
        });
        await Promise.all([escritura, inicial.close()]);
        await assert.rejects(
            () => inicial.state.keys.get('session', ['contacto']),
            error => error?.code === 'AUTH_STATE_CLOSED'
        );

        const reabierta = await crearEstadoAutenticacionCifrado({
            folder: carpeta,
            protector,
            BufferJSON,
            initAuthCreds,
            proto
        });
        const datos = await reabierta.state.keys.get('session', ['contacto']);
        assert.deepEqual(datos.contacto.valor, Buffer.from('confirmado'));
        await reabierta.close();
    } finally {
        fs.rmSync(carpeta, { recursive: true, force: true });
    }
});

test('el lease de respaldo pausa nuevas escrituras hasta liberar el snapshot', async () => {
    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-auth-lease-'));
    const protector = createPassphraseKeyProtector(
        'frase de prueba para lease de respaldo seguro'
    );
    const creds = initAuthCreds();
    creds.me = { id: '595000000004:1@s.whatsapp.net', name: 'L4' };
    escribirJson(path.join(carpeta, 'creds.json'), creds);

    try {
        const almacen = await crearEstadoAutenticacionCifrado({
            folder: carpeta,
            protector,
            BufferJSON,
            initAuthCreds,
            proto,
            migrarLegado: true
        });
        const liberar = await almacen.pausarParaRespaldo();
        let terminada = false;
        const escritura = almacen.state.keys.set({
            session: { posterior: { valor: 'después' } }
        }).then(() => {
            terminada = true;
        });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(terminada, false);
        liberar();
        await escritura;
        assert.equal(terminada, true);
        await almacen.close();
    } finally {
        fs.rmSync(carpeta, { recursive: true, force: true });
    }
});
