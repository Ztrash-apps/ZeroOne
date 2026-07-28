'use strict';

const VERSION_CHECKPOINT_PUBLICACION = 1;
const VERSION_SNAPSHOT_PUBLICACION = 1;
const ESTADO_INTERRUPCION_REINICIO = 'interrumpido_reinicio';
const CODIGO_INTERRUPCION_REINICIO = 'REINICIO_APLICACION';
const CODIGO_ENVIO_INCIERTO_REINICIO = 'REINICIO_ENVIO_INCIERTO';
const FASES_LINEA_EN_CURSO = new Set(['preparacion', 'envio']);

function texto(valor) {
    return String(valor || '').trim();
}

function fechaIso(valor = new Date()) {
    const fecha = valor instanceof Date ? valor : new Date(valor);
    if (!Number.isFinite(fecha.getTime())) {
        throw new TypeError('La fecha del checkpoint no es válida.');
    }
    return fecha.toISOString();
}

function idsUnicos(valores) {
    const resultado = [];
    const vistos = new Set();

    for (const valor of Array.isArray(valores) ? valores : []) {
        const id = texto(valor);
        if (!id || vistos.has(id)) continue;
        vistos.add(id);
        resultado.push(id);
    }

    return resultado;
}

function copiarLinea(linea) {
    return linea && typeof linea === 'object'
        ? { ...linea }
        : linea;
}

function copiarCheckpoint(checkpoint) {
    if (!checkpoint || typeof checkpoint !== 'object') return null;

    return {
        ...checkpoint,
        lineaEnCurso: checkpoint.lineaEnCurso
            ? { ...checkpoint.lineaEnCurso }
            : null,
        idsPendientesSeguros: idsUnicos(
            checkpoint.idsPendientesSeguros
        ),
        ultimaLineaDefinitiva: checkpoint.ultimaLineaDefinitiva
            ? { ...checkpoint.ultimaLineaDefinitiva }
            : null
    };
}

function copiarRegistro(registro) {
    if (!registro || typeof registro !== 'object') {
        throw new TypeError('El registro de publicación no es válido.');
    }

    return {
        ...registro,
        idsLineas: idsUnicos(registro.idsLineas),
        lineasCorrectas: (Array.isArray(registro.lineasCorrectas)
            ? registro.lineasCorrectas
            : []).map(copiarLinea),
        lineasFallidas: (Array.isArray(registro.lineasFallidas)
            ? registro.lineasFallidas
            : []).map(copiarLinea),
        checkpointPublicacion: copiarCheckpoint(
            registro.checkpointPublicacion
        ),
        recuperacionReinicio:
            registro.recuperacionReinicio &&
            typeof registro.recuperacionReinicio === 'object'
                ? {
                    ...registro.recuperacionReinicio,
                    confirmadasDesdeEstadosActivos: idsUnicos(
                        registro.recuperacionReinicio
                            .confirmadasDesdeEstadosActivos
                    ),
                    idsPendientesSeguros: idsUnicos(
                        registro.recuperacionReinicio
                            .idsPendientesSeguros
                    ),
                    idsEnvioIncierto: idsUnicos(
                        registro.recuperacionReinicio
                            .idsEnvioIncierto
                    )
                }
                : null
    };
}

function idLineaDeResultado(resultado) {
    return texto(resultado?.id || resultado?.lineaId);
}

function descripcionLinea(linea, respaldoId = '') {
    const id = texto(linea?.id || linea?.lineaId || respaldoId);
    if (!id) {
        throw new TypeError('La línea del checkpoint no tiene ID.');
    }

    return {
        id,
        nombre: texto(linea?.nombre) || id,
        numero: linea?.numero ? String(linea.numero) : null
    };
}

