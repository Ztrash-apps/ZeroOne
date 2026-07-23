const {
    app,
    BrowserWindow,
    ipcMain,
    Menu,
    Notification,
    safeStorage,
    shell,
    Tray
} = require('electron');

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');

const NOMBRE_APLICACION = 'ZeroOne';
const URL_APLICACION = 'http://127.0.0.1:3000';
const ORIGEN_APLICACION = new URL(URL_APLICACION).origin;
const INTERVALO_ACTUALIZACIONES = 5 * 60 * 60 * 1000;
const RUTA_ICONO = path.join(
    __dirname,
    'public',
    'assets',
    'zeroone-icon.png'
);
const MODO_DESARROLLO_WEB = !app.isPackaged &&
    process.env.ZEROONE_ENABLE_DEVTOOLS === '1';
const TOKEN_SESION_ESCRITORIO = MODO_DESARROLLO_WEB
    ? ''
    : crypto.randomBytes(32).toString('base64url');
const ARGUMENTO_INICIO_AUTOMATICO = '--zeroone-inicio-automatico';
const INICIO_AUTOMATICO_SOLICITADO = process.argv.includes(
    ARGUMENTO_INICIO_AUTOMATICO
);

app.setName(NOMBRE_APLICACION);
process.env.ZEROONE_DESKTOP_TOKEN = TOKEN_SESION_ESCRITORIO;

let ventanaPrincipal = null;
let iconoBandeja = null;
let temporizadorActualizaciones = null;
let busquedaEnCurso = false;
let descargaEnCurso = false;
let cierreAplicacionEnCurso = false;
let cierreAplicacionCompletado = false;
let preferenciasEscritorio = {
    mantenerEnSegundoPlano: true,
    iniciarConWindows: true
};
const sesionesEndurecidas = new WeakSet();
const sesionesAutorizadas = new WeakSet();

let estadoActualizacion = {
    estado: 'inactivo',
    mensaje: 'Todavía no se buscaron actualizaciones.',
    versionActual: app.getVersion(),
    versionDisponible: null,
    porcentaje: 0
};

function obtenerEstadoActualizacion() {
    return {
        ...estadoActualizacion,
        versionActual: app.getVersion()
    };
}

function enviarEstadoActualizacion(datos = {}) {
    estadoActualizacion = {
        ...estadoActualizacion,
        ...datos,
        versionActual: app.getVersion()
    };

    if (
        ventanaPrincipal &&
        !ventanaPrincipal.isDestroyed() &&
        !ventanaPrincipal.webContents.isDestroyed()
    ) {
        ventanaPrincipal.webContents.send(
            'actualizacion:estado',
            obtenerEstadoActualizacion()
        );
    }

    return obtenerEstadoActualizacion();
}

function configurarActualizador() {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = console;

    autoUpdater.on('checking-for-update', () => {
        enviarEstadoActualizacion({
            estado: 'buscando',
            mensaje: 'Buscando una nueva versión...',
            porcentaje: 0
        });
    });

    autoUpdater.on('update-available', informacion => {
        busquedaEnCurso = false;

        enviarEstadoActualizacion({
            estado: 'disponible',
            mensaje: `Nueva versión disponible: ${informacion.version}`,
            versionDisponible: informacion.version,
            porcentaje: 0
        });
    });

    autoUpdater.on('update-not-available', informacion => {
        busquedaEnCurso = false;

        enviarEstadoActualizacion({
            estado: 'actualizada',
            mensaje: 'Ya tenés la versión más reciente.',
            versionDisponible: informacion?.version || null,
            porcentaje: 0
        });
    });

    autoUpdater.on('download-progress', progreso => {
        enviarEstadoActualizacion({
            estado: 'descargando',
            mensaje: `Descargando actualización: ${Math.round(progreso.percent || 0)}%`,
            porcentaje: Math.round(progreso.percent || 0)
        });
    });

    autoUpdater.on('update-downloaded', informacion => {
        descargaEnCurso = false;

        enviarEstadoActualizacion({
            estado: 'descargada',
            mensaje: `La versión ${informacion.version} está lista para instalar.`,
            versionDisponible: informacion.version,
            porcentaje: 100
        });
    });

    autoUpdater.on('error', error => {
        busquedaEnCurso = false;
        descargaEnCurso = false;

        enviarEstadoActualizacion({
            estado: 'error',
            mensaje:
                error?.message ||
                'Ocurrió un problema buscando la actualización.'
        });

        console.error('Error del actualizador:', error);
    });
}

