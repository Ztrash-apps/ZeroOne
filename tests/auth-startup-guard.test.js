'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const {
    BufferJSON,
    initAuthCreds
} = require('@whiskeysockets/baileys');

const RAIZ = path.resolve(__dirname, '..');

function cargarGuardia(rutaDatos) {
    for (const carpeta of ['sesiones', 'programados', 'uploads', 'historial']) {
        const destino = path.join(rutaDatos, carpeta);
        fs.mkdirSync(destino, { recursive: true });
        fs.writeFileSync(path.join(destino, '.prueba-interna'), '');
    }
    const archivo = path.join(RAIZ, 'src', 'bot.js');
    const original = fs.readFileSync(archivo, 'utf8');
    const corte = original.indexOf('\napp.listen(');
    assert.ok(corte > 0);
    const anterior = process.env.ZEROONE_DATA_DIR;
    process.env.ZEROONE_DATA_DIR = rutaDatos;
    try {
        const fuente = original.slice(0, corte) + `
            module.exports = {
                crearEstadoAutenticacionPlano,
                cerrarAlmacenAutenticacionLinea,
                cerrarBackendSeguro,
                agregarLineaPrueba(linea) {
                    lineas.set(linea.id, linea);
                },
                establecerColaPublicacionesPrueba(promesa) {
                    colaPublicaciones = promesa;
                },
                agregarTareaEliminacionEstadosPrueba(promesa) {
                    const tarea = Promise.resolve(promesa).finally(() => {
                        tareasEliminacionEstadosEnCurso.delete(tarea);
                    });
                    tareasEliminacionEstadosEnCurso.add(tarea);
                }
            };
        `;
        const modulo = new Module(archivo, module);
        modulo.filename = archivo;
        modulo.paths = Module._nodeModulePaths(path.dirname(archivo));
        modulo._compile(fuente, archivo);
        return modulo.exports;
    } finally {
        if (anterior === undefined) delete process.env.ZEROONE_DATA_DIR;
        else process.env.ZEROONE_DATA_DIR = anterior;
    }
}

test('el arranque plaintext nunca reemplaza una sesión existente por un QR', async () => {
    const temporal = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-auth-guard-'));
    try {
        const {
            crearEstadoAutenticacionPlano,
            cerrarAlmacenAutenticacionLinea
        } = cargarGuardia(temporal);
        const carpetaCorrupta = path.join(temporal, 'sesiones', 'corrupta');
        fs.mkdirSync(carpetaCorrupta, { recursive: true });
        fs.writeFileSync(path.join(carpetaCorrupta, 'creds.json'), '{invalido');
        await assert.rejects(
            () => crearEstadoAutenticacionPlano({
                nombre: 'L1',
                vinculacionPendiente: false
            }, carpetaCorrupta),
            error => error?.code === 'AUTH_PLAINTEXT_CREDS_INVALID'
        );

        const carpetaFaltante = path.join(temporal, 'sesiones', 'faltante');
        fs.mkdirSync(carpetaFaltante, { recursive: true });
        await assert.rejects(
            () => crearEstadoAutenticacionPlano({
                nombre: 'L2',
                vinculacionPendiente: false
            }, carpetaFaltante),
            error => error?.code === 'AUTH_PLAINTEXT_IDENTITY_MISSING'
        );
        assert.equal(
            fs.existsSync(path.join(carpetaFaltante, 'creds.json')),
            false
        );

        const carpetaVinculada = path.join(temporal, 'sesiones', 'vinculada');
        fs.mkdirSync(carpetaVinculada, { recursive: true });
        const credenciales = initAuthCreds();
        credenciales.me = {
            id: '595000000020:1@s.whatsapp.net',
            name: 'L3'
        };
        fs.writeFileSync(
            path.join(carpetaVinculada, 'creds.json'),
            JSON.stringify(credenciales, BufferJSON.replacer)
        );
        const autenticacion = await crearEstadoAutenticacionPlano({
            nombre: 'L3',
            vinculacionPendiente: false
        }, carpetaVinculada);
        assert.equal(
            autenticacion.state.creds.me.id,
            credenciales.me.id
        );

        let resolverGuardado;
        let cierreTerminado = false;
        const guardadoPendiente = new Promise(resolve => {
            resolverGuardado = resolve;
        });
        const cierre = cerrarAlmacenAutenticacionLinea({
            nombre: 'L4',
            cerrarAlmacenAutenticacion: null,
            promesaCierreAlmacenAutenticacion: Promise.resolve(),
            promesaGuardadoCredenciales: guardadoPendiente
        }).then(() => {
            cierreTerminado = true;
        });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(cierreTerminado, false);
        resolverGuardado();
        await cierre;
        assert.equal(cierreTerminado, true);
    } finally {
        fs.rmSync(temporal, { recursive: true, force: true });
    }
});