function idsResultadosDefinitivos(registro) {
    const ids = [];

    for (const linea of registro.lineasCorrectas || []) {
        const id = idLineaDeResultado(linea);
        if (id) ids.push(id);
    }

    for (const linea of registro.lineasFallidas || []) {
        const id = idLineaDeResultado(linea);
        if (
            id &&
            linea?.envioConfirmado === false &&
            linea?.envioIncierto === false
        ) {
            ids.push(id);
        }
    }

    return new Set(idsUnicos(ids));
}

function recalcularContadores(registro) {
    const idsCorrectos = new Set(
        registro.lineasCorrectas.map(idLineaDeResultado).filter(Boolean)
    );
    const fallosSinDuplicar = registro.lineasFallidas.filter(linea => {
        const id = idLineaDeResultado(linea);
        return id && !idsCorrectos.has(id);
    });
    const idsNoProcesados = new Set(
        fallosSinDuplicar
            .filter(linea => linea?.fase === 'no_procesada')
            .map(idLineaDeResultado)
            .filter(Boolean)
    );
    const idsFallidos = new Set(
        fallosSinDuplicar
            .filter(linea => linea?.fase !== 'no_procesada')
            .map(idLineaDeResultado)
            .filter(Boolean)
    );

    registro.lineasFallidas = fallosSinDuplicar;
    registro.total = Number.isFinite(Number(registro.total))
        ? Number(registro.total)
        : registro.idsLineas.length;
    registro.correctas = idsCorrectos.size;
    registro.fallidas = idsFallidos.size;
    registro.noProcesadas = idsNoProcesados.size;
    return registro;
}

function crearCheckpointPublicacion(registro, fecha = new Date()) {
    const copia = copiarRegistro(registro);
    const resueltas = idsResultadosDefinitivos(copia);

    copia.checkpointPublicacion = {
        version: VERSION_CHECKPOINT_PUBLICACION,
        creadoEn: fechaIso(fecha),
        actualizadoEn: fechaIso(fecha),
        lineaEnCurso: null,
        idsPendientesSeguros: copia.idsLineas.filter(id => !resueltas.has(id)),
        ultimaLineaDefinitiva: null
    };

    return recalcularContadores(copia);
}

function crearSnapshotPublicacionActiva(registro) {
    const copia = copiarRegistro(registro);
    const checkpoint = exigirCheckpoint(copia);
    const publicacionId = texto(copia.id);

    if (!publicacionId) {
        throw new TypeError('La publicación del snapshot no tiene ID.');
    }

    return {
        version: VERSION_SNAPSHOT_PUBLICACION,
        publicacionId,
        fechaInicio: copia.fechaInicio || null,
        actualizadoEn: checkpoint.actualizadoEn,
        checkpointPublicacion: copiarCheckpoint(checkpoint),
        lineasCorrectas: copia.lineasCorrectas.map(copiarLinea),
        lineasFallidas: copia.lineasFallidas.map(copiarLinea)
    };
}

function aplicarSnapshotPublicacionActiva(registro, snapshot) {
    const copia = copiarRegistro(registro);
    if (
        !snapshot ||
        typeof snapshot !== 'object' ||
        snapshot.version !== VERSION_SNAPSHOT_PUBLICACION
    ) {
        throw new TypeError(
            'El snapshot de publicación activa no es compatible.'
        );
    }

    const publicacionId = texto(snapshot.publicacionId);
    if (!publicacionId || publicacionId !== texto(copia.id)) {
        throw new Error(
            'El snapshot no pertenece al registro de publicación indicado.'
        );
    }

    const checkpoint = copiarCheckpoint(snapshot.checkpointPublicacion);
    if (
        !checkpoint ||
        checkpoint.version !== VERSION_CHECKPOINT_PUBLICACION
    ) {
        throw new Error(
            'El snapshot no contiene un checkpoint compatible.'
        );
    }

    const correctasPorId = new Map();
    for (const correcta of [
        ...copia.lineasCorrectas,
        ...(Array.isArray(snapshot.lineasCorrectas)
            ? snapshot.lineasCorrectas
            : [])
    ]) {
        const id = idLineaDeResultado(correcta);
        if (!id) continue;
        correctasPorId.set(id, copiarLinea(correcta));
    }

    const fallosPorId = new Map();
    for (const fallo of [
        ...copia.lineasFallidas,
        ...(Array.isArray(snapshot.lineasFallidas)
            ? snapshot.lineasFallidas
            : [])
    ]) {
        const id = idLineaDeResultado(fallo);
        if (!id || correctasPorId.has(id)) continue;
        fallosPorId.set(id, copiarLinea(fallo));
    }

    copia.checkpointPublicacion = checkpoint;
    copia.lineasCorrectas = [...correctasPorId.values()];
    copia.lineasFallidas = [...fallosPorId.values()];
    return recalcularContadores(copia);
}

