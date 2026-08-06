'use strict';

const TIPOS_MANUAL_ZEROONE = Object.freeze({
    uso: Object.freeze({
        etiqueta: 'Guía práctica'
    }),
    tecnico: Object.freeze({
        etiqueta: 'Documento técnico'
    })
});

const estadoManualesZeroOne = {
    activo: 'uso',
    cache: new Map(),
    iniciado: false,
    solicitudActual: 0
};

function obtenerElementoManual(id) {
    return document.getElementById(id);
}

function tipoManualValido(tipo) {
    return Object.prototype.hasOwnProperty.call(TIPOS_MANUAL_ZEROONE, tipo);
}

function normalizarTipoManualCliente(tipo) {
    const normalizado = String(tipo || '').trim().toLowerCase();
    return tipoManualValido(normalizado) ? normalizado : 'uso';
}

function crearElementoManual(nombre, clase) {
    const elemento = document.createElement(nombre);
    if (clase) elemento.className = clase;
    return elemento;
}

function agregarIconoManual(destino, icono) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const uso = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    uso.setAttribute('href', `#i-${icono}`);
    svg.appendChild(uso);
    destino.appendChild(svg);
    return svg;
}

function crearIdSeccionManual(texto, usados) {
    const base = String(texto || 'seccion')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '') || 'seccion';
    const cantidad = (usados.get(base) || 0) + 1;
    usados.set(base, cantidad);
    return `manual-${base}${cantidad > 1 ? `-${cantidad}` : ''}`;
}

function agregarTextoEnLineaManual(destino, texto) {
    const fuente = String(texto || '');
    const expresion = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/gu;
    let indice = 0;

    for (const coincidencia of fuente.matchAll(expresion)) {
        if (coincidencia.index > indice) {
            destino.appendChild(document.createTextNode(
                fuente.slice(indice, coincidencia.index)
            ));
        }

        const valor = coincidencia[0];
        if (valor.startsWith('**')) {
            const fuerte = document.createElement('strong');
            fuerte.textContent = valor.slice(2, -2);
            destino.appendChild(fuerte);
        } else if (valor.startsWith('`')) {
            const codigo = document.createElement('code');
            codigo.textContent = valor.slice(1, -1);
            destino.appendChild(codigo);
        } else {
            const enlace = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/u.exec(valor);
            if (enlace) {
                const vinculo = document.createElement('a');
                vinculo.textContent = enlace[1];
                vinculo.href = enlace[2];
                vinculo.target = '_blank';
                vinculo.rel = 'noreferrer';
                destino.appendChild(vinculo);
            } else {
                destino.appendChild(document.createTextNode(valor));
            }
        }

        indice = coincidencia.index + valor.length;
    }

    if (indice < fuente.length) {
        destino.appendChild(document.createTextNode(fuente.slice(indice)));
    }
}

function dividirFilaTablaManual(linea) {
    let texto = String(linea || '').trim();
    if (texto.startsWith('|')) texto = texto.slice(1);
    if (texto.endsWith('|')) texto = texto.slice(0, -1);
    return texto.split('|').map(celda => celda.trim());
}

function esSeparadorTablaManual(linea) {
    const celdas = dividirFilaTablaManual(linea);
    return celdas.length > 0 && celdas.every(celda =>
        /^:?-{3,}:?$/u.test(celda)
    );
}

function esInicioTablaManual(lineas, indice) {
    const actual = String(lineas[indice] || '').trim();
    return actual.includes('|') && esSeparadorTablaManual(lineas[indice + 1]);
}

