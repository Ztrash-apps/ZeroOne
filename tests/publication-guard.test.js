const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const RAIZ_PROYECTO = path.resolve(__dirname, '..');
const ID_LINEA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function cargarBackendAislado(rutaDatos) {
    for (const carpeta of ['sesiones', 'programados', 'uploads', 'historial']) {
        const ruta = path.join(rutaDatos, carpeta);
        fs.mkdirSync(ruta, { recursive: true });
        fs.writeFileSync(path.join(ruta, '.prueba-interna'), '', 'utf8');
    }

    const archivo = path.join(RAIZ_PROYECTO, 'src', 'bot.js');
    const original = fs.readFileSync(archivo, 'utf8');
    const corte = original.indexOf('\napp.listen(');
    assert.ok(corte > 0, 'No se encontró el inicio del servidor');

    const variable = 'ZEROONE_DATA_DIR';
    const anterior = process.env[variable];
    process.env[variable] = rutaDatos;

    try {
        const fuente = original.slice(0, corte) + `
            module.exports = {
                reservarCampanaPublicacion,
                liberarCampanaPublicacion,
                lineaBloqueadaPorPublicacion,
                obtenerVistaBloqueoCampanaPublicacion,
                evaluarLineaParaPublicar,
                registrarPublicacionExitosaLinea,
                obtenerEstadoLimitesPublicacionLinea,
                registrarDesconexionCircuitBreaker,
                activarCircuitBreakerLimiteTemporal,
                obtenerVistaProteccionMiddleware,
                cargarConfiguracion,
                obtenerConfiguracion: () => ({ ...configuracion }),
                registrarLineaPrueba(linea) {
                    lineas.set(linea.id, linea);
                }
            };
        `;
        const modulo = new Module(archivo, module);
        modulo.filename = archivo;
        modulo.paths = Module._nodeModulePaths(path.dirname(archivo));
        modulo._compile(fuente, archivo);
        return modulo.exports;
    } finally {
        if (anterior === undefined) delete process.env[variable];
        else process.env[variable] = anterior;
    }
}

function crearLinea(id = ID_LINEA) {
    return {
        id,
        nombre: `Línea ${id.slice(0, 4)}`,
        etiqueta: 'activa',
        estado: 'conectado',
        socket: {},
        jid: '595999999999@s.whatsapp.net',
        eliminando: false,
        iniciando: false,
        reconexionManualEnCurso: false,
        conexionEnVerificacion: false,
        reconexionBloqueada: false,
        requiereRevisionEnvio: false,
        ultimaPublicacion: null,
        publicacionesRecientes: []
    };
}

test('guardas persistentes de campaña y línea (sin abrir WhatsApp)', async t => {
    const rutaDatos = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-publication-guard-')
    );

    try {
        fs.writeFileSync(
            path.join(rutaDatos, 'configuracion.json'),
            JSON.stringify({
                limiteFallosSeguridad: 1,
                modoRitmoPredeterminado: 'secuencial',
                intervaloSegundosPredeterminado: 45,
                variacionSegundosPredeterminada: 5,
                lineasPorGrupoPredeterminado: 10,
                intervaloMinutosPredeterminado: 5,
                maximoDestinatariosPorEstado: 500
            }),
            'utf8'
        );
        const backend = cargarBackendAislado(rutaDatos);
        backend.cargarConfiguracion();

        await t.test('migra configuración anterior con defaults prudentes', () => {
            const configuracion = backend.obtenerConfiguracion();
            assert.equal(configuracion.enfriamientoCampanasMinutos, 15);
            assert.equal(configuracion.limiteCampanasDiariasPorLinea, 12);
        });

        await t.test('reserva una sola campaña y bloquea todas sus líneas', () => {
            backend.registrarLineaPrueba(crearLinea());
            const token = backend.reservarCampanaPublicacion(
                [ID_LINEA],
                'prueba interna'
            );
            assert.equal(backend.lineaBloqueadaPorPublicacion(ID_LINEA), true);
            assert.equal(
                backend.obtenerVistaBloqueoCampanaPublicacion().fase,
                'en_cola'
            );
            assert.throws(
                () => backend.reservarCampanaPublicacion([], 'competidora'),
                error => error?.codigo === 'PUBLICACION_OCUPADA'
            );
            assert.equal(backend.liberarCampanaPublicacion(token), true);
            assert.equal(backend.lineaBloqueadaPorPublicacion(ID_LINEA), false);
        });

        await t.test('una tombstone no puede recibir una campaña nueva', () => {
            const linea = crearLinea();
            linea.eliminando = true;
            backend.registrarLineaPrueba(linea);
            assert.throws(
                () => backend.reservarCampanaPublicacion(
                    [linea.id],
                    'campaña contra tombstone'
                ),
                error => error?.codigo === 'LINEA_EN_ELIMINACION'
            );
        });

        await t.test('aplica enfriamiento y límite móvil de 24 horas', () => {
            const linea = crearLinea();
            const ahora = Date.now();
            linea.ultimaPublicacion = new Date(ahora - 60 * 1000).toISOString();
            let evaluacion = backend.evaluarLineaParaPublicar(linea);
            assert.equal(evaluacion.lista, false);
            assert.equal(
                evaluacion.codigoError,
                'ENFRIAMIENTO_PUBLICACION_LINEA'
            );

            linea.ultimaPublicacion = new Date(
                ahora - 30 * 60 * 1000
            ).toISOString();
            linea.publicacionesRecientes = Array.from({ length: 12 }, (_, i) =>
                new Date(ahora - (i + 1) * 60 * 60 * 1000).toISOString()
            );
            evaluacion = backend.evaluarLineaParaPublicar(linea);
            assert.equal(evaluacion.lista, false);
            assert.equal(evaluacion.codigoError, 'LIMITE_PUBLICACIONES_24H');
        });

        await t.test('registra una campaña exitosa para límites posteriores', () => {
            const linea = crearLinea();
            const registrada = backend.registrarPublicacionExitosaLinea(linea);
            const estado = backend.obtenerEstadoLimitesPublicacionLinea(linea);
            assert.equal(typeof registrada, 'string');
            assert.equal(estado.publicacionesUltimas24h, 1);
            assert.equal(estado.enEnfriamiento, true);
        });

        await t.test('HTTP 429 abre un bloqueo global respetando Retry-After', () => {
            const proteccion = backend.activarCircuitBreakerLimiteTemporal(
                crearLinea(),
                { statusCode: 429, retryAfter: 120 }
            );
            assert.equal(proteccion.activa, true);
            assert.equal(proteccion.codigo, '429');
            assert.ok(proteccion.segundosRestantes >= 119);
        });

        await t.test('abre el circuit breaker con tres líneas distintas', () => {
            for (let indice = 0; indice < 3; indice += 1) {
                backend.registrarDesconexionCircuitBreaker(
                    crearLinea(`${indice + 1}`.repeat(8) +
                        `-${indice + 1}`.repeat(4) +
                        `-4${indice + 1}`.repeat(3) +
                        `-8${indice + 1}`.repeat(3) +
                        `-${indice + 1}`.repeat(12)),
                    428,
                    'Cierre simulado'
                );
            }

            const proteccion = backend.obtenerVistaProteccionMiddleware();
            assert.equal(proteccion.activa, true);
            assert.equal(proteccion.codigo, 'CIRCUIT_BREAKER_DESCONEXIONES');
            assert.ok(proteccion.segundosRestantes > 0);
        });
    } finally {
        fs.rmSync(rutaDatos, { recursive: true, force: true });
    }
});
