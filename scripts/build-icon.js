'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const raiz = path.resolve(__dirname, '..');
const fuenteVector = path.join(
    raiz,
    'public',
    'assets',
    'zeroone-icon.svg'
);
const pngAplicacion = path.join(
    raiz,
    'public',
    'assets',
    'zeroone-icon.png'
);
const carpetaBuild = path.join(raiz, 'build');
const icoWindows = path.join(carpetaBuild, 'icon.ico');
const tamanosIco = [16, 20, 24, 32, 40, 48, 64, 128, 256];

async function renderizarPng(tamano) {
    return sharp(pngAplicacion)
        .resize(tamano, tamano, { fit: 'contain' })
        .png({ compressionLevel: 9 })
        .toBuffer();
}

function crearIco(imagenes) {
    const cabecera = Buffer.alloc(6);
    cabecera.writeUInt16LE(0, 0);
    cabecera.writeUInt16LE(1, 2);
    cabecera.writeUInt16LE(imagenes.length, 4);

    const directorio = Buffer.alloc(imagenes.length * 16);
    let desplazamiento = cabecera.length + directorio.length;

    imagenes.forEach(({ tamano, datos }, indice) => {
        const posicion = indice * 16;
        directorio.writeUInt8(tamano >= 256 ? 0 : tamano, posicion);
        directorio.writeUInt8(tamano >= 256 ? 0 : tamano, posicion + 1);
        directorio.writeUInt8(0, posicion + 2);
        directorio.writeUInt8(0, posicion + 3);
        directorio.writeUInt16LE(1, posicion + 4);
        directorio.writeUInt16LE(32, posicion + 6);
        directorio.writeUInt32LE(datos.length, posicion + 8);
        directorio.writeUInt32LE(desplazamiento, posicion + 12);
        desplazamiento += datos.length;
    });

    return Buffer.concat([
        cabecera,
        directorio,
        ...imagenes.map(imagen => imagen.datos)
    ]);
}

async function main() {
    fs.mkdirSync(carpetaBuild, { recursive: true });

    await sharp(fuenteVector, { density: 384 })
        .resize(1024, 1024, { fit: 'contain' })
        .png({ compressionLevel: 9 })
        .toFile(pngAplicacion);

    const imagenes = await Promise.all(
        tamanosIco.map(async tamano => ({
            tamano,
            datos: await renderizarPng(tamano)
        }))
    );

    fs.writeFileSync(icoWindows, crearIco(imagenes));
    console.log(`Iconos ZeroOne generados en ${path.relative(raiz, carpetaBuild)}.`);
}

main().catch(error => {
    console.error('No se pudieron generar los iconos de ZeroOne:', error);
    process.exitCode = 1;
});
