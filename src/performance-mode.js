'use strict';

const os = require('os');

const MODOS_RENDIMIENTO = new Set([
    'normal',
    'adaptativo',
    'ahorro'
]);

const LIMITES_RENDIMIENTO = Object.freeze({
    normal: Object.freeze({
        iniciosWhatsApp: 10,
        sincronizacionesAudiencia: 3
    }),
    reducido: Object.freeze({
        iniciosWhatsApp: 3,
        sincronizacionesAudiencia: 1
    })
});

const PORCENTAJE_LIBRE_ACTIVAR_REDUCCION = 20;
const PORCENTAJE_LIBRE_DESACTIVAR_REDUCCION = 30;
const INTERVALO_EVALUACION_MS = 10000;

function normalizarModoRendimiento(valor, respaldo = 'normal') {
    const normalizado = String(valor || '').trim().toLowerCase();
    return MODOS_RENDIMIENTO.has(normalizado)
        ? normalizado
        : respaldo;
}

function obtenerMemoriaSistema() {
    return {
        totalBytes: os.totalmem(),
        libreBytes: os.freemem()
    };
}

function normalizarMemoria(memoria = {}) {
    const totalBytes = Math.max(0, Number(memoria.totalBytes) || 0);
    const libreBytes = Math.min(
        totalBytes,
        Math.max(0, Number(memoria.libreBytes) || 0)
    );
    const porcentajeUso = totalBytes > 0
        ? Math.round((1 - (libreBytes / totalBytes)) * 1000) / 10
        : 0;

    return {
        memoriaLibreBytes: libreBytes,
        memoriaTotalBytes: totalBytes,
        porcentajeUso
    };
}

function crearControladorRendimiento(opciones = {}) {
    const obtenerModo = typeof opciones.obtenerModo === 'function'
        ? opciones.obtenerModo
        : () => 'normal';
    const obtenerMemoria = typeof opciones.obtenerMemoria === 'function'
        ? opciones.obtenerMemoria
        : obtenerMemoriaSistema;
    const onCambio = typeof opciones.onCambio === 'function'
        ? opciones.onCambio
        : () => {};
    const crearIntervalo = opciones.setInterval || setInterval;
    const limpiarIntervalo = opciones.clearInterval || clearInterval;
    const intervaloMs = Math.max(
        1000,
        Number(opciones.intervaloMs) || INTERVALO_EVALUACION_MS
    );

    let reducido = false;
    let modoAnterior = null;
    let temporizador = null;
    let estado = {
        modo: 'normal',
        reducido: false,
        motivo: 'Modo normal.',
        memoriaLibreBytes: 0,
        memoriaTotalBytes: 0,
        porcentajeUso: 0,
        limiteIniciosWhatsApp:
            LIMITES_RENDIMIENTO.normal.iniciosWhatsApp,
        limiteSincronizacionesAudiencia:
            LIMITES_RENDIMIENTO.normal.sincronizacionesAudiencia
    };

    function evaluar() {
        const modo = normalizarModoRendimiento(obtenerModo());
        const memoria = normalizarMemoria(obtenerMemoria());
        const porcentajeLibre = memoria.memoriaTotalBytes > 0
            ? (
                memoria.memoriaLibreBytes /
                memoria.memoriaTotalBytes
            ) * 100
            : 100;
        const reducidoAnterior = reducido;

        if (modo === 'ahorro') {
            reducido = true;
        } else if (modo === 'normal') {
            reducido = false;
        } else if (reducido) {
            reducido =
                porcentajeLibre < PORCENTAJE_LIBRE_DESACTIVAR_REDUCCION;
        } else {
            reducido =
                porcentajeLibre <= PORCENTAJE_LIBRE_ACTIVAR_REDUCCION;
        }

        let motivo = 'Modo normal.';
        if (modo === 'ahorro') {
            motivo = 'Ahorro de memoria activado manualmente.';
        } else if (modo === 'adaptativo' && reducido) {
            motivo = 'Presión de memoria detectada.';
        } else if (modo === 'adaptativo') {
            motivo = 'Recursos disponibles dentro del rango seguro.';
        }

        const limites = reducido
            ? LIMITES_RENDIMIENTO.reducido
            : LIMITES_RENDIMIENTO.normal;
        estado = {
            modo,
            reducido,
            motivo,
            ...memoria,
            limiteIniciosWhatsApp: limites.iniciosWhatsApp,
            limiteSincronizacionesAudiencia:
                limites.sincronizacionesAudiencia
        };

        if (modoAnterior !== modo || reducidoAnterior !== reducido) {
            modoAnterior = modo;
            onCambio({ ...estado });
        }

        return { ...estado };
    }

    function obtenerEstado() {
        return { ...estado };
    }

    function iniciar() {
        if (temporizador !== null) return obtenerEstado();
        const estadoInicial = evaluar();
        temporizador = crearIntervalo(evaluar, intervaloMs);
        temporizador?.unref?.();
        return estadoInicial;
    }

    function detener() {
        if (temporizador === null) return false;
        limpiarIntervalo(temporizador);
        temporizador = null;
        return true;
    }

    return {
        evaluar,
        obtenerEstado,
        iniciar,
        detener
    };
}

module.exports = {
    INTERVALO_EVALUACION_MS,
    LIMITES_RENDIMIENTO,
    MODOS_RENDIMIENTO,
    PORCENTAJE_LIBRE_ACTIVAR_REDUCCION,
    PORCENTAJE_LIBRE_DESACTIVAR_REDUCCION,
    crearControladorRendimiento,
    normalizarModoRendimiento
};
