'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    ARCHIVO_MARCADOR_INSTALACION_LIMPIA,
    crearPlanRestablecimiento,
    debeOmitirMigracionLegada,
    ejecutarRestablecimientoLocal
} = require('../src/factory-reset');

function crearTemporal(t) {
    const ruta = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-reset-'));
    t.after(() => fs.rmSync(ruta, { recursive: true, force: true }));
    return ruta;
}

test('el restablecimiento borra solo perfiles conocidos, IA y crea un perfil limpio', t => {
    const raiz = crearTemporal(t);
    const rutaAppData = path.join(raiz, 'appdata');
    const rutaLocalAppData = path.join(raiz, 'localappdata');
    const perfil = path.join(rutaAppData, 'autostatues');
    const perfilResidual = path.join(rutaAppData, 'ZeroOne');
    const carpetaIa = path.join(rutaLocalAppData, 'AutoStatues', 'ia');
    const ajeno = path.join(rutaAppData, 'otra-aplicacion', 'conservar.txt');

    fs.mkdirSync(path.join(perfil, 'datos', 'sesiones', 'linea-1'), {
        recursive: true
    });
    fs.writeFileSync(
        path.join(perfil, 'datos', 'sesiones', 'linea-1', 'creds.json'),
        '{"privado":true}',
        'utf8'
    );
    fs.writeFileSync(
        path.join(perfil, 'datos', 'agendamiento.sqlite-wal'),
        'datos de agenda',
        'utf8'
    );
    fs.mkdirSync(perfilResidual, { recursive: true });
    fs.writeFileSync(path.join(perfilResidual, 'Local Storage'), 'cache', 'utf8');
    fs.mkdirSync(carpetaIa, { recursive: true });
    fs.writeFileSync(path.join(carpetaIa, 'modelo.gguf'), 'modelo', 'utf8');
    fs.mkdirSync(path.dirname(ajeno), { recursive: true });
    fs.writeFileSync(ajeno, 'conservar', 'utf8');

    const plan = ejecutarRestablecimientoLocal({
        rutaAppData,
        rutaLocalAppData
    });

    assert.equal(fs.existsSync(perfilResidual), false);
    assert.equal(fs.existsSync(carpetaIa), false);
    assert.equal(
        fs.existsSync(path.join(perfil, 'datos', 'sesiones', 'linea-1')),
        false
    );
    assert.equal(
        fs.existsSync(
            path.join(plan.carpetaDatosNueva, ARCHIVO_MARCADOR_INSTALACION_LIMPIA)
        ),
        true
    );
    assert.equal(debeOmitirMigracionLegada(plan.carpetaDatosNueva), true);
    assert.equal(fs.readFileSync(ajeno, 'utf8'), 'conservar');
});

test('sin el marcador, una instalación nueva conserva la migración legada', t => {
    const raiz = crearTemporal(t);
    const carpetaDatos = path.join(raiz, 'datos');
    fs.mkdirSync(carpetaDatos, { recursive: true });

    assert.equal(debeOmitirMigracionLegada(carpetaDatos), false);
});

test('el plan rechaza raíces peligrosas y no acepta rutas implícitas', () => {
    assert.throws(
        () => crearPlanRestablecimiento({
            rutaAppData: path.parse(process.cwd()).root,
            rutaLocalAppData: path.join(os.tmpdir(), 'local')
        }),
        /no es valida/u
    );
    assert.throws(
        () => crearPlanRestablecimiento({
            rutaAppData: path.join(os.tmpdir(), 'app'),
            rutaLocalAppData: ''
        }),
        /no es valida/u
    );
});
