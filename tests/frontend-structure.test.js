'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const raiz = path.resolve(__dirname, '..');
const rutaPublica = path.join(raiz, 'public');

test('la interfaz carga módulos ordenados y no conserva el script monolítico', () => {
    const html = fs.readFileSync(path.join(rutaPublica, 'index.html'), 'utf8');
    const modulos = [
        'shell.js',
        'lines.js',
        'agenda.js',
        'publication.js',
        'manuals.js',
        'bootstrap.js'
    ];

    let posicionAnterior = -1;
    const fuentes = [];
    for (const modulo of modulos) {
        const etiqueta = `<script src="/js/${modulo}"></script>`;
        const posicion = html.indexOf(etiqueta);
        assert.ok(posicion > posicionAnterior, `${modulo} debe conservar su orden`);
        posicionAnterior = posicion;
        const ruta = path.join(rutaPublica, 'js', modulo);
        assert.equal(fs.existsSync(ruta), true, `${modulo} debe existir`);
        fuentes.push(fs.readFileSync(ruta, 'utf8'));
    }

    assert.equal(/<script>\s*[\s\S]+?<\/script>/u.test(html), false);
    assert.doesNotThrow(() => {
        new vm.Script(fuentes.join('\n'), { filename: 'zeroone-ui.js' });
    });
});

test('los estilos conservan su cascada por módulos y terminan en el sistema visual', () => {
    const html = fs.readFileSync(path.join(rutaPublica, 'index.html'), 'utf8');
    const estilos = [
        'foundation.css',
        'interface.css',
        'themes.css',
        'features.css',
        'design-system.css'
    ];

    let posicionAnterior = -1;
    for (const estilo of estilos) {
        const etiqueta = `<link rel="stylesheet" href="/css/${estilo}">`;
        const posicion = html.indexOf(etiqueta);
        assert.ok(posicion > posicionAnterior, `${estilo} debe conservar su cascada`);
        posicionAnterior = posicion;
        assert.equal(
            fs.existsSync(path.join(rutaPublica, 'css', estilo)),
            true,
            `${estilo} debe existir`
        );
    }

    const sistema = fs.readFileSync(
        path.join(rutaPublica, 'css', 'design-system.css'),
        'utf8'
    );
    assert.match(sistema, /ZeroOne Interface System/u);
    assert.match(sistema, /content-visibility:\s*auto/u);
});

