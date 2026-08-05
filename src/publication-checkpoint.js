'use strict';

// Journal mínimo y aislado para una publicación activa. Su única misión es
// distinguir lo que no llegó a enviarse de lo que pudo haberse enviado cuando
// el proceso se interrumpe. Nunca decide publicar ni reconectar por sí mismo.

const fs = require('fs');
const path = require('path');

const VERSION_CHECKPOINT_PUBLICACION = 1;
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
    const vistos = new Set();
    const resultado = [];

    for (const valor of Array.isArray(valores) ? valores : []) {
        const id = texto(valor);
        if (!id || vistos.has(id)) continue;
        vistos.add(id);
        resultado.push(id);
    }

    return resultado;
}

function copiar(valor) {
    return JSON.parse(JSON.stringify(valor));
}

function idResultado(resultado) {
    return texto(resultado?.id || resultado?.lineaId);
}

function normalizarRegistro(registro) {
    if (!registro || typeof registro !== 'object' || !texto(registro.id)) {
        throw new TypeError('El registro de publicación no es válido.');
    }

    const copia = copiar(registro);
    copia.id = texto(copia.id);
    copia.idsLineas = idsUnicos(copia.idsLineas);
    copia.lineasCorrectas = Array.isArray(copia.lineasCorrectas)
        ? copia.lineasCorrectas.filter(item => item && typeof item === 'object')
        : [];
    copia.lineasFallidas = Array.isArray(copia.lineasFallidas)
        ? copia.lineasFallidas.filter(item => item && typeof item === 'object')
        : [];
    return copia;
}

function recalcularContadores(registro) {
    const correctasPorId = new Map();
    for (const correcta of registro.lineasCorrectas) {
        const id = idResultado(correcta);
        if (id) correctasPorId.set(id, correcta);
    }

    const fallosPorId = new Map();
    for (const fallo of registro.lineasFallidas) {
        const id = idResultado(fallo);
        if (!id || correctasPorId.has(id)) continue;
        fallosPorId.set(id, fallo);
    }

    registro.lineasCorrectas = [...correctasPorId.values()];
    registro.lineasFallidas = [...fallosPorId.values()];
    registro.total = registro.idsLineas.length;
    registro.correctas = correctasPorId.size;
    registro.fallidas = [...fallosPorId.values()].filter(
        fallo => fallo?.fase !== 'no_procesada'
    ).length;
    registro.noProcesadas = [...fallosPorId.values()].filter(
        fallo => fallo?.fase === 'no_procesada'
    ).length;
    return registro;
}

function exigirCheckpoint(registro) {
    const checkpoint = registro?.checkpointPublicacion;
    if (
        !checkpoint ||
        checkpoint.version !== VERSION_CHECKPOINT_PUBLICACION
    ) {
        throw new Error('El registro no tiene un checkpoint compatible.');
    }
    return checkpoint;
}

function crearCheckpointPublicacion(registro, fecha = new Date()) {
    const copia = normalizarRegistro(registro);
    const resueltas = new Set([
        ...copia.lineasCorrectas.map(idResultado),
        ...copia.lineasFallidas
            .filter(fallo =>
                fallo?.envioConfirmado === false &&
                fallo?.envioIncierto === false
            )
            .map(idResultado)
    ].filter(Boolean));
    const momento = fechaIso(fecha);

    copia.checkpointPublicacion = {
        version: VERSION_CHECKPOINT_PUBLICACION,
        revision: 0,
        creadoEn: momento,
        actualizadoEn: momento,
        lineaEnCurso: null,
        idsPendientesSeguros: copia.idsLineas.filter(id => !resueltas.has(id)),
        ultimaLineaDefinitiva: null
    };
    return recalcularContadores(copia);
}

function descripcionLinea(linea) {
    const id = idResultado(linea);
    if (!id) throw new TypeError('La línea del checkpoint no tiene ID.');

    return {
        id,
        nombre: texto(linea?.nombre) || id,
        numero: linea?.numero ? String(linea.numero) : null
    };
}

function marcarLineaEnCurso(registro, linea, fase = 'preparacion', fecha = new Date()) {
    const copia = normalizarRegistro(registro);
    const checkpoint = exigirCheckpoint(copia);
    const faseNormalizada = texto(fase).toLowerCase();
    if (!FASES_LINEA_EN_CURSO.has(faseNormalizada)) {
        throw new TypeError('La fase debe ser preparación o envío.');
    }

    const descripcion = descripcionLinea(linea);
    const momento = fechaIso(fecha);
    checkpoint.idsPendientesSeguros = idsUnicos(
        checkpoint.idsPendientesSeguros
    ).filter(id => id !== descripcion.id);
    checkpoint.lineaEnCurso = {
        ...descripcion,
        fase: faseNormalizada,
        iniciadaEn: momento
    };
    checkpoint.actualizadoEn = momento;
    return copia;
}

