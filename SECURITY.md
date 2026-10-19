# Seguridad del visor de residentes

## Qué hay en GitHub (público)

Solo código del visor y datos **agregados / geográficos** sin padrón nominal:

| Archivo | Contenido |
|---------|-----------|
| `index.html`, `app.js`, `styles.css`, `config.js` | Interfaz |
| `data/limite.json` | Contorno municipal |
| `data/chat_stats.json` | Totales y rankings (sin nombres ni DNI) |
| Scripts `*.py` | ETL / publicación (sin contraseñas embebidas) |

## Qué NUNCA debe subirse

Quedan bloqueados por `.gitignore` (lista blanca):

- `data/personas.json` y cualquier export con nombre / DNI / documento
- `data/viviendas.geojson` (dirección + RC + ocupación por vivienda)
- Excel / CSV del padrón (`Habitantes*.xlsx`, `Padron_*.csv`, `padron_refcat.csv`, …)
- Caches de Catastro / portales / Infoelectoral
- Tokens, contraseñas o `.env`

## Cómo funciona en producción (mismas funciones, con auth)

1. `config.js` usa `dataSource: "portal"`.
2. El mapa y el padrón se cargan de capas del **Portal Enterprise** (`sit.rivasciudad.es`), restringidas a la organización.
3. El usuario debe **iniciar sesión** en el Portal; sin cuenta org no hay viviendas ni personas.
4. El chatbot lee solo `chat_stats.json` (agregados regenerables con `python build_chat_stats.py` en local).

## Desarrollo local (opcional)

En tu máquina puedes poner `dataSource: "local"` y tener `data/viviendas.geojson` + `data/personas.json` **sin commitearlos**. El `.gitignore` impide que salgan en el push.

## Publicar datos al Portal

```text
python publish_portal.py
```

Pide usuario/contraseña por consola (o `PORTAL_USER` / `PORTAL_PASSWORD` en el entorno). No guardes la contraseña en el repo.
