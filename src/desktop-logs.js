'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TAMANO_MAXIMO_PREDETERMINADO = 5 * 1024 * 1024;
const MAXIMOS_ARCHIVOS_PREDETERMINADOS = 8;
const MAXIMOS_CARACTERES_LINEA = 12000;

function fechaArchivo(ahora = new Date()) {
    return ahora.toISOString().slice(0, 10);
}

function ocultarTelefono(valor) {
    const texto = String(valor || '');
    const digitos = texto.replace(/\D/gu, '');
    if (digitos.length < 8) return texto;
    return `${digitos.slice(0, 3)}…${digitos.slice(-2)}`;
}

function ocultarConsultaUrl(valor) {
    try {
        const url = new URL(valor);
        if (url.search) url.search = '?parametros-ocultos';
        if (url.hash) url.hash = '';
        return url.toString();
    } catch {
        return '[URL oculta]';
    }
}

function redactarTextoLog(valor) {
    let texto = String(valor ?? '');

    texto = texto.replace(
        /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/giu,
        '[imagen QR oculta]'
    );
    texto = texto.replace(
        /https?:\/\/[^\s"'<>]+/giu,
        coincidencia => ocultarConsultaUrl(coincidencia)
    );
    texto = texto.replace(
        /<Buffer(?:\s+[0-9a-f]{2})+(?:\s+\.\.\.[^>]*)?>/giu,
        '<Buffer oculto>'
    );
    texto = texto.replace(
        /((?:authorization|access[_ -]?token|refresh[_ -]?token|token|secret|password|contrase(?:ñ|n)a|clave|cookie|client[_ -]?secret|priv(?:ate)?key|rootkey|chainkey|ciphertext|qr)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/giu,
        '$1[oculto]'
    );
    texto = texto.replace(
        /\b[a-z0-9+/_=-]{48,}\b/giu,
        '[valor largo oculto]'
    );
    texto = texto.replace(
        /(?<![\p{L}\p{N}])\+?\d[\d\s().-]{6,}\d(?![\p{L}\p{N}])/gu,
        coincidencia => ocultarTelefono(coincidencia)
    );

    if (texto.length > MAXIMOS_CARACTERES_LINEA) {
        texto = `${texto.slice(0, MAXIMOS_CARACTERES_LINEA)}… [recortado]`;
    }

    return texto;
}

function describirArgumentoSeguro(argumento) {
    if (argumento instanceof Error) {
        return redactarTextoLog(
            argumento.stack || `${argumento.name}: ${argumento.message}`
        );
    }
    if (Buffer.isBuffer(argumento)) {
        return `[Buffer oculto: ${argumento.length} bytes]`;
    }
    if (
        argumento === null ||
        argumento === undefined ||
        ['string', 'number', 'boolean', 'bigint'].includes(typeof argumento)
    ) {
        return redactarTextoLog(argumento);
    }

    const nombre = argumento?.constructor?.name || 'objeto';
    return `[${redactarTextoLog(nombre)} omitido por seguridad]`;
}

function limpiarArchivosAntiguos(
    directorio,
    maximosArchivos = MAXIMOS_ARCHIVOS_PREDETERMINADOS,
    fsModule = fs
) {
    let archivos;
    try {
        archivos = fsModule.readdirSync(directorio, { withFileTypes: true })
            .filter(entrada =>
                entrada.isFile() &&
                /^zeroone-\d{4}-\d{2}-\d{2}\.log(?:\.\d+)?$/u.test(entrada.name)
            )
            .map(entrada => {
                const ruta = path.join(directorio, entrada.name);
                return {
                    ruta,
                    fecha: fsModule.statSync(ruta).mtimeMs
                };
            })
            .sort((a, b) => b.fecha - a.fecha);
    } catch {
        return;
    }

    for (const archivo of archivos.slice(Math.max(1, maximosArchivos))) {
        try {
            fsModule.unlinkSync(archivo.ruta);
        } catch {
            // Un registro bloqueado se conserva y se intentará limpiar al reiniciar.
        }
    }
}

function crearRegistradorLocal(opciones = {}) {
    const {
        directorio,
        version = '',
        tamanoMaximo = TAMANO_MAXIMO_PREDETERMINADO,
        maximosArchivos = MAXIMOS_ARCHIVOS_PREDETERMINADOS,
        fsModule = fs,
        ahora = () => new Date()
    } = opciones;
    const rutaDirectorio = path.resolve(String(directorio || ''));
    if (!directorio) throw new TypeError('La carpeta de logs es obligatoria.');

    fsModule.mkdirSync(rutaDirectorio, { recursive: true });
    limpiarArchivosAntiguos(rutaDirectorio, maximosArchivos, fsModule);

    let diaActual = fechaArchivo(ahora());
    let rutaActual = path.join(rutaDirectorio, `zeroone-${diaActual}.log`);
    let bytesActuales = fsModule.existsSync(rutaActual)
        ? fsModule.statSync(rutaActual).size
        : 0;

    function actualizarArchivoDiario() {
        const nuevoDia = fechaArchivo(ahora());
        if (nuevoDia === diaActual) return;
        diaActual = nuevoDia;
        rutaActual = path.join(rutaDirectorio, `zeroone-${diaActual}.log`);
        bytesActuales = fsModule.existsSync(rutaActual)
            ? fsModule.statSync(rutaActual).size
            : 0;
        limpiarArchivosAntiguos(rutaDirectorio, maximosArchivos, fsModule);
    }

    function rotarSiCorresponde(bytesNuevos) {
        if (bytesActuales + bytesNuevos <= Math.max(1024, tamanoMaximo)) return;

        for (let indice = maximosArchivos - 1; indice >= 1; indice -= 1) {
            const origen = indice === 1
                ? rutaActual
                : `${rutaActual}.${indice - 1}`;
            const destino = `${rutaActual}.${indice}`;
            if (!fsModule.existsSync(origen)) continue;
            try {
                if (fsModule.existsSync(destino)) fsModule.unlinkSync(destino);
                fsModule.renameSync(origen, destino);
            } catch {
                // Si Windows mantiene el archivo ocupado, se continúa sin perder el log.
            }
        }
        bytesActuales = fsModule.existsSync(rutaActual)
            ? fsModule.statSync(rutaActual).size
            : 0;
        limpiarArchivosAntiguos(rutaDirectorio, maximosArchivos, fsModule);
    }

    function registrar(nivel, argumentos = []) {
        try {
            actualizarArchivoDiario();
            const marca = ahora().toISOString();
            const contenido = (Array.isArray(argumentos) ? argumentos : [argumentos])
                .map(describirArgumentoSeguro)
                .join(' ');
            const linea = `[${marca}] [${String(nivel || 'INFO').toUpperCase()}] ${contenido}\r\n`;
            const bytes = Buffer.byteLength(linea);
            rotarSiCorresponde(bytes);
            fsModule.appendFileSync(rutaActual, linea, {
                encoding: 'utf8',
                mode: 0o600
            });
            bytesActuales += bytes;
        } catch {
            // Los fallos del registro nunca deben interrumpir ZeroOne.
        }
    }

    registrar('INFO', [
        `ZeroOne ${version || 'sin versión'} inició el registro de diagnóstico.`
    ]);

    return {
        directorio: rutaDirectorio,
        obtenerRutaActual: () => rutaActual,
        registrar
    };
}

function instalarCapturaConsola(registrador, consola = console) {
    if (!registrador || typeof registrador.registrar !== 'function') {
        return () => {};
    }

    const originales = new Map();
    const niveles = {
        log: 'INFO',
        info: 'INFO',
        warn: 'WARN',
        error: 'ERROR',
        debug: 'DEBUG'
    };

    for (const [metodo, nivel] of Object.entries(niveles)) {
        if (typeof consola[metodo] !== 'function') continue;
        const original = consola[metodo].bind(consola);
        originales.set(metodo, consola[metodo]);
        consola[metodo] = (...argumentos) => {
            original(...argumentos);
            registrador.registrar(nivel, argumentos);
        };
    }

    return () => {
        for (const [metodo, original] of originales) {
            consola[metodo] = original;
        }
    };
}

async function abrirDirectorioLogsSeguro(opciones = {}) {
    const {
        directorio,
        abrirRuta,
        fsModule = fs
    } = opciones;
    if (!directorio) throw new TypeError('La carpeta de logs no está configurada.');
    if (typeof abrirRuta !== 'function') {
        throw new TypeError('No se puede abrir la carpeta de logs.');
    }

    const ruta = path.resolve(String(directorio));
    fsModule.mkdirSync(ruta, { recursive: true });
    const error = await abrirRuta(ruta);
    if (error) {
        throw new Error(`Windows no pudo abrir la carpeta de logs: ${error}`);
    }
    return { correcto: true };
}

module.exports = {
    abrirDirectorioLogsSeguro,
    crearRegistradorLocal,
    describirArgumentoSeguro,
    instalarCapturaConsola,
    redactarTextoLog
};
