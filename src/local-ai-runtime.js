'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');

const VERSION_RUNTIME = 'b10047';
const VERSION_MANIFIESTO = 2;
const MODELO = Object.freeze({
    nombre: 'Qwen3 1.7B Q4_K_M',
    archivo: 'Qwen3-1.7B-Q4_K_M.gguf',
    bytes: 1282439264,
    sha256: 'd2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5',
    url: 'https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF/resolve/daeb8e2d528a760970442092f6bf1e55c3b659eb/Qwen3-1.7B-Q4_K_M.gguf?download=true',
    licencia: 'Apache-2.0'
});
const RUNTIMES = Object.freeze([
    {
        id: 'cpu',
        archivo: `llama-${VERSION_RUNTIME}-bin-win-cpu-x64.zip`,
        bytes: 17958163,
        sha256: '987c529319d66ea070b45f27e6ec80429f385f28a28359c6cbc2f28f3adcd957',
        url: `https://github.com/ggml-org/llama.cpp/releases/download/${VERSION_RUNTIME}/llama-${VERSION_RUNTIME}-bin-win-cpu-x64.zip`
    },
    {
        id: 'vulkan',
        archivo: `llama-${VERSION_RUNTIME}-bin-win-vulkan-x64.zip`,
        bytes: 32734958,
        sha256: 'a7cb564cc335802f2cd1a2b65a195655462a10a4de544c761430b80b8fe0eaa0',
        url: `https://github.com/ggml-org/llama.cpp/releases/download/${VERSION_RUNTIME}/llama-${VERSION_RUNTIME}-bin-win-vulkan-x64.zip`
    }
]);

const HOSTS_DESCARGA = new Set([
    'huggingface.co',
    'cas-server.xethub.hf.co',
    'cas-server.xethub-eu.hf.co',
    'transfer.xethub.hf.co',
    'transfer.xethub-eu.hf.co',
    'cas-bridge.xethub.hf.co',
    'cas-bridge.xethub-eu.hf.co',
    'us.aws.cdn.hf.co',
    'us.gcp.cdn.hf.co',
    'cdn-lfs.hf.co',
    'cdn-lfs-us-1.hf.co',
    'cdn-lfs-eu-1.hf.co',
    'cdn-lfs.huggingface.co',
    'cdn-lfs-us-1.huggingface.co',
    'cdn-lfs-eu-1.huggingface.co',
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com'
]);
const MAX_REDIRECCIONES_DESCARGA = 5;
const TOTAL_DESCARGA = MODELO.bytes + RUNTIMES.reduce(
    (total, elemento) => total + elemento.bytes,
    0
);

function hostDescargaPermitido(hostname) {
    const host = String(hostname || '').toLowerCase();
    return HOSTS_DESCARGA.has(host);
}

function urlDescargaPermitida(valor) {
    try {
        const url = valor instanceof URL ? valor : new URL(valor);
        return url.protocol === 'https:'
            && (!url.port || url.port === '443')
            && !url.username
            && !url.password
            && hostDescargaPermitido(url.hostname);
    } catch {
        return false;
    }
}

class ErrorIALocal extends Error {
    constructor(codigo, mensaje, causa) {
        super(mensaje);
        this.name = 'ErrorIALocal';
        this.codigo = codigo;
        if (causa) this.cause = causa;
    }
}

function limitarTexto(valor, maximo = 400) {
    return String(valor || '').replace(/[\r\n\t]+/gu, ' ').trim().slice(0, maximo);
}

function sha256Archivo(ruta) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const lectura = fs.createReadStream(ruta);
        lectura.on('error', reject);
        lectura.on('data', bloque => hash.update(bloque));
        lectura.on('end', () => resolve(hash.digest('hex')));
    });
}

function escribirJsonAtomico(ruta, datos) {
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    const temporal = `${ruta}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(temporal, `${JSON.stringify(datos, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
    });
    if (process.platform === 'win32' && fs.existsSync(ruta)) {
        fs.rmSync(ruta, { force: true });
    }
    fs.renameSync(temporal, ruta);
}

function leerJson(ruta) {
    try {
        return JSON.parse(fs.readFileSync(ruta, 'utf8'));
    } catch {
        return null;
    }
}

