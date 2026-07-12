const {
    app,
    BrowserWindow,
    ipcMain,
    Notification
} = require('electron');

const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

const URL_APLICACION = 'http://127.0.0.1:3000';
const INTERVALO_ACTUALIZACIONES = 5 * 60 * 60 * 1000;

let ventanaPrincipal = null;
let temporizadorActualizaciones = null;
let busquedaEnCurso = false;
let descargaEnCurso = false;

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
        title: String(titulo || 'AutoStatues'),
        body: String(cuerpo || ''),
        silent: false
    });

    notificacion.on('click', () => {
        if (!ventanaPrincipal || ventanaPrincipal.isDestroyed()) return;
        if (ventanaPrincipal.isMinimized()) ventanaPrincipal.restore();
        ventanaPrincipal.show();
        ventanaPrincipal.focus();
    });

    notificacion.show();
    return { correcto: true };
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
    global.autostatuesUpdater = {
        obtenerEstado: obtenerEstadoActualizacion,
        buscar: () => buscarActualizacion('manual'),
        descargar: descargarActualizacion,
        instalar: instalarActualizacion
    };

    global.autostatuesDesktop = {
        notificar: mostrarNotificacion,
        obtenerVersion: () => app.getVersion()
    };
}

function crearVentana() {
    const rutaPreload = app.isPackaged
        ? path.join(process.resourcesPath, 'preload.js')
        : path.join(__dirname, 'preload.js');

    ventanaPrincipal = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 700,
        minHeight: 600,
        show: false,
        autoHideMenuBar: true,
        title: 'AutoStatues',
        backgroundColor: '#080c16',

        webPreferences: {
            preload: rutaPreload,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    ventanaPrincipal.maximize();

    ventanaPrincipal.webContents.on('preload-error', (_evento, ruta, error) => {
        console.error('Error cargando preload:', ruta, error);
    });

    ventanaPrincipal.webContents.on('did-finish-load', () => {
        enviarEstadoActualizacion();
    });

    async function cargarAplicacion() {
        if (!ventanaPrincipal || ventanaPrincipal.isDestroyed()) {
            return;
        }

        try {
            await ventanaPrincipal.loadURL(URL_APLICACION);

            if (ventanaPrincipal && !ventanaPrincipal.isDestroyed()) {
                ventanaPrincipal.maximize();
                ventanaPrincipal.show();
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
    app.on('second-instance', () => {
        if (!ventanaPrincipal) return;

        if (ventanaPrincipal.isMinimized()) {
            ventanaPrincipal.restore();
        }

        ventanaPrincipal.show();
        ventanaPrincipal.focus();
    });

    app.whenReady().then(() => {
        app.setAppUserModelId('com.zabo.autostatues');

        const carpetaDatos = path.join(
            app.getPath('userData'),
            'datos'
        );

        fs.mkdirSync(carpetaDatos, {
            recursive: true
        });

        process.env.AUTOSTATUES_DATA_DIR = carpetaDatos;

        configurarActualizador();
        configurarIPC();
        exponerActualizadorAlServidor();

        require('./src/bot.js');

        crearVentana();
        iniciarComprobacionesAutomaticas();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                crearVentana();
            }
        });
    });
}

app.on('before-quit', () => {
    if (temporizadorActualizaciones) {
        clearInterval(temporizadorActualizaciones);
        temporizadorActualizaciones = null;
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
