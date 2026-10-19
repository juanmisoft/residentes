# Residentes por vivienda · Rivas-Vaciamadrid

Visor 3D/2D (ArcGIS JS 4.33) para consultar ocupación del padrón por vivienda, con chatbot de agregados.

## Funcionalidades

- Mapa de viviendas (uni / pluri / incidencias), búsqueda, Street View, áreas, barrios
- Ficha de padrón por vivienda (tras login en el Portal)
- Chatbot con preguntas prefijadas (totales y rankings, sin datos personales)

## Seguridad

El padrón nominal **no está en este repositorio**. Se carga desde capas del Portal Enterprise con autenticación de organización.

Detalle: [SECURITY.md](SECURITY.md).

## Uso (producción / GitHub Pages / servidor estático)

1. Publica el contenido permitido por `.gitignore` (visor + `data/limite.json` + `data/chat_stats.json`).
2. `config.js` debe tener `dataSource: "portal"` y los `itemId` de viviendas/personas.
3. Quien abra el visor inicia sesión en `https://sit.rivasciudad.es/portal`.

Servidor local de prueba:

```bash
python server.py 8765
```

Abre `http://127.0.0.1:8765/` e inicia sesión en el Portal.

## Desarrollo con datos locales (solo en tu PC)

1. Genera `data/viviendas.geojson` y `data/personas.json` con los scripts ETL (no se suben a Git).
2. En `config.js`: `"dataSource": "local"` (no subas ese cambio si el remoto debe ser portal).
3. Regenera agregados del chat: `python build_chat_stats.py`.

## Actualizar capas del Portal

```bash
python publish_portal.py
```