function exigirCheckpoint(registro) {
    const checkpoint = registro.checkpointPublicacion;
    if (
        !checkpoint ||
        checkpoint.version !== VERSION_CHECKPOINT_PUBLICACION
    ) {
        throw new Error(
            'El registro no tiene un checkpoint de publicación compatible.'
        );
    }
    return checkpoint;
}

function normalizarFaseLineaEnCurso(fase) {
    const valor = texto(fase).toLowerCase();
    if (!FASES_LINEA_EN_CURSO.has(valor)) {
        throw new TypeError(
            'La fase de la línea debe ser "preparacion" o "envio".'
        );
    }
    return valor;
}

function marcarLineaEnCurso(
    registro,
    linea,
    fecha = new Date(),
    fase = 'preparacion'
) {
    const copia = copiarRegistro(registro);
    const checkpoint = exigirCheckpoint(copia);
    const descripcion = descripcionLinea(linea);
    const fechaInicio = fechaIso(fecha);
    const faseNormalizada = normalizarFaseLineaEnCurso(fase);

    checkpoint.idsPendientesSeguros =
        checkpoint.idsPendientesSeguros.filter(id => id !== descripcion.id);
    checkpoint.lineaEnCurso = {
        ...descripcion,
        fase: faseNormalizada,
        iniciadaEn: fechaInicio
    };
    checkpoint.actualizadoEn = fechaInicio;

    return copia;
}

function actualizarFaseLineaEnCurso(
    registro,
    fase,
    fecha = new Date()
) {
    const copia = copiarRegistro(registro);
    const checkpoint = exigirCheckpoint(copia);
    if (!checkpoint.lineaEnCurso?.id) {
        throw new Error('No hay una línea en curso para actualizar.');
    }

    checkpoint.lineaEnCurso = {
        ...checkpoint.lineaEnCurso,
        fase: normalizarFaseLineaEnCurso(fase),
        faseActualizadaEn: fechaIso(fecha)
    };
    checkpoint.actualizadoEn = fechaIso(fecha);
    return copia;
}

function normalizarResultadoCorrecto(resultado) {
    const linea = descripcionLinea(resultado);
    const confirmacionManual =
        resultado?.confirmacionManual === true ||
        Boolean(resultado?.confirmacionManualEn);
    const estadoId = texto(resultado?.estadoId);

    if (!estadoId && !confirmacionManual) {
        throw new Error(
            'Un éxito definitivo necesita un ID de estado o confirmación manual.'
        );
    }

    return {
        ...resultado,
        ...linea,
        estadoId: estadoId || null,
        confirmacionManual,
        envioConfirmado: true,
        envioIncierto: false
    };
}

function normalizarResultadoFallido(resultado) {
    const linea = descripcionLinea(resultado);
    if (
        resultado?.envioConfirmado !== false ||
        resultado?.envioIncierto !== false
    ) {
        throw new Error(
            'El fallo no es definitivo: no se confirmó que el estado no fue enviado.'
        );
    }

    return {
        ...resultado,
        ...linea,
        envioConfirmado: false,
        envioIncierto: false,
        reintentoSeguro: resultado?.reintentoSeguro === true
    };
}

