# Guía de uso de ZeroOne

Esta guía está pensada para usar la aplicación sin necesitar conocer el código.

## Recorrido rápido

La barra lateral tiene estos módulos:

| Módulo | Para qué sirve |
| --- | --- |
| **Inicio** | Ver el resumen general y las programaciones. |
| **Estados** | Crear una campaña y seguir su progreso en vivo. |
| **Estados activos** | Consultar publicaciones que siguen vigentes, sus líneas y visualizaciones registradas. |
| **Líneas** | Vincular, buscar, ordenar, editar y revisar cada línea. |
| **Agendamiento** | Revisar usuarios detectados y actualizar contactos mediante Google Contacts. |
| **Historial** | Consultar campañas terminadas y reintentar solo líneas seguras. |
| **Configuración** | Ajustar seguridad, ritmo, rendimiento, apariencia y opciones de escritorio. |

Podés contraer la barra lateral con el botón junto al nombre de ZeroOne.

## 1. Conectar una línea

1. Entrá en **Líneas**.
2. Elegí **Conectar línea** o el botón `+`.
3. Escribí un nombre fácil de reconocer, por ejemplo `L21` o `Soporte L21`.
4. En WhatsApp del teléfono, abrí **Dispositivos vinculados** y escaneá el QR.
5. Esperá a que ZeroOne indique que fue escaneado y confirmá la conexión.

Si cerrás el QR antes de terminar, la línea queda pendiente. Podés volver a
abrir su QR o usar **Reconectar** desde la tarjeta.

Una línea marcada como **Lista para publicar** puede elegirse en una campaña.
Las etiquetas de reposo, caída o indefinida impiden publicar hasta que la línea
se recupere o se revise manualmente.

## 2. Revisar la audiencia

La tarjeta de cada línea muestra el estado de su audiencia y la fuente usada.
ZeroOne consulta WhatsApp primero y, si hay una cuenta de Google asociada,
también puede contrastar Google Contacts. La lista más grande se utiliza; ante
un empate se conserva WhatsApp.

Una tarjeta con **Audiencia pendiente** no significa necesariamente que la
línea esté desconectada. Podés esperar el siguiente intento automático o usar
las acciones de la tarjeta si necesitás revisarla.

## 3. Publicar un estado ahora

1. Entrá en **Estados** y presioná `+`.
2. Elegí una imagen JPG o PNG y escribí un texto si lo necesitás.
3. Elegí el ritmo de envío:
   - **Una línea a la vez:** procesa una línea y espera antes de la siguiente.
   - **Por grupos:** procesa una tanda y espera entre grupos.
4. Seleccioná las líneas disponibles.
5. Revisá la configuración y elegí **Subir ahora**.

La imagen se optimiza antes de iniciar. Durante la campaña, la pantalla de
Estados muestra la línea actual, el próximo envío, las líneas correctas y las
fallidas.

### Si una línea falla

Cuando ZeroOne detiene una campaña para pedir una decisión, podés:

- **Omitir la línea fallida y continuar con el resto.**
- **Detener campaña.**

Si el envío queda sin confirmación, revisá primero WhatsApp. Después elegí
**Sí, se publicó** solo si comprobaste que el estado existe; en caso contrario
podés omitir esa línea y continuar. Esto evita duplicados.

### Alto total

El botón **Alto total** frena la campaña completa. ZeroOne conserva el avance
ya registrado para que el historial indique qué líneas se completaron y cuáles
no llegaron a procesarse.

## 4. Programar publicaciones

Al crear un estado también podés programarlo:

1. Elegí imagen, texto, ritmo y líneas.
2. Indicá hora y días.
3. Guardá la programación.

Desde **Inicio** podés editar, pausar, activar, duplicar, ejecutar o eliminar
una programación. Una programación que ya se está ejecutando no se puede editar
hasta finalizar.

## 5. Estados activos y visualizaciones

En **Estados activos**, las tarjetas agrupan la misma publicación entre varias
líneas.

- Cambiá entre vista pequeña, mediana, grande o lista.
- Abrí una tarjeta para ver visualizaciones registradas por línea.
- Usá el buscador, el orden alfabético o el orden por visualizaciones.
- Elegí eliminar solo cuando quieras solicitar la eliminación de los estados
  registrados en ese grupo.

