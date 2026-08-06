'use strict';

/*
 * Validación rápida de sintaxis para los archivos mantenidos por el proyecto.
 * No inicia Electron, Express ni sockets de WhatsApp.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RAIZ_PROYECTO = path.resolve(__dirname, '..');
const ARCHIVOS_RAIZ = ['main.js', 'preload.js'];
const CARPETAS_JAVASCRIPT = ['scripts', 'src', 'tests', path.join('public', 'js')];

function listarArchivosJavaScript(ruta) {
    const archivos = [];

    for (const entrada of fs.readdirSync(ruta, { withFileTypes: true })) {
        const rutaEntrada = path.join(ruta, entrada.name);
        if (entrada.isDirectory()) {
            archivos.push(...listarArchivosJavaScript(rutaEntrada));
        } else if (entrada.isFile() && entrada.name.endsWith('.js')) {
            archivos.push(rutaEntrada);
        }
    }

    return archivos;
}

function obtenerArchivosAValidar() {
    const archivosRaiz = ARCHIVOS_RAIZ.map(nombre =>
        path.join(RAIZ_PROYECTO, nombre)
    );
    const archivosCarpetas = CARPETAS_JAVASCRIPT.flatMap(carpeta =>
        listarArchivosJavaScript(path.join(RAIZ_PROYECTO, carpeta))
    );

    return [...archivosRaiz, ...archivosCarpetas].sort((a, b) =>
        a.localeCompare(b)
    );
}

function validarArchivo(ruta) {
    const resultado = spawnSync(process.execPath, ['--check', ruta], {
        cwd: RAIZ_PROYECTO,
        encoding: 'utf8'
    });

    if (resultado.status === 0) return;

    const detalle = String(resultado.stderr || resultado.stdout || '').trim();
    throw new Error(
        `Error de sintaxis en ${path.relative(RAIZ_PROYECTO, ruta)}${
            detalle ? `:\n${detalle}` : ''
        }`
    );
}

function main() {
    const archivos = obtenerArchivosAValidar();
    archivos.forEach(validarArchivo);
    console.log(`Sintaxis verificada: ${archivos.length} archivos JavaScript.`);
}

try {
    main();
} catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
}
