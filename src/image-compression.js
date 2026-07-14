const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const MEBIBYTE = 1024 * 1024;
const MAXIMO_BYTES_ENTRADA = 50 * MEBIBYTE;
const OBJETIVO_BYTES_SALIDA = Math.floor(1.5 * MEBIBYTE);
const MAXIMO_PIXELES_ENTRADA = 50_000_000;

const PERFILES_COMPRESION = Object.freeze([
    Object.freeze({ ancho: 1080, alto: 1920, calidad: 82 }),
    Object.freeze({ ancho: 1080, alto: 1920, calidad: 74 }),
    Object.freeze({ ancho: 960, alto: 1707, calidad: 70 }),
    Object.freeze({ ancho: 840, alto: 1493, calidad: 66 }),
    Object.freeze({ ancho: 720, alto: 1280, calidad: 60 })
]);

class ErrorCompresionImagen extends Error {
    constructor(codigo, mensaje, statusCode = 400) {
        super(mensaje);
        this.name = 'ErrorCompresionImagen';
        this.codigo = codigo;
        this.statusCode = statusCode;
    }
}

function crearProcesador(ruta, limitePixeles) {
    return sharp(ruta, {
        failOn: 'error',
        limitInputPixels: limitePixeles,
        sequentialRead: true
    });
}

async function generarCandidato(ruta, perfil, limitePixeles) {
    return crearProcesador(ruta, limitePixeles)
        .rotate()
        .resize({
            width: perfil.ancho,
            height: perfil.alto,
            fit: 'inside',
            withoutEnlargement: true
        })
        .flatten({ background: { r: 0, g: 0, b: 0 } })
        .toColourspace('srgb')
        .jpeg({
            quality: perfil.calidad,
            progressive: true,
            chromaSubsampling: '4:2:0',
            mozjpeg: true
        })
        .toBuffer({ resolveWithObject: true });
}

async function guardarCandidatoOptimizado(rutaOriginal, buffer) {
    const rutaFinal = `${rutaOriginal}.opt-${process.pid}-${crypto.randomUUID()}.jpg`;

    try {
        await fs.promises.writeFile(rutaFinal, buffer, { flag: 'wx' });
    } catch (error) {
        await fs.promises.rm(rutaFinal, { force: true }).catch(() => {});
        const errorGuardado = new ErrorCompresionImagen(
            'IMAGEN_OPTIMIZADA_NO_GUARDADA',
            'No se pudo guardar la imagen optimizada. Cerrá cualquier programa que esté usando el archivo e intentá nuevamente.',
            500
        );
        errorGuardado.cause = error;
        throw errorGuardado;
    }

    await fs.promises.rm(rutaOriginal, {
        force: true,
        maxRetries: 4,
        retryDelay: 100
    }).catch(() => {});

    return rutaFinal;
}

function mensajeErrorDecodificacion(error) {
    const detalle = String(error?.message || '').toLowerCase();

    if (detalle.includes('pixel limit') || detalle.includes('exceeds pixel')) {
        return new ErrorCompresionImagen(
            'IMAGEN_RESOLUCION_EXCESIVA',
            'La resolución de la imagen es demasiado alta para procesarla de forma segura.',
            413
        );
    }

    return new ErrorCompresionImagen(
        'IMAGEN_NO_DECODIFICABLE',
        'La imagen está dañada o no es un archivo JPG o PNG válido.'
    );
}