El total de visualizaciones es el que ZeroOne pudo registrar; no garantiza que
WhatsApp muestre todos los destinatarios ni confirma la entrega de cada estado.

## 6. Historial y reintentos

El **Historial** muestra fecha, imagen, ritmo, líneas correctas, fallidas y no
procesadas. Si una campaña se interrumpe por un cierre inesperado, puede aparecer
la opción de reanudar líneas pendientes cuando sea seguro hacerlo.

**Reintentar fallidas** solo se habilita para las líneas que ZeroOne considera
seguras. No todas las fallas deben reintentarse automáticamente.

## 7. Agendamiento

Agendamiento trabaja por línea y usa Google Contacts para crear o actualizar
contactos.

1. Entrá en **Agendamiento** y elegí una línea.
2. Cargá las credenciales JSON de Google si todavía no están configuradas.
3. Elegí **Conectar Google** y completá la autorización en el navegador.
4. Asigná una cuenta a la línea elegida.
5. Configurá referencias conocidas, por ejemplo `Usuario:` o `Cuenta creada:`.
6. Descargá la IA local una sola vez, analizá las sugerencias y revisalas antes
   de agendar.
7. Elegí **Agendar pendientes** cuando estés conforme con las revisiones.

La IA usa el contexto de mensajes salientes individuales que estén disponibles
para la línea, más mensajes nuevos. No solicita el historial completo ni usa
grupos, estados o mensajes recibidos para el análisis.

La opción de contactos mutuos sin usuario está desactivada por defecto y se
controla desde Configuración. Revisá siempre las sugerencias antes de aplicarlas.

## 8. Configuración útil

### General

- Activá notificaciones.
- Elegí si la `X` minimiza la aplicación al área de notificación.
- Activá el inicio automático con Windows.
- Abrí, copiá, creá o eliminá el registro de diagnóstico.

Para cerrar por completo cuando el segundo plano está activo, usá **Salir de
ZeroOne** desde el icono de la bandeja de Windows.

### Manuales

En **Configuración → Manuales** encontrás esta guía y el documento técnico
integrados dentro de ZeroOne. Podés cambiar entre **Uso diario** y
**Arquitectura**, y usar el índice lateral para ir directamente a cada tema.
Los dos se incluyen localmente con la aplicación, por lo que no requieren
Internet ni abren archivos externos.

### Publicación y seguridad

- **Segundos entre líneas:** espera base del modo secuencial.
- **Variación adicional:** agrega un valor aleatorio entre cero y el máximo;
  no usa siempre el máximo completo.
- **Líneas por grupo y minutos entre grupos:** controlan el modo por tandas.
- **Destinatarios por estado:** toma los primeros contactos de la base reciente
  disponible, hasta el límite elegido.
- **Corte de seguridad:** define cuántas líneas fallidas pausan la campaña.
- **Enfriamiento preventivo:** espera antes de permitir otra publicación tras
  ciertos errores recuperables.

Un código `WA_429` viene de WhatsApp: su tiempo de espera no se puede reducir
desde ZeroOne.

### Rendimiento y apariencia

- **Normal:** usa los límites habituales.
- **Adaptativo:** reduce tareas secundarias si detecta presión de memoria.
- **Ahorro:** aplica esos límites reducidos siempre.

Elegí el tema EVA o Rei desde **Apariencia** y guardá la configuración.

## 9. Logs y soporte

Cuando necesites ayuda:

1. Abrí **Configuración → General**.
2. Usá **Nuevo log** para iniciar un diagnóstico sin borrar los anteriores.
3. Usá **Copiar actual** para enviarlo por mensaje o **Abrir carpeta** para
   adjuntar el archivo.

No compartas archivos de sesiones, credenciales JSON de Google ni carpetas de
datos. Para soporte suele bastar el log de diagnóstico.

## 10. Restablecer todos los datos

Usalo solo como último recurso. En **Configuración → General**, escribí
`RESTABLECER` en la confirmación.

Se borran del equipo las sesiones locales, líneas, campañas, historial,
imágenes, ajustes, cuentas Google, caché de IA y logs. La aplicación se abre
limpia y tendrás que volver a vincular las líneas por QR y autorizar Google.
No desinstala ZeroOne ni elimina archivos del repositorio de desarrollo.
