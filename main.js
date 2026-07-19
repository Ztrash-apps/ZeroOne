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
const ARGUMENTO_INICIO_WINDOWS = '--inicio-windows';
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
const INICIO_DESDE_WINDOWS = process.argv.includes(
    ARGUMENTO_INICIO_WINDOWS
);

app.setName(NOMBRE_APLICACION);
process.env.ZEROONE_DESKTOP_TOKEN = TOKEN_SESION_ESCRITORIO;

let ventanaPrincipal = null;
let bandejaSistema = null;
let temporizadorActualizaciones = null;
let busquedaEnCurso = false;
let descargaEnCurso = false;
let cierreAplicacionEnCurso = false;
let cierreAplicacionCompletado = false;
let salidaSolicitada = false;
let mostrarVentanaSolicitada = !INICIO_DESDE_WINDOWS;
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

function mostrarVentanaPrincipal() {
    if (salidaSolicitada || cierreAplicacionEnCurso) return;
    mostrarVentanaSolicitada = true;
    if (!ventanaPrincipal || ventanaPrincipal.isDestroyed()) {
        if (app.isReady() && !salidaSolicitada) {
            crearVentana({ mostrarAlCargar: true });
        }
        return;
    }

    if (ventanaPrincipal.isMinimized()) {
        ventanaPrincipal.restore();
    }

    ventanaPrincipal.show();
    ventanaPrincipal.focus();
}

function ocultarVentanaPrincipal() {
    mostrarVentanaSolicitada = false;
    if (!ventanaPrincipal || ventanaPrincipal.isDestroyed()) return;
    ventanaPrincipal.hide();
}

function inicioConWindowsDisponible() {
    return process.platform === 'win32' && app.isPackaged;
}

function obtenerInicioConWindows() {
    if (!inicioConWindowsDisponible()) return false;

    return app.getLoginItemSettings({
        path: process.execPath,
        args: [ARGUMENTO_INICIO_WINDOWS]
    }).openAtLogin === true;
}

function guardarPreferenciaInicioWindows(activo) {
    if (!inicioConWindowsDisponible()) return;

    const ruta = path.join(
        app.getPath('userData'),
        'inicio-windows.json'
    );
    fs.writeFileSync(
        ruta,
        JSON.stringify({
            configurado: true,
            activo: activo === true
        })
    );
}

function establecerInicioConWindows(activo) {
    if (!inicioConWindowsDisponible()) return false;

    app.setLoginItemSettings({
        openAtLogin: activo === true,
        path: process.execPath,
        args: [ARGUMENTO_INICIO_WINDOWS]
    });

    const resultado = obtenerInicioConWindows();
    guardarPreferenciaInicioWindows(resultado);
    return resultado;
}

function configurarInicioWindowsPredeterminado() {
    if (!inicioConWindowsDisponible()) return;

    const ruta = path.join(
        app.getPath('userData'),
        'inicio-windows.json'
    );
    if (fs.existsSync(ruta)) return;

    // La primera ejecución de esta versión adopta el comportamiento
    // solicitado también para instalaciones actualizadas. Después el usuario
    // conserva control total desde el menú de la bandeja.
    establecerInicioConWindows(true);
}

function solicitarSalidaAplicacion() {
    salidaSolicitada = true;
    app.quit();
}

function prepararSalidaRapidaDelSistema() {
    salidaSolicitada = true;
    if (temporizadorActualizaciones) {
        clearInterval(temporizadorActualizaciones);
        temporizadorActualizaciones = null;
    }
    try {
        global.zerooneBackend?.cerrarInmediato?.();
    } catch (error) {
        console.error(
            'No se pudo iniciar el cierre inmediato del backend:',
            error?.message || error
        );
    }
    try {
        global.zerooneIaLocal?.detener?.();
    } catch (error) {
        console.error(
            'No se pudo detener inmediatamente el motor de IA:',
            error?.message || error
        );
    }
    try {
        global.zerooneAlmacenMensajes?.cerrar?.();
        global.zerooneAlmacenMensajes = null;
    } catch (error) {
        console.error(
            'No se pudo cerrar inmediatamente el almacén local:',
            error?.message || error
        );
    }
}

