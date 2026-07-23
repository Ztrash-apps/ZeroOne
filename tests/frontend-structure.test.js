'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const raiz = path.resolve(__dirname, '..');
const rutaPublica = path.join(raiz, 'public');

test('la interfaz carga módulos ordenados y no conserva el script monolítico', () => {
    const html = fs.readFileSync(path.join(rutaPublica, 'index.html'), 'utf8');
    const modulos = [
        'shell.js',
        'lines.js',
        'agenda.js',
        'publication.js',
        'bootstrap.js'
    ];

    let posicionAnterior = -1;
    const fuentes = [];
    for (const modulo of modulos) {
        const etiqueta = `<script src="/js/${modulo}"></script>`;
        const posicion = html.indexOf(etiqueta);
        assert.ok(posicion > posicionAnterior, `${modulo} debe conservar su orden`);
        posicionAnterior = posicion;
        const ruta = path.join(rutaPublica, 'js', modulo);
        assert.equal(fs.existsSync(ruta), true, `${modulo} debe existir`);
        fuentes.push(fs.readFileSync(ruta, 'utf8'));
    }

    assert.equal(/<script>\s*[\s\S]+?<\/script>/u.test(html), false);
    assert.doesNotThrow(() => {
        new vm.Script(fuentes.join('\n'), { filename: 'zeroone-ui.js' });
    });
});

test('los estilos conservan su cascada por módulos y terminan en el sistema visual', () => {
    const html = fs.readFileSync(path.join(rutaPublica, 'index.html'), 'utf8');
    const estilos = [
        'foundation.css',
        'interface.css',
        'themes.css',
        'features.css',
        'design-system.css'
    ];

    let posicionAnterior = -1;
    for (const estilo of estilos) {
        const etiqueta = `<link rel="stylesheet" href="/css/${estilo}">`;
        const posicion = html.indexOf(etiqueta);
        assert.ok(posicion > posicionAnterior, `${estilo} debe conservar su cascada`);
        posicionAnterior = posicion;
        assert.equal(
            fs.existsSync(path.join(rutaPublica, 'css', estilo)),
            true,
            `${estilo} debe existir`
        );
    }

    const sistema = fs.readFileSync(
        path.join(rutaPublica, 'css', 'design-system.css'),
        'utf8'
    );
    assert.match(sistema, /ZeroOne Interface System/u);
    assert.match(sistema, /content-visibility:\s*auto/u);
});

test('las tareas periódicas se pausan fuera de su pantalla o con la app oculta', () => {
    const bootstrap = fs.readFileSync(
        path.join(rutaPublica, 'js', 'bootstrap.js'),
        'utf8'
    );
    assert.match(bootstrap, /document\.hidden/u);
    assert.match(bootstrap, /seccionesPermitidas\.has\(seccionActual\)/u);
    assert.doesNotMatch(bootstrap, /setInterval\(actualizarLineas/u);
});