async function buscarActualizacion(origen = 'manual') {
    if (!app.isPackaged) {
        return enviarEstadoActualizacion({
            estado: 'desarrollo',
            mensaje:
                'Las actualizaciones solo se comprueban en la aplicación instalada.'
        });
    }

    if (busquedaEnCurso) {
        return enviarEstadoActualizacion({
            estado: 'buscando',
            mensaje: 'Ya se está buscando una actualización.'
        });
    }

    if (descargaEnCurso) {
        return enviarEstadoActualizacion({
            estado: 'descargando',
            mensaje: 'Hay una actualización descargándose.'
        });
    }

    busquedaEnCurso = true;

    enviarEstadoActualizacion({
        estado: 'buscando',
        mensaje:
            origen === 'automatico'
                ? 'Comprobando actualizaciones automáticamente...'
                : 'Buscando una nueva versión...',
        porcentaje: 0
    });

    try {
        await autoUpdater.checkForUpdates();
        return obtenerEstadoActualizacion();
    } catch (error) {
        busquedaEnCurso = false;

        return enviarEstadoActualizacion({
            estado: 'error',
            mensaje:
                error?.message ||
                'No se pudo comprobar si existe una actualización.'
        });
    }
}

async function descargarActualizacion() {
    if (!app.isPackaged) {
        return enviarEstadoActualizacion({
            estado: 'desarrollo',
            mensaje:
                'No se pueden descargar actualizaciones desde el modo de desarrollo.'
        });
    }

    if (descargaEnCurso) {
        return obtenerEstadoActualizacion();
    }

    if (estadoActualizacion.estado !== 'disponible') {
        return enviarEstadoActualizacion({
            mensaje: 'Primero tenés que buscar una actualización disponible.'
        });
    }

    descargaEnCurso = true;

    enviarEstadoActualizacion({
        estado: 'descargando',
        mensaje: 'Iniciando descarga...',
        porcentaje: 0
    });

    try {
        await autoUpdater.downloadUpdate();
        return obtenerEstadoActualizacion();
    } catch (error) {
        descargaEnCurso = false;

        return enviarEstadoActualizacion({
            estado: 'error',
            mensaje:
                error?.message ||
                'No se pudo descargar la actualización.'
        });
    }
}

function instalarActualizacion() {
    if (estadoActualizacion.estado !== 'descargada') {
        return {
            ...obtenerEstadoActualizacion(),
            correcto: false,
            mensaje: 'Todavía no hay una actualización descargada.'
        };
    }

    const respuesta = enviarEstadoActualizacion({
        estado: 'instalando',
        mensaje: 'Cerrando la aplicación para instalar la actualización...'
    });

    setTimeout(() => {
        autoUpdater.quitAndInstall(false, true);
    }, 600);

    return {
        ...respuesta,
        correcto: true
    };
}

function normalizarPreferenciasEscritorio(datos = {}) {
    return {
        mantenerEnSegundoPlano:
            datos.mantenerEnSegundoPlano !== false,
        iniciarConWindows:
            datos.iniciarConWindows !== false
    };
}

function cargarPreferenciasEscritorio(rutaConfiguracion) {
    const candidatos = [
        rutaConfiguracion,
        `${rutaConfiguracion}.bak`
    ];

    for (const ruta of candidatos) {
        if (!fs.existsSync(ruta)) continue;

        try {
            const datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
            preferenciasEscritorio =
                normalizarPreferenciasEscritorio(datos);
            return preferenciasEscritorio;
        } catch (error) {
            console.error(
                `No se pudieron leer las preferencias de escritorio desde ${path.basename(ruta)}:`,
                error.message
            );
        }
    }

    preferenciasEscritorio = normalizarPreferenciasEscritorio();
    return preferenciasEscritorio;
}

function configurarInicioConWindows() {
    if (process.platform !== 'win32' || !app.isPackaged) {
        return {
            disponible: false,
            activo: preferenciasEscritorio.iniciarConWindows
        };
    }

    app.setLoginItemSettings({
        openAtLogin: preferenciasEscritorio.iniciarConWindows,
        path: process.execPath,
        args: [ARGUMENTO_INICIO_AUTOMATICO]
    });

    const estado = app.getLoginItemSettings({
        path: process.execPath,
        args: [ARGUMENTO_INICIO_AUTOMATICO]
    });

    return {
        disponible: true,
        activo: estado.openAtLogin === true
    };
}

