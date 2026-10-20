# Datos en el repositorio

Solo archivos **seguros para GitHub**:

- `limite.json` — geometría del municipio (máscara del mapa).
- `uni_xy_overrides.json` — coordenadas por parcela (RC) para unifamiliares apilados (sin PII).
- `chat_stats.json` — agregados del chatbot (sin PII). Regenerar en local:

```bash
python build_chat_stats.py
```

El padrón (`personas.json`, `viviendas.geojson`, Excel, caches) **no se versiona**. En producción lo sirven las capas autenticadas del Portal Enterprise.