test('el cierre de autenticacion es single-flight y reintenta sin concurrencia', async () => {
    const temporal = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-auth-close-'));
    try {
        const { cerrarAlmacenAutenticacionLinea } = cargarGuardia(temporal);
        let intentosCierre = 0;
        let cierresConcurrentes = 0;
        let maximoConcurrente = 0;
        let guardadosCompletos = 0;
        let liberarPrimerCierre;
        const primerCierrePendiente = new Promise(resolve => {
            liberarPrimerCierre = resolve;
        });
        const cerrar = async () => {
            intentosCierre += 1;
            cierresConcurrentes += 1;
            maximoConcurrente = Math.max(
                maximoConcurrente,
                cierresConcurrentes
            );
            try {
                if (intentosCierre === 1) {
                    await primerCierrePendiente;
                    throw new Error('fallo sintetico de cierre');
                }
            } finally {
                cierresConcurrentes -= 1;
            }
        };
        const linea = {
            nombre: 'L5',
            cerrarAlmacenAutenticacion: cerrar,
            guardarCredencialesActuales: async () => {
                guardadosCompletos += 1;
            },
            contextoAutenticacion: null,
            promesaGuardadoCredenciales: Promise.resolve(),
            promesaCierreAlmacenAutenticacion: Promise.resolve(),
            cierreAlmacenEnCurso: null,
            falloPersistenciaCredenciales: null
        };

        const primero = cerrarAlmacenAutenticacionLinea(linea);
        const simultaneo = cerrarAlmacenAutenticacionLinea(linea);
        assert.equal(primero, simultaneo);
        liberarPrimerCierre();
        await assert.rejects(primero, /cerrar y confirmar|fallo sintetico/u);
        await assert.rejects(simultaneo);
        assert.equal(intentosCierre, 1);
        assert.equal(maximoConcurrente, 1);

        await cerrarAlmacenAutenticacionLinea(linea);
        assert.equal(intentosCierre, 2);
        assert.equal(maximoConcurrente, 1);
        assert.equal(guardadosCompletos, 2);
        assert.equal(linea.falloPersistenciaCredenciales, null);
    } finally {
        fs.rmSync(temporal, { recursive: true, force: true });
    }
});

test('el cierre espera la confirmacion real del socket y un guardado tardio', async () => {
    const temporal = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-auth-late-'));
    try {
        const { cerrarAlmacenAutenticacionLinea } = cargarGuardia(temporal);
        let confirmarSocket;
        const promesaCierreSocket = new Promise(resolve => {
            confirmarSocket = resolve;
        });
        let completarGuardado;
        const guardadoTardio = new Promise(resolve => {
            completarGuardado = resolve;
        });
        let cierreTerminado = false;
        const contexto = {
            aceptandoCredenciales: true,
            socketCreado: true,
            socketCerrado: false,
            promesaCierreSocket
        };
        const linea = {
            nombre: 'L6',
            cerrarAlmacenAutenticacion: async () => {},
            guardarCredencialesActuales: async () => {},
            contextoAutenticacion: contexto,
            promesaGuardadoCredenciales: Promise.resolve(),
            promesaCierreAlmacenAutenticacion: Promise.resolve(),
            cierreAlmacenEnCurso: null,
            falloPersistenciaCredenciales: null
        };

        const cierre = cerrarAlmacenAutenticacionLinea(linea).then(() => {
            cierreTerminado = true;
        });
        await new Promise(resolve => setTimeout(resolve, 600));
        assert.equal(cierreTerminado, false);
        assert.equal(contexto.aceptandoCredenciales, true);

        linea.promesaGuardadoCredenciales = guardadoTardio;
        contexto.socketCerrado = true;
        confirmarSocket();
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(cierreTerminado, false);

        completarGuardado();
        await cierre;
        assert.equal(cierreTerminado, true);
        assert.equal(contexto.aceptandoCredenciales, false);
    } finally {
        fs.rmSync(temporal, { recursive: true, force: true });
    }
});

