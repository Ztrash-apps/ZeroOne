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
