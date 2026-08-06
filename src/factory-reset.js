'use strict';

const fs = require('fs');
const path = require('path');

const NOMBRE_PERFIL_HISTORICO = 'autostatues';
const NOMBRE_PERFIL_RESIDUAL = 'ZeroOne';
const NOMBRE_CARPETA_IA = 'AutoStatues';
const NOMBRE_SUBCARPETA_IA = 'ia';
const ARCHIVO_MARCADOR_INSTALACION_LIMPIA = '.zeroone-instalacion-limpia';

function resolverRaizSegura(valor, etiqueta) {
    const texto = String(valor || '').trim();
    if (!texto) {
        throw new Error(`La raiz de ${etiqueta} no es valida.`);
    }

    const ruta = path.resolve(texto);
    const raiz = path.parse(ruta).root;

    if (!ruta || ruta === raiz) {
        throw new Error(`La raiz de ${etiqueta} no es valida.`);
    }

    return ruta;
}

function rutaDentroDe(raiz, ...segmentos) {
    const destino = path.resolve(raiz, ...segmentos);
    const relativo = path.relative(raiz, destino);

    if (
        !relativo ||
        relativo.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativo)
    ) {
        throw new Error('La ruta de restablecimiento quedó fuera de su raíz permitida.');
    }

    return destino;
}

function crearPlanRestablecimiento({ rutaAppData, rutaLocalAppData } = {}) {
    const appData = resolverRaizSegura(rutaAppData, 'datos de aplicación');
    const localAppData = resolverRaizSegura(
        rutaLocalAppData,
        'datos locales de aplicación'
    );
    const perfilHistorico = rutaDentroDe(appData, NOMBRE_PERFIL_HISTORICO);
    const perfilResidual = rutaDentroDe(appData, NOMBRE_PERFIL_RESIDUAL);
    const carpetaIa = rutaDentroDe(
        rutaDentroDe(localAppData, NOMBRE_CARPETA_IA),
        NOMBRE_SUBCARPETA_IA
    );

    return {
        perfilHistorico,
        perfilResidual,
        carpetaIa,
        carpetaDatosNueva: rutaDentroDe(
            perfilHistorico,
            'datos'
        )
    };
}

function borrarDirectorio(fsModulo, ruta) {
    fsModulo.rmSync(ruta, {
        recursive: true,
        force: true,
        maxRetries: 12,
        retryDelay: 250
    });
}

function debeOmitirMigracionLegada(carpetaDatos, fsModulo = fs) {
    const rutaDatos = resolverRaizSegura(carpetaDatos, 'datos de ZeroOne');
    return fsModulo.existsSync(
        path.join(rutaDatos, ARCHIVO_MARCADOR_INSTALACION_LIMPIA)
    );
}

function ejecutarRestablecimientoLocal(opciones = {}) {
    const fsModulo = opciones.fsModulo || fs;
    const plan = crearPlanRestablecimiento(opciones);

    borrarDirectorio(fsModulo, plan.perfilHistorico);
    borrarDirectorio(fsModulo, plan.perfilResidual);
    borrarDirectorio(fsModulo, plan.carpetaIa);

    fsModulo.mkdirSync(plan.carpetaDatosNueva, { recursive: true });
    fsModulo.writeFileSync(
        path.join(
            plan.carpetaDatosNueva,
            ARCHIVO_MARCADOR_INSTALACION_LIMPIA
        ),
        'ZeroOne restableció este perfil y no debe recuperar migraciones antiguas.\n',
        'utf8'
    );

    return plan;
}

module.exports = {
    ARCHIVO_MARCADOR_INSTALACION_LIMPIA,
    crearPlanRestablecimiento,
    debeOmitirMigracionLegada,
    ejecutarRestablecimientoLocal
};
