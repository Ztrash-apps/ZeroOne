'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const {
    MODELO,
    RUNTIMES,
    crearRuntimeIALocal,
    extraerZipSeguro
} = require('../src/local-ai-runtime');

function crearZipEntradas(entradas) {
    const locales = [];
    const centrales = [];
    let offset = 0;
    for (const entrada of entradas) {
        const nombreBuffer = Buffer.from(entrada.nombre, 'utf8');
        const datos = Buffer.from(entrada.contenido || '');
        const metodo = entrada.metodo ?? 8;
        const comprimido = metodo === 0 ? datos : zlib.deflateRawSync(datos);
        const crc = zlib.crc32(datos) >>> 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(metodo, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(comprimido.length, 18);
        local.writeUInt32LE(datos.length, 22);
        local.writeUInt16LE(nombreBuffer.length, 26);
        const localCompleto = Buffer.concat([local, nombreBuffer, comprimido]);
        locales.push(localCompleto);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(metodo, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(comprimido.length, 20);
        central.writeUInt32LE(datos.length, 24);
        central.writeUInt16LE(nombreBuffer.length, 28);
        central.writeUInt32LE(offset, 42);
        centrales.push(Buffer.concat([central, nombreBuffer]));
        offset += localCompleto.length;
    }
    const centralCompleto = Buffer.concat(centrales);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entradas.length, 8);
    eocd.writeUInt16LE(entradas.length, 10);
    eocd.writeUInt32LE(centralCompleto.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locales, centralCompleto, eocd]);
}

function crearZip(nombre, contenido) {
    return crearZipEntradas([{ nombre, contenido }]);
}

function temporal(t) {
    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'autostatues-ia-'));
    t.after(() => fs.rmSync(carpeta, { recursive: true, force: true }));
    return carpeta;
}

test('el manifiesto fija modelo y runtimes con tamaño, SHA y HTTPS', () => {
    assert.equal(MODELO.nombre, 'Qwen3 1.7B Q4_K_M');
    assert.equal(MODELO.sha256.length, 64);
    assert.ok(MODELO.bytes > 1_200_000_000);
    assert.equal(new URL(MODELO.url).protocol, 'https:');
    assert.deepEqual(RUNTIMES.map(item => item.id), ['cpu', 'vulkan']);
    for (const runtime of RUNTIMES) {
        assert.equal(runtime.sha256.length, 64);
        assert.equal(new URL(runtime.url).protocol, 'https:');
    }
});

test('el extractor acepta un ZIP válido y bloquea traversal', t => {
    const carpeta = temporal(t);
    const valido = path.join(carpeta, 'valido.zip');
    fs.writeFileSync(valido, crearZip('bin/llama-server.exe', 'runtime-prueba'));
    const destino = path.join(carpeta, 'destino');
    const resultado = extraerZipSeguro(valido, destino, 1024);
    assert.equal(resultado.extraidos, 1);
    assert.equal(
        fs.readFileSync(path.join(destino, 'bin', 'llama-server.exe'), 'utf8'),
        'runtime-prueba'
    );

    const malicioso = path.join(carpeta, 'malicioso.zip');
    fs.writeFileSync(malicioso, crearZip('../fuera.exe', 'no'));
    assert.throws(
        () => extraerZipSeguro(malicioso, path.join(carpeta, 'otro'), 1024),
        error => error.codigo === 'RUNTIME_ZIP'
    );
    assert.equal(fs.existsSync(path.join(carpeta, 'fuera.exe')), false);
});

test('el extractor parte del EOCD, conserva directorios e ignora firmas en datos', t => {
    const carpeta = temporal(t);
    const ruta = path.join(carpeta, 'runtime.zip');
    fs.writeFileSync(ruta, crearZipEntradas([
        { nombre: 'bin/', contenido: '', metodo: 0 },
        {
            nombre: 'bin/llama-server.exe',
            contenido: Buffer.from('antes-PK\u0001\u0002-despues'),
            metodo: 0
        }
    ]));
    const destino = path.join(carpeta, 'extraido');
    const resultado = extraerZipSeguro(ruta, destino, 1024);
    assert.equal(resultado.extraidos, 1);
    assert.equal(fs.statSync(path.join(destino, 'bin')).isDirectory(), true);
    assert.equal(
        fs.readFileSync(path.join(destino, 'bin', 'llama-server.exe'), 'utf8'),
        'antes-PK\u0001\u0002-despues'
    );
});

