# ClipForge Backend

Backend persistente de ClipForge para Express, FFmpeg, FFprobe, procesamiento de clips y Cloudflare R2. Está diseñado para desplegarse en Fly.io; el frontend Vite puede permanecer en Vercel.

## Arquitectura

- Fly.io ejecuta Express, FFmpeg y la cola secuencial.
- Un volumen Fly montado en `/data` conserva la base JSON y archivos temporales entre reinicios.
- Cloudflare R2 recibe las subidas directas desde el navegador y los MP4/SRT/miniaturas generados.
- Vercel solo sirve el frontend y usa `VITE_API_BASE_URL` para comunicarse con este servicio.

## Desarrollo local

```bash
cp .env.example .env
npm install
npm run dev
```

Backend: `http://localhost:8080`. Health check: `GET /healthz`.

En el frontend usa:

```env
VITE_API_BASE_URL=http://localhost:8080
```

## Primer despliegue en Fly.io

### 1. Instalar Flyctl en macOS

Sí, para seguir esta guía desde Terminal necesitas instalar `flyctl` en tu Mac. Con Homebrew:

```bash
brew install flyctl
fly auth login
```

Si no tienes Homebrew, usa el instalador oficial:

```bash
curl -L https://fly.io/install.sh | sh
```

Comprueba la instalación:

```bash
fly version
```

### 2. Obtener las credenciales de Cloudflare R2

No se crean dentro de **Settings** del bucket. Regresa a **Storage & databases → R2 → Overview**, busca **API Tokens**, pulsa **Manage** y después **Create Account API token**.

Configura el token así:

- Permiso: **Object Read & Write**.
- Bucket: **Apply to specific buckets only**.
- Bucket seleccionado: `clips` (o el nombre real de tu bucket).

Al terminar Cloudflare mostrará una sola vez:

- **Access Key ID** → `S3_ACCESS_KEY_ID`
- **Secret Access Key** → `S3_SECRET_ACCESS_KEY`
- **S3 API endpoint** → `S3_ENDPOINT`

Guarda esos valores en un gestor de contraseñas. No los pegues en GitHub, `fly.toml`, README ni archivos versionados.

La correspondencia completa es:

```env
S3_ENDPOINT=https://TU_ACCOUNT_ID.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=clips
S3_ACCESS_KEY_ID=ACCESS_KEY_ID_MOSTRADO_POR_CLOUDFLARE
S3_SECRET_ACCESS_KEY=SECRET_ACCESS_KEY_MOSTRADO_POR_CLOUDFLARE
S3_PUBLIC_BASE_URL=
```

`S3_PUBLIC_BASE_URL` puede quedar vacío. ClipForge generará URLs firmadas para leer objetos privados. No necesitas habilitar **Public Development URL** ni crear un dominio personalizado.

### 3. Crear la aplicación y el volumen Fly

Cambia `app` en `fly.toml` por un nombre globalmente único y crea la aplicación:

```bash
fly apps create TU-NOMBRE-DE-APP
```

Crea el volumen persistente en Dallas (`dfw`), una región activa y cercana para usuarios de México:

```bash
fly volumes create clipforge_data --app TU-NOMBRE-DE-APP --region dfw --size 10
```

### 4. Configurar secretos en Fly

Nunca subas `.env` a GitHub. `GEMINI_API_KEY` es opcional; si todavía no la tienes, omite esa línea:

```bash
fly secrets set --app TU-NOMBRE-DE-APP \
  FRONTEND_ORIGIN=https://TU-FRONTEND.vercel.app \
  S3_ENDPOINT=https://TU_ACCOUNT_ID.r2.cloudflarestorage.com \
  S3_BUCKET=clips \
  S3_ACCESS_KEY_ID=TU_ACCESS_KEY_ID \
  S3_SECRET_ACCESS_KEY=TU_SECRET_ACCESS_KEY
```

No necesitas enviar como secretos `PORT`, `STORAGE_ROOT` ni `S3_REGION`: ya están definidos en `fly.toml`. Si luego quieres Gemini:

```bash
fly secrets set --app TU-NOMBRE-DE-APP GEMINI_API_KEY=TU_CLAVE
```

### 5. Desplegar

```bash
fly deploy --app TU-NOMBRE-DE-APP
fly status --app TU-NOMBRE-DE-APP
fly logs --app TU-NOMBRE-DE-APP
```

### 6. Conectar Vercel

En Vercel configura y vuelve a desplegar:

```env
VITE_API_BASE_URL=https://TU-APP.fly.dev
```

## Configuración CORS de R2

En el bucket R2 permite `PUT`, `GET` y `HEAD` desde el dominio de Vercel y desde `http://localhost:5173`. Permite al menos los headers `Content-Type` y `ETag`.

Ejemplo conceptual:

```json
[
  {
    "AllowedOrigins": ["https://TU-FRONTEND.vercel.app", "http://localhost:5173"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["Content-Type", "ETag"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

No configures por ahora una regla de expiración general sobre `uploads/`: allí también viven los videos originales registrados. ClipForge elimina los objetos vinculados cuando borras un video y reemplaza los objetos antiguos al recompilar.

## Notas operativas

- Mantén una sola máquina mientras se use la base JSON y la cola en memoria.
- El volumen Fly no se replica automáticamente. R2 protege los medios, pero para escalar a varias máquinas debe migrarse la base a Postgres y la cola a un sistema persistente.
- `auto_stop_machines = false` evita que una compilación FFmpeg sea interrumpida por suspensión.
- El endpoint de salud no ejecuta FFmpeg: solo confirma que el proceso HTTP está vivo.