function actualizarFaseLineaEnCurso(registro, fase, fecha = new Date()) {
    const copia = normalizarRegistro(registro);
    const checkpoint = exigirCheckpoint(copia);
    const faseNormalizada = texto(fase).toLowerCase();
    if (!checkpoint.lineaEnCurso?.id || !FASES_LINEA_EN_CURSO.has(faseNormalizada)) {
        throw new Error('No hay una línea en curso compatible para actualizar.');
    }

    const momento = fechaIso(fecha);
    checkpoint.lineaEnCurso = {
        ...checkpoint.lineaEnCurso,
        fase: faseNormalizada,
        faseActualizadaEn: momento
    };
    checkpoint.actualizadoEn = momento;
    return copia;
}

function registrarResultadoDefinitivo(registro, tipo, resultado, fecha = new Date()) {
    const copia = normalizarRegistro(registro);
    const checkpoint = exigirCheckpoint(copia);
    const descripcion = descripcionLinea(resultado);
    const momento = fechaIso(fecha);
    let resultadoNormalizado;

    if (tipo === 'correcta') {
        const estadoId = texto(resultado?.estadoId);
        const confirmacionManual = resultado?.confirmacionManual === true ||
            Boolean(resultado?.confirmacionManualEn);
        if (!estadoId && !confirmacionManual) {
            throw new Error('Un éxito definitivo requiere ID o confirmación manual.');
        }
        resultadoNormalizado = {
            ...resultado,
            ...descripcion,
            estadoId: estadoId || null,
            envioConfirmado: true,
            envioIncierto: false
        };
        copia.lineasCorrectas = copia.lineasCorrectas.filter(
            item => idResultado(item) !== descripcion.id
        );
        copia.lineasFallidas = copia.lineasFallidas.filter(
            item => idResultado(item) !== descripcion.id
        );
        copia.lineasCorrectas.push(resultadoNormalizado);
    } else if (tipo === 'fallida') {
        if (
            resultado?.envioConfirmado !== false ||
            resultado?.envioIncierto !== false
        ) {
            throw new Error('El fallo no confirma que el estado no fue enviado.');
        }
        if (copia.lineasCorrectas.some(item => idResultado(item) === descripcion.id)) {
            throw new Error('No se puede reemplazar un estado confirmado por un fallo.');
        }
        resultadoNormalizado = {
            ...resultado,
            ...descripcion,
            envioConfirmado: false,
            envioIncierto: false,
            reintentoSeguro: resultado?.reintentoSeguro === true
        };
        copia.lineasFallidas = copia.lineasFallidas.filter(
            item => idResultado(item) !== descripcion.id
        );
        copia.lineasFallidas.push(resultadoNormalizado);
    } else {
        throw new TypeError('El resultado debe ser correcta o fallida.');
    }

    checkpoint.idsPendientesSeguros = idsUnicos(
        checkpoint.idsPendientesSeguros
    ).filter(id => id !== descripcion.id);
    if (checkpoint.lineaEnCurso?.id === descripcion.id) {
        checkpoint.lineaEnCurso = null;
    }
    checkpoint.ultimaLineaDefinitiva = {
        id: descripcion.id,
        tipo,
        registradaEn: momento
    };
    checkpoint.actualizadoEn = momento;
    return recalcularContadores(copia);
}

function crearSnapshotPublicacionActiva(registro, fecha = new Date()) {
    const copia = normalizarRegistro(registro);
    const checkpoint = exigirCheckpoint(copia);
    const momento = fechaIso(fecha);
    checkpoint.revision = Math.max(0, Number(checkpoint.revision) || 0) + 1;
    checkpoint.actualizadoEn = momento;

    return {
        version: VERSION_CHECKPOINT_PUBLICACION,
        publicacionId: copia.id,
        revision: checkpoint.revision,
        actualizadoEn: momento,
        registro: copia
    };
}

