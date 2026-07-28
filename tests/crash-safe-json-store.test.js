'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    crearAlmacenJsonSeguro
} = require('../src/crash-safe-json-store');

function crearTemporal(t) {
    const carpeta = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-json-seguro-')
    );
    t.after(() => fs.rmSync(carpeta, { recursive: true, force: true }));
    return path.join(carpeta, 'datos.json');
}

function crearAlmacen(ruta) {
    return crearAlmacenJsonSeguro({
        ruta,
        validar: datos => Boolean(
            datos &&
            typeof datos === 'object' &&
            !Array.isArray(datos) &&
            Array.isArray(datos.elementos)
        )
    });
}

function leerJson(ruta) {
    return JSON.parse(fs.readFileSync(ruta, 'utf8'));
}

test('recupera un principal lleno de NUL desde el .tmp válido', t => {
    const ruta = crearTemporal(t);
    const almacen = crearAlmacen(ruta);
    const esperado = {
        version: 1,
        elementos: [{ id: 'estado-1', linea: 'L21' }]
    };

    fs.writeFileSync(ruta, Buffer.alloc(2048, 0));
    fs.writeFileSync(
        almacen.rutas.temporal,
        JSON.stringify(esperado),
        'utf8'
    );

    const resultado = almacen.cargar({ version: 1, elementos: [] });

    assert.deepEqual(resultado.datos, esperado);
    assert.equal(resultado.fuente, 'temporal');
    assert.equal(resultado.recuperado, true);
    assert.deepEqual(leerJson(ruta), esperado);
    assert.deepEqual(leerJson(almacen.rutas.respaldo), esperado);
    assert.equal(fs.existsSync(almacen.rutas.temporal), false);
    assert.ok(resultado.errores.some(error => error.codigo === 'JSON_NUL'));
    assert.equal(resultado.archivosCorruptos.length, 1);
    assert.equal(
        fs.readFileSync(resultado.archivosCorruptos[0].ruta).every(
            byte => byte === 0
        ),
        true
    );
});

test('recupera un principal truncado desde el .bak válido', t => {
    const ruta = crearTemporal(t);
    const almacen = crearAlmacen(ruta);
    const esperado = {
        version: 1,
        elementos: [{ id: 'estado-backup' }]
    };

    fs.writeFileSync(ruta, '{"version":1,"elementos":[', 'utf8');
    fs.writeFileSync(almacen.rutas.temporal, '{"tambien":', 'utf8');
    fs.writeFileSync(
        almacen.rutas.respaldo,
        JSON.stringify(esperado),
        'utf8'
    );

    const resultado = almacen.cargar({ version: 1, elementos: [] });

    assert.deepEqual(resultado.datos, esperado);
    assert.equal(resultado.fuente, 'respaldo');
    assert.equal(resultado.recuperado, true);
    assert.deepEqual(leerJson(ruta), esperado);
    assert.deepEqual(leerJson(almacen.rutas.respaldo), esperado);
    assert.equal(resultado.archivosCorruptos.length, 2);
    assert.ok(
        resultado.archivosCorruptos.every(archivo =>
            fs.existsSync(archivo.ruta)
        )
    );
});

test('un principal válido tiene prioridad sobre .tmp y .bak válidos', t => {
    const ruta = crearTemporal(t);
    const almacen = crearAlmacen(ruta);
    const principal = { version: 3, elementos: [{ id: 'principal' }] };
    const temporal = { version: 2, elementos: [{ id: 'temporal' }] };
    const respaldo = { version: 1, elementos: [{ id: 'respaldo' }] };

    fs.writeFileSync(ruta, JSON.stringify(principal), 'utf8');
    fs.writeFileSync(
        almacen.rutas.temporal,
        JSON.stringify(temporal),
        'utf8'
    );
    fs.writeFileSync(
        almacen.rutas.respaldo,
        JSON.stringify(respaldo),
        'utf8'
    );

    const resultado = almacen.cargar({ version: 0, elementos: [] });

    assert.deepEqual(resultado.datos, principal);
    assert.equal(resultado.fuente, 'principal');
    assert.equal(resultado.recuperado, false);
    assert.equal(fs.existsSync(almacen.rutas.temporal), false);
    assert.deepEqual(
        leerJson(almacen.rutas.respaldo),
        respaldo,
        'un respaldo válido no se reemplaza durante una simple lectura'
    );
});

test('sin candidato válido devuelve el predeterminado sin sobrescribir evidencia', t => {
    const ruta = crearTemporal(t);
    const almacen = crearAlmacen(ruta);
    const predeterminado = { version: 1, elementos: [] };

    fs.writeFileSync(ruta, '{"incompleto"', 'utf8');
    fs.writeFileSync(almacen.rutas.temporal, Buffer.alloc(32, 0));
    fs.writeFileSync(
        almacen.rutas.respaldo,
        JSON.stringify({ version: 1, noElementos: true }),
        'utf8'
    );

    const principalAntes = fs.readFileSync(ruta);
    const respaldoAntes = fs.readFileSync(almacen.rutas.respaldo);
    const resultado = almacen.cargar(predeterminado);

    assert.deepEqual(resultado.datos, predeterminado);
    assert.equal(resultado.fuente, 'predeterminado');
    assert.equal(resultado.recuperado, false);
    assert.deepEqual(fs.readFileSync(ruta), principalAntes);
    assert.deepEqual(
        fs.readFileSync(almacen.rutas.respaldo),
        respaldoAntes
    );
    assert.equal(resultado.errores.length, 3);
});

test('guardar nunca sustituye un buen .bak con un principal corrupto', t => {
    const ruta = crearTemporal(t);
    const almacen = crearAlmacen(ruta);
    const respaldoBueno = {
        version: 1,
        elementos: [{ id: 'ultimo-bueno' }]
    };
    const nuevo = {
        version: 2,
        elementos: [{ id: 'nuevo' }]
    };

    fs.writeFileSync(ruta, '{"corrupto":', 'utf8');
    fs.writeFileSync(
        almacen.rutas.respaldo,
        JSON.stringify(respaldoBueno),
        'utf8'
    );

    almacen.guardar(nuevo);

    assert.deepEqual(leerJson(ruta), nuevo);
    assert.deepEqual(leerJson(almacen.rutas.respaldo), respaldoBueno);
});

test('guardarEspejado deja principal y respaldo en la misma revisión', t => {
    const ruta = crearTemporal(t);
    const almacen = crearAlmacen(ruta);
    const preparacion = {
        version: 1,
        elementos: [{ id: 'preparacion' }]
    };
    const envio = {
        version: 2,
        elementos: [{ id: 'envio' }]
    };

    almacen.guardarEspejado(preparacion);
    almacen.guardarEspejado(envio);
    fs.writeFileSync(ruta, Buffer.alloc(2048, 0));

    const recuperado = almacen.cargar({
        version: 0,
        elementos: []
    });

    assert.equal(recuperado.fuente, 'respaldo');
    assert.deepEqual(recuperado.datos, envio);
});