function registrarResultadoDefinitivo(
    registro,
    tipo,
    resultado,
    fecha = new Date()
) {
    const copia = copiarRegistro(registro);
    const checkpoint = exigirCheckpoint(copia);
    const momento = fechaIso(fecha);
    let linea;

    if (tipo === 'correcta') {
        linea = normalizarResultadoCorrecto(resultado);
        copia.lineasCorrectas = copia.lineasCorrectas.filter(
            item => idLineaDeResultado(item) !== linea.id
        );
        copia.lineasFallidas = copia.lineasFallidas.filter(
            item => idLineaDeResultado(item) !== linea.id
        );
        copia.lineasCorrectas.push(linea);
    } else if (tipo === 'fallida') {
        linea = normalizarResultadoFallido(resultado);
        if (
            copia.lineasCorrectas.some(
                item => idLineaDeResultado(item) === linea.id
            )
        ) {
            throw new Error(
                'No se puede reemplazar un envío confirmado por un fallo.'
            );
        }
        copia.lineasFallidas = copia.lineasFallidas.filter(
            item => idLineaDeResultado(item) !== linea.id
        );
        copia.lineasFallidas.push(linea);
    } else {
        throw new TypeError(
            'El tipo de resultado debe ser "correcta" o "fallida".'
        );
    }

    checkpoint.idsPendientesSeguros =
        checkpoint.idsPendientesSeguros.filter(id => id !== linea.id);
    if (checkpoint.lineaEnCurso?.id === linea.id) {
        checkpoint.lineaEnCurso = null;
    }
    checkpoint.ultimaLineaDefinitiva = {
        id: linea.id,
        tipo,
        registradaEn: momento
    };
    checkpoint.actualizadoEn = momento;

    return recalcularContadores(copia);
}

function gruposPorId(gruposEstadosActivos) {
    if (gruposEstadosActivos instanceof Map) {
        return new Map(gruposEstadosActivos);
    }

    const mapa = new Map();
    for (const grupo of Array.isArray(gruposEstadosActivos)
        ? gruposEstadosActivos
        : []) {
        const id = texto(grupo?.id);
        if (id && !mapa.has(id)) mapa.set(id, grupo);
    }
    return mapa;
}

function resultadoCorrectoDesdeEstadoActivo(linea, momento) {
    const descripcion = descripcionLinea(linea, linea?.lineaId);
    const estadoId = texto(linea?.clave?.id || linea?.meta?.id);

    return {
        ...descripcion,
        estadoId: estadoId || null,
        envioConfirmado: true,
        envioIncierto: false,
        recuperadaDesdeEstadosActivos: true,
        recuperadaEn: momento
    };
}

function falloPendienteSeguro(id, momento) {
    return {
        id,
        nombre: id,
        numero: null,
        error:
            'No se inició antes del reinicio. Puede seleccionarse manualmente para reintentar.',
        tipoError: 'interrumpida_reinicio',
        codigoError: CODIGO_INTERRUPCION_REINICIO,
        fase: 'no_procesada',
        reintentable: true,
        envioConfirmado: false,
        envioIncierto: false,
        reintentoSeguro: true,
        recuperadaEn: momento
    };
}

function falloEnvioIncierto(id, descripcion, momento) {
    return {
        id,
        nombre: texto(descripcion?.nombre) || id,
        numero: descripcion?.numero ? String(descripcion.numero) : null,
        error:
            'La aplicación se cerró sin poder confirmar si esta línea publicó el estado.',
        tipoError: 'envio_incierto_reinicio',
        codigoError: CODIGO_ENVIO_INCIERTO_REINICIO,
        fase: 'recuperacion_reinicio',
        reintentable: false,
        envioConfirmado: null,
        envioIncierto: true,
        reintentoSeguro: false,
        recuperadaEn: momento
    };
}

function esFalloDefinitivamenteNoEnviado(fallo) {
    return Boolean(
        idLineaDeResultado(fallo) &&
        fallo?.envioConfirmado === false &&
        fallo?.envioIncierto === false
    );
}