function esSnapshotValido(snapshot) {
    return Boolean(
        snapshot &&
        typeof snapshot === 'object' &&
        snapshot.version === VERSION_CHECKPOINT_PUBLICACION &&
        texto(snapshot.publicacionId) &&
        snapshot.registro &&
        typeof snapshot.registro === 'object' &&
        texto(snapshot.registro.id) === texto(snapshot.publicacionId) &&
        snapshot.registro.checkpointPublicacion?.version ===
            VERSION_CHECKPOINT_PUBLICACION &&
        Number.isFinite(Number(snapshot.revision)) &&
        Number(snapshot.revision) === Number(
            snapshot.registro.checkpointPublicacion.revision
        )
    );
}

function escribirArchivoSeguro(ruta, contenido) {
    const temporal = `${ruta}.tmp`;
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    let descriptor = null;
    try {
        descriptor = fs.openSync(temporal, 'w', 0o600);
        fs.writeFileSync(descriptor, contenido, 'utf8');
        try {
            fs.fsyncSync(descriptor);
        } catch (error) {
            // Algunos sistemas de archivos de Windows no permiten fsync para
            // este descriptor; el archivo temporal validado sigue siendo más
            // seguro que escribir directamente sobre el principal.
            if (!['EINVAL', 'ENOTSUP', 'ENOSYS', 'EPERM'].includes(error?.code)) {
                throw error;
            }
        }
    } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
    }
    JSON.parse(fs.readFileSync(temporal, 'utf8'));
    try {
        fs.renameSync(temporal, ruta);
    } catch {
        fs.copyFileSync(temporal, ruta);
        fs.rmSync(temporal, { force: true });
    }
}

function leerSnapshot(ruta, fuente) {
    if (!fs.existsSync(ruta)) return null;
    try {
        const datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
        return esSnapshotValido(datos)
            ? { datos, fuente }
            : null;
    } catch {
        return null;
    }
}

function crearAlmacenCheckpoint(ruta) {
    const principal = path.resolve(ruta);
    const respaldo = `${principal}.bak`;
    const temporal = `${principal}.tmp`;
    const temporalRespaldo = `${respaldo}.tmp`;

    function cargar() {
        const candidatas = [
            leerSnapshot(principal, 'principal'),
            leerSnapshot(temporal, 'temporal'),
            leerSnapshot(respaldo, 'respaldo'),
            leerSnapshot(temporalRespaldo, 'respaldo_temporal')
        ].filter(Boolean);
        if (!candidatas.length) return null;

        candidatas.sort((a, b) => {
            const diferencia = Number(b.datos.revision) - Number(a.datos.revision);
            if (diferencia) return diferencia;
            return a.fuente === 'principal' ? -1 : 1;
        });
        return candidatas[0];
    }

    function guardar(snapshot) {
        if (!esSnapshotValido(snapshot)) {
            throw new TypeError('El snapshot de publicación no es válido.');
        }
        const contenido = `${JSON.stringify(snapshot, null, 2)}\n`;
        // Se escribe primero el respaldo con la revisión nueva. Así, si se
        // apaga durante el reemplazo del principal, el lector elegirá la copia
        // válida de mayor revisión y no habilitará reenvíos inciertos.
        escribirArchivoSeguro(respaldo, contenido);
        escribirArchivoSeguro(principal, contenido);
    }

    function eliminarSiPerteneceA(publicacionId) {
        const actual = cargar();
        if (actual && texto(actual.datos.publicacionId) !== texto(publicacionId)) {
            return false;
        }
        for (const candidata of [principal, temporal, respaldo, temporalRespaldo]) {
            fs.rmSync(candidata, { force: true });
        }
        return true;
    }

    return Object.freeze({
        rutas: Object.freeze({ principal, respaldo, temporal, temporalRespaldo }),
        cargar,
        guardar,
        eliminarSiPerteneceA
    });
}

function resultadoCorrectoDesdeEstadoActivo(linea, momento) {
    const id = texto(linea?.lineaId || linea?.id);
    if (!id) return null;
    return {
        id,
        nombre: texto(linea?.nombre) || id,
        numero: linea?.numero ? String(linea.numero) : null,
        estadoId: texto(linea?.clave?.id || linea?.meta?.id) || null,
        envioConfirmado: true,
        envioIncierto: false,
        recuperadaDesdeEstadosActivos: true,
        recuperadaEn: momento
    };
}

function obtenerIdsPendientesSeguros(registro) {
    const correctas = new Set(
        (registro?.lineasCorrectas || []).map(idResultado).filter(Boolean)
    );
    return idsUnicos(
        (registro?.lineasFallidas || [])
            .filter(fallo =>
                fallo?.envioConfirmado === false &&
                fallo?.envioIncierto === false &&
                fallo?.reintentoSeguro === true &&
                !fallo?.reintentadaEn
            )
            .map(idResultado)
            .filter(id => id && !correctas.has(id))
    );
}