test('el backend no confirma salida mientras una publicacion sigue pendiente', async () => {
    const temporal = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroone-backend-close-'));
    try {
        const {
            cerrarBackendSeguro,
            agregarLineaPrueba,
            establecerColaPublicacionesPrueba
        } = cargarGuardia(temporal);
        let liberarPublicacion;
        const publicacionPendiente = new Promise(resolve => {
            liberarPublicacion = resolve;
        });
        let cierresAlmacen = 0;
        agregarLineaPrueba({
            id: 'linea-cierre',
            nombre: 'L7',
            socket: null,
            cerrarAlmacenAutenticacion: async () => {
                cierresAlmacen += 1;
            },
            guardarCredencialesActuales: async () => {},
            contextoAutenticacion: null,
            promesaGuardadoCredenciales: Promise.resolve(),
            promesaCierreAlmacenAutenticacion: Promise.resolve(),
            cierreAlmacenEnCurso: null,
            falloPersistenciaCredenciales: null,
            promesaActividadContactos: Promise.resolve(),
            actividadContactosCargada: false,
            actividadContactosSucia: false
        });
        establecerColaPublicacionesPrueba(publicacionPendiente);

        assert.equal(await cerrarBackendSeguro(1000), false);
        assert.equal(cierresAlmacen, 0);

        liberarPublicacion();
        assert.equal(await cerrarBackendSeguro(3000), true);
        assert.equal(cierresAlmacen, 1);
    } finally {
        fs.rmSync(temporal, { recursive: true, force: true });
    }
});

test('el backend no confirma salida mientras elimina estados activos', async () => {
    const temporal = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroone-state-delete-close-')
    );
    try {
        const {
            cerrarBackendSeguro,
            agregarLineaPrueba,
            agregarTareaEliminacionEstadosPrueba
        } = cargarGuardia(temporal);
        let liberarEliminacion;
        const eliminacionPendiente = new Promise(resolve => {
            liberarEliminacion = resolve;
        });
        let cierresAlmacen = 0;
        agregarLineaPrueba({
            id: 'linea-eliminacion-cierre',
            nombre: 'L8',
            socket: null,
            cerrarAlmacenAutenticacion: async () => {
                cierresAlmacen += 1;
            },
            guardarCredencialesActuales: async () => {},
            contextoAutenticacion: null,
            promesaGuardadoCredenciales: Promise.resolve(),
            promesaCierreAlmacenAutenticacion: Promise.resolve(),
            cierreAlmacenEnCurso: null,
            falloPersistenciaCredenciales: null,
            promesaActividadContactos: Promise.resolve(),
            actividadContactosCargada: false,
            actividadContactosSucia: false
        });
        agregarTareaEliminacionEstadosPrueba(eliminacionPendiente);

        assert.equal(await cerrarBackendSeguro(1000), false);
        assert.equal(
            cierresAlmacen,
            0,
            'no debe cerrar la sesión antes de persistir la revocación'
        );

        liberarEliminacion();
        assert.equal(await cerrarBackendSeguro(3000), true);
        assert.equal(cierresAlmacen, 1);
    } finally {
        fs.rmSync(temporal, { recursive: true, force: true });
    }
});
