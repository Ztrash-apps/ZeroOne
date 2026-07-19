'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
    crearGestorRespaldosSesiones,
    eliminarRespaldosLineaSeguro,
    listarRespaldos
} = require('../src/session-backup-manager');
const {
    crearEstadoAutenticacionCifrado
} = require('../src/encrypted-auth-state');

function hashArchivo(ruta) {
    return crypto.createHash('sha256').update(fs.readFileSync(ruta)).digest('hex');
}

test('crea, verifica y limita respaldos sin modificar la sesión', async () => {
    const temporal = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-backup-manager-'));
    const sesiones = path.join(temporal, 'sesiones');
    const respaldos = path.join(temporal, 'respaldos');
    const id = '11111111-1111-4111-8111-111111111111';
    const sesion = path.join(sesiones, id);
    fs.mkdirSync(sesion, { recursive: true });
    const credenciales = path.join(sesion, 'creds.json');
    fs.writeFileSync(credenciales, JSON.stringify({
        me: { id: '595000000000:1@s.whatsapp.net', name: 'L1' },
        registered: false
    }));
    fs.writeFileSync(path.join(sesion, 'app-state-sync-key-demo.json'), '{"key":1}');
    const hashAntes = hashArchivo(credenciales);

    try {
        const gestor = crearGestorRespaldosSesiones({
            carpetaSesiones: sesiones,
            carpetaRespaldos: respaldos,
            protector: createPassphraseKeyProtector(
                'frase local de prueba suficientemente segura'
            ),
            retencionPorLinea: 3,
            logger: { warn() {}, error() {} }
        });

        const primero = await gestor.respaldarLinea({ id, nombre: 'L1' });
        assert.equal(primero.estado, 'creada');
        assert.equal(primero.loginIdentityPresent, true);
        const segundo = await gestor.respaldarLinea({ id, nombre: 'L1' });
        assert.equal(segundo.estado, 'verificada');

        await gestor.respaldarLinea({ id, nombre: 'L1' }, { forzar: true });
        await gestor.respaldarLinea({ id, nombre: 'L1' }, { forzar: true });
        await gestor.respaldarLinea({ id, nombre: 'L1' }, { forzar: true });
        assert.equal(listarRespaldos(path.join(respaldos, id)).length, 3);
        assert.equal(hashArchivo(credenciales), hashAntes);
        gestor.cerrar();
    } finally {
        fs.rmSync(temporal, { recursive: true, force: true });
    }
});

test('respalda una sesión cifrada activa bajo lease verificado', async () => {
    const temporal = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-backup-lease-'));
    const sesiones = path.join(temporal, 'sesiones');
    const respaldos = path.join(temporal, 'respaldos');
    const id = '22222222-2222-4222-8222-222222222222';
    const sesion = path.join(sesiones, id);
    fs.mkdirSync(sesion, { recursive: true });
    const protector = createPassphraseKeyProtector(
        'frase local para respaldo cifrado con lease'
    );
    const credenciales = initAuthCreds();
    credenciales.me = { id: '595000000010:1@s.whatsapp.net', name: 'L10' };
    fs.writeFileSync(
        path.join(sesion, 'creds.json'),
        JSON.stringify(credenciales, BufferJSON.replacer)
    );

    let almacen;
    try {
        almacen = await crearEstadoAutenticacionCifrado({
            folder: sesion,
            protector,
            BufferJSON,
            initAuthCreds,
            proto,
            migrarLegado: true
        });
        const gestor = crearGestorRespaldosSesiones({
            carpetaSesiones: sesiones,
            carpetaRespaldos: respaldos,
            protector,
            logger: { warn() {}, error() {} }
        });
        const resultado = await gestor.respaldarLinea({
            id,
            nombre: 'L10',
            socket: {},
            pausarAlmacenAutenticacion: almacen.pausarParaRespaldo
        });
        assert.equal(resultado.estado, 'creada');
        assert.equal(resultado.loginIdentityPresent, true);
        assert.equal(gestor.tieneRespaldoVerificado(id), true);
        gestor.cerrar();
    } finally {
        await almacen?.close?.();
        fs.rmSync(temporal, { recursive: true, force: true });
    }
});

