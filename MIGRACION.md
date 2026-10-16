# Migración de CotizaTec a un servidor Linux propio

Guía para mudar el **backend** desde Render (y opcionalmente la base de datos desde Neon)
a un servidor Linux propio (VPS). Pensada para hacer en una sola sesión, sin improvisar.

---

## 0. Antes de empezar (¡lo más importante!)

> [!WARNING]
> **Guarda las claves de licencia en un lugar seguro ANTES de tocar nada.**
> La app verifica las licencias con una **clave pública embebida** en el APK
> (`js/license.js` → `LICENSE_PUBLIC_KEY_PEM`). Si migras con una clave privada
> distinta, **TODAS las licencias emitidas se invalidan**.

Copia desde las variables de entorno de Render (o de `backend/.env`):

- `LICENSE_PRIVATE_KEY`
- `LICENSE_PUBLIC_KEY`
- `TELEGRAM_TOKEN`
- `ADMIN_CHAT_ID`
- `WEB_TOKEN_SECRET`
- `DATABASE_URL` (si sigues usando Neon)

Guárdalas en un gestor de contraseñas. **Sin estas claves la migración rompe el sistema.**

---

## 1. Arquitectura actual (lo que vas a mover)

| Componente | Dónde está hoy | Qué es |
|---|---|---|
| Backend (app + paneles) | Render | Un solo proceso Node/Express (`node server.js`) |
| Base de datos | Neon | Postgres vía `DATABASE_URL` |
| Bot de Telegram | Render (polling) | `node-telegram-bot-api` — **no necesita URL pública** |
| App Android | APK en los teléfonos | Apunta fijo a `https://cotizatec-backend.onrender.com` |

El backend sirve también los paneles web (`/panel`, `/admin`) desde `backend/public`.

---

## 2. Puntos críticos (por qué no es solo "copiar y pegar")

1. **La app apunta a onrender de forma fija.** En `js/license.js:2` y `js/backup.js:163`
   usa `LICENCE_SERVER_BASE` y, si no existe, cae a `https://cotizatec-backend.onrender.com`.
   Hoy `LICENCE_SERVER_BASE` **no está definido** → la app siempre usa onrender.
   Al mudarte debes:
   - Tener un **dominio propio** (ej. `api.tudominio.com`) apuntando a la IP del server.
   - Definir `LICENCE_SERVER_BASE` en `index.html` **antes** de `backup.js`/`license.js`:
     ```html
     <script>var LICENCE_SERVER_BASE = 'https://api.tudominio.com';</script>
     ```
   - **Regenerar y publicar un nuevo APK.** Las apps ya instaladas seguirán usando
     onrender hasta que el usuario actualice.

