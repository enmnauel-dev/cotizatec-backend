# Contrato API — GPS / Rastreo de Flota

Contrato único de referencia entre el backend CotizaTec, la **app móvil** (los teléfonos de los
operadores) y el **panel web del dueño**. Cualquier cambio debe reflejarse aquí antes de entrar al código.

Base URL: `https://cotizatec-backend.onrender.com`

Identidad: la **app móvil** no usa cuentas web; se identifica por **deviceId** (el mismo que ya usa
para licencia y backups) y autentica con el **token de licencia firmado** que el servidor le entrega
en `GET /api/license/:deviceId`. El dueño ve cada dispositivo de su negocio (con su `alias`), y la
posición de dichos dispositivos es lo que muestra la tarjeta GPS.

Convenciones:

- Respuestas exitosas incluyen `ok: true`. Errores incluyen `error` (texto legible) y `code` estable.
- `UNAUTHORIZED` en el POST de GPS = token de licencia ausente/vencido: la app debe refrescarlo con
  `GET /api/license/:deviceId` y reintentar.
- `ts` de posición: epoch en milisegundos (UTC). `timestamp` en respuestas: ISO 8601 UTC.

---

## 1. Identidad y token (app móvil)

### GET `/api/license/:deviceId`

Ya existente (lo usa la app). Devuelve `{status, token}`; el `token` es firmado y es el que se usa como
Bearer en el POST de GPS.

## 2. Reporte de ubicación (app móvil → servidor)

### POST `/api/client/gps`

**Headers:**

```
Authorization: Bearer <TOKEN_DE_LICENCIA_DEL_DISPOSITIVO>
Content-Type: application/json
```

**Request body (JSON):**

```json
{
  "lat": 19.4512,
  "lon": -70.6973,
  "acc": 12.5,
  "speed": 45.0,
  "ts": 1725681523000
}
```

| Campo | Tipo | Requerido | Rango / Notas |
| --- | --- | --- | --- |
| `lat` | number | sí | latitud, entre -90 y 90 |
| `lon` | number | sí | longitud, entre -180 y 180 |
| `acc` | number | no | precisión en metros (≥ 0) |
| `speed` | number | no | velocidad km/h (≥ 0) |
| `ts` | number | no | epoch ms de la lectura del GPS. Si se omite, usa el reloj del servidor. |

El deviceId se toma del token firmado (no se confía en el body). El servidor guarda **solo la última
posición** por dispositivo.

**Response 200 OK:**

```json
{
  "ok": true,
  "pos": { "lat": 19.4512, "lon": -70.6973, "acc": 12.5, "speed": 45, "ts": 1725681523000 },
  "timestamp": "2026-09-06T19:58:44Z"
}
```

**Errores:**

| Código HTTP | `code` | Significado |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | Token de licencia ausente, inválido o vencido |
| 403 | `DEVICE_UNASSIGNED` | El dispositivo no está vinculado a un negocio |
| 403 | `MODULE_DISABLED` | El negocio no tiene contratado el módulo GPS |
| 400 | `INVALID_COORDINATES` | `lat`/`lon` fuera de rango o no numéricos |

## 3. Vista de flota (panel web del dueño)

### GET `/api/client/gps`

Se autentica con el token web del dueño (`POST /api/client/login`). Solo `role: owner`.
Devuelve la posición actual de **cada dispositivo del negocio** que haya reportado al menos una vez,
con su `alias` (nombre asignado por el dueño en el admin) como `name`.

**Response 200 OK:**

```json
{
  "ok": true,
  "updated": 1725681523000,
  "timestamp": "2026-09-06T19:58:44Z",
  "positions": [
    {
      "deviceId": "cotizatec-abcd1234",
      "name": "Furgón 1",
      "pos": { "lat": 19.4512, "lon": -70.6973, "acc": 12.5, "speed": 45, "ts": 1725681523000 }
    }
  ]
}
```

**Errores:** 401 `UNAUTHORIZED`, 403 `OWNER_ONLY`, 403 `MODULE_DISABLED`.

---

## 4. Recomendaciones de integración (app móvil)

- La app envía cada **15 s** mientras está abierta y visible. Con pantalla apagada no envía (requiere
  fondo/foreground service, fuera de alcance de esta versión).
- **Sin cobertura:** se ignora el envío y se reintenta en el próximo ciclo. El servidor guarda una sola
  posición por dispositivo, así que al recuperar red el mapa muestra la posición más reciente.
- **403 `MODULE_DISABLED` / `DEVICE_UNASSIGNED`:** la app pausa 5 minutos y reintenta (el dueño puede
  activar el módulo mientras tanto).
- **401:** refrescar token vía `GET /api/license/:deviceId` antes de reintentar.

## 5. Códigos de error estables (resumen)

| `code` | HTTP | Significado |
| --- | --- | --- |
| `UNAUTHORIZED` | 401 | Token (web o dispositivo) ausente/inválido/expirado |
| `INVALID_CREDENTIALS` | 401 | Usuario o contraseña incorrectos (login web) |
| `MODULE_DISABLED` | 403 | Módulo GPS no contratado en el negocio |
| `OWNER_ONLY` | 403 | Solo acciones del dueño (web) |
| `ACCOUNT_DISABLED` | 403 | La cuenta web está desactivada |
| `DEVICE_UNASSIGNED` | 403 | Dispositivo sin negocio vinculado |
| `INVALID_COORDINATES` | 400 | `lat`/`lon` fuera de rango o no numérico |