test('un .part completo y válido se promueve sin abrir la red', async t => {
    const carpeta = temporal(t);
    let llamadasRed = 0;
    const runtime = crearRuntimeIALocal({
        carpeta,
        fetch: async () => {
            llamadasRed += 1;
            throw new Error('La red no debía usarse');
        }
    });
    const contenido = Buffer.from('asset-completo');
    const sha256 = crypto.createHash('sha256').update(contenido).digest('hex');
    const asset = {
        archivo: 'asset.bin',
        bytes: contenido.length,
        sha256,
        url: 'https://huggingface.co/asset.bin'
    };
    const final = path.join(carpeta, 'downloads', asset.archivo);
    const parcial = `${final}.${sha256.slice(0, 12)}.part`;
    fs.mkdirSync(path.dirname(parcial), { recursive: true });
    fs.writeFileSync(parcial, contenido);

    await runtime.descargarArchivo(asset, final, 0, new AbortController().signal);

    assert.equal(llamadasRed, 0);
    assert.deepEqual(fs.readFileSync(final), contenido);
    assert.equal(fs.existsSync(parcial), false);
});

test('sigue manualmente una redirección oficial de Hugging Face y conserva el contenido', async t => {
    const carpeta = temporal(t);
    const contenido = Buffer.from('modelo-entregado-por-cdn-oficial');
    const sha256 = crypto.createHash('sha256').update(contenido).digest('hex');
    const asset = {
        id: 'prueba',
        archivo: 'modelo-redirigido.bin',
        bytes: contenido.length,
        sha256,
        url: 'https://huggingface.co/organizacion/modelo/resolve/main/modelo.bin'
    };
    const solicitudes = [];
    const runtime = crearRuntimeIALocal({
        carpeta,
        fetch: async (url, opciones) => {
            solicitudes.push({ url: String(url), redirect: opciones.redirect });
            if (solicitudes.length === 1) {
                return new Response(null, {
                    status: 302,
                    headers: {
                        location: 'https://us.aws.cdn.hf.co/modelo.bin?firma=prueba'
                    }
                });
            }
            return new Response(contenido, { status: 200 });
        }
    });
    const final = path.join(carpeta, 'downloads', asset.archivo);

    const descargados = await runtime.descargarArchivo(
        asset,
        final,
        0,
        new AbortController().signal
    );

    assert.equal(descargados, contenido.length);
    assert.deepEqual(fs.readFileSync(final), contenido);
    assert.deepEqual(solicitudes, [
        { url: asset.url, redirect: 'manual' },
        {
            url: 'https://us.aws.cdn.hf.co/modelo.bin?firma=prueba',
            redirect: 'manual'
        }
    ]);
});

test('bloquea una redirección a un origen ajeno antes de solicitarlo', async t => {
    const carpeta = temporal(t);
    const contenido = Buffer.from('contenido-no-usado');
    const sha256 = crypto.createHash('sha256').update(contenido).digest('hex');
    const asset = {
        archivo: 'origen-ajeno.bin',
        bytes: contenido.length,
        sha256,
        url: 'https://huggingface.co/modelo.bin'
    };
    let solicitudes = 0;
    const runtime = crearRuntimeIALocal({
        carpeta,
        fetch: async () => {
            solicitudes += 1;
            return new Response(null, {
                status: 302,
                headers: { location: 'https://evil.example/modelo.bin' }
            });
        }
    });

    await assert.rejects(
        runtime.descargarArchivo(
            asset,
            path.join(carpeta, asset.archivo),
            0,
            new AbortController().signal
        ),
        error => error.codigo === 'DESCARGA_ORIGEN'
    );
    assert.equal(solicitudes, 1);
});

test('bloquea un hostname engañoso que solo contiene el dominio oficial', async t => {
    const carpeta = temporal(t);
    const contenido = Buffer.from('contenido-no-usado');
    const sha256 = crypto.createHash('sha256').update(contenido).digest('hex');
    const asset = {
        archivo: 'hostname-enganoso.bin',
        bytes: contenido.length,
        sha256,
        url: 'https://huggingface.co/modelo.bin'
    };
    let solicitudes = 0;
    const runtime = crearRuntimeIALocal({
        carpeta,
        fetch: async () => {
            solicitudes += 1;
            return new Response(null, {
                status: 302,
                headers: {
                    location: 'https://us.aws.cdn.hf.co.evil.example/modelo.bin'
                }
            });
        }
    });

    await assert.rejects(
        runtime.descargarArchivo(
            asset,
            path.join(carpeta, asset.archivo),
            0,
            new AbortController().signal
        ),
        error => error.codigo === 'DESCARGA_ORIGEN'
    );
    assert.equal(solicitudes, 1);
});

