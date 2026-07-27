const TOTAL_LINEAS_SIMULADAS = 20;
const TOTAL_VISUALIZACIONES_SIMULADAS = 500;
const PREFIJO_ID_LINEA_SIMULADA = 'zeroone-ui-demo-line-';
const ID_PUBLICACION_SIMULADA = 'zeroone-ui-demo-status-500';

function idLineaSimulada(indice) {
    return `${PREFIJO_ID_LINEA_SIMULADA}${String(indice).padStart(2, '0')}`;
}

function esLineaSimulada(id) {
    return new RegExp(`^${PREFIJO_ID_LINEA_SIMULADA}\\d{2}$`, 'u')
        .test(String(id || ''));
}

function distribuirVisualizaciones() {
    return Array.from(
        { length: TOTAL_LINEAS_SIMULADAS },
        (_valor, indice) => 44 - (indice * 2)
    );
}

function crearLineasSimuladas(fechaBase = new Date()) {
    const ahora = new Date(fechaBase);
    const ultimaPublicacion = new Date(ahora.getTime() - (8 * 60 * 1000));

    return distribuirVisualizaciones().map((_visualizaciones, indice) => {
        const numeroLinea = indice + 1;
        const numero = `595981${String(100000 + numeroLinea).padStart(6, '0')}`;

        return {
            id: idLineaSimulada(numeroLinea),
            nombre: `L${String(numeroLinea).padStart(2, '0')}`,
            ordenConexion: numeroLinea,
            etiqueta: 'activa',
            estado: 'conectado',
            qr: null,
            numero,
            ultimaConexion: ahora.toISOString(),
            ultimaPublicacion: ultimaPublicacion.toISOString(),
            ultimoError: null,
            ultimoErrorAudiencia: null,
            fallosRecientes: 0,
            intentosReconexion: 0,
            conexionEnVerificacion: false,
            listaParaPublicar: false,
            codigoBloqueoPublicacion: 'LINEA_SIMULADA',
            motivoBloqueoPublicacion:
                'Esta línea pertenece a la vista interna y no puede publicar.',
            requiereRevisionEnvio: false,
            reconexionBloqueada: false,
            contactosEstado: 1000,
            contactosEstadoWhatsApp: 1000,
            contactosEstadoGoogle: 780,
            origenAudiencia: 'whatsapp',
            destinatariosEstado: 1000,
            destinatariosEstadoBase: 1000,
            limiteDestinatariosEstado: 1000,
            destinatariosEstadoTotales: 1000,
            destinatariosEstadoOmitidos: 0,
            destinatariosEstadoOmitidosPorLimite: 0,
            destinatariosEstadoFueraBase: 0,
            audienciaEstadosLista: true,
            estadoAudiencia: 'lista',
            resincronizandoAudiencia: false,
            intentosResincronizacionAudiencia: 0,
            maximosIntentosAudiencia: 4,
            proximoIntentoAudiencia: null,
            priorizacionAudiencia: {
                criterio: 'actividad_reciente',
                sincronizandoActividad: false,
                audienciaEfectiva: 1000,
                baseReciente: 1000,
                seleccionados: 1000,
                actividadConocida: 1000,
                actividadDesconocida: 0
            },
            historialAgendamiento: {
                estado: 'lista',
                progreso: 100,
                mensaje: 'Vista simulada lista.'
            },
            simulada: true
        };
    });
}

function crearEstadosActivosSimulados(fechaBase = new Date()) {
    const ahora = new Date(fechaBase);
    const fechaInicio = new Date(ahora.getTime() - (8 * 60 * 1000));
    const expiraEn = new Date(ahora.getTime() + (23 * 60 * 60 * 1000));
    const vistas = distribuirVisualizaciones();
    const lineas = crearLineasSimuladas(ahora).map((linea, indice) => ({
        lineaId: linea.id,
        nombre: linea.nombre,
        numero: linea.numero,
        estadoId: `DEMO-STATUS-${String(indice + 1).padStart(2, '0')}`,
        estado: 'activo',
        error: null,
        visualizaciones: vistas[indice],
        simulada: true
    }));

    return {
        resumen: {
            gruposActivos: 1,
            estadosEnLineas: TOTAL_LINEAS_SIMULADAS,
            conErrores: 0,
            visualizacionesTotales: TOTAL_VISUALIZACIONES_SIMULADAS,
            eliminadosAhora: 0
        },
        publicaciones: [{
            id: ID_PUBLICACION_SIMULADA,
            fechaInicio: fechaInicio.toISOString(),
            expiraEn: expiraEn.toISOString(),
            texto: 'Estado simulado para revisar visualizaciones',
            imagenUrl: '/assets/demo-status.svg',
            visualizaciones: TOTAL_VISUALIZACIONES_SIMULADAS,
            lineas,
            simulada: true
        }],
        progreso: {
            activo: false,
            estado: 'inactivo',
            publicacionId: null,
            total: 0,
            procesadas: 0,
            correctas: 0,
            fallidas: 0,
            eliminadas: 0,
            grupoActual: 0,
            totalGrupos: 0,
            mensaje: 'Vista interna: no se realizan operaciones reales.'
        },
        simulada: true
    };
}

module.exports = {
    ID_PUBLICACION_SIMULADA,
    PREFIJO_ID_LINEA_SIMULADA,
    TOTAL_LINEAS_SIMULADAS,
    TOTAL_VISUALIZACIONES_SIMULADAS,
    crearEstadosActivosSimulados,
    crearLineasSimuladas,
    distribuirVisualizaciones,
    esLineaSimulada
};