function aplicarPreferenciasEscritorio(datos = {}) {
    preferenciasEscritorio = normalizarPreferenciasEscritorio(datos);
    const inicioWindows = configurarInicioConWindows();

    return {
        ...preferenciasEscritorio,
        inicioWindows
    };
}

function mostrarVentanaPrincipal() {
    if (!ventanaPrincipal || ventanaPrincipal.isDestroyed()) {
        crearVentana(true);
        return;
    }

    ventanaPrincipal.setSkipTaskbar(false);
    if (ventanaPrincipal.isMinimized()) ventanaPrincipal.restore();
    ventanaPrincipal.show();
    ventanaPrincipal.focus();
}

function ocultarVentanaPrincipal() {
    if (!ventanaPrincipal || ventanaPrincipal.isDestroyed()) return;
    ventanaPrincipal.hide();
    ventanaPrincipal.setSkipTaskbar(true);
}

function crearIconoBandeja() {
    if (iconoBandeja && !iconoBandeja.isDestroyed()) return iconoBandeja;

    iconoBandeja = new Tray(RUTA_ICONO);
    iconoBandeja.setToolTip(
        'ZeroOne · ejecutándose en segundo plano'
    );
    iconoBandeja.setContextMenu(Menu.buildFromTemplate([
        {
            label: 'Abrir ZeroOne',
            click: mostrarVentanaPrincipal
        },
        { type: 'separator' },
        {
            label: 'Salir de ZeroOne',
            click: () => app.quit()
        }
    ]));
    iconoBandeja.on('click', mostrarVentanaPrincipal);
    iconoBandeja.on('double-click', mostrarVentanaPrincipal);

    return iconoBandeja;
}

function mostrarNotificacion(titulo, cuerpo) {
    if (!Notification.isSupported()) {
        return { correcto: false, mensaje: 'Las notificaciones no están disponibles.' };
    }

    const notificacion = new Notification({
        title: String(titulo || NOMBRE_APLICACION),
        body: String(cuerpo || ''),
        icon: RUTA_ICONO,
        silent: false
    });

    notificacion.on('click', () => {
        mostrarVentanaPrincipal();
    });

    notificacion.show();
    return { correcto: true };
}

async function abrirEnlaceExterno(valor) {
    let url;

    try {
        url = new URL(String(valor || ''));
    } catch {
        throw new Error('El enlace externo no es válido.');
    }

    if (url.protocol !== 'https:') {
        throw new Error('Solo se permiten enlaces externos seguros.');
    }

    await shell.openExternal(url.toString());
    return { correcto: true };
}

function cifrarDatoLocal(valor) {
    if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('El cifrado seguro de Windows no está disponible.');
    }

    return safeStorage.encryptString(String(valor || '')).toString('base64');
}

function descifrarDatoLocal(valor) {
    if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('El cifrado seguro de Windows no está disponible.');
    }

    return safeStorage.decryptString(Buffer.from(String(valor || ''), 'base64'));
}

function configurarIPC() {
    ipcMain.handle('actualizacion:obtener-estado', () => {
        return obtenerEstadoActualizacion();
    });

    ipcMain.handle('actualizacion:buscar', () => {
        return buscarActualizacion('manual');
    });

    ipcMain.handle('actualizacion:descargar', () => {
        return descargarActualizacion();
    });

    ipcMain.handle('actualizacion:instalar', () => {
        return instalarActualizacion();
    });

    ipcMain.handle('sistema:notificar', (_evento, datos = {}) => {
        return mostrarNotificacion(datos.titulo, datos.cuerpo);
    });

    ipcMain.handle('sistema:obtener-version', () => app.getVersion());
}

function exponerActualizadorAlServidor() {
    global.zerooneUpdater = {
        obtenerEstado: obtenerEstadoActualizacion,
        buscar: () => buscarActualizacion('manual'),
        descargar: descargarActualizacion,
        instalar: instalarActualizacion
    };

    global.zerooneDesktop = {
        notificar: mostrarNotificacion,
        obtenerVersion: () => app.getVersion(),
        abrirEnlace: abrirEnlaceExterno,
        aplicarPreferencias: aplicarPreferenciasEscritorio,
        obtenerPreferencias: () => ({
            ...preferenciasEscritorio
        })
    };

    global.zerooneSecureStorage = {
        disponible: () => safeStorage.isEncryptionAvailable(),
        cifrar: cifrarDatoLocal,
        descifrar: descifrarDatoLocal
    };
}