test('detiene una cadena de más de cinco redirecciones seguras', async t => {
    const carpeta = temporal(t);
    const contenido = Buffer.from('contenido-no-usado');
    const sha256 = crypto.createHash('sha256').update(contenido).digest('hex');
    const asset = {
        archivo: 'demasiadas-redirecciones.bin',
        bytes: contenido.length,
        sha256,
        url: 'https://huggingface.co/modelo.bin'
    };
    let solicitudes = 0;
    const runtime = crearRuntimeIALocal({
        carpeta,
        fetch: async () => {
            solicitudes += 1;
            return new Response(null, {
                status: 302,
                headers: {
                    location: `https://us.aws.cdn.hf.co/salto-${solicitudes}.bin`
                }
            });
        }
    });

    await assert.rejects(
        runtime.descargarArchivo(
            asset,
            path.join(carpeta, asset.archivo),
            0,
            new AbortController().signal
        ),
        error => error.codigo === 'DESCARGA_REDIRECCIONES'
    );
    assert.equal(solicitudes, 6);
});

test('una carpeta existente solo se reutiliza con manifiesto y hashes válidos', async t => {
    const carpeta = temporal(t);
    const zip = crearZip('bin/llama-server.exe', 'runtime-original');
    const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
    const asset = {
        id: 'cpu',
        archivo: 'runtime-prueba.zip',
        bytes: zip.length,
        sha256,
        url: 'https://github.com/runtime-prueba.zip'
    };
    let descargas = 0;
    const runtime = crearRuntimeIALocal({
        carpeta,
        fetch: async () => {
            descargas += 1;
            return new Response(zip, { status: 200 });
        }
    });
    const existenteSinManifiesto = path.join(
        runtime.rutaRuntime('cpu'),
        'bin',
        'llama-server.exe'
    );
    fs.mkdirSync(path.dirname(existenteSinManifiesto), { recursive: true });
    fs.writeFileSync(existenteSinManifiesto, 'runtime-no-confiable');
    const arbol = await runtime.instalarRuntime(
        asset,
        0,
        new AbortController().signal
    );
    assert.equal(descargas, 1);
    assert.equal(arbol.length, 1);
    assert.equal(arbol[0].sha256.length, 64);

    fs.writeFileSync(runtime.rutaManifiesto(), `${JSON.stringify({
        version: 2,
        modelo: MODELO.archivo,
        modeloSha256: MODELO.sha256,
        runtime: 'b10047',
        runtimeHashes: Object.fromEntries(RUNTIMES.map(item => [item.id, item.sha256])),
        runtimeArboles: { cpu: arbol, vulkan: arbol }
    })}\n`);

    await runtime.instalarRuntime(asset, 0, new AbortController().signal);
    assert.equal(descargas, 1, 'un árbol íntegro se reutiliza sin descargar');

    const ejecutable = path.join(runtime.rutaRuntime('cpu'), 'bin', 'llama-server.exe');
    fs.writeFileSync(ejecutable, 'runtime-alterado');
    assert.equal(fs.statSync(ejecutable).size, Buffer.byteLength('runtime-original'));
    await runtime.instalarRuntime(asset, 0, new AbortController().signal);
    assert.equal(descargas, 2, 'un archivo alterado obliga a reinstalar');

    fs.writeFileSync(path.join(runtime.rutaRuntime('cpu'), 'archivo-anadido.dll'), 'extra');
    await runtime.instalarRuntime(asset, 0, new AbortController().signal);
    assert.equal(descargas, 3, 'un archivo añadido también invalida el árbol');

    fs.rmSync(path.join(runtime.rutaRuntime('cpu'), 'bin', 'llama-server.exe'));
    await runtime.instalarRuntime(asset, 0, new AbortController().signal);
    assert.equal(descargas, 4, 'un archivo faltante también invalida el árbol');
});

test('llama-server se inicia offline con contexto de 4096', async t => {
    const carpeta = temporal(t);
    const ejecutable = path.join(carpeta, 'runtime', 'b10047', 'cpu', 'llama-server.exe');
    fs.mkdirSync(path.dirname(ejecutable), { recursive: true });
    fs.writeFileSync(ejecutable, 'prueba');
    let argumentos;
    const proceso = new EventEmitter();
    proceso.exitCode = null;
    proceso.killed = false;
    proceso.stdout = new EventEmitter();
    proceso.stderr = new EventEmitter();
    proceso.kill = () => {
        proceso.killed = true;
        proceso.exitCode = 0;
        queueMicrotask(() => proceso.emit('exit', 0));
        return true;
    };
    const runtime = crearRuntimeIALocal({
        carpeta,
        fetch: async () => ({ ok: true }),
        spawn: (_archivo, args) => {
            argumentos = args;
            return proceso;
        }
    });

    await runtime.iniciarMotor('cpu');

    assert.ok(argumentos.includes('--offline'));
    assert.equal(argumentos[argumentos.indexOf('--ctx-size') + 1], '4096');
    assert.equal(argumentos[argumentos.indexOf('--sleep-idle-seconds') + 1], '300');
    runtime.detener();
});