2. **Android bloquea HTTP sin cifrar.** El backend propio **debe** ir con **HTTPS**
   (nginx + certificado Let's Encrypt). Un `http://IP:3000` no funcionará en la app.

3. **No puedes "reapuntar" el dominio de Render.** `onrender.com` es de Render; no
   controlas su DNS. Por eso necesitas dominio propio.

4. **Claves de licencia idénticas** (ver sección 0).

---

## 3. Requisitos del servidor

- Debian/Ubuntu (o similar) actualizado
- **Node.js 20** LTS
- **PostgreSQL** (solo si NO sigues con Neon)
- **nginx** (proxy inverso + HTTPS)
- **certbot** (certificados)
- Recursos: mínimo ~1 GB RAM / 1 vCPU (2 GB recomendado si el Postgres va en el mismo server)

---

## 4. Instalación paso a paso

### 4.1 Node.js 20
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # debe mostrar v20.x
```

### 4.2 Copiar el backend
Sube la carpeta `backend/` (sin `node_modules`, sin `.env`) al server, p. ej. a `/opt/cotizatec`.

```bash
cd /opt/cotizatec/backend
npm install --omit=dev
```

### 4.3 Crear `backend/.env`
```ini
# Base de datos (Neon o Postgres local)
DATABASE_URL=postgresql://usuario:pass@host:5432/cotizatec

# Licencias (¡las MISMAS de siempre!)
LICENSE_PRIVATE_KEY=...
LICENSE_PUBLIC_KEY=...

# Bot de Telegram
TELEGRAM_TOKEN=...
ADMIN_CHAT_ID=...

# Firma de sesiones del panel web
WEB_TOKEN_SECRET=...

# Parámetros de negocio (ajusta si usabas otros)
LICENSE_DAYS=30
GRACE_DAYS=15
TRIAL_DAYS=15

# Puerto interno del proceso Node
PORT=3000
```
Permisos: `chmod 600 backend/.env`

### 4.4 Arranque permanente con pm2
```bash
sudo npm i -g pm2
pm2 start server.js --name cotizatec-backend
pm2 save
pm2 startup   # ejecuta el comando que imprima
```
Verifica: `pm2 logs cotizatec-backend` y `curl http://127.0.0.1:3000/api/health`.

### 4.5 nginx + HTTPS
`/etc/nginx/sites-available/cotizatec`:
```nginx
server {
    listen 80;
    server_name api.tudominio.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/cotizatec /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.tudominio.com   # obtiene y renueva el certificado
```
certbot instala la renovación automática. Prueba: `https://api.tudominio.com/api/health`.

### 4.6 Firewall
```bash
sudo ufw allow 80
sudo ufw allow 443
sudo ufw allow 22     # SSH (no lo cierres antes de confirmar acceso)
sudo ufw enable
```
El puerto **3000 debe quedar cerrado al exterior** (solo nginx entra por localhost).

---

## 5. Migrar la base de datos (solo si dejas Neon y usas Postgres local)

### Opción A — Seguir con Neon (recomendada, cero migración)
No hagas nada: mantén el `DATABASE_URL` de Neon. Solo cambias dónde corre Node.

### Opción B — Postgres en tu server
```bash
# 1. Instalar Postgres
sudo apt install -y postgresql
sudo -u postgres createuser --pwprompt cotizatec
sudo -u postgres createdb -O cotizatec cotizatec

# 2. Volcar desde Neon (ejecuta donde tengas pg_dump y acceso a Neon)
pg_dump "postgresql://...neon..." --no-owner --no-privileges -f dump.sql

# 3. Restaurar en el server
psql "postgresql://cotizatec:pass@127.0.0.1:5432/cotizatec" < dump.sql
```
Luego pon ese `DATABASE_URL` local en `backend/.env` y reinicia: `pm2 restart cotizatec-backend`.

> El esquema lo crea el propio backend al arrancar (`ensureSchema`), así que una base
> vacía también funciona; el `dump.sql` solo sirve para conservar los datos actuales.

---

## 6. Actualizar la app Android

1. Edita `index.html` (raíz) y agrega, antes de `js/backup.js` y `js/license.js`:
   ```html
   <script>var LICENCE_SERVER_BASE = 'https://api.tudominio.com';</script>
   ```
2. Espeja los JS a `www` (recordatorio: `www/` está en .gitignore):
   ```powershell
   Copy-Item "js\*.js" "www\js\" -Force
   npx cap sync android
   ```
3. Compila y publica el APK:
   ```powershell
   $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
   ./gradlew assembleDebug --no-daemon
   adb install -r "android\app\build\outputs\apk\debug\app-debug.apk"
   ```
4. Distribuye la nueva versión a los usuarios. **Mientras no actualicen, seguirán
   usando onrender**, así que **no apagues Render** hasta que migren todos los clientes.

---

## 7. Verificación final

- [ ] `https://api.tudominio.com/api/health` responde `{"ok":true,...,"db":{"ok":true}}`
- [ ] El panel `https://api.tudominio.com/panel` abre y permite iniciar sesión
- [ ] El bot de Telegram responde (`/start`, `/estado`)
- [ ] Un dispositivo de prueba **activa licencia** contra el nuevo servidor
- [ ] Un dispositivo de prueba **sube y descarga respaldo** correctamente
- [ ] El respaldo aparece en el panel web (módulo Clientes/Documentos)

---

## 8. Rotación de secretos

- La contraseña de Neon se compartió en un chat → **rótala** (Neon → Rotate password)
  y actualiza `DATABASE_URL` en Render y en el nuevo `backend/.env`.
- Usa contraseñas fuertes para Postgres y guarda todo en un gestor de contraseñas.

---

## 9. Rollback

Render queda intacto durante la migración:
- Si algo falla, apunta la app de nuevo a onrender (revirtiendo `LICENCE_SERVER_BASE`)
  y sigue operando con el servicio viejo.
- No borres Render ni Neon hasta validar la sección 7 al 100%.

---

## 10. Checklist rápido (resumen)

- [ ] Claves de licencia guardadas (sección 0)
- [ ] Dominio propio → IP del server (DNS)
- [ ] Node 20 + `npm install --omit=dev`
- [ ] `backend/.env` completo + `chmod 600`
- [ ] `pm2 start` + `pm2 save` + `startup`
- [ ] nginx configurado + certbot (HTTPS)
- [ ] Firewall: 80/443 abiertos, 3000 cerrado
- [ ] BD: Neon tal cual **o** Postgres local restaurado
- [ ] `LICENCE_SERVER_BASE` en `index.html` + APK reconstruido
- [ ] Verificación (sección 7) OK
- [ ] Render/Neon apagados **solo al final**
