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

test('separa los logs por versión y nunca purga archivos anteriores', t => {
    const directorio = crearTemporal(t);
    const anterior = path.join(directorio, 'zeroone-v1.5.7-2026-07-26.log');
    fs.writeFileSync(anterior, 'registro anterior', 'utf8');

    const registrador = crearRegistradorLocal({
        directorio,
        version: '1.5.8',
        ahora: () => new Date('2026-07-27T12:00:00.000Z')
    });

    assert.equal(
        path.basename(registrador.obtenerRutaActual()),
        'zeroone-v1.5.8-2026-07-27.log'
    );
    assert.equal(fs.readFileSync(anterior, 'utf8'), 'registro anterior');
    assert.match(
        registrador.leerRegistroActual(),
        /ZeroOne 1\.5\.8 inició el registro/u
    );
});

test('iniciar un log nuevo conserva el anterior y cambia el archivo activo', t => {
    const directorio = crearTemporal(t);
    const registrador = crearRegistradorLocal({
        directorio,
        version: '1.5.8',
        ahora: () => new Date('2026-07-27T12:34:56.000Z')
    });
    const anterior = registrador.obtenerRutaActual();
    registrador.registrar('INFO', ['dato que debe conservarse']);

    const resultado = registrador.crearNuevoRegistro();
    const actual = registrador.obtenerRutaActual();

    assert.equal(resultado.correcto, true);
    assert.notEqual(actual, anterior);
    assert.equal(fs.existsSync(anterior), true);
    assert.match(fs.readFileSync(anterior, 'utf8'), /dato que debe conservarse/u);
    assert.match(
        registrador.leerRegistroActual(),
        /nuevo registro de diagnóstico por solicitud del usuario/u
    );
});

test('eliminar afecta solo al log activo y crea un reemplazo inmediatamente', t => {
    const directorio = crearTemporal(t);
    const conservado = path.join(
        directorio,
        'zeroone-v1.5.7-2026-07-26.log'
    );
    fs.writeFileSync(conservado, 'no eliminar', 'utf8');
    const registrador = crearRegistradorLocal({
        directorio,
        version: '1.5.8',
        ahora: () => new Date('2026-07-27T12:34:56.000Z')
    });
    const eliminado = registrador.obtenerRutaActual();

    const resultado = registrador.eliminarRegistroActual();
    const reemplazo = registrador.obtenerRutaActual();

    assert.equal(resultado.correcto, true);
    assert.equal(fs.existsSync(eliminado), false);
    assert.equal(fs.readFileSync(conservado, 'utf8'), 'no eliminar');
    assert.equal(fs.existsSync(reemplazo), true);
    assert.match(
        registrador.leerRegistroActual(),
        /después de eliminar el anterior/u
    );
});

test('un fallo al crear el reemplazo conserva el log activo', t => {
    const directorio = crearTemporal(t);
    const fsConFallo = Object.create(fs);
    fsConFallo.appendFileSync = (ruta, ...argumentos) => {
        if (path.basename(String(ruta)).includes('-nuevo-')) {
            throw new Error('Disco no disponible');
        }
        return fs.appendFileSync(ruta, ...argumentos);
    };
    const registrador = crearRegistradorLocal({
        directorio,
        version: '1.5.8',
        fsModule: fsConFallo,
        ahora: () => new Date('2026-07-27T12:34:56.000Z')
    });
    const activo = registrador.obtenerRutaActual();
    const contenido = registrador.leerRegistroActual();

    assert.throws(
        () => registrador.crearNuevoRegistro(),
        /Disco no disponible/u
    );
    assert.equal(registrador.obtenerRutaActual(), activo);
    assert.equal(fs.readFileSync(activo, 'utf8'), contenido);

    assert.throws(
        () => registrador.eliminarRegistroActual(),
        /Disco no disponible/u
    );
    assert.equal(registrador.obtenerRutaActual(), activo);
    assert.equal(fs.readFileSync(activo, 'utf8'), contenido);
});

test('la rotación por tamaño abre otra parte sin sobrescribir archivos', t => {
    const directorio = crearTemporal(t);
    const registrador = crearRegistradorLocal({
        directorio,
        version: '1.5.8',
        tamanoMaximo: 1024,
        ahora: () => new Date('2026-07-27T12:34:56.000Z')
    });
    const inicial = registrador.obtenerRutaActual();

    registrador.registrar('INFO', ['entrada-a '.repeat(70)]);
    registrador.registrar('INFO', ['entrada-b '.repeat(70)]);
    const rotado = registrador.obtenerRutaActual();

    assert.notEqual(rotado, inicial);
    assert.equal(fs.existsSync(inicial), true);
    assert.match(fs.readFileSync(inicial, 'utf8'), /entrada-a/u);
    assert.match(fs.readFileSync(rotado, 'utf8'), /entrada-b/u);
});

test('si una rotación no puede abrirse conserva el archivo activo', t => {
    const directorio = crearTemporal(t);
    const fsConFallo = Object.create(fs);
    fsConFallo.appendFileSync = (ruta, ...argumentos) => {
        if (path.basename(String(ruta)).includes('-parte-')) {
            throw new Error('No se pudo crear la parte');
        }
        return fs.appendFileSync(ruta, ...argumentos);
    };
    const registrador = crearRegistradorLocal({
        directorio,
        version: '1.5.8',
        tamanoMaximo: 1024,
        fsModule: fsConFallo,
        ahora: () => new Date('2026-07-27T12:34:56.000Z')
    });
    const inicial = registrador.obtenerRutaActual();

    registrador.registrar('INFO', ['entrada-a '.repeat(70)]);
    registrador.registrar('INFO', ['entrada-b '.repeat(70)]);

    assert.equal(registrador.obtenerRutaActual(), inicial);
    assert.match(fs.readFileSync(inicial, 'utf8'), /entrada-a/u);
    assert.match(fs.readFileSync(inicial, 'utf8'), /entrada-b/u);
});
