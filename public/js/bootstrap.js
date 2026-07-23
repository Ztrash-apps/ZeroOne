        async function cargarConfiguracion() {
            try {
                const respuesta = await fetch('/configuracion');
                const data = await respuesta.json();
                configuracionActual = data;
                aplicarTemaVisual(data.temaVisual, true);
                establecerModoRitmo(
                    'config-modo-ritmo',
                    normalizarModoRitmo(data.modoRitmoPredeterminado)
                );
                document.getElementById('config-intervalo-segundos').value =
                    numeroConfigurado(data.intervaloSegundosPredeterminado, 10, 3600, 45);
                document.getElementById('config-variacion-segundos').value =
                    numeroConfigurado(data.variacionSegundosPredeterminada, 0, 30, 5);
                document.getElementById('config-lineas-grupo').value =
                    numeroConfigurado(data.lineasPorGrupoPredeterminado, 1, 10, 10);
                document.getElementById('config-intervalo').value =
                    numeroConfigurado(data.intervaloMinutosPredeterminado, 0, 1440, 5);
                document.getElementById('config-maximo-destinatarios').value =
                    numeroConfigurado(
                        data.maximoDestinatariosPorEstado,
                        1,
                        1000,
                        1000
                    );
                const limiteFallosSeguridad = numeroConfigurado(
                    data.limiteFallosSeguridad,
                    1,
                    10,
                    1
                );
                document.getElementById('config-limite-fallos').value = limiteFallosSeguridad;
                document.getElementById('config-limite-fallos-valor').textContent =
                    textoLimiteFallos(limiteFallosSeguridad);
                document.getElementById('config-notificaciones').checked = data.notificaciones !== false;
                document.getElementById('config-segundo-plano').checked =
                    data.mantenerEnSegundoPlano !== false;
                document.getElementById('config-iniciar-windows').checked =
                    data.iniciarConWindows !== false;
                document.getElementById('config-agendar-mutuos-sin-usuario').checked =
                    data.agendarMutuosSinUsuario === true;
            } catch (error) {
                toast('No se pudo cargar la configuración.', 'error');
            }
        }

        function activarPestanaConfiguracion(nombre, guardar = true) {
            const disponibles = new Set([
                'general',
                'publicacion',
                'seguridad',
                'agendamiento',
                'apariencia'
            ]);
            const activa = disponibles.has(nombre) ? nombre : 'general';

            document.querySelectorAll('[data-settings-tab]').forEach(boton => {
                const seleccionada = boton.dataset.settingsTab === activa;
                boton.classList.toggle('active', seleccionada);
                boton.setAttribute('aria-selected', String(seleccionada));
                boton.tabIndex = seleccionada ? 0 : -1;
            });
            document.querySelectorAll('[data-settings-panel]').forEach(panel => {
                const seleccionada = panel.dataset.settingsPanel === activa;
                panel.hidden = !seleccionada;
                panel.classList.toggle('active', seleccionada);
            });

            if (guardar) {
                localStorage.setItem('zeroone-settings-tab', activa);
            }
        }

        function limpiarFormularioCreacion() {
            document.getElementById('formulario').reset();
            document.getElementById('mensaje').textContent = '';
            document.getElementById('preview-imagen').style.display = 'none';
            document.getElementById('preview-imagen').removeAttribute('src');
            document.getElementById('upload-placeholder').style.display = 'grid';
            establecerModoRitmo('modo-ritmo', 'secuencial');

            if (urlPreviewActual) {
                URL.revokeObjectURL(urlPreviewActual);
                urlPreviewActual = null;
            }

            actualizarSelectorTodosDias('dias-programados');
        }

        document.querySelectorAll('.nav-button').forEach(boton => {
            boton.addEventListener('click', () => {
                mostrarSeccion(boton.dataset.section);
            });
        });

        window.addEventListener('hashchange', () => {
            const nombre = location.hash.replace(/^#/, '') || 'dashboard';
            mostrarSeccion(nombre, { actualizarHash: false });
        });

        document.getElementById('agenda-line-button').addEventListener('click', evento => {
            evento.stopPropagation();
            alternarPickerAgendamiento(document.getElementById('agenda-line-picker'));
        });

        document.getElementById('agenda-account-button').addEventListener('click', evento => {
            evento.stopPropagation();
            alternarPickerAgendamiento(document.getElementById('agenda-account-picker'));
        });

        document.getElementById('agenda-line-menu').addEventListener('click', evento => {
            const opcion = evento.target.closest('[data-agenda-linea-id]');
            if (!opcion) return;
            evento.stopPropagation();
            const id = String(opcion.dataset.agendaLineaId || '').trim();
            if (!id) return;

            agendaLineaId = id;
            agendaCuentaId = null;
            agendaSecuencia += 1;
            agendaFirmaLineas = '';
            agendaFirmaCuentas = '';
            cerrarSelectoresAgendamiento();
            renderizarAgendamiento({
                credencialesConfiguradas: agendaEstado?.credencialesConfiguradas === true,
                cuentas: agendaEstado?.cuentas || [],
                busqueda: agendaEstado?.busqueda || { palabrasClave: ['Usuario:'] },
                lineaId: id,
                cuentaId: null,
                resumen: {},
                proceso: {},
                candidatos: [],
                ia: agendaEstado?.ia || {}
            });
            actualizarAgendamiento(true);
        });

        document.getElementById('agenda-account-menu').addEventListener('click', evento => {
            const opcion = evento.target.closest('[data-agenda-cuenta-id]');
            if (!opcion) return;
            evento.stopPropagation();
            seleccionarCuentaAgendamiento(
                String(opcion.dataset.agendaCuentaId || '').trim()
            );
        });

        document.getElementById('btn-agenda-credentials').onclick = () => {
            document.getElementById('agenda-google-credentials-file').click();
        };

        document.getElementById('agenda-google-credentials-file').addEventListener('change', evento => {
            guardarCredencialesAgendamiento(evento.target.files?.[0]);
        });

        document.getElementById('btn-agenda-connect-google').onclick = () => {
            conectarGoogleAgendamiento();
        };

        document.getElementById('btn-agenda-refresh').onclick = () => {
            actualizarAgendamiento(true);
        };

        document.getElementById('btn-agenda-ai-download').onclick = () => {
            cambiarModeloAgendamientoIA('descargar');
        };

        document.getElementById('btn-agenda-ai-pause').onclick = () => {
            cambiarModeloAgendamientoIA('pausar');
        };

        document.getElementById('btn-agenda-ai-delete').onclick = () => {
            cambiarModeloAgendamientoIA('eliminar');
        };

        document.getElementById('btn-agenda-ai-analyze').onclick = () => {
            cambiarAnalisisAgendamientoIA('analizar');
        };

        document.getElementById('btn-agenda-ai-stop').onclick = () => {
            cambiarAnalisisAgendamientoIA('detener');
        };

        document.getElementById('agenda-ai-review-list').addEventListener('click', evento => {
            const boton = evento.target.closest('[data-agenda-ai-review-action]');
            if (!boton) return;
            const fila = boton.closest('[data-agenda-ai-review-id]');
            if (!fila) return;
            resolverRevisionAgendamientoIA(
                String(fila.dataset.agendaAiReviewId || ''),
                String(boton.dataset.agendaAiReviewAction || ''),
                fila
            );
        });

        document.getElementById('btn-agenda-keywords').onclick = () => {
            abrirPalabrasClaveAgendamiento();
        };
        document.getElementById('btn-config-agenda-keywords').onclick = () => {
            abrirPalabrasClaveDesdeConfiguracion();
        };

        document.getElementById('agenda-palabras-texto').addEventListener(
            'input',
            actualizarContadorPalabrasAgenda
        );

        document.getElementById('btn-guardar-agenda-palabras').onclick = () => {
            guardarPalabrasClaveAgendamiento();
        };

        document.getElementById('btn-cancelar-agenda-palabras').onclick =
            cerrarPalabrasClaveAgendamiento;
        document.getElementById('cerrar-modal-agenda-palabras').onclick =
            cerrarPalabrasClaveAgendamiento;
        document.getElementById('modal-agenda-palabras').addEventListener(
            'click',
            evento => {
                if (evento.target.id === 'modal-agenda-palabras') {
                    cerrarPalabrasClaveAgendamiento();
                }
            }
        );

        document.getElementById('btn-agenda-start').onclick = () => {
            cambiarProcesoAgendamiento('iniciar');
        };

        document.getElementById('btn-agenda-stop').onclick = () => {
            cambiarProcesoAgendamiento('detener');
        };

        document.addEventListener('click', evento => {
            if (!evento.target.closest('.agenda-picker')) cerrarSelectoresAgendamiento();
        });

        document.addEventListener('keydown', evento => {
            if (evento.key !== 'Escape') return;
            const modalPalabras =
                document.getElementById('modal-agenda-palabras');
            if (modalPalabras.classList.contains('open')) {
                evento.preventDefault();
                cerrarPalabrasClaveAgendamiento();
                return;
            }
            const abierto = document.querySelector('.agenda-picker.open');
            if (!abierto) return;
            cerrarSelectoresAgendamiento();
            abierto.querySelector('.agenda-picker-button')?.focus({ preventScroll: true });
        });

        document.querySelectorAll('[data-line-view]').forEach(boton => {
            boton.addEventListener('click', () => {
                vistaLineas = boton.dataset.lineView;
                renderizarLineasConectadas(cacheLineasSeccion);
            });
        });

        document.querySelectorAll('[data-pending-line-view]').forEach(boton => {
            boton.addEventListener('click', () => {
                vistaLineasPendientes = boton.dataset.pendingLineView;
                aplicarVistaLineasPendientes();
            });
        });

        document.querySelectorAll('[data-active-status-view]').forEach(boton => {
            boton.addEventListener('click', () => {
                vistaEstadosActivos = boton.dataset.activeStatusView;
                aplicarVistaEstadosActivos();
            });
        });

        document.getElementById('btn-orden-lineas').addEventListener('click', evento => {
            evento.stopPropagation();
            document.getElementById('selector-orden-lineas-subida').classList.remove('open');
            document.getElementById('btn-orden-lineas-subida').setAttribute('aria-expanded', 'false');
            const selector = document.getElementById('selector-orden-lineas');
            const abierto = selector.classList.toggle('open');
            evento.currentTarget.setAttribute('aria-expanded', String(abierto));
        });

        document.getElementById('btn-orden-lineas-subida').addEventListener('click', evento => {
            evento.stopPropagation();
            document.getElementById('selector-orden-lineas').classList.remove('open');
            document.getElementById('btn-orden-lineas').setAttribute('aria-expanded', 'false');
            const selector = document.getElementById('selector-orden-lineas-subida');
            const abierto = selector.classList.toggle('open');
            evento.currentTarget.setAttribute('aria-expanded', String(abierto));
        });

        document.querySelectorAll('[data-line-order]').forEach(opcion => {
            opcion.addEventListener('click', () => {
                ordenLineas = opcion.dataset.lineOrder;
                document.getElementById('selector-orden-lineas').classList.remove('open');
                document.getElementById('btn-orden-lineas').setAttribute('aria-expanded', 'false');
                renderizarLineasConectadas(cacheLineasSeccion);
            });
        });

        document.querySelectorAll('[data-upload-line-order]').forEach(opcion => {
            opcion.addEventListener('click', () => {
                ordenLineasSubida = opcion.dataset.uploadLineOrder;
                document.getElementById('selector-orden-lineas-subida').classList.remove('open');
                document.getElementById('btn-orden-lineas-subida').setAttribute('aria-expanded', 'false');
                actualizarLineas();
            });
        });

        document.addEventListener('click', evento => {
            if (evento.target.closest('.line-order-picker')) return;
            document.getElementById('selector-orden-lineas').classList.remove('open');
            document.getElementById('btn-orden-lineas').setAttribute('aria-expanded', 'false');
            document.getElementById('selector-orden-lineas-subida').classList.remove('open');
            document.getElementById('btn-orden-lineas-subida').setAttribute('aria-expanded', 'false');
        });

        document.getElementById('btn-direccion-lineas').onclick = () => {
            direccionLineas = direccionLineas === 'asc' ? 'desc' : 'asc';
            renderizarLineasConectadas(cacheLineasSeccion);
        };

        document.getElementById('btn-direccion-lineas-subida').onclick = () => {
            direccionLineasSubida = direccionLineasSubida === 'asc' ? 'desc' : 'asc';
            actualizarLineas();
        };

        document
            .getElementById('lista-lineas-conectadas')
            .addEventListener('click', manejarClickLineasConectadas);
        document
            .getElementById('lista-lineas-conectadas')
            .addEventListener('change', manejarCambioSeleccionEliminarLinea);

        document
            .getElementById('lista-lineas-pendientes')
            .addEventListener('click', manejarClickLineasPendientes);
        document
            .getElementById('lista-lineas-pendientes')
            .addEventListener('change', manejarCambioSeleccionEliminarLinea);

        [
            {
                grupo: 'pendientes',
                selectorId: 'seleccionar-todas-eliminar-pendientes',
                botonId: 'btn-eliminar-pendientes-seleccionadas'
            },
            {
                grupo: 'conectadas',
                selectorId: 'seleccionar-todas-eliminar-conectadas',
                botonId: 'btn-eliminar-conectadas-seleccionadas'
            }
        ].forEach(configuracion => {
            document
                .getElementById(configuracion.selectorId)
                .addEventListener('change', function () {
                    const ids = lineasDisponiblesParaEliminar(
                        configuracion.grupo
                    ).map(linea => linea.id);
                    if (this.checked) {
                        ids.forEach(id => lineasSeleccionadasEliminar.add(id));
                    } else {
                        ids.forEach(id => lineasSeleccionadasEliminar.delete(id));
                    }
                    actualizarControlesEliminacionLineas();
                });

            document
                .getElementById(configuracion.botonId)
                .addEventListener(
                    'click',
                    () => eliminarSeleccionLineas(configuracion.grupo)
                );
        });

        document.querySelectorAll('.view-button').forEach(boton => {
            boton.addEventListener('click', () => {
                vistaProgramaciones = boton.dataset.view;

                document.querySelectorAll('.view-button').forEach(item => {
                    item.classList.toggle(
                        'active',
                        item === boton
                    );
                });

                actualizarProgramaciones();
            });
        });

        document.getElementById('btn-nuevo-estado').onclick = async () => {
            if (seccionActual === 'lineas') {
                const entrada = document.getElementById('nombre-linea');
                entrada.scrollIntoView({ behavior: 'smooth', block: 'center' });
                setTimeout(() => entrada.focus(), 260);
                return;
            }

            if (!configuracionActual) await cargarConfiguracion();
            if (configuracionActual) {
                establecerModoRitmo(
                    'modo-ritmo',
                    normalizarModoRitmo(configuracionActual.modoRitmoPredeterminado)
                );
                document.getElementById('intervalo-segundos').value =
                    numeroConfigurado(configuracionActual.intervaloSegundosPredeterminado, 10, 3600, 45);
                document.getElementById('variacion-segundos').value =
                    numeroConfigurado(configuracionActual.variacionSegundosPredeterminada, 0, 30, 5);
                document.getElementById('lineas-por-grupo').value =
                    numeroConfigurado(configuracionActual.lineasPorGrupoPredeterminado, 1, 10, 10);
                document.getElementById('intervalo-minutos').value =
                    numeroConfigurado(configuracionActual.intervaloMinutosPredeterminado, 0, 1440, 5);
            } else {
                establecerModoRitmo('modo-ritmo', 'secuencial');
            }
            actualizarCantidadSeleccionadas();
            actualizarLineas();
            abrirModal('modal-crear');
        };

        document.getElementById('cerrar-modal-crear').onclick = () => {
            cerrarModal('modal-crear');
        };

        document.getElementById('modal-crear').addEventListener(
            'click',
            evento => {
                if (evento.target.id === 'modal-crear') {
                    cerrarModal('modal-crear');
                }
            }
        );

        document.getElementById('foto').addEventListener('change', evento => {
            const archivo = evento.target.files[0];
            const preview = document.getElementById('preview-imagen');
            const placeholder =
                document.getElementById('upload-placeholder');

            if (urlPreviewActual) {
                URL.revokeObjectURL(urlPreviewActual);
                urlPreviewActual = null;
            }

            if (!archivo) {
                preview.style.display = 'none';
                placeholder.style.display = 'grid';
                return;
            }

            urlPreviewActual = URL.createObjectURL(archivo);
            preview.src = urlPreviewActual;
            preview.style.display = 'block';
            placeholder.style.display = 'none';
        });

        document.getElementById('editar-foto').addEventListener('change', evento => {
            const archivo = evento.target.files[0];
            const imagen = document.getElementById('editar-imagen-actual');
            const nombre = document.getElementById('editar-foto-nombre');

            if (urlPreviewEdicion) {
                URL.revokeObjectURL(urlPreviewEdicion);
                urlPreviewEdicion = null;
            }

            if (!archivo) {
                nombre.textContent = 'Ningún archivo nuevo seleccionado';
                return;
            }

            urlPreviewEdicion = URL.createObjectURL(archivo);
            imagen.src = urlPreviewEdicion;
            nombre.textContent = archivo.name;
        });

        document.getElementById('btn-conectar').onclick = async () => {
            const input = document.getElementById('nombre-linea');
            const mensaje = document.getElementById('mensaje-linea');
            const nombre = input.value.trim();

            if (!nombre) {
                mensaje.textContent =
                    'Escribí un nombre para identificar la línea.';
                mensaje.style.color = 'var(--danger)';
                return;
            }

            mensaje.textContent = 'Creando línea...';
            mensaje.style.color = 'var(--warning)';

            try {
                const respuesta = await fetch('/lineas', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ nombre })
                });

                const data = await respuesta.json();

                if (!respuesta.ok) {
                    throw new Error(data.error);
                }

                input.value = '';
                mensaje.textContent = '';
                prepararAperturaQr(data.id);
                toast(`Línea "${data.nombre}" creada. Preparando QR...`, 'success');
                actualizarLineas();
            } catch (error) {
                mensaje.textContent =
                    error.message || 'No se pudo crear la línea.';
                mensaje.style.color = 'var(--danger)';
            }
        };

        document.getElementById('cuenta-linea')?.addEventListener('change', evento => {
            const selector = evento.currentTarget;
            if (selector.value !== '__gestionar_google__') return;

            selector.value = '';
            mostrarSeccion('agendamiento');
            toast('Configurá o conectá una cuenta de Google y luego volvé a Líneas.', 'info');
            requestAnimationFrame(() => {
                const destino = agendaEstado?.credencialesConfiguradas === true
                    ? document.getElementById('btn-agenda-connect-google')
                    : document.getElementById('btn-agenda-credentials');
                destino?.focus({ preventScroll: true });
            });
        });

        const botonConectarLinea = document.getElementById('btn-conectar');
        botonConectarLinea.onclick = null;
        botonConectarLinea.addEventListener('click', async () => {
            const input = document.getElementById('nombre-linea');
            const selectorCuenta = document.getElementById('cuenta-linea');
            const mensaje = document.getElementById('mensaje-linea');
            const nombre = input.value.trim();
            const cuentaId = selectorCuenta
                ? String(selectorCuenta.value || '').trim()
                : '';

            if (!nombre) {
                mensaje.textContent = 'Escribí un nombre para identificar la línea.';
                mensaje.style.color = 'var(--danger)';
                return;
            }

            mensaje.textContent = 'Creando línea...';
            mensaje.style.color = 'var(--warning)';

            try {
                const respuesta = await fetch('/lineas', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        nombre,
                        ...(cuentaId ? { cuentaId } : {})
                    })
                });

                const data = await respuesta.json();

                if (!respuesta.ok) {
                    throw new Error(data.error);
                }

                input.value = '';
                if (selectorCuenta) selectorCuenta.value = '';
                mensaje.textContent = '';
                prepararAperturaQr(data.id);
                toast(`Línea "${data.nombre}" creada. Preparando QR...`, 'success');
                if (data.cuentaAsociacion && data.cuentaAsociacion.ok === false) {
                    mensaje.textContent =
                        `Línea creada. ${data.cuentaAsociacion.error || 'No se pudo asignar la cuenta de Google.'}`;
                    mensaje.style.color = 'var(--warning)';
                }
                actualizarLineas();
            } catch (error) {
                mensaje.textContent =
                    error.message || 'No se pudo crear la línea.';
                mensaje.style.color = 'var(--danger)';
            }
        });

        document.getElementById('buscar-lineas').addEventListener(
            'input',
            debounce(actualizarLineas, 180)
        );

        document.getElementById('lista-lineas').addEventListener(
            'change',
            evento => {
                const checkbox = evento.target.closest('.seleccionar-linea');
                if (!checkbox) return;
                if (checkbox.checked) {
                    lineasSeleccionadas.add(checkbox.value);
                } else {
                    lineasSeleccionadas.delete(checkbox.value);
                }
                actualizarCheckboxGeneral();
            }
        );

        document.getElementById('lista-estados-activos').addEventListener(
            'click',
            evento => {
                const botonEliminar = evento.target.closest(
                    '.btn-eliminar-estado-activo'
                );
                if (botonEliminar) {
                    evento.stopPropagation();
                    eliminarEstadoActivo(botonEliminar.dataset.id);
                    return;
                }
                if (evento.target.closest('button, a, input, select, textarea')) return;
                const tarjeta = evento.target.closest(
                    '[data-active-publication-id]'
                );
                if (tarjeta) {
                    abrirVisualizacionesEstado(
                        tarjeta.dataset.activePublicationId
                    );
                }
            }
        );
        document.getElementById('lista-estados-activos').addEventListener(
            'keydown',
            evento => {
                if (!['Enter', ' '].includes(evento.key)) return;
                const tarjeta = evento.target.closest(
                    '[data-active-publication-id]'
                );
                if (!tarjeta || evento.target.closest('button, a, input, select, textarea')) {
                    return;
                }
                evento.preventDefault();
                abrirVisualizacionesEstado(
                    tarjeta.dataset.activePublicationId
                );
            }
        );

        document.getElementById('buscar-lineas-seccion').addEventListener(
            'input',
            debounce(() => {
                renderizarLineasConectadas(cacheLineasSeccion);
            }, 100)
        );

        document.getElementById('btn-limpiar-busqueda-seccion').onclick = () => {
            document.getElementById('buscar-lineas-seccion').value = '';
            vistaLineas = 'large';
            ordenLineas = 'conexion';
            direccionLineas = 'asc';
            renderizarLineasConectadas(cacheLineasSeccion);
            document.getElementById('buscar-lineas-seccion').focus();
        };

        document.getElementById('btn-limpiar-busqueda').onclick = () => {
            document.getElementById('buscar-lineas').value = '';
            document.getElementById('buscar-lineas').focus();
            actualizarLineas();
        };

        document.getElementById('seleccionar-todas').addEventListener(
            'change',
            function () {
                if (this.checked) {
                    idsLineasConectadas.forEach(id => {
                        lineasSeleccionadas.add(id);
                    });
                } else {
                    idsLineasConectadas.forEach(id => {
                        lineasSeleccionadas.delete(id);
                    });
                }

                document
                    .querySelectorAll('.seleccionar-linea:not(:disabled)')
                    .forEach(checkbox => {
                        checkbox.checked =
                            lineasSeleccionadas.has(checkbox.value);
                    });

                actualizarCheckboxGeneral();
            }
        );

        document.getElementById('formulario').onsubmit = async evento => {
            evento.preventDefault();

            const mensaje = document.getElementById('mensaje');
            const boton = document.getElementById('btn-publicar');
            const claveAccion = 'subir';
            let claveIdempotencia = null;

            try {
                const datos = validarDatosFormulario(false);
                claveIdempotencia = iniciarSolicitudIdempotente(claveAccion, boton);
                if (!claveIdempotencia) return;

                mensaje.textContent = 'Optimizando imagen y preparando publicación...';
                mensaje.style.color = 'var(--warning)';

                const respuesta = await fetch('/subir', {
                    method: 'POST',
                    headers: { 'Idempotency-Key': claveIdempotencia },
                    body: crearFormData(datos, false)
                });

                const data = await exigirRespuesta(
                    respuesta,
                    'No se pudo iniciar la publicación.'
                );

                mensaje.textContent = '';
                publicacionActivaActual = true;
                toast(
                    data.mensaje || 'Publicación iniciada.',
                    'success'
                );

                cerrarModal('modal-crear');
                mostrarSeccion('estados');
                iniciarSeguimientoProgreso();
            } catch (error) {
                mensaje.textContent = error.message;
                mensaje.style.color = [409, 429].includes(Number(error?.httpStatus))
                    ? 'var(--warning)'
                    : 'var(--danger)';
            } finally {
                if (claveIdempotencia) {
                    finalizarSolicitudIdempotente(claveAccion, boton);
                }
            }
        };

        document.getElementById('btn-programar').onclick = async () => {
            const mensaje = document.getElementById('mensaje');
            const boton = document.getElementById('btn-programar');
            const claveAccion = 'programar';
            let claveIdempotencia = null;

            try {
                const datos = validarDatosFormulario(true);
                claveIdempotencia = iniciarSolicitudIdempotente(claveAccion, boton);
                if (!claveIdempotencia) return;

                mensaje.textContent = 'Optimizando imagen y guardando programación...';
                mensaje.style.color = 'var(--warning)';

                const respuesta = await fetch('/programar', {
                    method: 'POST',
                    headers: { 'Idempotency-Key': claveIdempotencia },
                    body: crearFormData(datos, true)
                });

                const data = await exigirRespuesta(
                    respuesta,
                    'No se pudo programar el estado.'
                );

                mensaje.textContent = '';
                toast(
                    data.mensaje || 'Estado programado correctamente.',
                    'success'
                );

                cerrarModal('modal-crear');
                limpiarFormularioCreacion();
                mostrarSeccion('dashboard');
                actualizarProgramaciones();
            } catch (error) {
                mensaje.textContent = error.message;
                mensaje.style.color = [409, 429].includes(Number(error?.httpStatus))
                    ? 'var(--warning)'
                    : 'var(--danger)';
            } finally {
                if (claveIdempotencia) {
                    finalizarSolicitudIdempotente(claveAccion, boton);
                }
            }
        };

        document.getElementById('btn-guardar-edicion').onclick = async () => {
            const id = document.getElementById('editar-id').value;
            const hora = document.getElementById('editar-hora').value;
            const texto = document.getElementById('editar-texto').value;
            const archivo = document.getElementById('editar-foto').files[0];
            const diasSemana = obtenerDiasSeleccionados('editar-dias-programados');
            const activa = document.getElementById('editar-activa').checked;
            const mensaje = document.getElementById('mensaje-edicion');
            const boton = document.getElementById('btn-guardar-edicion');

            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) {
                mensaje.textContent = 'Elegí una hora válida.';
                mensaje.style.color = 'var(--danger)';
                return;
            }

            if (!diasSemana.length) {
                mensaje.textContent = 'Seleccioná al menos un día de la semana.';
                mensaje.style.color = 'var(--danger)';
                return;
            }

            const formData = new FormData();
            formData.append('hora', hora);
            formData.append('texto', texto);
            formData.append('diasSemana', JSON.stringify(diasSemana));
            formData.append('activa', String(activa));

            if (archivo) {
                formData.append('imagen', archivo);
            }

            try {
                boton.disabled = true;
                mensaje.textContent = archivo
                    ? 'Optimizando imagen y guardando cambios...'
                    : 'Guardando cambios...';
                mensaje.style.color = 'var(--warning)';

                const respuesta = await fetch(
                    `/programaciones/${id}`,
                    {
                        method: 'PUT',
                        body: formData
                    }
                );

                const data = await leerRespuesta(respuesta);

                if (!respuesta.ok) {
                    throw new Error(
                        data.error ||
                        'No se pudo actualizar la programación.'
                    );
                }

                mensaje.textContent = '';
                toast(
                    data.mensaje || 'Programación actualizada.',
                    'success'
                );

                cerrarEditorProgramacion();
                actualizarProgramaciones();
            } catch (error) {
                mensaje.textContent = error.message;
                mensaje.style.color = 'var(--danger)';
            } finally {
                boton.disabled = false;
            }
        };

        async function ejecutarAccionSeguridad(accion) {
            const botonReanudar = document.getElementById('btn-reanudar-seguridad');
            const botonCancelar = document.getElementById('btn-cancelar-seguridad');

            botonReanudar.disabled = true;
            botonCancelar.disabled = true;

            try {
                const respuesta = await fetch(
                    `/progreso/${accion}`,
                    { method: 'POST' }
                );
                const data = await leerRespuesta(respuesta);

                if (!respuesta.ok) {
                    throw new Error(
                        data.error || 'No se pudo procesar la decisión.'
                    );
                }

                toast(data.mensaje || 'Decisión aplicada.', 'success');
                actualizarProgresoPublicacion();
            } catch (error) {
                toast(error.message, 'error');
            } finally {
                botonReanudar.disabled = false;
                botonCancelar.disabled = false;
            }
        }

        document.getElementById('btn-reconectar-todas').onclick = async () => {
            if (publicacionActivaActual) {
                toast(
                    'Esperá a que termine la publicación o usá Alto total antes de reconectar.',
                    'warning'
                );
                actualizarAccionesPublicacion();
                return;
            }

            try {
                const respuesta = await fetch('/lineas/reconectar-todas', { method: 'POST' });
                const data = await leerRespuesta(respuesta);
                if (!respuesta.ok) throw new Error(data.error || 'No se pudo iniciar la reconexión.');
                toast(data.mensaje, 'success');
                setTimeout(actualizarLineas, 700);
            } catch (error) { toast(error.message, 'error'); }
        };

        document.getElementById('btn-actualizar-activos').onclick = () => {
            actualizarEstadosActivos(false);
        };

        document.getElementById('btn-guardar-linea').onclick = async () => {
            const id = lineaEditandoId || document.getElementById('editar-linea-id').value;
            const nombre = document.getElementById('editar-linea-nombre').value.trim();
            const mensaje = document.getElementById('mensaje-editar-linea');
            const boton = document.getElementById('btn-guardar-linea');

            if (!id || !nombre) {
                mensaje.textContent = 'Escribí un nombre válido para la línea.';
                mensaje.style.color = 'var(--danger)';
                return;
            }

            try {
                boton.disabled = true;
                mensaje.textContent = 'Guardando cambios...';
                mensaje.style.color = 'var(--warning)';
                const respuesta = await fetch(`/lineas/${encodeURIComponent(id)}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ nombre })
                });
                const data = await leerRespuesta(respuesta);
                if (!respuesta.ok) {
                    throw new Error(data.error || data.mensaje || 'No se pudo editar la línea.');
                }

                cerrarEditorLinea();
                toast(data.mensaje || 'Línea actualizada.', 'success');
                actualizarLineas();
            } catch (error) {
                mensaje.textContent = error.message;
                mensaje.style.color = 'var(--danger)';
            } finally {
                boton.disabled = false;
            }
        };

        document.getElementById('btn-cancelar-editar-linea').onclick = cerrarEditorLinea;
        document.getElementById('cerrar-modal-editar-linea').onclick = cerrarEditorLinea;
        document.getElementById('modal-editar-linea').addEventListener('click', evento => {
            if (evento.target.id === 'modal-editar-linea') cerrarEditorLinea();
        });
        document.getElementById('editar-linea-nombre').addEventListener('keydown', evento => {
            if (evento.key === 'Enter') {
                evento.preventDefault();
                document.getElementById('btn-guardar-linea').click();
            }
        });

        document.getElementById('btn-actualizar-historial').onclick = actualizarHistorial;
        document.querySelectorAll('[data-settings-tab]').forEach(boton => {
            boton.addEventListener('click', () => {
                activarPestanaConfiguracion(boton.dataset.settingsTab);
            });
            boton.addEventListener('keydown', evento => {
                if (!['ArrowLeft', 'ArrowRight'].includes(evento.key)) return;
                evento.preventDefault();
                const botones = [...document.querySelectorAll('[data-settings-tab]')];
                const actual = botones.indexOf(boton);
                const direccion = evento.key === 'ArrowRight' ? 1 : -1;
                const siguiente = botones[
                    (actual + direccion + botones.length) % botones.length
                ];
                activarPestanaConfiguracion(siguiente.dataset.settingsTab);
                siguiente.focus();
            });
        });
        activarPestanaConfiguracion(
            localStorage.getItem('zeroone-settings-tab') || 'general',
            false
        );
        ['config-modo-ritmo', 'modo-ritmo'].forEach(nombre => {
            document.querySelectorAll(`input[name="${nombre}"]`).forEach(radio => {
                radio.addEventListener('change', () => {
                    if (radio.checked) establecerModoRitmo(nombre, radio.value);
                });
            });
        });
        document.getElementById('config-limite-fallos').addEventListener('input', evento => {
            document.getElementById('config-limite-fallos-valor').textContent =
                textoLimiteFallos(evento.target.value);
        });

        document.getElementById('btn-guardar-configuracion').onclick = async () => {
            try {
                const modoRitmoPredeterminado = obtenerModoRitmo('config-modo-ritmo');
                let intervaloSegundosPredeterminado = Number(
                    document.getElementById('config-intervalo-segundos').value
                );
                let variacionSegundosPredeterminada = Number(
                    document.getElementById('config-variacion-segundos').value
                );
                let lineasPorGrupoPredeterminado = Number(
                    document.getElementById('config-lineas-grupo').value
                );
                let intervaloMinutosPredeterminado = Number(
                    document.getElementById('config-intervalo').value
                );
                const maximoDestinatariosPorEstado = Number(
                    document.getElementById('config-maximo-destinatarios').value
                );
                const temaVisual = normalizarTemaVisual(
                    document.querySelector('input[name="config-tema-visual"]:checked')?.value
                );

                const segundosValidos = Number.isInteger(intervaloSegundosPredeterminado) && intervaloSegundosPredeterminado >= 10 && intervaloSegundosPredeterminado <= 3600;
                const variacionValida = Number.isInteger(variacionSegundosPredeterminada) && variacionSegundosPredeterminada >= 0 && variacionSegundosPredeterminada <= 30 && variacionSegundosPredeterminada <= intervaloSegundosPredeterminado;
                const grupoValido = Number.isInteger(lineasPorGrupoPredeterminado) && lineasPorGrupoPredeterminado >= 1 && lineasPorGrupoPredeterminado <= 10;
                const minutosValidos = Number.isFinite(intervaloMinutosPredeterminado) && intervaloMinutosPredeterminado >= 0 && intervaloMinutosPredeterminado <= 1440;
                const destinatariosValidos = Number.isInteger(maximoDestinatariosPorEstado) && maximoDestinatariosPorEstado >= 1 && maximoDestinatariosPorEstado <= 1000;

                if (modoRitmoPredeterminado === 'secuencial' && !segundosValidos) {
                    throw new Error('El intervalo secuencial debe estar entre 10 y 3600 segundos.');
                }
                if (modoRitmoPredeterminado === 'secuencial' && !variacionValida) {
                    throw new Error('La variación debe estar entre 0 y 30 segundos y no superar el intervalo base.');
                }
                if (modoRitmoPredeterminado === 'grupos' && !grupoValido) {
                    throw new Error('Las líneas por grupo deben estar entre 1 y 10.');
                }
                if (modoRitmoPredeterminado === 'grupos' && !minutosValidos) {
                    throw new Error('El intervalo entre grupos debe estar entre 0 y 1440 minutos.');
                }
                if (!destinatariosValidos) {
                    throw new Error('Los destinatarios por estado deben estar entre 1 y 1.000.');
                }

                if (!segundosValidos) intervaloSegundosPredeterminado = 45;
                if (!variacionValida) variacionSegundosPredeterminada = 5;
                if (!grupoValido) lineasPorGrupoPredeterminado = 10;
                if (!minutosValidos) intervaloMinutosPredeterminado = 5;

                const respuesta = await fetch('/configuracion', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        modoRitmoPredeterminado,
                        intervaloSegundosPredeterminado,
                        variacionSegundosPredeterminada,
                        lineasPorGrupoPredeterminado,
                        intervaloMinutosPredeterminado,
                        maximoDestinatariosPorEstado,
                        temaVisual,
                        limiteFallosSeguridad: Number(
                            document.getElementById('config-limite-fallos').value
                        ),
                        notificaciones: document.getElementById('config-notificaciones').checked,
                        mantenerEnSegundoPlano:
                            document.getElementById('config-segundo-plano').checked,
                        iniciarConWindows:
                            document.getElementById('config-iniciar-windows').checked,
                        agendarMutuosSinUsuario:
                            document.getElementById(
                                'config-agendar-mutuos-sin-usuario'
                            ).checked
                    })
                });
                const data = await leerRespuesta(respuesta);
                if (!respuesta.ok) throw new Error(data.error || 'No se pudo guardar.');
                configuracionActual = data.configuracion;
                aplicarTemaVisual(data.configuracion.temaVisual, true);
                toast(data.mensaje, 'success');
            } catch (error) {
                aplicarTemaVisual(configuracionActual?.temaVisual, true);
                toast(error.message, 'error');
            }
        };

        document.getElementById('btn-probar-notificacion').onclick = async () => {
            if (window.sistema?.notificar) {
                await window.sistema.notificar('ZeroOne', 'Las notificaciones están funcionando correctamente.');
                toast('Notificación enviada.', 'success');
            } else {
                toast('Las notificaciones solo están disponibles en la aplicación instalada.', 'error');
            }
        };

        document.getElementById('btn-alto-total').onclick = async () => {
            if (!publicacionActivaActual || altoTotalSolicitado) return;

            const confirmarAlto = await solicitarConfirmacion({
                titulo: 'Alto total',
                mensaje: 'Las líneas que todavía no comenzaron se cancelarán. Si un envío ya está en curso, se esperará su respuesta para guardar el ID y luego se detendrá.',
                textoConfirmar: 'Detener todo',
                icono: 'stop'
            });
            if (!confirmarAlto) return;

            altoTotalSolicitado = true;
            actualizarAccionesPublicacion();

            try {
                const respuesta = await fetch('/progreso/alto-total', {
                    method: 'POST'
                });
                const data = await exigirRespuesta(
                    respuesta,
                    'No se pudo aplicar el Alto total.'
                );

                if (data.habiaTrabajo === false) {
                    publicacionActivaActual = false;
                    altoTotalSolicitado = false;
                }

                toast(data.mensaje, data.habiaTrabajo === false ? 'info' : 'warning');
                iniciarSeguimientoProgreso();
            } catch (error) {
                altoTotalSolicitado = false;
                toast(error.message, tipoToastErrorHTTP(error));
            } finally {
                actualizarAccionesPublicacion();
            }
        };

        document.getElementById('btn-reanudar-seguridad').onclick = () => {
            ejecutarAccionSeguridad('reanudar');
        };

        document.getElementById('btn-cancelar-seguridad').onclick = async () => {
            const confirmado = await solicitarConfirmacion({
                titulo: 'Cancelar líneas restantes',
                mensaje: 'Las líneas que aún no se procesaron se cancelarán para esta publicación.',
                textoConfirmar: 'Cancelar restantes',
                icono: 'stop'
            });
            if (confirmado) ejecutarAccionSeguridad('cancelar');
        };

        document.getElementById('btn-cancelar-edicion').onclick =
            cerrarEditorProgramacion;

        document.getElementById('cerrar-modal-editar').onclick =
            cerrarEditorProgramacion;

        document.getElementById('modal-editar').addEventListener(
            'click',
            evento => {
                if (evento.target.id === 'modal-editar') {
                    cerrarEditorProgramacion();
                }
            }
        );

        document.addEventListener('click', evento => {
            if (evento.target.closest('.tag-picker')) return;

            if (selectorEtiquetaAbiertoId !== null) {
                selectorEtiquetaAbiertoId = null;
                document.querySelectorAll('.tag-picker.open').forEach(picker => {
                    picker.classList.remove('open');
                    picker.querySelector('.tag-picker-button')
                        ?.setAttribute('aria-expanded', 'false');
                });
            }
        });

        function mostrarEstadoActualizacion(estado) {
            const version = document.getElementById('update-version');
            const versionSidebar = document.getElementById('sidebar-app-version');
            const mensaje = document.getElementById('update-message');
            const progreso = document.getElementById('update-progress');
            const barra = document.getElementById('update-progress-bar');
            const botonBuscar = document.getElementById('btn-update-search');
            const botonDescargar = document.getElementById('btn-update-download');
            const botonInstalar = document.getElementById('btn-update-install');

            const versionActual = estado.versionActual || '1.5.2';
            version.textContent = `v${versionActual}`;
            if (versionSidebar) versionSidebar.textContent = `ZeroOne ${versionActual}`;
            mensaje.textContent = estado.mensaje || 'Estado de actualización no disponible.';

            const porcentaje = Math.max(0, Math.min(100, Number(estado.porcentaje) || 0));
            barra.style.width = `${porcentaje}%`;
            progreso.classList.toggle(
                'visible',
                ['descargando', 'descargada'].includes(estado.estado)
            );

            botonBuscar.disabled = ['buscando', 'descargando', 'instalando'].includes(
                estado.estado
            );
            botonBuscar.innerHTML = estado.estado === 'buscando'
                ? `${iconoSVG('loader', 'spin')}<span>Buscando...</span>`
                : `${iconoSVG('update')}<span>Buscar actualización</span>`;

            botonDescargar.hidden = estado.estado !== 'disponible';
            botonDescargar.disabled = estado.estado !== 'disponible';

            botonInstalar.hidden = estado.estado !== 'descargada';
            botonInstalar.disabled = estado.estado !== 'descargada';
        }

        const puenteActualizador = window.actualizador || null;
        let dejarDeEscucharActualizador = null;

        async function consultarEstadoActualizacion() {
            try {
                if (
                    puenteActualizador &&
                    typeof puenteActualizador.obtenerEstado === 'function'
                ) {
                    const data = await puenteActualizador.obtenerEstado();
                    mostrarEstadoActualizacion(data);
                    return;
                }

                const respuesta = await fetch('/actualizacion/estado');
                const data = await leerRespuesta(respuesta);

                if (!respuesta.ok) {
                    throw new Error(
                        data.error || data.mensaje || 'No se pudo consultar la actualización.'
                    );
                }

                mostrarEstadoActualizacion(data);
            } catch (error) {
                document.getElementById('update-message').textContent =
                    error.message || 'No se pudo consultar el actualizador.';
            }
        }

        async function ejecutarAccionActualizacion(accion) {
            try {
                let data;

                if (
                    puenteActualizador &&
                    typeof puenteActualizador[accion] === 'function'
                ) {
                    data = await puenteActualizador[accion]();
                } else {
                    const respuesta = await fetch(`/actualizacion/${accion}`, {
                        method: 'POST'
                    });
                    data = await leerRespuesta(respuesta);

                    if (!respuesta.ok) {
                        throw new Error(
                            data.error || data.mensaje || 'No se pudo procesar la actualización.'
                        );
                    }
                }

                mostrarEstadoActualizacion(data);
            } catch (error) {
                toast(
                    error.message || 'No se pudo procesar la actualización.',
                    'error'
                );
                consultarEstadoActualizacion();
            }
        }

        if (
            puenteActualizador &&
            typeof puenteActualizador.alCambiarEstado === 'function'
        ) {
            dejarDeEscucharActualizador =
                puenteActualizador.alCambiarEstado(estado => {
                    mostrarEstadoActualizacion(estado);
                });

            window.addEventListener('beforeunload', () => {
                if (typeof dejarDeEscucharActualizador === 'function') {
                    dejarDeEscucharActualizador();
                }
            });
        }

        document.getElementById('btn-update-search').onclick = () => {
            ejecutarAccionActualizacion('buscar');
        };

        document.getElementById('btn-update-download').onclick = () => {
            ejecutarAccionActualizacion('descargar');
        };

        document.getElementById('btn-update-install').onclick = async () => {
            const confirmado = await solicitarConfirmacion({
                titulo: 'Instalar actualización',
                mensaje: 'ZeroOne se cerrará para completar la instalación.',
                textoConfirmar: 'Instalar ahora',
                tono: 'primary',
                icono: 'install'
            });
            if (confirmado) ejecutarAccionActualizacion('instalar');
        };

        configurarSelectorTodosDias('dias-programados');
        configurarSelectorTodosDias('editar-dias-programados');

        const tareasPeriodicasInterfaz = new Set();

        function iniciarTareaPeriodica(
            tarea,
            intervaloMs,
            { secciones = null, nombre = 'actualización' } = {}
        ) {
            let ejecutando = false;
            let temporizador = null;
            const seccionesPermitidas = Array.isArray(secciones)
                ? new Set(secciones)
                : null;

            const programar = () => {
                temporizador = window.setTimeout(ejecutar, intervaloMs);
            };
            const ejecutar = async () => {
                const correspondeSeccion = !seccionesPermitidas
                    || seccionesPermitidas.has(seccionActual);
                if (!document.hidden && correspondeSeccion && !ejecutando) {
                    ejecutando = true;
                    try {
                        await tarea();
                    } catch (error) {
                        console.error(`Falló ${nombre}:`, error);
                    } finally {
                        ejecutando = false;
                    }
                }
                programar();
            };
            const detener = () => {
                if (temporizador !== null) window.clearTimeout(temporizador);
                tareasPeriodicasInterfaz.delete(detener);
            };

            tareasPeriodicasInterfaz.add(detener);
            programar();
            return detener;
        }

        window.addEventListener('beforeunload', () => {
            for (const detener of [...tareasPeriodicasInterfaz]) detener();
        });

        const seccionInicial = location.hash.replace(/^#/, '') || 'dashboard';
        mostrarSeccion(seccionInicial, { actualizarHash: false });

        actualizarLineas();
        cargarConfiguracion();
        iniciarSeguimientoProgreso();
        consultarEstadoActualizacion();

        iniciarTareaPeriodica(actualizarLineas, 3500, {
            nombre: 'la actualización de líneas',
            secciones: ['estados', 'lineas', 'agendamiento']
        });
        iniciarTareaPeriodica(() => actualizarEstadosActivos(true), 6000, {
            nombre: 'la actualización de estados activos',
            secciones: ['activos']
        });
        iniciarTareaPeriodica(actualizarProgramaciones, 8000, {
            nombre: 'la actualización de programaciones',
            secciones: ['dashboard']
        });
        iniciarTareaPeriodica(actualizarResumen, 5000, {
            nombre: 'la actualización del resumen',
            secciones: ['dashboard']
        });
        iniciarTareaPeriodica(consultarEstadoActualizacion, 30000, {
            nombre: 'la consulta del actualizador'
        });
