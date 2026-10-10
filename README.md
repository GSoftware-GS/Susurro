# Susurro

Chat cifrado con PGP, descentralizado y fácil de instalar en el móvil. Sin cuentas, sin número de teléfono y sin servidor de chat propio: es una web estática que se instala como app (PWA).

## Cómo se usa

1. **Abre la web, escribe tu nombre y elige una contraseña.** Se genera tu identidad (un par de claves PGP) en tu dispositivo, y la contraseña cifra todo lo que Susurro guarda en él. Si la olvidas, solo podrás recuperar tu cuenta con una copia de seguridad.
2. **Instálala en el móvil.**
   - **Android (Chrome):** botón «Instalar» de la app, o menú ⋮ → «Instalar aplicación».
   - **iPhone (Safari):** Compartir → «Añadir a pantalla de inicio». Hazlo **antes** de crear la identidad y ábrela desde el icono: en iPhone la app instalada guarda sus datos aparte de Safari.
   - **Ordenador (Chrome/Edge):** icono de instalar en la barra de direcciones.
3. **Añade a alguien.**
   - En persona: «Mi código» muestra tu QR; la otra persona lo escanea con la cámara del móvil o desde «Añadir contacto → Escanear código QR».
   - A distancia: «Compartir enlace» (WhatsApp, Telegram, correo…) o pega su enlace o su clave pública PGP en «Añadir contacto».
   - Basta con que uno añada al otro: el primer mensaje llega como **solicitud de chat** junto con la clave del remitente, y el otro puede aceptarla o bloquearla.
4. **Verifica la huella** (recomendado): toca el nombre del contacto y comparad las huellas por otra vía (en persona, por llamada). Si coinciden, márcalo como verificado. Mientras no lo esté, junto al nombre se ve el principio de su huella.
5. **Mensajes temporales** (opcional): en un chat, toca el icono del cronómetro y elige 5 minutos, 1 hora, 1 día o 1 semana. Los mensajes nuevos desaparecen de los dos dispositivos pasado ese tiempo desde que se envían, y se pide a los relays que los borren a la vez. El cambio se aplica a los dos lados.
6. **Haz una copia de seguridad:** Ajustes → «Guardar copia cifrada». Incluye tu clave, tus contactos y tus mensajes (salvo los temporales), cifrados con una contraseña de al menos 10 caracteres; el botón «Generar una contraseña segura» crea una de 20. Sirve para pasar a otro dispositivo o para recuperar todo si se borra el navegador (se restaura desde la pantalla de inicio, en «Restaurar copia o importar clave PGP»). Ahí también se puede importar una clave privada PGP que ya tengas.

**Bloqueo.** Susurro se bloquea solo tras 5 minutos en segundo plano, y con el candado de la barra superior al momento. Al bloquearse se borran de la memoria la clave y las conversaciones; mientras está bloqueado no recibe mensajes (esperan en los relays).

Susurro funciona en una sola ventana a la vez por dispositivo: si se abre en otra, la primera se detiene y ofrece «Usar aquí» para no pisar los datos.

**Móvil y ordenador.** En pantallas anchas se ve en dos columnas (chats y conversación). Enter envía y Mayús+Enter añade un salto de línea. Cada dispositivo puede tener su propia identidad, o la misma: haz una copia de seguridad en uno y restáurala en el otro. Con la misma identidad, los dos dispositivos reciben todos los mensajes, pero cada uno solo muestra los que se enviaron desde él (lo enviado no se sincroniza). Usa siempre la misma dirección web, porque cada dirección guarda sus datos por separado.

## ¿Dónde se guardan los mensajes?

- **En el hosting (Netlify o Hostinger): nunca.** Solo aloja los archivos de la app; ningún mensaje pasa por él.
- **En los relays Nostr: cifrados y por poco tiempo.** Son servidores independientes de distintas personas que hacen de cartero: guardan el mensaje cifrado (no pueden leerlo) para entregarlo aunque el destinatario esté desconectado. Cada mensaje lleva una fecha de caducidad (NIP-40): 7 días como máximo, o el tiempo del temporizador si es temporal. Los relays que siguen el estándar lo borran al caducar; uno que no lo siga podría conservar el texto cifrado, que sigue siendo ilegible.
- **En tu dispositivo: cifrados con tu contraseña.** Tus conversaciones se guardan para que puedas releerlas, siempre cifradas con AES-256-GCM. Sin la contraseña no se pueden abrir.

