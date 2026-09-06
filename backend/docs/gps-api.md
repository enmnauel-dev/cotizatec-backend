# Contrato API — GPS / Rastreo de Flota

Contrato único de referencia entre el backend CotizaTec y la **app móvil** instalada en los
vehículos de la flota. Cualquier cambio en este contrato debe reflejarse aquí antes de entrar
al código.

Base URL: `https://cotizatec-backend.onrender.com` (producción)

Convenciones generales del API:

- Toda respuesta exitosa incluye `ok: true`. Toda respuesta de error incluye `error` (texto legible)
  y, cuando corresponde, un `code` estable para que la app pueda decidir sin parsear texto en español.
- Los errores con `code: "UNAUTHORIZED"` significan token ausente, inválido o expirado: la app debe
  volver a autenticar (login) y reintentar.
- Los `timestamp` de servidor se envían en ISO 8601 UTC (`YYYY-MM-DDTHH:MM:SSZ`). Los `ts` de posición
  son epoch en milisegundos (UTC), tanto si los envía la app como si los genera el servidor.

---

## 1. Autenticación

### POST `/api/client/login`

Obtiene el token que debe acompañar después a las llamadas de GPS.

**Request body (JSON):**

```json
{
  "username": "chofer1",
  "password": "PasswordSeguro123"
}
```

**Response 200 OK:**

```json
{
  "ok": true,
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "role": "empleado",
  "userId": "usr_987",
  "name": "Carlos Reyes"
}
```

- `role`: `owner` (dueño) o `empleado` (operador). La app móvil usa cuentas `empleado`.
- `userId`: id interno de la cuenta web; en la app suele bastar como referencia local.

**Errores:**

| Código | Error | Código HTTP | `code` |
| --- | --- | --- | --- |
| Credenciales incorrectas | "Usuario o contraseña incorrectos." | 401 | `INVALID_CREDENTIALS` |

> Nota: se usa el mismo pool de usuarios del portal web (`Crear usuario` del admin). Algo que la app
> movil deba soportar cuando el dueño desactiva la cuenta.

---

## 2. Reporte de ubicación (app móvil → servidor)

### POST `/api/client/gps`

Envía la posición actual del vehículo/operador.

**Headers:**

```
Authorization: Bearer <JWT_TOKEN_DEL_EMPLEADO>
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
| `ts` | number | no | epoch ms del momento de lectura del GPS. Si se omite, el servidor usa su reloj. |

**Response 200 OK:**

```json
{
  "ok": true,
  "pos": { "lat": 19.4512, "lon": -70.6973, "acc": 12.5, "speed": 45, "ts": 1725681523000 },
  "timestamp": "2026-09-06T19:58:44Z"
}
```

El servidor conserva **solo la última posición** por usuario del negocio.

**Errores:**

| Código | Código HTTP | `code` |
| --- | --- | --- |
| Token ausente, inválido o expirado | 401 | `UNAUTHORIZED` |
| El negocio no tiene el módulo GPS contratado | 403 | `MODULE_DISABLED` |
| `lat`/`lon` fuera de rango o no numéricos | 400 | `INVALID_COORDINATES` |

## 3. Vista de flota (panel web / dueño)

### GET `/api/client/gps`

Solo el **dueño** (`role: owner`) del negocio puede ver la flota. Intento con cuenta `empleado` → 403.

**Response 200 OK:**

```json
{
  "ok": true,
  "updated": 1725681523000,
  "timestamp": "2026-09-06T19:58:44Z",
  "positions": [
    {
      "username": "chofer1",
      "userId": "usr_987",
      "name": "Carlos Reyes",
      "role": "empleado",
      "status": "activo",
      "pos": { "lat": 19.4512, "lon": -70.6973, "acc": 12.5, "speed": 45, "ts": 1725681523000 }
    }
  ]
}
```

- Solo aparecen operadores que ya reportaron al menos una posición.
- `ts`: epoch ms de la última lectura; el panel marca "En línea" si `now - ts < 5 min`.

**Errores:**

| Código | Código HTTP | `code` |
| --- | --- | --- |
| No autenticado / token expirado | 401 | `UNAUTHORIZED` |
| La cuenta no es del dueño | 403 | `OWNER_ONLY` |
| El negocio no tiene el módulo GPS contratado | 403 | `MODULE_DISABLED` |

---

## 4. Recomendaciones de integración (app móvil)

- **Sin cobertura / fuera de línea:** almacenar los pings en buffer local (SQLite/Room) y reenviarlos
  en orden al recuperar red. Actualmente el servidor guarda solo la última posición, así que al reenviar
  un lote el resultado será la posición más reciente del lote.
- **Frecuencia:** enviar por umbral de distancia (ej. cada 15–30 m) o por tiempo (ej. cada 10–15 s en
  movimiento); pausar cuando el vehículo está apagado/estacionado. No enviar más de un ping cada ~5 s.
- **Encendido:** registrar el token obtenido en `POST /api/client/login` y renovarlo cuando el servidor
  devuelva 401 (`UNAUTHORIZED`).
- **Prefijar el `ts` con la hora local de captura** del GPS, no la de envío, para medir correctamente la
  antigüedad si hay cola offline.

## 5. Códigos de error estables (resumen)

| `code` | HTTP | Significado |
| --- | --- | --- |
| `UNAUTHORIZED` | 401 | Token ausente/inválido/expirado → re-login |
| `INVALID_CREDENTIALS` | 401 | Usuario o contraseña incorrectos |
| `MODULE_DISABLED` | 403 | Módulo GPS no contratado en el negocio |
| `OWNER_ONLY` | 403 | Solo acciones del dueño |
| `ACCOUNT_DISABLED` | 403 | La cuenta web está desactivada |
| `INVALID_COORDINATES` | 400 | `lat`/`lon` fuera de rango o no numérico |