        const lineasSeleccionadas = new Set();
        const lineasSeleccionadasEliminar = new Set();
        const programacionesCache = new Map();

        let idsLineasConectadas = [];
        let intervaloProgreso = null;
        let vistaProgramaciones = 'grid';
        let urlPreviewActual = null;
        let urlPreviewEdicion = null;
        let selectorEtiquetaAbiertoId = null;
        let configuracionActual = null;
        let seccionActual = 'dashboard';
        let cacheLineasSeccion = [];
        let cacheLineasAgendamiento = [];
        let cacheLineasPendientes = [];
        let vistaLineas = 'large';
        let vistaLineasPendientes = 'large';
        let vistaEstadosActivos = 'medium';
        let cacheEstadosActivos = { resumen: {}, publicaciones: [] };
        let publicacionVisualizacionesId = null;
        let ordenVisualizacionesEstado = 'alfabetico';
        let direccionVisualizacionesEstado = 'asc';
        let ordenLineas = 'conexion';
        let direccionLineas = 'asc';
        let ordenLineasSubida = 'conexion';
        let direccionLineasSubida = 'asc';
        let lineaEditandoId = null;
        let cargandoEstadosActivos = false;
        let proteccionMiddlewareActual = null;
        let publicacionActivaActual = false;
        let eliminandoLineasSeleccionadas = false;
        let altoTotalSolicitado = false;
        let secuenciaActualizacionLineas = 0;
        let resolverConfirmacion = null;
        let focoPrevioConfirmacion = null;
        let lineaQrObjetivoId = null;
        let lineaQrModalId = null;
        let qrModalActual = null;
        let qrCuentaId = null;
        let qrCuentaAsignando = false;
        let qrCuentasCargando = false;
        let qrBusquedaCuenta = '';
        let qrSolicitudCuentas = 0;
        let agendaLineaId = null;
        let agendaCuentaId = null;
        let agendaEstado = null;
        let agendaActualizando = false;
        let agendaActualizacionPendiente = false;
        let agendaOAuthEnCurso = false;
        let agendaTemporizador = null;
        let agendaSecuencia = 0;
        let agendaFirmaLineas = '';
        let agendaFirmaCuentas = '';
        let agendaOperacionIA = false;
        let cuentasGoogleDisponibles = [];
        let cuentasGoogleCargando = false;
        const agendaRevisionesIAEnCurso = new Set();

        const solicitudesIdempotentesEnCurso = new Set();
        const qrDescartadosPorLinea = new Map();
        const CLAVE_SIDEBAR_COMPACTA = 'zeroone.sidebar.compacta';
        const TEMAS_VISUALES = new Set(
            window.ZeroOneTheme?.themes || [
                'eva-01',
                'eva-00',
                'eva-02',
                'eva-13',
                'rei'
            ]
        );

        function normalizarTemaVisual(tema, respaldo = 'eva-01') {
            const valor = String(tema || '').trim().toLowerCase();
            return TEMAS_VISUALES.has(valor) ? valor : respaldo;
        }

        function aplicarTemaVisual(tema, guardarCache = false) {
            const normalizado = normalizarTemaVisual(tema);
            const aplicado = window.ZeroOneTheme?.apply
                ? window.ZeroOneTheme.apply(normalizado, guardarCache)
                : normalizado;

            if (!window.ZeroOneTheme?.apply) {
                document.documentElement.dataset.theme = aplicado;
            }

            document
                .querySelectorAll('input[name="config-tema-visual"]')
                .forEach(radio => {
                    radio.checked = radio.value === aplicado;
                });

            return aplicado;
        }

        function configurarSelectorTemasVisuales() {
            const temaInicial = window.ZeroOneTheme?.current?.() ||
                document.documentElement.dataset.theme ||
                'eva-01';
            aplicarTemaVisual(temaInicial, false);

            document
                .querySelectorAll('input[name="config-tema-visual"]')
                .forEach(radio => {
                    radio.addEventListener('change', () => {
                        if (radio.checked) aplicarTemaVisual(radio.value, false);
                    });
                });
        }

        function aplicarSidebarCompacta(compacta, guardar = true) {
            const appShell = document.querySelector('.app-shell');
            const boton = document.getElementById('btn-toggle-sidebar');
            const estaCompacta = compacta === true;

            if (!appShell || !boton) return;

            appShell.classList.toggle('sidebar-collapsed', estaCompacta);
            boton.setAttribute('aria-expanded', String(!estaCompacta));

            const etiqueta = estaCompacta
                ? 'Expandir barra lateral'
                : 'Contraer barra lateral';

            boton.title = etiqueta;
            boton.setAttribute('aria-label', etiqueta);

            if (!guardar) return;

            try {
                localStorage.setItem(
                    CLAVE_SIDEBAR_COMPACTA,
                    estaCompacta ? '1' : '0'
                );
            } catch {
                // La preferencia es opcional; el control sigue funcionando.
            }
        }

        function configurarSidebarCompacta() {
            const boton = document.getElementById('btn-toggle-sidebar');
            if (!boton) return;

            let compacta = false;

            try {
                compacta = localStorage.getItem(CLAVE_SIDEBAR_COMPACTA) === '1';
            } catch {
                compacta = false;
            }

            aplicarSidebarCompacta(compacta, false);

            boton.addEventListener('click', () => {
                const appShell = document.querySelector('.app-shell');
                aplicarSidebarCompacta(
                    !appShell?.classList.contains('sidebar-collapsed')
                );
            });
        }

        configurarSidebarCompacta();
        configurarSelectorTemasVisuales();

        const titulos = {
            dashboard: 'Panel general',
            estados: 'Actividad de Estados',
            activos: 'Estados activos',
            lineas: 'Líneas conectadas',
            agendamiento: 'Agendamiento',
            historial: 'Historial de publicaciones',
            configuracion: 'Configuración'
        };

        const MODOS_RITMO_VALIDOS = new Set(['secuencial', 'grupos']);

        function normalizarModoRitmo(valor, respaldo = 'secuencial') {
            return MODOS_RITMO_VALIDOS.has(valor) ? valor : respaldo;
        }

        function establecerModoRitmo(nombre, valor) {
            const modo = normalizarModoRitmo(valor);
            const radios = document.querySelectorAll(`input[name="${nombre}"]`);

            radios.forEach(radio => {
                radio.checked = radio.value === modo;
            });

            const prefijo = nombre === 'config-modo-ritmo' ? 'config' : 'crear';
            const panelSecuencial = document.getElementById(`${prefijo}-ritmo-secuencial`);
            const panelGrupos = document.getElementById(`${prefijo}-ritmo-grupos`);

            if (panelSecuencial) panelSecuencial.hidden = modo !== 'secuencial';
            if (panelGrupos) panelGrupos.hidden = modo !== 'grupos';

            return modo;
        }

        function obtenerModoRitmo(nombre) {
            const seleccionado = document.querySelector(`input[name="${nombre}"]:checked`);
            return normalizarModoRitmo(seleccionado?.value);
        }

        function numeroConfigurado(valor, minimo, maximo, respaldo) {
            const numero = Number(valor);
            return Number.isFinite(numero) && numero >= minimo && numero <= maximo
                ? numero
                : respaldo;
        }

        function debounce(tarea, esperaMs = 160) {
            let temporizador = null;
            return (...argumentos) => {
                if (temporizador !== null) window.clearTimeout(temporizador);
                temporizador = window.setTimeout(() => {
                    temporizador = null;
                    tarea(...argumentos);
                }, esperaMs);
            };
        }

        function textoLimiteFallos(valor) {
            const cantidad = Math.max(1, Math.min(10, Math.round(Number(valor) || 1)));
            return `${cantidad} ${cantidad === 1 ? 'línea' : 'líneas'}`;
        }

        function describirRitmoPublicacion(item) {
            const modo = normalizarModoRitmo(item?.modoRitmo, 'grupos');

            if (modo === 'secuencial') {
                const segundos = Math.round(numeroConfigurado(
                    item?.intervaloSegundos,
                    10,
                    3600,
                    45
                ));
                const variacion = Math.round(numeroConfigurado(
                    item?.variacionSegundos,
                    0,
                    30,
                    5
                ));

                return {
                    modo,
                    principal: `Una línea cada ${segundos} s`,
                    detalle: variacion > 0 ? `Variación adicional: 0–${variacion} s` : ''
                };
            }

            const lineasGuardadas = Number(item?.lineasPorGrupo);
            const lineas = Number.isFinite(lineasGuardadas) && lineasGuardadas >= 1
                ? Math.round(lineasGuardadas)
                : 10;
            const minutos = numeroConfigurado(item?.intervaloMinutos, 0, 1440, 5);

            return {
                modo,
                principal: `Grupos de ${lineas}`,
                detalle: `${minutos} min entre grupos`
            };
        }

        function escaparHTML(texto) {
            return String(texto ?? '').replace(/[&<>"']/g, caracter => {
                const caracteres = {
                    '&': '&amp;',
                    '<': '&lt;',
                    '>': '&gt;',
                    '"': '&quot;',
                    "'": '&#039;'
                };

                return caracteres[caracter];
            });
        }

        function iconoSVG(nombre, clase = '') {
            return `<svg class="icon ${clase}" aria-hidden="true"><use href="#i-${nombre}"></use></svg>`;
        }

        function formatearFecha(valor, reemplazo = 'No disponible') {
            if (!valor) return reemplazo;
            const fecha = new Date(valor);
            return Number.isNaN(fecha.getTime()) ? reemplazo : fecha.toLocaleString();
        }

        const selectoresTodosDias = {
            'dias-programados': 'todos-dias-programados',
            'editar-dias-programados': 'editar-todos-dias'
        };

        function obtenerDiasSeleccionados(contenedorId) {
            return Array.from(
                document.querySelectorAll(`#${contenedorId} input:checked`)
            ).map(input => Number(input.value));
        }

        function actualizarSelectorTodosDias(contenedorId) {
            const selectorId = selectoresTodosDias[contenedorId];
            const selector = selectorId ? document.getElementById(selectorId) : null;
            const dias = Array.from(
                document.querySelectorAll(`#${contenedorId} input[type="checkbox"]`)
            );

            if (!selector || !dias.length) return;

            const seleccionados = dias.filter(input => input.checked).length;
            selector.checked = seleccionados === dias.length;
            selector.indeterminate = seleccionados > 0 && seleccionados < dias.length;
        }

        function configurarSelectorTodosDias(contenedorId) {
            const selectorId = selectoresTodosDias[contenedorId];
            const selector = selectorId ? document.getElementById(selectorId) : null;
            const dias = Array.from(
                document.querySelectorAll(`#${contenedorId} input[type="checkbox"]`)
            );

            if (!selector || !dias.length) return;

            selector.addEventListener('change', () => {
                dias.forEach(input => {
                    input.checked = selector.checked;
                });
                selector.indeterminate = false;
            });

            dias.forEach(input => {
                input.addEventListener('change', () => {
                    actualizarSelectorTodosDias(contenedorId);
                });
            });

            actualizarSelectorTodosDias(contenedorId);
        }

        function marcarDiasSeleccionados(contenedorId, dias) {
            const seleccionados = new Set((dias || []).map(Number));
            document.querySelectorAll(`#${contenedorId} input`).forEach(input => {
                input.checked = seleccionados.has(Number(input.value));
            });
            actualizarSelectorTodosDias(contenedorId);
        }

        function describirDias(dias) {
            const valores = [...new Set((dias || []).map(Number))].sort((a,b) => a-b);
            if (valores.length === 7) return 'Todos los días';
            const nombres = { 0:'Dom',1:'Lun',2:'Mar',3:'Mié',4:'Jue',5:'Vie',6:'Sáb' };
            return valores.map(dia => nombres[dia]).filter(Boolean).join(', ') || 'Sin días';
        }

        function toast(mensaje, tipo = '') {
            const contenedor = document.getElementById('toast-container');
            const elemento = document.createElement('div');

            elemento.className = `toast ${tipo}`.trim();
            elemento.setAttribute('role', tipo === 'error' ? 'alert' : 'status');
            elemento.setAttribute('aria-live', tipo === 'error' ? 'assertive' : 'polite');
            const icono = tipo === 'success'
                ? 'check-circle'
                : tipo === 'error'
                    ? 'x-circle'
                    : tipo === 'warning'
                        ? 'alert'
                        : 'info';
            elemento.innerHTML = `
                ${iconoSVG(icono)}
                <span>${escaparHTML(mensaje)}</span>
                <button type="button" class="toast-close" aria-label="Cerrar aviso">
                    ${iconoSVG('x')}
                </button>
            `;
            contenedor.appendChild(elemento);

            let retirando = false;
            const retirar = () => {
                if (retirando || !elemento.isConnected) return;
                retirando = true;
                elemento.classList.add('leaving');
                elemento.addEventListener('animationend', () => elemento.remove(), {
                    once: true
                });
                setTimeout(() => elemento.remove(), 260);
            };

            elemento.querySelector('.toast-close').onclick = retirar;
            setTimeout(retirar, 4200);
        }

        function abrirModal(id) {
            const modal = document.getElementById(id);
            if (!modal) return;
            if (!modal.classList.contains('open')) {
                modal.__focoPrevio = document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : null;
            }
            modal.classList.add('open');
            modal.setAttribute('aria-hidden', 'false');
        }

        function cerrarModal(id) {
            const modal = document.getElementById(id);
            if (!modal) return;
            const focoPrevio = modal.__focoPrevio;
            if (modal.contains(document.activeElement)) {
                document.activeElement.blur();
            }
            modal.classList.remove('open');
            modal.setAttribute('aria-hidden', 'true');
            modal.__focoPrevio = null;

            if (id !== 'modal-confirmacion') {
                requestAnimationFrame(() => {
                    if (focoPrevio?.isConnected && !focoPrevio.matches(':disabled')) {
                        focoPrevio.focus({ preventScroll: true });
                    }
                });
            }
        }

        function solicitarConfirmacion({
            titulo = 'Confirmar acción',
            mensaje = '',
            textoConfirmar = 'Confirmar',
            tono = 'danger',
            icono = 'alert'
        } = {}) {
            if (resolverConfirmacion) return Promise.resolve(false);

            const modal = document.getElementById('modal-confirmacion');
            const tarjeta = modal.querySelector('.confirmation-card');
            const botonConfirmar = document.getElementById('confirmacion-aceptar');

            focoPrevioConfirmacion = document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
            tarjeta.dataset.tone = tono === 'primary' ? 'primary' : 'danger';
            document.getElementById('confirmacion-titulo').textContent = titulo;
            document.getElementById('confirmacion-mensaje').textContent = mensaje;
            document.getElementById('confirmacion-aceptar-texto').textContent = textoConfirmar;
            document.getElementById('confirmacion-icono').setAttribute('href', `#i-${icono}`);
            document.getElementById('confirmacion-aceptar-icono').setAttribute(
                'href',
                tono === 'primary' ? '#i-check' : `#i-${icono}`
            );
            botonConfirmar.classList.toggle('danger', tono !== 'primary');
            botonConfirmar.classList.add('primary-button');

            abrirModal('modal-confirmacion');
            requestAnimationFrame(() => {
                document.getElementById('confirmacion-cancelar').focus({
                    preventScroll: true
                });
            });

            return new Promise(resolve => {
                resolverConfirmacion = resolve;
            });
        }

        function resolverModalConfirmacion(resultado) {
            if (!resolverConfirmacion) return;

            const resolver = resolverConfirmacion;
            const foco = focoPrevioConfirmacion;
            resolverConfirmacion = null;
            focoPrevioConfirmacion = null;
            cerrarModal('modal-confirmacion');
            resolver(resultado);

            requestAnimationFrame(() => {
                if (!resultado && foco?.isConnected && !foco.matches(':disabled')) {
                    foco.focus({ preventScroll: true });
                }
            });
        }

        document.getElementById('confirmacion-cancelar').onclick = () => {
            resolverModalConfirmacion(false);
        };

        document.getElementById('confirmacion-aceptar').onclick = () => {
            resolverModalConfirmacion(true);
        };

        document.getElementById('modal-confirmacion').addEventListener('click', evento => {
            if (evento.target.id === 'modal-confirmacion') {
                resolverModalConfirmacion(false);
            }
        });

        document.addEventListener('keydown', evento => {
            const modal = document.getElementById('modal-confirmacion');
            if (!modal.classList.contains('open')) return;

            if (evento.key === 'Escape') {
                evento.preventDefault();
                resolverModalConfirmacion(false);
                return;
            }

            if (evento.key !== 'Tab') return;
            const controles = [
                document.getElementById('confirmacion-cancelar'),
                document.getElementById('confirmacion-aceptar')
            ];
            const indiceActual = controles.indexOf(document.activeElement);
            const siguiente = evento.shiftKey
                ? (indiceActual <= 0 ? controles.length - 1 : indiceActual - 1)
                : (indiceActual >= controles.length - 1 ? 0 : indiceActual + 1);

            evento.preventDefault();
            controles[siguiente].focus({ preventScroll: true });
        });

        function prepararAperturaQr(id) {
            const idNormalizado = String(id || '').trim();
            if (!idNormalizado) return;
            lineaQrObjetivoId = idNormalizado;
            qrDescartadosPorLinea.delete(idNormalizado);
        }

        function puedeAbrirQrAutomaticamente() {
            const hayOtroModal = Array.from(
                document.querySelectorAll('.modal.open')
            ).some(modal => modal.id !== 'modal-qr-linea');

            return seccionActual === 'lineas' && !hayOtroModal;
        }

        function normalizarBusquedaCuentaQr(valor = '') {
            return String(valor || '')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLocaleLowerCase('es')
                .trim();
        }

        function cuentasGoogleOrdenadasParaQr() {
            return opcionesCuentasGoogle()
                .filter(cuenta => idCuentaAgenda(cuenta))
                .slice()
                .sort((a, b) => nombreCuentaAgenda(a).localeCompare(
                    nombreCuentaAgenda(b),
                    'es',
                    { sensitivity: 'base', numeric: true }
                ));
        }

        function renderizarCuentasGoogleQr() {
            const lista = document.getElementById('qr-account-list');
            const actual = document.getElementById('qr-account-current');
            const mensaje = document.getElementById('qr-account-message');
            const botonGestionar = document.getElementById('btn-qr-manage-google');
            if (!lista || !actual || !mensaje || !botonGestionar) return;

            const cuentas = cuentasGoogleOrdenadasParaQr();
            const consulta = normalizarBusquedaCuentaQr(qrBusquedaCuenta);
            const visibles = consulta
                ? cuentas.filter(cuenta => normalizarBusquedaCuentaQr(
                    `${nombreCuentaAgenda(cuenta)} ${idCuentaAgenda(cuenta)}`
                ).includes(consulta))
                : cuentas;
            const seleccionada = cuentas.find(
                cuenta => idCuentaAgenda(cuenta) === String(qrCuentaId || '')
            );

            actual.classList.toggle('selected', Boolean(seleccionada));
            actual.innerHTML = seleccionada
                ? `${iconoSVG('check-circle')}<span><small>Cuenta seleccionada</small><strong>${escaparHTML(nombreCuentaAgenda(seleccionada))}</strong></span>`
                : `${iconoSVG('info')}<span><small>Cuenta seleccionada</small><strong>Sin cuenta de Google</strong></span>`;

            if (qrCuentasCargando) {
                lista.innerHTML = `
                    <div class="qr-account-empty loading">
                        ${iconoSVG('loader', 'spin')}
                        <span>Cargando cuentas...</span>
                    </div>
                `;
            } else if (!cuentas.length) {
                lista.innerHTML = `
                    <div class="qr-account-empty">
                        ${iconoSVG('users')}
                        <strong>No hay cuentas conectadas</strong>
                        <span>Agregá una desde Agendamiento.</span>
                    </div>
                `;
            } else if (!visibles.length) {
                lista.innerHTML = `
                    <div class="qr-account-empty compact">
                        ${iconoSVG('search')}
                        <span>No encontramos esa cuenta.</span>
                    </div>
                `;
            } else {
                lista.innerHTML = visibles.map(cuenta => {
                    const id = idCuentaAgenda(cuenta);
                    const nombre = nombreCuentaAgenda(cuenta);
                    const activa = id === String(qrCuentaId || '');
                    const inicial = nombre.charAt(0).toLocaleUpperCase('es') || 'G';
                    return `
                        <button
                            type="button"
                            class="qr-account-option ${activa ? 'active' : ''}"
                            data-qr-account-id="${escaparHTML(id)}"
                            role="option"
                            aria-selected="${String(activa)}"
                            ${qrCuentaAsignando ? 'disabled' : ''}
                        >
                            <span class="qr-account-avatar">${escaparHTML(inicial)}</span>
                            <span class="qr-account-option-copy">
                                <strong>${escaparHTML(nombre)}</strong>
                                <small>${activa ? 'Asignada a esta línea' : 'Usar para esta línea'}</small>
                            </span>
                            ${iconoSVG(activa ? 'check-circle' : 'chevron-down')}
                        </button>
                    `;
                }).join('');
            }

            botonGestionar.querySelector('span').textContent = cuentas.length
                ? 'Agregar otra cuenta'
                : 'Agregar cuenta de Google';
        }

        async function cargarCuentasGoogleQr(lineaId, { forzar = false } = {}) {
            const id = String(lineaId || '').trim();
            if (!id || (qrCuentasCargando && !forzar)) return;

            const solicitud = ++qrSolicitudCuentas;
            qrCuentasCargando = true;
            const mensaje = document.getElementById('qr-account-message');
            if (mensaje) mensaje.textContent = '';
            renderizarCuentasGoogleQr();

            try {
                const respuesta = await fetch(
                    `/agendamiento?${new URLSearchParams({ lineaId: id })}`
                );
                const data = await exigirRespuesta(
                    respuesta,
                    'No se pudieron cargar las cuentas de Google.'
                );
                if (solicitud !== qrSolicitudCuentas || lineaQrModalId !== id) return;

                cuentasGoogleDisponibles = Array.isArray(data.cuentas)
                    ? data.cuentas
                    : [];
                qrCuentaId = data.cuentaId ? String(data.cuentaId) : null;
            } catch (error) {
                if (solicitud !== qrSolicitudCuentas || lineaQrModalId !== id) return;
                cuentasGoogleDisponibles = [];
                qrCuentaId = null;
                if (mensaje) mensaje.textContent = error.message;
            } finally {
                if (solicitud === qrSolicitudCuentas && lineaQrModalId === id) {
                    qrCuentasCargando = false;
                    renderizarCuentasGoogleQr();
                }
            }
        }

        async function seleccionarCuentaGoogleQr(cuentaId) {
            const lineaId = String(lineaQrModalId || '').trim();
            const id = String(cuentaId || '').trim();
            if (!lineaId || !id || qrCuentaAsignando || id === String(qrCuentaId || '')) return;

            qrCuentaAsignando = true;
            const mensaje = document.getElementById('qr-account-message');
            if (mensaje) mensaje.textContent = 'Asignando cuenta...';
            renderizarCuentasGoogleQr();

            try {
                const respuesta = await fetch(
                    `/agendamiento/lineas/${encodeURIComponent(lineaId)}/cuenta`,
                    {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ cuentaId: id })
                    }
                );
                const data = await exigirRespuesta(
                    respuesta,
                    'No se pudo asignar la cuenta de Google.'
                );
                if (lineaQrModalId !== lineaId) return;
                qrCuentaId = String(data.cuentaId || id);
                if (mensaje) mensaje.textContent = 'Cuenta asignada correctamente.';
                toast('Cuenta de Google asignada a la línea.', 'success');
            } catch (error) {
                if (lineaQrModalId === lineaId && mensaje) {
                    mensaje.textContent = error.message;
                }
            } finally {
                qrCuentaAsignando = false;
                if (lineaQrModalId === lineaId) renderizarCuentasGoogleQr();
            }
        }

        function abrirQrDeLinea(linea, { forzar = false } = {}) {
            if (
                !linea ||
                linea.estado !== 'esperando_qr' ||
                !String(linea.qr || '').trim()
            ) return false;

            const id = String(linea.id);
            const qr = String(linea.qr);
            if (forzar) qrDescartadosPorLinea.delete(id);
            if (!forzar && qrDescartadosPorLinea.get(id) === qr) return false;

            const modal = document.getElementById('modal-qr-linea');
            const tarjeta = modal.querySelector('.qr-line-modal-card');
            const imagen = document.getElementById('qr-linea-imagen');
            const cambioLinea = lineaQrModalId !== id;

            lineaQrModalId = id;
            lineaQrObjetivoId = id;
            if (qrModalActual !== qr) {
                qrModalActual = qr;
                imagen.src = qr;
            }
            imagen.alt = `Código QR para vincular ${linea.nombre || 'la línea'}`;
            document.getElementById('qr-linea-nombre').textContent =
                linea.nombre || 'Vincular línea';

            if (cambioLinea) {
                qrCuentaId = null;
                qrBusquedaCuenta = '';
                const buscador = document.getElementById('qr-account-search');
                if (buscador) buscador.value = '';
                renderizarCuentasGoogleQr();
                void cargarCuentasGoogleQr(id, { forzar: true });
            }

            if (!modal.classList.contains('open')) {
                abrirModal('modal-qr-linea');
                requestAnimationFrame(() => tarjeta.focus({ preventScroll: true }));
            }

            return true;
        }

        function cerrarQrDeLinea({ manual = false, conservarObjetivo = false } = {}) {
            const idCerrado = lineaQrModalId;
            const qrCerrado = qrModalActual;
            const imagen = document.getElementById('qr-linea-imagen');

            if (manual && idCerrado && qrCerrado) {
                qrDescartadosPorLinea.set(idCerrado, qrCerrado);
            }

            lineaQrModalId = null;
            qrModalActual = null;
            qrCuentaId = null;
            qrCuentaAsignando = false;
            qrCuentasCargando = false;
            qrBusquedaCuenta = '';
            qrSolicitudCuentas += 1;
            if (!conservarObjetivo) lineaQrObjetivoId = null;

            if (document.getElementById('modal-qr-linea').classList.contains('open')) {
                cerrarModal('modal-qr-linea');
            }

            setTimeout(() => {
                if (!lineaQrModalId) imagen.removeAttribute('src');
            }, 230);
        }

        function sincronizarModalQr(lineas = []) {
            const porId = new Map(
                (Array.isArray(lineas) ? lineas : []).map(linea => [
                    String(linea.id),
                    linea
                ])
            );

            if (lineaQrModalId) {
                const lineaVisible = porId.get(lineaQrModalId);

                if (
                    lineaVisible?.estado === 'esperando_qr' &&
                    String(lineaVisible.qr || '').trim()
                ) {
                    abrirQrDeLinea(lineaVisible, { forzar: true });
                    return;
                }

                const idAnterior = lineaQrModalId;
                const nombreAnterior = lineaVisible?.nombre ||
                    cacheLineasPendientes.find(linea => String(linea.id) === idAnterior)?.nombre ||
                    'La línea';
                const conectada = lineaVisible?.estado === 'conectado';
                const esperandoNuevoQr = ['iniciando', 'reconectando'].includes(
                    String(lineaVisible?.estado || '')
                );

                cerrarQrDeLinea({
                    manual: false,
                    conservarObjetivo: esperandoNuevoQr
                });

                if (conectada) {
                    qrDescartadosPorLinea.delete(idAnterior);
                    lineaQrObjetivoId = null;
                    toast(`${nombreAnterior} quedó conectada.`, 'success');
                }

                if (esperandoNuevoQr) return;
            }

            if (lineaQrObjetivoId) {
                const objetivo = porId.get(lineaQrObjetivoId);
                if (!objetivo) {
                    lineaQrObjetivoId = null;
                } else if (
                    objetivo.estado === 'esperando_qr' &&
                    String(objetivo.qr || '').trim()
                ) {
                    if (puedeAbrirQrAutomaticamente()) {
                        abrirQrDeLinea(objetivo);
                    }
                    return;
                } else if (objetivo.estado === 'conectado') {
                    qrDescartadosPorLinea.delete(String(objetivo.id));
                    lineaQrObjetivoId = null;
                } else if (!['iniciando', 'reconectando'].includes(objetivo.estado)) {
                    lineaQrObjetivoId = null;
                }
            }

            // Los QR antiguos no interrumpen otras tareas: se abren desde su card.
        }

        document.getElementById('qr-account-search').addEventListener('input', evento => {
            qrBusquedaCuenta = evento.currentTarget.value;
            renderizarCuentasGoogleQr();
        });

        document.getElementById('qr-account-list').addEventListener('click', evento => {
            const opcion = evento.target.closest('[data-qr-account-id]');
            if (!opcion) return;
            seleccionarCuentaGoogleQr(opcion.dataset.qrAccountId);
        });

        document.getElementById('btn-qr-manage-google').addEventListener('click', () => {
            const lineaId = String(lineaQrModalId || '');
            cerrarQrDeLinea({ manual: true });
            agendaLineaId = lineaId || agendaLineaId;
            agendaCuentaId = null;
            agendaFirmaLineas = '';
            agendaFirmaCuentas = '';
            mostrarSeccion('agendamiento');
            toast('Conectá una cuenta de Google y luego volvé a abrir el QR.', 'info');
        });

        document.getElementById('modal-qr-linea').addEventListener('click', evento => {
            if (evento.target.id === 'modal-qr-linea') {
                cerrarQrDeLinea({ manual: true });
            }
        });

        document.addEventListener('keydown', evento => {
            const modalQr = document.getElementById('modal-qr-linea');
            if (!modalQr.classList.contains('open')) return;
            if (document.getElementById('modal-confirmacion').classList.contains('open')) return;

            if (evento.key === 'Escape') {
                evento.preventDefault();
                cerrarQrDeLinea({ manual: true });
                return;
            }

            if (evento.key !== 'Tab') return;

            const controles = Array.from(modalQr.querySelectorAll(
                'input:not(:disabled), button:not(:disabled), [tabindex="0"]'
            )).filter(control => control.offsetParent !== null);
            if (!controles.length) {
                evento.preventDefault();
                modalQr.querySelector('.qr-line-modal-card').focus({ preventScroll: true });
                return;
            }

            const primero = controles[0];
            const ultimo = controles[controles.length - 1];
            if (evento.shiftKey && document.activeElement === primero) {
                evento.preventDefault();
                ultimo.focus({ preventScroll: true });
            } else if (!evento.shiftKey && document.activeElement === ultimo) {
                evento.preventDefault();
                primero.focus({ preventScroll: true });
            } else if (!controles.includes(document.activeElement)) {
                evento.preventDefault();
                primero.focus({ preventScroll: true });
            }
        });

        function actualizarCantidadSeleccionadas() {
            document.getElementById('cantidad-lineas-seleccionadas').textContent =
                `${lineasSeleccionadas.size} línea(s)`;
        }

        function lineasDisponiblesParaEliminar(grupo = null) {
            const lineas = (Array.isArray(cacheLineasAgendamiento)
                ? cacheLineasAgendamiento
                : [])
                .filter(linea => linea?.id)
                .map(linea => ({
                    ...linea,
                    id: String(linea.id)
                }));

            if (grupo === 'conectadas') {
                return lineas.filter(linea => linea.estado === 'conectado');
            }
            if (grupo === 'pendientes') {
                return lineas.filter(linea => linea.estado !== 'conectado');
            }
            return lineas;
        }

        function actualizarControlesEliminacionLineas() {
            const lineasDisponibles = lineasDisponiblesParaEliminar();
            const idsDisponibles = new Set(
                lineasDisponibles.map(linea => linea.id)
            );

            for (const id of Array.from(lineasSeleccionadasEliminar)) {
                if (!idsDisponibles.has(id)) {
                    lineasSeleccionadasEliminar.delete(id);
                }
            }

            const grupos = [
                {
                    nombre: 'pendientes',
                    selectorId: 'seleccionar-todas-eliminar-pendientes',
                    botonId: 'btn-eliminar-pendientes-seleccionadas',
                    contadorId: 'cantidad-eliminar-pendientes'
                },
                {
                    nombre: 'conectadas',
                    selectorId: 'seleccionar-todas-eliminar-conectadas',
                    botonId: 'btn-eliminar-conectadas-seleccionadas',
                    contadorId: 'cantidad-eliminar-conectadas'
                }
            ];

            grupos.forEach(grupo => {
                const disponiblesGrupo = lineasDisponiblesParaEliminar(
                    grupo.nombre
                );
                const seleccionadas = disponiblesGrupo.filter(linea =>
                    lineasSeleccionadasEliminar.has(linea.id)
                ).length;
                const selectorTodas = document.getElementById(
                    grupo.selectorId
                );
                const botonEliminar = document.getElementById(grupo.botonId);
                const contador = document.getElementById(grupo.contadorId);

                if (selectorTodas) {
                    selectorTodas.checked =
                        disponiblesGrupo.length > 0 &&
                        seleccionadas === disponiblesGrupo.length;
                    selectorTodas.indeterminate =
                        seleccionadas > 0 &&
                        seleccionadas < disponiblesGrupo.length;
                    selectorTodas.disabled =
                        eliminandoLineasSeleccionadas ||
                        disponiblesGrupo.length === 0;
                }
                if (contador) {
                    contador.textContent = String(seleccionadas);
                    contador.title = `${seleccionadas} seleccionada${seleccionadas === 1 ? '' : 's'}`;
                    contador.setAttribute(
                        'aria-label',
                        `${seleccionadas} línea${seleccionadas === 1 ? '' : 's'} seleccionada${seleccionadas === 1 ? '' : 's'}`
                    );
                }
                if (botonEliminar) {
                    botonEliminar.disabled =
                        eliminandoLineasSeleccionadas || seleccionadas === 0;
                }
            });

            document.querySelectorAll('.line-delete-check').forEach(checkbox => {
                const id = String(checkbox.dataset.id || checkbox.value || '');
                checkbox.checked = lineasSeleccionadasEliminar.has(id);
                checkbox.disabled = eliminandoLineasSeleccionadas;
                checkbox.closest('.connected-line-card, .pending-line-card')
                    ?.classList.toggle('selected-for-delete', checkbox.checked);
            });
        }

        function manejarCambioSeleccionEliminarLinea(evento) {
            const checkbox = evento.target.closest('.line-delete-check');
            if (!checkbox) return;
            const id = String(checkbox.dataset.id || checkbox.value || '');
            if (!id) return;

            if (checkbox.checked) lineasSeleccionadasEliminar.add(id);
            else lineasSeleccionadasEliminar.delete(id);
            actualizarControlesEliminacionLineas();
        }

        function limpiarLineaEliminadaEnInterfaz(idEntrada) {
            const id = String(idEntrada || '');
            if (!id) return;
            if (lineaQrModalId === id) cerrarQrDeLinea();
            if (lineaQrObjetivoId === id) lineaQrObjetivoId = null;
            qrDescartadosPorLinea.delete(id);
            lineasSeleccionadas.delete(id);
            lineasSeleccionadasEliminar.delete(id);
            if (selectorEtiquetaAbiertoId === id) selectorEtiquetaAbiertoId = null;
            actualizarCheckboxGeneral();
            actualizarControlesEliminacionLineas();
        }

        async function eliminarLineaRemota(idEntrada) {
            const id = String(idEntrada || '');
            const respuesta = await fetch(
                `/lineas/${encodeURIComponent(id)}`,
                { method: 'DELETE' }
            );
            const data = await leerRespuesta(respuesta);
            if (!respuesta.ok) {
                const error = new Error(
                    data.error || 'No se pudo eliminar la línea.'
                );
                error.codigo = data.codigo || null;
                throw error;
            }
            limpiarLineaEliminadaEnInterfaz(id);
            return data;
        }

        async function eliminarSeleccionLineas(grupo) {
            if (eliminandoLineasSeleccionadas) return;
            if (grupo !== 'conectadas' && grupo !== 'pendientes') return;

            const disponibles = lineasDisponiblesParaEliminar(grupo);
            const porId = new Map(disponibles.map(linea => [linea.id, linea]));
            const ids = Array.from(lineasSeleccionadasEliminar)
                .filter(id => porId.has(id));
            if (!ids.length) {
                actualizarControlesEliminacionLineas();
                return;
            }

            const sonConectadas = grupo === 'conectadas';
            const descripcionGrupo = sonConectadas
                ? `conectada${ids.length === 1 ? '' : 's'}`
                : `pendiente${ids.length === 1 ? '' : 's'} o reconectando`;
            const confirmado = await solicitarConfirmacion({
                titulo: `Eliminar ${ids.length} línea${ids.length === 1 ? '' : 's'} ${descripcionGrupo}`,
                mensaje: sonConectadas
                    ? 'Se eliminarán las sesiones seleccionadas. Para volver a usarlas tendrás que vincularlas nuevamente.'
                    : 'Se detendrá cualquier vinculación o reconexión en curso. Para volver a usarlas tendrás que vincularlas nuevamente.',
                textoConfirmar: `Eliminar ${ids.length}`,
                icono: 'trash'
            });
            if (!confirmado) return;

            const prefijoId = sonConectadas ? 'conectadas' : 'pendientes';
            const boton = document.getElementById(
                `btn-eliminar-${prefijoId}-seleccionadas`
            );
            const textoBoton = document.getElementById(
                `texto-eliminar-${prefijoId}`
            );
            const tituloBotonOriginal = boton?.title || '';
            const fallidas = [];
            let eliminadas = 0;
            eliminandoLineasSeleccionadas = true;
            actualizarControlesEliminacionLineas();
            boton?.setAttribute('aria-busy', 'true');

            try {
                for (let indice = 0; indice < ids.length; indice += 1) {
                    const id = ids[indice];
                    if (textoBoton) {
                        textoBoton.textContent = `${indice + 1} / ${ids.length}`;
                    }
                    if (boton) {
                        boton.title = `Eliminando línea ${indice + 1} de ${ids.length}`;
                    }
                    try {
                        await eliminarLineaRemota(id);
                        eliminadas += 1;
                    } catch (error) {
                        fallidas.push({
                            id,
                            nombre: porId.get(id)?.nombre || 'Línea',
                            mensaje: error.message
                        });
                    }
                }

                if (eliminadas > 0) {
                    toast(
                        `${eliminadas} línea${eliminadas === 1 ? '' : 's'} eliminada${eliminadas === 1 ? '' : 's'} correctamente.`,
                        'success'
                    );
                }
                if (fallidas.length > 0) {
                    const primera = fallidas[0];
                    toast(
                        `${fallidas.length} no se pudieron eliminar. ${primera.nombre}: ${primera.mensaje}`,
                        'error'
                    );
                }
            } finally {
                eliminandoLineasSeleccionadas = false;
                if (textoBoton) textoBoton.textContent = 'Eliminar';
                if (boton) {
                    boton.removeAttribute('aria-busy');
                    boton.title = tituloBotonOriginal;
                }
                actualizarControlesEliminacionLineas();
                actualizarLineas();
            }
        }

