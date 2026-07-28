'use strict';

const fs = require('fs');
const path = require('path');

const ERRORES_FSYNC_IGNORABLES = new Set([
    'EINVAL',
    'ENOTSUP',
    'ENOSYS',
    'EPERM'
]);

function errorSeguro(error) {
    return {
        codigo: String(error?.code || 'JSON_INVALIDO'),
        mensaje: String(error?.message || error || 'Error desconocido')
    };
}

function validarConPredicado(valor, validar) {
    try {
        return validar(valor) === true;
    } catch {
        return false;
    }
}

function serializarValidado(valor, validar, espacios) {
    if (!validarConPredicado(valor, validar)) {
        throw new TypeError('El valor no cumple la validación requerida.');
    }

    const json = JSON.stringify(valor, null, espacios);
    if (typeof json !== 'string') {
        throw new TypeError('El valor no se puede representar como JSON.');
    }

    const datosSerializados = JSON.parse(json);
    if (!validarConPredicado(datosSerializados, validar)) {
        throw new TypeError(
            'El valor deja de ser válido después de serializarse como JSON.'
        );
    }

    return {
        datos: datosSerializados,
        contenido: `${json}\n`
    };
}

function fsyncPermitido(descriptor) {
    try {
        fs.fsyncSync(descriptor);
    } catch (error) {
        if (!ERRORES_FSYNC_IGNORABLES.has(error?.code)) throw error;
    }
}

function fsyncDirectorioPermitido(ruta) {
    let descriptor = null;
    try {
        descriptor = fs.openSync(path.dirname(ruta), 'r');
        fsyncPermitido(descriptor);
    } catch (error) {
        if (!ERRORES_FSYNC_IGNORABLES.has(error?.code)) throw error;
    } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
    }
}

function fsyncDirectorioMejorEsfuerzo(ruta) {
    try {
        fsyncDirectorioPermitido(ruta);
    } catch {
        // El reemplazo ya es válido. Un sistema que no permite sincronizar
        // directorios no debe convertirlo en un falso fallo de rename.
    }
}

function escribirTemporalSincronizado(rutaTemporal, contenido) {
    fs.mkdirSync(path.dirname(rutaTemporal), { recursive: true });
    let descriptor = null;
    try {
        descriptor = fs.openSync(rutaTemporal, 'w', 0o600);
        fs.writeFileSync(descriptor, contenido, 'utf8');
        fsyncPermitido(descriptor);
    } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
    }
}

