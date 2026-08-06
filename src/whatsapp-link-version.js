'use strict';

const https = require('node:https');

const URL_VERSION_WHATSAPP = 'https://web.whatsapp.com/sw.js';
const TIEMPO_MAXIMO_PREDETERMINADO_MS = 7000;
const VIGENCIA_CACHE_PREDETERMINADA_MS = 15 * 60 * 1000;
const ENFRIAMIENTO_FALLO_PREDETERMINADO_MS = 60 * 1000;
const MAXIMOS_BYTES_RESPUESTA = 2 * 1024 * 1024;
const CABECERAS_WHATSAPP = {
    'sec-fetch-site': 'none',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
};

function normalizarVersion(valor) {
    if (!Array.isArray(valor) || valor.length !== 3) return null;

    const version = valor.map(Number);
    return version.every(numero =>
        Number.isSafeInteger(numero) && numero > 0
    )
        ? version
        : null;
}

function extraerVersionDesdeServiceWorker(contenido) {
    const coincidencia = String(contenido || '')
        .match(/\\?"client_revision\\?":\s*(\d+)/u);
    if (!coincidencia?.[1]) return null;

    return normalizarVersion([2, 3000, Number(coincidencia[1])]);
}

function crearError(mensaje) {
    return new Error(mensaje);
}

/**
 * Consulta opcional de version para vinculos QR.
 *
 * Esta deliberadamente aislada de Undici/fetch y no propaga rechazos: la
 * conexion QR siempre puede usar la version incluida por Baileys si la red
 * remota falla, tarda o corta su socket TLS.
 */
function crearProveedorVersionVinculacionWhatsApp(opciones = {}) {
    const solicitar = typeof opciones.solicitar === 'function'
        ? opciones.solicitar
        : https.request;
    const ahora = typeof opciones.ahora === 'function'
        ? opciones.ahora
        : () => Date.now();
    const timeoutMs = Number.isFinite(Number(opciones.timeoutMs))
        ? Math.max(50, Number(opciones.timeoutMs))
        : TIEMPO_MAXIMO_PREDETERMINADO_MS;
    const cacheTtlMs = Number.isFinite(Number(opciones.cacheTtlMs))
        ? Math.max(0, Number(opciones.cacheTtlMs))
        : VIGENCIA_CACHE_PREDETERMINADA_MS;
    const enfriamientoFalloMs = Number.isFinite(
        Number(opciones.enfriamientoFalloMs)
    )
        ? Math.max(0, Number(opciones.enfriamientoFalloMs))
        : ENFRIAMIENTO_FALLO_PREDETERMINADO_MS;
    const alFallar = typeof opciones.alFallar === 'function'
        ? opciones.alFallar
        : () => {};

    let version = null;
    let versionObtenidaEn = 0;
    let proximoIntentoEn = 0;
    let promesaEnCurso = null;

    function avisarFallo(error) {
        try {
            alFallar(error);
        } catch {
            // A diagnostic callback must never break a QR connection.
        }
    }

    function obtenerVersionEnCache() {
        if (
            version &&
            ahora() - versionObtenidaEn <= cacheTtlMs
        ) {
            return [...version];
        }
        return null;
    }

    function consultarRemotamente() {
        return new Promise(resolve => {
            let terminada = false;
            let solicitud = null;
            let temporizador = null;

            const finalizar = resultado => {
                if (terminada) return;
                terminada = true;
                if (temporizador) clearTimeout(temporizador);
                resolve(resultado);
            };
            const fallar = error => finalizar({
                version: null,
                error: error instanceof Error
                    ? error
                    : crearError(String(error || 'La consulta de version fallo.'))
            });

            try {
                solicitud = solicitar(
                    URL_VERSION_WHATSAPP,
                    {
                        method: 'GET',
                        headers: CABECERAS_WHATSAPP
                    },
                    respuesta => {
                        let bytes = 0;
                        const partes = [];
                        const estado = Number(respuesta?.statusCode) || 0;

                        respuesta.once?.('error', fallar);
                        respuesta.once?.('aborted', () => fallar(
                            crearError('La respuesta de version se interrumpio.')
                        ));
                        respuesta.on?.('data', parte => {
                            try {
                                if (terminada) return;
                                const texto = String(parte);
                                bytes += Buffer.byteLength(texto);
                                if (bytes > MAXIMOS_BYTES_RESPUESTA) {
                                    const error = crearError(
                                        'La respuesta de version excedio el limite seguro.'
                                    );
                                    fallar(error);
                                    try {
                                        solicitud?.destroy?.(error);
                                    } catch {
                                        // The request may already be closed.
                                    }
                                    return;
                                }
                                partes.push(texto);
                            } catch (error) {
                                fallar(error);
                            }
                        });
                        respuesta.once?.('end', () => {
                            try {
                                if (terminada) return;
                                if (estado < 200 || estado >= 300) {
                                    fallar(
                                        crearError(
                                            `WhatsApp respondio HTTP ${estado || 'desconocido'} al consultar la version.`
                                        )
                                    );
                                    return;
                                }

                                const obtenida = extraerVersionDesdeServiceWorker(
                                    partes.join('')
                                );
                                if (!obtenida) {
                                    fallar(
                                        crearError(
                                            'WhatsApp no entrego una revision de protocolo valida.'
                                        )
                                    );
                                    return;
                                }
                                finalizar({ version: obtenida, error: null });
                            } catch (error) {
                                fallar(error);
                            }
                        });
                    }
                );

                solicitud.once?.('error', fallar);
                temporizador = setTimeout(() => {
                    const error = crearError(
                        'La consulta de version supero el tiempo disponible.'
                    );
                    // Resolve before destroying. The request already has an
                    // error listener, so a late socket close stays contained.
                    fallar(error);
                    try {
                        solicitud?.destroy?.(error);
                    } catch {
                        // The request may already be closed.
                    }
                }, timeoutMs);
                temporizador.unref?.();
                solicitud.end?.();
            } catch (error) {
                fallar(error);
            }
        });
    }

    function actualizarEnSegundoPlano({ forzar = false } = {}) {
        const cache = obtenerVersionEnCache();
        if (promesaEnCurso) return promesaEnCurso;
        if (!forzar && cache) return Promise.resolve(cache);
        if (!forzar && ahora() < proximoIntentoEn) {
            return Promise.resolve(cache);
        }

        promesaEnCurso = consultarRemotamente()
            .then(resultado => {
                if (resultado?.version) {
                    version = resultado.version;
                    versionObtenidaEn = ahora();
                    proximoIntentoEn = 0;
                    return [...version];
                }

                proximoIntentoEn = ahora() + enfriamientoFalloMs;
                avisarFallo(resultado?.error);
                return obtenerVersionEnCache();
            })
            .catch(error => {
                // consultarRemotamente resolves all transport failures. This
                // extra barrier protects the Electron main process from a
                // future regression in the optional lookup.
                proximoIntentoEn = ahora() + enfriamientoFalloMs;
                avisarFallo(error);
                return obtenerVersionEnCache();
            })
            .finally(() => {
                promesaEnCurso = null;
            });

        return promesaEnCurso;
    }

    return {
        obtenerVersionEnCache,
        actualizarEnSegundoPlano
    };
}

module.exports = {
    CABECERAS_WHATSAPP,
    URL_VERSION_WHATSAPP,
    crearProveedorVersionVinculacionWhatsApp,
    extraerVersionDesdeServiceWorker,
    normalizarVersion
};