async function optimizarImagenArchivo(ruta, opciones = {}) {
    const maximoBytesEntrada = Number.isFinite(opciones.maximoBytesEntrada)
        ? opciones.maximoBytesEntrada
        : MAXIMO_BYTES_ENTRADA;
    const objetivoBytes = Number.isFinite(opciones.objetivoBytes)
        ? opciones.objetivoBytes
        : OBJETIVO_BYTES_SALIDA;
    const maximoPixelesEntrada = Number.isFinite(opciones.maximoPixelesEntrada)
        ? opciones.maximoPixelesEntrada
        : MAXIMO_PIXELES_ENTRADA;

    let estadisticas;

    try {
        estadisticas = await fs.promises.stat(ruta);
    } catch {
        throw new ErrorCompresionImagen(
            'IMAGEN_NO_ENCONTRADA',
            'No se pudo encontrar la imagen seleccionada.'
        );
    }

    if (!estadisticas.isFile() || estadisticas.size === 0) {
        throw new ErrorCompresionImagen(
            'IMAGEN_VACIA',
            'La imagen seleccionada está vacía o no es válida.'
        );
    }

    if (estadisticas.size > maximoBytesEntrada) {
        throw new ErrorCompresionImagen(
            'IMAGEN_ENTRADA_DEMASIADO_PESADA',
            `La imagen original no puede superar ${Math.round(maximoBytesEntrada / MEBIBYTE)} MB.`,
            413
        );
    }

    let metadatos;

    try {
        metadatos = await crearProcesador(ruta, maximoPixelesEntrada).metadata();
    } catch (error) {
        throw mensajeErrorDecodificacion(error);
    }

    if (
        !['jpeg', 'png'].includes(metadatos.format) ||
        !Number.isInteger(metadatos.width) ||
        !Number.isInteger(metadatos.height)
    ) {
        throw new ErrorCompresionImagen(
            'FORMATO_IMAGEN_NO_ADMITIDO',
            'El archivo debe ser una imagen JPG o PNG válida.'
        );
    }

    let candidatoFinal = null;
    let perfilFinal = null;

    try {
        for (const perfil of PERFILES_COMPRESION) {
            const candidato = await generarCandidato(
                ruta,
                perfil,
                maximoPixelesEntrada
            );

            candidatoFinal = candidato;
            perfilFinal = perfil;
            if (candidato.data.length <= objetivoBytes) break;
        }

        let ancho = 640;
        let alto = 1138;
        let calidad = 54;

        while (
            candidatoFinal &&
            candidatoFinal.data.length > objetivoBytes &&
            ancho >= 128 &&
            alto >= 227
        ) {
            const perfil = { ancho, alto, calidad };
            candidatoFinal = await generarCandidato(
                ruta,
                perfil,
                maximoPixelesEntrada
            );
            perfilFinal = perfil;
            ancho = Math.floor(ancho * 0.82);
            alto = Math.floor(alto * 0.82);
            calidad = Math.max(36, calidad - 4);
        }
    } catch (error) {
        if (error instanceof ErrorCompresionImagen) throw error;
        throw mensajeErrorDecodificacion(error);
    }

    if (!candidatoFinal?.data?.length) {
        throw new ErrorCompresionImagen(
            'IMAGEN_NO_OPTIMIZABLE',
            'No se pudo preparar la imagen para su publicación.'
        );
    }

    if (candidatoFinal.data.length > objetivoBytes) {
        throw new ErrorCompresionImagen(
            'IMAGEN_NO_OPTIMIZABLE',
            'No se pudo reducir la imagen hasta un peso seguro para publicarla.'
        );
    }

    const rutaFinal = await guardarCandidatoOptimizado(
        ruta,
        candidatoFinal.data
    );

    return {
        rutaFinal,
        formatoOriginal: metadatos.format,
        formatoFinal: 'jpeg',
        anchoOriginal: metadatos.width,
        altoOriginal: metadatos.height,
        anchoFinal: candidatoFinal.info.width,
        altoFinal: candidatoFinal.info.height,
        bytesOriginales: estadisticas.size,
        bytesFinales: candidatoFinal.data.length,
        calidadFinal: perfilFinal.calidad,
        objetivoCumplido: candidatoFinal.data.length <= objetivoBytes
    };
}

function convertirNombreAJpeg(nombreOriginal) {
    const nombreSeguro = path.basename(String(nombreOriginal || 'imagen'));
    const base = path.parse(nombreSeguro).name || 'imagen';
    return `${base}.jpg`;
}

module.exports = {
    ErrorCompresionImagen,
    MAXIMO_BYTES_ENTRADA,
    MAXIMO_PIXELES_ENTRADA,
    OBJETIVO_BYTES_SALIDA,
    PERFILES_COMPRESION,
    convertirNombreAJpeg,
    optimizarImagenArchivo
};
