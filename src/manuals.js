'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TAMANO_MAXIMO_MANUAL = 512 * 1024;
const TAMANO_MAXIMO_MANUAL_CIFRADO = TAMANO_MAXIMO_MANUAL * 3;
const VERSION_MANUAL_TECNICO_CIFRADO = 1;
const ALGORITMO_MANUAL_TECNICO = 'aes-256-gcm';
const KDF_MANUAL_TECNICO = 'scrypt';
const CONTEXTO_MANUAL_TECNICO = Buffer.from(
    'ZeroOne/manual-tecnico/v1',
    'utf8'
);
const LONGITUD_SAL = 16;
const LONGITUD_IV = 12;
const LONGITUD_ETIQUETA = 16;
const LONGITUD_CLAVE = 32;

const MANUALES = Object.freeze({
    uso: Object.freeze({
        id: 'uso',
        titulo: 'Guía de uso',
        descripcion: 'Recorrido práctico para usar ZeroOne día a día.',
        archivo: 'GUIA_DE_USO_ZEROONE.md',
        protegido: false
    }),
    tecnico: Object.freeze({
        id: 'tecnico',
        titulo: 'Arquitectura técnica',
        descripcion: 'Diseño interno, flujos y decisiones de la aplicación.',
        archivo: 'ARQUITECTURA_TECNICA_ZEROONE.enc',
        protegido: true
    })
});

class ErrorManual extends Error {
    constructor(codigo, mensaje, causa) {
        super(mensaje, causa ? { cause: causa } : undefined);
        this.name = 'ErrorManual';
        this.codigo = codigo;
    }
}

function normalizarTipoManual(tipo) {
    return String(tipo || '').trim().toLowerCase();
}

function crearErrorManualNoDisponible(causa) {
    return new ErrorManual(
        'MANUAL_NO_DISPONIBLE',
        'El manual no está disponible en esta instalación.',
        causa
    );
}

function normalizarContrasenaManual(contrasena) {
    if (typeof contrasena !== 'string' || !contrasena.length) {
        throw new ErrorManual(
            'MANUAL_PROTEGIDO',
            'El manual técnico está protegido con contraseña.'
        );
    }

    if (Buffer.byteLength(contrasena, 'utf8') > 1024) {
        throw new ErrorManual(
            'MANUAL_CONTRASENA_INCORRECTA',
            'La contraseña no coincide.'
        );
    }

    return contrasena;
}

function derivarClaveManualTecnico(contrasena, sal) {
    return crypto.scryptSync(contrasena, sal, LONGITUD_CLAVE, {
        N: 32768,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024
    });
}

function decodificarBase64Seguro(valor, nombre, longitudEsperada) {
    if (typeof valor !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(valor) ||
        valor.length % 4 !== 0) {
        throw crearErrorManualNoDisponible(
            new Error(`Campo cifrado inválido: ${nombre}.`)
        );
    }

    const bytes = Buffer.from(valor, 'base64');
    if (!bytes.length ||
        (longitudEsperada !== undefined && bytes.length !== longitudEsperada)) {
        throw crearErrorManualNoDisponible(
            new Error(`Campo cifrado inválido: ${nombre}.`)
        );
    }

    return bytes;
}

function leerSobreManualTecnico(serializado) {
    let sobre;
    try {
        sobre = JSON.parse(String(serializado || ''));
    } catch (error) {
        throw crearErrorManualNoDisponible(error);
    }

    if (!sobre || typeof sobre !== 'object' || Array.isArray(sobre) ||
        sobre.version !== VERSION_MANUAL_TECNICO_CIFRADO ||
        sobre.algoritmo !== ALGORITMO_MANUAL_TECNICO ||
        sobre.kdf !== KDF_MANUAL_TECNICO) {
        throw crearErrorManualNoDisponible(
            new Error('El formato del manual técnico no es compatible.')
        );
    }

    return {
        sal: decodificarBase64Seguro(sobre.sal, 'sal', LONGITUD_SAL),
        iv: decodificarBase64Seguro(sobre.iv, 'iv', LONGITUD_IV),
        etiqueta: decodificarBase64Seguro(
            sobre.etiqueta,
            'etiqueta',
            LONGITUD_ETIQUETA
        ),
        contenido: decodificarBase64Seguro(sobre.contenido, 'contenido')
    };
}