function crearBandejaSistema() {
    if (bandejaSistema && !bandejaSistema.isDestroyed()) {
        return bandejaSistema;
    }

    bandejaSistema = new Tray(RUTA_ICONO);
    bandejaSistema.setToolTip(NOMBRE_APLICACION);

    const inicioDisponible = inicioConWindowsDisponible();
    const menu = Menu.buildFromTemplate([
        {
            label: `Mostrar ${NOMBRE_APLICACION}`,
            click: mostrarVentanaPrincipal
        },
        {
            label: 'Iniciar con Windows',
            type: 'checkbox',
            checked: obtenerInicioConWindows(),
            enabled: inicioDisponible,
            toolTip: inicioDisponible
                ? 'Abrir ZeroOne oculto en la bandeja al iniciar Windows.'
                : 'Esta opcion esta disponible en la aplicacion instalada.',
            click: elemento => {
                try {
                    elemento.checked = establecerInicioConWindows(
                        elemento.checked
                    );
                } catch (error) {
                    elemento.checked = obtenerInicioConWindows();
                    console.error(
                        'No se pudo cambiar el inicio con Windows:',
                        error?.message || error
                    );
                }
            }
        },
        { type: 'separator' },
        {
            label: 'Salir',
            click: solicitarSalidaAplicacion
        }
    ]);

    bandejaSistema.setContextMenu(menu);
    bandejaSistema.on('click', mostrarVentanaPrincipal);

    return bandejaSistema;
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
        abrirEnlace: abrirEnlaceExterno
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

function crearVentana({ mostrarAlCargar = true } = {}) {
    mostrarVentanaSolicitada = mostrarAlCargar === true;
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
    const ventanaCreada = ventanaPrincipal;

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

    async function cargarAplicacion() {
        if (
            ventanaPrincipal !== ventanaCreada ||
            ventanaCreada.isDestroyed()
        ) {
            return;
        }

        try {
            await ventanaCreada.loadURL(URL_APLICACION);

            if (
                ventanaPrincipal === ventanaCreada &&
                !ventanaCreada.isDestroyed()
            ) {
                ventanaCreada.maximize();
                if (mostrarVentanaSolicitada) {
                    mostrarVentanaPrincipal();
                } else {
                    ocultarVentanaPrincipal();
                }
            }
        } catch (error) {
            if (
                ventanaPrincipal !== ventanaCreada ||
                ventanaCreada.isDestroyed()
            ) return;
            console.log(
                'El servidor todavía no está listo. Reintentando...',
                error.message
            );

            setTimeout(cargarAplicacion, 1000);
        }
    }

    cargarAplicacion();

    ventanaCreada.on('close', evento => {
        if (salidaSolicitada || cierreAplicacionCompletado) return;
        evento.preventDefault();
        mostrarVentanaSolicitada = false;
        ventanaCreada.hide();
    });

    ventanaCreada.on('closed', () => {
        if (ventanaPrincipal === ventanaCreada) {
            ventanaPrincipal = null;
        }
    });

    // Windows permite demorar el cierre en query-session-end. Se usa el mismo
    // drenaje seguro que al elegir Salir; session-end queda como último recurso
    // cuando el sistema ya no admite cancelar el evento.
    ventanaCreada.on('query-session-end', evento => {
        if (cierreAplicacionCompletado) return;
        evento.preventDefault();
        solicitarSalidaAplicacion();
    });
    ventanaCreada.on('session-end', prepararSalidaRapidaDelSistema);
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
    salidaSolicitada = true;
    app.quit();
} else {
    app.on('second-instance', () => {
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

        try {
            configurarInicioWindowsPredeterminado();
        } catch (error) {
            console.error(
                'No se pudo configurar el inicio con Windows; ' +
                'ZeroOne continuará abriendo normalmente:',
                error?.message || error
            );
        }

        process.env.ZEROONE_DATA_DIR = carpetaDatos;
        process.env.ZEROONE_AI_DIR = path.join(
            process.env.LOCALAPPDATA || app.getPath('userData'),
            'AutoStatues',
            'ia'
        );

        configurarActualizador();
        configurarIPC();
        exponerActualizadorAlServidor();

        require('./src/bot.js');

        crearVentana({
            mostrarAlCargar: !INICIO_DESDE_WINDOWS
        });
        crearBandejaSistema();
        iniciarComprobacionesAutomaticas();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                crearVentana();
                return;
            }

            mostrarVentanaPrincipal();
        });
    });
}

