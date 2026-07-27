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

function archivosRespaldados(carpeta) {
    return fs.readdirSync(carpeta)
        .filter(nombre =>
            nombre.includes('.incompatible-') && nombre.endsWith('.bak')
        )
        .sort();
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

test('recupera una clave local incompatible sin tocar otros datos', t => {
    const carpeta = temporal(t);
    const anteriores = opciones(carpeta);
    const ruta = anteriores.ruta;
    const rutaClave = anteriores.rutaClave;
    let almacen = crearAlmacenMensajesRecientes(anteriores);
    almacen.guardar('linea-anterior', [{
        key: {
            fromMe: true,
            remoteJid: '595981111111@s.whatsapp.net',
            id: 'ANTERIOR-1'
        },
        messageTimestamp: Date.now(),
        message: { conversation: 'Usuario: anterior77' }
    }]);
    almacen.cerrar();

    fs.writeFileSync(`${ruta}-wal`, 'wal-anterior');
    fs.writeFileSync(`${ruta}-shm`, 'shm-anterior');
    const claveAnterior = fs.readFileSync(rutaClave);
    const baseAnterior = fs.readFileSync(ruta);
    const actuales = {
        ruta,
        rutaClave,
        cifrarClave: valor => `actual:${valor}`,
        descifrarClave: valor => {
            const texto = String(valor);
            if (!texto.startsWith('actual:')) {
                throw new Error(
                    'Error while decrypting the ciphertext provided to safeStorage.decryptString.'
                );
            }
            return texto.slice('actual:'.length);
        },
        cifradoDisponible: () => true,
        recuperarCifradoIncompatible: true
    };

    const rutasOriginales = new Set([
        ruta,
        `${ruta}-wal`,
        `${ruta}-shm`,
        rutaClave
    ]);
    const eventosArchivos = [];
    const copiarOriginal = fs.copyFileSync;
    const eliminarOriginal = fs.rmSync;
    try {
        fs.copyFileSync = (origen, destino, ...argumentos) => {
            if (rutasOriginales.has(origen)) {
                eventosArchivos.push({ operacion: 'copiar', ruta: origen });
            }
            return copiarOriginal(origen, destino, ...argumentos);
        };
        fs.rmSync = (rutaEntrada, ...argumentos) => {
            if (rutasOriginales.has(rutaEntrada)) {
                eventosArchivos.push({
                    operacion: 'retirar',
                    ruta: rutaEntrada
                });
            }
            return eliminarOriginal(rutaEntrada, ...argumentos);
        };
        almacen = crearAlmacenMensajesRecientes(actuales);
    } finally {
        fs.copyFileSync = copiarOriginal;
        fs.rmSync = eliminarOriginal;
    }
    assert.equal(almacen.recuperacionCifrado?.realizada, true);
    assert.equal(
        almacen.recuperacionCifrado.archivosRespaldados.length,
        4
    );
    const primeraRetirada = eventosArchivos.findIndex(
        evento => evento.operacion === 'retirar'
    );
    const ultimaCopia = eventosArchivos.reduce(
        (indice, evento, actual) =>
            evento.operacion === 'copiar' ? actual : indice,
        -1
    );
    assert.equal(ultimaCopia < primeraRetirada, true);
    assert.equal(
        eventosArchivos.filter(
            evento => evento.operacion === 'retirar'
        ).at(-1)?.ruta,
        rutaClave
    );
    assert.deepEqual(almacen.obtener('linea-anterior'), []);

    const respaldoClave = almacen.recuperacionCifrado.archivosRespaldados
        .find(archivo => archivo.startsWith(`${rutaClave}.incompatible-`));
    const respaldoBase = almacen.recuperacionCifrado.archivosRespaldados
        .find(archivo => archivo.startsWith(`${ruta}.incompatible-`));
    assert.deepEqual(fs.readFileSync(respaldoClave), claveAnterior);
    assert.deepEqual(fs.readFileSync(respaldoBase), baseAnterior);

    assert.equal(almacen.guardar('linea-nueva', [{
        key: {
            fromMe: true,
            remoteJid: '595982222222@s.whatsapp.net',
            id: 'NUEVO-1'
        },
        messageTimestamp: Date.now(),
        message: { conversation: 'Usuario: nueva88' }
    }]), 1);
    assert.equal(almacen.obtener('linea-nueva').length, 1);
    almacen.cerrar();

    const respaldosIniciales = archivosRespaldados(carpeta);
    assert.equal(respaldosIniciales.length, 4);
    almacen = crearAlmacenMensajesRecientes(actuales);
    assert.equal(almacen.recuperacionCifrado, null);
    assert.equal(almacen.obtener('linea-nueva').length, 1);
    almacen.cerrar();
    assert.deepEqual(archivosRespaldados(carpeta), respaldosIniciales);
});

test('no mueve el caché cuando el cifrado local no está disponible', t => {
    const carpeta = temporal(t);
    const anteriores = opciones(carpeta);
    const almacen = crearAlmacenMensajesRecientes(anteriores);
    almacen.cerrar();
    const claveAnterior = fs.readFileSync(anteriores.rutaClave);
    const baseAnterior = fs.readFileSync(anteriores.ruta);
    let intentosCifrado = 0;

    assert.throws(
        () => crearAlmacenMensajesRecientes({
            ...anteriores,
            cifradoDisponible: () => false,
            cifrarClave: valor => {
                intentosCifrado += 1;
                return `actual:${valor}`;
            },
            descifrarClave: () => {
                throw new Error('no debería intentar descifrar');
            },
            recuperarCifradoIncompatible: true
        }),
        error => error?.code === 'CIFRADO_LOCAL_NO_DISPONIBLE'
    );

    assert.equal(intentosCifrado, 0);
    assert.deepEqual(fs.readFileSync(anteriores.rutaClave), claveAnterior);
    assert.deepEqual(fs.readFileSync(anteriores.ruta), baseAnterior);
    assert.deepEqual(archivosRespaldados(carpeta), []);
});

test('no retira originales si una copia de respaldo no puede verificarse', t => {
    const carpeta = temporal(t);
    const anteriores = opciones(carpeta);
    const ruta = anteriores.ruta;
    const rutaClave = anteriores.rutaClave;
    const almacen = crearAlmacenMensajesRecientes(anteriores);
    almacen.cerrar();
    const baseAnterior = fs.readFileSync(ruta);
    const claveAnterior = fs.readFileSync(rutaClave);
    const copiarOriginal = fs.copyFileSync;
    const eliminarOriginal = fs.rmSync;
    const originalesRetirados = [];

    try {
        fs.copyFileSync = (origen, destino, ...argumentos) => {
            const resultado = copiarOriginal(origen, destino, ...argumentos);
            if (
                origen === ruta &&
                String(destino).includes('.incompatible-')
            ) {
                fs.appendFileSync(destino, 'copia-corrupta');
            }
            return resultado;
        };
        fs.rmSync = (rutaEntrada, ...argumentos) => {
            if ([ruta, rutaClave].includes(rutaEntrada)) {
                originalesRetirados.push(rutaEntrada);
            }
            return eliminarOriginal(rutaEntrada, ...argumentos);
        };
        assert.throws(
            () => crearAlmacenMensajesRecientes({
                ruta,
                rutaClave,
                cifrarClave: valor => `actual:${valor}`,
                descifrarClave: valor => {
                    const texto = String(valor);
                    if (!texto.startsWith('actual:')) {
                        throw new Error('clave anterior incompatible');
                    }
                    return texto.slice('actual:'.length);
                },
                cifradoDisponible: () => true,
                recuperarCifradoIncompatible: true
            }),
            /respaldo local no pudo verificarse/u
        );
    } finally {
        fs.copyFileSync = copiarOriginal;
        fs.rmSync = eliminarOriginal;
    }

    assert.deepEqual(originalesRetirados, []);
    assert.deepEqual(fs.readFileSync(ruta), baseAnterior);
    assert.deepEqual(fs.readFileSync(rutaClave), claveAnterior);
    assert.deepEqual(archivosRespaldados(carpeta), []);
});

test('el rollback continúa aunque falle la restauración de un archivo', t => {
    const carpeta = temporal(t);
    const anteriores = opciones(carpeta);
    const ruta = anteriores.ruta;
    const rutaClave = anteriores.rutaClave;
    const almacen = crearAlmacenMensajesRecientes(anteriores);
    almacen.cerrar();
    fs.writeFileSync(`${ruta}-wal`, 'wal-rollback');
    fs.writeFileSync(`${ruta}-shm`, 'shm-rollback');

    const actuales = {
        ruta,
        rutaClave,
        cifrarClave: valor => `actual:${valor}`,
        descifrarClave: valor => {
            const texto = String(valor);
            if (!texto.startsWith('actual:')) {
                throw new Error('clave anterior incompatible');
            }
            return texto.slice('actual:'.length);
        },
        cifradoDisponible: () => true,
        recuperarCifradoIncompatible: true
    };
    const restauracionesIntentadas = [];
    const copiarOriginal = fs.copyFileSync;
    const eliminarOriginal = fs.rmSync;
    let errorRecibido = null;

    try {
        fs.copyFileSync = (origen, destino, ...argumentos) => {
            if (String(origen).includes('.incompatible-')) {
                restauracionesIntentadas.push(destino);
                if (destino === ruta) {
                    throw new Error('fallo simulado al restaurar SQLite');
                }
            }
            return copiarOriginal(origen, destino, ...argumentos);
        };
        fs.rmSync = (rutaEntrada, ...argumentos) => {
            if (rutaEntrada === rutaClave) {
                throw new Error('fallo simulado al retirar la clave');
            }
            return eliminarOriginal(rutaEntrada, ...argumentos);
        };
        assert.throws(
            () => crearAlmacenMensajesRecientes(actuales),
            error => {
                errorRecibido = error;
                return /fallo simulado al retirar la clave/u.test(
                    error?.message || ''
                );
            }
        );
    } finally {
        fs.copyFileSync = copiarOriginal;
        fs.rmSync = eliminarOriginal;
    }

    assert.equal(errorRecibido?.rollbackError instanceof AggregateError, true);
    assert.equal(errorRecibido.rollbackError.errors.length, 1);
    assert.deepEqual(
        restauracionesIntentadas,
        [ruta, `${ruta}-wal`, `${ruta}-shm`]
    );
    assert.equal(fs.existsSync(`${ruta}-wal`), true);
    assert.equal(fs.existsSync(`${ruta}-shm`), true);
    assert.equal(fs.existsSync(rutaClave), true);
    assert.equal(
        archivosRespaldados(carpeta).some(nombre =>
            nombre.startsWith(`${path.basename(ruta)}.incompatible-`)
        ),
        true
    );
});

test('libera SQLite y limpia la clave si falla la inicialización', t => {
    const carpeta = temporal(t);
    let cierres = 0;
    let limpiezasClave = 0;
    const llenarOriginal = Buffer.prototype.fill;

    try {
        Buffer.prototype.fill = function (valor, ...argumentos) {
            if (valor === 0 && this.length === 32) limpiezasClave += 1;
            return llenarOriginal.call(this, valor, ...argumentos);
        };
        assert.throws(
            () => crearAlmacenMensajesRecientes({
                ...opciones(carpeta),
                crearBaseDatos: () => ({
                    exec: () => {
                        throw new Error('fallo simulado al preparar SQLite');
                    },
                    close: () => {
                        cierres += 1;
                    }
                })
            }),
            /fallo simulado al preparar SQLite/u
        );
    } finally {
        Buffer.prototype.fill = llenarOriginal;
    }

    assert.equal(cierres, 1);
    // Una limpieza corresponde a la verificación y otra a la clave activa.
    assert.equal(limpiezasClave >= 2, true);
});

test('conserva la clave nueva y limpia SQLite si falla después de rotarla', t => {
    const carpeta = temporal(t);
    const anteriores = opciones(carpeta);
    let almacen = crearAlmacenMensajesRecientes(anteriores);
    almacen.guardar('linea-recuperable', [{
        key: {
            fromMe: true,
            remoteJid: '595983333333@s.whatsapp.net',
            id: 'RECUPERABLE-1'
        },
        messageTimestamp: Date.now(),
        message: { conversation: 'Usuario: recuperable99' }
    }]);
    almacen.cerrar();
    const claveAnterior = fs.readFileSync(anteriores.rutaClave);
    const baseAnterior = fs.readFileSync(anteriores.ruta);
    let cierres = 0;
    const actuales = {
        ...anteriores,
        cifrarClave: valor => `actual:${valor}`,
        descifrarClave: valor => {
            const texto = String(valor);
            if (!texto.startsWith('actual:')) {
                throw new Error('clave anterior incompatible');
            }
            return texto.slice('actual:'.length);
        },
        cifradoDisponible: () => true,
        recuperarCifradoIncompatible: true
    };

    assert.throws(
        () => crearAlmacenMensajesRecientes({
            ...actuales,
            crearBaseDatos: ruta => ({
                exec: () => {
                    fs.writeFileSync(ruta, 'base-nueva-incompleta');
                    throw new Error(
                        'fallo simulado después de rotar la clave'
                    );
                },
                close: () => {
                    cierres += 1;
                }
            })
        }),
        /fallo simulado después de rotar la clave/u
    );

    assert.equal(cierres, 1);
    assert.notDeepEqual(
        fs.readFileSync(anteriores.rutaClave),
        claveAnterior
    );
    assert.equal(fs.existsSync(anteriores.ruta), false);
    const respaldoBase = archivosRespaldados(carpeta)
        .map(nombre => path.join(carpeta, nombre))
        .find(ruta => ruta.startsWith(
            `${anteriores.ruta}.incompatible-`
        ));
    assert.ok(respaldoBase);
    assert.deepEqual(fs.readFileSync(respaldoBase), baseAnterior);

    almacen = crearAlmacenMensajesRecientes(actuales);
    assert.equal(almacen.recuperacionCifrado, null);
    assert.deepEqual(almacen.obtener('linea-recuperable'), []);
    almacen.cerrar();
});

test('elimina sólo respaldos incompatibles que superan la retención', t => {
    const carpeta = temporal(t);
    const configuracion = opciones(carpeta);
    let almacen = crearAlmacenMensajesRecientes(configuracion);
    almacen.cerrar();

    const respaldoViejoBase =
        `${configuracion.ruta}.incompatible-viejo.bak`;
    const respaldoViejoClave =
        `${configuracion.rutaClave}.incompatible-viejo.bak`;
    const respaldoReciente =
        `${configuracion.ruta}.incompatible-reciente.bak`;
    const respaldoAjeno = path.join(
        carpeta,
        'otro.sqlite.incompatible-viejo.bak'
    );
    for (const ruta of [
        respaldoViejoBase,
        respaldoViejoClave,
        respaldoReciente,
        respaldoAjeno
    ]) {
        fs.writeFileSync(ruta, 'respaldo');
    }
    const fechaVieja = new Date(Date.now() - RETENCION_MS - 60000);
    fs.utimesSync(respaldoViejoBase, fechaVieja, fechaVieja);
    fs.utimesSync(respaldoViejoClave, fechaVieja, fechaVieja);
    fs.utimesSync(respaldoAjeno, fechaVieja, fechaVieja);

    almacen = crearAlmacenMensajesRecientes(configuracion);
    almacen.cerrar();

    assert.equal(fs.existsSync(respaldoViejoBase), false);
    assert.equal(fs.existsSync(respaldoViejoClave), false);
    assert.equal(fs.existsSync(respaldoReciente), true);
    assert.equal(fs.existsSync(respaldoAjeno), true);
});

test('no mueve el caché si una clave nueva no supera la verificación', t => {
    const carpeta = temporal(t);
    const anteriores = opciones(carpeta);
    const almacen = crearAlmacenMensajesRecientes(anteriores);
    almacen.cerrar();
    const claveAnterior = fs.readFileSync(anteriores.rutaClave);
    const baseAnterior = fs.readFileSync(anteriores.ruta);

    assert.throws(
        () => crearAlmacenMensajesRecientes({
            ...anteriores,
            cifradoDisponible: () => true,
            cifrarClave: valor => `actual:${valor}`,
            descifrarClave: () => {
                throw new Error('safeStorage no pudo descifrar');
            },
            recuperarCifradoIncompatible: true
        }),
        /safeStorage no pudo descifrar/u
    );

    assert.deepEqual(fs.readFileSync(anteriores.rutaClave), claveAnterior);
    assert.deepEqual(fs.readFileSync(anteriores.ruta), baseAnterior);
    assert.deepEqual(archivosRespaldados(carpeta), []);
});
