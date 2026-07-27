const {
    contextBridge,
    ipcRenderer
} = require('electron');

contextBridge.exposeInMainWorld('actualizador', {
    obtenerEstado() {
        return ipcRenderer.invoke('actualizacion:obtener-estado');
    },

    buscar() {
        return ipcRenderer.invoke('actualizacion:buscar');
    },

    descargar() {
        return ipcRenderer.invoke('actualizacion:descargar');
    },

    instalar() {
        return ipcRenderer.invoke('actualizacion:instalar');
    },

    alCambiarEstado(callback) {
        if (typeof callback !== 'function') {
            return () => {};
        }

        const listener = (_evento, estado) => {
            callback(estado);
        };

        ipcRenderer.on('actualizacion:estado', listener);

        return () => {
            ipcRenderer.removeListener(
                'actualizacion:estado',
                listener
            );
        };
    }
});

contextBridge.exposeInMainWorld('sistema', {
    notificar(titulo, cuerpo) {
        return ipcRenderer.invoke('sistema:notificar', { titulo, cuerpo });
    },

    obtenerVersion() {
        return ipcRenderer.invoke('sistema:obtener-version');
    },

    abrirCarpetaLogs() {
        return ipcRenderer.invoke('sistema:abrir-carpeta-logs');
    },

    crearLog() {
        return ipcRenderer.invoke('sistema:crear-log');
    },

    copiarLog() {
        return ipcRenderer.invoke('sistema:copiar-log');
    },

    eliminarLog() {
        return ipcRenderer.invoke('sistema:eliminar-log');
    }
});
