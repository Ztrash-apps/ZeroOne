const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const {
    OBJETIVO_BYTES_SALIDA,
    convertirNombreAJpeg,
    optimizarImagenArchivo
} = require('../src/image-compression');

async function conCarpetaTemporal(nombre, tarea) {
    const carpeta = fs.mkdtempSync(
        path.join(os.tmpdir(), `autostatues-compresion-${nombre}-`)
    );

    try {
        await tarea(carpeta);
    } finally {
        fs.rmSync(carpeta, { recursive: true, force: true });
    }
}

test('reduce sin recortar, corrige el formato y no agranda imágenes pequeñas', async () => {
    await conCarpetaTemporal('dimensiones', async carpeta => {
        const casos = [
            {
                nombre: 'vertical.png',
                ancho: 1600,
                alto: 3200,
                anchoEsperado: 960,
                altoEsperado: 1920
            },
            {
                nombre: 'horizontal.jpg',
                ancho: 1600,
                alto: 900,
                anchoEsperado: 1080,
                altoEsperado: 608
            },
            {
                nombre: 'pequena.png',
                ancho: 320,
                alto: 640,
                anchoEsperado: 320,
                altoEsperado: 640
            }
        ];

        for (const caso of casos) {
            const ruta = path.join(carpeta, caso.nombre);
            await sharp({
                create: {
                    width: caso.ancho,
                    height: caso.alto,
                    channels: 4,
                    background: { r: 37, g: 99, b: 235, alpha: 0.6 }
                }
            }).png().toFile(ruta);

            const resultado = await optimizarImagenArchivo(ruta);
            const metadatos = await sharp(resultado.rutaFinal).metadata();

            assert.equal(metadatos.format, 'jpeg');
            assert.equal(metadatos.width, caso.anchoEsperado);
            assert.equal(metadatos.height, caso.altoEsperado);
            assert.equal(resultado.anchoFinal, caso.anchoEsperado);
            assert.equal(resultado.altoFinal, caso.altoEsperado);
            assert.ok(
                fs.statSync(resultado.rutaFinal).size <= OBJETIVO_BYTES_SALIDA
            );
            assert.equal(fs.existsSync(ruta), false);

            const proporcionOriginal = caso.ancho / caso.alto;
            const proporcionFinal = metadatos.width / metadatos.height;
            assert.ok(Math.abs(proporcionOriginal - proporcionFinal) < 0.002);
        }
    });
});

test('ajusta calidad y resolución hasta cumplir un objetivo de peso exigente', async () => {
    await conCarpetaTemporal('peso', async carpeta => {
        const ruta = path.join(carpeta, 'ruido.png');
        const ancho = 1000;
        const alto = 1600;
        const pixeles = crypto.randomBytes(ancho * alto * 3);
        const objetivoBytes = 90 * 1024;

        await sharp(pixeles, {
            raw: { width: ancho, height: alto, channels: 3 }
        }).png({ compressionLevel: 0 }).toFile(ruta);

        const resultado = await optimizarImagenArchivo(ruta, {
            objetivoBytes
        });
        const metadatos = await sharp(resultado.rutaFinal).metadata();

        assert.equal(resultado.objetivoCumplido, true);
        assert.ok(resultado.bytesFinales <= objetivoBytes);
        assert.ok(resultado.bytesFinales < resultado.bytesOriginales);
        assert.ok(metadatos.width <= 1080);
        assert.ok(metadatos.height <= 1920);
        assert.equal(metadatos.format, 'jpeg');
        assert.equal(fs.existsSync(ruta), false);
    });
});

test('rechaza imágenes dañadas y entradas por encima del límite de seguridad', async () => {
    await conCarpetaTemporal('invalidas', async carpeta => {
        const rutaDanada = path.join(carpeta, 'danada.jpg');
        fs.writeFileSync(rutaDanada, Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]));

        await assert.rejects(
            optimizarImagenArchivo(rutaDanada),
            error => error?.codigo === 'IMAGEN_NO_DECODIFICABLE'
        );

        const rutaPesada = path.join(carpeta, 'pesada.png');
        fs.writeFileSync(rutaPesada, Buffer.alloc(1025, 1));

        await assert.rejects(
            optimizarImagenArchivo(rutaPesada, { maximoBytesEntrada: 1024 }),
            error =>
                error?.codigo === 'IMAGEN_ENTRADA_DEMASIADO_PESADA' &&
                error?.statusCode === 413
        );
    });
});

test('normaliza nombres almacenados al formato JPEG generado', () => {
    assert.equal(convertirNombreAJpeg('foto familiar.PNG'), 'foto familiar.jpg');
    assert.equal(convertirNombreAJpeg('../../imagen.jpeg'), 'imagen.jpg');
    assert.equal(convertirNombreAJpeg(''), 'imagen.jpg');
});
