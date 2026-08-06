'use strict';

/*
 * Herramienta de desarrollo: cifra o recupera el fuente del manual técnico.
 * La contraseña se lee solo de ZEROONE_TECHNICAL_MANUAL_PASSWORD para que no
 * quede en el historial de comandos ni en package.json.
 *
 * Ejemplos:
 *   $env:ZEROONE_TECHNICAL_MANUAL_PASSWORD='...'
 *   node scripts/technical-manual-crypto.js decrypt docs/ARQUITECTURA_TECNICA_ZEROONE.enc docs-private/ARQUITECTURA_TECNICA_ZEROONE.md
 *   node scripts/technical-manual-crypto.js encrypt docs-private/ARQUITECTURA_TECNICA_ZEROONE.md docs/ARQUITECTURA_TECNICA_ZEROONE.enc
 */

const fs = require('node:fs');
const path = require('node:path');
const {
    cifrarManualTecnico,
    descifrarManualTecnico
} = require('../src/manuals');

const RAIZ_PROYECTO = path.resolve(__dirname, '..');

function resolverRutaProyecto(ruta, etiqueta) {
    const resuelta = path.resolve(RAIZ_PROYECTO, String(ruta || ''));
    const prefijoRaiz = `${RAIZ_PROYECTO}${path.sep}`;
    if (!resuelta.startsWith(prefijoRaiz)) {
        throw new Error(`${etiqueta} debe estar dentro del proyecto.`);
    }
    return resuelta;
}

function obtenerContrasena() {
    const contrasena = process.env.ZEROONE_TECHNICAL_MANUAL_PASSWORD;
    if (typeof contrasena !== 'string' || !contrasena.length) {
        throw new Error(
            'Definí ZEROONE_TECHNICAL_MANUAL_PASSWORD antes de ejecutar la herramienta.'
        );
    }
    return contrasena;
}

function ejecutar() {
    const [accion, origenArgumento, destinoArgumento] = process.argv.slice(2);
    if (!['encrypt', 'decrypt'].includes(accion) ||
        !origenArgumento || !destinoArgumento) {
        throw new Error(
            'Uso: node scripts/technical-manual-crypto.js <encrypt|decrypt> <origen> <destino>'
        );
    }

    const origen = resolverRutaProyecto(origenArgumento, 'El origen');
    const destino = resolverRutaProyecto(destinoArgumento, 'El destino');
    const contrasena = obtenerContrasena();
    const entrada = fs.readFileSync(origen, 'utf8');
    const salida = accion === 'encrypt'
        ? cifrarManualTecnico(entrada, contrasena)
        : descifrarManualTecnico(entrada, contrasena);

    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, salida, 'utf8');
    console.log(`Manual técnico ${accion === 'encrypt' ? 'cifrado' : 'recuperado'} correctamente.`);
}

try {
    ejecutar();
} catch (error) {
    console.error(`No se pudo procesar el manual técnico: ${error.message}`);
    process.exitCode = 1;
}