function urlPerteneceALaAplicacion(valor) {
    try {
        return new URL(String(valor || '')).origin === ORIGEN_APLICACION;
    } catch {
        return false;
    }
}

function esAtajoWebBloqueado(entrada = {}) {
    if (entrada.type && entrada.type !== 'keyDown') return false;

    const tecla = String(entrada.key || '').toLowerCase();
    const codigo = String(entrada.code || '').toLowerCase();
    const modificador = entrada.control === true || entrada.meta === true;

    if (tecla === 'f5' || tecla === 'f12') return true;
    if (!modificador) return false;

    if (['r', 'u', 's', 'p'].includes(tecla)) return true;
    if (
        (entrada.shift === true || entrada.alt === true) &&
        ['i', 'j', 'c'].includes(tecla)
    ) {
        return true;
    }

    return ['+', '=', '-', '_', '0', 'add', 'subtract'].includes(tecla) ||
        ['numpadadd', 'numpadsubtract', 'numpad0', 'digit0'].includes(codigo);
}

function endurecerSesionProduccion(sesion) {
    if (MODO_DESARROLLO_WEB || sesionesEndurecidas.has(sesion)) return;
    sesionesEndurecidas.add(sesion);

    sesion.setPermissionCheckHandler(() => false);
    sesion.setPermissionRequestHandler((_contenido, _permiso, responder) => {
        responder(false);
    });

    sesion.on('will-download', evento => {
        evento.preventDefault();
    });
}

function autorizarSesionEscritorio(sesion) {
    if (
        !TOKEN_SESION_ESCRITORIO ||
        sesionesAutorizadas.has(sesion)
    ) return;

    sesionesAutorizadas.add(sesion);
    sesion.webRequest.onBeforeSendHeaders(
        { urls: [`${ORIGEN_APLICACION}/*`] },
        (detalles, responder) => {
            responder({
                requestHeaders: {
                    ...detalles.requestHeaders,
                    'X-ZeroOne-Desktop': TOKEN_SESION_ESCRITORIO
                }
            });
        }
    );
}

function protegerContenidoVentana(ventana) {
    const contenido = ventana.webContents;

    autorizarSesionEscritorio(contenido.session);

    contenido.on('will-navigate', (evento, destino) => {
        if (!urlPerteneceALaAplicacion(destino)) evento.preventDefault();
    });

    contenido.on('will-redirect', (evento, destino) => {
        if (!urlPerteneceALaAplicacion(destino)) evento.preventDefault();
    });

    contenido.setWindowOpenHandler(() => ({ action: 'deny' }));
    contenido.on('will-attach-webview', evento => evento.preventDefault());

    if (MODO_DESARROLLO_WEB) return;

    contenido.on('before-input-event', (evento, entrada) => {
        if (esAtajoWebBloqueado(entrada)) evento.preventDefault();
    });

    contenido.on('context-menu', evento => evento.preventDefault());
    contenido.on('devtools-opened', () => contenido.closeDevTools());

    contenido.on('page-title-updated', evento => {
        evento.preventDefault();
        if (!ventana.isDestroyed()) ventana.setTitle(NOMBRE_APLICACION);
    });

    endurecerSesionProduccion(contenido.session);
}

function crearVentana(mostrarAlCargar = true) {
    const rutaPreload = path.join(__dirname, 'preload.js');

    ventanaPrincipal = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 700,
        minHeight: 600,
        show: false,
        autoHideMenuBar: true,
        title: NOMBRE_APLICACION,
        icon: RUTA_ICONO,
        backgroundColor: '#09060f',

        webPreferences: {
            preload: rutaPreload,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            devTools: MODO_DESARROLLO_WEB,
            navigateOnDragDrop: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            webviewTag: false
        }
    });

    if (!MODO_DESARROLLO_WEB) {
        ventanaPrincipal.setMenu(null);
        ventanaPrincipal.setMenuBarVisibility(false);
    }

    protegerContenidoVentana(ventanaPrincipal);

    ventanaPrincipal.maximize();

    ventanaPrincipal.webContents.on('preload-error', (_evento, ruta, error) => {
        console.error('Error cargando preload:', ruta, error);
    });

    ventanaPrincipal.webContents.on('did-finish-load', () => {
        enviarEstadoActualizacion();
    });

    ventanaPrincipal.on('close', evento => {
        if (
            cierreAplicacionEnCurso ||
            cierreAplicacionCompletado ||
            !preferenciasEscritorio.mantenerEnSegundoPlano
        ) {
            return;
        }

        evento.preventDefault();
        ocultarVentanaPrincipal();
    });

    async function cargarAplicacion() {
        if (!ventanaPrincipal || ventanaPrincipal.isDestroyed()) {
            return;
        }

        try {
            await ventanaPrincipal.loadURL(URL_APLICACION);

            if (ventanaPrincipal && !ventanaPrincipal.isDestroyed()) {
                ventanaPrincipal.maximize();
                if (mostrarAlCargar) {
                    mostrarVentanaPrincipal();
                } else {
                    ocultarVentanaPrincipal();
                }
            }
        } catch (error) {
            console.log(
                'El servidor todavía no está listo. Reintentando...',
                error.message
            );

            setTimeout(cargarAplicacion, 1000);
        }
    }

    cargarAplicacion();

    ventanaPrincipal.on('closed', () => {
        ventanaPrincipal = null;
    });
}