## Cómo funciona

```
Tu móvil ──(firma + cifra con OpenPGP)──► 5 relays Nostr públicos ──► móvil del destinatario
                                                                      (descifra + verifica firma)
```

- **Cifrado:** OpenPGP.js 6 con claves ed25519/cv25519, compatibles con GnuPG. Cada mensaje se firma con tu clave y se cifra para el destinatario sin indicar a quién va (`wildcard`: no aparece el ID de su clave).
- **Contenido cifrado:** un JSON con el texto, la fecha, un identificador único, el temporizador, tu clave pública (para que puedan responderte aunque aún no te tengan) y la huella del destinatario, rellenado hasta múltiplos de 512 bytes para no delatar la longitud. Al incluir la huella del destinatario, nadie puede reenviar a otra persona un mensaje firmado por ti.
- **Transporte:** cada mensaje es un evento Nostr (`kind` 4242) que se publica a la vez en todos los relays configurados, con su etiqueta de caducidad (`expiration`). Cada evento va firmado con una clave Nostr desechable, de modo que la firma no identifica a quien envía. El destinatario se identifica con la etiqueta `p` = `sha256("susurro:" + huella)`. El ✓ aparece cuando lo han aceptado al menos dos relays (o todos los que respondieron, si son menos).
- **Recepción:** la app escucha esa etiqueta en todos los relays y procesa los eventos de uno en uno: descarta los caducados, verifica el evento Nostr, exige exactamente un destinatario, descifra con límite de tamaño descomprimido, exige una firma válida de la clave que viaja dentro (tolerando relojes hasta 10 minutos adelantados) y descarta duplicados y repeticiones. Cada relay continúa desde el último histórico completo que entregó (señal `EOSE`), con 2 días de margen; si un relay llega al tope de 500 eventos por petición, se piden también los anteriores antes de darlo por completo, para que inundar tu etiqueta no oculte mensajes.
- **Desconocidos:** se guardan como máximo 20 solicitudes pendientes, con 3 mensajes de 1.000 caracteres cada una y sin enlaces; lo demás se descarta hasta que aceptes o bloquees. De un contacto bloqueado solo se guarda la huella. Si una solicitud usa un nombre que se ve igual que el de un contacto (también con letras cirílicas o griegas que imitan a las latinas), la app avisa de posible suplantación.
- **Sin conexión:** lo que escribes queda en cola (icono de reloj) y se reintenta al reconectar y cada 30 segundos; si lleva más de una hora en cola se vuelve a firmar con fecha actual. La app abre sin internet gracias al service worker.
- **Almacenamiento local:** en el `localStorage` solo hay datos cifrados con AES-256-GCM. La clave que los cifra es aleatoria y está a su vez cifrada con tu contraseña mediante Argon2 (64 MiB de memoria por intento), lo que hace muy lento probar contraseñas por fuerza bruta.

## Seguridad: qué protege y qué no

Se han hecho tres auditorías independientes (criptografía y protocolo, aplicación web y despliegue, y vulnerabilidades conocidas de las librerías) más pruebas de ataque reales: suplantación, reenvío, repetición, fechas trucadas, bombas de descompresión, mensajes con varios destinatarios, inyección de código en nombres, mensajes y enlaces, y copias manipuladas. Todas se rechazan.

**Protege:**
- Solo el destinatario puede leer el mensaje: los relays y el hosting nunca ven el contenido.
- Firma obligatoria: nadie puede hacerse pasar por un contacto cuya huella hayas verificado.
- Quien coja tu móvil o copie los datos del navegador no puede leer nada sin tu contraseña.
- Todo se pinta como texto (sin `innerHTML`), la CSP solo permite los scripts propios de la app y Trusted Types impide cargar otros desde el código. En Netlify, la CSP por cabecera bloquea además el script que Netlify inyecta en las páginas.

