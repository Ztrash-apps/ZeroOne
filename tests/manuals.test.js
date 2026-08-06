'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    ErrorManual,
    cifrarManualTecnico,
    leerManualLocal
} = require('../src/manuals');

const CONTRASENA_PRUEBA = 'prueba-manual-tecnico-2026';
const CONTENIDO_TECNICO_PRUEBA = '# Arquitectura\n\nContenido técnico protegido.';

function serializarManualCifrado(contenido, contrasena) {
    const resultado = cifrarManualTecnico(contenido, contrasena);
    return typeof resultado === 'string'
        ? resultado
        : JSON.stringify(resultado);
}

function crearDocumentacionTemporal() {
    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-manuales-'));
    fs.writeFileSync(
        path.join(carpeta, 'GUIA_DE_USO_ZEROONE.md'),
        '# Guía\n\nContenido de uso.',
        'utf8'
    );
    fs.writeFileSync(
        path.join(carpeta, 'ARQUITECTURA_TECNICA_ZEROONE.enc'),
        serializarManualCifrado(CONTENIDO_TECNICO_PRUEBA, CONTRASENA_PRUEBA),
        'utf8'
    );
    return carpeta;
}

test('los manuales locales se leen desde una lista cerrada de documentos', () => {
    const carpeta = crearDocumentacionTemporal();

    try {
        const uso = leerManualLocal('uso', { carpetaDocumentacion: carpeta });
        const tecnico = leerManualLocal('TECNICO', {
            carpetaDocumentacion: carpeta,
            contrasena: CONTRASENA_PRUEBA
        });

        assert.deepEqual(uso, {
            id: 'uso',
            titulo: 'Guía de uso',
            descripcion: 'Recorrido práctico para usar ZeroOne día a día.',
            protegido: false,
            contenido: '# Guía\n\nContenido de uso.'
        });
        assert.equal(tecnico.id, 'tecnico');
        assert.equal(tecnico.titulo, 'Arquitectura técnica');
        assert.equal(tecnico.protegido, true);
        assert.equal(tecnico.contenido, CONTENIDO_TECNICO_PRUEBA);
    } finally {
        fs.rmSync(carpeta, { recursive: true, force: true });
    }
});

test('el manual técnico exige contraseña y rechaza una incorrecta sin revelar el contenido', () => {
    const carpeta = crearDocumentacionTemporal();

    try {
        assert.throws(
            () => leerManualLocal('tecnico', { carpetaDocumentacion: carpeta }),
            error => error instanceof ErrorManual &&
                error.codigo === 'MANUAL_PROTEGIDO' &&
                !error.message.includes(CONTENIDO_TECNICO_PRUEBA)
        );
        assert.throws(
            () => leerManualLocal('tecnico', {
                carpetaDocumentacion: carpeta,
                contrasena: 'contraseña-incorrecta'
            }),
            error => error instanceof ErrorManual &&
                error.codigo === 'MANUAL_CONTRASENA_INCORRECTA' &&
                !error.message.includes(CONTENIDO_TECNICO_PRUEBA)
        );
    } finally {
        fs.rmSync(carpeta, { recursive: true, force: true });
    }
});

test('un archivo técnico cifrado corrupto falla de forma controlada', () => {
    const carpeta = crearDocumentacionTemporal();

    try {
        fs.writeFileSync(
            path.join(carpeta, 'ARQUITECTURA_TECNICA_ZEROONE.enc'),
            '{archivo-cifrado-inválido',
            'utf8'
        );

        assert.throws(
            () => leerManualLocal('tecnico', {
                carpetaDocumentacion: carpeta,
                contrasena: CONTRASENA_PRUEBA
            }),
            error => error instanceof ErrorManual &&
                error.codigo === 'MANUAL_NO_DISPONIBLE' &&
                !error.message.includes(carpeta)
        );
    } finally {
        fs.rmSync(carpeta, { recursive: true, force: true });
    }
});

test('los manuales no permiten resolver nombres o rutas arbitrarias', () => {
    const carpeta = crearDocumentacionTemporal();

    try {
        assert.throws(
            () => leerManualLocal('../../package', { carpetaDocumentacion: carpeta }),
            error => error instanceof ErrorManual &&
                error.codigo === 'MANUAL_NO_ENCONTRADO'
        );
    } finally {
        fs.rmSync(carpeta, { recursive: true, force: true });
    }
});

test('un manual faltante entrega un error controlado sin exponer la ruta local', () => {
    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-manuales-'));

    try {
        assert.throws(
            () => leerManualLocal('uso', { carpetaDocumentacion: carpeta }),
            error => error instanceof ErrorManual &&
                error.codigo === 'MANUAL_NO_DISPONIBLE' &&
                !error.message.includes(carpeta)
        );
    } finally {
        fs.rmSync(carpeta, { recursive: true, force: true });
    }
});

test('el backend publica solamente los manuales locales y el técnico se desbloquea por una ruta local', () => {
    const raiz = path.resolve(__dirname, '..');
    const backend = fs.readFileSync(path.join(raiz, 'src', 'bot.js'), 'utf8');
    const paquete = JSON.parse(
        fs.readFileSync(path.join(raiz, 'package.json'), 'utf8')
    );
    const gitignore = fs.readFileSync(path.join(raiz, '.gitignore'), 'utf8');

    assert.match(backend, /app\.get\('\/manuales\/:tipo'/u);
    assert.match(backend, /leerManualLocal\(req\.params\.tipo/u);
    assert.match(backend, /app\.post\('\/manuales\/tecnico\/desbloquear'/u);
    assert.match(backend, /MANUAL_PROTEGIDO/u);
    assert.match(backend, /MANUAL_CONTRASENA_INCORRECTA/u);
    assert.match(backend, /CARPETA_DOCUMENTACION/u);
    assert.ok(
        paquete.build.files.includes('docs/**/*'),
        'Los manuales deben entrar en el instalador.'
    );
    assert.equal(
        fs.existsSync(path.join(raiz, 'docs', 'ARQUITECTURA_TECNICA_ZEROONE.md')),
        false,
        'El manual técnico en texto plano no debe distribuirse junto a la aplicación.'
    );
    assert.equal(
        fs.existsSync(path.join(raiz, 'docs', 'ARQUITECTURA_TECNICA_ZEROONE.enc')),
        true,
        'El instalador debe contener únicamente la versión cifrada del manual técnico.'
    );
    assert.match(
        gitignore,
        /^\/docs-private\/$/mu,
        'La fuente recuperable del manual técnico debe permanecer fuera de Git.'
    );
});
