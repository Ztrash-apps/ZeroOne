'use strict';

function normalizarEntero(valor, respaldo, minimo, maximo) {
    const numero = Number(valor);
    if (!Number.isFinite(numero)) return respaldo;
    return Math.min(maximo, Math.max(minimo, Math.round(numero)));
}

function crearEstadoPreparacionInicial() {
    return {
        activa: false,
        completada: false,
        total: 0,
        procesadas: 0,
        listas: 0,
        omitidas: 0,
        loteActual: 0,
        totalLotes: 0,
        lineasLote: [],
        iniciadaEn: null,
        finalizadaEn: null,
        mensaje: 'La preparacion inicial todavia no comenzo.'
    };
}

function copiarEstado(estado) {
    const total = Math.max(0, Number(estado.total) || 0);
    const procesadas = Math.min(total, Math.max(0, Number(estado.procesadas) || 0));

    return {
        ...estado,
        lineasLote: Array.isArray(estado.lineasLote)
            ? estado.lineasLote.map(linea => ({ ...linea }))
            : [],
        porcentaje: total > 0
            ? Math.min(100, Math.round((procesadas / total) * 100))
            : estado.completada
                ? 100
                : 0
    };
}

function crearCoordinadorSincronizacionInicial({
    tamanoLote = 10,
    procesarLinea,
    alActualizar = () => {},
    ahora = () => Date.now()
} = {}) {
    if (typeof procesarLinea !== 'function') {
        throw new TypeError('procesarLinea debe ser una funcion.');
    }

    const tamano = normalizarEntero(tamanoLote, 10, 1, 50);
    let estado = crearEstadoPreparacionInicial();
    let ejecucion = null;

    const publicarEstado = cambios => {
        estado = {
            ...estado,
            ...cambios
        };
        const vista = copiarEstado(estado);
        alActualizar(vista);
        return vista;
    };

    const ejecutar = lineas => {
        if (ejecucion) return ejecucion;

        const pendientes = Array.isArray(lineas) ? [...lineas] : [];
        ejecucion = (async () => {
            publicarEstado({
                activa: true,
                completada: false,
                total: pendientes.length,
                procesadas: 0,
                listas: 0,
                omitidas: 0,
                loteActual: 0,
                totalLotes: Math.ceil(pendientes.length / tamano),
                lineasLote: [],
                iniciadaEn: new Date(ahora()).toISOString(),
                finalizadaEn: null,
                mensaje: pendientes.length
                    ? 'Preparando conexiones y audiencias por tandas.'
                    : 'No hay lineas guardadas que preparar.'
            });

            for (let inicio = 0; inicio < pendientes.length; inicio += tamano) {
                const lote = pendientes.slice(inicio, inicio + tamano);
                const numeroLote = Math.floor(inicio / tamano) + 1;

                publicarEstado({
                    loteActual: numeroLote,
                    lineasLote: lote.map(linea => ({
                        id: linea?.id || null,
                        nombre: String(linea?.nombre || 'Linea sin nombre'),
                        estado: 'preparando'
                    })),
                    mensaje:
                        `Preparando tanda ${numeroLote} de ` +
                        `${Math.ceil(pendientes.length / tamano)}.`
                });

                const resultados = await Promise.all(lote.map(async linea => {
                    try {
                        const resultado = await procesarLinea(linea);
                        return {
                            id: linea?.id || null,
                            nombre: String(linea?.nombre || 'Linea sin nombre'),
                            lista: resultado?.lista === true,
                            estado: String(resultado?.estado || (
                                resultado?.lista === true ? 'lista' : 'omitida'
                            ))
                        };
                    } catch (error) {
                        return {
                            id: linea?.id || null,
                            nombre: String(linea?.nombre || 'Linea sin nombre'),
                            lista: false,
                            estado: 'error',
                            error: String(error?.message || error)
                        };
                    }
                }));

                const listasLote = resultados.filter(item => item.lista).length;
                publicarEstado({
                    procesadas: estado.procesadas + lote.length,
                    listas: estado.listas + listasLote,
                    omitidas: estado.omitidas + lote.length - listasLote,
                    lineasLote: resultados
                });
            }

            return publicarEstado({
                activa: false,
                completada: true,
                lineasLote: [],
                finalizadaEn: new Date(ahora()).toISOString(),
                mensaje: pendientes.length
                    ? `Preparacion terminada: ${estado.listas} lista(s) y ` +
                        `${estado.omitidas} pendiente(s) de atencion.`
                    : 'Preparacion terminada.'
            });
        })().finally(() => {
            ejecucion = null;
        });

        return ejecucion;
    };

    return {
        ejecutar,
        obtenerEstado: () => copiarEstado(estado),
        estaActiva: () => estado.activa === true
    };
}

module.exports = {
    crearCoordinadorSincronizacionInicial,
    crearEstadoPreparacionInicial
};
