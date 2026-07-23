        async function actualizarLineas() {
            const secuencia = ++secuenciaActualizacionLineas;

            try {
                const respuesta = await fetch('/estado');
                const data = await respuesta.json();
                if (secuencia !== secuenciaActualizacionLineas) return;

                const selector = document.getElementById('lista-lineas');

                const todasLasLineas = data.lineas
                    .map((linea, indice) => ({
                        ...linea,
                        ordenOriginal: Number(linea.ordenConexion) || indice + 1
                    }));
                const conectadas = todasLasLineas.filter(
                    linea => linea.estado === 'conectado'
                );
                const pendientes = todasLasLineas.filter(
                    linea => linea.estado !== 'conectado'
                );

                sincronizarModalQr(data.lineas);

                cacheLineasSeccion = conectadas;
                cacheLineasAgendamiento = todasLasLineas;
                renderizarSelectorLineasAgendamiento();

                const idsLineasExistentes = new Set(
                    todasLasLineas.map(linea => String(linea.id))
                );
                for (const id of Array.from(lineasSeleccionadasEliminar)) {
                    if (!idsLineasExistentes.has(id)) {
                        lineasSeleccionadasEliminar.delete(id);
                    }
                }

                idsLineasConectadas = conectadas
                    .filter(lineaListaParaPublicar)
                    .map(linea => linea.id);

                for (const id of Array.from(lineasSeleccionadas)) {
                    if (!idsLineasConectadas.includes(id)) {
                        lineasSeleccionadas.delete(id);
                    }
                }

                const busqueda = document
                    .getElementById('buscar-lineas')
                    .value
                    .trim()
                    .toLocaleLowerCase('es');

                const visibles = conectadas
                    .filter(linea =>
                        !busqueda ||
                        String(linea.nombre || '')
                            .toLocaleLowerCase('es')
                            .includes(busqueda) ||
                        String(linea.numero || '')
                            .toLocaleLowerCase('es')
                            .includes(busqueda) ||
                        nombreEtiqueta(linea.etiqueta)
                            .toLocaleLowerCase('es')
                            .includes(busqueda)
                    )
                    .sort(compararLineasSubida);

                const contenidoSelector = visibles.length
                    ? visibles.map(linea => {
                    const listaParaPublicar = lineaListaParaPublicar(linea);
                    const motivoNoPublicable = motivoLineaNoPublicable(linea);
                    return `
                        <label class="selector-line">
                        <input
                            type="checkbox"
                            class="line-check seleccionar-linea"
                            value="${escaparHTML(linea.id)}"
                            ${listaParaPublicar && lineasSeleccionadas.has(linea.id) ? 'checked' : ''}
                            ${listaParaPublicar ? '' : 'disabled'}
                        >
                        <span class="selector-line-info">
                            <strong>
                                ${escaparHTML(linea.nombre)}
                                ${etiquetaHTML(linea.etiqueta)}
                            </strong>
                            <span class="meta-with-icon">${iconoSVG('phone-call')}<span>${linea.numero ? escaparHTML(linea.numero) : 'Número no disponible'}</span></span>
                            ${motivoNoPublicable
                                ? `<span class="selector-line-publication-state">${iconoSVG(linea.conexionEnVerificacion ? 'loader' : 'alert', linea.conexionEnVerificacion ? 'spin' : '')}<span>${escaparHTML(motivoNoPublicable)}</span></span>`
                                : ''}
                        </span>
                        </label>
                    `;
                }).join('')
                    : `
                        <div class="empty-state" style="min-height:100px;">
                            <div>
                                <strong>${busqueda ? 'No se encontraron líneas' : 'No hay líneas conectadas'}</strong>
                                ${busqueda ? 'Probá con otro nombre o número.' : 'Conectá una línea desde la sección Líneas.'}
                            </div>
                        </div>
                    `;
                if (selector.__contenidoRenderizado !== contenidoSelector) {
                    selector.innerHTML = contenidoSelector;
                    selector.__contenidoRenderizado = contenidoSelector;
                }

                renderizarLineasConectadas(cacheLineasSeccion);

                renderizarLineasPendientes(pendientes);
                actualizarControlesEliminacionLineas();

                document.getElementById('nav-line-count').textContent =
                    conectadas.length;

                const visiblesPublicables = visibles.filter(lineaListaParaPublicar).length;
                document.getElementById('resultado-busqueda').textContent =
                    busqueda
                        ? `${visibles.length} resultado(s) · ${visiblesPublicables} lista(s) para publicar.`
                        : `${conectadas.length} conectada(s) · ${idsLineasConectadas.length} lista(s) para publicar.`;

                actualizarControlesOrdenLineasSubida(visibles.length);

                actualizarCheckboxGeneral();
                actualizarAccionesPublicacion();
            } catch (error) {
                if (secuencia !== secuenciaActualizacionLineas) return;
                console.error('Error consultando las líneas:', error);
            }
        }

        function formatearTiempo(segundos) {
            const minutos = Math.floor(segundos / 60);
            const segundosRestantes = segundos % 60;

            return `${minutos}:${String(segundosRestantes).padStart(2, '0')}`;
        }

        function nombreCausaPublicacion(valor) {
            if (valor === undefined || valor === null || valor === '') return '';

            const etiquetas = {
                desconexion: 'Desconexión',
                desconectada: 'Desconexión',
                conexion: 'Conexión',
                sincronizacion: 'Sincronización pendiente',
                audiencia: 'Audiencia no sincronizada',
                privacidad: 'Privacidad incompleta',
                sincronizacion_audiencia: 'Sincronización de audiencia',
                limite_audiencia: 'Límite de audiencia',
                limite_temporal: 'Limitación temporal',
                middleware_enfriamiento: 'Enfriamiento preventivo',
                proteccion_middleware: 'Protección preventiva',
                seguridad_linea: 'Protección de línea',
                registro_local: 'Registro local',
                envio: 'Fallo de envío',
                envio_incierto: 'Envío sin confirmación',
                omitida_por_corte: 'No procesada por corte',
                cancelacion: 'Cancelación de seguridad',
                cancelacion_manual: 'Cancelación manual',
                desconocido: 'Error sin clasificar'
            };
            const clave = String(valor).trim().toLowerCase();
            return etiquetas[clave] || String(valor).replace(/[_-]+/g, ' ');
        }

        function nombreFasePublicacion(valor) {
            const fases = {
                preparacion: 'Preparación',
                audiencia: 'Audiencia',
                envio: 'Envío',
                registro: 'Registro local',
                no_procesada: 'No procesada'
            };
            const clave = String(valor || '').trim().toLowerCase();
            return fases[clave] || nombreCausaPublicacion(valor);
        }

        function describirEstadoHistorial(estado) {
            const estados = {
                completado: {
                    texto: 'Completado',
                    clase: 'success',
                    icono: 'check-circle'
                },
                completado_con_errores: {
                    texto: 'Completado con errores',
                    clase: 'warning',
                    icono: 'alert'
                },
                error: {
                    texto: 'Error',
                    clase: 'error',
                    icono: 'x-circle'
                },
                cancelado: {
                    texto: 'Cancelado',
                    clase: 'error',
                    icono: 'stop'
                },
                cancelado_seguridad: {
                    texto: 'Cancelado por seguridad',
                    clase: 'error',
                    icono: 'stop'
                },
                detenido_desconexion: {
                    texto: 'Detenido por desconexión',
                    clase: 'error',
                    icono: 'x-circle'
                },
                detenido_limite_temporal: {
                    texto: 'Detenido temporalmente',
                    clase: 'warning',
                    icono: 'alert'
                },
                detenido_envio_incierto: {
                    texto: 'Detenido · envío sin confirmar',
                    clase: 'warning',
                    icono: 'alert'
                },
                detenido_seguridad_linea: {
                    texto: 'Detenido por protección de línea',
                    clase: 'warning',
                    icono: 'alert'
                },
                detenido_alto_total: {
                    texto: 'Detenido con Alto total',
                    clase: 'error',
                    icono: 'stop'
                },
                ejecutando: {
                    texto: 'Publicando',
                    clase: '',
                    icono: 'loader'
                }
            };

            if (estados[estado]) return estados[estado];

            const textoBase = String(estado || 'Sin estado').replace(/[_-]+/g, ' ');
            return {
                texto: textoBase.charAt(0).toUpperCase() + textoBase.slice(1),
                clase: '',
                icono: 'info'
            };
        }

        function detalleFallosHistorial(lineasFallidas) {
            const fallos = Array.isArray(lineasFallidas) ? lineasFallidas : [];
            if (!fallos.length) return '';

            const elementos = fallos.map(fallo => {
                const tipo = nombreCausaPublicacion(
                    fallo?.tipoError ?? fallo?.causa
                );
                const codigo = fallo?.codigoError === undefined || fallo?.codigoError === null
                    ? ''
                    : String(fallo.codigoError);
                const fase = nombreFasePublicacion(fallo?.fase);
                const envioConfirmado = fallo?.envioConfirmado === true;
                const envioIncierto = fallo?.envioIncierto === true;
                const reintentoBloqueado = fallo?.reintentoSeguro !== true;
                const reintentadaEn = fallo?.reintentadaEn;

                return `
                    <li class="history-failure-item">
                        <div class="history-failure-heading">
                            ${iconoSVG('x-circle')}
                            <strong>${escaparHTML(fallo?.nombre || 'Línea sin nombre')}</strong>
                        </div>
                        <span>${escaparHTML(fallo?.error || 'Error sin detalle.')}</span>
                        <div class="history-failure-meta">
                            ${tipo ? `<small>${escaparHTML(tipo)}</small>` : ''}
                            ${codigo ? `<small>Código: ${escaparHTML(codigo)}</small>` : ''}
                            ${fase ? `<small>Fase: ${escaparHTML(fase)}</small>` : ''}
                            ${envioConfirmado ? '<small class="confirmed">Envío confirmado: no duplicar</small>' : ''}
                            ${!envioConfirmado && envioIncierto ? '<small class="confirmed">Resultado incierto: reintento bloqueado</small>' : ''}
                            ${!envioConfirmado && !envioIncierto && reintentoBloqueado ? '<small class="confirmed">Seguridad de reintento no verificada: bloqueado</small>' : ''}
                            ${reintentadaEn ? `<small>Reintentada: ${escaparHTML(formatearFecha(reintentadaEn))}</small>` : ''}
                        </div>
                    </li>
                `;
            }).join('');

            return `
                <details class="history-failures">
                    <summary>
                        ${iconoSVG('alert')}
                        <span>Ver detalle de ${fallos.length} línea(s) con incidencias</span>
                    </summary>
                    <ul class="history-failure-list">${elementos}</ul>
                </details>
            `;
        }

        function extraerCausaProgreso(progreso) {
            if (progreso.tipoErrorCorte) {
                const tipoCorte = nombreCausaPublicacion(progreso.tipoErrorCorte);
                const codigoCorte = progreso.codigoErrorCorte === undefined ||
                    progreso.codigoErrorCorte === null
                    ? ''
                    : String(progreso.codigoErrorCorte);

                return codigoCorte
                    ? `${tipoCorte} · Código: ${codigoCorte}`
                    : tipoCorte;
            }

            const valor = progreso.causaError ??
                progreso.tipoError ??
                progreso.tipoErrorActual ??
                progreso.tipoErrorCorte ??
                progreso.tipoFallo ??
                progreso.causaFallo ??
                progreso.causaActual ??
                progreso.causaDetencion ??
                progreso.motivoDetencion ??
                progreso.codigoError ??
                progreso.errorActual ??
                progreso.proteccionMiddleware?.motivo;

            if (!valor) return '';
            if (typeof valor !== 'object') return nombreCausaPublicacion(valor);

            const tipo = nombreCausaPublicacion(
                valor.tipo ?? valor.codigo ?? valor.causa ?? valor.clasificacion
            );
            const detalle = String(valor.mensaje ?? valor.detalle ?? valor.error ?? '').trim();

            if (tipo && detalle && tipo.toLowerCase() !== detalle.toLowerCase()) {
                return `${tipo}: ${detalle}`;
            }

            return tipo || detalle;
        }

        function extraerLineaActual(progreso) {
            const valor = progreso.lineaActual ??
                progreso.lineaEnCurso ??
                progreso.lineaEnProceso ??
                progreso.lineaActualNombre ??
                progreso.lineaCorte ??
                progreso.proteccionMiddleware?.linea;

            if (!valor) return '';
            if (typeof valor !== 'object') return String(valor);

            const nombre = String(valor.nombre ?? valor.alias ?? valor.id ?? '').trim();
            const numero = String(valor.numero ?? '').trim();
            return [nombre, numero].filter(Boolean).join(' · ');
        }

        function actualizarContextoProgreso(progreso) {
            const contexto = document.getElementById('progreso-contexto');
            const lineaChip = document.getElementById('progreso-linea-chip');
            const causaChip = document.getElementById('progreso-causa-chip');
            const linea = extraerLineaActual(progreso);
            const causa = extraerCausaProgreso(progreso);

            lineaChip.hidden = !linea;
            causaChip.hidden = !causa;
            document.getElementById('progreso-linea-actual').textContent = linea;
            document.getElementById('progreso-causa').textContent = causa;
            contexto.hidden = !linea && !causa;
        }

        async function actualizarProgresoPublicacion() {
            try {
                const respuesta = await fetch('/progreso');
                const progreso = await respuesta.json();
                publicacionActivaActual = Boolean(
                    progreso.ocupada ?? (
                        progreso.activo ||
                        Number(progreso.publicacionesPendientes) > 0
                    )
                );
                altoTotalSolicitado = Boolean(
                    publicacionActivaActual && (
                        altoTotalSolicitado ||
                        progreso.altoTotalSolicitado === true
                    )
                );
                actualizarProteccionMiddleware(progreso.proteccionMiddleware);

                document.getElementById('progreso-procesadas').textContent =
                    progreso.procesadas || 0;
                document.getElementById('progreso-total').textContent =
                    progreso.total || 0;
                document.getElementById('progreso-correctas').textContent =
                    progreso.correctas || 0;
                document.getElementById('progreso-fallidas').textContent =
                    progreso.fallidas || 0;
                const modoRitmo = normalizarModoRitmo(progreso.modoRitmo, 'grupos');
                const secuencial = modoRitmo === 'secuencial';
                const unidadActual = secuencial
                    ? (progreso.indiceLineaActual ?? progreso.lineaActualIndice ?? progreso.grupoActual ?? 0)
                    : (progreso.grupoActual ?? 0);
                const totalUnidades = secuencial
                    ? (progreso.totalLineas ?? progreso.totalGrupos ?? progreso.total ?? 0)
                    : (progreso.totalGrupos ?? 0);

                document.getElementById('progreso-unidad-label').textContent =
                    secuencial ? 'Línea:' : 'Grupo:';
                document.getElementById('progreso-grupo').textContent =
                    `${unidadActual} de ${totalUnidades}`;
                actualizarContextoProgreso(progreso);

                const proximo = document.getElementById('progreso-proximo');

                if (['esperando_siguiente_grupo', 'esperando_siguiente_linea', 'esperando_siguiente_envio'].includes(progreso.estado)) {
                    const segundosRestantes = progreso.proximoEnvioSegundos ?? (
                        secuencial
                            ? (progreso.proximaLineaSegundos ?? progreso.proximoGrupoSegundos ?? 0)
                            : (progreso.proximoGrupoSegundos ?? 0)
                    );
                    proximo.textContent = formatearTiempo(segundosRestantes);
                } else if (progreso.estado === 'esperando_reconexion') {
                    proximo.textContent = 'Esperando reconexión';
                } else if (progreso.estado === 'esperando_resultado_envio') {
                    proximo.textContent = 'Guardando resultado';
                } else if (progreso.estado === 'esperando_sincronizacion_audiencia') {
                    proximo.textContent =
                        `Sincronizando · ${formatearTiempo(
                            progreso.sincronizacionAudienciaSegundos || 0
                        )}`;
                } else if (progreso.estado === 'completado') {
                    proximo.textContent = 'Finalizado';
                } else if (progreso.estado === 'completado_con_errores') {
                    proximo.textContent = 'Finalizado con errores';
                } else if (progreso.estado === 'detenido_seguridad') {
                    proximo.textContent = 'Detenido por seguridad';
                } else if (progreso.estado === 'detenido_desconexion') {
                    proximo.textContent = 'Detenido por desconexión';
                } else if (progreso.estado === 'detenido_limite_temporal') {
                    proximo.textContent = 'Detenido temporalmente';
                } else if (progreso.estado === 'detenido_envio_incierto') {
                    proximo.textContent = 'Detenido · envío sin confirmar';
                } else if (progreso.estado === 'detenido_seguridad_linea') {
                    proximo.textContent = 'Línea no habilitada';
                } else if (progreso.estado === 'deteniendo_alto_total') {
                    proximo.textContent = progreso.envioEnCurso
                        ? 'Guardando el envío en curso'
                        : 'Deteniendo...';
                } else if (progreso.estado === 'detenido_alto_total') {
                    proximo.textContent = 'Detenido con Alto total';
                } else if (progreso.estado === 'cancelado_seguridad') {
                    proximo.textContent = 'Cancelado';
                } else if (progreso.estado === 'error') {
                    proximo.textContent = 'Error';
                } else if (progreso.activo) {
                    proximo.textContent = 'Publicando ahora';
                } else {
                    proximo.textContent = '--';
                }

                document.getElementById('progreso-mensaje').textContent =
                    progreso.mensaje || 'No hay una publicación activa.';

                const alertaSeguridad = document.getElementById('alerta-seguridad');
                const detalleSeguridad = document.getElementById('detalle-seguridad');
                const seguridadDetenida =
                    progreso.estado === 'detenido_seguridad';

                alertaSeguridad.classList.toggle('visible', seguridadDetenida);

                if (seguridadDetenida) {
                    detalleSeguridad.textContent =
                        progreso.mensajeSeguridad ||
                        extraerCausaProgreso(progreso) ||
                        `Se alcanzó el límite configurado de ` +
                        `${progreso.limiteFallosSeguridad || 1} línea(s) con fallos.`;
                }

                const porcentaje = progreso.total > 0
                    ? Math.round(
                        (progreso.procesadas / progreso.total) * 100
                    )
                    : 0;

                document.getElementById('barra-progreso').style.width =
                    `${porcentaje}%`;

                document.getElementById('lista-correctas').innerHTML =
                    (progreso.lineasCorrectas || [])
                        .map(linea => `
                            <li>
                                ${iconoSVG('check-circle')}
                                <span>
                                    ${escaparHTML(linea.nombre)}
                                    ${linea.numero ? `— ${escaparHTML(linea.numero)}` : ''}
                                </span>
                            </li>
                        `)
                        .join('');

                document.getElementById('lista-fallidas').innerHTML =
                    (progreso.lineasFallidas || [])
                        .map(linea => {
                            const tipo = nombreCausaPublicacion(
                                linea.tipoError ?? linea.causa ?? linea.codigoError
                            );
                            const codigo = linea.codigoError === undefined || linea.codigoError === null
                                ? ''
                                : String(linea.codigoError);
                            return `
                                <li>
                                    ${iconoSVG('x-circle')}
                                    <span>
                                        ${escaparHTML(linea.nombre)} — ${escaparHTML(linea.error)}
                                        ${tipo ? `<small class="result-error-type">${escaparHTML(tipo)}</small>` : ''}
                                        ${codigo ? `<small class="result-error-type">Código: ${escaparHTML(codigo)}</small>` : ''}
                                    </span>
                                </li>
                            `;
                        })
                        .join('');

                actualizarAccionesPublicacion();
            } catch (error) {
                console.error('No se pudo consultar el progreso:', error);
            }
        }

        function iniciarSeguimientoProgreso() {
            if (intervaloProgreso) {
                clearInterval(intervaloProgreso);
            }

            actualizarProgresoPublicacion();
            intervaloProgreso = setInterval(
                actualizarProgresoPublicacion,
                1000
            );
        }

        function validarDatosFormulario(paraProgramar) {
            const archivo = document.getElementById('foto').files[0];
            const texto = document.getElementById('texto').value;
            const modoRitmo = obtenerModoRitmo('modo-ritmo');
            let intervaloSegundos = Number(document.getElementById('intervalo-segundos').value);
            let variacionSegundos = Number(document.getElementById('variacion-segundos').value);
            let lineasPorGrupo = Number(document.getElementById('lineas-por-grupo').value);
            let intervaloMinutos = Number(document.getElementById('intervalo-minutos').value);
            const hora = document.getElementById('hora-programada').value;
            const diasSemana = obtenerDiasSeleccionados('dias-programados');

            if (!lineasSeleccionadas.size) throw new Error('Seleccioná al menos una línea conectada.');
            if (!archivo) throw new Error('Seleccioná una imagen.');

            if (!MODOS_RITMO_VALIDOS.has(modoRitmo)) {
                throw new Error('Elegí un ritmo de publicación válido.');
            }

            const segundosValidos = Number.isInteger(intervaloSegundos) && intervaloSegundos >= 10 && intervaloSegundos <= 3600;
            const variacionValida = Number.isInteger(variacionSegundos) && variacionSegundos >= 0 && variacionSegundos <= 30 && variacionSegundos <= intervaloSegundos;
            const grupoValido = Number.isInteger(lineasPorGrupo) && lineasPorGrupo >= 1 && lineasPorGrupo <= 10;
            const minutosValidos = Number.isFinite(intervaloMinutos) && intervaloMinutos >= 0 && intervaloMinutos <= 1440;

            if (modoRitmo === 'secuencial' && !segundosValidos) {
                throw new Error('Indicá un intervalo entre 10 y 3600 segundos.');
            }

            if (modoRitmo === 'secuencial' && !variacionValida) {
                throw new Error('Indicá una variación entre 0 y 30 segundos que no supere el intervalo base.');
            }

            if (modoRitmo === 'grupos' && !grupoValido) {
                throw new Error('Indicá una cantidad entre 1 y 10 líneas por envío.');
            }

            if (modoRitmo === 'grupos' && !minutosValidos) {
                throw new Error('Indicá un intervalo entre 0 y 1440 minutos.');
            }

            if (!segundosValidos) intervaloSegundos = 45;
            if (!variacionValida) variacionSegundos = 5;
            if (!grupoValido) lineasPorGrupo = 10;
            if (!minutosValidos) intervaloMinutos = 5;

            if (paraProgramar && !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) {
                throw new Error('Elegí una hora válida.');
            }

            if (paraProgramar && !diasSemana.length) {
                throw new Error('Seleccioná al menos un día de la semana.');
            }

            return {
                archivo,
                texto,
                modoRitmo,
                intervaloSegundos,
                variacionSegundos,
                lineasPorGrupo,
                intervaloMinutos,
                hora,
                diasSemana
            };
        }

        function crearFormData(datos, incluirHora) {
            const formData = new FormData();
            formData.append('imagen', datos.archivo);
            formData.append('texto', datos.texto);
            formData.append('lineas', JSON.stringify(Array.from(lineasSeleccionadas)));
            formData.append('modoRitmo', datos.modoRitmo);
            formData.append('intervaloSegundos', String(datos.intervaloSegundos));
            formData.append('variacionSegundos', String(datos.variacionSegundos));
            formData.append('lineasPorGrupo', String(datos.lineasPorGrupo));
            formData.append('intervaloMinutos', String(datos.intervaloMinutos));

            if (incluirHora) {
                formData.append('hora', datos.hora);
                formData.append('diasSemana', JSON.stringify(datos.diasSemana));
            }

            return formData;
        }

        function abrirEditorProgramacion(id) {
            const item = programacionesCache.get(id);
            if (!item) return;

            document.getElementById('editar-id').value = item.id;
            document.getElementById('editar-hora').value = item.hora;
            document.getElementById('editar-texto').value = item.texto || '';
            document.getElementById('editar-activa').checked = item.activa !== false;
            marcarDiasSeleccionados('editar-dias-programados', item.diasSemana || [0,1,2,3,4,5,6]);
            if (urlPreviewEdicion) {
                URL.revokeObjectURL(urlPreviewEdicion);
                urlPreviewEdicion = null;
            }

            document.getElementById('editar-foto').value = '';
            document.getElementById('editar-foto-nombre').textContent =
                'Ningún archivo nuevo seleccionado';
            document.getElementById('mensaje-edicion').textContent = '';
            document.getElementById('editar-imagen-actual').src =
                `/programaciones/${item.id}/imagen?v=${Date.now()}`;

            abrirModal('modal-editar');
        }

        function cerrarEditorProgramacion() {
            cerrarModal('modal-editar');
            document.getElementById('editar-id').value = '';
            document.getElementById('editar-foto').value = '';
            document.getElementById('editar-foto-nombre').textContent =
                'Ningún archivo nuevo seleccionado';
            document.getElementById('mensaje-edicion').textContent = '';

            if (urlPreviewEdicion) {
                URL.revokeObjectURL(urlPreviewEdicion);
                urlPreviewEdicion = null;
            }
        }

        function tarjetaProgramacion(item) {
            const puedeModificar = !['en_cola', 'ejecutando'].includes(item.estado);
            const proxima = formatearFecha(item.proximaEjecucion, item.activa === false ? 'En pausa' : 'No disponible');
            const ultima = formatearFecha(item.ultimaEjecucion, 'Todavía no se ejecutó');
            const textoVisible = item.texto
                ? escaparHTML(item.texto)
                : '<em style="color:var(--muted);">Sin texto.</em>';
            const dias = describirDias(item.diasSemana);
            const ritmo = describirRitmoPublicacion(item);

            return `
                <article class="program-card ${item.activa === false ? 'program-paused' : ''}">
                    <img class="program-card-image" src="/programaciones/${item.id}/imagen?v=${encodeURIComponent(item.actualizadoEn || '')}" alt="Imagen programada">
                    <div class="program-card-body">
                        <div class="program-card-time title-with-icon">
                            ${iconoSVG('clock')}
                            <span>${escaparHTML(dias)} · ${escaparHTML(item.hora)}</span>
                        </div>
                        <div class="program-meta">
                            <span class="chip ${item.activa === false ? '' : 'success'}">${iconoSVG(item.activa === false ? 'pause' : 'calendar')}<span>${mostrarEstadoProgramacion(item.estado)}</span></span>
                            <span class="chip">${iconoSVG('users')}<span>${item.cantidadLineas} líneas</span></span>
                            <span class="chip">${iconoSVG(ritmo.modo === 'secuencial' ? 'timer' : 'layers')}<span>${escaparHTML(ritmo.principal)}</span></span>
                            ${ritmo.detalle ? `<span class="chip">${iconoSVG('activity')}<span>${escaparHTML(ritmo.detalle)}</span></span>` : ''}
                        </div>
                        <p class="program-card-text">${textoVisible}</p>
                        <div class="program-dates">
                            <span class="meta-with-icon">${iconoSVG('calendar')}<span>Próxima: ${escaparHTML(proxima)}</span></span>
                            <span class="meta-with-icon">${iconoSVG('history')}<span>Última: ${escaparHTML(ultima)}</span></span>
                        </div>
                        <div class="program-actions">
                            <button type="button" class="btn-edit btn-editar-programacion" data-id="${item.id}" ${puedeModificar ? '' : 'disabled'}>${iconoSVG('edit')}<span>Editar</span></button>
                            <button type="button" class="btn-run btn-ejecutar-programacion" data-id="${item.id}" data-disabled-base="${puedeModificar ? 'false' : 'true'}" ${puedeModificar ? '' : 'disabled'}>${iconoSVG('play')}<span>Ejecutar</span></button>
                            <button type="button" class="btn-pause btn-estado-programacion" data-id="${item.id}" data-activa="${item.activa === false ? 'true' : 'false'}" ${puedeModificar ? '' : 'disabled'}>${iconoSVG(item.activa === false ? 'play' : 'pause')}<span>${item.activa === false ? 'Activar' : 'Pausar'}</span></button>
                            <button type="button" class="btn-neutral btn-duplicar-programacion" data-id="${item.id}" ${puedeModificar ? '' : 'disabled'}>${iconoSVG('copy')}<span>Duplicar</span></button>
                            <button type="button" class="btn-delete btn-eliminar-programacion" data-id="${item.id}" ${puedeModificar ? '' : 'disabled'}>${iconoSVG('trash')}<span>Eliminar</span></button>
                        </div>
                    </div>
                </article>`;
        }

        async function actualizarProgramaciones() {
            try {
                const respuesta = await fetch('/programaciones');
                const data = await respuesta.json();
                const contenedor = document.getElementById('lista-programaciones');
                const firmaRender = JSON.stringify([
                    vistaProgramaciones,
                    data.programaciones
                ]);

                programacionesCache.clear();
                for (const item of data.programaciones) programacionesCache.set(item.id, item);
                contenedor.classList.toggle('list-view', vistaProgramaciones === 'list');
                if (contenedor.__firmaRender === firmaRender) {
                    actualizarAccionesPublicacion();
                    return;
                }
                contenedor.__firmaRender = firmaRender;

                if (!data.programaciones.length) {
                    contenedor.innerHTML = `<div class="empty-state"><div class="empty-state-content"><span class="empty-state-icon">${iconoSVG('calendar')}</span><strong>Aún no hay estados programados</strong><span>Tocá el botón de agregar para crear el primero.</span></div></div>`;
                    actualizarResumen();
                    return;
                }

                contenedor.innerHTML = data.programaciones.map(tarjetaProgramacion).join('');
                actualizarAccionesPublicacion();

                document.querySelectorAll('.btn-editar-programacion').forEach(boton => {
                    boton.addEventListener('click', evento => abrirEditorProgramacion(evento.currentTarget.dataset.id));
                });

                document.querySelectorAll('.btn-estado-programacion').forEach(boton => {
                    boton.addEventListener('click', async evento => {
                        const actual = evento.currentTarget;
                        try {
                            const respuestaEstado = await fetch(`/programaciones/${actual.dataset.id}/estado`, {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ activa: actual.dataset.activa === 'true' })
                            });
                            const datos = await leerRespuesta(respuestaEstado);
                            if (!respuestaEstado.ok) throw new Error(datos.error || 'No se pudo cambiar el estado.');
                            toast(datos.mensaje, 'success');
                            actualizarProgramaciones();
                        } catch (error) { toast(error.message, 'error'); }
                    });
                });

                document.querySelectorAll('.btn-ejecutar-programacion').forEach(boton => {
                    boton.addEventListener('click', async evento => {
                        const botonActual = evento.currentTarget;
                        const id = botonActual.dataset.id;
                        const claveAccion = `ejecutar:${id}`;
                        const claveIdempotencia = iniciarSolicitudIdempotente(
                            claveAccion,
                            botonActual
                        );
                        if (!claveIdempotencia) return;

                        try {
                            const respuestaEjecucion = await fetch(
                                `/programaciones/${encodeURIComponent(id)}/ejecutar`,
                                {
                                    method: 'POST',
                                    headers: { 'Idempotency-Key': claveIdempotencia }
                                }
                            );
                            const datos = await exigirRespuesta(
                                respuestaEjecucion,
                                'No se pudo ejecutar la programación.'
                            );
                            publicacionActivaActual = true;
                            toast(datos.mensaje, 'success');
                            mostrarSeccion('estados');
                            iniciarSeguimientoProgreso();
                        } catch (error) {
                            toast(error.message, tipoToastErrorHTTP(error));
                        } finally {
                            finalizarSolicitudIdempotente(claveAccion, botonActual);
                        }
                    });
                });

                document.querySelectorAll('.btn-duplicar-programacion').forEach(boton => {
                    boton.addEventListener('click', async evento => {
                        try {
                            const respuestaCopia = await fetch(`/programaciones/${evento.currentTarget.dataset.id}/duplicar`, { method: 'POST' });
                            const datos = await leerRespuesta(respuestaCopia);
                            if (!respuestaCopia.ok) throw new Error(datos.error || 'No se pudo duplicar.');
                            toast(datos.mensaje, 'success');
                            actualizarProgramaciones();
                        } catch (error) { toast(error.message, 'error'); }
                    });
                });

                document.querySelectorAll('.btn-eliminar-programacion').forEach(boton => {
                    boton.addEventListener('click', async evento => {
                        const id = evento.currentTarget.dataset.id;
                        const confirmado = await solicitarConfirmacion({
                            titulo: 'Eliminar programación',
                            mensaje: 'Esta programación dejará de ejecutarse y desaparecerá del panel.',
                            textoConfirmar: 'Eliminar',
                            icono: 'trash'
                        });
                        if (!confirmado) return;
                        const respuestaEliminar = await fetch(`/programaciones/${id}`, { method: 'DELETE' });
                        const datos = await leerRespuesta(respuestaEliminar);
                        if (!respuestaEliminar.ok) return toast(datos.error || 'No se pudo eliminar.', 'error');
                        toast(datos.mensaje || 'Programación eliminada.', 'success');
                        actualizarProgramaciones();
                    });
                });

                actualizarResumen();
            } catch (error) {
                console.error('No se pudieron cargar las programaciones:', error);
            }
        }

        async function actualizarResumen() {
            try {
                const respuesta = await fetch('/resumen');
                const data = await respuesta.json();
                document.getElementById('resumen-lineas-conectadas').textContent = data.lineas?.conectadas || 0;
                document.getElementById('resumen-lineas-problemas').textContent = data.lineas?.conProblemas || 0;
                document.getElementById('resumen-publicaciones-hoy').textContent = data.publicacionesHoy || 0;
                document.getElementById('resumen-exito-hoy').textContent = `${data.porcentajeExitoHoy || 0}%`;
                document.getElementById('resumen-proxima').textContent = data.proximaProgramacion?.proximaEjecucion
                    ? formatearFecha(data.proximaProgramacion.proximaEjecucion)
                    : 'Sin programaciones activas';

                const banner = document.getElementById('resumen-actividad');
                banner.classList.toggle('active', Boolean(data.publicacionActiva));
                document.getElementById('resumen-actividad-titulo').textContent = data.publicacionActiva
                    ? 'Publicación en curso'
                    : 'Sin publicaciones activas';
                document.getElementById('resumen-actividad-texto').textContent = data.publicacionActiva
                    ? (data.progreso?.mensaje || 'Procesando líneas seleccionadas.')
                    : 'La cola está disponible para una nueva publicación.';
            } catch (error) {
                console.error('No se pudo cargar el resumen:', error);
            }
        }

        async function actualizarHistorial() {
            const contenedor = document.getElementById('lista-historial');
            try {
                const respuesta = await fetch('/historial?limite=100');
                const data = await respuesta.json();
                if (!data.historial?.length) {
                    contenedor.innerHTML = `<div class="empty-state"><div class="empty-state-content"><span class="empty-state-icon">${iconoSVG('history')}</span><strong>Todavía no hay publicaciones</strong><span>Los resultados aparecerán acá después del primer envío.</span></div></div>`;
                    return;
                }

                contenedor.innerHTML = data.historial.map(item => {
                    const lineasFallidas = Array.isArray(item.lineasFallidas)
                        ? item.lineasFallidas
                        : [];
                    const estadoVisual = describirEstadoHistorial(item.estado);
                    const puedeReintentar =
                        item.estado !== 'ejecutando' &&
                        lineasFallidas.some(fallo =>
                            fallo?.envioConfirmado !== true &&
                            fallo?.reintentoSeguro === true &&
                            !fallo?.reintentadaEn
                        );
                    const ritmo = describirRitmoPublicacion(item);
                    const tipoCorte = nombreCausaPublicacion(item.tipoErrorCorte);
                    return `<article class="history-item">
                        <img class="history-thumb" src="/historial/${item.id}/imagen?v=${encodeURIComponent(item.fechaInicio || '')}" alt="Estado publicado">
                        <div class="history-main">
                            <div class="history-title">
                                <strong>${escaparHTML(item.origen || 'Publicación')}</strong>
                                <span class="history-status ${estadoVisual.clase}">${iconoSVG(estadoVisual.icono)}<span>${escaparHTML(estadoVisual.texto)}</span></span>
                            </div>
                            <div class="history-meta"><span>${escaparHTML(formatearFecha(item.fechaInicio))}</span><span>${item.total || 0} líneas</span><span class="history-rhythm">${escaparHTML(ritmo.principal)}${ritmo.detalle ? ` · ${escaparHTML(ritmo.detalle)}` : ''}</span>${tipoCorte ? `<span class="result-error-type">${escaparHTML(tipoCorte)}</span>` : ''}</div>
                            <div class="history-results"><span>Correctas: <strong>${item.correctas || 0}</strong></span><span>Fallidas: <strong>${item.fallidas || 0}</strong></span>${Number(item.noProcesadas) > 0 ? `<span>No procesadas: <strong>${Number(item.noProcesadas)}</strong></span>` : ''}</div>
                            ${item.error ? `<span class="help">${escaparHTML(item.error)}</span>` : ''}
                            ${detalleFallosHistorial(lineasFallidas)}
                        </div>
                        <div class="history-actions">
                            <button type="button" class="secondary-button btn-reintentar-historial" data-id="${item.id}" data-disabled-base="${puedeReintentar ? 'false' : 'true'}" ${puedeReintentar ? '' : 'disabled'}>${iconoSVG('refresh')}<span>Reintentar fallidas</span></button>
                        </div>
                    </article>`;
                }).join('');
                actualizarAccionesPublicacion();

                document.querySelectorAll('.btn-reintentar-historial').forEach(boton => {
                    boton.addEventListener('click', async evento => {
                        const botonActual = evento.currentTarget;
                        const id = botonActual.dataset.id;
                        const claveAccion = `reintentar:${id}`;
                        const claveIdempotencia = iniciarSolicitudIdempotente(
                            claveAccion,
                            botonActual
                        );
                        if (!claveIdempotencia) return;

                        try {
                            const respuestaReintento = await fetch(
                                `/historial/${encodeURIComponent(id)}/reintentar-fallidas`,
                                {
                                    method: 'POST',
                                    headers: { 'Idempotency-Key': claveIdempotencia }
                                }
                            );
                            const datos = await exigirRespuesta(
                                respuestaReintento,
                                'No se pudo reintentar la publicación.'
                            );
                            publicacionActivaActual = true;
                            toast(datos.mensaje, 'success');
                            mostrarSeccion('estados');
                            iniciarSeguimientoProgreso();
                        } catch (error) {
                            toast(error.message, tipoToastErrorHTTP(error));
                        } finally {
                            finalizarSolicitudIdempotente(claveAccion, botonActual);
                        }
                    });
                });
            } catch (error) {
                contenedor.innerHTML = `<div class="empty-state"><strong>No se pudo cargar el historial</strong></div>`;
            }
        }