function crearTablaManual(lineas, indice) {
    const envoltorio = crearElementoManual('div', 'manual-table-wrap');
    const tabla = document.createElement('table');
    const cabecera = dividirFilaTablaManual(lineas[indice]);
    const cabeza = document.createElement('thead');
    const filaCabeza = document.createElement('tr');

    cabecera.forEach(texto => {
        const celda = document.createElement('th');
        celda.scope = 'col';
        agregarTextoEnLineaManual(celda, texto);
        filaCabeza.appendChild(celda);
    });
    cabeza.appendChild(filaCabeza);
    tabla.appendChild(cabeza);

    const cuerpo = document.createElement('tbody');
    let cursor = indice + 2;
    while (cursor < lineas.length) {
        const linea = String(lineas[cursor] || '').trim();
        if (!linea || !linea.includes('|')) break;

        const fila = document.createElement('tr');
        const celdas = dividirFilaTablaManual(linea);
        cabecera.forEach((_, columna) => {
            const celda = document.createElement('td');
            agregarTextoEnLineaManual(celda, celdas[columna] || '');
            fila.appendChild(celda);
        });
        cuerpo.appendChild(fila);
        cursor += 1;
    }
    tabla.appendChild(cuerpo);
    envoltorio.appendChild(tabla);
    return { elemento: envoltorio, siguiente: cursor };
}

function esInicioListaManual(linea) {
    return /^\s*(?:[-*]|\d+\.)\s+/u.test(String(linea || ''));
}

function crearListaManual(lineas, indice) {
    const primera = String(lineas[indice] || '');
    const ordenada = /^\s*\d+\.\s+/u.test(primera);
    const lista = document.createElement(ordenada ? 'ol' : 'ul');
    const coincidenciaInicio = ordenada
        ? /^\s*(\d+)\.\s+/u.exec(primera)
        : null;
    if (coincidenciaInicio && Number(coincidenciaInicio[1]) !== 1) {
        lista.start = Number(coincidenciaInicio[1]);
    }

    let cursor = indice;
    while (cursor < lineas.length) {
        const linea = String(lineas[cursor] || '');
        const coincide = ordenada
            ? /^\s*\d+\.\s+(.+)$/u.exec(linea)
            : /^\s*[-*]\s+(.+)$/u.exec(linea);
        if (!coincide) break;

        const item = document.createElement('li');
        agregarTextoEnLineaManual(item, coincide[1]);
        lista.appendChild(item);
        cursor += 1;

        while (cursor < lineas.length) {
            const continuacion = /^\s{2,}(.+)$/u.exec(String(lineas[cursor] || ''));
            if (!continuacion) break;
            item.appendChild(document.createTextNode(' '));
            agregarTextoEnLineaManual(item, continuacion[1].trim());
            cursor += 1;
        }
    }

    return { elemento: lista, siguiente: cursor };
}

