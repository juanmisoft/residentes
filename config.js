/* Configuración del visor · Rivas-Vaciamadrid
 *
 * Producción / GitHub: dataSource "portal" (capas Enterprise con login org).
 * Desarrollo local: "local" + data/viviendas.geojson y personas.json (gitignored).
 * No pongas contraseñas ni tokens aquí.
 */
window.RESIDENTES_CONFIG = {
  dataSource: "portal",
  portalUrl: "https://sit.rivasciudad.es/portal",
  viviendasItemId: "35fc05e3903e42f2b8aeba6482e62b50",
  personasItemId: "3ae315e68b43410487d9df1f5563b01a",
  // Fecha del fichero de habitantes (Habitantes a fecha 08_10_26.xlsx)
  fechaPadron: "2026-10-08"
};
