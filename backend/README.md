# CotizaTec Backend — Licencias + Bot de Telegram

Servidor de licencias y bot de administración para la app CotizaTec.
Permite activar/bloquear licencias de pago mensual y recibir avisos por Telegram.

## Estructura

```
backend/
  server.js        # API HTTP (register, license, device)
  bot.js           # Bot de Telegram (comandos de administración)
  license.js       # Firma/verificación Ed25519 de licencias
  store.js         # Almacenamiento (JSON local; DATABASE_URL soportado)
  scripts/genkeys.js  # Genera las claves Ed25519
  .env.example     # Variables de entorno de referencia
```

## Puesta en marcha (local)

1. Instalar dependencias:
   ```bash
   cd backend
   npm install
   ```
2. Generar las claves Ed25519:
   ```bash
   npm run genkeys
   ```
   Copia los valores de `keys.json` a `.env` como `LICENSE_PUBLIC_KEY` y `LICENSE_PRIVATE_KEY`.

3. Crear el `.env` (copia de `.env.example`) y completar:
   - `TELEGRAM_TOKEN`: token del bot creado con @BotFather.
   - `ADMIN_CHAT_ID`: tu chat con el bot (aparece al escribir /start).
   - `LICENSE_DAYS`: duración de licencia (30).
   - `GRACE_DAYS`: días de gracia (15).

4. Arrancar:
   ```bash
   npm start
   ```
   El servidor queda en `http://localhost:3000`. El bot queda escuchando comandos.

## Comandos del bot

| Comando | Descripción |
|---|---|
| `/start` o `/ayuda` | Lista de comandos |
| `/usuarios` | Usuarios registrados y licencias activas |
| `/activar <deviceId> [días]` | Activa licencia (por defecto 30 días) |
| `/renovar <deviceId> [días]` | Renueva/amplía licencia |
| `/bloquear <deviceId>` | Revoca licencia (bloquea la app) |
| `/estado <deviceId>` | Estado actual de un dispositivo |
| `/avisar <deviceId>` | Aviso de pago al cliente |

Solo el `ADMIN_CHAT_ID` puede usar estos comandos.

## API

- `GET /api/health` — salud del servidor.
- `POST /api/register` — registra un dispositivo (`{deviceId, appVersion, platform}`).
- `GET /api/license/:deviceId` — devuelve `{status: none|active|grace|expired, token}`.
  El `token` es una licencia firmada Ed25519 que la app verifica localmente (offline).
- `GET /api/device/:deviceId` — estado de la licencia de un dispositivo.

## Despliegue en Render

1. Crea un Web Service apuntando a la carpeta `backend`.
2. Build command: `npm install`
3. Start command: `npm start`
4. Variables de entorno: todas las de `.env.example` (genera claves con `npm run genkeys`).
5. **Persistencia**: Render Free tiene disco efímero. Para datos permanentes, añade un
   Postgres (Render/Railway/Supabase/Neon) y pon su URL en `DATABASE_URL`. El `store.js`
   usa Postgres cuando `DATABASE_URL` está definido; si no, usa el archivo `data.json`.

## Despliegue en Railway

1. Crea un nuevo servicio y apunta a la carpeta `backend`.
2. Railway detecta `npm start` automáticamente.
3. Añade las variables de entorno igual que en Render.
4. Railway ofrece Postgres gratuito (Starter) — añádelo y configura `DATABASE_URL`.

## Nota importante

La clave pública (LICENSE_PUBLIC_KEY) está incrustada en `js/license.js` de la app
para verificar firmas offline. Si la regeneras, debes actualizar `js/license.js`,
recompilar la app y volver a activar licencias.