function obtenerIdsEnvioIncierto(registro) {
    const correctas = new Set(
        (registro?.lineasCorrectas || []).map(idResultado).filter(Boolean)
    );
    return idsUnicos(
        (registro?.lineasFallidas || [])
            .filter(fallo => fallo?.envioIncierto === true)
            .map(idResultado)
            .filter(id => id && !correctas.has(id))
    );
}

function reconciliarRegistroInterrumpido(registro, gruposEstadosActivos, fecha = new Date()) {
    const copia = normalizarRegistro(registro);
    if (copia.estado !== 'ejecutando') {
        return { registro: copia, cambiado: false };
    }

    const checkpoint = exigirCheckpoint(copia);
    const momento = fechaIso(fecha);
    const grupos = gruposEstadosActivos instanceof Map
        ? gruposEstadosActivos
        : new Map((Array.isArray(gruposEstadosActivos) ? gruposEstadosActivos : [])
            .filter(grupo => texto(grupo?.id))
            .map(grupo => [texto(grupo.id), grupo]));
    const activos = grupos.get(copia.id);
    const correctas = new Map();
    const confirmadasDesdeEstadosActivos = [];

    for (const correcta of copia.lineasCorrectas) {
        const id = idResultado(correcta);
        if (id) correctas.set(id, correcta);
    }
    for (const linea of Array.isArray(activos?.lineas) ? activos.lineas : []) {
        const correcta = resultadoCorrectoDesdeEstadoActivo(linea, momento);
        if (!correcta) continue;
        correctas.set(correcta.id, {
            ...(correctas.get(correcta.id) || {}),
            ...correcta
        });
        confirmadasDesdeEstadosActivos.push(correcta.id);
    }

    const fallos = new Map();
    for (const fallo of copia.lineasFallidas) {
        const id = idResultado(fallo);
        if (id && !correctas.has(id)) fallos.set(id, fallo);
    }
    const pendientes = new Set(idsUnicos(checkpoint.idsPendientesSeguros));
    if (checkpoint.lineaEnCurso?.fase === 'preparacion') {
        pendientes.add(checkpoint.lineaEnCurso.id);
    }
    // Los pendientes presentes antes de reconstruir los fallos no son un
    // resultado final: son líneas que el apagado dejó sin iniciar. Aunque se
    // representen como fallos reanudables para la UI, la campaña debe seguir
    // apareciendo como interrumpida, no como "completada con errores".
    const habiaPendientesSeguros = pendientes.size > 0;

    for (const id of copia.idsLineas) {
        if (correctas.has(id)) {
            fallos.delete(id);
            continue;
        }
        const existente = fallos.get(id);
        if (
            existente?.envioConfirmado === false &&
            existente?.envioIncierto === false
        ) continue;
        if (pendientes.has(id)) {
            const descripcion = checkpoint.lineaEnCurso?.id === id
                ? checkpoint.lineaEnCurso
                : existente;
            fallos.set(id, {
                id,
                nombre: texto(descripcion?.nombre) || id,
                numero: descripcion?.numero || null,
                error: 'No se inició antes del reinicio. Puede reanudarse manualmente.',
                tipoError: 'interrumpida_reinicio',
                codigoError: CODIGO_INTERRUPCION_REINICIO,
                fase: 'no_procesada',
                reintentable: true,
                envioConfirmado: false,
                envioIncierto: false,
                reintentoSeguro: true,
                recuperadaEn: momento
            });
            continue;
        }
        if (existente?.envioIncierto === true) continue;
        const descripcion = checkpoint.lineaEnCurso?.id === id
            ? checkpoint.lineaEnCurso
            : existente;
        fallos.set(id, {
            id,
            nombre: texto(descripcion?.nombre) || id,
            numero: descripcion?.numero || null,
            error: 'La aplicación se cerró sin confirmar si esta línea publicó el estado.',
            tipoError: 'envio_incierto_reinicio',
            codigoError: CODIGO_ENVIO_INCIERTO_REINICIO,
            fase: 'recuperacion_reinicio',
            reintentable: false,
            envioConfirmado: null,
            envioIncierto: true,
            reintentoSeguro: false,
            recuperadaEn: momento
        });
    }

    copia.lineasCorrectas = [...correctas.values()];
    copia.lineasFallidas = [...fallos.values()];
    copia.fechaFin = momento;
    checkpoint.lineaEnCurso = null;
    checkpoint.actualizadoEn = momento;
    checkpoint.interrumpidoEn = momento;
    recalcularContadores(copia);

    const idsDefinitivos = new Set([
        ...copia.lineasCorrectas.map(idResultado),
        ...copia.lineasFallidas
            .filter(fallo =>
                fallo?.envioConfirmado === false &&
                fallo?.envioIncierto === false
            )
            .map(idResultado)
    ].filter(Boolean));
    const todoFinalizado = !habiaPendientesSeguros &&
        copia.idsLineas.length > 0 &&
        copia.idsLineas.every(id => idsDefinitivos.has(id));

    if (todoFinalizado) {
        copia.estado = copia.lineasFallidas.length
            ? 'completado_con_errores'
            : 'completado';
        copia.error = null;
    } else {
        copia.estado = ESTADO_INTERRUPCION_REINICIO;
        copia.error =
            'La aplicación se cerró durante la publicación. No se reanudó automáticamente para evitar estados duplicados.';
    }
    copia.recuperacionReinicio = {
        recuperadaEn: momento,
        reanudacionAutomatica: false,
        confirmadasDesdeEstadosActivos: idsUnicos(confirmadasDesdeEstadosActivos),
        idsPendientesSeguros: obtenerIdsPendientesSeguros(copia),
        idsEnvioIncierto: obtenerIdsEnvioIncierto(copia)
    };

    return {
        registro: copia,
        cambiado: true,
        ...copia.recuperacionReinicio
    };
}

