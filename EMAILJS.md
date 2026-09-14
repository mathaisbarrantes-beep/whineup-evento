# EmailJS: configuracion paso a paso

El servidor envia los correos llamando a la API REST de EmailJS. **Ningun
identificador de EmailJS llega al navegador**: si alguien inspecciona el codigo
fuente de la pagina no encuentra nada con lo que enviar correos en tu nombre.

Esto es distinto del uso habitual de EmailJS (el SDK del navegador), donde la
clave publica queda a la vista de cualquiera y permite gastar tu cuota.

---

## 1. Crear el servicio

1. Entra en <https://dashboard.emailjs.com/>.
2. **Email Services** -> *Add New Service* -> elige tu proveedor (Gmail, Outlook,
   o SMTP propio) y conecta la cuenta desde la que saldran los correos.
3. Copia el **Service ID** (tiene la forma `service_xxxxxxx`).

## 2. Activar el uso desde el servidor

**Este paso es obligatorio.** Sin el, EmailJS rechaza las peticiones que no
vienen de un navegador y no se enviara ningun correo.

1. **Account** -> pestana **Security**.
2. Activa **"Allow EmailJS API for non-browser applications"**.
3. En la misma pantalla copia la **Public Key** y la **Private Key**.

## 3. Crear las dos plantillas

En **Email Templates** -> *Create New Template*.

En ambas plantillas, en la pestana **Settings**, rellena asi los campos de
cabecera (son variables, se sustituyen en cada envio):

| Campo       | Valor          |
| ----------- | -------------- |
| To Email    | `{{to_email}}` |
| To Name     | `{{to_name}}`  |
| Subject     | `{{subject}}`  |

### Plantilla A — "solicitud recibida" (`EMAILJS_TEMPLATE_COMPRA`)

Se envia justo despues de que alguien manda su referencia de pago. **No lleva
QR**: el codigo todavia no esta activo.

```html
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto">
  <h2>{{evento}}</h2>
  <p>Hola {{to_name}},</p>
  <p>{{mensaje}}</p>
  <table cellpadding="6" style="font-size:14px;color:#444">
    <tr><td><b>Entrada</b></td><td>{{tipo_entrada}}</td></tr>
    <tr><td><b>Fecha</b></td><td>{{fecha}}</td></tr>
    <tr><td><b>Lugar</b></td><td>{{lugar}}</td></tr>
    <tr><td><b>Importe</b></td><td>{{precio}}</td></tr>
    <tr><td><b>Referencia</b></td><td>{{referencia_corta}}</td></tr>
  </table>
  <p style="font-size:12px;color:#777">Te avisaremos por este mismo medio en cuanto confirmemos el pago.</p>
</div>
```

### Plantilla B — "entrada activa" (`EMAILJS_TEMPLATE_TICKET`)

Se envia cuando el administrador confirma el pago, y tambien al generar
cortesias o al reenviar una entrada. **Esta si lleva el QR.**

```html
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto">
  <h2>{{evento}}</h2>
  <p>Hola {{to_name}},</p>
  <p>{{mensaje}}</p>

  <p style="text-align:center;margin:28px 0">
    <img src="{{qr_url}}" alt="Codigo QR de tu entrada" width="260" height="260"
         style="border:12px solid #fff;border-radius:12px" />
  </p>

  <p style="text-align:center">
    <a href="{{ticket_url}}"
       style="display:inline-block;background:#111;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none">
      Abrir mi entrada
    </a>
  </p>

  <table cellpadding="6" style="font-size:14px;color:#444;margin:0 auto">
    <tr><td><b>Entrada</b></td><td>{{tipo_entrada}}</td></tr>
    <tr><td><b>Fecha</b></td><td>{{fecha}}</td></tr>
    <tr><td><b>Lugar</b></td><td>{{lugar}}</td></tr>
    <tr><td><b>Referencia</b></td><td>{{referencia_corta}}</td></tr>
  </table>

  <p style="font-size:12px;color:#777;text-align:center;margin-top:24px">
    Este codigo es personal y sirve una sola vez. No lo compartas ni lo publiques
    en redes: quien tenga la imagen puede entrar en tu lugar.
  </p>
</div>
```

Guarda cada plantilla y copia su **Template ID** (`template_xxxxxxx`).

---

## 4. Variables que debes darme / configurar

Pega estos cinco valores en el panel de variables de entorno de tu proveedor
(Render, Vercel...) o en tu `.env` local:

```
EMAILJS_SERVICE_ID=service_xxxxxxx
EMAILJS_PUBLIC_KEY=...
EMAILJS_PRIVATE_KEY=...
EMAILJS_TEMPLATE_COMPRA=template_xxxxxxx
EMAILJS_TEMPLATE_TICKET=template_yyyyyyy
```

Ademas necesito que definas `PUBLIC_URL` con tu dominio real: sin ella, la
imagen del QR del correo apunta a un sitio que no existe.

---

## 5. Variables disponibles en las plantillas

| Variable              | Contenido                                              |
| --------------------- | ------------------------------------------------------ |
| `{{to_email}}`        | Correo del comprador                                   |
| `{{to_name}}`         | Nombre del comprador                                   |
| `{{subject}}`         | Asunto que envia el servidor                           |
| `{{evento}}`          | Nombre del evento                                      |
| `{{fecha}}`           | Fecha del evento                                       |
| `{{lugar}}`           | Lugar del evento                                       |
| `{{tipo_entrada}}`    | General / VIP / Cortesia                               |
| `{{precio}}`          | Importe ya formateado (`45 000,00 CRC`)                |
| `{{estado}}`          | Estado interno de la entrada                           |
| `{{mensaje}}`         | Texto explicativo que cambia segun el momento          |
| `{{qr_url}}`          | Imagen PNG del QR, servida por tu propio dominio       |
| `{{ticket_url}}`      | Pagina web de la entrada                               |
| `{{referencia_corta}}`| 8 caracteres para dar soporte sin exponer el codigo    |

### Por que el QR va como URL y no como adjunto

- La API REST de EmailJS limita el tamano del cuerpo; un adjunto en base64 se
  acerca peligrosamente a ese limite.
- Gmail, Outlook y Apple Mail muestran imagenes remotas sin problema y las
  cachean en su propio proxy.
- La URL lleva una firma HMAC: no se puede adivinar, y si un dia hay que dejar
  de servir una imagen concreta, basta con anular la entrada.

---

## 6. Comprobar que funciona

```bash
curl https://TU-DOMINIO/api/salud
```

Debe responder `"correo": { "emailjs": true, ... }`. Despues haz una compra de
prueba, confirmala desde el panel y verifica que el correo llega con el QR
visible (revisa tambien la carpeta de spam).

## 7. Cuota

El plan gratuito de EmailJS son **200 correos al mes**. Cada entrada consume
dos (solicitud + confirmacion). Si generas cortesias en lote, desmarca
*"Enviar el QR por correo"* en el panel y reenvia solo las que hagan falta.
Para un evento mediano conviene un plan de pago o un proveedor transaccional
como Resend, Brevo o Amazon SES.
