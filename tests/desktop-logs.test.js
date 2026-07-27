'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    abrirDirectorioLogsSeguro,
    crearRegistradorLocal,
    redactarTextoLog
} = require('../src/desktop-logs');

function crearTemporal(t) {
    const ruta = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-logs-'));
    t.after(() => fs.rmSync(ruta, { recursive: true, force: true }));
    return ruta;
}

test('el registro local oculta credenciales, teléfonos, QR y objetos de sesión', t => {
    const directorio = crearTemporal(t);
    const registrador = crearRegistradorLocal({
        directorio,
        version: '1.5.4',
        ahora: () => new Date('2026-07-27T12:00:00.000Z')
    });

    registrador.registrar('error', [
        'Falló +595981123456 token=super-secreto',
        'https://mmg.whatsapp.net/archivo.enc?token=privado',
        'data:image/png;base64,ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnop',
        Buffer.from('clave privada'),
        { privKey: 'no-debe-aparecer' }
    ]);

    const contenido = fs.readFileSync(registrador.obtenerRutaActual(), 'utf8');
    assert.match(contenido, /ZeroOne 1\.5\.4 inició el registro/u);
    assert.match(contenido, /595…56/u);
    assert.match(contenido, /token=\[oculto\]/u);
    assert.match(contenido, /parametros-ocultos/u);
    assert.match(contenido, /\[imagen QR oculta\]/u);
    assert.match(contenido, /\[Buffer oculto: 13 bytes\]/u);
    assert.match(contenido, /\[Object omitido por seguridad\]/u);
    assert.doesNotMatch(
        contenido,
        /595981123456|super-secreto|privado|ABCDEFGHIJKLMNOPQRSTUVWXYZ|clave privada|no-debe-aparecer/u
    );
});

test('la redacción conserva mensajes útiles y elimina valores largos', () => {
    const mensaje = redactarTextoLog(
        `Audiencia resincronizada para L47: 242 contactos. ` +
        `clave: 123456 valor=${'a'.repeat(80)}`
    );
    assert.match(mensaje, /L47: 242 contactos/u);
    assert.match(mensaje, /clave: \[oculto\]/u);
    assert.match(mensaje, /\[valor largo oculto\]/u);
    assert.doesNotMatch(mensaje, /123456|a{48}/u);
});

test('abre únicamente el directorio configurado y propaga errores de Windows', async t => {
    const raiz = crearTemporal(t);
    const directorio = path.join(raiz, 'logs');
    const rutas = [];

    const resultado = await abrirDirectorioLogsSeguro({
        directorio,
        abrirRuta: async ruta => {
            rutas.push(ruta);
            return '';
        }
    });

    assert.deepEqual(resultado, { correcto: true });
    assert.deepEqual(rutas, [path.resolve(directorio)]);
    assert.equal(fs.statSync(directorio).isDirectory(), true);

    await assert.rejects(
        abrirDirectorioLogsSeguro({
            directorio,
            abrirRuta: async () => 'Acceso denegado'
        }),
        /Acceso denegado/u
    );
});