function reconciliarRegistroLegadoSinCheckpoint(
    registro,
    gruposEstadosActivos,
    fecha = new Date()
) {
    const copia = normalizarRegistro(registro);
    if (
        copia.estado !== 'ejecutando' ||
        copia.checkpointPublicacion?.version === VERSION_CHECKPOINT_PUBLICACION
    ) {
        return { registro: copia, cambiado: false };
    }

    const momento = fechaIso(fecha);
    // Un registro 1.5.12 no permite saber hasta qué punto llegó su último
    // envío. No se inventan pendientes seguros: todo lo que no aparezca en
    // estados-activos queda incierto y requiere revisión manual.
    copia.checkpointPublicacion = {
        version: VERSION_CHECKPOINT_PUBLICACION,
        revision: 0,
        creadoEn: momento,
        actualizadoEn: momento,
        lineaEnCurso: null,
        idsPendientesSeguros: [],
        ultimaLineaDefinitiva: null,
        legadoSinCheckpoint: true
    };
    return reconciliarRegistroInterrumpido(copia, gruposEstadosActivos, fecha);
}

function reconciliarRegistroSinJournal(
    registro,
    gruposEstadosActivos,
    fecha = new Date()
) {
    const copia = normalizarRegistro(registro);
    if (copia.estado !== 'ejecutando') {
        return { registro: copia, cambiado: false };
    }
    if (copia.checkpointPublicacion?.version !== VERSION_CHECKPOINT_PUBLICACION) {
        return reconciliarRegistroLegadoSinCheckpoint(
            copia,
            gruposEstadosActivos,
            fecha
        );
    }

    // Si el journal externo se perdió o está corrupto, el checkpoint que
    // quedó dentro del historial podría corresponder a una fase anterior al
    // apagado. No se usa para habilitar reintentos: lo no confirmado queda
    // incierto y solo se conservan éxitos/errores ya definitivos.
    copia.checkpointPublicacion.idsPendientesSeguros = [];
    copia.checkpointPublicacion.lineaEnCurso = null;
    copia.checkpointPublicacion.journalNoDisponible = true;
    return reconciliarRegistroInterrumpido(copia, gruposEstadosActivos, fecha);
}

module.exports = {
    VERSION_CHECKPOINT_PUBLICACION,
    ESTADO_INTERRUPCION_REINICIO,
    CODIGO_INTERRUPCION_REINICIO,
    CODIGO_ENVIO_INCIERTO_REINICIO,
    crearAlmacenCheckpoint,
    crearCheckpointPublicacion,
    crearSnapshotPublicacionActiva,
    marcarLineaEnCurso,
    actualizarFaseLineaEnCurso,
    registrarResultadoDefinitivo,
    reconciliarRegistroInterrumpido,
    reconciliarRegistroLegadoSinCheckpoint,
    reconciliarRegistroSinJournal,
    obtenerIdsPendientesSeguros,
    obtenerIdsEnvioIncierto
};