function reemplazarConTemporal(rutaTemporal, destino) {
    try {
        fs.renameSync(rutaTemporal, destino);
        fsyncDirectorioMejorEsfuerzo(destino);
        return;
    } catch (error) {
        if (
            !fs.existsSync(destino) ||
            !['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)
        ) {
            throw error;
        }
    }

    const desplazado =
        `${destino}.previous-${process.pid}-${Date.now()}`;
    fs.renameSync(destino, desplazado);
    try {
        fs.renameSync(rutaTemporal, destino);
        fsyncDirectorioMejorEsfuerzo(destino);
        fs.rmSync(desplazado, { force: true });
    } catch (error) {
        if (!fs.existsSync(destino) && fs.existsSync(desplazado)) {
            try {
                fs.renameSync(desplazado, destino);
            } catch {
                // Se deja el archivo desplazado intacto para recuperación manual.
            }
        }
        throw error;
    }
}

function conservarCandidataInvalida(candidata) {
    if (
        !candidata?.existe ||
        candidata.valida ||
        !fs.existsSync(candidata.ruta)
    ) {
        return null;
    }

    const destino =
        `${candidata.ruta}.corrupto-` +
        `${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
        fs.renameSync(candidata.ruta, destino);
        return {
            fuente: candidata.fuente,
            ruta: destino,
            error: null
        };
    } catch (error) {
        return {
            fuente: candidata.fuente,
            ruta: null,
            error: errorSeguro(error)
        };
    }
}

function escribirAtomico(ruta, rutaTemporal, contenido) {
    escribirTemporalSincronizado(rutaTemporal, contenido);
    reemplazarConTemporal(rutaTemporal, ruta);
}

function leerCandidata(ruta, fuente, validar) {
    if (!fs.existsSync(ruta)) {
        return {
            fuente,
            ruta,
            existe: false,
            valida: false,
            datos: undefined,
            error: null
        };
    }

    try {
        const contenido = fs.readFileSync(ruta, 'utf8');
        if (contenido.includes('\0')) {
            const error = new SyntaxError(
                'El archivo contiene bytes NUL y no es JSON válido.'
            );
            error.code = 'JSON_NUL';
            throw error;
        }

        const datos = JSON.parse(
            contenido.charCodeAt(0) === 0xfeff
                ? contenido.slice(1)
                : contenido
        );
        if (!validarConPredicado(datos, validar)) {
            const error = new TypeError(
                'El contenido JSON no cumple la validación requerida.'
            );
            error.code = 'JSON_VALIDACION';
            throw error;
        }

        return {
            fuente,
            ruta,
            existe: true,
            valida: true,
            datos,
            error: null
        };
    } catch (error) {
        return {
            fuente,
            ruta,
            existe: true,
            valida: false,
            datos: undefined,
            error: errorSeguro(error)
        };
    }
}

function crearAlmacenJsonSeguro({
    ruta,
    validar = () => true,
    espacios = 2
} = {}) {
    if (typeof ruta !== 'string' || !ruta.trim()) {
        throw new TypeError('Se requiere una ruta de archivo JSON.');
    }
    if (typeof validar !== 'function') {
        throw new TypeError('La validación debe ser una función.');
    }
    if (!Number.isInteger(espacios) || espacios < 0 || espacios > 10) {
        throw new TypeError('Los espacios JSON deben ser un entero entre 0 y 10.');
    }

    const principal = path.resolve(ruta);
    const temporal = `${principal}.tmp`;
    const respaldo = `${principal}.bak`;
    const temporalRespaldo = `${respaldo}.tmp`;
    const rutas = Object.freeze({
        principal,
        temporal,
        respaldo
    });

    function leerEstadoActual() {
        return {
            principal: leerCandidata(principal, 'principal', validar),
            temporal: leerCandidata(temporal, 'temporal', validar),
            respaldo: leerCandidata(respaldo, 'respaldo', validar)
        };
    }

    function escribirRespaldoValidado(datos) {
        const serializado = serializarValidado(datos, validar, espacios);
        escribirAtomico(
            respaldo,
            temporalRespaldo,
            serializado.contenido
        );

        const comprobacion = leerCandidata(
            respaldo,
            'respaldo',
            validar
        );
        if (!comprobacion.valida) {
            const error = new Error(
                'El respaldo escrito no superó la validación posterior.'
            );
            error.code = 'RESPALDO_INVALIDO';
            throw error;
        }
    }

    function guardar(datos) {
        const serializado = serializarValidado(datos, validar, espacios);
        fs.mkdirSync(path.dirname(principal), { recursive: true });

        const actual = leerEstadoActual();
        let respaldoActualizado = false;

        if (actual.principal.valida) {
            escribirRespaldoValidado(actual.principal.datos);
            respaldoActualizado = true;
        } else if (!actual.respaldo.valida) {
            escribirRespaldoValidado(serializado.datos);
            respaldoActualizado = true;
        }

        escribirAtomico(
            principal,
            temporal,
            serializado.contenido
        );

        return {
            ruta: principal,
            respaldoActualizado
        };
    }

    function guardarEspejado(datos) {
        const resultado = guardar(datos);
        const comprobacionPrincipal = leerCandidata(
            principal,
            'principal',
            validar
        );
        if (!comprobacionPrincipal.valida) {
            const error = new Error(
                'El archivo principal escrito no superó la validación posterior.'
            );
            error.code = 'PRINCIPAL_INVALIDO';
            throw error;
        }

        // En puntos de no retorno (por ejemplo, justo antes de enviar) el
        // respaldo debe contener la misma revisión que el principal. Si este
        // paso no termina, el llamador no debe ejecutar la operación externa.
        escribirRespaldoValidado(comprobacionPrincipal.datos);
        return {
            ...resultado,
            respaldoEspejado: true
        };
    }

    function cargar(predeterminado) {
        if (!validarConPredicado(predeterminado, validar)) {
            throw new TypeError(
                'El valor predeterminado no cumple la validación requerida.'
            );
        }

        const estado = leerEstadoActual();
        const errores = Object.values(estado)
            .filter(candidata => candidata.existe && !candidata.valida)
            .map(candidata => ({
                fuente: candidata.fuente,
                ...candidata.error
            }));

        if (estado.principal.valida) {
            const archivosCorruptos = [];
            for (const candidata of [
                estado.temporal,
                estado.respaldo
            ]) {
                const conservada = conservarCandidataInvalida(candidata);
                if (!conservada) continue;
                if (conservada.ruta) {
                    archivosCorruptos.push(conservada);
                } else if (conservada.error) {
                    errores.push({
                        fuente: `conservacion_${conservada.fuente}`,
                        ...conservada.error
                    });
                }
            }

            if (!estado.respaldo.valida) {
                try {
                    escribirRespaldoValidado(estado.principal.datos);
                } catch (error) {
                    errores.push({
                        fuente: 'respaldo',
                        ...errorSeguro(error)
                    });
                }
            }

            if (fs.existsSync(temporal)) {
                try {
                    fs.rmSync(temporal, { force: true });
                } catch {
                    // El principal válido siempre tiene prioridad sobre un .tmp.
                }
            }

            return {
                datos: estado.principal.datos,
                fuente: 'principal',
                recuperado: false,
                errores,
                archivosCorruptos
            };
        }

        const recuperable = estado.temporal.valida
            ? estado.temporal
            : estado.respaldo.valida
                ? estado.respaldo
                : null;

        if (recuperable) {
            let recuperado = false;
            const archivosCorruptos = [];
            for (const candidata of Object.values(estado)) {
                const conservada = conservarCandidataInvalida(candidata);
                if (!conservada) continue;
                if (conservada.ruta) {
                    archivosCorruptos.push(conservada);
                } else if (conservada.error) {
                    errores.push({
                        fuente: `conservacion_${conservada.fuente}`,
                        ...conservada.error
                    });
                }
            }
            try {
                guardarEspejado(recuperable.datos);
                recuperado = true;
            } catch (error) {
                errores.push({
                    fuente: 'restauracion',
                    ...errorSeguro(error)
                });
            }

            return {
                datos: recuperable.datos,
                fuente: recuperable.fuente,
                recuperado,
                errores,
                archivosCorruptos
            };
        }

        return {
            datos: predeterminado,
            fuente: 'predeterminado',
            recuperado: false,
            errores
        };
    }

    return Object.freeze({
        rutas,
        cargar,
        guardar,
        guardarEspejado
    });
}

module.exports = {
    crearAlmacenJsonSeguro
};
