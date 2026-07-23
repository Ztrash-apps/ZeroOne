'use strict';

function responderError(res, mensaje) {
    return res.status(400).json({ error: mensaje });
}

function registrarRutasConfiguracion(app, opciones = {}) {
    const {
        obtenerConfiguracion,
        guardarConfiguracion,
        aplicarPreferenciasEscritorio = () => {},
        temasVisuales = new Set(),
        modosRitmo = new Set(),
        minimoDestinatarios = 1,
        maximoDestinatarios = 1000
    } = opciones;

    if (typeof obtenerConfiguracion !== 'function') {
        throw new TypeError('obtenerConfiguracion es obligatorio.');
    }
    if (typeof guardarConfiguracion !== 'function') {
        throw new TypeError('guardarConfiguracion es obligatorio.');
    }

    app.get('/configuracion', (_req, res) => {
        res.json(obtenerConfiguracion());
    });

    app.put('/configuracion', (req, res) => {
        const actual = obtenerConfiguracion();
        const limiteFallos = Number(req.body.limiteFallosSeguridad);
        const modoRitmo = req.body.modoRitmoPredeterminado;
        const intervaloSegundos = Number(req.body.intervaloSegundosPredeterminado);
        const variacionSegundos = Number(req.body.variacionSegundosPredeterminada);
        const lineasPorGrupo = Number(req.body.lineasPorGrupoPredeterminado);
        const intervalo = Number(req.body.intervaloMinutosPredeterminado);
        const limiteDestinatarios = Number(req.body.maximoDestinatariosPorEstado);
        const temaSolicitado = req.body.temaVisual ?? actual.temaVisual;
        const temaVisual = String(temaSolicitado || '').trim().toLowerCase();

        if (!temasVisuales.has(temaVisual)) {
            return responderError(res, 'El tema visual seleccionado no es válido.');
        }
        if (
            !Number.isInteger(limiteFallos)
            || limiteFallos < 1
            || limiteFallos > 10
        ) {
            return responderError(
                res,
                'El corte de seguridad debe estar entre 1 y 10 líneas con fallos.'
            );
        }
        if (!modosRitmo.has(modoRitmo)) {
            return responderError(
                res,
                'El modo de ritmo predeterminado no es válido.'
            );
        }
        if (
            !Number.isInteger(intervaloSegundos)
            || intervaloSegundos < 10
            || intervaloSegundos > 3600
        ) {
            return responderError(
                res,
                'El intervalo secuencial debe estar entre 10 y 3600 segundos.'
            );
        }
        if (
            !Number.isInteger(variacionSegundos)
            || variacionSegundos < 0
            || variacionSegundos > 30
            || variacionSegundos > intervaloSegundos
        ) {
            return responderError(
                res,
                'La distribución de carga debe estar entre 0 y 30 segundos y no superar el intervalo base.'
            );
        }
        if (
            !Number.isInteger(lineasPorGrupo)
            || lineasPorGrupo < 1
            || lineasPorGrupo > 10
        ) {
            return responderError(
                res,
                'Las líneas por grupo deben estar entre 1 y 10.'
            );
        }
        if (!Number.isFinite(intervalo) || intervalo < 0 || intervalo > 1440) {
            return responderError(
                res,
                'El intervalo debe estar entre 0 y 1440 minutos.'
            );
        }
        if (
            !Number.isInteger(limiteDestinatarios)
            || limiteDestinatarios < minimoDestinatarios
            || limiteDestinatarios > maximoDestinatarios
        ) {
            return responderError(
                res,
                `Los destinatarios por estado deben estar entre ` +
                    `${minimoDestinatarios} y ${maximoDestinatarios}.`
            );
        }

        const nuevaConfiguracion = {
            ...actual,
            limiteFallosSeguridad: limiteFallos,
            notificaciones: req.body.notificaciones !== false,
            mantenerEnSegundoPlano:
                req.body.mantenerEnSegundoPlano !== false,
            iniciarConWindows:
                req.body.iniciarConWindows !== false,
            agendarMutuosSinUsuario:
                req.body.agendarMutuosSinUsuario === undefined
                    ? actual.agendarMutuosSinUsuario === true
                    : req.body.agendarMutuosSinUsuario === true,
            temaVisual,
            modoRitmoPredeterminado: modoRitmo,
            intervaloSegundosPredeterminado: intervaloSegundos,
            variacionSegundosPredeterminada: variacionSegundos,
            lineasPorGrupoPredeterminado: lineasPorGrupo,
            intervaloMinutosPredeterminado: intervalo,
            maximoDestinatariosPorEstado: limiteDestinatarios
        };

        try {
            aplicarPreferenciasEscritorio({
                mantenerEnSegundoPlano:
                    nuevaConfiguracion.mantenerEnSegundoPlano,
                iniciarConWindows:
                    nuevaConfiguracion.iniciarConWindows
            });
        } catch (error) {
            return res.status(500).json({
                error:
                    error?.message
                    || 'No se pudieron aplicar las preferencias de inicio de ZeroOne.'
            });
        }

        guardarConfiguracion(nuevaConfiguracion);
        return res.json({
            mensaje: 'Configuración guardada.',
            configuracion: nuevaConfiguracion
        });
    });
}

module.exports = {
    registrarRutasConfiguracion
};