test('las tareas periódicas se pausan fuera de su pantalla o con la app oculta', () => {
    const bootstrap = fs.readFileSync(
        path.join(rutaPublica, 'js', 'bootstrap.js'),
        'utf8'
    );
    assert.match(bootstrap, /document\.hidden/u);
    assert.match(bootstrap, /seccionesPermitidas\.has\(seccionActual\)/u);
    assert.doesNotMatch(bootstrap, /setInterval\(actualizarLineas/u);
});

test('el panel de actualizaciones muestra el nombre de la release actual o disponible', () => {
    const html = fs.readFileSync(path.join(rutaPublica, 'index.html'), 'utf8');
    const bootstrap = fs.readFileSync(
        path.join(rutaPublica, 'js', 'bootstrap.js'),
        'utf8'
    );
    const estilos = fs.readFileSync(
        path.join(rutaPublica, 'css', 'foundation.css'),
        'utf8'
    );

    assert.match(html, /id="sidebar-app-version"/u);
    assert.match(html, /The Update that Changed the World/u);
    assert.match(bootstrap, /estado\.tituloVersionDisponible/u);
    assert.match(bootstrap, /estado\.tituloVersionActual/u);
    assert.match(estilos, /\.sidebar-version\s*\{[\s\S]+-webkit-line-clamp:\s*2/u);
});

test('Configuración integra los manuales locales en un lector seguro y navegable', () => {
    const html = fs.readFileSync(path.join(rutaPublica, 'index.html'), 'utf8');
    const manuales = fs.readFileSync(
        path.join(rutaPublica, 'js', 'manuals.js'),
        'utf8'
    );
    const bootstrap = fs.readFileSync(
        path.join(rutaPublica, 'js', 'bootstrap.js'),
        'utf8'
    );
    const lineas = fs.readFileSync(
        path.join(rutaPublica, 'js', 'lines.js'),
        'utf8'
    );
    const estilos = fs.readFileSync(
        path.join(rutaPublica, 'css', 'features.css'),
        'utf8'
    );

    assert.match(html, /data-settings-tab="manuales"/u);
    assert.match(html, /data-settings-panel="manuales"/u);
    assert.doesNotMatch(
        html,
        /data-settings-panel="manuales"[^>]+data-settings-editable="true"/u
    );
    assert.match(html, /id="manuals-toc"/u);
    assert.match(html, /id="manuals-reader-content"/u);
    assert.match(html, /id="manuals-reader-state"/u);
    assert.match(html, /data-manual-type="uso"/u);
    assert.match(html, /data-manual-type="tecnico"/u);
    assert.match(html, /id="i-lock"/u);
    assert.match(bootstrap, /'manuales'/u);
    assert.match(bootstrap, /inicializarManuales()/u);
    assert.match(bootstrap, /activa === 'manuales'[\s\S]+cargarManualZeroOne/u);
    assert.match(
        bootstrap,
        /panelActivo\?\.dataset\.settingsEditable === 'true'/u
    );
    assert.match(manuales, /fetch\(`\/manuales\/\$\{encodeURIComponent\(manualTipo\)\}`/u);
    assert.match(manuales, /\/manuales\/tecnico\/desbloquear/u);
    assert.match(manuales, /method:\s*'POST'/u);
    assert.match(manuales, /input\.type\s*=\s*'password'/u);
    assert.match(manuales, /MANUAL_PROTEGIDO/u);
    assert.match(manuales, /function bloquearManualTecnicoAlSalir\(\)/u);
    assert.match(manuales, /cache\.delete\('tecnico'\)/u);
    assert.doesNotMatch(manuales, /localStorage[\s\S]{0,180}contrasena|contrasena[\s\S]{0,180}localStorage/u);
    assert.match(manuales, /document\.createDocumentFragment\(\)/u);
    assert.doesNotMatch(manuales, /innerHTML/u);
    assert.match(estilos, /\.manuals-workspace\s*\{/u);
    assert.match(estilos, /\.manuals-reader\s*\{/u);
    assert.match(estilos, /\.manuals-toc\s*\{/u);
    assert.match(
        estilos,
        /#section-configuracion \.settings-tab-panel\s*\{[\s\S]+min-height:\s*0/u
    );
    assert.match(
        estilos,
        /#section-configuracion \.manuals-settings-panel\s*\{[\s\S]+min-height:\s*0/u
    );
    assert.match(
        estilos,
        /\.manuals-reader\s*\{[\s\S]+min-height:\s*0[\s\S]+overflow:\s*visible/u
    );
    assert.match(estilos, /\.manuals-locked-state\s*\{/u);
    assert.match(estilos, /\.manuals-unlock-form\s*\{/u);
    assert.match(estilos, /\.settings-global-actions\[hidden\]\s*\{/u);
    assert.match(bootstrap, /bloquearManualTecnicoAlSalir\(\)/u);
    assert.match(lineas, /bloquearManualTecnicoAlSalir\(\)/u);
});

test('las acciones de Configuración aparecen solo donde hay preferencias para guardar', () => {
    const html = fs.readFileSync(path.join(rutaPublica, 'index.html'), 'utf8');

    for (const panel of [
        'general',
        'publicacion',
        'seguridad',
        'rendimiento',
        'agendamiento',
        'apariencia'
    ]) {
        assert.match(
            html,
            new RegExp(
                `data-settings-panel="${panel}"[^>]+data-settings-editable="true"`,
                'u'
            )
        );
    }
    assert.match(
        html,
        /data-settings-panel="general"[\s\S]+id="btn-probar-notificacion"/u
    );
    assert.match(html, /id="settings-global-actions"/u);
});

test('el envío incierto se confirma por solicitud sin cerrar el progreso', () => {
    const html = fs.readFileSync(path.join(rutaPublica, 'index.html'), 'utf8');
    const publicacion = fs.readFileSync(
        path.join(rutaPublica, 'js', 'publication.js'),
        'utf8'
    );
    const bootstrap = fs.readFileSync(
        path.join(rutaPublica, 'js', 'bootstrap.js'),
        'utf8'
    );
    const interfaz = fs.readFileSync(
        path.join(rutaPublica, 'css', 'interface.css'),
        'utf8'
    );

    assert.match(html, /id="confirmacion-envio-progreso"/u);
    assert.match(html, /id="btn-confirmar-envio-publicado"/u);
    assert.match(html, /id="btn-omitir-envio-no-publicado"/u);
    assert.match(html, /id="texto-omitir-envio-no-publicado"/u);
    assert.match(
        html,
        /id="btn-confirmar-envio-publicado"[\s\S]+id="btn-omitir-envio-no-publicado"/u
    );
    assert.match(html, /id="btn-simulacro-envio"[\s\S]+Modo de prueba/u);
    assert.match(publicacion, /confirmacionEnvioPendiente\?\.solicitudId/u);
    assert.match(publicacion, /Esperando tu confirmación/u);
    assert.match(
        publicacion,
        /texto-omitir-envio-no-publicado[\s\S]+Omitir \$\{nombre \|\| numero \|\| 'esta línea'\} y continuar con el resto/u
    );
    assert.match(
        interfaz,
        /\.uncertain-send-button\s*\{[\s\S]+line-height:\s*1\.35;[\s\S]+white-space:\s*normal;/u
    );
    assert.match(publicacion, /simulacroDisponible\s*===\s*true/u);
    assert.match(
        bootstrap,
        /fetch\('\/progreso\/confirmar-envio'[\s\S]+solicitudId,\s*resultado/u
    );
    assert.match(
        bootstrap,
        /fetch\('\/progreso\/simulacro-envio'[\s\S]+method:\s*'POST'/u
    );
});

test('cada decisión segura permite omitir la línea identificada o detener la campaña', () => {
    const html = fs.readFileSync(path.join(rutaPublica, 'index.html'), 'utf8');
    const publicacion = fs.readFileSync(
        path.join(rutaPublica, 'js', 'publication.js'),
        'utf8'
    );
    const bootstrap = fs.readFileSync(
        path.join(rutaPublica, 'js', 'bootstrap.js'),
        'utf8'
    );

    assert.match(html, /id="titulo-alerta-seguridad"/u);
    assert.match(html, /id="texto-reanudar-seguridad"/u);
    assert.match(html, /id="texto-cancelar-seguridad"/u);
    assert.match(
        publicacion,
        /decisionSeguridad\.permiteOmitir\s*===\s*true[\s\S]+Omitir \$\{lineaDecision \|\| 'la línea fallida'\} y continuar con el resto/u
    );
    assert.match(
        publicacion,
        /decisionSeguridadPendiente[\s\S]+\.permiteOmitir\s*===\s*true[\s\S]+Esperando tu decisión/u
    );
    assert.match(
        publicacion,
        /Omitir \$\{cantidadLineasNoDisponibles\} líneas no disponibles y continuar con el resto/u
    );
    assert.match(
        publicacion,
        /dataset\.permiteOmitir[\s\S]+Error en \$\{lineaDecision\}/u
    );
    assert.match(
        bootstrap,
        /dataset\.permiteOmitir\s*===\s*'true'[\s\S]+Detener campaña/u
    );
});

test('el progreso distingue la preparación segura de un envío ya iniciado', () => {
    const publicacion = fs.readFileSync(
        path.join(rutaPublica, 'js', 'publication.js'),
        'utf8'
    );

    assert.match(
        publicacion,
        /preparacion_transitoria:\s*'Servicio temporal de WhatsApp'/u
    );
    assert.match(
        publicacion,
        /progreso\.estado === 'preparando_entrega'[\s\S]+Preparando entrega/u
    );
    assert.match(
        publicacion,
        /progreso\.estado === 'esperando_reintento_preparacion'[\s\S]+Preparando reintento seguro/u
    );
});

test('Ajustes permite configurar el enfriamiento preventivo sin alterar WA_429', () => {
    const html = fs.readFileSync(path.join(rutaPublica, 'index.html'), 'utf8');
    const bootstrap = fs.readFileSync(
        path.join(rutaPublica, 'js', 'bootstrap.js'),
        'utf8'
    );

    assert.match(
        html,
        /id="config-enfriamiento-preventivo-minutos"[^>]+min="1"[^>]+max="15"/u
    );
    assert.match(html, /id="config-enfriamiento-preventivo-valor"/u);
    assert.match(html, /WA_429 no se puede configurar/u);
    assert.match(html, /WhatsApp determina ese tiempo de espera/u);
    assert.match(
        bootstrap,
        /data\.enfriamientoPreventivoMinutos[\s\S]+textoEnfriamientoPreventivo/u
    );
    assert.match(
        bootstrap,
        /body:\s*JSON\.stringify\([\s\S]+enfriamientoPreventivoMinutos/u
    );
});

test('Ajustes ofrece rendimiento adaptativo sin hibernar ni desconectar líneas', () => {
    const html = fs.readFileSync(path.join(rutaPublica, 'index.html'), 'utf8');
    const shell = fs.readFileSync(
        path.join(rutaPublica, 'js', 'shell.js'),
        'utf8'
    );
    const bootstrap = fs.readFileSync(
        path.join(rutaPublica, 'js', 'bootstrap.js'),
        'utf8'
    );

    assert.match(html, /id="config-modo-rendimiento"/u);
    for (const modo of ['normal', 'adaptativo', 'ahorro']) {
        assert.match(
            html,
            new RegExp(
                `input[^>]+name="config-modo-rendimiento"[^>]+value="${modo}"`,
                'u'
            ),
            `debe ofrecer el modo ${modo}`
        );
    }
    assert.match(
        html,
        /input[^>]+name="config-modo-rendimiento"[^>]+value="normal"[^>]+checked/u
    );
    assert.doesNotMatch(
        html,
        /<select[^>]+id="config-modo-rendimiento"/u
    );
    assert.match(
        html,
        /id="config-modo-rendimiento"[\s\S]+role|<fieldset[\s\S]+id="config-modo-rendimiento"/u
    );
    assert.match(html, /id="estado-modo-rendimiento"/u);
    assert.match(
        html,
        /(?:no|nunca) desconecta[^<]*(?:líneas|sesiones)[^<]*(?:líneas|sesiones)/iu
    );
    assert.match(
        bootstrap,
        /establecerModoRendimiento\(data\.modoRendimiento\)/u
    );
    assert.match(
        bootstrap,
        /obtenerModoRendimiento\(\)[\s\S]+body:\s*JSON\.stringify\([\s\S]+modoRendimiento/u
    );
    assert.match(
        shell,
        /estadoRendimiento[\s\S]+estado-modo-rendimiento/u
    );
    assert.match(
        shell,
        /input\[name="config-modo-rendimiento"\]:checked/u
    );
});

test('agendamiento y visualizaciones conservan búsqueda y listas desplazables', () => {
    const html = fs.readFileSync(path.join(rutaPublica, 'index.html'), 'utf8');
    const agenda = fs.readFileSync(
        path.join(rutaPublica, 'js', 'agenda.js'),
        'utf8'
    );
    const bootstrap = fs.readFileSync(
        path.join(rutaPublica, 'js', 'bootstrap.js'),
        'utf8'
    );
    const lineas = fs.readFileSync(
        path.join(rutaPublica, 'js', 'lines.js'),
        'utf8'
    );
    const estilos = fs.readFileSync(
        path.join(rutaPublica, 'css', 'interface.css'),
        'utf8'
    );

    assert.match(html, /id="buscar-lineas-agendamiento"/u);
    assert.match(html, /id="agenda-line-options"/u);
    assert.match(html, /id="buscar-cuentas-agendamiento"/u);
    assert.match(html, /id="agenda-account-options"/u);
    assert.match(html, /id="resultado-cuentas-agendamiento"/u);
    assert.match(agenda, /normalizarBusquedaAgenda/u);
    assert.match(
        agenda,
        /agendaBusquedaCuentas[\s\S]+No se encontraron cuentas con esa búsqueda/u
    );
    assert.match(
        bootstrap,
        /buscar-lineas-agendamiento[\s\S]+addEventListener\('input'/u
    );
    assert.match(
        bootstrap,
        /buscar-cuentas-agendamiento[\s\S]+renderizarSelectorCuentasAgendamiento/u
    );
    assert.match(
        estilos,
        /\.agenda-picker-options[\s\S]+overflow-y:\s*auto/u
    );
    assert.match(
        estilos,
        /#agenda-line-menu,\s*#agenda-account-menu[\s\S]+overflow:\s*hidden/u
    );

    assert.match(html, /id="buscar-visualizaciones-lineas"/u);
    assert.match(html, /id="lista-visualizaciones-lineas"/u);
    assert.match(
        lineas,
        /buscar-visualizaciones-lineas[\s\S]+addEventListener\('input'/u
    );
    assert.match(estilos, /\.status-views-list[\s\S]+overflow:\s*auto/u);
});

test('el QR espera confirmación visual y Cancelar no altera la sesión', () => {
    const html = fs.readFileSync(path.join(rutaPublica, 'index.html'), 'utf8');
    const shell = fs.readFileSync(
        path.join(rutaPublica, 'js', 'shell.js'),
        'utf8'
    );
    const estilos = fs.readFileSync(
        path.join(rutaPublica, 'css', 'features.css'),
        'utf8'
    );

    assert.match(html, /id="qr-linea-resultado"/u);
    assert.match(html, /id="qr-linea-estado"[^>]+aria-live="polite"/u);
    assert.match(html, /id="btn-qr-confirmar"[^>]+disabled/u);
    assert.match(html, /id="btn-qr-cancelar"/u);

    const inicioConectada = shell.indexOf('if (conectada) {');
    const finConectada = shell.indexOf('if (confirmandoConexion)', inicioConectada);
    assert.ok(inicioConectada >= 0 && finConectada > inicioConectada);
    const ramaConectada = shell.slice(inicioConectada, finConectada);
    assert.match(ramaConectada, /actualizarEstadoVisualQr\(\s*'conectado'/u);
    assert.doesNotMatch(ramaConectada, /cerrarQrDeLinea/u);

    const inicioCancelar = shell.indexOf('function cancelarModalQr()');
    const finCancelar = shell.indexOf(
        'function puedeAbrirQrAutomaticamente()',
        inicioCancelar
    );
    assert.ok(inicioCancelar >= 0 && finCancelar > inicioCancelar);
    const cancelacion = shell.slice(inicioCancelar, finCancelar);
    assert.match(cancelacion, /cerrarQrDeLinea/u);
    assert.doesNotMatch(
        cancelacion,
        /fetch|DELETE|eliminarLineaRemota|reconectar|logout/u
    );

    assert.match(
        shell,
        /btn-qr-confirmar[\s\S]+qrFaseModal !== 'conectado'[\s\S]+cerrarQrDeLinea/u
    );
    assert.match(
        shell,
        /btn-qr-cancelar[\s\S]+cancelarModalQr/u
    );
    assert.match(estilos, /@keyframes qr-check-pop/u);
    assert.match(
        estilos,
        /@media \(prefers-reduced-motion: reduce\)[\s\S]+qr-scan-check/u
    );
});

test('EVA-05 tiene catálogo, selector, paleta y arranque temprano coherentes', () => {
    const html = fs.readFileSync(path.join(rutaPublica, 'index.html'), 'utf8');
    const inicializador = fs.readFileSync(
        path.join(rutaPublica, 'js', 'theme-init.js'),
        'utf8'
    );
    const shell = fs.readFileSync(
        path.join(rutaPublica, 'js', 'shell.js'),
        'utf8'
    );
    const estilos = fs.readFileSync(
        path.join(rutaPublica, 'css', 'themes.css'),
        'utf8'
    );

    assert.match(
        html,
        /data-theme-preview="eva-05"[\s\S]+value="eva-05"[\s\S]+EVA-05/u
    );
    assert.match(inicializador, /'eva-05'/u);
    assert.match(inicializador, /'eva-05':\s*'#080d09'/u);
    assert.match(shell, /'eva-05'/u);
    assert.match(
        estilos,
        /:root\[data-theme="eva-05"\]\s*\{[\s\S]+--accent:\s*#587a47;[\s\S]+--signal:\s*#e4ead5;[\s\S]+--detail:\s*#f06a32;[\s\S]+--info:\s*#98b88b;[\s\S]+?\}/u
    );
    assert.match(
        estilos,
        /\[data-theme-preview="eva-05"\]\s+\.theme-preview/u
    );

    const meta = {
        contenido: null,
        setAttribute(nombre, valor) {
            if (nombre === 'content') this.contenido = valor;
        }
    };
    const contexto = {
        window: {},
        document: {
            documentElement: { dataset: {} },
            querySelector: () => meta
        },
        localStorage: {
            getItem: () => 'eva-05',
            setItem: () => {}
        }
    };
    vm.runInNewContext(inicializador, contexto, {
        filename: 'theme-init.js'
    });
    assert.equal(contexto.document.documentElement.dataset.theme, 'eva-05');
    assert.equal(meta.contenido, '#080d09');
});

test('Ajustes gestiona únicamente los logs internos mediante el puente seguro', () => {
    const html = fs.readFileSync(path.join(rutaPublica, 'index.html'), 'utf8');
    const bootstrap = fs.readFileSync(
        path.join(rutaPublica, 'js', 'bootstrap.js'),
        'utf8'
    );
    const preload = fs.readFileSync(path.join(raiz, 'preload.js'), 'utf8');
    const principal = fs.readFileSync(path.join(raiz, 'main.js'), 'utf8');

    assert.match(html, /id="btn-abrir-carpeta-logs"/u);
    assert.match(html, /id="btn-crear-log"/u);
    assert.match(html, /id="btn-copiar-log"/u);
    assert.match(html, /id="btn-eliminar-log"/u);
    assert.match(html, /Registros de diagnóstico/u);
    assert.match(html, /Cada versión guarda sus propios logs/u);
    assert.match(
        bootstrap,
        /btn-abrir-carpeta-logs[\s\S]+window\.sistema\.abrirCarpetaLogs\(\)/u
    );
    assert.match(
        bootstrap,
        /btn-crear-log[\s\S]+window\.sistema\.crearLog\(\)/u
    );
    assert.match(
        bootstrap,
        /btn-copiar-log[\s\S]+window\.sistema\.copiarLog\(\)/u
    );
    assert.match(
        bootstrap,
        /btn-eliminar-log[\s\S]+solicitarConfirmacion\(\{[\s\S]+window\.sistema\.eliminarLog\(\)/u
    );
    const inicioEliminar = bootstrap.indexOf(
        "document.getElementById('btn-eliminar-log').onclick"
    );
    const finEliminar = bootstrap.indexOf(
        "document.getElementById('btn-alto-total').onclick",
        inicioEliminar
    );
    const manejadorEliminar = bootstrap.slice(inicioEliminar, finEliminar);
    assert.ok(
        manejadorEliminar.indexOf('const boton = evento.currentTarget') <
        manejadorEliminar.indexOf('await solicitarConfirmacion')
    );
    assert.match(
        preload,
        /abrirCarpetaLogs\(\)\s*\{\s*return ipcRenderer\.invoke\('sistema:abrir-carpeta-logs'\)/u
    );
    assert.match(
        preload,
        /crearLog\(\)\s*\{\s*return ipcRenderer\.invoke\('sistema:crear-log'\)/u
    );
    assert.match(
        preload,
        /copiarLog\(\)\s*\{\s*return ipcRenderer\.invoke\('sistema:copiar-log'\)/u
    );
    assert.match(
        preload,
        /eliminarLog\(\)\s*\{\s*return ipcRenderer\.invoke\('sistema:eliminar-log'\)/u
    );
    assert.doesNotMatch(preload, /shell|openPath|showItemInFolder|abrirRuta/u);
    assert.match(principal, /app\.setAppLogsPath\(carpetaLogs\)/u);
    assert.match(
        principal,
        /ipcMain\.handle\('sistema:abrir-carpeta-logs',\s*evento[\s\S]+eventoProvieneDeVentanaPrincipal/u
    );
    assert.match(
        principal,
        /abrirDirectorioLogsSeguro\(\{[\s\S]+directorio:\s*rutaCarpetaLogs[\s\S]+shell\.openPath/u
    );
    for (const canal of [
        'sistema:crear-log',
        'sistema:copiar-log',
        'sistema:eliminar-log'
    ]) {
        assert.match(
            principal,
            new RegExp(
                `ipcMain\\.handle\\('${canal}',\\s*evento[\\s\\S]+eventoProvieneDeVentanaPrincipal`,
                'u'
            )
        );
    }
});

test('Ajustes ofrece un restablecimiento completo protegido y sin rutas del renderer', () => {
    const html = fs.readFileSync(path.join(rutaPublica, 'index.html'), 'utf8');
    const bootstrap = fs.readFileSync(
        path.join(rutaPublica, 'js', 'bootstrap.js'),
        'utf8'
    );
    const preload = fs.readFileSync(path.join(raiz, 'preload.js'), 'utf8');
    const principal = fs.readFileSync(path.join(raiz, 'main.js'), 'utf8');

    assert.match(html, /id="btn-restablecer-datos"/u);
    assert.match(html, /id="modal-restablecer-datos"/u);
    assert.match(html, /id="restablecer-datos-confirmacion"/u);
    assert.match(html, /Escribí\s*<strong>RESTABLECER<\/strong>/u);
    assert.match(
        bootstrap,
        /btn-restablecer-datos[\s\S]+window\.sistema\.restablecerDatos\(confirmacion\)/u
    );
    assert.match(
        preload,
        /restablecerDatos\(confirmacion\)\s*\{\s*return ipcRenderer\.invoke\('sistema:restablecer-datos', confirmacion\)/u
    );
    assert.match(
        principal,
        /ipcMain\.handle\('sistema:restablecer-datos', \(evento, confirmacion\)[\s\S]+eventoProvieneDeVentanaPrincipal/u
    );
    assert.match(principal, /RESTABLECER/u);
    assert.match(principal, /ARGUMENTO_RESTABLECER_DATOS/u);
    assert.match(principal, /app\.relaunch\(\{/u);
    assert.match(principal, /app\.setPath\(\s*'sessionData'/u);
    assert.match(principal, /ejecutarRestablecimientoLocal\(/u);
});

test('Windows recibe la identidad y el icono nativo de ZeroOne', () => {
    const principal = fs.readFileSync(path.join(raiz, 'main.js'), 'utf8');

    assert.equal(fs.existsSync(path.join(raiz, 'build', 'icon.ico')), true);
    assert.match(
        principal,
        /RUTA_ICONO_ICO\s*=\s*path\.join\(__dirname,\s*'build',\s*'icon\.ico'\)/u
    );
    assert.match(
        principal,
        /RUTA_ICONO_WINDOWS\s*=\s*app\.isPackaged[\s\S]+process\.execPath[\s\S]+fs\.existsSync\(RUTA_ICONO_ICO\)[\s\S]+RUTA_ICONO/u
    );
    assert.match(
        principal,
        /ID_APLICACION_WINDOWS\s*=\s*app\.isPackaged[\s\S]+ID_APLICACION_WINDOWS_INSTALADA[\s\S]+\.development/u
    );
    assert.match(
        principal,
        /app\.setName\(NOMBRE_APLICACION\);[\s\S]+app\.setAppUserModelId\(ID_APLICACION_WINDOWS\)/u
    );
    assert.match(
        principal,
        /ventanaPrincipal\.setIcon\(RUTA_ICONO_VENTANA\)/u
    );
    assert.match(
        principal,
        /ventanaPrincipal\.setAppDetails\(\{[\s\S]+appIconPath:\s*RUTA_ICONO_WINDOWS[\s\S]+relaunchDisplayName:\s*NOMBRE_APLICACION/u
    );
});

test('las tarjetas separan conexión disponible de audiencia validada', () => {
    const lineas = fs.readFileSync(
        path.join(rutaPublica, 'js', 'lines.js'),
        'utf8'
    );

    assert.match(
        lineas,
        /listaParaPublicarAhora\s*=\s*listaParaPublicar\s*&&\s*audienciaLista/u
    );
    assert.match(lineas, /texto:\s*'Preparando audiencia'/u);
    assert.match(lineas, /texto:\s*'Audiencia pendiente'/u);
    assert.match(lineas, /texto:\s*'Audiencia no disponible'/u);
    assert.match(
        lineas,
        /contactosAudienciaConocidos[\s\S]+validando privacidad[\s\S]+privacidad sin validar/u
    );
    assert.match(
        lineas,
        /contactosAudienciaConocidos[\s\S]+linea\.contactosEstado[\s\S]+linea\.contactosEstadoWhatsApp[\s\S]+linea\.contactosEstadoGoogle/u
    );
    assert.match(
        lineas,
        /cacheLineasSeccion\.filter\([\s\S]+lineaListaParaPublicar\(linea\)\s*&&[\s\S]+audienciaEstadosLista/u
    );

    const publicacion = fs.readFileSync(
        path.join(rutaPublica, 'js', 'publication.js'),
        'utf8'
    );
    assert.match(
        publicacion,
        /Preparando audiencia; podés seleccionarla/u
    );
    assert.match(
        publicacion,
        /seleccionable\(s\)[\s\S]+con audiencia lista/u
    );
    assert.match(
        publicacion,
        /visiblesPreparando[\s\S]+preparando audiencia/u
    );
});

test('la reparación de privacidad solo se ofrece con confirmación explícita', () => {
    const lineas = fs.readFileSync(
        path.join(rutaPublica, 'js', 'lines.js'),
        'utf8'
    );
    const backend = fs.readFileSync(
        path.join(raiz, 'src', 'bot.js'),
        'utf8'
    );

    assert.match(
        lineas,
        /linea\.reparacionPrivacidadDisponible\s*===\s*true[\s\S]+btn-reaplicar-privacidad/u
    );
    assert.match(
        lineas,
        /Se eliminará cualquier exclusión configurada en WhatsApp/u
    );
    assert.match(
        lineas,
        /reaplicar-privacidad-contactos[\s\S]+REAPLICAR_MIS_CONTACTOS/u
    );
    assert.match(
        backend,
        /sock\.ev\.on\('settings\.update'[\s\S]+linea\.reparandoPrivacidadAudiencia\s*!==\s*true[\s\S]+linea\.verificacionPrivacidadForzadaPendiente\s*!==\s*true/u
    );
    assert.match(
        backend,
        /function audienciaEstadosLista[\s\S]+verificacionPrivacidadForzadaPendiente\s*!==\s*true/u
    );
});

test('el editor de programaciones permite elegir, buscar y ordenar sus líneas', () => {
    const html = fs.readFileSync(
        path.join(rutaPublica, 'index.html'),
        'utf8'
    );
    const shell = fs.readFileSync(
        path.join(rutaPublica, 'js', 'shell.js'),
        'utf8'
    );
    const publicacion = fs.readFileSync(
        path.join(rutaPublica, 'js', 'publication.js'),
        'utf8'
    );
    const bootstrap = fs.readFileSync(
        path.join(rutaPublica, 'js', 'bootstrap.js'),
        'utf8'
    );
    const diseno = fs.readFileSync(
        path.join(rutaPublica, 'css', 'design-system.css'),
        'utf8'
    );

    for (const id of [
        'editar-buscar-lineas',
        'editar-btn-orden-lineas',
        'editar-btn-direccion-lineas',
        'editar-seleccionar-todas-lineas',
        'editar-lista-lineas',
        'editar-cantidad-lineas',
        'editar-intervalo-segundos',
        'editar-variacion-segundos',
        'editar-lineas-por-grupo',
        'editar-intervalo-minutos'
    ]) {
        assert.match(html, new RegExp(`id="${id}"`, 'u'));
    }

    assert.match(
        html,
        /program-edit-layout[\s\S]+program-edit-visual[\s\S]+program-edit-controls/u
    );
    assert.match(
        shell,
        /lineasSeleccionadasEdicionProgramacion\s*=\s*new Set\(\)/u
    );
    assert.match(
        publicacion,
        /function renderizarLineasEditorProgramacion\(\)[\s\S]+compararLineasEditorProgramacion/u
    );
    assert.match(
        publicacion,
        /programacion\?\.lineasProgramadas[\s\S]+faltante:\s*true/u
    );
    assert.match(
        publicacion,
        /lineasSeleccionadasEdicionProgramacion\.has\(id\)/u
    );
    assert.match(
        bootstrap,
        /editar-buscar-lineas[\s\S]+debounce\(renderizarLineasEditorProgramacion,\s*120\)/u
    );
    assert.match(
        bootstrap,
        /formData\.append\(\s*'lineas',[\s\S]+lineasSeleccionadasEdicionProgramacion/u
    );
    assert.match(
        bootstrap,
        /formData\.append\('modoRitmo',\s*modoRitmo\)/u
    );
    assert.match(
        bootstrap,
        /program-edit-line:not\(\.missing\)[\s\S]+editar-seleccionar-linea:not\(:disabled\)/u
    );
    assert.match(
        diseno,
        /#modal-editar \.program-edit-layout\s*\{[\s\S]+grid-template-columns/u
    );
    assert.match(
        diseno,
        /#modal-editar \.program-edit-lines-list\s*\{[\s\S]+repeat\(2,\s*minmax\(0,\s*1fr\)\)/u
    );
    assert.match(
        diseno,
        /@media \(max-width:\s*820px\)[\s\S]+#modal-editar \.program-edit-layout/u
    );
});