function obtenerIdsPendientesSeguros(registro) {
    const correctas = new Set(
        (registro?.lineasCorrectas || [])
            .map(idLineaDeResultado)
            .filter(Boolean)
    );

    return idsUnicos(
        (registro?.lineasFallidas || [])
            .filter(fallo =>
                esFalloDefinitivamenteNoEnviado(fallo) &&
                fallo?.reintentoSeguro === true &&
                !fallo?.reintentadaEn
            )
            .map(idLineaDeResultado)
            .filter(id => id && !correctas.has(id))
    );
}

function obtenerIdsEnvioIncierto(registro) {
    const correctas = new Set(
        (registro?.lineasCorrectas || [])
            .map(idLineaDeResultado)
            .filter(Boolean)
    );

    return idsUnicos(
        (registro?.lineasFallidas || [])
            .filter(fallo =>
                fallo?.envioIncierto === true ||
                (
                    fallo?.envioConfirmado !== false &&
                    fallo?.envioConfirmado !== true
                )
            )
            .map(idLineaDeResultado)
            .filter(id => id && !correctas.has(id))
    );
}

function reconciliarRegistroInterrumpido(
    registro,
    gruposEstadosActivos,
    fecha = new Date()
) {
    const copia = copiarRegistro(registro);
    if (copia.estado !== 'ejecutando') {
        return {
            registro: copia,
            cambiado: false,
            confirmadasDesdeEstadosActivos: [],
            idsPendientesSeguros: obtenerIdsPendientesSeguros(copia),
            idsEnvioIncierto: obtenerIdsEnvioIncierto(copia)
        };
    }

    const momento = fechaIso(fecha);
    const grupo = gruposPorId(gruposEstadosActivos).get(texto(copia.id));
    const confirmadasDesdeEstadosActivos = [];
    const correctasPorId = new Map();

    for (const correcta of copia.lineasCorrectas) {
        const id = idLineaDeResultado(correcta);
        if (id && !correctasPorId.has(id)) {
            correctasPorId.set(id, correcta);
        }
    }

    for (const linea of Array.isArray(grupo?.lineas) ? grupo.lineas : []) {
        const correcta = resultadoCorrectoDesdeEstadoActivo(linea, momento);
        correctasPorId.set(correcta.id, {
            ...(correctasPorId.get(correcta.id) || {}),
            ...correcta
        });
        confirmadasDesdeEstadosActivos.push(correcta.id);
    }

    const idsCorrectos = new Set(correctasPorId.keys());
    const fallosPorId = new Map();
    for (const fallo of copia.lineasFallidas) {
        const id = idLineaDeResultado(fallo);
        if (!id || idsCorrectos.has(id) || fallosPorId.has(id)) continue;
        fallosPorId.set(id, fallo);
    }

    const checkpointCompatible =
        copia.checkpointPublicacion?.version ===
        VERSION_CHECKPOINT_PUBLICACION;
    const idsPendientesDelCheckpoint = new Set(
        checkpointCompatible
            ? copia.checkpointPublicacion.idsPendientesSeguros
            : []
    );
    const lineaEnCurso = checkpointCompatible
        ? copia.checkpointPublicacion.lineaEnCurso
        : null;
    if (
        lineaEnCurso?.id &&
        lineaEnCurso.fase === 'preparacion'
    ) {
        idsPendientesDelCheckpoint.add(lineaEnCurso.id);
    }
    const idsObjetivo = copia.idsLineas.length
        ? copia.idsLineas
        : idsUnicos([
            ...correctasPorId.keys(),
            ...fallosPorId.keys(),
            lineaEnCurso?.id
        ]);

    for (const id of idsObjetivo) {
        if (idsCorrectos.has(id)) {
            fallosPorId.delete(id);
            continue;
        }

        const falloExistente = fallosPorId.get(id);
        if (esFalloDefinitivamenteNoEnviado(falloExistente)) continue;

        if (idsPendientesDelCheckpoint.has(id)) {
            fallosPorId.set(id, falloPendienteSeguro(id, momento));
            continue;
        }

        if (falloExistente?.envioIncierto === true) continue;

        const descripcion = lineaEnCurso?.id === id
            ? lineaEnCurso
            : falloExistente;
        fallosPorId.set(
            id,
            falloEnvioIncierto(id, descripcion, momento)
        );
    }

    copia.lineasCorrectas = [...correctasPorId.values()];
    copia.lineasFallidas = [...fallosPorId.values()];
    copia.estado = ESTADO_INTERRUPCION_REINICIO;
    copia.fechaFin = momento;
    copia.error =
        'La aplicación se cerró durante la publicación. No se reanudó automáticamente para evitar estados duplicados.';

    if (checkpointCompatible) {
        copia.checkpointPublicacion.lineaEnCurso = null;
        copia.checkpointPublicacion.actualizadoEn = momento;
        copia.checkpointPublicacion.interrumpidoEn = momento;
    }

    recalcularContadores(copia);

    const idsPendientesSeguros = obtenerIdsPendientesSeguros(copia);
    const idsEnvioIncierto = obtenerIdsEnvioIncierto(copia);
    copia.recuperacionReinicio = {
        recuperadaEn: momento,
        reanudacionAutomatica: false,
        requiereRevisionManual: idsEnvioIncierto.length > 0,
        confirmadasDesdeEstadosActivos: idsUnicos(
            confirmadasDesdeEstadosActivos
        ),
        idsPendientesSeguros,
        idsEnvioIncierto
    };

    return {
        registro: copia,
        cambiado: true,
        confirmadasDesdeEstadosActivos:
            copia.recuperacionReinicio.confirmadasDesdeEstadosActivos,
        idsPendientesSeguros,
        idsEnvioIncierto
    };
}

