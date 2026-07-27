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

    assert.match(html, /id="confirmacion-envio-progreso"/u);
    assert.match(html, /id="btn-confirmar-envio-publicado"/u);
    assert.match(html, /id="btn-omitir-envio-no-publicado"/u);
    assert.match(html, /id="btn-simulacro-envio"[\s\S]+Modo de prueba/u);
    assert.match(publicacion, /confirmacionEnvioPendiente\?\.solicitudId/u);
    assert.match(publicacion, /Esperando tu confirmación/u);
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
    assert.match(agenda, /normalizarBusquedaAgenda/u);
    assert.match(
        bootstrap,
        /buscar-lineas-agendamiento[\s\S]+addEventListener\('input'/u
    );
    assert.match(
        estilos,
        /\.agenda-picker-options[\s\S]+overflow-y:\s*auto/u
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

test('Ajustes abre únicamente la carpeta fija de logs mediante el puente seguro', () => {
    const html = fs.readFileSync(path.join(rutaPublica, 'index.html'), 'utf8');
    const bootstrap = fs.readFileSync(
        path.join(rutaPublica, 'js', 'bootstrap.js'),
        'utf8'
    );
    const preload = fs.readFileSync(path.join(raiz, 'preload.js'), 'utf8');
    const principal = fs.readFileSync(path.join(raiz, 'main.js'), 'utf8');

    assert.match(html, /id="btn-abrir-carpeta-logs"/u);
    assert.match(html, /Registros de diagnóstico/u);
    assert.match(
        bootstrap,
        /btn-abrir-carpeta-logs[\s\S]+window\.sistema\.abrirCarpetaLogs\(\)/u
    );
    assert.match(
        preload,
        /abrirCarpetaLogs\(\)\s*\{\s*return ipcRenderer\.invoke\('sistema:abrir-carpeta-logs'\)/u
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
