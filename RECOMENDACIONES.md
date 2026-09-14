# Que anadir despues

Ordenado por lo que mas te va a doler si falta el dia del evento.

---

## Prioridad alta — antes de vender

### 1. Cobro automatico en vez de referencia manual

Hoy el comprador escribe una referencia y un administrador la aprueba a mano.
Funciona para 50 entradas; con 300 es un cuello de botella, y nada impide que
alguien invente una referencia y espere que cuele.

Lo que resuelve el problema de verdad es un **webhook del proveedor de pago**:
PayPal, Stripe o Tilopay (este ultimo cubre SINPE y tarjetas en Costa Rica).
El flujo pasa a ser: el comprador paga -> el proveedor avisa a tu servidor con
una firma verificable -> la entrada se activa sola y sale el correo.

Punto critico: **verifica siempre la firma del webhook**. Un webhook sin firmar
es un endpoint publico que regala entradas.

### 2. Aforo y control de existencias

`EVENTOS` ya acepta un campo `aforo`, pero todavia no se aplica. Sin limite
puedes vender 500 entradas para un local de 200 personas. Necesitas un contador
por evento incrementado dentro de la misma transaccion que crea la entrada
(si no, dos compras simultaneas se saltan el limite).

### 3. Modo sin conexion para el escaner

Si el wifi del local falla, hoy no entra nadie. La solucion habitual es
descargar la lista de entradas validas al telefono antes de abrir puertas,
validar contra esa copia local y sincronizar despues.

Mientras tanto, minimo imprescindible: el movil del staff con datos moviles y
una lista impresa de respaldo.

### 4. Copias de seguridad probadas

Activa las exportaciones programadas de Firestore **y restaura una** en un
proyecto de pruebas. Una copia que nunca se ha restaurado no es una copia.

---

## Prioridad media — mejoran mucho la operacion

### 5. Varias entradas en una sola compra

Ahora cada compra genera una entrada. Casi todo el mundo compra para un grupo.
Anade un selector de cantidad que genere N entradas y las envie en un solo
correo, con un QR distinto por persona.

### 6. Panel con numeros reales

Un panel que muestre por evento: vendidas, ingresadas, pendientes de pago,
ingresos y ritmo de entrada por hora. Sin eso vas a ciegas durante el evento.
Anade tambien exportar a CSV para la contabilidad.

### 7. Registro de auditoria

Una coleccion `auditoria` con quien confirmo cada pago, quien anulo que entrada
y desde donde. Cuando aparezca una discrepancia el dia del evento, es la unica
forma de reconstruir lo que paso.

### 8. Segundo factor para los administradores

La cuenta de administrador puede generar entradas gratis. Un TOTP (Google
Authenticator) sobre la contrasena actual cuesta poco y evita que una
contrasena filtrada se convierta en entradas regaladas.

### 9. Reventa controlada

Un boton de "transferir entrada" que invalide el QR anterior y emita uno nuevo
al correo del nuevo titular. Evita que la gente revenda por su cuenta con
capturas de pantalla, que es el fraude mas comun en eventos.

### 10. Compilar Tailwind en lugar del CDN

`cdn.tailwindcss.com` compila estilos en el navegador: va lento, obliga a
permitir `unsafe-eval` en la CSP y depende de un tercero. Compilarlo en el
build quita las tres cosas.

---

## Prioridad baja — cuando el resto funcione

- **Lista de acceso por puerta**: varios escaneres con zonas distintas (VIP vs
  General) y un contador de aforo en vivo por puerta.
- **Recordatorio automatico** 24 h antes del evento con el QR otra vez: reduce
  mucho el "perdi el correo" en la entrada.
- **Apple Wallet / Google Wallet**: el asistente guarda la entrada en el movil y
  no depende de encontrar el correo.
- **Codigos de descuento** con limite de usos y caducidad.
- **Politica de retencion de datos**: borrar automaticamente correos y telefonos
  pasados 6-12 meses del evento. Menos datos guardados, menos que perder.
- **Monitorizacion**: Sentry para errores y un aviso si `/api/salud` deja de
  responder. Enterarte por un cliente es tarde.
- **Pruebas de carga**: la venta se concentra en los minutos posteriores al
  anuncio. Comprueba que aguanta antes de descubrirlo en directo.

---

## Lo legal, que no es opcional

`terminos.html` y `privacidad.html` estan practicamente vacios. Antes de cobrar
necesitas al menos:

- Politica de reembolsos y cancelacion (que pasa si se suspende el evento).
- Tratamiento de datos personales: que guardas, cuanto tiempo y como se
  solicita el borrado.
- Datos fiscales del vendedor y como se emite la factura.
- Condiciones de acceso: edad minima, derecho de admision, que pasa con una
  entrada duplicada en la puerta.

Redactalo con alguien que conozca la normativa de Costa Rica; no es algo que
convenga improvisar.