function cifrarManualTecnico(contenido, contrasena) {
    const texto = String(contenido || '').replace(/^\uFEFF/u, '');
    if (!texto || Buffer.byteLength(texto, 'utf8') > TAMANO_MAXIMO_MANUAL) {
        throw crearErrorManualNoDisponible(
            new Error('El contenido del manual técnico no es válido.')
        );
    }

    const sal = crypto.randomBytes(LONGITUD_SAL);
    const claveConSal = derivarClaveManualTecnico(
        normalizarContrasenaManual(contrasena),
        sal
    );
    const iv = crypto.randomBytes(LONGITUD_IV);

    try {
        const cifrador = crypto.createCipheriv(
            ALGORITMO_MANUAL_TECNICO,
            claveConSal,
            iv,
            { authTagLength: LONGITUD_ETIQUETA }
        );
        cifrador.setAAD(CONTEXTO_MANUAL_TECNICO);
        const contenidoCifrado = Buffer.concat([
            cifrador.update(texto, 'utf8'),
            cifrador.final()
        ]);
        const etiqueta = cifrador.getAuthTag();

        return `${JSON.stringify({
            version: VERSION_MANUAL_TECNICO_CIFRADO,
            algoritmo: ALGORITMO_MANUAL_TECNICO,
            kdf: KDF_MANUAL_TECNICO,
            sal: sal.toString('base64'),
            iv: iv.toString('base64'),
            etiqueta: etiqueta.toString('base64'),
            contenido: contenidoCifrado.toString('base64')
        }, null, 2)}\n`;
    } finally {
        claveConSal.fill(0);
    }
}

function descifrarManualTecnico(serializado, contrasena) {
    const claveContrasena = normalizarContrasenaManual(contrasena);
    const sobre = leerSobreManualTecnico(serializado);
    let clave;

    try {
        clave = derivarClaveManualTecnico(claveContrasena, sobre.sal);
        const descifrador = crypto.createDecipheriv(
            ALGORITMO_MANUAL_TECNICO,
            clave,
            sobre.iv,
            { authTagLength: LONGITUD_ETIQUETA }
        );
        descifrador.setAAD(CONTEXTO_MANUAL_TECNICO);
        descifrador.setAuthTag(sobre.etiqueta);
        const contenido = Buffer.concat([
            descifrador.update(sobre.contenido),
            descifrador.final()
        ]).toString('utf8').replace(/^\uFEFF/u, '');

        if (!contenido || Buffer.byteLength(contenido, 'utf8') > TAMANO_MAXIMO_MANUAL) {
            throw new Error('El contenido descifrado no es válido.');
        }

        return contenido;
    } catch (error) {
        if (error instanceof ErrorManual) {
            throw error;
        }

        throw new ErrorManual(
            'MANUAL_CONTRASENA_INCORRECTA',
            'La contraseña no coincide.',
            error
        );
    } finally {
        clave?.fill(0);
    }
}

function resolverArchivoManual(tipo, carpetaDocumentacion) {
    const manual = MANUALES[normalizarTipoManual(tipo)];
    if (!manual) {
        throw new ErrorManual(
            'MANUAL_NO_ENCONTRADO',
            'El manual solicitado no existe.'
        );
    }

    const raiz = path.resolve(carpetaDocumentacion || path.join(__dirname, '..', 'docs'));
    const archivo = path.resolve(raiz, manual.archivo);
    const prefijoRaiz = raiz.endsWith(path.sep) ? raiz : `${raiz}${path.sep}`;

    if (!archivo.startsWith(prefijoRaiz)) {
        throw new ErrorManual(
            'MANUAL_NO_ENCONTRADO',
            'El manual solicitado no existe.'
        );
    }

    return { manual, archivo };
}

function leerManualLocal(tipo, opciones = {}) {
    const { manual, archivo } = resolverArchivoManual(
        tipo,
        opciones.carpetaDocumentacion
    );

    let estadisticas;
    try {
        estadisticas = fs.statSync(archivo);
    } catch (error) {
        throw crearErrorManualNoDisponible(error);
    }

    const limite = manual.protegido
        ? TAMANO_MAXIMO_MANUAL_CIFRADO
        : TAMANO_MAXIMO_MANUAL;
    if (!estadisticas.isFile() || estadisticas.size > limite) {
        throw crearErrorManualNoDisponible();
    }

    try {
        const archivoManual = fs.readFileSync(archivo, 'utf8');
        const contenido = manual.protegido
            ? descifrarManualTecnico(archivoManual, opciones.contrasena)
            : archivoManual.replace(/^\uFEFF/u, '');

        return {
            id: manual.id,
            titulo: manual.titulo,
            descripcion: manual.descripcion,
            protegido: manual.protegido,
            contenido
        };
    } catch (error) {
        if (error instanceof ErrorManual) {
            throw error;
        }
        throw crearErrorManualNoDisponible(error);
    }
}

module.exports = {
    ALGORITMO_MANUAL_TECNICO,
    ErrorManual,
    KDF_MANUAL_TECNICO,
    MANUALES,
    TAMANO_MAXIMO_MANUAL,
    TAMANO_MAXIMO_MANUAL_CIFRADO,
    VERSION_MANUAL_TECNICO_CIFRADO,
    cifrarManualTecnico,
    descifrarManualTecnico,
    leerManualLocal
};