function renderizarMarkdownManual(contenido) {
    const lineas = String(contenido || '').replace(/\r\n?/gu, '\n').split('\n');
    const fragmento = document.createDocumentFragment();
    const indice = [];
    const idsUsados = new Map();
    let cursor = 0;

    while (cursor < lineas.length) {
        const linea = lineas[cursor];
        const texto = String(linea || '').trim();

        if (!texto) {
            cursor += 1;
            continue;
        }

        if (/^```/u.test(texto)) {
            const lenguaje = texto.slice(3).trim();
            const bloque = document.createElement('pre');
            const codigo = document.createElement('code');
            const contenidoCodigo = [];
            cursor += 1;
            while (cursor < lineas.length && !/^```/u.test(String(lineas[cursor]).trim())) {
                contenidoCodigo.push(lineas[cursor]);
                cursor += 1;
            }
            codigo.textContent = contenidoCodigo.join('\n');
            if (lenguaje) codigo.dataset.language = lenguaje;
            bloque.appendChild(codigo);
            fragmento.appendChild(bloque);
            if (cursor < lineas.length) cursor += 1;
            continue;
        }

        const encabezado = /^(#{1,4})\s+(.+?)\s*$/u.exec(texto);
        if (encabezado) {
            const nivel = encabezado[1].length;
            const titulo = encabezado[2];
            const elemento = document.createElement(`h${nivel}`);
            elemento.id = crearIdSeccionManual(titulo, idsUsados);
            elemento.tabIndex = -1;
            agregarTextoEnLineaManual(elemento, titulo);
            fragmento.appendChild(elemento);
            if (nivel >= 2) {
                indice.push({
                    id: elemento.id,
                    nivel,
                    texto: titulo.replace(/\*\*/gu, '')
                });
            }
            cursor += 1;
            continue;
        }

        if (/^(?:-{3,}|\*{3,}|_{3,})$/u.test(texto)) {
            fragmento.appendChild(document.createElement('hr'));
            cursor += 1;
            continue;
        }

        if (esInicioTablaManual(lineas, cursor)) {
            const tabla = crearTablaManual(lineas, cursor);
            fragmento.appendChild(tabla.elemento);
            cursor = tabla.siguiente;
            continue;
        }

        if (esInicioListaManual(linea)) {
            const lista = crearListaManual(lineas, cursor);
            fragmento.appendChild(lista.elemento);
            cursor = lista.siguiente;
            continue;
        }

        if (/^>\s?/u.test(texto)) {
            const cita = document.createElement('blockquote');
            agregarTextoEnLineaManual(cita, texto.replace(/^>\s?/u, ''));
            fragmento.appendChild(cita);
            cursor += 1;
            continue;
        }

        const parrafo = document.createElement('p');
        const partes = [];
        while (cursor < lineas.length) {
            const candidata = String(lineas[cursor] || '');
            const candidataLimpia = candidata.trim();
            if (
                !candidataLimpia ||
                /^```/u.test(candidataLimpia) ||
                /^(#{1,4})\s+/u.test(candidataLimpia) ||
                /^(?:-{3,}|\*{3,}|_{3,})$/u.test(candidataLimpia) ||
                esInicioTablaManual(lineas, cursor) ||
                esInicioListaManual(candidata) ||
                /^>\s?/u.test(candidataLimpia)
            ) {
                break;
            }
            partes.push(candidataLimpia);
            cursor += 1;
        }
        agregarTextoEnLineaManual(parrafo, partes.join(' '));
        fragmento.appendChild(parrafo);
    }

    return { fragmento, indice };
}

function actualizarSeleccionManual(tipo) {
    document.querySelectorAll('[data-manual-type]').forEach(boton => {
        const seleccionado = boton.dataset.manualType === tipo;
        boton.classList.toggle('active', seleccionado);
        boton.setAttribute('aria-selected', String(seleccionado));
        boton.tabIndex = seleccionado ? 0 : -1;
    });
}

function renderizarIndiceManual(secciones) {
    const indice = obtenerElementoManual('manuals-toc');
    if (!indice) return;

    indice.replaceChildren();
    if (!secciones.length) {
        const vacio = crearElementoManual('p', 'manuals-toc-empty');
        vacio.textContent = 'Este manual no tiene secciones navegables.';
        indice.appendChild(vacio);
        return;
    }

    const etiqueta = crearElementoManual('span', 'manuals-toc-label');
    etiqueta.textContent = 'Contenido';
    indice.appendChild(etiqueta);

    secciones.forEach(seccion => {
        const boton = crearElementoManual('button', 'manuals-toc-button');
        boton.type = 'button';
        boton.dataset.level = String(seccion.nivel);
        boton.textContent = seccion.texto;
        boton.addEventListener('click', () => {
            const destino = document.getElementById(seccion.id);
            destino?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            destino?.focus?.({ preventScroll: true });
        });
        indice.appendChild(boton);
    });
}

function actualizarEstadoLectorManual(texto, icono = 'book') {
    const estado = obtenerElementoManual('manuals-reader-state');
    if (!estado) return;

    estado.replaceChildren();
    agregarIconoManual(estado, icono);
    estado.appendChild(document.createTextNode(texto));
}

function mostrarEstadoManual(tipo, texto, clase, conReintento = false) {
    const contenido = obtenerElementoManual('manuals-reader-content');
    if (!contenido) return;

    const estado = crearElementoManual('div', `manuals-${clase}-state`);
    agregarIconoManual(estado, clase === 'error' ? 'alert' : 'loader');
    const copia = document.createElement('span');
    copia.textContent = texto;
    estado.appendChild(copia);

    if (conReintento) {
        const boton = crearElementoManual('button', 'secondary-button manuals-retry-button');
        boton.type = 'button';
        agregarIconoManual(boton, 'refresh');
        const etiqueta = document.createElement('span');
        etiqueta.textContent = 'Reintentar';
        boton.appendChild(etiqueta);
        boton.addEventListener('click', () => {
            void cargarManualZeroOne(tipo, { forzar: true });
        });
        estado.appendChild(boton);
    }

    contenido.replaceChildren(estado);
    renderizarIndiceManual([]);
}

function mostrarManualProtegido(tipo, mensaje) {
    const lector = obtenerElementoManual('manuals-reader');
    const contenido = obtenerElementoManual('manuals-reader-content');
    const subtitulo = obtenerElementoManual('manuals-reader-kicker');
    if (!lector || !contenido) return;

    const estado = crearElementoManual('section', 'manuals-locked-state');
    estado.setAttribute('aria-labelledby', 'manuals-locked-title');

    const emblema = crearElementoManual('span', 'manuals-locked-emblem');
    agregarIconoManual(emblema, 'lock');
    estado.appendChild(emblema);

    const titulo = document.createElement('h2');
    titulo.id = 'manuals-locked-title';
    titulo.textContent = 'Arquitectura técnica protegida';
    estado.appendChild(titulo);

    const descripcion = document.createElement('p');
    descripcion.textContent = mensaje ||
        'Ingresá la contraseña para consultar este manual técnico.';
    estado.appendChild(descripcion);

    const nota = crearElementoManual('p', 'manuals-locked-note');
    nota.textContent = 'El acceso se mantiene solo durante esta sesión y la contraseña no se guarda.';
    estado.appendChild(nota);

    const formulario = crearElementoManual('form', 'manuals-unlock-form');
    formulario.noValidate = true;

    const etiqueta = crearElementoManual('label', 'manuals-unlock-field');
    const textoEtiqueta = document.createElement('span');
    textoEtiqueta.textContent = 'Contraseña';
    const input = document.createElement('input');
    input.type = 'password';
    input.name = 'manual-tecnico-contrasena';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.required = true;
    input.maxLength = 512;
    input.placeholder = 'Ingresá la contraseña';
    input.setAttribute('aria-describedby', 'manuals-unlock-message');
    etiqueta.append(textoEtiqueta, input);
    formulario.appendChild(etiqueta);

    const estadoFormulario = crearElementoManual('p', 'manuals-unlock-message');
    estadoFormulario.id = 'manuals-unlock-message';
    estadoFormulario.setAttribute('aria-live', 'polite');
    formulario.appendChild(estadoFormulario);

    const boton = crearElementoManual('button', 'primary-button manuals-unlock-button');
    boton.type = 'submit';
    agregarIconoManual(boton, 'lock');
    const textoBoton = document.createElement('span');
    textoBoton.textContent = 'Desbloquear manual';
    boton.appendChild(textoBoton);
    formulario.appendChild(boton);

    formulario.addEventListener('submit', evento => {
        evento.preventDefault();
        void desbloquearManualTecnico(tipo, input, boton, estadoFormulario);
    });
    estado.appendChild(formulario);

    contenido.replaceChildren(estado);
    lector.setAttribute('aria-busy', 'false');
    lector.scrollIntoView({ block: 'start', behavior: 'auto' });
    if (subtitulo) subtitulo.textContent = TIPOS_MANUAL_ZEROONE.tecnico.etiqueta;
    actualizarEstadoLectorManual('Protegido localmente', 'lock');
    renderizarIndiceManual([]);
    input.focus();
}

function descartarManualTecnicoDesbloqueado() {
    const habiaContenido = estadoManualesZeroOne.cache.has('tecnico');
    estadoManualesZeroOne.cache.delete('tecnico');
    estadoManualesZeroOne.solicitudActual += 1;
    return habiaContenido;
}

function bloquearManualTecnicoAlSalir() {
    const estabaEnManualTecnico = estadoManualesZeroOne.activo === 'tecnico';
    const habiaContenido = estadoManualesZeroOne.cache.has('tecnico');
    if (!estabaEnManualTecnico && !habiaContenido) return;
    descartarManualTecnicoDesbloqueado();

    const lector = obtenerElementoManual('manuals-reader');
    const contenido = obtenerElementoManual('manuals-reader-content');
    if (lector && contenido && estabaEnManualTecnico) {
        const aviso = crearElementoManual(
            'div',
            'manuals-loading-state manuals-locked-away-state'
        );
        agregarIconoManual(aviso, 'lock');
        const texto = document.createElement('span');
        texto.textContent = 'El manual técnico se bloqueó al salir.';
        aviso.appendChild(texto);
        contenido.replaceChildren(aviso);
        lector.setAttribute('aria-busy', 'false');
        actualizarEstadoLectorManual('Protegido localmente', 'lock');
        renderizarIndiceManual([]);
    }
}

async function desbloquearManualTecnico(tipo, input, boton, estadoFormulario) {
    if (normalizarTipoManualCliente(tipo) !== 'tecnico') return;

    let contrasena = input.value;
    if (!contrasena) {
        estadoFormulario.textContent = 'Ingresá la contraseña para continuar.';
        input.focus();
        return;
    }

    const solicitud = ++estadoManualesZeroOne.solicitudActual;
    boton.disabled = true;
    boton.dataset.loading = 'true';
    estadoFormulario.textContent = 'Verificando acceso…';

    try {
        const respuesta = await fetch('/manuales/tecnico/desbloquear', {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contrasena })
        });
        const data = await respuesta.json().catch(() => ({}));
        if (!respuesta.ok) {
            throw new Error(data.error || 'No se pudo desbloquear el manual.');
        }
        if (!data || data.id !== 'tecnico' || typeof data.contenido !== 'string') {
            throw new Error('El manual recibido no tiene un formato válido.');
        }

        if (solicitud !== estadoManualesZeroOne.solicitudActual || estadoManualesZeroOne.activo !== 'tecnico') {
            return;
        }
        estadoManualesZeroOne.cache.set('tecnico', data);
        mostrarManualZeroOne(data);
    } catch (error) {
        if (solicitud !== estadoManualesZeroOne.solicitudActual || estadoManualesZeroOne.activo !== 'tecnico') {
            return;
        }
        estadoFormulario.textContent = error?.message ||
            'No se pudo desbloquear el manual. Verificá la contraseña e intentá nuevamente.';
        input.focus();
    } finally {
        contrasena = '';
        input.value = '';
        boton.disabled = false;
        delete boton.dataset.loading;
    }
}

function mostrarManualZeroOne(manual) {
    const lector = obtenerElementoManual('manuals-reader');
    const contenido = obtenerElementoManual('manuals-reader-content');
    const subtitulo = obtenerElementoManual('manuals-reader-kicker');
    if (!lector || !contenido) return;

    const renderizado = renderizarMarkdownManual(manual.contenido);
    contenido.replaceChildren(renderizado.fragmento);
    lector.scrollIntoView({ block: 'start', behavior: 'auto' });
    lector.setAttribute('aria-busy', 'false');
    if (subtitulo) {
        subtitulo.textContent = manual.titulo || TIPOS_MANUAL_ZEROONE[manual.id]?.etiqueta || 'Manual';
    }
    actualizarEstadoLectorManual(
        manual.id === 'tecnico'
            ? 'Protegido · desbloqueado en esta sesión'
            : 'Disponible sin conexión',
        manual.id === 'tecnico' ? 'lock' : 'book'
    );
    renderizarIndiceManual(renderizado.indice);
}

async function cargarManualZeroOne(tipo = estadoManualesZeroOne.activo, opciones = {}) {
    const manualTipo = normalizarTipoManualCliente(tipo);
    const forzar = opciones.forzar === true;
    if (estadoManualesZeroOne.activo === 'tecnico' && manualTipo !== 'tecnico') {
        descartarManualTecnicoDesbloqueado();
    }
    estadoManualesZeroOne.activo = manualTipo;
    localStorage.setItem('zeroone-manual-activo', manualTipo);
    actualizarSeleccionManual(manualTipo);

    const lector = obtenerElementoManual('manuals-reader');
    if (lector) lector.setAttribute('aria-busy', 'true');

    if (!forzar && estadoManualesZeroOne.cache.has(manualTipo)) {
        mostrarManualZeroOne(estadoManualesZeroOne.cache.get(manualTipo));
        return;
    }

    mostrarEstadoManual(manualTipo, 'Preparando el manual…', 'loading');
    const solicitud = ++estadoManualesZeroOne.solicitudActual;

    try {
        const respuesta = await fetch(`/manuales/${encodeURIComponent(manualTipo)}`, {
            cache: 'no-store'
        });
        const data = await respuesta.json().catch(() => ({}));
        if (respuesta.status === 423 && data?.codigo === 'MANUAL_PROTEGIDO') {
            if (solicitud !== estadoManualesZeroOne.solicitudActual || estadoManualesZeroOne.activo !== manualTipo) {
                return;
            }
            mostrarManualProtegido(manualTipo, data.error);
            return;
        }
        if (!respuesta.ok) {
            throw new Error(data.error || 'No se pudo abrir el manual.');
        }
        if (!data || !tipoManualValido(data.id) || typeof data.contenido !== 'string') {
            throw new Error('El manual recibido no tiene un formato válido.');
        }

        estadoManualesZeroOne.cache.set(data.id, data);
        if (solicitud !== estadoManualesZeroOne.solicitudActual || estadoManualesZeroOne.activo !== manualTipo) {
            return;
        }
        mostrarManualZeroOne(data);
    } catch (error) {
        if (solicitud !== estadoManualesZeroOne.solicitudActual || estadoManualesZeroOne.activo !== manualTipo) {
            return;
        }
        if (lector) lector.setAttribute('aria-busy', 'false');
        mostrarEstadoManual(
            manualTipo,
            error?.message || 'No se pudo abrir el manual local.',
            'error',
            true
        );
    }
}

function inicializarManuales() {
    if (estadoManualesZeroOne.iniciado) return;
    estadoManualesZeroOne.iniciado = true;

    const guardado = normalizarTipoManualCliente(
        localStorage.getItem('zeroone-manual-activo')
    );
    estadoManualesZeroOne.activo = guardado;
    actualizarSeleccionManual(guardado);

    const botones = [...document.querySelectorAll('[data-manual-type]')];
    botones.forEach(boton => {
        boton.addEventListener('click', () => {
            void cargarManualZeroOne(boton.dataset.manualType);
        });
        boton.addEventListener('keydown', evento => {
            if (!['ArrowLeft', 'ArrowRight'].includes(evento.key)) return;
            evento.preventDefault();
            const actual = botones.indexOf(boton);
            const direccion = evento.key === 'ArrowRight' ? 1 : -1;
            const siguiente = botones[
                (actual + direccion + botones.length) % botones.length
            ];
            siguiente.focus();
            void cargarManualZeroOne(siguiente.dataset.manualType);
        });
    });
}