**Limitaciones que conviene conocer:**
- **Con la app desbloqueada, el dispositivo manda.** Un malware o una extensión maliciosa del navegador puede leer lo que la app tiene abierto. Mantén el sistema actualizado y no instales extensiones dudosas.
- **Mensajes temporales:** nadie puede impedir que la otra persona haga una captura de pantalla o use una versión modificada de la app que no borre nada. Un relay que no respete la caducidad podría conservar el texto cifrado.
- **Metadatos:** quien conozca tu clave pública puede calcular tu etiqueta y ver en los relays cuántos mensajes recibes y cuándo. Los relays ven tu IP, y como envías y recibes por la misma conexión, un relay podría deducir con quién hablas. El tipo de evento (4242) delata que usas Susurro. Usa una VPN o Tor si te preocupa.
- **Sin secreto hacia delante ni negabilidad:** si alguien roba tu clave privada, podría descifrar mensajes antiguos que haya guardado de los relays antes de que caducaran. Y como los mensajes van firmados, el destinatario puede demostrar a terceros que los escribiste tú. Son propiedades de PGP.
- **Confianza en el primer uso:** la primera clave que recibes de alguien se acepta tal cual y cualquiera puede ponerse cualquier nombre. Solo comparar huellas por otra vía protege de verdad. Si un contacto cambia de clave, aparece como un contacto nuevo; no se gestiona la revocación de claves robadas.
- **Entrega no garantizada:** depende de relays públicos que pueden filtrar, retrasar o borrar eventos. ✓ significa «aceptado por los relays», no «leído». Un mensaje a alguien que pase más de 7 días sin abrir la app se pierde.
- **Sin avisos con la app cerrada:** no hay notificaciones push (necesitarían un servidor central).
- **Solicitudes no deseadas:** crear claves no cuesta nada, así que bloquear no frena a un atacante decidido; por eso hay topes de solicitudes y mensajes pendientes.
- **Quien controla el hosting controla la app:** un `app.js` modificado podría robar claves. Protege tu cuenta de Netlify o Hostinger con verificación en dos pasos y vigila quién tiene acceso.

## Publicarla

Todo lo que se publica está en la carpeta `public/`. Es una web estática: no necesita PHP ni base de datos.

Requisitos:
- **HTTPS**, obligatorio para instalarla, usar la cámara y el cifrado del navegador.
- **Una dirección solo para Susurro**, sea un dominio o un subdominio. Los datos del navegador se separan por dominio, no por carpeta: si Susurro comparte dominio con otra web (un WordPress, por ejemplo), un fallo en esa web podría leer los datos.

### Netlify (lo más fácil)

