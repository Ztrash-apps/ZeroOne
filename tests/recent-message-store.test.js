'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    CACHE_SQLITE_KIB,
    RETENCION_MS,
    crearAlmacenMensajesRecientes
} = require('../src/recent-message-store');

function temporal(t) {
    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'autostatues-contexto-'));
    t.after(() => fs.rmSync(carpeta, { recursive: true, force: true }));
    return carpeta;
}

function opciones(carpeta) {
    return {
        ruta: path.join(carpeta, 'mensajes.sqlite'),
        rutaClave: path.join(carpeta, 'mensajes.key'),
        cifrarClave: valor => `protegida:${valor}`,
        descifrarClave: valor => String(valor).slice('protegida:'.length)
    };
}

test('persiste contexto redactado y cifrado sin guardar claves, URL ni teléfono', t => {
    const carpeta = temporal(t);
    let almacen = crearAlmacenMensajesRecientes(opciones(carpeta));
    const guardados = almacen.guardar('linea-1', [{
        key: {
            fromMe: true,
            remoteJid: '595981123456@s.whatsapp.net',
            id: 'MSG-1'
        },
        messageTimestamp: 1800000000,
        message: {
            conversation: [
                'Usuario: rositaflor77',
                'Clave: super-secreta',
                'https://greenvip.net',
                '+595 981 123 456'
            ].join('\n')
        }
    }]);
    assert.equal(guardados, 1);
    let mensajes = almacen.obtener('linea-1');
    assert.equal(mensajes.length, 1);
    assert.match(mensajes[0].message.conversation, /rositaflor77/u);
    assert.match(mensajes[0].message.conversation, /\[SECRETO\]|\[URL\]|\[TELEFONO\]/u);
    assert.doesNotMatch(
        mensajes[0].message.conversation,
        /super-secreta|greenvip\.net|981 123 456/u
    );
    const binario = fs.readFileSync(path.join(carpeta, 'mensajes.sqlite'));
    assert.equal(binario.includes(Buffer.from('rositaflor77')), false);
    assert.equal(binario.includes(Buffer.from('595981123456')), false);

    // La lectura siempre vuelve a SQLite; modificar el resultado no deja una
    // copia mutable retenida como caché de historial en el proceso.
    mensajes[0].message.conversation = 'Usuario: alterado_en_ram';
    mensajes = almacen.obtener('linea-1');
    assert.match(mensajes[0].message.conversation, /rositaflor77/u);
    assert.equal(
        Object.values(almacen).some(valor => Array.isArray(valor) || valor instanceof Map),
        false
    );
    assert.equal(CACHE_SQLITE_KIB, 2048);
    almacen.cerrar();

    almacen = crearAlmacenMensajesRecientes(opciones(carpeta));
    mensajes = almacen.obtener('linea-1');
    assert.equal(mensajes[0].key.remoteJid, '595981123456@s.whatsapp.net');
    assert.equal(almacen.eliminarLinea('linea-1'), 1);
    assert.deepEqual(almacen.obtener('linea-1'), []);
    almacen.cerrar();
});

test('descarta mensajes que ya excedieron la retención', t => {
    const almacen = crearAlmacenMensajesRecientes(opciones(temporal(t)));
    const guardados = almacen.guardar('linea-vencida', [{
        key: {
            fromMe: true,
            remoteJid: '595981000000@s.whatsapp.net',
            id: 'VENCIDO-1'
        },
        messageTimestamp: Date.now() - RETENCION_MS - 1000,
        message: { conversation: 'Usuario: rositaflor77' }
    }]);

    assert.equal(guardados, 0);
    assert.deepEqual(almacen.obtener('linea-vencida'), []);
    almacen.cerrar();
});

test('ignora recibidos, grupos y estados', t => {
    const almacen = crearAlmacenMensajesRecientes(opciones(temporal(t)));
    const base = texto => ({
        key: { fromMe: true, remoteJid: '595981000000@s.whatsapp.net' },
        message: { conversation: texto }
    });
    const recibidos = almacen.guardar('linea-2', [
        { ...base('recibido'), key: { fromMe: false, remoteJid: '595981000000@s.whatsapp.net' } },
        { ...base('grupo'), key: { fromMe: true, remoteJid: 'grupo@g.us' } },
        { ...base('estado'), key: { fromMe: true, remoteJid: 'status@broadcast' } }
    ]);
    assert.equal(recibidos, 0);
    assert.deepEqual(almacen.obtener('linea-2'), []);
    almacen.cerrar();
});

test('elimina solo la linea indicada y trunca estrictamente el WAL', t => {
    const carpeta = temporal(t);
    const ruta = path.join(carpeta, 'mensajes.sqlite');
    const almacen = crearAlmacenMensajesRecientes(opciones(carpeta));
    const mensaje = (jid, id, usuario) => ({
        key: {
            fromMe: true,
            remoteJid: jid,
            id
        },
        messageTimestamp: Date.now(),
        message: { conversation: `Usuario: ${usuario}` }
    });

    almacen.guardar('linea-eliminada', [
        mensaje('595981111111@s.whatsapp.net', 'ELIMINAR-1', 'rositaflor77')
    ]);
    almacen.guardar('linea-conservada', [
        mensaje('595982222222@s.whatsapp.net', 'CONSERVAR-1', 'margarita88')
    ]);

    const rutaWal = `${ruta}-wal`;
    assert.equal(fs.existsSync(rutaWal), true);
    assert.ok(fs.statSync(rutaWal).size > 0);

    assert.equal(almacen.eliminarLinea('linea-eliminada'), 1);
    assert.deepEqual(almacen.obtener('linea-eliminada'), []);
    assert.equal(almacen.obtener('linea-conservada').length, 1);
    assert.equal(fs.existsSync(rutaWal) ? fs.statSync(rutaWal).size : 0, 0);

    // Una repetición es idempotente y vuelve a verificar el checkpoint. Esto
    // permite reintentar una eliminación cuyo primer checkpoint estuvo ocupado.
    assert.equal(almacen.eliminarLinea('linea-eliminada'), 0);
    almacen.cerrar();
});