test('un fallo 5xx de Vulkan cierra ese motor y reintenta una vez en CPU', async t => {
    const runtime = crearRuntimeIALocal({ carpeta: temporal(t) });
    const motores = [];
    const crearProceso = () => {
        const proceso = new EventEmitter();
        proceso.exitCode = null;
        proceso.killed = false;
        proceso.kill = () => {
            proceso.killed = true;
            queueMicrotask(() => {
                proceso.exitCode = 0;
                proceso.emit('exit', 0);
                proceso.emit('close', 0);
            });
            return true;
        };
        return proceso;
    };
    runtime.asegurarIniciada = async () => {
        if (runtime.motorActivo) return runtime;
        const motor = runtime.vulkanNoDisponible ? 'cpu' : 'vulkan';
        motores.push(motor);
        runtime.motorActivo = motor;
        runtime.puerto = motor === 'vulkan' ? 31001 : 31002;
        runtime.apiKey = `key-${motor}`;
        runtime.proceso = crearProceso();
        runtime.procesosVivos.add(runtime.proceso);
        return runtime;
    };
    let llamadas = 0;
    runtime.fetch = async () => {
        llamadas += 1;
        if (llamadas === 1) return { ok: false, status: 500 };
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
    };

    const respuesta = await runtime.completar({ messages: [] });

    assert.equal(respuesta.choices.length, 1);
    assert.deepEqual(motores, ['vulkan', 'cpu']);
    assert.equal(llamadas, 2);
    assert.equal(runtime.motorActivo, 'cpu');
    assert.equal(runtime.vulkanNoDisponible, true);
    runtime.detener();
});

test('un motor que no cerró bloquea otro inicio en vez de duplicarlo', async t => {
    let procesosNuevos = 0;
    const runtime = crearRuntimeIALocal({
        carpeta: temporal(t),
        spawn: () => {
            procesosNuevos += 1;
            throw new Error('no debía iniciar otro proceso');
        }
    });
    const huerfano = new EventEmitter();
    huerfano.exitCode = null;
    huerfano.killed = true;
    runtime.procesosVivos.add(huerfano);

    await assert.rejects(
        runtime.asegurarIniciada(),
        error => error.codigo === 'MOTOR_NO_CIERRA'
    );
    assert.equal(procesosNuevos, 0);
});

test('una generación cancelada no crea el proceso después de reservar puerto', async t => {
    const carpeta = temporal(t);
    const ejecutable = path.join(
        carpeta,
        'runtime',
        'b10047',
        'cpu',
        'llama-server.exe'
    );
    fs.mkdirSync(path.dirname(ejecutable), { recursive: true });
    fs.writeFileSync(ejecutable, 'prueba');
    let procesosNuevos = 0;
    const runtime = crearRuntimeIALocal({
        carpeta,
        spawn: () => {
            procesosNuevos += 1;
            throw new Error('no debía iniciar');
        }
    });
    runtime.generacionInicio = 2;

    await assert.rejects(
        runtime.iniciarMotor('cpu', 1),
        error => error.codigo === 'IA_CANCELADA'
    );
    assert.equal(procesosNuevos, 0);
});

test('cancelar una descarga esperada deja estado pausado y sin error', async t => {
    const runtime = crearRuntimeIALocal({ carpeta: temporal(t), fetch: async () => null });
    runtime.instalada = () => false;
    runtime.descargarArchivo = async (_asset, _ruta, _previos, signal) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelada')), { once: true });
    });
    const descarga = runtime.descargar();
    assert.equal(runtime.detenerDescarga(), true);
    await assert.rejects(descarga);
    assert.equal(runtime.obtenerEstado().estado, 'pausada');
    assert.equal(runtime.obtenerEstado().error, null);
});