1. Entra en [app.netlify.com/drop](https://app.netlify.com/drop) **con tu cuenta iniciada**. Sin cuenta, el sitio queda protegido con contraseña y se borra en una hora si no lo reclamas.
2. Arrastra la carpeta `public` a la página. En unos segundos tendrás una dirección `https://nombre-aleatorio.netlify.app` con HTTPS y un subdominio solo para la app.
3. Opcional: cámbiale el nombre en la configuración del sitio. Hazlo **antes** de empezar a usarla (cambiar la dirección es empezar de cero, ver abajo).
4. **Si el nombre del sitio no es `susurro-chat`, o usas un dominio propio, cambia el dominio en `public/_headers`** (aparece dos veces en la línea `Content-Security-Policy`). Esa cabecera solo deja ejecutar los scripts de esa dirección exacta: con otro dominio la app no carga.
5. Para actualizarla: abre el sitio en Netlify, pestaña *Deploys*, y arrastra de nuevo la carpeta `public`.

Netlify inyecta en las páginas su propio script (`/.netlify/scripts/hud`, una insignia y una barra para el dueño del sitio). La CSP de `public/_headers` lo bloquea para que no se ejecute dentro de la app. Si tu plan lo permite, desactívalo además en la configuración del sitio (opción del distintivo «Powered by Netlify»).

### Hostinger u otro hosting con Apache/LiteSpeed

1. Crea un subdominio en el panel (por ejemplo `chat.tu-dominio.com`) y activa su certificado SSL.
2. Sube el **contenido** de `public/` a la carpeta raíz del subdominio, incluido `.htaccess`, que fuerza HTTPS y añade las cabeceras de seguridad.

### En cualquier caso

- Abre la dirección en el móvil e instálala.
- **Al publicar cambios, cambia siempre el valor de `CACHE` en `public/sw.js`** (por ejemplo `susurro-v4`). La app se sirve desde la caché del dispositivo: sin ese cambio nadie verá la versión nueva. Con él, la versión nueva se descarga entera en segundo plano y aparece el aviso «Hay una versión nueva de Susurro» con el botón «Actualizar»; si no se pulsa, se aplica en el siguiente arranque.
- **Cada dirección tiene su propio almacenamiento.** Si cambias de dirección (otro nombre en Netlify, o pasar a tu dominio), la app empieza vacía y los enlaces de invitación antiguos apuntan a la dirección vieja. Para conservar tu identidad, haz una copia de seguridad en la vieja y restáurala en la nueva.

## Desarrollo local

```bash
python -m http.server 8765 --bind 127.0.0.1 --directory public
```

Abre `http://localhost:8765`. Para simular a dos personas en el mismo ordenador, abre la segunda en `http://127.0.0.1:8765`: cada dirección tiene su propio almacenamiento. Este servidor no envía las cabeceras de `_headers`; la CSP de `index.html` sí se aplica.

El service worker sirve la app desde su caché, así que tras editar un archivo no verás el cambio. Mientras desarrollas, activa en las DevTools de Chrome *Application → Service workers → Bypass for network*, o cambia `CACHE` en `public/sw.js` y recarga dos veces.

## Ajustes

- **Contraseña de acceso:** Ajustes → «Cambiar contraseña» (pide la actual). «Bloquear ahora» cierra la sesión al momento.
- **Relays:** Ajustes → Relays, uno por línea (`wss://…`). Por defecto: `relay.damus.io`, `nos.lol`, `offchain.pub`, `nostr.mom` y `relay.nostr.net`. Ambas personas deben compartir al menos un relay.
- **Borrar todo:** Ajustes → Zona peligrosa. Elimina identidad, contactos y mensajes de ese dispositivo. Si olvidas la contraseña, la pantalla de bloqueo ofrece lo mismo para empezar de nuevo o restaurar una copia.

## Estructura

| Archivo | Contenido |
|---|---|
| `public/` | **Lo que se publica** |
| `public/index.html` | Estructura de pantallas y diálogos, y política de seguridad de contenido (CSP con Trusted Types) |
| `public/styles.css` | Estilos (móvil primero, modo claro y oscuro) |
| `public/app.js` | Lógica: claves, cifrado, almacenamiento cifrado, cliente de relays Nostr, mensajes temporales e interfaz |
| `public/sw.js` | Service worker: caché por versión para abrir rápido y sin conexión |
| `public/manifest.webmanifest` | Datos para instalarla como app (nombre, iconos, `share_target`) |
| `public/_headers` | Cabeceras de seguridad en Netlify (CSP por ruta, anti-iframe, COOP…) |
| `public/.htaccess` | HTTPS obligatorio y cabeceras de seguridad en Apache/LiteSpeed (Hostinger) |
| `public/icons/` | Iconos de la app |
| `public/vendor/` | Librerías de terceros sin modificar y sus licencias (`vendor/licenses/`) |
| `.claude/launch.json` | Servidor local para la vista previa de Claude Code (no se publica) |

## Librerías de terceros

Incluidas en `public/vendor/` y obtenidas de npm con `npm pack` (sin vulnerabilidades conocidas en `npm audit` y en la base de avisos de GitHub a fecha de octubre de 2026):

- [OpenPGP.js](https://github.com/openpgpjs/openpgpjs) 6.3.2 — LGPL-3.0
- [nostr-tools](https://github.com/nbd-wtf/nostr-tools) 2.25.2 — Unlicense
- [jsQR](https://github.com/cozmo/jsQR) 1.4.0 — Apache-2.0 (se carga solo al escanear)
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 — MIT (se carga solo al mostrar tu código)