function bytesLibres(ruta) {
    try {
        const estado = fs.statfsSync(ruta);
        return Number(estado.bavail) * Number(estado.bsize);
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

function nombreZipSeguro(nombre) {
    const limpio = String(nombre || '').replaceAll('\\', '/');
    if (!limpio || limpio.startsWith('/') || /^[a-z]:/iu.test(limpio)) return null;
    const partes = limpio.split('/').filter(Boolean);
    if (!partes.length || partes.some(parte => parte === '..' || parte === '.')) {
        return null;
    }
    return partes.join('/');
}

// Extractor mínimo para los ZIP fijados de llama.cpp. Parte del EOCD, recorre
// exactamente el directorio central y bloquea traversal, enlaces y ZIP bombs.
function extraerZipSeguro(rutaZip, destino, maximoBytes = 1024 * 1024 * 1024) {
    const zip = fs.readFileSync(rutaZip);
    const firmaEocd = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const minimoEocd = Math.max(0, zip.length - (22 + 0xffff));
    let eocd = -1;
    let desde = zip.length - 22;
    while (desde >= minimoEocd) {
        const candidato = zip.lastIndexOf(firmaEocd, desde);
        if (candidato < minimoEocd) break;
        if (candidato + 22 <= zip.length) {
            const comentario = zip.readUInt16LE(candidato + 20);
            if (candidato + 22 + comentario === zip.length) {
                eocd = candidato;
                break;
            }
        }
        desde = candidato - 1;
    }
    if (eocd < 0) {
        throw new ErrorIALocal('RUNTIME_ZIP', 'El motor descargado no contiene un directorio ZIP válido.');
    }
    const disco = zip.readUInt16LE(eocd + 4);
    const discoCentral = zip.readUInt16LE(eocd + 6);
    const entradasDisco = zip.readUInt16LE(eocd + 8);
    const entradas = zip.readUInt16LE(eocd + 10);
    const tamanoCentral = zip.readUInt32LE(eocd + 12);
    const offsetCentral = zip.readUInt32LE(eocd + 16);
    if (
        disco !== 0 || discoCentral !== 0 || entradasDisco !== entradas ||
        entradas === 0xffff || tamanoCentral === 0xffffffff || offsetCentral === 0xffffffff
    ) {
        throw new ErrorIALocal('RUNTIME_ZIP', 'El formato multidisco o ZIP64 del motor no es compatible.');
    }
    if (entradas < 1 || entradas > 10000) {
        throw new ErrorIALocal('RUNTIME_ZIP', 'El ZIP del motor contiene una cantidad de archivos no permitida.');
    }
    const finCentral = offsetCentral + tamanoCentral;
    if (finCentral > eocd || finCentral > zip.length) {
        throw new ErrorIALocal('RUNTIME_ZIP', 'El directorio del motor está incompleto o dañado.');
    }

    fs.mkdirSync(destino, { recursive: true });
    const raiz = path.resolve(destino);
    let posicion = offsetCentral;
    let extraidos = 0;
    let bytesExtraidos = 0;
    const rutasVistas = new Set();

    for (let indice = 0; indice < entradas; indice += 1) {
        if (posicion + 46 > finCentral || zip.readUInt32LE(posicion) !== 0x02014b50) {
            throw new ErrorIALocal('RUNTIME_ZIP', 'El directorio del motor está incompleto o dañado.');
        }
        const flags = zip.readUInt16LE(posicion + 8);
        const metodo = zip.readUInt16LE(posicion + 10);
        const crcEsperado = zip.readUInt32LE(posicion + 16);
        const comprimidos = zip.readUInt32LE(posicion + 20);
        const descomprimidos = zip.readUInt32LE(posicion + 24);
        const largoNombre = zip.readUInt16LE(posicion + 28);
        const largoExtra = zip.readUInt16LE(posicion + 30);
        const largoComentario = zip.readUInt16LE(posicion + 32);
        const atributos = zip.readUInt32LE(posicion + 38);
        const offsetLocal = zip.readUInt32LE(posicion + 42);
        const finNombre = posicion + 46 + largoNombre;
        const finEntrada = finNombre + largoExtra + largoComentario;
        if (finEntrada > finCentral) {
            throw new ErrorIALocal('RUNTIME_ZIP', 'El motor descargado está incompleto.');
        }
        const nombreCrudo = zip.subarray(posicion + 46, finNombre).toString('utf8').replaceAll('\\', '/');
        const esDirectorio = nombreCrudo.endsWith('/');
        const nombre = nombreZipSeguro(nombreCrudo);
        posicion = finEntrada;
        if (!nombre) throw new ErrorIALocal('RUNTIME_ZIP', 'El motor contiene una ruta no permitida.');
        if ((flags & 1) !== 0 || ![0, 8].includes(metodo)) {
            throw new ErrorIALocal('RUNTIME_ZIP', 'El formato del motor no es compatible.');
        }
        const modoUnix = (atributos >>> 16) & 0xffff;
        if ((modoUnix & 0o170000) === 0o120000) {
            throw new ErrorIALocal('RUNTIME_ZIP', 'El motor contiene un enlace no permitido.');
        }
        const claveRuta = nombre.toLowerCase();
        if (rutasVistas.has(claveRuta)) {
            throw new ErrorIALocal('RUNTIME_ZIP', 'El motor contiene rutas duplicadas.');
        }
        rutasVistas.add(claveRuta);
        const salida = path.resolve(raiz, ...nombre.split('/'));
        const relativa = path.relative(raiz, salida);
        if (!relativa || relativa.startsWith('..') || path.isAbsolute(relativa)) {
            throw new ErrorIALocal('RUNTIME_ZIP', 'El motor intentó escribir fuera de su carpeta.');
        }
        const tipoUnix = modoUnix & 0o170000;
        if (esDirectorio || tipoUnix === 0o040000) {
            if (comprimidos !== 0 || descomprimidos !== 0) {
                throw new ErrorIALocal('RUNTIME_ZIP', 'Un directorio del motor contiene datos inesperados.');
            }
            fs.mkdirSync(salida, { recursive: true });
            continue;
        }
        if (descomprimidos > maximoBytes || bytesExtraidos + descomprimidos > maximoBytes) {
            throw new ErrorIALocal('RUNTIME_ZIP', 'El motor excede el tamaño seguro.');
        }
        if (offsetLocal + 30 > offsetCentral || zip.readUInt32LE(offsetLocal) !== 0x04034b50) {
            throw new ErrorIALocal('RUNTIME_ZIP', 'El motor descargado está dañado.');
        }
        const flagsLocal = zip.readUInt16LE(offsetLocal + 6);
        const metodoLocal = zip.readUInt16LE(offsetLocal + 8);
        const nombreLocal = zip.readUInt16LE(offsetLocal + 26);
        const extraLocal = zip.readUInt16LE(offsetLocal + 28);
        const inicioDatos = offsetLocal + 30 + nombreLocal + extraLocal;
        const finDatos = inicioDatos + comprimidos;
        if (inicioDatos > offsetCentral || finDatos > offsetCentral) {
            throw new ErrorIALocal('RUNTIME_ZIP', 'El motor descargado está incompleto.');
        }
        const nombreEntradaLocal = zip.subarray(
            offsetLocal + 30,
            offsetLocal + 30 + nombreLocal
        ).toString('utf8').replaceAll('\\', '/');
        if (
            flagsLocal !== flags || metodoLocal !== metodo ||
            nombreZipSeguro(nombreEntradaLocal) !== nombre
        ) {
            throw new ErrorIALocal('RUNTIME_ZIP', 'La cabecera local del motor no coincide con su directorio.');
        }
        let contenido;
        try {
            contenido = metodo === 0
                ? Buffer.from(zip.subarray(inicioDatos, finDatos))
                : zlib.inflateRawSync(zip.subarray(inicioDatos, finDatos), {
                    maxOutputLength: Math.min(descomprimidos + 1, maximoBytes)
                });
        } catch (error) {
            throw new ErrorIALocal('RUNTIME_ZIP', 'No se pudo descomprimir un archivo del motor.', error);
        }
        if (contenido.length !== descomprimidos) {
            throw new ErrorIALocal('RUNTIME_ZIP', 'Un archivo del motor no coincide con su tamaño firmado.');
        }
        const crc = zlib.crc32(contenido) >>> 0;
        if (crc !== crcEsperado) {
            throw new ErrorIALocal('RUNTIME_ZIP', 'Un archivo del motor no superó la verificación CRC.');
        }
        fs.mkdirSync(path.dirname(salida), { recursive: true });
        fs.writeFileSync(salida, contenido, { mode: 0o700 });
        extraidos += 1;
        bytesExtraidos += contenido.length;
    }
    if (posicion !== finCentral) {
        throw new ErrorIALocal('RUNTIME_ZIP', 'El directorio del motor contiene datos inesperados.');
    }
    if (!extraidos) throw new ErrorIALocal('RUNTIME_ZIP', 'El ZIP del motor no contiene archivos.');
    return { extraidos, bytesExtraidos };
}

function entradaArbolValida(entrada) {
    return Boolean(
        entrada &&
        nombreZipSeguro(entrada.ruta) === entrada.ruta &&
        Number.isSafeInteger(entrada.bytes) && entrada.bytes >= 0 &&
        /^[a-f0-9]{64}$/u.test(String(entrada.sha256 || ''))
    );
}

function manifiestoArbolValido(manifiesto) {
    if (!Array.isArray(manifiesto) || !manifiesto.length || manifiesto.length > 10000) return false;
    const vistas = new Set();
    for (const entrada of manifiesto) {
        if (!entradaArbolValida(entrada)) return false;
        const clave = entrada.ruta.toLowerCase();
        if (vistas.has(clave)) return false;
        vistas.add(clave);
    }
    return manifiesto.some(entrada => path.posix.basename(entrada.ruta).toLowerCase() === 'llama-server.exe');
}

async function crearManifiestoArbol(carpeta) {
    const raiz = path.resolve(carpeta);
    let estadoRaiz;
    try {
        estadoRaiz = fs.lstatSync(raiz);
    } catch {
        throw new ErrorIALocal('RUNTIME_MODIFICADO', 'Falta una carpeta del motor local.');
    }
    if (!estadoRaiz.isDirectory() || estadoRaiz.isSymbolicLink()) {
        throw new ErrorIALocal('RUNTIME_MODIFICADO', 'La carpeta del motor local no es válida.');
    }
    const resultado = [];
    async function recorrer(actual, prefijo = '') {
        const entradas = fs.readdirSync(actual, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name, 'en'));
        for (const entrada of entradas) {
            const ruta = path.join(actual, entrada.name);
            const estado = fs.lstatSync(ruta);
            const relativa = prefijo ? `${prefijo}/${entrada.name}` : entrada.name;
            const segura = nombreZipSeguro(relativa.replaceAll('\\', '/'));
            if (!segura || segura !== relativa.replaceAll('\\', '/')) {
                throw new ErrorIALocal('RUNTIME_MODIFICADO', 'El motor contiene una ruta no permitida.');
            }
            if (estado.isSymbolicLink()) {
                throw new ErrorIALocal('RUNTIME_MODIFICADO', 'El motor contiene un enlace no permitido.');
            }
            if (estado.isDirectory()) {
                await recorrer(ruta, segura);
            } else if (estado.isFile()) {
                resultado.push({
                    ruta: segura,
                    bytes: estado.size,
                    sha256: await sha256Archivo(ruta)
                });
            } else {
                throw new ErrorIALocal('RUNTIME_MODIFICADO', 'El motor contiene un archivo especial no permitido.');
            }
            if (resultado.length > 10000) {
                throw new ErrorIALocal('RUNTIME_MODIFICADO', 'El motor contiene demasiados archivos.');
            }
        }
    }
    await recorrer(raiz);
    resultado.sort((a, b) => a.ruta.localeCompare(b.ruta, 'en'));
    if (!manifiestoArbolValido(resultado)) {
        throw new ErrorIALocal('RUNTIME_INVALIDO', 'El paquete no contiene un motor válido.');
    }
    return resultado;
}

function listarArbolSinHash(carpeta) {
    const resultado = [];
    const raiz = path.resolve(carpeta);
    const estadoRaiz = fs.lstatSync(raiz);
    if (!estadoRaiz.isDirectory() || estadoRaiz.isSymbolicLink()) return null;
    function recorrer(actual, prefijo = '') {
        for (const entrada of fs.readdirSync(actual, { withFileTypes: true })) {
            const ruta = path.join(actual, entrada.name);
            const estado = fs.lstatSync(ruta);
            const relativa = prefijo ? `${prefijo}/${entrada.name}` : entrada.name;
            if (estado.isSymbolicLink()) return false;
            if (estado.isDirectory()) {
                if (!recorrer(ruta, relativa)) return false;
            } else if (estado.isFile()) {
                resultado.push({ ruta: relativa.replaceAll('\\', '/'), bytes: estado.size });
            } else return false;
            if (resultado.length > 10000) return false;
        }
        return true;
    }
    if (!recorrer(raiz)) return null;
    return resultado.sort((a, b) => a.ruta.localeCompare(b.ruta, 'en'));
}

function arbolCoincideSinHash(carpeta, esperado) {
    if (!manifiestoArbolValido(esperado)) return false;
    try {
        const actual = listarArbolSinHash(carpeta);
        if (!actual || actual.length !== esperado.length) return false;
        const mapa = new Map(esperado.map(entrada => [entrada.ruta.toLowerCase(), entrada.bytes]));
        return actual.every(entrada => mapa.get(entrada.ruta.toLowerCase()) === entrada.bytes);
    } catch {
        return false;
    }
}

async function verificarManifiestoArbol(carpeta, esperado) {
    if (!manifiestoArbolValido(esperado)) return false;
    let actual;
    try {
        actual = await crearManifiestoArbol(carpeta);
    } catch {
        return false;
    }
    if (actual.length !== esperado.length) return false;
    const mapa = new Map(esperado.map(entrada => [entrada.ruta.toLowerCase(), entrada]));
    return actual.every(entrada => {
        const anterior = mapa.get(entrada.ruta.toLowerCase());
        return anterior?.bytes === entrada.bytes && anterior?.sha256 === entrada.sha256;
    });
}

function manifiestoInstalacionValido(manifiesto) {
    if (
        manifiesto?.version !== VERSION_MANIFIESTO ||
        manifiesto?.modelo !== MODELO.archivo ||
        manifiesto?.modeloSha256 !== MODELO.sha256 ||
        manifiesto?.runtime !== VERSION_RUNTIME ||
        !manifiesto?.runtimeHashes ||
        !manifiesto?.runtimeArboles
    ) return false;
    return RUNTIMES.every(runtime => (
        manifiesto.runtimeHashes[runtime.id] === runtime.sha256 &&
        manifiestoArbolValido(manifiesto.runtimeArboles[runtime.id])
    ));
}

function buscarArchivo(carpeta, nombre, profundidad = 4) {
    if (profundidad < 0 || !fs.existsSync(carpeta)) return null;
    for (const entrada of fs.readdirSync(carpeta, { withFileTypes: true })) {
        const ruta = path.join(carpeta, entrada.name);
        if (entrada.isFile() && entrada.name.toLowerCase() === nombre.toLowerCase()) {
            return ruta;
        }
        if (entrada.isDirectory()) {
            const encontrado = buscarArchivo(ruta, nombre, profundidad - 1);
            if (encontrado) return encontrado;
        }
    }
    return null;
}

function obtenerPuertoLibre() {
    return new Promise((resolve, reject) => {
        const servidor = net.createServer();
        servidor.unref();
        servidor.once('error', reject);
        servidor.listen(0, '127.0.0.1', () => {
            const puerto = servidor.address().port;
            servidor.close(error => error ? reject(error) : resolve(puerto));
        });
    });
}

function esperarCierreProceso(proceso, timeoutMs = 5000) {
    if (!proceso || proceso.exitCode !== null) return Promise.resolve(true);
    return new Promise(resolve => {
        let terminado = false;
        const finalizar = valor => {
            if (terminado) return;
            terminado = true;
            clearTimeout(timeout);
            proceso.removeListener?.('exit', alCerrar);
            proceso.removeListener?.('close', alCerrar);
            resolve(valor);
        };
        const alCerrar = () => finalizar(true);
        proceso.once?.('exit', alCerrar);
        proceso.once?.('close', alCerrar);
        const timeout = setTimeout(() => finalizar(proceso.exitCode !== null), timeoutMs);
        timeout.unref?.();
    });
}

function esErrorRecuperableVulkan(error) {
    if (error?.codigo === 'IA_HTTP') {
        return Number(error?.status) >= 500;
    }
    if (error?.codigo) return false;
    const codigosRed = new Set([
        'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE',
        'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'
    ]);
    let actual = error;
    for (let nivel = 0; actual && nivel < 4; nivel += 1) {
        if (actual.name === 'TypeError' || codigosRed.has(actual.code)) return true;
        actual = actual.cause;
    }
    return false;
}

class RuntimeIALocal extends EventEmitter {
    constructor(opciones = {}) {
        super();
        this.carpeta = path.resolve(opciones.carpeta || path.join(process.cwd(), '.ia-local'));
        this.fetch = opciones.fetch || globalThis.fetch;
        this.spawn = opciones.spawn || spawn;
        this.estado = 'no_instalada';
        this.mensaje = 'La IA local todavía no fue descargada.';
        this.porcentaje = 0;
        this.detalleDescarga = null;
        this.error = null;
        this.promesaDescarga = null;
        this.controladorDescarga = null;
        this.promesaInicio = null;
        this.proceso = null;
        this.procesoIniciando = null;
        this.generacionInicio = 0;
        this.puerto = null;
        this.apiKey = null;
        this.motorActivo = null;
        this.vulkanNoDisponible = false;
        this.procesosVivos = new Set();
        this.instalacionVerificada = false;
        this.temporizadorInactividad = null;
        fs.mkdirSync(this.carpeta, { recursive: true });
        if (this.instalada()) {
            this.estado = 'lista';
            this.mensaje = 'Qwen3 1.7B está instalado y listo para analizar.';
            this.porcentaje = 100;
        }
    }

    rutaModelo() {
        return path.join(this.carpeta, 'models', MODELO.archivo);
    }

    rutaRuntime(id) {
        return path.join(this.carpeta, 'runtime', VERSION_RUNTIME, id);
    }

    rutaManifiesto() {
        return path.join(this.carpeta, 'instalacion.json');
    }

    instalada() {
        const manifiesto = leerJson(this.rutaManifiesto());
        if (!manifiestoInstalacionValido(manifiesto)) return false;
        try {
            const estadoModelo = fs.lstatSync(this.rutaModelo());
            if (
                estadoModelo.isSymbolicLink() || !estadoModelo.isFile() ||
                estadoModelo.size !== MODELO.bytes
            ) return false;
        } catch {
            return false;
        }
        return RUNTIMES.every(runtime => arbolCoincideSinHash(
            this.rutaRuntime(runtime.id),
            manifiesto.runtimeArboles[runtime.id]
        ));
    }

    obtenerEstado() {
        return {
            estado: this.estado,
            mensaje: this.mensaje,
            porcentaje: this.porcentaje,
            detalle: this.detalleDescarga,
            instalada: this.instalada(),
            ejecutando: Boolean(this.proceso && !this.proceso.killed),
            motor: this.motorActivo,
            modelo: {
                nombre: MODELO.nombre,
                bytes: MODELO.bytes,
                licencia: MODELO.licencia
            },
            descargaBytes: TOTAL_DESCARGA,
            error: this.error
        };
    }

    cambiarEstado(datos) {
        Object.assign(this, datos);
        const vista = this.obtenerEstado();
        this.emit('estado', vista);
        return vista;
    }

    obtenerProcesosVivos() {
        for (const proceso of this.procesosVivos) {
            if (proceso?.exitCode !== null) this.procesosVivos.delete(proceso);
        }
        return [...this.procesosVivos];
    }

    async descargarArchivo(asset, rutaFinal, bytesPrevios, signal) {
        fs.mkdirSync(path.dirname(rutaFinal), { recursive: true });
        if (fs.existsSync(rutaFinal) && fs.statSync(rutaFinal).size === asset.bytes) {
            this.cambiarEstado({
                estado: 'verificando',
                detalleDescarga: `Verificando ${asset.archivo}…`
            });
            if (await sha256Archivo(rutaFinal) === asset.sha256) return asset.bytes;
            fs.rmSync(rutaFinal, { force: true });
        }
        const parcial = `${rutaFinal}.${asset.sha256.slice(0, 12)}.part`;
        let offset = fs.existsSync(parcial) ? fs.statSync(parcial).size : 0;
        if (offset > asset.bytes) {
            fs.rmSync(parcial, { force: true });
            offset = 0;
        }
        if (offset === asset.bytes) {
            this.cambiarEstado({
                estado: 'verificando',
                detalleDescarga: `Verificando ${asset.archivo}…`
            });
            const hashParcial = await sha256Archivo(parcial);
            if (signal.aborted) {
                throw new ErrorIALocal('DESCARGA_CANCELADA', 'La descarga fue detenida.');
            }
            if (hashParcial === asset.sha256) {
                if (fs.existsSync(rutaFinal)) fs.rmSync(rutaFinal, { force: true });
                fs.renameSync(parcial, rutaFinal);
                return asset.bytes;
            }
            fs.rmSync(parcial, { force: true });
            offset = 0;
        }
        const headers = {
            'Accept-Encoding': 'identity',
            ...(offset ? { Range: `bytes=${offset}-` } : {})
        };
        let respuesta;
        let urlActual;
        try {
            urlActual = new URL(asset.url);
            for (let redirecciones = 0; ; redirecciones += 1) {
                if (!urlDescargaPermitida(urlActual)) {
                    throw new ErrorIALocal(
                        'DESCARGA_ORIGEN',
                        'La descarga fue redirigida a un origen no permitido.'
                    );
                }
                respuesta = await this.fetch(urlActual, {
                    headers,
                    signal,
                    redirect: 'manual'
                });
                const urlRespondida = respuesta.url ? new URL(respuesta.url) : urlActual;
                if (!urlDescargaPermitida(urlRespondida)) {
                    throw new ErrorIALocal(
                        'DESCARGA_ORIGEN',
                        'La descarga fue redirigida a un origen no permitido.'
                    );
                }
                urlActual = urlRespondida;
                if (![301, 302, 303, 307, 308].includes(respuesta.status)) break;
                const destino = respuesta.headers?.get?.('location');
                if (!destino) break;
                if (redirecciones >= MAX_REDIRECCIONES_DESCARGA) {
                    throw new ErrorIALocal(
                        'DESCARGA_REDIRECCIONES',
                        'La descarga superó el límite de redirecciones seguras.'
                    );
                }
                urlActual = new URL(destino, urlActual);
            }
        } catch (error) {
            if (signal.aborted) throw new ErrorIALocal('DESCARGA_CANCELADA', 'La descarga fue detenida.', error);
            if (error instanceof ErrorIALocal) throw error;
            throw new ErrorIALocal('DESCARGA_RED', 'No se pudo descargar la IA local.', error);
        }
        if (offset && respuesta.status === 200) {
            fs.rmSync(parcial, { force: true });
            offset = 0;
        } else if (offset && respuesta.status === 206) {
            const rango = String(respuesta.headers.get('content-range') || '');
            if (!rango.startsWith(`bytes ${offset}-`)) {
                throw new ErrorIALocal('DESCARGA_RANGO', 'El servidor devolvió un tramo de descarga inválido.');
            }
        } else if (!respuesta.ok) {
            throw new ErrorIALocal('DESCARGA_HTTP', `No se pudo descargar la IA local (HTTP ${respuesta.status}).`);
        }
        if (!respuesta.body) throw new ErrorIALocal('DESCARGA_VACIA', 'La descarga no devolvió datos.');
        const escritura = fs.createWriteStream(parcial, {
            flags: offset ? 'a' : 'w',
            mode: 0o600
        });
        let recibidos = offset;
        const lectura = Readable.fromWeb(respuesta.body);
        lectura.on('data', bloque => {
            recibidos += bloque.length;
            if (recibidos > asset.bytes) lectura.destroy(
                new ErrorIALocal('DESCARGA_TAMANO', 'La descarga excedió el tamaño esperado.')
            );
            const total = bytesPrevios + recibidos;
            this.cambiarEstado({
                estado: 'descargando',
                porcentaje: Math.min(99, Math.floor((total / TOTAL_DESCARGA) * 100)),
                detalleDescarga: asset === MODELO ? 'Descargando Qwen3 1.7B…' : `Descargando motor ${asset.id.toUpperCase()}…`,
                mensaje: 'Descargando y verificando la IA local. Podés detenerla y continuar después.'
            });
        });
        await pipeline(lectura, escritura, { signal });
        const tamano = fs.statSync(parcial).size;
        if (tamano !== asset.bytes) {
            throw new ErrorIALocal('DESCARGA_INCOMPLETA', 'La descarga quedó incompleta; se podrá reanudar.');
        }
        this.cambiarEstado({
            estado: 'verificando',
            detalleDescarga: `Verificando ${asset.archivo}…`
        });
        const hash = await sha256Archivo(parcial);
        if (signal.aborted) {
            throw new ErrorIALocal(
                'DESCARGA_CANCELADA',
                'La descarga fue detenida.'
            );
        }
        if (hash !== asset.sha256) {
            fs.rmSync(parcial, { force: true });
            throw new ErrorIALocal('DESCARGA_HASH', 'La descarga no superó la verificación de seguridad.');
        }
        if (fs.existsSync(rutaFinal)) fs.rmSync(rutaFinal, { force: true });
        fs.renameSync(parcial, rutaFinal);
        return asset.bytes;
    }

    async instalarRuntime(asset, bytesPrevios, signal) {
        const destino = this.rutaRuntime(asset.id);
        const manifiestoAnterior = leerJson(this.rutaManifiesto());
        const arbolAnterior = manifiestoInstalacionValido(manifiestoAnterior)
            ? manifiestoAnterior.runtimeArboles[asset.id]
            : null;
        if (arbolAnterior && await verificarManifiestoArbol(destino, arbolAnterior)) {
            return arbolAnterior;
        }
        fs.rmSync(destino, { recursive: true, force: true });
        const carpetaZips = path.join(this.carpeta, 'downloads');
        const rutaZip = path.join(carpetaZips, asset.archivo);
        await this.descargarArchivo(asset, rutaZip, bytesPrevios, signal);
        const temporal = `${destino}.tmp-${process.pid}`;
        fs.rmSync(temporal, { recursive: true, force: true });
        try {
            extraerZipSeguro(rutaZip, temporal);
            if (!buscarArchivo(temporal, 'llama-server.exe')) {
                throw new ErrorIALocal('RUNTIME_INVALIDO', 'El paquete no contiene llama-server.exe.');
            }
            fs.rmSync(destino, { recursive: true, force: true });
            fs.mkdirSync(path.dirname(destino), { recursive: true });
            fs.renameSync(temporal, destino);
            fs.rmSync(rutaZip, { force: true });
            return await crearManifiestoArbol(destino);
        } finally {
            fs.rmSync(temporal, { recursive: true, force: true });
        }
    }

    descargar() {
        if (this.promesaDescarga) return this.promesaDescarga;
        if (this.instalada()) return Promise.resolve(this.obtenerEstado());
        if (!this.fetch) {
            const error = new ErrorIALocal(
                'FETCH_NO_DISPONIBLE',
                'No hay cliente de red para descargar la IA.'
            );
            this.cambiarEstado({ estado: 'error', mensaje: error.message, error: error.message });
            return Promise.reject(error);
        }
        const libres = bytesLibres(this.carpeta);
        if (libres < 2.5 * 1024 * 1024 * 1024) {
            const error = new ErrorIALocal(
                'ESPACIO_INSUFICIENTE',
                'Se necesitan al menos 2,5 GB libres para instalar Qwen3 1.7B.'
            );
            this.cambiarEstado({ estado: 'error', mensaje: error.message, error: error.message });
            return Promise.reject(error);
        }
        this.controladorDescarga = new AbortController();
        const signal = this.controladorDescarga.signal;
        this.cambiarEstado({
            estado: 'descargando',
            mensaje: 'Preparando la descarga segura de Qwen3 1.7B…',
            porcentaje: 0,
            error: null
        });
        this.promesaDescarga = (async () => {
            let completos = 0;
            const rutaModelo = this.rutaModelo();
            await this.descargarArchivo(MODELO, rutaModelo, completos, signal);
            completos += MODELO.bytes;
            const runtimeArboles = {};
            for (const runtime of RUNTIMES) {
                runtimeArboles[runtime.id] = await this.instalarRuntime(runtime, completos, signal);
                completos += runtime.bytes;
            }
            escribirJsonAtomico(this.rutaManifiesto(), {
                version: VERSION_MANIFIESTO,
                modelo: MODELO.archivo,
                modeloSha256: MODELO.sha256,
                runtime: VERSION_RUNTIME,
                runtimeHashes: Object.fromEntries(RUNTIMES.map(item => [item.id, item.sha256])),
                runtimeArboles,
                instaladaEn: new Date().toISOString()
            });
            this.instalacionVerificada = false;
            this.vulkanNoDisponible = false;
            return this.cambiarEstado({
                estado: 'lista',
                mensaje: 'Qwen3 1.7B quedó instalado y listo para analizar.',
                porcentaje: 100,
                detalleDescarga: null,
                error: null
            });
        })().catch(error => {
            const cancelada = signal.aborted || error?.codigo === 'DESCARGA_CANCELADA';
            this.cambiarEstado({
                estado: cancelada ? 'pausada' : 'error',
                mensaje: cancelada
                    ? 'La descarga quedó pausada y podrá continuar desde el mismo punto.'
                    : (error?.message || 'No se pudo instalar la IA local.'),
                detalleDescarga: null,
                error: cancelada ? null : limitarTexto(error?.message)
            });
            throw error;
        }).finally(() => {
            this.promesaDescarga = null;
            this.controladorDescarga = null;
        });
        return this.promesaDescarga;
    }

    detenerDescarga() {
        if (!this.controladorDescarga) return false;
        this.controladorDescarga.abort();
        return true;
    }

    async esperarSalud(puerto, apiKey, proceso, timeoutMs = 120000) {
        const inicio = Date.now();
        while (Date.now() - inicio < timeoutMs) {
            if (proceso.errorInicio) {
                throw new ErrorIALocal(
                    'MOTOR_NO_INICIO',
                    'Windows no pudo iniciar el motor local.',
                    proceso.errorInicio
                );
            }
            if (proceso.exitCode !== null || proceso.killed) {
                throw new ErrorIALocal('MOTOR_CERRADO', 'El motor local se cerró durante el inicio.');
            }
            try {
                const respuesta = await this.fetch(`http://127.0.0.1:${puerto}/health`, {
                    headers: { Authorization: `Bearer ${apiKey}` },
                    signal: AbortSignal.timeout(1500)
                });
                if (respuesta.ok) return;
            } catch {
                // El modelo todavía se está cargando.
            }
            await new Promise(resolve => setTimeout(resolve, 350));
        }
        throw new ErrorIALocal('MOTOR_TIMEOUT', 'Qwen tardó demasiado en iniciar.');
    }

    async iniciarMotor(id, generacionEsperada = null) {
        const ejecutable = buscarArchivo(this.rutaRuntime(id), 'llama-server.exe');
        if (!ejecutable) throw new ErrorIALocal('RUNTIME_FALTANTE', `No se encontró el motor ${id}.`);
        const puerto = await obtenerPuertoLibre();
        if (
            generacionEsperada !== null &&
            generacionEsperada !== this.generacionInicio
        ) {
            throw new ErrorIALocal(
                'IA_CANCELADA',
                'El inicio de la IA local fue detenido.'
            );
        }
        const apiKey = crypto.randomBytes(32).toString('hex');
        const hilos = Math.max(2, Math.min(8, (os.cpus()?.length || 4) - 1));
        const argumentos = [
            '--model', this.rutaModelo(),
            '--offline',
            '--host', '127.0.0.1',
            '--port', String(puerto),
            '--api-key', apiKey,
            '--ctx-size', '4096',
            '--parallel', '1',
            '--threads', String(hilos),
            '--threads-http', '1',
            '--prio', '-1',
            '--cache-ram', '64',
            '--alias', 'zeroone-qwen3',
            '--sleep-idle-seconds', '300',
            '--no-webui',
            '--no-slots',
            '--log-disable'
        ];
        if (id === 'vulkan') argumentos.push(
            '--gpu-layers', 'auto',
            '--fit', 'on',
            '--fit-target', '1024'
        );
        else argumentos.push('--device', 'none', '--gpu-layers', '0');
        const proceso = this.spawn(ejecutable, argumentos, {
            cwd: path.dirname(ejecutable),
            windowsHide: true,
            detached: false,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        this.procesosVivos.add(proceso);
        const dejarDeRastrear = () => this.procesosVivos.delete(proceso);
        proceso.once?.('exit', dejarDeRastrear);
        proceso.once?.('close', dejarDeRastrear);
        proceso.once('error', error => {
            proceso.errorInicio = error;
        });
        this.procesoIniciando = proceso;
        let diagnostico = '';
        const capturar = bloque => {
            diagnostico = `${diagnostico}${bloque}`.slice(-4000);
        };
        proceso.stdout?.on('data', capturar);
        proceso.stderr?.on('data', capturar);
        try {
            await this.esperarSalud(puerto, apiKey, proceso);
        } catch (error) {
            proceso.kill();
            const cerrado = await esperarCierreProceso(proceso, 3000);
            if (!cerrado) {
                throw new ErrorIALocal(
                    'MOTOR_NO_CIERRA',
                    'El motor local no terminó de cerrarse durante el inicio.',
                    error
                );
            }
            if (this.procesoIniciando === proceso) this.procesoIniciando = null;
            error.diagnostico = limitarTexto(diagnostico, 500);
            throw error;
        }
        if (this.procesoIniciando === proceso) this.procesoIniciando = null;
        this.proceso = proceso;
        this.puerto = puerto;
        this.apiKey = apiKey;
        this.motorActivo = id;
        proceso.once('exit', () => {
            if (this.proceso !== proceso) return;
            this.proceso = null;
            this.puerto = null;
            this.apiKey = null;
            this.motorActivo = null;
            this.instalacionVerificada = false;
            if (this.estado === 'ejecutando') {
                this.cambiarEstado({
                    estado: 'lista',
                    mensaje: 'El motor local se detuvo; se iniciará cuando vuelva a usarse.'
                });
            }
        });
        return proceso;
    }

    async cerrarMotoresParaFallback() {
        const procesos = this.obtenerProcesosVivos();
        for (const proceso of procesos) {
            if (proceso.exitCode === null && !proceso.killed) proceso.kill();
        }
        const cierres = await Promise.all(
            procesos.map(proceso => esperarCierreProceso(proceso, 5000))
        );
        if (cierres.some(cerrado => !cerrado)) {
            throw new ErrorIALocal(
                'MOTOR_NO_CIERRA',
                'El motor Vulkan no terminó de cerrarse; no se iniciará otro motor en paralelo.'
            );
        }
        this.proceso = null;
        this.procesoIniciando = null;
        this.puerto = null;
        this.apiKey = null;
        this.motorActivo = null;
        // La instalación ya fue verificada justo antes de este intento. Conservar
        // el resultado evita volver a leer el modelo completo durante el fallback.
        this.instalacionVerificada = true;
    }

    async asegurarIniciada() {
        if (this.proceso && this.proceso.exitCode === null && !this.proceso.killed) {
            this.rearmarInactividad();
            return this;
        }
        if (this.promesaInicio) return this.promesaInicio;
        if (this.obtenerProcesosVivos().some(proceso => proceso.exitCode === null)) {
            throw new ErrorIALocal(
                'MOTOR_NO_CIERRA',
                'Un motor local anterior todavía no terminó de cerrarse.'
            );
        }
        const manifiesto = leerJson(this.rutaManifiesto());
        if (!manifiestoInstalacionValido(manifiesto)) {
            throw new ErrorIALocal('IA_NO_INSTALADA', 'Primero descargá Qwen3 1.7B desde Agendamiento.');
        }
        const generacion = ++this.generacionInicio;
        this.promesaInicio = (async () => {
            this.cambiarEstado({
                estado: 'verificando',
                mensaje: 'Verificando la integridad de Qwen3 1.7B antes de usarlo…',
                error: null
            });
            if (!this.instalacionVerificada) {
                let hashModelo;
                try {
                    const estadoModelo = fs.lstatSync(this.rutaModelo());
                    if (estadoModelo.isSymbolicLink() || !estadoModelo.isFile()) {
                        throw new Error('El modelo no es un archivo regular.');
                    }
                    hashModelo = await sha256Archivo(this.rutaModelo());
                } catch (error) {
                    throw new ErrorIALocal(
                        'MODELO_MODIFICADO',
                        'El modelo local no superó la verificación SHA-256. Eliminá y descargá la IA nuevamente.',
                        error
                    );
                }
                if (hashModelo !== MODELO.sha256) {
                    throw new ErrorIALocal(
                        'MODELO_MODIFICADO',
                        'El modelo local no superó la verificación SHA-256. Eliminá y descargá la IA nuevamente.'
                    );
                }
                for (const runtime of RUNTIMES) {
                    const valido = await verificarManifiestoArbol(
                        this.rutaRuntime(runtime.id),
                        manifiesto.runtimeArboles[runtime.id]
                    );
                    if (!valido) {
                        throw new ErrorIALocal(
                            'RUNTIME_MODIFICADO',
                            `El motor ${runtime.id.toUpperCase()} fue alterado o está incompleto. Eliminá y descargá la IA nuevamente.`
                        );
                    }
                }
            }
            if (generacion !== this.generacionInicio) {
                throw new ErrorIALocal('IA_CANCELADA', 'El inicio de la IA local fue detenido.');
            }
            this.instalacionVerificada = true;
            this.cambiarEstado({
                estado: 'iniciando',
                mensaje: 'Iniciando Qwen3 1.7B en este equipo…',
                error: null
            });
            try {
                if (this.vulkanNoDisponible) {
                    await this.iniciarMotor('cpu', generacion);
                } else {
                    await this.iniciarMotor('vulkan', generacion);
                }
            } catch (errorVulkan) {
                if (generacion !== this.generacionInicio) {
                    throw new ErrorIALocal(
                        'IA_CANCELADA',
                        'El inicio de la IA local fue detenido.',
                        errorVulkan
                    );
                }
                if (
                    this.vulkanNoDisponible ||
                    errorVulkan?.codigo === 'MOTOR_NO_CIERRA'
                ) throw errorVulkan;
                this.vulkanNoDisponible = true;
                try {
                    await this.iniciarMotor('cpu', generacion);
                } catch (errorCpu) {
                    if (generacion !== this.generacionInicio) {
                        throw new ErrorIALocal(
                            'IA_CANCELADA',
                            'El inicio de la IA local fue detenido.',
                            errorCpu
                        );
                    }
                    throw errorCpu;
                }
            }
            if (generacion !== this.generacionInicio) {
                const procesoCancelado = this.proceso;
                procesoCancelado?.kill();
                await esperarCierreProceso(procesoCancelado, 3000);
                this.proceso = null;
                throw new ErrorIALocal(
                    'IA_CANCELADA',
                    'El inicio de la IA local fue detenido.'
                );
            }
            this.cambiarEstado({
                estado: 'ejecutando',
                mensaje: `Qwen3 1.7B está usando el motor ${this.motorActivo.toUpperCase()}.`,
                porcentaje: 100
            });
            this.rearmarInactividad();
            return this;
        })().catch(error => {
            const cancelada = error?.codigo === 'IA_CANCELADA';
            if (!cancelada) this.instalacionVerificada = false;
            this.cambiarEstado(cancelada ? {
                estado: this.instalada() ? 'lista' : 'no_instalada',
                mensaje: 'El inicio de la IA local fue detenido.',
                error: null
            } : {
                estado: 'error',
                mensaje: error?.message || 'No se pudo iniciar Qwen3 1.7B.',
                error: limitarTexto(error?.message)
            });
            throw error;
        }).finally(() => {
            this.promesaInicio = null;
        });
        return this.promesaInicio;
    }

    rearmarInactividad() {
        clearTimeout(this.temporizadorInactividad);
        this.temporizadorInactividad = setTimeout(() => this.detener(), 5 * 60 * 1000);
        this.temporizadorInactividad.unref?.();
    }

    async enviarSolicitud(solicitud, { signal, timeoutMs = 45000 } = {}) {
        const controlador = new AbortController();
        const cancelar = () => controlador.abort(signal?.reason);
        if (signal?.aborted) cancelar();
        else signal?.addEventListener('abort', cancelar, { once: true });
        const timeout = setTimeout(() => controlador.abort(), timeoutMs);
        timeout.unref?.();
        try {
            const respuesta = await this.fetch(
                `http://127.0.0.1:${this.puerto}/v1/chat/completions`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(solicitud),
                    signal: controlador.signal
                }
            );
            if (!respuesta.ok) {
                const error = new ErrorIALocal(
                    'IA_HTTP',
                    `La IA local devolvió HTTP ${respuesta.status}.`
                );
                error.status = respuesta.status;
                throw error;
            }
            const datos = await respuesta.json();
            this.rearmarInactividad();
            return datos;
        } catch (error) {
            if (signal?.aborted) throw new ErrorIALocal('IA_CANCELADA', 'El análisis fue detenido.', error);
            if (controlador.signal.aborted) throw new ErrorIALocal('IA_TIMEOUT', 'La IA local tardó demasiado.', error);
            throw error;
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', cancelar);
        }
    }

    async completar(solicitud, { signal, timeoutMs = 45000 } = {}) {
        if (signal?.aborted) {
            throw new ErrorIALocal('IA_CANCELADA', 'El análisis fue detenido.');
        }
        const cancelarInicio = () => {
            if (this.promesaInicio || this.procesoIniciando) this.detener();
        };
        signal?.addEventListener('abort', cancelarInicio, { once: true });
        try {
            await this.asegurarIniciada();
        } finally {
            signal?.removeEventListener('abort', cancelarInicio);
        }
        if (signal?.aborted) {
            throw new ErrorIALocal('IA_CANCELADA', 'El análisis fue detenido.');
        }

        const motorIntentado = this.motorActivo;
        try {
            return await this.enviarSolicitud(solicitud, { signal, timeoutMs });
        } catch (error) {
            if (
                motorIntentado !== 'vulkan' ||
                !esErrorRecuperableVulkan(error)
            ) throw error;
            this.vulkanNoDisponible = true;
            await this.cerrarMotoresParaFallback();
            if (signal?.aborted) {
                throw new ErrorIALocal(
                    'IA_CANCELADA',
                    'El análisis fue detenido.',
                    error
                );
            }
            await this.asegurarIniciada();
            return this.enviarSolicitud(solicitud, { signal, timeoutMs });
        }
    }

    detener() {
        this.generacionInicio += 1;
        clearTimeout(this.temporizadorInactividad);
        this.temporizadorInactividad = null;
        const procesos = [...new Set([
            ...this.obtenerProcesosVivos(),
            this.proceso,
            this.procesoIniciando
        ].filter(Boolean))];
        this.proceso = null;
        this.procesoIniciando = null;
        this.puerto = null;
        this.apiKey = null;
        this.motorActivo = null;
        this.instalacionVerificada = false;
        for (const proceso of procesos) {
            this.procesosVivos.add(proceso);
            if (proceso.exitCode === null && !proceso.killed) proceso.kill();
        }
        if (this.instalada()) {
            this.cambiarEstado({
                estado: 'lista',
                mensaje: 'Qwen3 1.7B está instalado y se iniciará al analizar.'
            });
        }
        return procesos.length > 0;
    }

    async cerrarYEsperar(timeoutMs = 5000) {
        this.detenerDescarga();
        const procesos = [...new Set([
            ...this.obtenerProcesosVivos(),
            this.proceso,
            this.procesoIniciando
        ].filter(Boolean))];
        this.detener();
        if (!procesos.length) return true;
        const cierres = await Promise.all(
            procesos.map(proceso => esperarCierreProceso(proceso, timeoutMs))
        );
        return cierres.every(Boolean);
    }

    async desinstalar() {
        this.detenerDescarga();
        this.detener();
        if (this.promesaDescarga) {
            try {
                await this.promesaDescarga;
            } catch {
                // La cancelación esperada deja de escribir antes de borrar.
            }
        }
        if (this.promesaInicio) {
            try {
                await this.promesaInicio;
            } catch {
                // El proceso de inicio fue detenido arriba.
            }
        }
        const procesos = this.obtenerProcesosVivos();
        for (const proceso of procesos) {
            if (proceso.exitCode === null && !proceso.killed) proceso.kill();
        }
        const esperasCierre = procesos.map(
            proceso => esperarCierreProceso(proceso, 5000)
        );
        const cierres = await Promise.all(esperasCierre);
        if (cierres.some(cerrado => !cerrado)) {
            const error = new ErrorIALocal(
                'MOTOR_NO_CIERRA',
                'El motor local no terminó de cerrarse. Volvé a intentar eliminar la IA en unos segundos.'
            );
            this.cambiarEstado({ estado: 'error', mensaje: error.message, error: error.message });
            throw error;
        }
        fs.rmSync(path.join(this.carpeta, 'models'), { recursive: true, force: true });
        fs.rmSync(path.join(this.carpeta, 'runtime'), { recursive: true, force: true });
        fs.rmSync(path.join(this.carpeta, 'downloads'), { recursive: true, force: true });
        fs.rmSync(this.rutaManifiesto(), { force: true });
        this.instalacionVerificada = false;
        this.vulkanNoDisponible = false;
        return this.cambiarEstado({
            estado: 'no_instalada',
            mensaje: 'La IA local fue eliminada de este equipo.',
            porcentaje: 0,
            error: null
        });
    }
}

function crearRuntimeIALocal(opciones) {
    return new RuntimeIALocal(opciones);
}

module.exports = {
    ErrorIALocal,
    MODELO,
    RUNTIMES,
    RuntimeIALocal,
    crearRuntimeIALocal,
    extraerZipSeguro,
    sha256Archivo
};