function iniciarComprobacionesAutomaticas() {
    setTimeout(() => {
        buscarActualizacion('automatico');
    }, 15000);

    temporizadorActualizaciones = setInterval(() => {
        buscarActualizacion('automatico');
    }, INTERVALO_ACTUALIZACIONES);
}

const bloqueoObtenido = app.requestSingleInstanceLock();

if (!bloqueoObtenido) {
    app.quit();
} else {
    app.on('second-instance', (_evento, lineaComandos = []) => {
        if (
            preferenciasEscritorio.mantenerEnSegundoPlano &&
            lineaComandos.includes(ARGUMENTO_INICIO_AUTOMATICO)
        ) {
            return;
        }

        mostrarVentanaPrincipal();
    });

    app.whenReady().then(() => {
        // Conserva la ubicación histórica para que una actualización de marca
        // no cree un perfil vacío ni obligue a volver a vincular las líneas.
        app.setPath(
            'userData',
            path.join(app.getPath('appData'), 'autostatues')
        );
        app.setAppUserModelId('com.zabo.autostatues');

        if (!MODO_DESARROLLO_WEB) {
            Menu.setApplicationMenu(null);
        }

        const carpetaDatos = path.join(
            app.getPath('userData'),
            'datos'
        );

        fs.mkdirSync(carpetaDatos, {
            recursive: true
        });

        process.env.ZEROONE_DATA_DIR = carpetaDatos;
        process.env.ZEROONE_AI_DIR = path.join(
            process.env.LOCALAPPDATA || app.getPath('userData'),
            'AutoStatues',
            'ia'
        );

        cargarPreferenciasEscritorio(
            path.join(carpetaDatos, 'configuracion.json')
        );
        configurarInicioConWindows();
        configurarActualizador();
        configurarIPC();
        exponerActualizadorAlServidor();

        require('./src/bot.js');

        crearIconoBandeja();
        crearVentana(
            !(
                INICIO_AUTOMATICO_SOLICITADO &&
                preferenciasEscritorio.mantenerEnSegundoPlano
            )
        );
        iniciarComprobacionesAutomaticas();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                crearVentana(true);
            } else {
                mostrarVentanaPrincipal();
            }
        });
    });
}

app.on('before-quit', evento => {
    if (cierreAplicacionCompletado) return;
    evento.preventDefault();
    if (cierreAplicacionEnCurso) return;
    cierreAplicacionEnCurso = true;
    if (temporizadorActualizaciones) {
        clearInterval(temporizadorActualizaciones);
        temporizadorActualizaciones = null;
    }
    Promise.resolve(
        global.zerooneIaLocal?.cerrarYEsperar?.(5000)
    ).then(cerrado => {
        if (cerrado === false) {
            console.error(
                'El motor de IA no confirmó su cierre antes de salir.'
            );
        }
    }).catch(error => {
        console.error(
            'No se pudo confirmar el cierre del motor de IA:',
            error?.message || error
        );
    }).finally(() => {
        global.zerooneAlmacenMensajes?.cerrar?.();
        global.zerooneAlmacenMensajes = null;
        if (iconoBandeja && !iconoBandeja.isDestroyed()) {
            iconoBandeja.destroy();
        }
        iconoBandeja = null;
        cierreAplicacionCompletado = true;
        app.quit();
    });
});

app.on('window-all-closed', () => {
    if (
        process.platform !== 'darwin' &&
        !preferenciasEscritorio.mantenerEnSegundoPlano
    ) {
        app.quit();
    }
});
