# ZeroOne

Aplicación de escritorio para gestionar líneas de WhatsApp, publicar estados,
programar campañas, consultar estados activos y organizar contactos desde una
interfaz local.

## Documentación

- [Guía de uso sencilla](docs/GUIA_DE_USO_ZEROONE.md)
- El manual técnico protegido está disponible dentro de ZeroOne, en
  **Configuración → Manuales**.

## Estructura del proyecto

| Ruta | Responsabilidad |
| --- | --- |
| `main.js` | Proceso principal de Electron: ventana, bandeja, actualizador, logs y opciones del escritorio. |
| `preload.js` | Puente restringido entre la interfaz y Electron. |
| `src/bot.js` | Servidor local, líneas, publicación, audiencia, historial y rutas principales. |
| `src/` | Módulos aislados de agendamiento, IA, checkpoints, rendimiento, compresión, logs y QR. |
| `public/` | Interfaz HTML, JavaScript modular, CSS y recursos visuales. |
| `tests/` | Pruebas internas sin usar sesiones reales. |
| `scripts/` | Herramientas de mantenimiento, como la generación de iconos y la revisión de sintaxis. |

## Comandos de desarrollo

```powershell
npm start
npm run start:demo
npm run test:internal
npm run build
```

`start:demo` usa datos visuales aislados. `test:internal` revisa primero la
sintaxis de todos los archivos JavaScript mantenidos y después ejecuta las
pruebas internas. Ninguno de los dos comandos debe usar las sesiones reales.

## Datos locales

Las sesiones, campañas, imágenes, historial, cuentas autorizadas, cachés y
logs se guardan fuera del código de la aplicación y están excluidos de Git.
No se deben copiar ni subir esos datos a un repositorio.
