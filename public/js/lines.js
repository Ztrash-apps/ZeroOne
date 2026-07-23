        function mostrarSeccion(nombre, opciones = {}) {
            if (!Object.prototype.hasOwnProperty.call(titulos, nombre)) {
                nombre = 'dashboard';
            }

            seccionActual = nombre;

            document.querySelectorAll('.section').forEach(seccion => {
                seccion.classList.toggle(
                    'active',
                    seccion.id === `section-${nombre}`
                );
            });

            document.querySelectorAll('.nav-button').forEach(boton => {
                boton.classList.toggle(
                    'active',
                    boton.dataset.section === nombre
                );
            });

            document.getElementById('page-title').textContent = titulos[nombre] || 'ZeroOne';
            document.getElementById('view-controls').style.display =
                nombre === 'dashboard' ? 'flex' : 'none';

            const fab = document.getElementById('btn-nuevo-estado');
            const fabEsLinea = nombre === 'lineas';
            const ocultarFab = nombre === 'agendamiento';
            fab.title = fabEsLinea ? 'Conectar una nueva línea' : 'Crear nuevo estado';
            fab.setAttribute('aria-label', fab.title);
            fab.style.display = ocultarFab ? 'none' : 'grid';
            fab.setAttribute('aria-hidden', String(ocultarFab));

            if (opciones.actualizarHash !== false && location.hash !== `#${nombre}`) {
                history.pushState({ seccion: nombre }, '', `#${nombre}`);
            }

            if (nombre === 'dashboard') {
                actualizarResumen();
                actualizarProgramaciones();
            }
            if (nombre === 'activos') actualizarEstadosActivos(true);
            if (nombre === 'estados') actualizarLineas();
            if (nombre === 'lineas') {
                renderizarLineasConectadas(cacheLineasSeccion);
                actualizarLineas();
            }
            if (nombre === 'agendamiento') {
                actualizarLineas();
                actualizarAgendamiento(true);
            }
            if (nombre === 'historial') actualizarHistorial();
            if (nombre === 'configuracion') cargarConfiguracion();
            if (nombre === 'lineas') {
                void cargarCuentasGoogleParaLinea(true);
            }

            programarActualizacionAgendamiento();
        }

        function actualizarCheckboxGeneral() {
            const checkbox = document.getElementById('seleccionar-todas');

            const cantidadSeleccionadas =
                idsLineasConectadas.filter(id =>
                    lineasSeleccionadas.has(id)
                ).length;

            checkbox.checked =
                idsLineasConectadas.length > 0 &&
                cantidadSeleccionadas === idsLineasConectadas.length;

            checkbox.indeterminate =
                cantidadSeleccionadas > 0 &&
                cantidadSeleccionadas < idsLineasConectadas.length;

            checkbox.disabled = idsLineasConectadas.length === 0;

            actualizarCantidadSeleccionadas();
        }

        function claseEstadoLinea(estado) {
            if (estado === 'esperando_qr') return 'waiting';
            if ([
                'error',
                'sesion_cerrada',
                'desconectado',
                'reconectando',
                'requiere_intervencion'
            ].includes(estado)) return 'error';
            return '';
        }

        function mostrarEstado(estado) {
            const estados = {
                iniciando: ['loader', 'Iniciando'],
                esperando_qr: ['phone', 'Esperando QR'],
                conectado: ['check-circle', 'Conectado'],
                desconectado: ['x-circle', 'Desconectado'],
                reconectando: ['refresh', 'Desconectado · reconectando'],
                requiere_intervencion: ['alert', 'Intervención manual requerida'],
                sesion_cerrada: ['alert', 'Sesión cerrada'],
                error: ['x-circle', 'Error']
            };

            const valor = estados[estado];
            if (!valor) return escaparHTML(estado);
            return `<span class="status-inline">${iconoSVG(valor[0])}<span>${valor[1]}</span></span>`;
        }


        function normalizarEtiquetaVisual(etiqueta) {
            const valor = String(etiqueta || '').trim().toLowerCase();
            return ['activa', 'indefinida', 'caida', 'reposo'].includes(valor)
                ? valor
                : 'indefinida';
        }

        function nombreEtiqueta(etiqueta) {
            const nombres = {
                activa: 'Activa',
                indefinida: 'Indefinida',
                caida: 'Caída',
                reposo: 'Reposo'
            };

            return nombres[normalizarEtiquetaVisual(etiqueta)];
        }

        function etiquetaHTML(etiqueta) {
            const valor = normalizarEtiquetaVisual(etiqueta);
            return `<span class="line-tag ${valor}">${nombreEtiqueta(valor)}</span>`;
        }

        function selectorEtiquetaHTML(linea, abiertoForzado = null) {
            const valor = normalizarEtiquetaVisual(linea.etiqueta);
            const estaAbierto = typeof abiertoForzado === 'boolean'
                ? abiertoForzado
                : selectorEtiquetaAbiertoId === linea.id;
            const opciones = ['activa', 'indefinida', 'caida', 'reposo']
                .map(opcion => `
                    <button
                        type="button"
                        class="line-tag ${opcion} tag-option"
                        data-id="${linea.id}"
                        data-etiqueta="${opcion}"
                    >
                        ${nombreEtiqueta(opcion)}
                    </button>
                `)
                .join('');

            return `
                <div
                    class="tag-picker ${estaAbierto ? 'open' : ''}"
                    data-id="${linea.id}"
                >
                    <button
                        type="button"
                        class="tag-picker-button btn-abrir-etiquetas"
                        data-id="${linea.id}"
                        aria-expanded="${estaAbierto ? 'true' : 'false'}"
                    >
                        ${iconoSVG('tag')}
                        <span>Etiquetas</span>
                        ${iconoSVG('chevron-down', 'tag-chevron')}
                    </button>
                    <div class="tag-menu" role="menu" aria-label="Etiquetas de ${escaparHTML(linea.nombre)}">
                        ${opciones}
                    </div>
                </div>
            `;
        }

        function formatearFechaCompacta(valor, reemplazo = 'Sin registro') {
            if (!valor) return reemplazo;
            const fecha = new Date(valor);
            if (Number.isNaN(fecha.getTime())) return reemplazo;

            return fecha.toLocaleString('es-PY', {
                day: '2-digit',
                month: '2-digit',
                year: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
        }

        function obtenerAvatarLinea(linea) {
            const nombre = String(linea.nombre || '').trim();
            const numeroNombre = nombre.match(/(\d{1,3})(?!.*\d)/);
            if (numeroNombre) return numeroNombre[1];

            const iniciales = nombre
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map(parte => parte[0])
                .join('')
                .toUpperCase();

            return iniciales || String(linea.ordenOriginal || '--');
        }

        function describirLineaPendiente(linea, intentos, maximosIntentos) {
            const estado = String(linea.estado || 'error');
            const error = String(linea.ultimoError || '').trim();
            const requiereIntervencion = linea.reconexionBloqueada === true ||
                estado === 'requiere_intervencion';

            if (estado === 'esperando_qr') {
                return {
                    clase: 'qr',
                    icono: 'qr',
                    titulo: 'QR listo para escanear',
                    detalle: 'Escaneá el código para completar la vinculación con WhatsApp.'
                };
            }

            if (requiereIntervencion) {
                return {
                    clase: 'danger',
                    icono: 'alert',
                    titulo: 'Intervención manual',
                    detalle: `Los reintentos automáticos se detuvieron (${intentos} de ${maximosIntentos}). Reconectá la línea manualmente.`
                };
            }

            if (estado === 'reconectando') {
                return {
                    clase: 'progress',
                    icono: 'loader',
                    iconoClase: 'spin',
                    titulo: 'Reconectando',
                    detalle: error || 'Intentando restablecer la sesión de WhatsApp.'
                };
            }

            if (estado === 'iniciando') {
                return {
                    clase: 'progress',
                    icono: 'loader',
                    iconoClase: 'spin',
                    titulo: 'Preparando conexión',
                    detalle: 'Creando una sesión segura para generar el código QR.'
                };
            }

            if (estado === 'sesion_cerrada') {
                return {
                    clase: 'danger',
                    icono: 'x-circle',
                    titulo: 'Sesión cerrada',
                    detalle: error || 'Volvé a vincular esta línea para continuar.'
                };
            }

            return {
                clase: 'danger',
                icono: 'alert',
                titulo: estado === 'desconectado' ? 'Línea desconectada' : 'Conexión pendiente',
                detalle: error || 'La línea necesita atención antes de volver a publicar.'
            };
        }

        function aplicarVistaLineasPendientes() {
            const vistasPermitidas = new Set(['small', 'large', 'list']);
            if (!vistasPermitidas.has(vistaLineasPendientes)) {
                vistaLineasPendientes = 'large';
            }

            const contenedor = document.getElementById('lista-lineas-pendientes');
            if (contenedor) {
                contenedor.className =
                    `lines-grid pending-lines-grid view-${vistaLineasPendientes}`;
            }

            document.querySelectorAll('[data-pending-line-view]').forEach(boton => {
                const activa = boton.dataset.pendingLineView ===
                    vistaLineasPendientes;
                boton.classList.toggle('active', activa);
                boton.setAttribute('aria-pressed', String(activa));
            });
        }

        function renderizarLineasPendientes(lineas = cacheLineasPendientes) {
            const contenedor = document.getElementById('lista-lineas-pendientes');
            if (!contenedor) return;

            cacheLineasPendientes = Array.isArray(lineas) ? lineas : [];
            aplicarVistaLineasPendientes();

            const existentes = new Map(
                Array.from(
                    contenedor.querySelectorAll('.pending-line-card[data-line-id]')
                ).map(tarjeta => [tarjeta.dataset.lineId, tarjeta])
            );
            const idsVisibles = new Set();
            let indice = 0;

            if (cacheLineasPendientes.length) {
                contenedor.querySelector('.pending-lines-empty')?.remove();
            }

            for (const linea of cacheLineasPendientes) {
                const id = String(linea.id);
                const intentos = Math.max(0, Number(linea.intentosReconexion) || 0);
                const maximosIntentos = Math.max(
                    1,
                    Number(linea.maximosIntentosReconexion) || 5
                );
                const estadoVisual = describirLineaPendiente(
                    linea,
                    intentos,
                    maximosIntentos
                );
                const requiereIntervencion = linea.reconexionBloqueada === true ||
                    linea.estado === 'requiere_intervencion';
                const tieneQr = linea.estado === 'esperando_qr' &&
                    Boolean(String(linea.qr || '').trim());
                const proximoIntento = linea.proximoIntentoReconexion
                    ? formatearFechaCompacta(linea.proximoIntentoReconexion)
                    : '';
                const tituloDetalle = [
                    estadoVisual.detalle,
                    linea.ultimoError,
                    proximoIntento ? `Próximo intento: ${proximoIntento}` : ''
                ].filter(Boolean).join(' · ');
                const chips = [
                    intentos > 0 || requiereIntervencion || linea.estado === 'reconectando'
                        ? `
                            <span class="pending-line-chip ${requiereIntervencion ? 'critical' : ''}">
                                ${iconoSVG('refresh')}
                                <span>${intentos}/${maximosIntentos} intentos</span>
                            </span>
                        `
                        : '',
                    proximoIntento && !requiereIntervencion
                        ? `
                            <span class="pending-line-chip" title="Próximo intento: ${escaparHTML(proximoIntento)}">
                                ${iconoSVG('clock')}
                                <span>Próximo ${escaparHTML(proximoIntento)}</span>
                            </span>
                        `
                        : ''
                ].filter(Boolean).join('');

                idsVisibles.add(id);
                const tarjeta = existentes.get(id) || document.createElement('article');
                tarjeta.className = 'pending-line-card';
                tarjeta.classList.toggle(
                    'selected-for-delete',
                    lineasSeleccionadasEliminar.has(id)
                );
                tarjeta.dataset.lineId = id;
                tarjeta.dataset.state = String(linea.estado || 'error');

                const contenido = `
                    <header class="pending-line-header">
                        <span class="pending-line-avatar">${escaparHTML(obtenerAvatarLinea({
                            ...linea,
                            ordenOriginal: linea.ordenConexion
                        }))}</span>
                        <div class="pending-line-identity">
                            <div class="pending-line-name-row">
                                <h3>${escaparHTML(linea.nombre)}</h3>
                                ${etiquetaHTML(linea.etiqueta)}
                            </div>
                            <span class="pending-line-last-seen">
                                ${iconoSVG('clock')}
                                <span>Última conexión: ${escaparHTML(formatearFechaCompacta(linea.ultimaConexion))}</span>
                            </span>
                        </div>
                        <span class="line-card-header-tools">
                            <input
                                type="checkbox"
                                class="line-check line-delete-check"
                                data-id="${escaparHTML(id)}"
                                value="${escaparHTML(id)}"
                                aria-label="Seleccionar ${escaparHTML(linea.nombre)} para eliminar"
                                title="Seleccionar para eliminar"
                                ${lineasSeleccionadasEliminar.has(id) ? 'checked' : ''}
                                ${eliminandoLineasSeleccionadas ? 'disabled' : ''}
                            >
                            <span class="pending-line-order">#${Number(linea.ordenConexion) || 0}</span>
                        </span>
                    </header>

                    <div class="pending-line-status-row">
                        <span class="pending-line-status-pill ${estadoVisual.clase}">
                            ${iconoSVG(estadoVisual.icono, estadoVisual.iconoClase || '')}
                            <span>${escaparHTML(estadoVisual.titulo)}</span>
                        </span>
                        ${tieneQr
                            ? `
                                <button type="button" class="pending-qr-button btn-ver-qr" data-id="${escaparHTML(id)}">
                                    ${iconoSVG('qr')}
                                    <span>Ver QR</span>
                                </button>
                            `
                            : ''}
                    </div>

                    <p class="pending-line-message" title="${escaparHTML(tituloDetalle)}">
                        ${escaparHTML(estadoVisual.detalle)}
                    </p>

                    <div class="pending-line-meta">${chips}</div>

                    <div class="pending-line-actions">
                        ${selectorEtiquetaHTML(linea, false)}
                        <button
                            type="button"
                            class="small-secondary pending-icon-button btn-reconectar"
                            data-id="${escaparHTML(id)}"
                            title="${requiereIntervencion ? 'Reconectar manualmente' : 'Reconectar línea'}"
                            aria-label="${requiereIntervencion ? 'Reconectar manualmente' : 'Reconectar línea'}"
                        >
                            ${iconoSVG('refresh')}
                        </button>
                        <button
                            type="button"
                            class="small-danger pending-icon-button btn-eliminar"
                            data-id="${escaparHTML(id)}"
                            title="Eliminar línea"
                            aria-label="Eliminar línea"
                        >
                            ${iconoSVG('trash')}
                        </button>
                    </div>
                `;

                if (tarjeta.__contenidoRenderizado !== contenido) {
                    tarjeta.innerHTML = contenido;
                    tarjeta.__contenidoRenderizado = contenido;
                }

                const selectorEtiqueta = tarjeta.querySelector('.tag-picker');
                const etiquetaAbierta = selectorEtiquetaAbiertoId === id;
                selectorEtiqueta?.classList.toggle('open', etiquetaAbierta);
                selectorEtiqueta?.querySelector('.tag-picker-button')
                    ?.setAttribute('aria-expanded', String(etiquetaAbierta));

                const posicion = contenedor.children[indice];
                if (posicion !== tarjeta) {
                    contenedor.insertBefore(tarjeta, posicion || null);
                }
                indice += 1;
            }

            existentes.forEach((tarjeta, id) => {
                if (!idsVisibles.has(id)) tarjeta.remove();
            });

            if (!cacheLineasPendientes.length) {
                let estadoVacio = contenedor.querySelector('.pending-lines-empty');
                if (!estadoVacio) {
                    estadoVacio = document.createElement('div');
                    estadoVacio.className = 'empty-state pending-lines-empty';
                    contenedor.appendChild(estadoVacio);
                }
                estadoVacio.innerHTML = '<div>No hay líneas pendientes.</div>';
            }
        }

        async function manejarClickLineasPendientes(evento) {
            const botonEtiquetas = evento.target.closest('.btn-abrir-etiquetas');
            if (botonEtiquetas) {
                evento.stopPropagation();
                const id = botonEtiquetas.dataset.id;
                selectorEtiquetaAbiertoId = selectorEtiquetaAbiertoId === id ? null : id;

                document.querySelectorAll('.tag-picker').forEach(picker => {
                    const abierto = picker.dataset.id === selectorEtiquetaAbiertoId;
                    picker.classList.toggle('open', abierto);
                    picker.querySelector('.tag-picker-button')
                        ?.setAttribute('aria-expanded', String(abierto));
                });
                return;
            }

            const opcionEtiqueta = evento.target.closest('.tag-option');
            if (opcionEtiqueta) {
                evento.stopPropagation();
                const id = opcionEtiqueta.dataset.id;
                opcionEtiqueta.disabled = true;

                try {
                    const respuesta = await fetch(
                        `/lineas/${encodeURIComponent(id)}/etiqueta`,
                        {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                etiqueta: opcionEtiqueta.dataset.etiqueta
                            })
                        }
                    );
                    const data = await leerRespuesta(respuesta);
                    if (!respuesta.ok) {
                        throw new Error(data.error || 'No se pudo actualizar la etiqueta.');
                    }

                    selectorEtiquetaAbiertoId = null;
                    toast(data.mensaje || 'Etiqueta actualizada.', 'success');
                    actualizarLineas();
                } catch (error) {
                    opcionEtiqueta.disabled = false;
                    toast(error.message, 'error');
                }
                return;
            }

            const botonQr = evento.target.closest('.btn-ver-qr');
            if (botonQr) {
                const linea = cacheLineasPendientes.find(
                    item => String(item.id) === String(botonQr.dataset.id)
                );
                if (!abrirQrDeLinea(linea, { forzar: true })) {
                    toast('El código QR todavía no está disponible.', 'warning');
                }
                return;
            }

            const botonReconectar = evento.target.closest('.btn-reconectar');
            if (botonReconectar) {
                if (publicacionActivaActual) {
                    toast(
                        'Esperá a que termine la publicación o usá Alto total antes de reconectar.',
                        'warning'
                    );
                    actualizarAccionesPublicacion();
                    return;
                }

                const id = botonReconectar.dataset.id;
                const contenidoOriginal = botonReconectar.innerHTML;
                prepararAperturaQr(id);
                botonReconectar.disabled = true;
                botonReconectar.innerHTML = iconoSVG('loader', 'spin');

                try {
                    const respuesta = await fetch(
                        `/lineas/${encodeURIComponent(id)}/reconectar`,
                        { method: 'POST' }
                    );
                    const data = await leerRespuesta(respuesta);
                    if (!respuesta.ok) {
                        throw new Error(data.error || 'No se pudo reconectar la línea.');
                    }

                    const tarjeta = botonReconectar.closest('.pending-line-card');
                    if (tarjeta) tarjeta.__contenidoRenderizado = null;
                    toast(data.mensaje || 'Reconexión iniciada.', 'success');
                    setTimeout(actualizarLineas, 700);
                } catch (error) {
                    if (lineaQrObjetivoId === String(id)) lineaQrObjetivoId = null;
                    botonReconectar.disabled = false;
                    botonReconectar.innerHTML = contenidoOriginal;
                    toast(error.message, 'error');
                }
                return;
            }

            const botonEliminar = evento.target.closest('.btn-eliminar');
            if (!botonEliminar) return;
            const id = String(botonEliminar.dataset.id);
            const confirmado = await solicitarConfirmacion({
                titulo: 'Eliminar línea',
                mensaje: 'La línea se quitará de ZeroOne y su sesión se cerrará. Para usarla otra vez tendrás que vincularla nuevamente.',
                textoConfirmar: 'Eliminar línea',
                icono: 'trash'
            });
            if (!confirmado) return;

            try {
                botonEliminar.disabled = true;
                const data = await eliminarLineaRemota(id);
                toast(data.mensaje || 'Línea eliminada.', 'success');
                actualizarLineas();
            } catch (error) {
                botonEliminar.disabled = false;
                toast(error.message, 'error');
            }
        }

        function compararLineasPor(a, b, criterio, direccion) {
            const texto = valor => String(valor || '').toLocaleLowerCase('es');
            const ordenConexion = linea => {
                const valor = Number(linea.ordenOriginal ?? linea.ordenConexion);
                return Number.isFinite(valor) ? valor : Number.MAX_SAFE_INTEGER;
            };
            let resultado;

            if (criterio === 'alfabetico') {
                resultado = texto(a.nombre).localeCompare(
                    texto(b.nombre),
                    'es',
                    { numeric: true }
                );

                if (resultado === 0) {
                    resultado = ordenConexion(a) - ordenConexion(b);
                }
            } else {
                resultado = ordenConexion(a) - ordenConexion(b);
            }

            return direccion === 'desc' ? -resultado : resultado;
        }

        function compararLineas(a, b) {
            return compararLineasPor(a, b, ordenLineas, direccionLineas);
        }

        function compararLineasSubida(a, b) {
            return compararLineasPor(
                a,
                b,
                ordenLineasSubida,
                direccionLineasSubida
            );
        }

        function actualizarControlesVistaLineas() {
            document.querySelectorAll('[data-line-view]').forEach(boton => {
                boton.classList.toggle('active', boton.dataset.lineView === vistaLineas);
            });

            const selectorOrden = document.getElementById('selector-orden-lineas');
            const botonOrden = document.getElementById('btn-orden-lineas');
            const textoOrden = document.getElementById('texto-orden-lineas');
            const nombreOrden = ordenLineas === 'alfabetico'
                ? 'Alfabético'
                : 'Orden de conexión';

            if (textoOrden) textoOrden.textContent = nombreOrden;
            document.querySelectorAll('[data-line-order]').forEach(opcion => {
                const estaActiva = opcion.dataset.lineOrder === ordenLineas;
                opcion.classList.toggle('active', estaActiva);
                opcion.setAttribute('aria-selected', String(estaActiva));
            });
            if (botonOrden && selectorOrden) {
                botonOrden.setAttribute(
                    'aria-expanded',
                    String(selectorOrden.classList.contains('open'))
                );
            }

            const botonDireccion = document.getElementById('btn-direccion-lineas');
            const textoDireccion = document.getElementById('texto-direccion-lineas');
            const esAscendente = direccionLineas === 'asc';
            const esAlfabetico = ordenLineas === 'alfabetico';
            const etiqueta = esAlfabetico
                ? (esAscendente ? 'A → Z' : 'Z → A')
                : (esAscendente ? '1 → 10' : '10 → 1');
            const siguiente = esAscendente ? 'descendente' : 'ascendente';

            if (textoDireccion) textoDireccion.textContent = etiqueta;
            if (botonDireccion) {
                botonDireccion.dataset.direction = direccionLineas;
                botonDireccion.title = `Cambiar a orden ${siguiente}`;
                botonDireccion.setAttribute('aria-label', `Cambiar a orden ${siguiente}`);
            }
        }

        function actualizarControlesOrdenLineasSubida(totalLineas = cacheLineasSeccion.length) {
            const selectorOrden = document.getElementById('selector-orden-lineas-subida');
            const botonOrden = document.getElementById('btn-orden-lineas-subida');
            const textoOrden = document.getElementById('texto-orden-lineas-subida');
            const nombreOrden = ordenLineasSubida === 'alfabetico'
                ? 'Alfabético'
                : 'Orden de conexión';

            if (textoOrden) textoOrden.textContent = nombreOrden;
            document.querySelectorAll('[data-upload-line-order]').forEach(opcion => {
                const estaActiva = opcion.dataset.uploadLineOrder === ordenLineasSubida;
                opcion.classList.toggle('active', estaActiva);
                opcion.setAttribute('aria-selected', String(estaActiva));
            });

            if (botonOrden && selectorOrden) {
                botonOrden.setAttribute(
                    'aria-expanded',
                    String(selectorOrden.classList.contains('open'))
                );
            }

            const botonDireccion = document.getElementById('btn-direccion-lineas-subida');
            const textoDireccion = document.getElementById('texto-direccion-lineas-subida');
            const esAscendente = direccionLineasSubida === 'asc';
            const esAlfabetico = ordenLineasSubida === 'alfabetico';
            const etiqueta = esAlfabetico
                ? (esAscendente ? 'A → Z' : 'Z → A')
                : (esAscendente ? '1 → 10' : '10 → 1');
            const siguiente = esAscendente ? 'descendente' : 'ascendente';

            if (textoDireccion) textoDireccion.textContent = etiqueta;
            if (botonDireccion) {
                botonDireccion.dataset.direction = direccionLineasSubida;
                botonDireccion.title = `Cambiar a orden ${siguiente}`;
                botonDireccion.setAttribute('aria-label', `Cambiar a orden ${siguiente}`);
            }
        }

        function renderizarLineasConectadas(lineas = cacheLineasSeccion) {
            const contenedor = document.getElementById('lista-lineas-conectadas');
            if (!contenedor) return;

            cacheLineasSeccion = Array.isArray(lineas) ? lineas : [];
            const busqueda = document
                .getElementById('buscar-lineas-seccion')
                .value
                .trim()
                .toLocaleLowerCase('es');

            const filtradas = cacheLineasSeccion
                .filter(linea =>
                    !busqueda ||
                    String(linea.nombre || '').toLocaleLowerCase('es').includes(busqueda) ||
                    String(linea.numero || '').toLocaleLowerCase('es').includes(busqueda) ||
                    nombreEtiqueta(linea.etiqueta).toLocaleLowerCase('es').includes(busqueda)
                )
                .sort(compararLineas);

            const visibles = filtradas;

            contenedor.className = `connected-lines-grid view-${vistaLineas}`;
            const tarjetasExistentes = new Map(
                Array.from(
                    contenedor.querySelectorAll('.connected-line-card[data-line-id]')
                ).map(tarjeta => [tarjeta.dataset.lineId, tarjeta])
            );
            const idsVisibles = new Set();
            let indiceTarjeta = 0;

            if (visibles.length) {
                contenedor.querySelector('.connected-lines-empty')?.remove();
            }

            for (const linea of visibles) {
                const idLinea = String(linea.id);
                idsVisibles.add(idLinea);
                const tarjeta = tarjetasExistentes.get(idLinea) ||
                    document.createElement('article');
                tarjeta.className = 'connected-line-card';
                tarjeta.classList.toggle(
                    'selected-for-delete',
                    lineasSeleccionadasEliminar.has(idLinea)
                );
                tarjeta.dataset.lineId = idLinea;
                const audienciaLista = Boolean(linea.audienciaEstadosLista);
                const audienciaSeleccionada = Number(linea.destinatariosEstado) || 0;
                const audienciaTotal = Number(
                    linea.destinatariosEstadoTotales ?? linea.destinatariosEstado
                ) || 0;
                const audienciaBase = Number(
                    linea.destinatariosEstadoBase ??
                    Math.min(audienciaTotal, 1000)
                ) || 0;
                const audiencia = audienciaLista
                    ? audienciaBase > audienciaSeleccionada
                        ? `${audienciaSeleccionada.toLocaleString('es')} de ${audienciaBase.toLocaleString('es')} recientes`
                        : `${audienciaSeleccionada.toLocaleString('es')} contacto(s)`
                    : 'Sincronizando...';
                const origenAudiencia = ['google', 'whatsapp'].includes(
                    linea.origenAudiencia
                ) ? linea.origenAudiencia : null;
                const audienciaWhatsApp = Math.max(
                    0,
                    Number(linea.contactosEstadoWhatsApp) || 0
                );
                const audienciaGoogle = Math.max(
                    0,
                    Number(linea.contactosEstadoGoogle) || 0
                );
                const detalleComparacionAudiencia =
                    `WhatsApp: ${audienciaWhatsApp.toLocaleString('es')} · ` +
                    `Google: ${audienciaGoogle.toLocaleString('es')}. ` +
                    'Se usa la lista mayor; WhatsApp gana los empates.';
                const fuenteAudiencia = origenAudiencia === 'google'
                    ? {
                        texto: 'Google',
                        detalle:
                            `Audiencia elegida desde la cuenta de Google asociada. ${detalleComparacionAudiencia}`,
                        clase: 'source-google',
                        marca: 'G'
                    }
                    : origenAudiencia === 'whatsapp'
                        ? {
                            texto: 'WhatsApp',
                            detalle:
                                `Audiencia elegida desde la libreta sincronizada por WhatsApp. ${detalleComparacionAudiencia}`,
                            clase: 'source-whatsapp',
                            marca: 'W'
                        }
                        : {
                            texto: 'Origen pendiente',
                            detalle: 'ZeroOne todavía está identificando el origen de la audiencia',
                            clase: 'source-pending',
                            marca: '?'
                        };
                const priorizacionAudiencia = linea.priorizacionAudiencia || {};
                const actividadConocida = Math.max(
                    0,
                    Number(priorizacionAudiencia.actividadConocida) || 0
                );
                const actividadDesconocida = Math.max(
                    0,
                    Number(priorizacionAudiencia.actividadDesconocida) || 0
                );
                const muestraPrioridadActividad = audienciaLista &&
                    priorizacionAudiencia.criterio === 'actividad_reciente';
                const actualizandoActividad =
                    priorizacionAudiencia.sincronizandoActividad === true;
                const resumenActividad = muestraPrioridadActividad
                    ? `${actualizandoActividad ? 'Actualizando actividad' : 'Más recientes primero'} · ${actividadConocida.toLocaleString('es')} con actividad conocida · ${actividadDesconocida.toLocaleString('es')} sin datos`
                    : '';
                const detalleBase = audienciaLista && audienciaTotal > audienciaBase
                    ? `Base reciente: ${audienciaBase.toLocaleString('es')} de ${audienciaTotal.toLocaleString('es')} contactos disponibles`
                    : '';
                const detalleAudiencia = [
                    linea.ultimoError,
                    detalleBase,
                    resumenActividad
                ]
                    .filter(Boolean)
                    .join(' · ');
                const enVerificacion = linea.conexionEnVerificacion === true;
                const requiereRevision = linea.requiereRevisionEnvio === true;
                const listaParaPublicar = lineaListaParaPublicar(linea);
                const estadoPublicacion = requiereRevision
                    ? { icono: 'alert', texto: 'Publicaciones pausadas', clase: 'warning' }
                    : enVerificacion
                        ? { icono: 'loader', texto: 'Verificando conexión', clase: 'warning', iconoClase: 'spin' }
                        : listaParaPublicar
                            ? { icono: 'check-circle', texto: 'Lista para publicar', clase: '' }
                            : { icono: 'pause', texto: 'Publicación no disponible', clase: 'warning' };
                const avisoPublicacion = !listaParaPublicar
                    ? `
                        <div class="publication-review-notice">
                            <span class="publication-review-copy">
                                ${iconoSVG(requiereRevision ? 'alert' : enVerificacion ? 'loader' : 'info', enVerificacion ? 'spin' : '')}
                                <span>${escaparHTML(motivoLineaNoPublicable(linea))}</span>
                            </span>
                            ${requiereRevision
                                ? `<button type="button" class="btn-habilitar-publicaciones" data-id="${linea.id}">Revisé la línea</button>`
                                : ''}
                        </div>
                    `
                    : '';

                const contenidoTarjeta = `
                    <div class="connected-line-card-header">
                        <span class="connected-line-avatar">${escaparHTML(obtenerAvatarLinea(linea))}</span>
                        <div class="connected-line-identity">
                            <div class="connected-line-name-row">
                                <h3>${escaparHTML(linea.nombre)}</h3>
                                ${etiquetaHTML(linea.etiqueta)}
                            </div>
                            <span class="connected-line-number">
                                ${iconoSVG('phone-call')}
                                <span>${linea.numero ? escaparHTML(linea.numero) : 'Número no disponible'}</span>
                            </span>
                        </div>
                        <span class="line-card-header-tools">
                            <input
                                type="checkbox"
                                class="line-check line-delete-check"
                                data-id="${escaparHTML(idLinea)}"
                                value="${escaparHTML(idLinea)}"
                                aria-label="Seleccionar ${escaparHTML(linea.nombre)} para eliminar"
                                title="Seleccionar para eliminar"
                                ${lineasSeleccionadasEliminar.has(idLinea) ? 'checked' : ''}
                                ${eliminandoLineasSeleccionadas ? 'disabled' : ''}
                            >
                            <span class="connected-line-rank">#${Number(linea.ordenOriginal) || 0}</span>
                        </span>
                    </div>

                    <div class="connected-line-state-row">
                        <span class="connected-state-pill ${estadoPublicacion.clase}">
                            ${iconoSVG(estadoPublicacion.icono, estadoPublicacion.iconoClase || '')}
                            <span>${estadoPublicacion.texto}</span>
                        </span>
                        <span class="connected-original-order">Conexión original #${Number(linea.ordenOriginal) || 0}</span>
                    </div>

                    <div class="connected-line-health">
                        <div class="connected-health-item">
                            <span>Última conexión</span>
                            <strong>${escaparHTML(formatearFechaCompacta(linea.ultimaConexion))}</strong>
                        </div>
                        <div class="connected-health-item">
                            <span>Última publicación</span>
                            <strong>${escaparHTML(formatearFechaCompacta(linea.ultimaPublicacion))}</strong>
                        </div>
                    </div>

                    <div class="connected-line-audience" ${detalleAudiencia ? `title="${escaparHTML(detalleAudiencia)}"` : ''}>
                        <span class="audience-pill-row">
                            <span class="audience-pill ${audienciaLista ? '' : 'audience-syncing'}">
                                ${iconoSVG(audienciaLista ? 'users' : 'loader', audienciaLista ? '' : 'spin')}
                                <span>Audiencia: ${escaparHTML(audiencia)}</span>
                            </span>
                            <span
                                class="audience-source-pill ${fuenteAudiencia.clase}"
                                title="${escaparHTML(fuenteAudiencia.detalle)}"
                                aria-label="${escaparHTML(fuenteAudiencia.detalle)}"
                            >
                                <span class="audience-source-mark">${fuenteAudiencia.marca}</span>
                                <span>${fuenteAudiencia.texto}</span>
                            </span>
                        </span>
                        ${muestraPrioridadActividad
                            ? `<span class="audience-activity-summary">${escaparHTML(resumenActividad)}</span>`
                            : ''}
                    </div>

                    ${avisoPublicacion}

                    ${selectorEtiquetaHTML(linea)}

                    <div class="connected-line-actions">
                        <button type="button" class="btn-editar-linea" data-id="${linea.id}" title="Editar línea" aria-label="Editar línea">
                            ${iconoSVG('edit')}
                            <span>Editar</span>
                        </button>
                        <button type="button" class="small-secondary btn-reconectar" data-id="${linea.id}" title="Reconectar línea" aria-label="Reconectar línea">
                            ${iconoSVG('refresh')}
                            <span>Reconectar</span>
                        </button>
                        <button type="button" class="small-danger btn-eliminar" data-id="${linea.id}" title="Eliminar línea" aria-label="Eliminar línea">
                            ${iconoSVG('trash')}
                            <span>Eliminar</span>
                        </button>
                    </div>
                `;

                if (tarjeta.__contenidoRenderizado !== contenidoTarjeta) {
                    tarjeta.innerHTML = contenidoTarjeta;
                    tarjeta.__contenidoRenderizado = contenidoTarjeta;
                }

                const posicionActual = contenedor.children[indiceTarjeta];
                if (posicionActual !== tarjeta) {
                    contenedor.insertBefore(tarjeta, posicionActual || null);
                }
                indiceTarjeta += 1;
            }

            tarjetasExistentes.forEach((tarjeta, idLinea) => {
                if (!idsVisibles.has(idLinea)) tarjeta.remove();
            });

            if (!visibles.length) {
                let estadoVacio = contenedor.querySelector('.connected-lines-empty');
                if (!estadoVacio) {
                    estadoVacio = document.createElement('div');
                    estadoVacio.className = 'empty-state connected-lines-empty';
                    estadoVacio.style.gridColumn = '1 / -1';
                    contenedor.appendChild(estadoVacio);
                }

                estadoVacio.innerHTML = `
                        <div class="empty-state-content">
                            <span class="empty-state-icon">${iconoSVG('lines')}</span>
                            <strong>${busqueda ? 'No se encontraron líneas' : 'No hay líneas conectadas'}</strong>
                            <span>${busqueda ? 'Probá con otro nombre o número.' : 'Las líneas aparecerán acá cuando terminen de vincularse.'}</span>
                        </div>
                `;
            }

            const listasParaPublicar = cacheLineasSeccion.filter(lineaListaParaPublicar).length;
            document.getElementById('resultado-busqueda-seccion').textContent = busqueda
                ? `${filtradas.length} resultado(s) de ${cacheLineasSeccion.length}.`
                : `${cacheLineasSeccion.length} conectada(s) · ${listasParaPublicar} lista(s) para publicar.`;
            actualizarControlesVistaLineas();
        }

        function abrirEditorLinea(id) {
            const linea = cacheLineasSeccion.find(item => String(item.id) === String(id));
            if (!linea) return;

            lineaEditandoId = linea.id;
            document.getElementById('editar-linea-id').value = linea.id;
            document.getElementById('editar-linea-nombre').value = linea.nombre || '';
            document.getElementById('mensaje-editar-linea').textContent = '';
            abrirModal('modal-editar-linea');
            setTimeout(() => document.getElementById('editar-linea-nombre').focus(), 60);
        }

        function cerrarEditorLinea() {
            lineaEditandoId = null;
            document.getElementById('editar-linea-id').value = '';
            document.getElementById('editar-linea-nombre').value = '';
            document.getElementById('mensaje-editar-linea').textContent = '';
            cerrarModal('modal-editar-linea');
        }

        function htmlEstadosActivosVacios(mensaje = 'Las próximas publicaciones aparecerán agrupadas en este apartado.') {
            return `
                <div class="active-empty-state">
                    <div class="empty-state-content">
                        <span class="empty-state-icon">${iconoSVG('layers')}</span>
                        <strong>No hay estados activos guardados</strong>
                        <span>${escaparHTML(mensaje)}</span>
                    </div>
                </div>
            `;
        }

        function renderizarProgresoEliminacion(progreso = {}) {
            const activo = Boolean(progreso.activo);
            const estado = String(progreso.estado || 'inactivo');
            const total = Number(progreso.total) || 0;
            const procesadas = Number(progreso.procesadas) || 0;
            const porcentaje = total ? Math.min(100, Math.round((procesadas / total) * 100)) : 0;
            const badge = document.getElementById('eliminacion-estado');

            const etiquetaEstado = activo
                ? 'Eliminando'
                : estado === 'completado'
                    ? 'Completado'
                    : estado === 'completado_con_errores'
                        ? 'Con errores'
                        : estado === 'error'
                            ? 'Error'
                            : 'Inactivo';

            badge.textContent = etiquetaEstado;
            badge.classList.toggle('active', activo);
            badge.classList.toggle('success', !activo && estado === 'completado');
            badge.classList.toggle(
                'error',
                !activo && ['completado_con_errores', 'error'].includes(estado)
            );
            document.getElementById('eliminacion-mensaje').textContent =
                progreso.mensaje || (activo ? 'Eliminando estados...' : 'No hay una eliminación activa.');
            document.getElementById('eliminacion-procesadas').textContent = `${procesadas} de ${total}`;
            document.getElementById('eliminacion-grupo').textContent =
                `${Number(progreso.grupoActual) || 0} de ${Number(progreso.totalGrupos) || 0}`;
            document.getElementById('eliminacion-proximo').textContent =
                Number(progreso.proximoGrupoSegundos) > 0
                    ? formatearTiempo(Number(progreso.proximoGrupoSegundos))
                    : '--';
            document.getElementById('eliminacion-barra').style.width = `${porcentaje}%`;
        }

        function aplicarVistaEstadosActivos() {
            const vistasValidas = new Set(['small', 'medium', 'large', 'list']);
            if (!vistasValidas.has(vistaEstadosActivos)) {
                vistaEstadosActivos = 'medium';
            }

            const contenedor = document.getElementById('lista-estados-activos');
            if (contenedor) {
                contenedor.classList.remove(
                    'view-small',
                    'view-medium',
                    'view-large',
                    'view-list'
                );
                contenedor.classList.add(`view-${vistaEstadosActivos}`);
            }

            document.querySelectorAll('[data-active-status-view]').forEach(boton => {
                const activa = boton.dataset.activeStatusView === vistaEstadosActivos;
                boton.classList.toggle('active', activa);
                boton.setAttribute('aria-pressed', String(activa));
            });
        }

        function obtenerPublicacionVisualizacionesActiva() {
            return (cacheEstadosActivos.publicaciones || []).find(
                publicacion => String(publicacion.id) ===
                    String(publicacionVisualizacionesId)
            ) || null;
        }

        function actualizarDireccionVisualizaciones() {
            const boton = document.getElementById('btn-direccion-visualizaciones');
            const texto = document.getElementById('texto-direccion-visualizaciones');
            const ascendente = direccionVisualizacionesEstado === 'asc';
            const alfabetico = ordenVisualizacionesEstado === 'alfabetico';

            boton.dataset.direction = direccionVisualizacionesEstado;
            texto.textContent = alfabetico
                ? (ascendente ? 'A → Z' : 'Z → A')
                : (ascendente ? '0 → 9' : '9 → 0');
            boton.title = ascendente
                ? 'Cambiar a orden de mayor a menor'
                : 'Cambiar a orden de menor a mayor';
            boton.setAttribute('aria-label', boton.title);

            document.querySelectorAll('[data-status-views-sort]').forEach(item => {
                const activo = item.dataset.statusViewsSort ===
                    ordenVisualizacionesEstado;
                item.classList.toggle('active', activo);
                item.setAttribute('aria-pressed', String(activo));
            });
        }

        function renderizarLineasVisualizacionesEstado() {
            const publicacion = obtenerPublicacionVisualizacionesActiva();
            const contenedor = document.getElementById(
                'lista-visualizaciones-lineas'
            );
            if (!publicacion) {
                contenedor.innerHTML = '<div class="status-views-empty">El estado ya no está activo.</div>';
                return;
            }

            const busqueda = document
                .getElementById('buscar-visualizaciones-lineas')
                .value
                .trim()
                .toLocaleLowerCase('es');
            const lineas = (Array.isArray(publicacion.lineas)
                ? publicacion.lineas
                : [])
                .filter(linea => (
                    !busqueda ||
                    String(linea.nombre || '').toLocaleLowerCase('es').includes(busqueda) ||
                    String(linea.numero || '').toLocaleLowerCase('es').includes(busqueda)
                ))
                .sort((a, b) => {
                    let resultado;
                    if (ordenVisualizacionesEstado === 'visualizaciones') {
                        resultado = (Number(a.visualizaciones) || 0) -
                            (Number(b.visualizaciones) || 0);
                        if (resultado === 0) {
                            resultado = String(a.nombre || '').localeCompare(
                                String(b.nombre || ''),
                                'es',
                                { numeric: true, sensitivity: 'base' }
                            );
                        }
                    } else {
                        resultado = String(a.nombre || '').localeCompare(
                            String(b.nombre || ''),
                            'es',
                            { numeric: true, sensitivity: 'base' }
                        );
                    }
                    return direccionVisualizacionesEstado === 'desc'
                        ? -resultado
                        : resultado;
                });

            contenedor.innerHTML = lineas.length
                ? lineas.map((linea, indice) => {
                    const vistas = Math.max(
                        0,
                        Number(linea.visualizaciones) || 0
                    );
                    return `
                        <div class="status-view-line">
                            <span class="status-view-line-rank">${indice + 1}</span>
                            <span class="status-view-line-copy">
                                <strong>${escaparHTML(linea.nombre || 'Línea sin nombre')}</strong>
                                <span>${escaparHTML(linea.numero || 'Número no disponible')}</span>
                            </span>
                            <span class="status-view-line-count" title="${vistas.toLocaleString('es')} visualizaciones">
                                ${iconoSVG('eye')}
                                <span>${vistas.toLocaleString('es')}</span>
                            </span>
                        </div>
                    `;
                }).join('')
                : '<div class="status-views-empty">No se encontraron líneas con esa búsqueda.</div>';

            document.getElementById('resultado-visualizaciones-lineas').textContent =
                `${lineas.length} de ${publicacion.lineas?.length || 0} línea(s)`;
            actualizarDireccionVisualizaciones();
        }

        function abrirVisualizacionesEstado(id) {
            const publicacion = (cacheEstadosActivos.publicaciones || []).find(
                item => String(item.id) === String(id)
            );
            if (!publicacion) return;

            publicacionVisualizacionesId = publicacion.id;
            ordenVisualizacionesEstado = 'alfabetico';
            direccionVisualizacionesEstado = 'asc';
            document.getElementById('buscar-visualizaciones-lineas').value = '';

            const total = Math.max(0, Number(publicacion.visualizaciones) || 0);
            document.getElementById('visualizaciones-estado-total').textContent =
                `${total.toLocaleString('es')} visualización${total === 1 ? '' : 'es'}`;

            const fecha = formatearFechaCompacta(
                publicacion.fechaInicio,
                'Fecha no disponible'
            );
            const titulo = publicacion.texto
                ? String(publicacion.texto).slice(0, 100)
                : `Publicación del ${fecha}`;
            document.getElementById('visualizaciones-estado-nombre').textContent = titulo;
            document.getElementById('visualizaciones-estado-fecha').textContent = fecha;

            const imagen = document.getElementById('visualizaciones-estado-imagen');
            const vacia = document.getElementById(
                'visualizaciones-estado-imagen-vacia'
            );
            const mostrarVacia = () => {
                imagen.style.display = 'none';
                vacia.style.display = 'grid';
            };
            const url = String(publicacion.imagenUrl || '').trim();
            imagen.onload = () => {
                imagen.style.display = 'block';
                vacia.style.display = 'none';
            };
            imagen.onerror = mostrarVacia;
            if (url) {
                imagen.style.display = 'block';
                vacia.style.display = 'none';
                imagen.src = url;
            } else {
                imagen.removeAttribute('src');
                mostrarVacia();
            }

            renderizarLineasVisualizacionesEstado();
            abrirModal('modal-visualizaciones-estado');
            requestAnimationFrame(() => {
                document.getElementById('buscar-visualizaciones-lineas')
                    .focus({ preventScroll: true });
            });
        }

        function cerrarVisualizacionesEstado() {
            publicacionVisualizacionesId = null;
            cerrarModal('modal-visualizaciones-estado');
        }

        function renderizarEstadosActivos(data = {}) {
            const resumen = data.resumen || {};
            const publicaciones = Array.isArray(data.publicaciones) ? data.publicaciones : [];
            const contenedor = document.getElementById('lista-estados-activos');

            cacheEstadosActivos = { resumen, publicaciones };

            aplicarVistaEstadosActivos();

            document.getElementById('activos-grupos').textContent = Number(resumen.gruposActivos) || 0;
            document.getElementById('activos-lineas').textContent = Number(resumen.estadosEnLineas) || 0;
            document.getElementById('activos-errores').textContent = Number(resumen.conErrores) || 0;
            document.getElementById('activos-eliminados').textContent = Number(resumen.eliminadosAhora) || 0;
            document.getElementById('nav-active-count').textContent =
                Number(resumen.gruposActivos) || publicaciones.length;
            renderizarProgresoEliminacion(data.progreso || {});

            if (!publicaciones.length) {
                const contenidoVacio = htmlEstadosActivosVacios();
                if (contenedor.__contenidoRenderizado !== contenidoVacio) {
                    contenedor.innerHTML = contenidoVacio;
                    contenedor.__contenidoRenderizado = contenidoVacio;
                }
                if (document.getElementById('modal-visualizaciones-estado').classList.contains('open')) {
                    cerrarVisualizacionesEstado();
                }
                return;
            }

            const contenidoPublicaciones = publicaciones.map(publicacion => {
                const lineas = Array.isArray(publicacion.lineas) ? publicacion.lineas : [];
                const imagen = String(publicacion.imagenUrl || '').trim();
                const fecha = formatearFechaCompacta(publicacion.fechaInicio, 'Fecha no disponible');
                const expiracion = formatearFechaCompacta(publicacion.expiraEn, 'Sin vencimiento informado');
                const titulo = publicacion.texto
                    ? String(publicacion.texto).slice(0, 72)
                    : `Publicación del ${fecha}`;

                const visualizaciones = Math.max(
                    0,
                    Number(publicacion.visualizaciones) || 0
                );

                const lineasHTML = lineas.length
                    ? lineas.map(linea => {
                        const conError = Boolean(linea.error) || ['error', 'fallido'].includes(String(linea.estado || '').toLowerCase());
                        const estadoId = String(linea.estadoId || '').trim();
                        const estadoIdCorto = estadoId.length > 16
                            ? `${estadoId.slice(0, 8)}…${estadoId.slice(-4)}`
                            : estadoId;
                        return `
                            <div class="active-group-line" title="${escaparHTML(linea.error || '')}">
                                <span class="active-group-line-main">
                                    <strong>${escaparHTML(linea.nombre || 'Línea sin nombre')}</strong>
                                    <span class="active-line-details">
                                        <span>${escaparHTML(linea.numero || 'Número no disponible')}</span>
                                        ${estadoId ? `<span class="active-line-id" title="ID del estado: ${escaparHTML(estadoId)}">ID ${escaparHTML(estadoIdCorto)}</span>` : ''}
                                    </span>
                                </span>
                                <span class="active-line-status ${conError ? 'error' : ''}">${conError ? 'Error' : escaparHTML(linea.estado || 'Activo')}</span>
                            </div>
                        `;
                    }).join('')
                    : '<div class="active-group-line"><span class="active-group-line-main"><strong>Sin líneas registradas</strong></span></div>';

                return `
                    <article
                        class="active-group-card"
                        data-active-publication-id="${escaparHTML(publicacion.id)}"
                        role="button"
                        tabindex="0"
                        aria-label="Ver visualizaciones de ${escaparHTML(titulo)}"
                    >
                        <div class="active-group-media">
                            ${imagen
                                ? `<img src="${escaparHTML(imagen)}" alt="Vista previa de ${escaparHTML(titulo)}" loading="lazy">`
                                : `<span class="active-group-media-placeholder">${iconoSVG('image')}</span>`}
                            <span class="active-group-views" title="Visualizaciones totales">
                                ${iconoSVG('eye')}
                                <span>${visualizaciones.toLocaleString('es')}</span>
                            </span>
                            <span class="active-group-count">${iconoSVG('layers')}<span>${lineas.length} estado(s)</span></span>
                        </div>
                        <div class="active-group-body">
                            <div class="active-group-heading">
                                <div>
                                    <h3>${escaparHTML(titulo)}</h3>
                                    <p>${escaparHTML(fecha)}</p>
                                </div>
                                <span class="active-group-expiry">${escaparHTML(expiracion)}</span>
                            </div>
                            ${publicacion.texto ? `<p class="active-group-text">${escaparHTML(publicacion.texto)}</p>` : ''}
                            <div class="active-group-lines">${lineasHTML}</div>
                            <div class="active-group-actions">
                                <button type="button" class="small-danger btn-eliminar-estado-activo" data-id="${escaparHTML(publicacion.id)}">
                                    ${iconoSVG('trash')}
                                    <span>Eliminar grupo</span>
                                </button>
                            </div>
                        </div>
                    </article>
                `;
            }).join('');
            if (contenedor.__contenidoRenderizado !== contenidoPublicaciones) {
                contenedor.innerHTML = contenidoPublicaciones;
                contenedor.__contenidoRenderizado = contenidoPublicaciones;
            }

            const modalVistas = document.getElementById(
                'modal-visualizaciones-estado'
            );
            if (modalVistas.classList.contains('open')) {
                const activa = obtenerPublicacionVisualizacionesActiva();
                if (!activa) {
                    cerrarVisualizacionesEstado();
                } else {
                    const total = Math.max(
                        0,
                        Number(activa.visualizaciones) || 0
                    );
                    document.getElementById(
                        'visualizaciones-estado-total'
                    ).textContent = `${total.toLocaleString('es')} visualización${total === 1 ? '' : 'es'}`;
                    renderizarLineasVisualizacionesEstado();
                }
            }
        }

        async function actualizarEstadosActivos(silencioso = false) {
            if (cargandoEstadosActivos) return;
            cargandoEstadosActivos = true;
            const boton = document.getElementById('btn-actualizar-activos');
            const contenidoOriginal = boton.innerHTML;

            if (!silencioso) {
                boton.disabled = true;
                boton.innerHTML = `${iconoSVG('loader', 'spin')}<span>Actualizando...</span>`;
            }

            try {
                const respuesta = await fetch('/estados-activos', { cache: 'no-store' });
                const data = await leerRespuesta(respuesta);
                if (!respuesta.ok) {
                    throw new Error(data.error || data.mensaje || 'No se pudieron cargar los estados activos.');
                }

                renderizarEstadosActivos(data);
            } catch (error) {
                console.error('Error consultando estados activos:', error);
                if (!silencioso) toast(error.message, 'error');
            } finally {
                cargandoEstadosActivos = false;

                if (!silencioso) {
                    boton.disabled = false;
                    boton.innerHTML = contenidoOriginal;
                }
            }
        }

        async function eliminarEstadoActivo(id) {
            if (!id) return;
            const confirmado = await solicitarConfirmacion({
                titulo: 'Eliminar grupo de estados',
                mensaje: 'Se eliminarán los estados de todas las líneas incluidas en este grupo. Esta acción no se puede deshacer.',
                textoConfirmar: 'Eliminar grupo',
                icono: 'trash'
            });
            if (!confirmado) return;

            try {
                const respuesta = await fetch(`/estados-activos/${encodeURIComponent(id)}`, {
                    method: 'DELETE'
                });
                const data = await leerRespuesta(respuesta);
                if (!respuesta.ok) {
                    throw new Error(data.error || data.mensaje || 'No se pudo iniciar la eliminación.');
                }

                toast(data.mensaje || 'Eliminación iniciada.', 'success');
                actualizarEstadosActivos(true);
            } catch (error) {
                toast(error.message, 'error');
            }
        }

        document.getElementById('cerrar-modal-visualizaciones').onclick = () => {
            cerrarVisualizacionesEstado();
        };

        document.getElementById('modal-visualizaciones-estado')
            .addEventListener('click', evento => {
                if (evento.target.id === 'modal-visualizaciones-estado') {
                    cerrarVisualizacionesEstado();
                }
            });

        document.getElementById('buscar-visualizaciones-lineas')
            .addEventListener('input', renderizarLineasVisualizacionesEstado);

        document.querySelectorAll('[data-status-views-sort]').forEach(boton => {
            boton.addEventListener('click', () => {
                ordenVisualizacionesEstado = boton.dataset.statusViewsSort;
                renderizarLineasVisualizacionesEstado();
            });
        });

        document.getElementById('btn-direccion-visualizaciones').onclick = () => {
            direccionVisualizacionesEstado =
                direccionVisualizacionesEstado === 'asc' ? 'desc' : 'asc';
            renderizarLineasVisualizacionesEstado();
        };

        document.addEventListener('keydown', evento => {
            if (evento.key !== 'Escape') return;
            const modal = document.getElementById('modal-visualizaciones-estado');
            if (!modal.classList.contains('open')) return;
            if (document.getElementById('modal-confirmacion').classList.contains('open')) return;

            evento.preventDefault();
            cerrarVisualizacionesEstado();
        });

        async function manejarClickLineasConectadas(evento) {
            const botonHabilitar = evento.target.closest('.btn-habilitar-publicaciones');
            if (botonHabilitar) {
                const id = botonHabilitar.dataset.id;
                const confirmado = await solicitarConfirmacion({
                    titulo: 'Habilitar publicaciones',
                    mensaje: 'Confirmá que revisaste la línea y que su conexión funciona correctamente antes de volver a publicar.',
                    textoConfirmar: 'Habilitar línea',
                    tono: 'primary',
                    icono: 'check-circle'
                });
                if (!confirmado) return;

                const contenidoOriginal = botonHabilitar.innerHTML;
                botonHabilitar.disabled = true;
                botonHabilitar.innerHTML = `${iconoSVG('loader', 'spin')}<span>Habilitando...</span>`;

                try {
                    const respuesta = await fetch(
                        `/lineas/${encodeURIComponent(id)}/habilitar-publicaciones`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ confirmar: true })
                        }
                    );
                    const data = await exigirRespuesta(
                        respuesta,
                        'No se pudieron habilitar las publicaciones de esta línea.'
                    );
                    toast(data.mensaje || 'Línea habilitada para publicar.', 'success');
                    actualizarLineas();
                } catch (error) {
                    botonHabilitar.disabled = false;
                    botonHabilitar.innerHTML = contenidoOriginal;
                    toast(error.message, tipoToastErrorHTTP(error));
                }
                return;
            }

            const botonEditar = evento.target.closest('.btn-editar-linea');
            if (botonEditar) {
                abrirEditorLinea(botonEditar.dataset.id);
                return;
            }

            const botonEtiquetas = evento.target.closest('.btn-abrir-etiquetas');
            if (botonEtiquetas) {
                evento.stopPropagation();
                const id = botonEtiquetas.dataset.id;
                selectorEtiquetaAbiertoId = selectorEtiquetaAbiertoId === id ? null : id;

                document.querySelectorAll('.tag-picker').forEach(picker => {
                    const abierto = picker.dataset.id === selectorEtiquetaAbiertoId;
                    picker.classList.toggle('open', abierto);
                    picker.querySelector('.tag-picker-button')
                        ?.setAttribute('aria-expanded', String(abierto));
                });
                return;
            }

            const opcionEtiqueta = evento.target.closest('.tag-option');
            if (opcionEtiqueta) {
                evento.stopPropagation();
                const id = opcionEtiqueta.dataset.id;
                const etiqueta = opcionEtiqueta.dataset.etiqueta;
                opcionEtiqueta.disabled = true;

                try {
                    const respuesta = await fetch(`/lineas/${encodeURIComponent(id)}/etiqueta`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ etiqueta })
                    });
                    const data = await leerRespuesta(respuesta);
                    if (!respuesta.ok) {
                        throw new Error(data.error || 'No se pudo actualizar la etiqueta.');
                    }

                    selectorEtiquetaAbiertoId = null;
                    toast(data.mensaje || 'Etiqueta actualizada.', 'success');
                    actualizarLineas();
                } catch (error) {
                    opcionEtiqueta.disabled = false;
                    toast(error.message, 'error');
                }
                return;
            }

            const botonReconectar = evento.target.closest('.btn-reconectar');
            if (botonReconectar) {
                if (publicacionActivaActual) {
                    toast(
                        'Esperá a que termine la publicación o usá Alto total antes de reconectar.',
                        'warning'
                    );
                    actualizarAccionesPublicacion();
                    return;
                }

                const id = botonReconectar.dataset.id;
                const contenidoOriginal = botonReconectar.innerHTML;
                prepararAperturaQr(id);
                botonReconectar.disabled = true;
                botonReconectar.innerHTML = `${iconoSVG('loader', 'spin')}<span>Reconectando...</span>`;

                try {
                    const respuesta = await fetch(`/lineas/${encodeURIComponent(id)}/reconectar`, {
                        method: 'POST'
                    });
                    const data = await leerRespuesta(respuesta);
                    if (!respuesta.ok) {
                        throw new Error(data.error || 'No se pudo reconectar la línea.');
                    }

                    toast(data.mensaje || 'Reconexión iniciada.', 'success');
                    const tarjeta = botonReconectar.closest('.connected-line-card');
                    if (tarjeta) tarjeta.__contenidoRenderizado = null;
                    setTimeout(actualizarLineas, 700);
                } catch (error) {
                    if (lineaQrObjetivoId === String(id)) lineaQrObjetivoId = null;
                    botonReconectar.disabled = false;
                    botonReconectar.innerHTML = contenidoOriginal;
                    toast(error.message, 'error');
                }
                return;
            }

            const botonEliminar = evento.target.closest('.btn-eliminar');
            if (!botonEliminar) return;

            const id = botonEliminar.dataset.id;
            const confirmado = await solicitarConfirmacion({
                titulo: 'Eliminar línea',
                mensaje: 'La línea se quitará de ZeroOne y su sesión se cerrará. Para usarla otra vez tendrás que vincularla nuevamente.',
                textoConfirmar: 'Eliminar línea',
                icono: 'trash'
            });
            if (!confirmado) return;

            try {
                botonEliminar.disabled = true;
                const data = await eliminarLineaRemota(id);
                toast(data.mensaje || 'Línea eliminada.', 'success');
                actualizarLineas();
            } catch (error) {
                botonEliminar.disabled = false;
                toast(error.message, 'error');
            }
        }