function reconciliarHistorialInterrumpido(
    historial,
    gruposEstadosActivos,
    fecha = new Date(),
    snapshotPublicacionActiva = null
) {
    const registros = Array.isArray(historial) ? historial : [];
    const grupos = gruposPorId(gruposEstadosActivos);
    const resumen = [];
    let cambiados = 0;

    const historialReconciliado = registros.map(registro => {
        const registroBase =
            snapshotPublicacionActiva &&
            registro?.estado === 'ejecutando' &&
            texto(snapshotPublicacionActiva.publicacionId) === texto(registro?.id)
                ? aplicarSnapshotPublicacionActiva(
                    registro,
                    snapshotPublicacionActiva
                )
                : registro;
        const resultado = reconciliarRegistroInterrumpido(
            registroBase,
            grupos,
            fecha
        );
        if (resultado.cambiado) {
            cambiados += 1;
            resumen.push({
                id: texto(resultado.registro.id),
                confirmadasDesdeEstadosActivos:
                    resultado.confirmadasDesdeEstadosActivos,
                idsPendientesSeguros: resultado.idsPendientesSeguros,
                idsEnvioIncierto: resultado.idsEnvioIncierto
            });
        }
        return resultado.registro;
    });

    return {
        historial: historialReconciliado,
        cambiados,
        resumen
    };
}

module.exports = {
    VERSION_CHECKPOINT_PUBLICACION,
    VERSION_SNAPSHOT_PUBLICACION,
    ESTADO_INTERRUPCION_REINICIO,
    CODIGO_INTERRUPCION_REINICIO,
    CODIGO_ENVIO_INCIERTO_REINICIO,
    crearCheckpointPublicacion,
    crearSnapshotPublicacionActiva,
    aplicarSnapshotPublicacionActiva,
    marcarLineaEnCurso,
    actualizarFaseLineaEnCurso,
    registrarResultadoDefinitivo,
    reconciliarRegistroInterrumpido,
    reconciliarHistorialInterrumpido,
    obtenerIdsPendientesSeguros,
    obtenerIdsEnvioIncierto
};
