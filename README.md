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

1. Instala Flyctl e inicia sesión:

```bash
brew install flyctl
fly auth login
```

2. Cambia `app` en `fly.toml` si `clipforge-backend` ya está ocupado y crea la aplicación sin desplegar:

```bash
fly launch --no-deploy --copy-config
```

3. Crea el volumen persistente en Miami:

```bash
fly volumes create clipforge_data --region mia --size 10
```

4. Configura secretos. Nunca subas `.env` a GitHub:

```bash
fly secrets set \
  FRONTEND_ORIGIN=https://TU-FRONTEND.vercel.app \
  GEMINI_API_KEY=... \
  S3_ENDPOINT=https://TU_ACCOUNT_ID.r2.cloudflarestorage.com \
  S3_REGION=auto \
  S3_BUCKET=clipforge \
  S3_ACCESS_KEY_ID=... \
  S3_SECRET_ACCESS_KEY=... \
  S3_PUBLIC_BASE_URL=https://media.tudominio.com
```

`S3_PUBLIC_BASE_URL` es opcional. Si el bucket es privado, déjalo vacío: el backend entregará redirecciones GET firmadas y temporales.

5. Despliega y revisa los logs:

```bash
fly deploy
fly status
fly logs
```

6. En Vercel configura y vuelve a desplegar:

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

## Notas operativas

- Mantén una sola máquina mientras se use la base JSON y la cola en memoria.
- El volumen Fly no se replica automáticamente. R2 protege los medios, pero para escalar a varias máquinas debe migrarse la base a Postgres y la cola a un sistema persistente.
- `auto_stop_machines = false` evita que una compilación FFmpeg sea interrumpida por suspensión.
- El endpoint de salud no ejecuta FFmpeg: solo confirma que el proceso HTTP está vivo.
