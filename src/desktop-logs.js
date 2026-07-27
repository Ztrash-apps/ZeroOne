'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TAMANO_MAXIMO_PREDETERMINADO = 5 * 1024 * 1024;
const MAXIMOS_CARACTERES_LINEA = 12000;

function fechaArchivo(ahora = new Date()) {
    return ahora.toISOString().slice(0, 10);
}

function horaArchivo(ahora = new Date()) {
    return ahora.toISOString().slice(11, 19).replace(/:/gu, '-');
}

function normalizarVersionArchivo(version) {
    const segura = String(version || 'sin-version')
        .trim()
        .replace(/[^a-z0-9._-]+/giu, '-')
        .replace(/^-+|-+$/gu, '');
    return segura || 'sin-version';
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

function crearRegistradorLocal(opciones = {}) {
    const {
        directorio,
        version = '',
        tamanoMaximo = TAMANO_MAXIMO_PREDETERMINADO,
        fsModule = fs,
        ahora = () => new Date()
    } = opciones;
    const rutaDirectorio = path.resolve(String(directorio || ''));
    if (!directorio) throw new TypeError('La carpeta de logs es obligatoria.');

    fsModule.mkdirSync(rutaDirectorio, { recursive: true });

    const versionArchivo = normalizarVersionArchivo(version);
    let diaActual = fechaArchivo(ahora());
    let rutaActual = path.join(
        rutaDirectorio,
        `zeroone-v${versionArchivo}-${diaActual}.log`
    );
    let bytesActuales = fsModule.existsSync(rutaActual)
        ? fsModule.statSync(rutaActual).size
        : 0;

    function rutaUnica(sufijo, fecha = ahora()) {
        const base = `zeroone-v${versionArchivo}-${fechaArchivo(fecha)}-${sufijo}`;
        let indice = 1;
        let candidata = path.join(rutaDirectorio, `${base}.log`);

        while (fsModule.existsSync(candidata)) {
            indice += 1;
            candidata = path.join(
                rutaDirectorio,
                `${base}-${indice}.log`
            );
        }

        return candidata;
    }

    function activarRuta(ruta) {
        rutaActual = ruta;
        bytesActuales = fsModule.existsSync(rutaActual)
            ? fsModule.statSync(rutaActual).size
            : 0;
    }

    function seleccionarDestinoRegistro(bytesNuevos, fecha) {
        const nuevoDia = fechaArchivo(fecha);
        if (nuevoDia !== diaActual) {
            return {
                ruta: path.join(
                    rutaDirectorio,
                    `zeroone-v${versionArchivo}-${nuevoDia}.log`
                ),
                dia: nuevoDia,
                exclusivo: false
            };
        }
        if (bytesActuales + bytesNuevos > Math.max(1024, tamanoMaximo)) {
            return {
                ruta: rutaUnica(`parte-${horaArchivo(fecha)}`, fecha),
                dia: nuevoDia,
                exclusivo: true
            };
        }
        return {
            ruta: rutaActual,
            dia: diaActual,
            exclusivo: false
        };
    }

    function construirLineaRegistro(nivel, argumentos, fecha = ahora()) {
        const contenido = (Array.isArray(argumentos) ? argumentos : [argumentos])
            .map(describirArgumentoSeguro)
            .join(' ');
        return (
            `[${fecha.toISOString()}] ` +
            `[${String(nivel || 'INFO').toUpperCase()}] ${contenido}\r\n`
        );
    }

    function crearArchivoRegistro(ruta, mensaje, fecha) {
        const linea = construirLineaRegistro('INFO', [mensaje], fecha);
        fsModule.appendFileSync(ruta, linea, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600
        });
    }

    function registrar(nivel, argumentos = []) {
        try {
            const fecha = ahora();
            const linea = construirLineaRegistro(nivel, argumentos, fecha);
            const bytes = Buffer.byteLength(linea);
            const destino = seleccionarDestinoRegistro(bytes, fecha);
            try {
                fsModule.appendFileSync(destino.ruta, linea, {
                    encoding: 'utf8',
                    flag: destino.exclusivo ? 'wx' : 'a',
                    mode: 0o600
                });
                if (destino.ruta === rutaActual) {
                    bytesActuales += bytes;
                } else {
                    diaActual = destino.dia;
                    activarRuta(destino.ruta);
                }
            } catch (error) {
                if (destino.ruta === rutaActual) throw error;

                // Si Windows impide crear la nueva parte, conservar el
                // registro es más importante que respetar momentáneamente el
                // límite de tamaño. La próxima entrada volverá a intentar.
                fsModule.appendFileSync(rutaActual, linea, {
                    encoding: 'utf8',
                    mode: 0o600
                });
                bytesActuales += bytes;
            }
        } catch {
            // Los fallos del registro nunca deben interrumpir ZeroOne.
        }
    }

    function crearNuevoRegistro() {
        const fecha = ahora();
        const rutaNueva = rutaUnica(`nuevo-${horaArchivo(fecha)}`, fecha);
        crearArchivoRegistro(
            rutaNueva,
            `ZeroOne ${version || 'sin versión'} inició un nuevo registro de diagnóstico por solicitud del usuario.`,
            fecha
        );
        diaActual = fechaArchivo(fecha);
        activarRuta(rutaNueva);
        return {
            correcto: true,
            archivo: path.basename(rutaActual)
        };
    }

    function leerRegistroActual() {
        if (!fsModule.existsSync(rutaActual)) return '';
        return fsModule.readFileSync(rutaActual, 'utf8');
    }

    function eliminarRegistroActual() {
        const rutaEliminada = rutaActual;
        const archivoEliminado = path.basename(rutaEliminada);
        const fecha = ahora();
        const rutaNueva = rutaUnica(`nuevo-${horaArchivo(fecha)}`, fecha);
        crearArchivoRegistro(
            rutaNueva,
            `ZeroOne ${version || 'sin versión'} inició un registro de diagnóstico después de eliminar el anterior.`,
            fecha
        );

        try {
            if (fsModule.existsSync(rutaEliminada)) {
                fsModule.unlinkSync(rutaEliminada);
            }
        } catch (error) {
            try {
                fsModule.unlinkSync(rutaNueva);
            } catch {
                // El archivo nuevo no contiene datos previos y puede quedar
                // como respaldo si Windows impide retirarlo.
            }
            throw error;
        }

        diaActual = fechaArchivo(fecha);
        activarRuta(rutaNueva);

        return {
            correcto: true,
            archivoEliminado,
            archivo: path.basename(rutaActual)
        };
    }

    registrar('INFO', [
        `ZeroOne ${version || 'sin versión'} inició el registro de diagnóstico.`
    ]);

    return {
        directorio: rutaDirectorio,
        crearNuevoRegistro,
        eliminarRegistroActual,
        leerRegistroActual,
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