test('no reutiliza un respaldo reciente si la sesión fue reemplazada', async () => {
    const temporal = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-backup-relink-'));
    const sesiones = path.join(temporal, 'sesiones');
    const respaldos = path.join(temporal, 'respaldos');
    const id = '33333333-3333-4333-8333-333333333333';
    const sesion = path.join(sesiones, id);
    const credenciales = path.join(sesion, 'creds.json');
    fs.mkdirSync(sesion, { recursive: true });
    fs.writeFileSync(credenciales, JSON.stringify({
        me: { id: '595000000020:1@s.whatsapp.net', name: 'Cuenta anterior' },
        registered: false
    }));

    try {
        const gestor = crearGestorRespaldosSesiones({
            carpetaSesiones: sesiones,
            carpetaRespaldos: respaldos,
            protector: createPassphraseKeyProtector(
                'frase local para detectar una revinculacion'
            ),
            logger: { warn() {}, error() {} }
        });

        const anterior = await gestor.respaldarLinea({ id, nombre: 'L20' });
        assert.equal(anterior.estado, 'creada');

        fs.writeFileSync(credenciales, JSON.stringify({
            me: { id: '595000000021:1@s.whatsapp.net', name: 'Cuenta nueva' },
            registered: false
        }));

        const actual = await gestor.respaldarLinea({ id, nombre: 'L20' });
        assert.equal(actual.estado, 'creada');
        assert.notEqual(
            actual.sessionFingerprintSha256,
            anterior.sessionFingerprintSha256
        );
        assert.equal(listarRespaldos(path.join(respaldos, id)).length, 2);
        assert.equal(gestor.tieneRespaldoVerificado(id), true);
        gestor.cerrar();
    } finally {
        fs.rmSync(temporal, { recursive: true, force: true });
    }
});

test('elimina únicamente los respaldos de la línea indicada y bloquea recrearlos', async () => {
    const temporal = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-backup-delete-'));
    const sesiones = path.join(temporal, 'sesiones');
    const respaldos = path.join(temporal, 'respaldos');
    const id = '44444444-4444-4444-8444-444444444444';
    const otroId = '55555555-5555-4555-8555-555555555555';
    const sesion = path.join(sesiones, id);
    fs.mkdirSync(sesion, { recursive: true });
    fs.writeFileSync(path.join(sesion, 'creds.json'), JSON.stringify({
        me: { id: '595000000040:1@s.whatsapp.net', name: 'L40' }
    }));
    fs.mkdirSync(path.join(respaldos, otroId), { recursive: true });
    fs.writeFileSync(path.join(respaldos, otroId, 'conservar.txt'), 'ok');

    try {
        const gestor = crearGestorRespaldosSesiones({
            carpetaSesiones: sesiones,
            carpetaRespaldos: respaldos,
            protector: createPassphraseKeyProtector(
                'frase local para probar el borrado coordinado'
            ),
            logger: { warn() {}, error() {} }
        });
        await gestor.respaldarLinea({ id, nombre: 'L40' });
        assert.equal(gestor.tieneRespaldoVerificado(id), true);

        await gestor.eliminarLinea(id);
        assert.equal(fs.existsSync(path.join(respaldos, id)), false);
        assert.equal(fs.existsSync(path.join(respaldos, otroId)), true);
        assert.equal(gestor.tieneRespaldoVerificado(id), false);

        const omitida = await gestor.respaldarLinea({ id, nombre: 'L40' });
        assert.deepEqual(omitida, {
            estado: 'omitida',
            motivo: 'linea_en_eliminacion'
        });
        assert.equal(fs.existsSync(path.join(respaldos, id)), false);

        gestor.habilitarLinea(id);
        const recreada = await gestor.respaldarLinea({ id, nombre: 'L40' });
        assert.equal(recreada.estado, 'creada');
        assert.equal(fs.existsSync(path.join(respaldos, id)), true);
        gestor.cerrar();
    } finally {
        fs.rmSync(temporal, { recursive: true, force: true });
    }
});

test('el borrado de respaldos rechaza identificadores fuera de la raíz', () => {
    const temporal = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-backup-path-'));
    try {
        assert.throws(
            () => eliminarRespaldosLineaSeguro({
                carpetaRespaldos: temporal,
                id: '..\\otra-carpeta'
            }),
            /identificador/u
        );
    } finally {
        fs.rmSync(temporal, { recursive: true, force: true });
    }
});