test('cancelar el inicio durante el fallback CPU no convierte la pausa en error', async t => {
    const carpeta = temporal(t);
    const modeloPrueba = Buffer.from('modelo-prueba');
    const originalCrearHash = crypto.createHash;
    const arboles = {};
    for (const id of ['cpu', 'vulkan']) {
        const contenido = Buffer.from(`runtime-${id}`);
        const ejecutable = path.join(carpeta, 'runtime', 'b10047', id, 'llama-server.exe');
        fs.mkdirSync(path.dirname(ejecutable), { recursive: true });
        fs.writeFileSync(ejecutable, contenido);
        arboles[id] = [{
            ruta: 'llama-server.exe',
            bytes: contenido.length,
            sha256: originalCrearHash('sha256').update(contenido).digest('hex')
        }];
    }
    const rutaModelo = path.join(carpeta, 'models', MODELO.archivo);
    fs.mkdirSync(path.dirname(rutaModelo), { recursive: true });
    fs.writeFileSync(rutaModelo, modeloPrueba);
    fs.writeFileSync(path.join(carpeta, 'instalacion.json'), `${JSON.stringify({
        version: 2,
        modelo: MODELO.archivo,
        modeloSha256: MODELO.sha256,
        runtime: 'b10047',
        runtimeHashes: Object.fromEntries(RUNTIMES.map(item => [item.id, item.sha256])),
        runtimeArboles: arboles
    })}\n`);

    crypto.createHash = algoritmo => {
        const bloques = [];
        return {
            update(bloque) {
                bloques.push(Buffer.from(bloque));
                return this;
            },
            digest(formato) {
                const contenido = Buffer.concat(bloques);
                if (contenido.equals(modeloPrueba)) {
                    return formato === 'hex' ? MODELO.sha256 : Buffer.from(MODELO.sha256, 'hex');
                }
                const hash = originalCrearHash(algoritmo);
                hash.update(contenido);
                return hash.digest(formato);
            }
        };
    };
    t.after(() => {
        crypto.createHash = originalCrearHash;
    });

    const runtime = crearRuntimeIALocal({ carpeta, fetch: async () => ({ ok: true }) });
    runtime.instalada = () => true;
    let avisarCpu;
    const cpuIniciado = new Promise(resolve => { avisarCpu = resolve; });
    runtime.iniciarMotor = async id => {
        if (id === 'vulkan') throw new Error('Vulkan no disponible');
        return new Promise((resolve, reject) => {
            const proceso = new EventEmitter();
            proceso.exitCode = null;
            proceso.killed = false;
            proceso.kill = () => {
                proceso.killed = true;
                proceso.exitCode = 0;
                queueMicrotask(() => {
                    proceso.emit('exit', 0);
                    reject(new Error('CPU detenido'));
                });
                return true;
            };
            runtime.procesoIniciando = proceso;
            avisarCpu();
        });
    };
    const controlador = new AbortController();
    const analisis = runtime.completar({}, { signal: controlador.signal });
    await cpuIniciado;
    controlador.abort();

    await assert.rejects(analisis, error => error.codigo === 'IA_CANCELADA');
    assert.equal(runtime.obtenerEstado().estado, 'lista');
    assert.equal(runtime.obtenerEstado().error, null);
});

test('desinstalar espera el cierre del proceso antes de borrar archivos', async t => {
    const carpeta = temporal(t);
    const marcador = path.join(carpeta, 'runtime', 'marcador.txt');
    fs.mkdirSync(path.dirname(marcador), { recursive: true });
    fs.writeFileSync(marcador, 'activo');
    const proceso = new EventEmitter();
    proceso.exitCode = null;
    proceso.killed = false;
    let archivoPresenteAlCerrar = false;
    proceso.kill = () => {
        proceso.killed = true;
        setTimeout(() => {
            archivoPresenteAlCerrar = fs.existsSync(marcador);
            proceso.exitCode = 0;
            proceso.emit('exit', 0);
        }, 35);
        return true;
    };
    const runtime = crearRuntimeIALocal({ carpeta, fetch: null });
    runtime.proceso = proceso;
    const inicio = Date.now();

    await runtime.desinstalar();

    assert.equal(archivoPresenteAlCerrar, true);
    assert.ok(Date.now() - inicio >= 25);
    assert.equal(fs.existsSync(path.join(carpeta, 'runtime')), false);
});

test('una instalación vacía informa que no está lista sin iniciar procesos', t => {
    const runtime = crearRuntimeIALocal({ carpeta: temporal(t), fetch: null });
    const estado = runtime.obtenerEstado();
    assert.equal(estado.instalada, false);
    assert.equal(estado.ejecutando, false);
    assert.equal(estado.modelo.nombre, 'Qwen3 1.7B Q4_K_M');
    assert.ok(estado.descargaBytes > MODELO.bytes);
});
