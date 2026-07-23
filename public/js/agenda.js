        function mostrarEstadoProgramacion(estado) {
            const estados = {
                programado: 'Programado',
                pausado: 'En pausa',
                en_cola: 'En cola',
                ejecutando: 'Publicando'
            };

            return estados[estado] || estado;
        }

        async function leerRespuesta(respuesta) {
            const contenido = await respuesta.text();

            try {
                return JSON.parse(contenido);
            } catch {
                return { mensaje: contenido };
            }
        }

        function crearClaveIdempotencia(accion) {
            const identificador = globalThis.crypto?.randomUUID?.() ||
                `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            return `zeroone-${accion}-${identificador}`;
        }

        function iniciarSolicitudIdempotente(claveAccion, boton) {
            if (solicitudesIdempotentesEnCurso.has(claveAccion)) return null;
            solicitudesIdempotentesEnCurso.add(claveAccion);
            if (boton) boton.disabled = true;
            actualizarAccionesPublicacion();
            return crearClaveIdempotencia(claveAccion.replace(/[^a-z0-9_-]+/gi, '-'));
        }

        function finalizarSolicitudIdempotente(claveAccion, boton) {
            solicitudesIdempotentesEnCurso.delete(claveAccion);
            if (boton) boton.disabled = false;
            actualizarAccionesPublicacion();
        }

        function crearErrorHTTP(respuesta, data, respaldo) {
            if (
                respuesta.status === 429 &&
                data?.codigo === 'MIDDLEWARE_ENFRIAMIENTO'
            ) {
                actualizarProteccionMiddleware(data.proteccionMiddleware);
            }
            if (
                respuesta.status === 409 &&
                data?.codigo === 'PUBLICACION_OCUPADA'
            ) {
                publicacionActivaActual = true;
                actualizarAccionesPublicacion();
            }

            const error = new Error(
                data?.error || data?.mensaje || respaldo || 'No se pudo completar la solicitud.'
            );
            error.httpStatus = respuesta.status;
            error.codigo = data?.codigo || null;
            error.data = data;
            return error;
        }

        async function exigirRespuesta(respuesta, respaldo) {
            const data = await leerRespuesta(respuesta);
            if (!respuesta.ok) throw crearErrorHTTP(respuesta, data, respaldo);
            return data;
        }

        function tipoToastErrorHTTP(error) {
            return [409, 429].includes(Number(error?.httpStatus))
                ? 'warning'
                : 'error';
        }

        function idCuentaAgenda(cuenta = {}) {
            return String(cuenta.id ?? cuenta.cuentaId ?? '').trim();
        }

        function nombreCuentaAgenda(cuenta = {}) {
            return String(
                cuenta.email ?? cuenta.correo ?? cuenta.nombre ?? cuenta.displayName ?? idCuentaAgenda(cuenta)
            ).trim() || 'Cuenta de Google';
        }

        function opcionesCuentasGoogle() {
            return Array.isArray(cuentasGoogleDisponibles)
                ? cuentasGoogleDisponibles
                : [];
        }

        function cuentaGoogleExiste(id = '') {
            const target = String(id || '').trim();
            if (!target) return false;
            return opcionesCuentasGoogle().some(
                cuenta => idCuentaAgenda(cuenta) === target
            );
        }

        function renderizarSelectorCuentaLinea() {
            const selector = document.getElementById('cuenta-linea');
            if (!selector) return;

            const cuentas = opcionesCuentasGoogle();
            const seleccionado = String(selector.value || '').trim();

            selector.innerHTML = `
                <option value="">Sin cuenta de Google</option>
                ${cuentas.map(cuenta => {
                    const id = idCuentaAgenda(cuenta);
                    const nombre = nombreCuentaAgenda(cuenta);
                    return `<option value="${escaparHTML(id)}">${escaparHTML(nombre)}</option>`;
                }).join('')}
                <option value="__gestionar_google__">+ ${cuentas.length ? 'Agregar otra cuenta' : 'Configurar cuenta de Google'}</option>
            `;
            if (cuentaGoogleExiste(seleccionado)) {
                selector.value = seleccionado;
            } else if (cuentas.length === 1) {
                selector.value = idCuentaAgenda(cuentas[0]);
            } else {
                selector.value = '';
            }
            selector.disabled = false;
            selector.removeAttribute('data-mensaje');
        }

        async function cargarCuentasGoogleParaLinea(force = false) {
            if (cuentasGoogleCargando) return opcionesCuentasGoogle();
            if (!force && cuentasGoogleDisponibles.length) {
                return opcionesCuentasGoogle();
            }

            cuentasGoogleCargando = true;
            try {
                const respuesta = await fetch('/agendamiento');
                const data = await leerRespuesta(respuesta);
                if (respuesta.ok && data && typeof data === 'object') {
                    cuentasGoogleDisponibles = Array.isArray(data.cuentas)
                        ? data.cuentas
                        : [];
                    renderizarSelectorCuentaLinea();
                    return cuentasGoogleDisponibles;
                }
                cuentasGoogleDisponibles = [];
                return [];
            } catch {
                cuentasGoogleDisponibles = [];
                return [];
            } finally {
                cuentasGoogleCargando = false;
            }
        }

        function normalizarHistorialAgenda(historial = {}) {
            const estados = new Set([
                'pendiente',
                'en_cola',
                'esperando_qr',
                'sincronizando',
                'lista',
                'parcial',
                'pausada'
            ]);
            const estado = estados.has(historial?.estado)
                ? historial.estado
                : 'pendiente';
            const numero = Number(historial?.progreso);
            const progreso = historial?.progreso === null ||
                historial?.progreso === undefined ||
                !Number.isFinite(numero)
                ? null
                : Math.min(100, Math.max(0, Math.round(numero)));

            return {
                ...historial,
                estado,
                progreso,
                indeterminado:
                    historial?.indeterminado === true ||
                    (
                        ['en_cola', 'esperando_qr', 'sincronizando'].includes(estado) &&
                        progreso === null
                    ),
                listoParaAgendar:
                    historial?.listoParaAgendar === true || estado === 'lista'
            };
        }

        function presentacionHistorialAgenda(historial = {}) {
            const datos = normalizarHistorialAgenda(historial);
            const presentaciones = {
                pendiente: {
                    titulo: 'Historial pendiente',
                    detalle:
                        'Todavía no se preparó el historial de esta línea.',
                    marca: '•'
                },
                en_cola: {
                    titulo: datos.posicionCola
                        ? `En cola · turno ${datos.posicionCola}`
                        : 'En cola',
                    detalle:
                        'Esperando mientras otra línea termina su sincronización.',
                    marca: '•'
                },
                esperando_qr: {
                    titulo: 'Esperando el QR',
                    detalle:
                        'Escaneá el QR para comenzar la sincronización exclusiva.',
                    marca: ''
                },
                sincronizando: {
                    titulo: 'Sincronizando historial',
                    detalle:
                        'WhatsApp está enviando y ZeroOne está procesando los datos.',
                    marca: ''
                },
                lista: {
                    titulo: 'Lista para agendar',
                    detalle:
                        'El historial recibido terminó de procesarse correctamente.',
                    marca: '✓'
                },
                parcial: {
                    titulo: 'Historial parcial',
                    detalle:
                        'Se conservaron los datos disponibles, pero WhatsApp no entregó el historial completo.',
                    marca: '!'
                },
                pausada: {
                    titulo: 'Sincronización pausada',
                    detalle:
                        'Podés volver a prepararla cuando la línea esté estable.',
                    marca: 'Ⅱ'
                }
            };
            const visual = presentaciones[datos.estado] || presentaciones.pendiente;
            return {
                ...datos,
                ...visual,
                detalle: String(datos.motivo || visual.detalle)
            };
        }

        function anilloHistorialAgendaHTML(historial = {}, grande = false) {
            const visual = presentacionHistorialAgenda(historial);
            const progreso = visual.progreso ?? 0;
            const indeterminado = visual.indeterminado
                ? ' indeterminate'
                : '';
            const descripcion = visual.progreso === null
                ? visual.titulo
                : `${visual.titulo}: ${visual.progreso}%`;
            return `
                <span
                    class="agenda-history-ring${grande ? ' large' : ''}${indeterminado}"
                    data-state="${escaparHTML(visual.estado)}"
                    style="--history-progress:${progreso}"
                    role="img"
                    aria-label="${escaparHTML(descripcion)}"
                    title="${escaparHTML(descripcion)}"
                >
                    <svg viewBox="0 0 36 36" aria-hidden="true">
                        <circle class="track" cx="18" cy="18" r="15.5" pathLength="100"></circle>
                        <circle class="value" cx="18" cy="18" r="15.5" pathLength="100"></circle>
                    </svg>
                    <span class="agenda-history-ring-mark">${escaparHTML(visual.marca)}</span>
                </span>
            `;
        }

        function lineaAgendaSeleccionada() {
            return cacheLineasAgendamiento.find(
                linea => String(linea.id) === String(agendaLineaId)
            ) || null;
        }

        function prefijoAgendaLinea(linea = {}) {
            const nombre = String(linea.nombre || '').trim();
            const explicito = nombre.match(/\bL\s*0*(\d+)\b/i);
            const coincidencia = nombre.match(/(\d+)(?!.*\d)/);
            const numero = explicito?.[1] || coincidencia?.[1] ||
                linea.ordenConexion || linea.ordenOriginal;
            return numero ? `L${numero}` : 'L—';
        }

        function cerrarPickerAgendamiento(picker) {
            if (!picker) return;
            picker.classList.remove('open');
            picker.querySelector('.agenda-picker-button')?.setAttribute('aria-expanded', 'false');
        }

        function cerrarSelectoresAgendamiento(excepto = null) {
            document.querySelectorAll('.agenda-picker').forEach(picker => {
                if (picker !== excepto) cerrarPickerAgendamiento(picker);
            });
        }

        function alternarPickerAgendamiento(picker) {
            if (!picker || picker.hidden) return;
            const abrir = !picker.classList.contains('open');
            cerrarSelectoresAgendamiento(picker);
            picker.classList.toggle('open', abrir);
            picker.querySelector('.agenda-picker-button')?.setAttribute('aria-expanded', String(abrir));
        }

        function renderizarSelectorLineasAgendamiento({ forzar = false } = {}) {
            const picker = document.getElementById('agenda-line-picker');
            const menu = document.getElementById('agenda-line-menu');
            const etiqueta = document.getElementById('agenda-line-label');
            if (!picker || !menu || !etiqueta) return;

            if (
                !agendaLineaId &&
                seccionActual === 'agendamiento' &&
                cacheLineasAgendamiento.length
            ) {
                agendaLineaId = String(cacheLineasAgendamiento[0].id);
            }

            const linea = lineaAgendaSeleccionada();
            etiqueta.textContent = linea
                ? `${linea.nombre}${linea.numero ? ` · ${linea.numero}` : ''}`
                : agendaLineaId
                    ? 'Línea no disponible'
                    : 'Seleccionar línea';
            document.getElementById('agenda-name-example').textContent =
                `${prefijoAgendaLinea(linea || {})} usuario 🟣`;

            const firma = JSON.stringify({
                seleccionada: String(agendaLineaId || ''),
                lineas: cacheLineasAgendamiento.map(item => [
                    String(item.id),
                    item.nombre || '',
                    item.numero || '',
                    item.ordenConexion || item.ordenOriginal || ''
                ])
            });
            const interactuando = picker.classList.contains('open') || picker.contains(document.activeElement);
            if (!forzar && (firma === agendaFirmaLineas || interactuando)) return;
            agendaFirmaLineas = firma;

            if (!cacheLineasAgendamiento.length) {
                menu.innerHTML = '<div class="agenda-empty" style="min-height:90px;padding:14px;">No hay líneas disponibles.</div>';
                return;
            }

            menu.innerHTML = cacheLineasAgendamiento.map(item => {
                const activa = String(item.id) === String(agendaLineaId);
                return `
                    <button
                        type="button"
                        class="agenda-picker-option ${activa ? 'active' : ''}"
                        data-agenda-linea-id="${escaparHTML(item.id)}"
                        role="option"
                        aria-selected="${activa}"
                    >
                        <span class="agenda-picker-avatar">${escaparHTML(obtenerAvatarLinea(item))}</span>
                        <span class="agenda-picker-option-copy">
                            <strong>${escaparHTML(item.nombre || 'Línea sin nombre')}</strong>
                            <small>${escaparHTML(
                                `${item.numero || 'Número no disponible'} · Chats recientes`
                            )}</small>
                        </span>
                        ${activa ? iconoSVG('check') : '<span></span>'}
                    </button>
                `;
            }).join('');
        }

        function renderizarSelectorCuentasAgendamiento(cuentas = [], { forzar = false } = {}) {
            const picker = document.getElementById('agenda-account-picker');
            const boton = document.getElementById('agenda-account-button');
            const menu = document.getElementById('agenda-account-menu');
            const etiqueta = document.getElementById('agenda-account-label');
            if (!picker || !boton || !menu || !etiqueta) return;

            const lista = Array.isArray(cuentas) ? cuentas : [];
            const seleccionada = lista.find(cuenta => idCuentaAgenda(cuenta) === String(agendaCuentaId));
            picker.hidden = !lista.length;
            boton.disabled = !agendaLineaId;
            etiqueta.textContent = seleccionada
                ? nombreCuentaAgenda(seleccionada)
                : 'Seleccionar cuenta';

            const firma = JSON.stringify({
                seleccionada: String(agendaCuentaId || ''),
                cuentas: lista.map(cuenta => [idCuentaAgenda(cuenta), nombreCuentaAgenda(cuenta)])
            });
            const interactuando = picker.classList.contains('open') || picker.contains(document.activeElement);
            if (!forzar && (firma === agendaFirmaCuentas || interactuando)) return;
            agendaFirmaCuentas = firma;

            menu.innerHTML = lista.map(cuenta => {
                const id = idCuentaAgenda(cuenta);
                const nombre = nombreCuentaAgenda(cuenta);
                const activa = id === String(agendaCuentaId);
                return `
                    <button
                        type="button"
                        class="agenda-picker-option ${activa ? 'active' : ''}"
                        data-agenda-cuenta-id="${escaparHTML(id)}"
                        role="option"
                        aria-selected="${activa}"
                    >
                        <span class="agenda-picker-avatar">G</span>
                        <span class="agenda-picker-option-copy">
                            <strong>${escaparHTML(nombre)}</strong>
                            <small>Google Contacts</small>
                        </span>
                        ${activa ? iconoSVG('check') : '<span></span>'}
                    </button>
                `;
            }).join('');
        }

        function numeroAgenda(valor) {
            const numero = Number(valor);
            return Number.isFinite(numero) && numero > 0 ? Math.round(numero) : 0;
        }

        function porcentajeAgendaIA(valor) {
            const numero = Number(valor);
            if (!Number.isFinite(numero)) return 0;
            return Math.min(100, Math.max(0, numero));
        }

        function porcentajeEstimacionAgendaIA(valor) {
            const numero = Number(valor);
            if (!Number.isFinite(numero)) return 0;
            return Math.round(porcentajeAgendaIA(numero <= 1 ? numero * 100 : numero));
        }

        function formatearBytesAgendaIA(valor) {
            const bytes = Number(valor);
            if (!Number.isFinite(bytes) || bytes <= 0) return '';
            const unidades = ['B', 'KB', 'MB', 'GB'];
            const indice = Math.min(
                unidades.length - 1,
                Math.floor(Math.log(bytes) / Math.log(1000))
            );
            const cantidad = bytes / (1000 ** indice);
            return `${cantidad.toLocaleString('es', {
                maximumFractionDigits: indice >= 3 ? 2 : 1
            })} ${unidades[indice]}`;
        }

        function estadoModeloAgendaIA(modelo = {}) {
            return String(modelo.estado || (modelo.instalada ? 'lista' : 'no_instalada'))
                .trim()
                .toLocaleLowerCase('es');
        }

        function modeloAgendaIADescargando(modelo = {}) {
            return [
                'descargando',
                'preparando',
                'preparando_descarga',
                'verificando',
                'instalando'
            ].includes(estadoModeloAgendaIA(modelo));
        }

        function modeloAgendaIAEnTransicion(modelo = {}) {
            return modeloAgendaIADescargando(modelo) || [
                'iniciando',
                'cargando',
                'eliminando',
                'deteniendo'
            ].includes(estadoModeloAgendaIA(modelo));
        }

        function renderizarRevisionesAgendaIA(revisiones = [], {
            bloqueadas = agendaEstado?.proceso?.activo === true ||
                agendaEstado?.ia?.analisis?.activo === true
        } = {}) {
            const contenedor = document.getElementById('agenda-ai-review-list');
            const contador = document.getElementById('agenda-ai-review-count');
            if (!contenedor || !contador) return;

            const lista = (Array.isArray(revisiones) ? revisiones : [])
                .filter(item => item && item.id && item.usuario);
            const totalPendientes = Math.max(
                lista.length,
                numeroAgenda(agendaEstado?.ia?.totalRevisiones)
            );
            contador.textContent = totalPendientes > lista.length
                ? `${lista.length} de ${totalPendientes} pendientes`
                : `${lista.length} pendiente${lista.length === 1 ? '' : 's'}`;

            if (!lista.length) {
                contenedor.innerHTML = '<div class="agenda-ai-empty">No hay sugerencias pendientes para esta línea.</div>';
                return;
            }

            contenedor.innerHTML = lista.map(item => {
                const id = String(item.id || '').trim();
                const telefono = String(item.telefono || '').trim();
                const usuario = String(item.usuario || '').trim();
                const tiposEvidencia = {
                    PLANTILLA_CRM: 'Mensaje automático del CRM',
                    CONTACTO_WHATSAPP: 'Contacto guardado en WhatsApp'
                };
                const tipoEvidencia = String(
                    item.tipoEvidencia || 'Contexto reciente'
                );
                const evidencia = tiposEvidencia[tipoEvidencia] ||
                    tipoEvidencia.replaceAll('_', ' ').toLocaleLowerCase('es');
                const fechaEvidencia = item.evidencias?.[0]?.timestampMs ||
                    item.detectadaEn;
                const fecha = fechaEvidencia
                    ? formatearFechaCompacta(fechaEvidencia, '')
                    : '';
                const estimacion = porcentajeEstimacionAgendaIA(item.confianza);
                const procesando = bloqueadas || agendaRevisionesIAEnCurso.has(id);
                const pendienteResolucion = item.pendienteResolucion === true;
                const bloquearConfirmacion = procesando || pendienteResolucion;
                return `
                    <div class="agenda-ai-review-row" data-agenda-ai-review-id="${escaparHTML(id)}">
                        <span class="agenda-ai-review-person">
                            <strong>${telefono ? escaparHTML(`+${telefono.replace(/^\+/, '')}`) : 'Número pendiente'}</strong>
                            <span>${escaparHTML(evidencia)} · estimación ${estimacion}%${fecha ? ` · ${escaparHTML(fecha)}` : ''}</span>
                            ${pendienteResolucion ? '<span>Reconectá la línea para resolver el número antes de aprobar.</span>' : ''}
                        </span>
                        <label class="agenda-ai-review-editor">
                            <input
                                type="text"
                                value="${escaparHTML(usuario)}"
                                maxlength="80"
                                autocomplete="off"
                                aria-label="Usuario sugerido para ${escaparHTML(telefono || 'este contacto')}"
                                ${bloquearConfirmacion ? 'disabled' : ''}
                            >
                            <span class="agenda-ai-estimate" title="Estimación del modelo">${estimacion}%</span>
                        </label>
                        <span class="agenda-ai-review-actions">
                            <button type="button" class="secondary-button approve" data-agenda-ai-review-action="aprobar" title="Aprobar sugerencia" aria-label="Aprobar sugerencia" ${bloquearConfirmacion ? 'disabled' : ''}>
                                ${iconoSVG('check')}
                            </button>
                            <button type="button" class="secondary-button edit" data-agenda-ai-review-action="editar" title="Guardar corrección" aria-label="Guardar corrección" ${bloquearConfirmacion ? 'disabled' : ''}>
                                ${iconoSVG('edit')}
                            </button>
                            <button type="button" class="secondary-button reject" data-agenda-ai-review-action="rechazar" title="Rechazar sugerencia" aria-label="Rechazar sugerencia" ${procesando ? 'disabled' : ''}>
                                ${iconoSVG('x')}
                            </button>
                        </span>
                    </div>
                `;
            }).join('');
        }

        function renderizarIAAgendamiento(ia = {}) {
            const datos = ia && typeof ia === 'object' ? ia : {};
            const modelo = datos.modelo && typeof datos.modelo === 'object'
                ? datos.modelo
                : {};
            const detalleModelo = modelo.modelo && typeof modelo.modelo === 'object'
                ? modelo.modelo
                : {};
            const analisis = datos.analisis && typeof datos.analisis === 'object'
                ? datos.analisis
                : null;
            const estado = estadoModeloAgendaIA(modelo);
            const instalada = modelo.instalada === true;
            const descargando = modeloAgendaIADescargando(modelo);
            const pausada = ['pausada', 'descarga_pausada'].includes(estado);
            const errorModelo = Boolean(modelo.error) || estado === 'error';
            const ejecutando = modelo.ejecutando === true;
            const analisisActivo = analisis?.activo === true;
            const procesoAgendaActivo = agendaEstado?.proceso?.activo === true;

            const badge = document.getElementById('agenda-ai-state');
            const presentaciones = errorModelo
                ? { texto: 'Requiere atención', clase: 'error' }
                : instalada
                    ? analisisActivo
                    ? { texto: 'Analizando', clase: 'active' }
                    : ejecutando
                        ? { texto: 'Motor local listo', clase: 'active' }
                    : { texto: 'Lista en este equipo', clase: 'ready' }
                : descargando
                    ? { texto: estado === 'verificando' ? 'Verificando' : 'Descargando', clase: 'active' }
                    : pausada
                        ? { texto: 'Descarga pausada', clase: 'warning' }
                        : { texto: 'No instalada', clase: '' };
            badge.className = `agenda-ai-state${presentaciones.clase ? ` ${presentaciones.clase}` : ''}`;
            badge.textContent = presentaciones.texto;

            const nombreModelo = String(detalleModelo.nombre || 'Qwen3 1.7B · Q4_K_M').trim();
            const bytesModelo = formatearBytesAgendaIA(detalleModelo.bytes) || '1,28 GB';
            const bytesDescargaTotal = formatearBytesAgendaIA(modelo.descargaBytes) || '1,33 GB';
            const licencia = String(detalleModelo.licencia || 'Apache 2.0')
                .trim()
                .replace(/^Apache-2\.0$/i, 'Apache 2.0');
            document.getElementById('agenda-ai-model-name').textContent = nombreModelo;
            document.getElementById('agenda-ai-model-detail').textContent =
                `Local y privado · modelo ${bytesModelo} · descarga total aproximada ${bytesDescargaTotal} · ${licencia}`;

            const botonDescargar = document.getElementById('btn-agenda-ai-download');
            const botonPausar = document.getElementById('btn-agenda-ai-pause');
            const botonEliminar = document.getElementById('btn-agenda-ai-delete');
            botonDescargar.hidden = (instalada && !errorModelo) || descargando;
            botonDescargar.disabled = agendaOperacionIA;
            botonDescargar.querySelector('span').textContent = pausada
                ? 'Continuar descarga'
                : errorModelo
                    ? 'Reinstalar IA'
                    : 'Descargar IA';
            botonPausar.hidden = !descargando;
            botonPausar.disabled = agendaOperacionIA || estado === 'verificando';
            botonEliminar.hidden = descargando || (!instalada && !pausada && porcentajeAgendaIA(modelo.porcentaje) <= 0);
            botonEliminar.disabled = agendaOperacionIA || analisisActivo;

            const progresoDescarga = document.getElementById('agenda-ai-download-progress');
            const porcentajeDescarga = porcentajeAgendaIA(modelo.porcentaje);
            const mostrarDescarga = descargando || pausada || errorModelo ||
                (!instalada && porcentajeDescarga > 0);
            progresoDescarga.hidden = !mostrarDescarga;
            const barraDescarga = document.getElementById('agenda-ai-download-bar');
            barraDescarga.style.width = `${porcentajeDescarga}%`;
            barraDescarga.classList.toggle('indeterminate', descargando && porcentajeDescarga <= 0);
            document.getElementById('agenda-ai-download-percent').textContent = `${Math.round(porcentajeDescarga)}%`;
            document.getElementById('agenda-ai-download-message').textContent = String(
                modelo.error || modelo.detalle || modelo.mensaje || (pausada
                    ? 'Descarga pausada. Podés continuarla sin empezar de cero.'
                    : 'Descargando el modelo local…')
            );

            const botonAnalizar = document.getElementById('btn-agenda-ai-analyze');
            const botonDetener = document.getElementById('btn-agenda-ai-stop');
            botonAnalizar.disabled =
                agendaOperacionIA || !agendaLineaId || !instalada || analisisActivo ||
                procesoAgendaActivo || modeloAgendaIAEnTransicion(modelo);
            botonDetener.disabled = agendaOperacionIA || !agendaLineaId || !analisisActivo;

            const panelAnalisis = document.getElementById('agenda-ai-analysis-progress');
            const totalVentanas = numeroAgenda(analisis?.totalVentanas);
            const procesadas = numeroAgenda(analisis?.procesadas);
            const totalMensajes = numeroAgenda(analisis?.totalMensajes);
            const mensajesDisponibles = numeroAgenda(
                analisis?.mensajesDisponibles
            );
            const mensajesPendientes = numeroAgenda(
                analisis?.mensajesPendientes
            );
            const mensajesEnCuarentena = numeroAgenda(
                analisis?.mensajesEnCuarentena
            );
            const tieneResultado = Boolean(analisis);
            panelAnalisis.hidden = !tieneResultado;
            const porcentajeAnalisis = totalVentanas
                ? porcentajeAgendaIA((procesadas / totalVentanas) * 100)
                : 0;
            const barraAnalisis = document.getElementById('agenda-ai-analysis-bar');
            barraAnalisis.style.width = `${porcentajeAnalisis}%`;
            barraAnalisis.classList.toggle('indeterminate', analisisActivo && totalVentanas <= 0);
            document.getElementById('agenda-ai-analysis-count').textContent = totalVentanas
                ? `${procesadas} de ${totalVentanas}`
                : mensajesDisponibles > totalMensajes
                    ? `${totalMensajes} de ${mensajesDisponibles} mensajes`
                    : `${totalMensajes} mensajes`;
            document.getElementById('agenda-ai-analysis-message').textContent = String(
                analisis?.error || (analisisActivo
                    ? analisis?.estado === 'iniciando_modelo'
                        ? 'Iniciando el modelo local. En el primer uso puede tardar hasta dos minutos…'
                        : 'La IA está revisando los bloques recientes de esta línea…'
                    : analisis?.estado === 'completado' && mensajesPendientes > 0
                        ? `Tanda finalizada. Quedan ${mensajesPendientes} mensajes para la próxima tanda.`
                        : analisis?.estado === 'en_cuarentena'
                            ? `${mensajesEnCuarentena} mensajes están en cuarentena temporal; los contextos nuevos podrán analizarse ahora.`
                        : analisis?.estado
                            ? `Análisis ${String(analisis.estado).replaceAll('_', ' ')}.`
                        : 'Último análisis finalizado.')
            );
            document.getElementById('agenda-ai-analysis-approved').textContent =
                numeroAgenda(analisis?.aprobadas);
            document.getElementById('agenda-ai-analysis-review').textContent =
                numeroAgenda(analisis?.revisiones);
            document.getElementById('agenda-ai-analysis-discarded').textContent =
                numeroAgenda(analisis?.descartadas);
            document.getElementById('agenda-ai-analysis-errors').textContent =
                numeroAgenda(analisis?.errores);

            renderizarRevisionesAgendaIA(datos.revisiones, {
                bloqueadas: analisisActivo || procesoAgendaActivo
            });
            return { analisisActivo, modeloActivo: descargando || ejecutando };
        }

        function describirFuenteAgenda(fuente) {
            const etiquetas = {
                mensaje: 'Usuario detectado',
                plantilla: 'Usuario detectado',
                vio_estado: 'Vio tu estado',
                vista_estado: 'Vio tu estado',
                publico_estado: 'Publicó un estado',
                publicacion_estado: 'Publicó un estado'
            };
            return etiquetas[fuente] || String(fuente || '').replaceAll('_', ' ');
        }

        function estadoVisualCandidatoAgenda(candidato = {}) {
            const estado = String(candidato.estado || 'pendiente').toLocaleLowerCase('es');
            if (['agendado', 'sincronizado', 'actualizado', 'completado'].includes(estado)) {
                return { clase: 'done', texto: 'Agendado' };
            }
            if (['error', 'fallido', 'revision', 'requiere_revision', 'duplicado'].includes(estado)) {
                return {
                    clase: 'error',
                    texto: estado.includes('revision') || estado === 'duplicado' ? 'Revisar' : 'Error'
                };
            }
            if (['procesando', 'agendando'].includes(estado)) {
                return { clase: '', texto: 'Agendando…' };
            }
            if (estado === 'sin_usuario') {
                return {
                    clase: '',
                    texto: candidato.temporal ? 'Opcional' : 'Sin usuario'
                };
            }
            if (estado === 'omitido') return { clase: 'error', texto: 'Omitido' };
            return { clase: '', texto: 'Pendiente' };
        }

        function renderizarCandidatosAgendamiento(candidatos = []) {
            const contenedor = document.getElementById('agenda-contact-list');
            if (!contenedor) return;
            const lista = Array.isArray(candidatos) ? candidatos : [];

            if (!lista.length) {
                const mensaje = agendaLineaId
                    ? 'Todavía no se detectaron usuarios válidos en esta línea.'
                    : 'Seleccioná una línea para ver sus usuarios detectados.';
                contenedor.innerHTML = `
                    <div class="agenda-empty">
                        <div>${iconoSVG('users')}<br>${escaparHTML(mensaje)}</div>
                    </div>
                `;
                return;
            }

            const prefijo = prefijoAgendaLinea(lineaAgendaSeleccionada() || {});
            contenedor.innerHTML = lista.map(candidato => {
                const usuario = String(candidato.usuario || '').trim();
                const nombreGenerado = `${prefijo} ${usuario || 'usuario'}${candidato.mutuo ? ' 🟣' : ''}`;
                let nombre = String(candidato.nombre || nombreGenerado).trim();
                if (candidato.mutuo && !nombre.includes('🟣')) nombre += ' 🟣';
                const telefono = String(candidato.telefono || '').trim();
                const fuentes = Array.isArray(candidato.fuentes)
                    ? candidato.fuentes.map(describirFuenteAgenda).filter(Boolean)
                    : [];
                const estado = estadoVisualCandidatoAgenda(candidato);
                const detalle = String(candidato.detalle || '').trim();
                return `
                    <div class="agenda-contact-row" ${detalle ? `title="${escaparHTML(detalle)}"` : ''}>
                        <span class="agenda-contact-main">
                            <strong>${escaparHTML(nombre)}</strong>
                            <span>${telefono ? escaparHTML(`+${telefono.replace(/^\+/, '')}`) : 'Número pendiente de resolver'}</span>
                        </span>
                        <span class="agenda-contact-meta">
                            <span>${usuario ? escaparHTML(`Usuario: ${usuario}`) : 'Usuario sin resolver'}</span>
                            <span>${escaparHTML(fuentes.join(' · ') || (candidato.mutuo ? 'Contacto mutuo' : 'Plantilla detectada'))}</span>
                        </span>
                        <span class="agenda-contact-status ${estado.clase}">${escaparHTML(estado.texto)}</span>
                    </div>
                `;
            }).join('');
        }

        function renderizarAgendamiento(data = {}) {
            agendaEstado = data && typeof data === 'object' ? data : {};
            if (Object.prototype.hasOwnProperty.call(agendaEstado, 'lineaId') && agendaEstado.lineaId) {
                agendaLineaId = String(agendaEstado.lineaId);
            }
            if (Object.prototype.hasOwnProperty.call(agendaEstado, 'cuentaId')) {
                agendaCuentaId = agendaEstado.cuentaId ? String(agendaEstado.cuentaId) : null;
            }

            renderizarSelectorLineasAgendamiento();
            const cuentas = Array.isArray(agendaEstado.cuentas) ? agendaEstado.cuentas : [];
            cuentasGoogleDisponibles = cuentas;
            renderizarSelectorCuentaLinea();
            renderizarSelectorCuentasAgendamiento(cuentas);

            const credencialesConfiguradas = agendaEstado.credencialesConfiguradas === true;
            const cuenta = cuentas.find(item => idCuentaAgenda(item) === String(agendaCuentaId));
            const tituloGoogle = document.getElementById('agenda-google-title');
            const subtituloGoogle = document.getElementById('agenda-google-subtitle');
            const mensajeGoogle = document.getElementById('agenda-google-message');
            const botonCredenciales = document.getElementById('btn-agenda-credentials');
            const botonConectar = document.getElementById('btn-agenda-connect-google');

            if (!credencialesConfiguradas) {
                tituloGoogle.textContent = 'Google no configurado';
                subtituloGoogle.textContent = 'Cargá las credenciales de aplicación de escritorio.';
            } else if (cuenta) {
                tituloGoogle.textContent = nombreCuentaAgenda(cuenta);
                subtituloGoogle.textContent = 'Cuenta asignada a la línea seleccionada.';
            } else if (cuentas.length) {
                tituloGoogle.textContent = `${cuentas.length} cuenta${cuentas.length === 1 ? '' : 's'} disponible${cuentas.length === 1 ? '' : 's'}`;
                subtituloGoogle.textContent = agendaLineaId
                    ? 'Elegí la cuenta que recibirá los contactos de esta línea.'
                    : 'Seleccioná una línea para asignarle una cuenta.';
            } else {
                tituloGoogle.textContent = 'Google listo para conectar';
                subtituloGoogle.textContent = 'Autorizá una cuenta desde tu navegador.';
            }
            botonCredenciales.querySelector('span').textContent =
                credencialesConfiguradas ? 'Cambiar credenciales' : 'Credenciales';
            botonConectar.disabled = !credencialesConfiguradas;
            botonConectar.querySelector('span').textContent = cuentas.length ? 'Agregar cuenta' : 'Conectar Google';
            mensajeGoogle.textContent = String(agendaEstado.mensajeGoogle || agendaEstado.mensaje || '');

            const resumen = agendaEstado.resumen || {};
            const detectados = numeroAgenda(resumen.detectados);
            const pendientes = numeroAgenda(resumen.pendientes);
            const agendados = numeroAgenda(resumen.agendados);
            const mutuos = numeroAgenda(resumen.mutuos);
            const usuariosPendientesJid = numeroAgenda(
                resumen.usuariosPendientesJid
            );
            document.getElementById('agenda-stat-detected').textContent = detectados;
            document.getElementById('agenda-stat-pending').textContent = pendientes;
            document.getElementById('agenda-stat-synced').textContent = agendados;
            document.getElementById('agenda-stat-mutual').textContent = mutuos;

            const palabrasClave = Array.isArray(agendaEstado?.busqueda?.palabrasClave)
                ? agendaEstado.busqueda.palabrasClave
                : ['Usuario:'];
            const cantidadPalabras = palabrasClave.length;
            document.getElementById('agenda-keywords-title').textContent =
                `${cantidadPalabras} referencia${cantidadPalabras === 1 ? '' : 's'} directa${cantidadPalabras === 1 ? '' : 's'}`;
            document.getElementById('agenda-keywords-detail').textContent =
                agendaLineaId
                    ? 'Las referencias aceleran los formatos conocidos; Qwen analiza todos los mensajes salientes disponibles.'
                    : 'Las referencias directas se aplicarán a todas las líneas de esta instalación.';

            const proceso = agendaEstado.proceso || {};
            const activo = proceso.activo === true;
            const procesados = numeroAgenda(proceso.procesados);
            const total = numeroAgenda(proceso.total);
            const porcentaje = total ? Math.min(100, Math.max(0, (procesados / total) * 100)) : 0;
            document.getElementById('agenda-progress-title').textContent = activo
                ? 'Agendando contactos'
                : total
                    ? 'Último proceso'
                    : 'Sin proceso activo';
            document.getElementById('agenda-progress-count').textContent = `${procesados} de ${total}`;
            document.getElementById('agenda-progress-bar').style.width = `${porcentaje}%`;
            document.getElementById('agenda-progress-message').textContent = String(
                proceso.mensaje || (agendaLineaId
                    ? 'La cola está lista para procesar los contactos pendientes.'
                    : 'Seleccioná una línea y una cuenta Google.')
            );
            document.getElementById('agenda-progress-current').textContent =
                String(proceso.actual || '—');

            const actividadIA = renderizarIAAgendamiento(agendaEstado.ia || {});
            document.getElementById('agenda-line-button').disabled =
                activo || actividadIA.analisisActivo;
            document.getElementById('agenda-account-button').disabled =
                activo || actividadIA.analisisActivo || !agendaLineaId;
            botonCredenciales.disabled =
                activo || actividadIA.analisisActivo || agendaOAuthEnCurso;
            botonConectar.disabled =
                activo || actividadIA.analisisActivo || agendaOAuthEnCurso ||
                !credencialesConfiguradas;
            document.getElementById('btn-agenda-start').disabled =
                activo || actividadIA.analisisActivo || !agendaLineaId ||
                !agendaCuentaId || !credencialesConfiguradas ||
                (pendientes < 1 && usuariosPendientesJid < 1);
            document.getElementById('btn-agenda-stop').disabled =
                !activo || !agendaLineaId;
            document.getElementById('btn-agenda-keywords').disabled =
                activo || actividadIA.analisisActivo;
            renderizarCandidatosAgendamiento(agendaEstado.candidatos);
            programarActualizacionAgendamiento();
        }

        function programarActualizacionAgendamiento() {
            if (agendaTemporizador) {
                clearTimeout(agendaTemporizador);
                agendaTemporizador = null;
            }
            const procesoActivo = agendaEstado?.proceso?.activo === true;
            const analisisIAActivo = agendaEstado?.ia?.analisis?.activo === true;
            const modeloIAActivo = modeloAgendaIAEnTransicion(
                agendaEstado?.ia?.modelo || {}
            ) || agendaEstado?.ia?.modelo?.ejecutando === true;
            if (
                seccionActual !== 'agendamiento' &&
                !procesoActivo &&
                !analisisIAActivo &&
                !modeloIAActivo
            ) return;
            agendaTemporizador = setTimeout(() => {
                agendaTemporizador = null;
                actualizarAgendamiento(false);
            }, 2000);
        }

        async function actualizarAgendamiento(mostrarError = false) {
            renderizarSelectorLineasAgendamiento();
            if (agendaActualizando) {
                agendaActualizacionPendiente = agendaActualizacionPendiente || mostrarError;
                return;
            }

            agendaActualizando = true;
            const secuencia = ++agendaSecuencia;
            const lineaConsultada = String(agendaLineaId || '');
            try {
                const url = lineaConsultada
                    ? `/agendamiento?${new URLSearchParams({ lineaId: lineaConsultada })}`
                    : '/agendamiento';
                const respuesta = await fetch(url);
                const data = await exigirRespuesta(
                    respuesta,
                    'No se pudo cargar el agendamiento.'
                );
                if (
                    secuencia !== agendaSecuencia ||
                    lineaConsultada !== String(agendaLineaId || '')
                ) return;
                renderizarAgendamiento(data);
            } catch (error) {
                document.getElementById('agenda-progress-message').textContent =
                    error.message || 'No se pudo actualizar el agendamiento.';
                if (mostrarError) toast(error.message, tipoToastErrorHTTP(error));
            } finally {
                agendaActualizando = false;
                if (agendaActualizacionPendiente) {
                    agendaActualizacionPendiente = false;
                    actualizarAgendamiento(true);
                } else {
                    programarActualizacionAgendamiento();
                }
            }
        }

        async function cambiarModeloAgendamientoIA(accion) {
            if (agendaOperacionIA) return;
            const configuraciones = {
                descargar: {
                    url: '/agendamiento/ia/descargar',
                    method: 'POST',
                    error: 'No se pudo iniciar la descarga de la IA.'
                },
                pausar: {
                    url: '/agendamiento/ia/pausar-descarga',
                    method: 'POST',
                    error: 'No se pudo pausar la descarga de la IA.'
                },
                eliminar: {
                    url: '/agendamiento/ia',
                    method: 'DELETE',
                    error: 'No se pudo eliminar el modelo local.'
                }
            };
            const configuracion = configuraciones[accion];
            if (!configuracion) return;

            const modeloActual = agendaEstado?.ia?.modelo || {};
            const reinstalar = accion === 'descargar' &&
                modeloActual.instalada === true &&
                (Boolean(modeloActual.error) || modeloActual.estado === 'error');

            if (accion === 'eliminar' || reinstalar) {
                const confirmado = await solicitarConfirmacion({
                    titulo: reinstalar ? 'Reinstalar IA local' : 'Eliminar IA local',
                    mensaje: reinstalar
                        ? 'Se reemplazarán el modelo y el motor local para reparar su integridad. Las sugerencias ya revisadas no se perderán.'
                        : 'Se borrará el modelo descargado de este equipo. Las sugerencias ya revisadas no se perderán.',
                    textoConfirmar: reinstalar ? 'Reinstalar' : 'Eliminar modelo',
                    tono: reinstalar ? 'warning' : 'danger',
                    icono: reinstalar ? 'refresh' : 'trash'
                });
                if (!confirmado) return;
            }

            agendaOperacionIA = true;
            renderizarIAAgendamiento(agendaEstado?.ia || {});
            try {
                const respuesta = await fetch(configuracion.url, {
                    method: configuracion.method,
                    ...(reinstalar ? {
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ reinstalar: true })
                    } : {})
                });
                const data = await exigirRespuesta(respuesta, configuracion.error);
                toast(
                    data.mensaje || (accion === 'eliminar'
                        ? 'Modelo local eliminado.'
                        : accion === 'pausar'
                            ? 'Descarga pausada.'
                            : 'Descarga local iniciada.'),
                    'success'
                );
            } catch (error) {
                toast(error.message || configuracion.error, tipoToastErrorHTTP(error));
            } finally {
                agendaOperacionIA = false;
                await actualizarAgendamiento(true);
            }
        }

        async function cambiarAnalisisAgendamientoIA(accion) {
            if (agendaOperacionIA || !agendaLineaId) {
                if (!agendaLineaId) toast('Seleccioná una línea antes de analizar.', 'warning');
                return;
            }
            if (!['analizar', 'detener'].includes(accion)) return;

            agendaOperacionIA = true;
            renderizarIAAgendamiento(agendaEstado?.ia || {});
            try {
                const respuesta = await fetch(
                    `/agendamiento/lineas/${encodeURIComponent(agendaLineaId)}/ia/${accion}`,
                    { method: 'POST' }
                );
                const data = await exigirRespuesta(
                    respuesta,
                    accion === 'analizar'
                        ? 'No se pudo iniciar el análisis local.'
                        : 'No se pudo detener el análisis local.'
                );
                toast(
                    data.mensaje || (accion === 'analizar'
                        ? 'Análisis local iniciado.'
                        : 'Análisis detenido.'),
                    accion === 'analizar' ? 'success' : 'info'
                );
            } catch (error) {
                toast(error.message || 'No se pudo cambiar el análisis.', tipoToastErrorHTTP(error));
            } finally {
                agendaOperacionIA = false;
                await actualizarAgendamiento(true);
            }
        }

        async function resolverRevisionAgendamientoIA(revisionId, accion, fila) {
            const id = String(revisionId || '').trim();
            if (
                !agendaLineaId || !id ||
                !['aprobar', 'editar', 'rechazar'].includes(accion) ||
                agendaRevisionesIAEnCurso.has(id)
            ) return;

            const usuario = String(fila?.querySelector('input')?.value || '').trim();
            if (accion === 'editar' && !usuario) {
                toast('Escribí un usuario antes de guardar la corrección.', 'warning');
                fila?.querySelector('input')?.focus({ preventScroll: true });
                return;
            }

            agendaRevisionesIAEnCurso.add(id);
            renderizarRevisionesAgendaIA(agendaEstado?.ia?.revisiones || []);
            try {
                const respuesta = await fetch(
                    `/agendamiento/lineas/${encodeURIComponent(agendaLineaId)}/ia/revisiones/${encodeURIComponent(id)}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            accion,
                            ...(accion === 'editar' ? { usuario } : {})
                        })
                    }
                );
                const data = await exigirRespuesta(
                    respuesta,
                    'No se pudo guardar la revisión.'
                );
                toast(
                    data.mensaje || (accion === 'rechazar'
                        ? 'Sugerencia rechazada.'
                        : accion === 'editar'
                            ? 'Corrección guardada.'
                            : 'Sugerencia aprobada.'),
                    accion === 'rechazar' ? 'info' : 'success'
                );
            } catch (error) {
                toast(error.message || 'No se pudo guardar la revisión.', tipoToastErrorHTTP(error));
            } finally {
                agendaRevisionesIAEnCurso.delete(id);
                await actualizarAgendamiento(true);
            }
        }

        async function seleccionarCuentaAgendamiento(cuentaId) {
            if (!agendaLineaId || !cuentaId) return;
            const boton = document.getElementById('agenda-account-button');
            boton.disabled = true;
            try {
                const respuesta = await fetch(
                    `/agendamiento/lineas/${encodeURIComponent(agendaLineaId)}/cuenta`,
                    {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ cuentaId })
                    }
                );
                const data = await exigirRespuesta(
                    respuesta,
                    'No se pudo asignar la cuenta Google.'
                );
                agendaCuentaId = String(cuentaId);
                agendaFirmaCuentas = '';
                cerrarSelectoresAgendamiento();
                toast(data.mensaje || 'Cuenta asignada a la línea.', 'success');
                await actualizarAgendamiento(true);
            } catch (error) {
                toast(error.message, tipoToastErrorHTTP(error));
            } finally {
                boton.disabled = !agendaLineaId ||
                    agendaEstado?.proceso?.activo === true;
            }
        }

        async function guardarCredencialesAgendamiento(archivo) {
            if (!archivo) return;
            const boton = document.getElementById('btn-agenda-credentials');
            boton.disabled = true;
            try {
                let credenciales;
                try {
                    credenciales = JSON.parse(await archivo.text());
                } catch {
                    throw new Error('El archivo de credenciales no contiene un JSON válido.');
                }
                if (!credenciales || typeof credenciales !== 'object' || Array.isArray(credenciales)) {
                    throw new Error('Seleccioná las credenciales JSON de una aplicación de escritorio.');
                }

                const respuesta = await fetch('/agendamiento/credenciales', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(credenciales)
                });
                const data = await exigirRespuesta(
                    respuesta,
                    'No se pudieron guardar las credenciales de Google.'
                );
                toast(data.mensaje || 'Credenciales de Google guardadas.', 'success');
                await actualizarAgendamiento(true);
            } catch (error) {
                toast(error.message, tipoToastErrorHTTP(error));
            } finally {
                boton.disabled = agendaEstado?.proceso?.activo === true;
                document.getElementById('agenda-google-credentials-file').value = '';
            }
        }

        async function conectarGoogleAgendamiento() {
            const boton = document.getElementById('btn-agenda-connect-google');
            agendaOAuthEnCurso = true;
            boton.disabled = true;
            boton.setAttribute('aria-busy', 'true');
            try {
                const respuesta = await fetch('/agendamiento/google/conectar', {
                    method: 'POST'
                });
                const data = await exigirRespuesta(
                    respuesta,
                    'No se pudo iniciar la conexión con Google.'
                );
                toast(
                    data.mensaje || 'Completá la autorización en el navegador.',
                    'success'
                );
                await actualizarAgendamiento(true);
            } catch (error) {
                toast(error.message, tipoToastErrorHTTP(error));
            } finally {
                agendaOAuthEnCurso = false;
                boton.removeAttribute('aria-busy');
                renderizarAgendamiento(agendaEstado || {});
            }
        }

        function frasesAgendaDesdeTexto(texto) {
            const frases = [];
            const vistas = new Set();
            for (const valor of String(texto || '').split(/\r?\n/)) {
                const frase = valor
                    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
                    .normalize('NFC')
                    .replace(/\s+/gu, ' ')
                    .trim();
                if (!frase) continue;
                const clave = frase.toLocaleLowerCase('es');
                if (vistas.has(clave)) continue;
                vistas.add(clave);
                frases.push(frase);
            }
            return frases;
        }

        function actualizarContadorPalabrasAgenda() {
            const texto = document.getElementById('agenda-palabras-texto').value;
            const cantidad = frasesAgendaDesdeTexto(texto).length;
            document.getElementById('agenda-palabras-contador').textContent =
                `${cantidad} de 70`;
        }

        function abrirPalabrasClaveAgendamiento() {
            const palabras = Array.isArray(agendaEstado?.busqueda?.palabrasClave)
                ? agendaEstado.busqueda.palabrasClave
                : ['Usuario:'];
            const textarea = document.getElementById('agenda-palabras-texto');
            const mensaje = document.getElementById('agenda-palabras-mensaje');
            textarea.value = palabras.join('\n');
            mensaje.textContent = '';
            mensaje.removeAttribute('data-tone');
            actualizarContadorPalabrasAgenda();
            abrirModal('modal-agenda-palabras');
            requestAnimationFrame(() => {
                textarea.focus({ preventScroll: true });
                textarea.setSelectionRange(textarea.value.length, textarea.value.length);
            });
        }

        function cerrarPalabrasClaveAgendamiento() {
            cerrarModal('modal-agenda-palabras');
        }

        async function abrirPalabrasClaveDesdeConfiguracion() {
            try {
                const respuesta = await fetch('/agendamiento');
                const data = await exigirRespuesta(
                    respuesta,
                    'No se pudieron cargar las referencias de agendamiento.'
                );
                agendaEstado = {
                    ...(agendaEstado || {}),
                    busqueda: data.busqueda || agendaEstado?.busqueda
                };
                abrirPalabrasClaveAgendamiento();
            } catch (error) {
                toast(error.message, tipoToastErrorHTTP(error));
            }
        }

        async function guardarPalabrasClaveAgendamiento() {
            const textarea = document.getElementById('agenda-palabras-texto');
            const mensaje = document.getElementById('agenda-palabras-mensaje');
            const boton = document.getElementById('btn-guardar-agenda-palabras');
            const palabrasClave = frasesAgendaDesdeTexto(textarea.value);

            if (!palabrasClave.length) {
                mensaje.textContent =
                    'Escribí al menos una referencia directa.';
                mensaje.dataset.tone = 'error';
                textarea.focus({ preventScroll: true });
                return;
            }

            boton.disabled = true;
            boton.setAttribute('aria-busy', 'true');
            mensaje.textContent = agendaLineaId
                ? 'Guardando las referencias y revisando los mensajes recientes…'
                : 'Guardando las referencias…';
            mensaje.dataset.tone = 'info';

            try {
                const respuesta = await fetch('/agendamiento/palabras-clave', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        palabrasClave,
                        lineaId: agendaLineaId || null
                    })
                });
                const data = await exigirRespuesta(
                    respuesta,
                    'No se pudieron guardar las palabras clave.'
                );
                agendaEstado = {
                    ...(agendaEstado || {}),
                    busqueda: data.busqueda || { palabrasClave }
                };
                cerrarPalabrasClaveAgendamiento();
                toast(
                    data.mensaje || 'Referencias directas guardadas.',
                    'success'
                );
                await actualizarAgendamiento(true);
            } catch (error) {
                mensaje.textContent =
                    error.message || 'No se pudieron guardar las palabras clave.';
                mensaje.dataset.tone = 'error';
            } finally {
                boton.disabled = false;
                boton.removeAttribute('aria-busy');
            }
        }

        async function cambiarProcesoAgendamiento(accion) {
            if (!agendaLineaId) {
                toast('Seleccioná primero una línea.', 'warning');
                return;
            }
            if (accion === 'iniciar' && !agendaCuentaId) {
                toast('Asigná una cuenta Google a esta línea.', 'warning');
                return;
            }

            const boton = document.getElementById(
                accion === 'iniciar' ? 'btn-agenda-start' : 'btn-agenda-stop'
            );
            boton.disabled = true;
            try {
                const respuesta = await fetch(
                    `/agendamiento/lineas/${encodeURIComponent(agendaLineaId)}/${accion}`,
                    { method: 'POST' }
                );
                const data = await exigirRespuesta(
                    respuesta,
                    accion === 'iniciar'
                        ? 'No se pudo iniciar el agendamiento.'
                        : 'No se pudo detener el agendamiento.'
                );
                toast(
                    data.mensaje || (accion === 'iniciar'
                        ? 'Agendamiento iniciado.'
                        : 'Agendamiento detenido.'),
                    accion === 'iniciar' ? 'success' : 'warning'
                );
                await actualizarAgendamiento(true);
            } catch (error) {
                toast(error.message, tipoToastErrorHTTP(error));
                renderizarAgendamiento(agendaEstado || {});
            }
        }

        function lineaListaParaPublicar(linea = {}) {
            if (linea.conexionEnVerificacion === true) return false;
            if (linea.requiereRevisionEnvio === true) return false;
            if (normalizarEtiquetaVisual(linea.etiqueta) !== 'activa') return false;
            return linea.listaParaPublicar !== false;
        }

        function motivoLineaNoPublicable(linea = {}) {
            if (linea.requiereRevisionEnvio === true) {
                return linea.motivoRevisionEnvio ||
                    'Requiere revisión antes de volver a publicar.';
            }
            if (linea.conexionEnVerificacion === true) {
                return linea.motivoBloqueoPublicacion ||
                    'La conexión todavía se está verificando.';
            }
            const etiqueta = normalizarEtiquetaVisual(linea.etiqueta);
            if (etiqueta !== 'activa') {
                return `La etiqueta ${nombreEtiqueta(etiqueta).toLocaleLowerCase('es')} bloquea la publicación de estados.`;
            }
            if (linea.listaParaPublicar === false) {
                return linea.motivoBloqueoPublicacion ||
                    'La línea no está habilitada para publicar.';
            }
            return '';
        }

        function segundosRestantesProteccion(proteccion = {}) {
            const informados = Number(proteccion.segundosRestantes);
            const bloqueadaHastaMs = Date.parse(proteccion.bloqueadaHasta || '');
            const calculados = Number.isFinite(bloqueadaHastaMs)
                ? Math.max(0, Math.ceil((bloqueadaHastaMs - Date.now()) / 1000))
                : 0;

            if (Number.isFinite(informados) && informados >= 0) {
                return Number.isFinite(bloqueadaHastaMs)
                    ? Math.max(Math.floor(informados), calculados)
                    : Math.floor(informados);
            }

            return calculados;
        }

        function proteccionMiddlewareActiva() {
            return proteccionMiddlewareActual?.activa === true &&
                Number(proteccionMiddlewareActual.segundosRestantes) > 0;
        }

        function actualizarAccionesPublicacion() {
            const bloqueada = proteccionMiddlewareActiva();
            const botonPublicar = document.getElementById('btn-publicar');
            const botonAltoTotal = document.getElementById('btn-alto-total');

            if (botonPublicar) {
                botonPublicar.disabled = publicacionActivaActual ||
                    bloqueada ||
                    solicitudesIdempotentesEnCurso.has('subir');
                botonPublicar.title = bloqueada
                    ? 'Esperá a que termine el enfriamiento preventivo.'
                    : '';
            }

            if (botonAltoTotal) {
                const icono = botonAltoTotal.querySelector('.icon');
                const usoIcono = botonAltoTotal.querySelector('use');
                const texto = botonAltoTotal.querySelector('span');

                botonAltoTotal.hidden = false;
                botonAltoTotal.removeAttribute('aria-hidden');
                botonAltoTotal.disabled = !publicacionActivaActual ||
                    altoTotalSolicitado;
                botonAltoTotal.setAttribute(
                    'aria-busy',
                    altoTotalSolicitado ? 'true' : 'false'
                );
                botonAltoTotal.title = altoTotalSolicitado
                    ? 'Deteniendo la publicación...'
                    : publicacionActivaActual
                        ? 'Detener toda la publicación'
                        : 'No hay una publicación en curso';
                botonAltoTotal.setAttribute(
                    'aria-label',
                    botonAltoTotal.title
                );
                icono?.classList.toggle('spin', altoTotalSolicitado);
                usoIcono?.setAttribute(
                    'href',
                    altoTotalSolicitado ? '#i-loader' : '#i-stop'
                );
                if (texto) {
                    texto.textContent = altoTotalSolicitado
                        ? 'Deteniendo...'
                        : 'Alto total';
                }
            }

            document.querySelectorAll('.btn-ejecutar-programacion').forEach(boton => {
                const clave = `ejecutar:${boton.dataset.id}`;
                const deshabilitadaBase = boton.dataset.disabledBase === 'true';
                boton.disabled = deshabilitadaBase ||
                    publicacionActivaActual ||
                    bloqueada ||
                    solicitudesIdempotentesEnCurso.has(clave);
                boton.title = bloqueada
                    ? 'Ejecución pausada durante el enfriamiento preventivo.'
                    : publicacionActivaActual
                        ? 'Ya existe una publicación en curso.'
                        : '';
            });

            document.querySelectorAll('.btn-reintentar-historial').forEach(boton => {
                const clave = `reintentar:${boton.dataset.id}`;
                const deshabilitadaBase = boton.dataset.disabledBase === 'true';
                boton.disabled = deshabilitadaBase ||
                    publicacionActivaActual ||
                    bloqueada ||
                    solicitudesIdempotentesEnCurso.has(clave);
                boton.title = bloqueada
                    ? 'Reintento pausado durante el enfriamiento preventivo.'
                    : publicacionActivaActual
                        ? 'Ya existe una publicación en curso.'
                        : '';
            });

            const mensajeReconexiones =
                'Esperá a que termine la publicación o usá Alto total antes de reconectar.';
            const controlesReconexiones = [
                ...document.querySelectorAll('.btn-reconectar'),
                document.getElementById('btn-reconectar-todas')
            ].filter(Boolean);

            controlesReconexiones.forEach(boton => {
                if (publicacionActivaActual) {
                    if (boton.dataset.bloqueadaPorPublicacion !== 'true') {
                        boton.dataset.bloqueadaPorPublicacion = 'true';
                        boton.dataset.deshabilitadaAntesPublicacion = String(boton.disabled);
                        boton.dataset.tituloAntesPublicacion = boton.title || '';
                        boton.dataset.ariaAntesPublicacion =
                            boton.getAttribute('aria-label') || '';
                    }

                    boton.disabled = true;
                    boton.title = mensajeReconexiones;
                    boton.setAttribute('aria-label', mensajeReconexiones);
                    return;
                }

                if (boton.dataset.bloqueadaPorPublicacion === 'true') {
                    boton.disabled =
                        boton.dataset.deshabilitadaAntesPublicacion === 'true';
                    boton.title = boton.dataset.tituloAntesPublicacion || '';
                    const ariaAnterior = boton.dataset.ariaAntesPublicacion || '';
                    if (ariaAnterior) {
                        boton.setAttribute('aria-label', ariaAnterior);
                    } else {
                        boton.removeAttribute('aria-label');
                    }
                    delete boton.dataset.bloqueadaPorPublicacion;
                    delete boton.dataset.deshabilitadaAntesPublicacion;
                    delete boton.dataset.tituloAntesPublicacion;
                    delete boton.dataset.ariaAntesPublicacion;
                }
            });
        }

        function actualizarProteccionMiddleware(proteccion = {}) {
            const yaEstabaActiva = proteccionMiddlewareActiva();
            const segundosRestantes = segundosRestantesProteccion(proteccion);
            const activa = proteccion?.activa === true && segundosRestantes > 0;
            const panel = document.getElementById('alerta-middleware');
            const detalle = document.getElementById('detalle-middleware');
            const contador = document.querySelector('#contador-middleware > span');

            proteccionMiddlewareActual = activa
                ? { ...proteccion, activa: true, segundosRestantes }
                : null;

            if (panel) panel.classList.toggle('visible', activa);

            if (activa) {
                const linea = typeof proteccion.linea === 'object'
                    ? String(proteccion.linea?.nombre || '').trim()
                    : String(proteccion.linea || '').trim();
                const partes = [
                    String(proteccion.motivo || 'Las publicaciones están pausadas temporalmente por seguridad.').trim(),
                    linea ? `Línea: ${linea}.` : '',
                    proteccion.codigo ? `Código: ${proteccion.codigo}.` : ''
                ].filter(Boolean);

                if (detalle) detalle.textContent = partes.join(' ');
                if (contador) {
                    contador.textContent = `Disponible en ${formatearTiempo(segundosRestantes)}`;
                }
                if (!yaEstabaActiva) {
                    toast(
                        `Enfriamiento preventivo activo · ${formatearTiempo(segundosRestantes)}.`,
                        'warning'
                    );
                }
            } else {
                if (detalle) {
                    detalle.textContent = 'Las publicaciones están disponibles.';
                }
                if (contador) contador.textContent = '--';
            }

            actualizarAccionesPublicacion();
        }