app.on('before-quit', evento => {
    if (cierreAplicacionCompletado) return;
    evento.preventDefault();
    if (cierreAplicacionEnCurso) return;
    cierreAplicacionEnCurso = true;
    salidaSolicitada = true;
    ocultarVentanaPrincipal();
    if (temporizadorActualizaciones) {
        clearInterval(temporizadorActualizaciones);
        temporizadorActualizaciones = null;
    }
    const cerrarBackendConReintento = async () => {
        let avisoMostrado = false;
        while (true) {
            try {
                const resultado = await global.zerooneBackend?.cerrarYEsperar?.(
                    15000
                );
                if (resultado === true) return true;
            } catch (error) {
                console.error(
                    'El cierre seguro del backend se reintentará:',
                    error?.message || error
                );
            }

            // El backend ya dejó de aceptar operaciones y no se puede volver
            // a presentar la ventana como operativa. Se mantiene el mismo
            // cierre en curso hasta confirmar las escrituras pendientes.
            if (!avisoMostrado) {
                avisoMostrado = true;
                try {
                    if (Notification.isSupported()) {
                        new Notification({
                            title: 'ZeroOne está terminando de guardar',
                            body:
                                'El cierre está demorando porque aún hay datos seguros pendientes. No apagues el equipo.'
                        }).show();
                    }
                } catch {}
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    };

    Promise.allSettled([
        cerrarBackendConReintento(),
        Promise.resolve(
            global.zerooneIaLocal?.cerrarYEsperar?.(5000)
        )
    ]).then(([backend, ia]) => {
        const backendSeguro =
            backend.status === 'fulfilled' && backend.value === true;
        if (backend.status === 'rejected') {
            console.error(
                'No se pudo confirmar el cierre seguro del backend:',
                backend.reason?.message || backend.reason
            );
        } else if (backend.value === false) {
            console.error(
                'El backend no confirmó todos sus guardados antes de salir.'
            );
        }
        if (ia.status === 'rejected') {
            console.error(
                'No se pudo confirmar el cierre del motor de IA:',
                ia.reason?.message || ia.reason
            );
        } else if (ia.value === false) {
            console.error(
                'El motor de IA no confirmó su cierre antes de salir.'
            );
        }

        if (!backendSeguro) {
            throw new Error(
                'El backend no confirmó el cierre seguro de las credenciales.'
            );
        }

        global.zerooneAlmacenMensajes?.cerrar?.();
        global.zerooneAlmacenMensajes = null;
        if (bandejaSistema && !bandejaSistema.isDestroyed()) {
            bandejaSistema.destroy();
        }
        bandejaSistema = null;
        cierreAplicacionCompletado = true;
        app.quit();
    }).catch(error => {
        console.error(
            'ZeroOne no pudo completar el cierre seguro:',
            error?.message || error
        );
        // No se reactiva una interfaz cuyo backend ya está detenido. Un
        // nuevo before-quit podrá continuar el mismo drenaje.
        cierreAplicacionEnCurso = false;
        try {
            if (Notification.isSupported()) {
                new Notification({
                    title: 'ZeroOne protegió tus sesiones',
                    body:
                        'No se confirmó el cierre. Volvé a elegir Salir para continuar el drenaje seguro.'
                }).show();
            }
        } catch (errorNotificacion) {
            console.error(
                'No se pudo mostrar la alerta de cierre seguro:',
                errorNotificacion?.message || errorNotificacion
            );
        }
    });
});

app.on('window-all-closed', () => {
    // La aplicacion permanece activa en la bandeja hasta elegir "Salir".
});
