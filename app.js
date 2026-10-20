require([
  "esri/config",
  "esri/identity/IdentityManager",
  "esri/Map",
  "esri/Basemap",
  "esri/views/SceneView",
  "esri/views/MapView",
  "esri/Viewpoint",
  "esri/layers/SceneLayer",
  "esri/layers/GeoJSONLayer",
  "esri/layers/FeatureLayer",
  "esri/layers/TileLayer",
  "esri/symbols/PointSymbol3D",
  "esri/symbols/ObjectSymbol3DLayer",
  "esri/symbols/TextSymbol3DLayer",
  "esri/symbols/IconSymbol3DLayer",
  "esri/symbols/callouts/LineCallout3D",
  "esri/renderers/UniqueValueRenderer",
  "esri/geometry/Point",
  "esri/geometry/Polygon",
  "esri/geometry/support/webMercatorUtils",
  "esri/Graphic",
  "esri/layers/GraphicsLayer",
  "esri/widgets/Home",
  "esri/widgets/BasemapGallery",
  "esri/widgets/Expand"
], function (
  esriConfig,
  IdentityManager,
  Map,
  Basemap,
  SceneView,
  MapView,
  Viewpoint,
  SceneLayer,
  GeoJSONLayer,
  FeatureLayer,
  TileLayer,
  PointSymbol3D,
  ObjectSymbol3DLayer,
  TextSymbol3DLayer,
  IconSymbol3DLayer,
  LineCallout3D,
  UniqueValueRenderer,
  Point,
  Polygon,
  webMercatorUtils,
  Graphic,
  GraphicsLayer,
  Home,
  BasemapGallery,
  Expand
) {
  const APP_CFG = window.RESIDENTES_CONFIG || {};
  const USE_PORTAL = (APP_CFG.dataSource || "portal") === "portal";
  const PORTAL_URL = APP_CFG.portalUrl || "https://sit.rivasciudad.es/portal";
  const VIVIENDAS_ITEM_ID = APP_CFG.viviendasItemId || "";
  const PERSONAS_ITEM_ID = APP_CFG.personasItemId || "";
  const FECHA_PADRON = APP_CFG.fechaPadron || "";
  if (USE_PORTAL && PORTAL_URL) {
    esriConfig.portalUrl = PORTAL_URL;
  }

  (function showFechaPadron() {
    const el = document.getElementById("statFechaPadron");
    if (!el || !FECHA_PADRON) return;
    const m = String(FECHA_PADRON).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    el.textContent = m ? (m[3] + "/" + m[2] + "/" + m[1]) : FECHA_PADRON;
  })();
  const COLORS = {
    1: "#3b82f6",
    2: "#14b8a6",
    3: "#eab308",
    4: "#f97316",
    5: "#ef4444"
  };
  const BLOCK_COLOR = "#0f6f6a";
  const MARKER_SCALE = 8000;

  let edificios = [];
  let edificiosPorRc = {};
  let censusPoints = [];
  let meta = null;
  let unifamiliarLayer = null;
  let plurifamiliarLayer = null;
  let incidenciaLayer = null;
  let labelPoints = [];
  let limiteRing = null;
  let parcelasOk = false;
  let mapView = null;
  let sceneView = null;
  let clipExtent = null;
  let limitePolygon = null;
  let homeExtent = null;
  let homeViewpoint3d = null;
  let savedCamera = null;
  let viewHandles = [];
  let switching = false;
  let popupVisibleHandle = null;
  let uniRenderer3d = null;
  let uniRenderer2d = null;
  let pluriRenderer3d = null;
  let pluriRenderer2d = null;
  let incRenderer3d = null;
  let incRenderer2d = null;
  let selectedTarget = null;
  let highlightHandle = null;
  let personasCache = null;
  let personasLoading = null;
  let personasLayer = null;
  let currentPadronContext = null;

  const LIMITE_QUERY = "https://sit.rivasciudad.es/server/rest/services/Termino_municipal_actual/FeatureServer/0/query?where=1%3D1&outFields=NOMBRE&returnGeometry=true&outSR=4326&f=json";

  function sphere(color, size) {
    return new PointSymbol3D({
      symbolLayers: [
        new ObjectSymbol3DLayer({
          resource: { primitive: "sphere" },
          width: size,
          height: size,
          depth: size,
          material: { color: color }
        })
      ]
    });
  }

  const numberSymbols = {};

  function flatMarker(color, style, size) {
    return {
      type: "simple-marker",
      style: style,
      size: size,
      color: color,
      outline: style === "diamond"
        ? { color: color, width: 0 }
        : { color: "#ffffff", width: 1 }
    };
  }

  function numberSymbol(value, lifted) {
    const flat = view.type === "2d";
    const key = (flat ? "flat:" : lifted ? "up:" : "dot:") + value;
    if (!numberSymbols[key]) {
      if (flat) {
        numberSymbols[key] = {
          type: "text",
          text: String(value),
          color: "#ffffff",
          haloColor: [20, 28, 38, 0.95],
          haloSize: 1.5,
          font: { size: 11, family: "Arial", weight: "bold" },
          yoffset: lifted ? 16 : 10
        };
        return numberSymbols[key];
      }
      const symbol = new PointSymbol3D({
        symbolLayers: [
          new TextSymbol3DLayer({
            text: String(value),
            material: { color: "#ffffff" },
            halo: { color: [20, 28, 38, 0.95], size: 1.5 },
            size: 13,
            font: { family: "Arial", weight: "bold" }
          })
        ]
      });
      if (lifted) {
        symbol.verticalOffset = {
          screenLength: 58,
          maxWorldLength: 48,
          minWorldLength: 8
        };
      }
      numberSymbols[key] = symbol;
    }
    return numberSymbols[key];
  }

  function featureUrl(features) {
    const blob = new Blob(
      [JSON.stringify({ type: "FeatureCollection", features: features })],
      { type: "application/geo+json" }
    );
    return URL.createObjectURL(blob);
  }

  function layerFromUrl(title, url, extra) {
    return new GeoJSONLayer(Object.assign({
      url: url,
      title: title,
      outFields: ["*"],
      popupEnabled: false,
      legendEnabled: false
    }, extra));
  }

  function plantaOrder(planta) {
    if (!planta || planta === "Sin planta") return 100;
    if (planta === "Sótano") return -1;
    if (planta === "Baja" || planta === "Unifamiliar") return 0;
    const n = parseInt(planta, 10);
    return isNaN(n) ? 50 : n;
  }

  function isUpperFloor(planta) {
    const text = String(planta || "").trim();
    if (!text || text === "Baja" || text === "Sin planta" || text === "Unifamiliar") return false;
    if (text === "Sótano" || text.indexOf("Sótano") === 0) return false;
    const n = parseInt(text, 10);
    return !isNaN(n) && n >= 1;
  }

  function isGroundCommunity(features) {
    if (!features || features.length < 2) return false;
    for (let i = 0; i < features.length; i++) {
      const planta = features[i].properties && features[i].properties.planta;
      if (isUpperFloor(planta)) return false;
    }
    return true;
  }

  function houseNumberLabel(props) {
    props = props || {};
    const letra = String(props.letra || "").trim();
    const portal = String(props.portal || "").trim();
    if (/^\d+$/.test(letra)) return letra;
    if (/^\d+$/.test(portal)) return portal;
    return "";
  }

  function looksLikeHouseNumbers(features) {
    if (!features || features.length < 4) return false;
    let numeric = 0;
    features.forEach(function (feature) {
      if (houseNumberLabel(feature.properties)) numeric += 1;
    });
    return numeric >= features.length * 0.6;
  }

  /** Chalets en la misma parcela/dirección (sin plantas altas, portales/letras numéricos). */
  function looksLikeChaletCluster(features) {
    if (!features || features.length < 4) return false;
    if (!isGroundCommunity(features)) return false;
    if (!looksLikeHouseNumbers(features)) return false;
    // Si hay plantas altas reales, es un bloque (aunque haya letras).
    for (let i = 0; i < features.length; i++) {
      const piso = String((features[i].properties && features[i].properties.piso) || "").trim().toUpperCase();
      if (/^P0*[2-9]/.test(piso) || /^P0*1\d/.test(piso)) return false;
    }
    return true;
  }

  function compareUnidad(a, b) {
    const byFloor = plantaOrder(a.planta) - plantaOrder(b.planta);
    if (byFloor) return byFloor;
    const byAddress = (a.direccion || "").localeCompare(b.direccion || "", "es");
    if (byAddress) return byAddress;
    const byPortal = String(a.portal || "").localeCompare(String(b.portal || ""), "es", { numeric: true });
    if (byPortal) return byPortal;
    return (a.puerta || a.letra || "").localeCompare(b.puerta || b.letra || "", "es");
  }

  function cargoNum(ref) {
    const text = String(ref || "");
    if (text.length < 18) return 0;
    const n = parseInt(text.slice(14, 18), 10);
    return isNaN(n) ? 0 : n;
  }

  function parseUnidadLetra(letra) {
    const text = String(letra || "").trim();
    const bloq = text.match(/^Bloq\.\s*(\d+|[A-Za-z])\s*(.*)$/i);
    if (bloq) {
      const n = parseInt(bloq[1], 10);
      return {
        portal: isNaN(n) ? bloq[1].toUpperCase() : String(n),
        puerta: bloq[2].trim(),
        kind: "bloque"
      };
    }
    const esc = text.match(/^Esc\.\s*(\d+|[A-Za-z])\s*(.*)$/i);
    if (esc) {
      const n = parseInt(esc[1], 10);
      return {
        portal: isNaN(n) ? esc[1].toUpperCase() : String(n),
        puerta: esc[2].trim(),
        kind: "escalera"
      };
    }
    return { portal: "", puerta: text, kind: "" };
  }

  function assignPortals(unidades) {
    if (!unidades || !unidades.length) return;
    const parsed = unidades.map(function (unidad) {
      return parseUnidadLetra(unidad.letra);
    });
    unidades.forEach(function (unidad, i) {
      unidad.puerta = parsed[i].puerta || unidad.letra || "";
      unidad.portal = "";
      unidad.portalKind = "";
    });
    const counts = {};
    unidades.forEach(function (unidad) {
      const key = (unidad.planta || "") + "\n" + (unidad.puerta || "");
      counts[key] = (counts[key] || 0) + 1;
    });
    const needsPortal = Object.keys(counts).some(function (key) {
      return counts[key] > 1;
    });
    if (!needsPortal) return;

    const explicit = parsed.filter(function (item) { return item.portal; }).length;
    if (explicit >= unidades.length * 0.6) {
      unidades.forEach(function (unidad, i) {
        if (!parsed[i].portal) return;
        unidad.portal = parsed[i].portal;
        unidad.portalKind = parsed[i].kind;
      });
    } else {
      const order = unidades.map(function (_, i) { return i; }).sort(function (a, b) {
        return cargoNum(unidades[a].ref) - cargoNum(unidades[b].ref);
      });
      let portal = 0;
      let prevFloor = null;
      order.forEach(function (i) {
        const floor = plantaOrder(unidades[i].planta);
        if (prevFloor == null || (floor <= 1 && prevFloor >= 3)) {
          portal += 1;
        }
        unidades[i].portal = String(portal);
        unidades[i].portalKind = "portal";
        prevFloor = floor;
      });
    }

    const used = {};
    unidades.slice().sort(function (a, b) {
      return cargoNum(a.ref) - cargoNum(b.ref);
    }).forEach(function (unidad) {
      const key = (unidad.planta || "") + "\n" + (unidad.puerta || "");
      const seen = used[key] || (used[key] = {});
      const portal = unidad.portal || "?";
      if (!seen[portal]) {
        seen[portal] = true;
        return;
      }
      let extra = 1;
      while (seen[portal + "-" + extra]) extra += 1;
      unidad.portal = portal + "-" + extra;
      seen[unidad.portal] = true;
    });
  }

  function portalKindLabel(unidad) {
    if (unidad.portalKind === "bloque") return "Bloque";
    if (unidad.portalKind === "escalera") return "Escalera";
    return "Portal";
  }

  function unidadLabel(unidad, showPortal) {
    const puerta = unidad.puerta || unidad.letra || "";
    const ref = String(unidad.ref || "").trim();
    const parts = [];
    if (showPortal && unidad.portal) {
      parts.push("<em class='portal-tag'>" + esc(portalKindLabel(unidad) + " " + unidad.portal) + "</em>");
    }
    if (puerta) parts.push(esc(puerta));
    if (ref) parts.push(esc(ref));
    return parts.join(" · ") || "Vivienda";
  }

  function unidadPlainLabel(unidad, showPortal) {
    const puerta = unidad.puerta || unidad.letra || "";
    const ref = String(unidad.ref || "").trim();
    const parts = [];
    if (showPortal && unidad.portal) {
      parts.push(portalKindLabel(unidad) + " " + unidad.portal);
    }
    if (puerta) parts.push(puerta);
    if (ref) parts.push(ref);
    return parts.join(" · ");
  }

  function padronMetaFromUnidad(unidad, direccion) {
    return {
      direccion: direccion || unidad.direccion || "",
      portal: unidad.portal || "",
      portalKind: portalKindLabel(unidad),
      planta: unidad.planta || "",
      letra: unidad.puerta || unidad.letra || "",
      ref: String(unidad.ref || "").trim()
    };
  }

  function buildPointLayers(features) {
    const uni = [];
    const unidadesPorRc = {};
    features.forEach(function (feature) {
      const props = feature.properties || {};
      if (props.tipo === "plurifamiliar") {
        const list = unidadesPorRc[props.rc] || (unidadesPorRc[props.rc] = []);
        const coords = feature.geometry && feature.geometry.coordinates;
        list.push({
          direccion: props.direccion,
          planta: props.planta,
          letra: props.letra,
          residentes: props.residentes,
          hombres: props.hombres,
          mujeres: props.mujeres,
          edad_media: props.edad_media,
          vid: props.vid || props.id,
          ref: props.ref || "",
          lon: coords ? coords[0] : null,
          lat: coords ? coords[1] : null
        });
        return;
      }
      uni.push(feature);
    });

    edificios.forEach(function (building) {
      const all = unidadesPorRc[building.rc] || [];
      let units = all;
      if (building.tipo === "plurifamiliar" && building.direccion) {
        const wanted = String(building.direccion).trim();
        const filtered = all.filter(function (u) {
          return String(u.direccion || "").trim() === wanted;
        });
        if (filtered.length) units = filtered;
      }
      building.unidades = units.slice().sort(compareUnidad);
      assignPortals(building.unidades);
      building.unidades.sort(compareUnidad);
    });

    const pluri = [];
    edificios.forEach(function (building) {
      if (building.tipo !== "plurifamiliar") return;
      if (building.lon == null || building.lat == null) return;
      const unidades = building.unidades || [];
      let hombres = 0;
      let mujeres = 0;
      let edadSum = 0;
      let edadN = 0;
      let residentes = 0;
      const vids = [];
      unidades.forEach(function (u) {
        residentes += Number(u.residentes) || 0;
        hombres += Number(u.hombres) || 0;
        mujeres += Number(u.mujeres) || 0;
        if (u.edad_media != null && u.residentes) {
          edadSum += Number(u.edad_media) * (Number(u.residentes) || 0);
          edadN += Number(u.residentes) || 0;
        }
        if (u.vid) vids.push(u.vid);
      });
      // Preferir media de las unidades de esta fachada (por si hay varias en la parcela)
      const focus = focusOf(building, building.direccion);
      if (focus && focus.lon != null) {
        building.lon = focus.lon;
        building.lat = focus.lat;
      }
      building.residentes = residentes || building.residentes;
      building.viviendas = unidades.length || building.viviendas;
      building.hombres = hombres;
      building.mujeres = mujeres;
      building.edad_media = edadN ? Math.round((edadSum / edadN) * 10) / 10 : null;
      building.vids = vids;
      pluri.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [building.lon, building.lat, 6] },
        properties: {
          rc: building.rc,
          direccion: building.direccion,
          residentes: building.residentes,
          viviendas: building.viviendas,
          hombres: hombres,
          mujeres: mujeres,
          edad_media: building.edad_media,
          vids: vids.join(","),
          tipo: "plurifamiliar",
          planta: "",
          letra: ""
        }
      });
    });

    const uniUrl = featureUrl(uni);
    const pluriUrl = featureUrl(pluri);
    const aboveRoof = { mode: "relative-to-scene", offset: 2, unit: "meters" };

    uniRenderer3d = new UniqueValueRenderer({
      field: "residentes",
      defaultSymbol: sphere(COLORS[5], 3.4),
      uniqueValueInfos: [1, 2, 3, 4].map(function (value) {
        return { value: value, symbol: sphere(COLORS[value], 3.4) };
      })
    });
    uniRenderer2d = new UniqueValueRenderer({
      field: "residentes",
      defaultSymbol: flatMarker(COLORS[5], "circle", 9),
      uniqueValueInfos: [1, 2, 3, 4].map(function (value) {
        return { value: value, symbol: flatMarker(COLORS[value], "circle", 9) };
      })
    });
    pluriRenderer3d = {
      type: "simple",
      symbol: new PointSymbol3D({
        symbolLayers: [
          new IconSymbol3DLayer({
            resource: { primitive: "square" },
            size: 18,
            material: { color: BLOCK_COLOR }
          })
        ],
        verticalOffset: {
          screenLength: 40,
          maxWorldLength: 36,
          minWorldLength: 4
        },
        callout: new LineCallout3D({
          size: 1.1,
          color: [15, 111, 106, 0.9]
        })
      })
    };
    pluriRenderer2d = {
      type: "simple",
      symbol: flatMarker(BLOCK_COLOR, "square", 11)
    };

    unifamiliarLayer = layerFromUrl("Unifamiliares", uniUrl, {
      minScale: 12000,
      labelsVisible: false,
      elevationInfo: aboveRoof,
      renderer: uniRenderer3d
    });

    plurifamiliarLayer = layerFromUrl("Plurifamiliares", pluriUrl, {
      minScale: MARKER_SCALE,
      labelsVisible: false,
      elevationInfo: aboveRoof,
      renderer: pluriRenderer3d
    });

    labelPoints = [];
    uni.forEach(function (feature) {
      const coords = feature.geometry.coordinates;
      labelPoints.push({
        lon: coords[0],
        lat: coords[1],
        residentes: feature.properties.residentes,
        kind: "uni"
      });
    });
    pluri.forEach(function (feature) {
      const coords = feature.geometry.coordinates;
      labelPoints.push({
        lon: coords[0],
        lat: coords[1],
        residentes: feature.properties.residentes,
        kind: "pluri"
      });
    });

    return [unifamiliarLayer, plurifamiliarLayer];
  }

  const TILES = {
    imagery: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer",
    streets: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer",
    topo: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer",
    gray: "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer",
    transport: "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer",
    places: "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer"
  };

  function tile(url, title) {
    return new TileLayer({ url: url, title: title });
  }

  function makeBasemap(id) {
    const titles = {
      hybrid: "Imagen y calles",
      satellite: "Imagen",
      streets: "Calles",
      topo: "Topográfico",
      gray: "Gris claro"
    };
    const title = titles[id] || titles.hybrid;
    if (id === "satellite") {
      return new Basemap({ id: id, title: title, baseLayers: [tile(TILES.imagery, "Imagen")] });
    }
    if (id === "streets") {
      return new Basemap({ id: id, title: title, baseLayers: [tile(TILES.streets, "Calles")] });
    }
    if (id === "topo") {
      return new Basemap({ id: id, title: title, baseLayers: [tile(TILES.topo, "Topográfico")] });
    }
    if (id === "gray") {
      return new Basemap({ id: id, title: title, baseLayers: [tile(TILES.gray, "Gris")] });
    }
    return new Basemap({
      id: "hybrid",
      title: titles.hybrid,
      baseLayers: [tile(TILES.imagery, "Imagen")],
      referenceLayers: [tile(TILES.transport, "Calles"), tile(TILES.places, "Topónimos")]
    });
  }

  const basemaps = ["hybrid", "satellite", "streets", "topo", "gray"].map(makeBasemap);

  const parcelasLayer = new FeatureLayer({
    url: "https://sit.rivasciudad.es/server/rest/services/PARCELAS_CATASTRALES_URBANA/FeatureServer/0",
    title: "Parcelas",
    outFields: ["REFCAT"],
    popupEnabled: false,
    opacity: 1,
    elevationInfo: { mode: "on-the-ground" },
    renderer: {
      type: "simple",
      symbol: {
        type: "simple-fill",
        color: [255, 255, 255, 0.04],
        outline: { color: [255, 255, 255, 0.55], width: 0.6 }
      }
    }
  });

  /** Portales municipales (SIT): puntos por acceso/fachada; no se dibuja en el mapa. */
  const portalesLayer = new FeatureLayer({
    url: "https://sit.rivasciudad.es/server/rest/services/ACCESOS_PORTALES/FeatureServer/0",
    title: "Portales",
    outFields: ["REFCATASTRAL", "ACCESO", "CALLE"],
    popupEnabled: false,
    visible: false,
    listMode: "hide"
  });

  // https://sit.rivasciudad.es/portal/home/item.html?id=c2cd53a576504626b6c655c07ec95208
  const barriosLayer = new FeatureLayer({
    url: "https://sit.rivasciudad.es/server/rest/services/BARRIOS_POR_N_VIV_2020/FeatureServer/0",
    title: "Barrios",
    outFields: ["*"],
    visible: false,
    popupEnabled: true,
    elevationInfo: { mode: "on-the-ground" },
    labelingInfo: [{
      labelExpressionInfo: { expression: "$feature.NOMBRE" },
      symbol: {
        type: "text",
        color: [28, 36, 48, 0.95],
        haloColor: [255, 255, 255, 0.92],
        haloSize: 1.4,
        font: { size: 12, weight: "bold" }
      },
      labelPlacement: "always-horizontal"
    }],
    labelsVisible: true,
    renderer: {
      type: "unique-value",
      field: "NOMBRE",
      defaultSymbol: {
        type: "simple-fill",
        color: [120, 120, 120, 0.18],
        outline: { color: [80, 80, 80, 0.75], width: 1.4 }
      },
      uniqueValueInfos: [
        {
          value: "Barrio Centro",
          label: "Centro",
          symbol: {
            type: "simple-fill",
            color: [15, 111, 106, 0.28],
            outline: { color: [15, 111, 106, 0.95], width: 1.6 }
          }
        },
        {
          value: "Barrio Este",
          label: "Este",
          symbol: {
            type: "simple-fill",
            color: [217, 119, 6, 0.28],
            outline: { color: [180, 83, 9, 0.95], width: 1.6 }
          }
        },
        {
          value: "Barrio Oeste",
          label: "Oeste",
          symbol: {
            type: "simple-fill",
            color: [37, 99, 235, 0.26],
            outline: { color: [29, 78, 216, 0.95], width: 1.6 }
          }
        }
      ]
    },
    popupTemplate: {
      title: "{NOMBRE}",
      content: [
        {
          type: "fields",
          fieldInfos: [
            { fieldName: "NOMBRE", label: "Barrio" },
            { fieldName: "UNIFAMILIAR", label: "Unifamiliares" },
            { fieldName: "SUM_VIV_UNI", label: "Viviendas unifamiliares" },
            { fieldName: "AGRUPADA", label: "Agrupadas" },
            { fieldName: "SUM_VIV_AGRU", label: "Viviendas agrupadas" },
            { fieldName: "COLECTIVA", label: "Colectivas" },
            { fieldName: "SUM_VIV_COL", label: "Viviendas colectivas" }
          ]
        }
      ]
    }
  });

  const buildingsLayer = new SceneLayer({
    url: "https://basemaps3d.arcgis.com/arcgis/rest/services/Esri3D_Buildings_v1/SceneServer",
    title: "Edificios",
    popupEnabled: false,
    opacity: 0.22,
    renderer: {
      type: "simple",
      symbol: {
        type: "mesh-3d",
        symbolLayers: [
          {
            type: "fill",
            material: { color: [186, 196, 206], colorMixMode: "replace" },
            edges: {
              type: "solid",
              color: [42, 54, 68, 0.85],
              size: 1
            }
          }
        ]
      }
    }
  });

  const maskLayer = new GraphicsLayer({
    title: "Fuera del término",
    listMode: "hide",
    elevationInfo: { mode: "on-the-ground" }
  });

  const drawLayer = new GraphicsLayer({
    title: "Área",
    listMode: "hide",
    elevationInfo: { mode: "on-the-ground" }
  });

  const labelLayer = new GraphicsLayer({
    title: "Etiquetas",
    listMode: "hide",
    elevationInfo: { mode: "relative-to-scene", offset: 8, unit: "meters" }
  });

  const highlightGroundLayer = new GraphicsLayer({
    title: "Selección suelo",
    listMode: "hide",
    elevationInfo: { mode: "on-the-ground" }
  });

  const highlightLayer = new GraphicsLayer({
    title: "Selección",
    listMode: "hide",
    elevationInfo: { mode: "relative-to-scene", offset: 3, unit: "meters" }
  });

  function isMobileClient() {
    return window.matchMedia("(max-width: 768px)").matches
      || window.matchMedia("(max-width: 980px) and (pointer: coarse)").matches;
  }

  const preferFlatBoot = isMobileClient();
  document.body.classList.toggle("mobile-2d", preferFlatBoot);
  if (preferFlatBoot) {
    const loadingP = document.querySelector("#loading p");
    if (loadingP) loadingP.textContent = "Cargando mapa y datos del Portal…";
  }

  const map = new Map({
    basemap: basemaps[0],
    ground: preferFlatBoot ? null : "world-elevation",
    layers: preferFlatBoot
      ? [maskLayer, barriosLayer, parcelasLayer, drawLayer, labelLayer, highlightGroundLayer, highlightLayer]
      : [maskLayer, barriosLayer, parcelasLayer, buildingsLayer, drawLayer, labelLayer, highlightGroundLayer, highlightLayer]
  });

  const homeCamera = {
    position: { longitude: -3.526, latitude: 40.332, z: 2400 },
    heading: 18,
    tilt: 58
  };
  const homeCenter2d = { longitude: -3.526, latitude: 40.332 };
  const homeZoom2d = 13;
  const sharedPopupOpts = {
    autoOpenEnabled: false,
    autoCloseEnabled: false,
    dockEnabled: false,
    collapseEnabled: false
  };
  const sharedUiPad = { top: 76, right: 12, bottom: 12, left: 12 };

  function createSceneView(container) {
    return new SceneView({
      container: container || "viewDiv",
      map: map,
      viewingMode: "local",
      camera: homeCamera,
      qualityProfile: "medium",
      environment: {
        lighting: {
          directShadowsEnabled: false,
          ambientOcclusionEnabled: false
        }
      },
      popupEnabled: false,
      popup: Object.assign({}, sharedPopupOpts),
      ui: { padding: Object.assign({}, sharedUiPad) }
    });
  }

  function createMapView(container, center, zoom) {
    return new MapView({
      container: container || "viewDiv",
      map: map,
      center: center || homeCenter2d,
      zoom: zoom == null ? homeZoom2d : zoom,
      popupEnabled: false,
      popup: Object.assign({}, sharedPopupOpts),
      ui: { padding: Object.assign({}, sharedUiPad) }
    });
  }

  let view;
  if (preferFlatBoot) {
    mapView = createMapView("viewDiv");
    view = mapView;
    sceneView = null;
  } else {
    view = createSceneView("viewDiv");
    sceneView = view;
  }

  view.popup.autoCloseEnabled = false;
  // Debajo del punto: al ampliar crece hacia abajo y no tapa la barra de búsqueda.
  try { view.popup.alignment = "top-center"; } catch (err) { /* API antigua */ }

  function styleHighlights(targetView) {
    if (!targetView) return;
    if (targetView.highlights && typeof targetView.highlights.find === "function") {
      const current = targetView.highlights.find(function (item) {
        return item.name === "default";
      });
      if (current) {
        current.color = [245, 197, 24];
        current.haloColor = [255, 255, 255];
        current.haloOpacity = 1;
        current.fillOpacity = 0.45;
      }
    } else if (targetView.highlightOptions) {
      targetView.highlightOptions = {
        color: [245, 197, 24],
        haloColor: [255, 255, 255],
        haloOpacity: 0.95,
        fillOpacity: 0.4
      };
    }
  }

  styleHighlights(view);

  const homeWidget = new Home({ view: view });
  const basemapGallery = new BasemapGallery({
    view: view,
    source: basemaps
  });
  const basemapExpand = new Expand({
    view: view,
    content: basemapGallery,
    expandIcon: "basemap",
    expandTooltip: "Mapas base",
    collapseTooltip: "Cerrar mapas base",
    group: "top-right"
  });
  const areaPanel = document.getElementById("areaPanel");
  const areaHint = document.getElementById("areaHint");
  const btnArea = document.getElementById("btnArea");
  const btnStreet = document.getElementById("btnStreet");
  const btnView = document.getElementById("btnView");
  const btnHelp = document.getElementById("btnHelp");
  const btnBarrios = document.getElementById("btnBarrios");
  const btnChat = document.getElementById("btnChat");
  const chatPanel = document.getElementById("chatPanel");
  let streetMode = false;

  function detachChrome() {
    [homeWidget, btnView, basemapExpand, btnStreet, btnArea, btnChat, btnBarrios, btnHelp].forEach(function (item) {
      if (item) view.ui.remove(item);
    });
  }

  function mountChrome() {
    homeWidget.view = view;
    basemapGallery.view = view;
    basemapExpand.view = view;
    basemapExpand.expanded = false;
    const tools = [homeWidget];
    if (!isMobileClient() && btnView) tools.push(btnView);
    tools.push(basemapExpand, btnStreet, btnArea, btnChat, btnBarrios, btnHelp);
    view.ui.add(tools.filter(Boolean), "top-right");
  }

  function syncBarriosButton() {
    if (!btnBarrios) return;
    const on = !!(barriosLayer && barriosLayer.visible);
    btnBarrios.classList.toggle("is-active", on);
    btnBarrios.setAttribute("aria-pressed", on ? "true" : "false");
    btnBarrios.title = on ? "Ocultar barrios" : "Mostrar barrios";
    btnBarrios.setAttribute("aria-label", btnBarrios.title);
  }

  if (btnBarrios) {
    btnBarrios.addEventListener("click", function () {
      barriosLayer.visible = !barriosLayer.visible;
      syncBarriosButton();
    });
    syncBarriosButton();
  }

  function unbindView() {
    viewHandles.forEach(function (handle) { handle.remove(); });
    viewHandles = [];
  }

  function placeBuildings(show) {
    const present = map.layers.includes(buildingsLayer);
    if (show && !present) {
      const index = Math.max(0, map.layers.indexOf(parcelasLayer) + 1);
      map.add(buildingsLayer, index);
    } else if (!show && present) {
      map.remove(buildingsLayer);
    }
  }

  function applyViewStyle() {
    const flat = view.type === "2d";
    placeBuildings(!flat);
    parcelasLayer.visible = !flat;
    parcelasLayer.renderer = {
      type: "simple",
      symbol: {
        type: "simple-fill",
        color: [255, 255, 255, 0],
        outline: flat
          ? { color: [0, 0, 0, 0], width: 0 }
          : { color: [255, 255, 255, 0.28], width: 0.4 }
      }
    };
    if (unifamiliarLayer && uniRenderer2d && uniRenderer3d) {
      unifamiliarLayer.renderer = flat ? uniRenderer2d : uniRenderer3d;
    }
    if (plurifamiliarLayer && pluriRenderer2d && pluriRenderer3d) {
      plurifamiliarLayer.renderer = flat ? pluriRenderer2d : pluriRenderer3d;
    }
    if (incidenciaLayer && incRenderer2d && incRenderer3d) {
      incidenciaLayer.renderer = flat ? incRenderer2d : incRenderer3d;
    }
    if (selectedTarget) applyHighlight(selectedTarget);
    if (btnView) {
      btnView.textContent = flat ? "3D" : "2D";
      btnView.title = flat ? "Vista 3D" : "Vista 2D";
      btnView.setAttribute("aria-label", btnView.title);
      btnView.hidden = isMobileClient();
    }
  }

  function bindView() {
    unbindView();
    viewHandles.push(view.on("pointer-down", function (event) {
      if (event.button !== 0) return;
      press = { x: event.x, y: event.y };
    }));
    viewHandles.push(view.on("drag", function (event) {
      if (areaMode) event.stopPropagation();
    }));
    viewHandles.push(view.on("double-click", function (event) {
      if (!areaMode) return;
      event.stopPropagation();
      const armed = Date.now() - startClickAt < 500;
      if (areaVertices.length >= 3 && (armed || nearFirstVertex(event))) closeArea();
    }));
    viewHandles.push(view.on("pointer-up", function (event) {
      if (areaMode || streetMode) return;
      if (!press) return;
      const dx = event.x - press.x;
      const dy = event.y - press.y;
      press = null;
      if (dx * dx + dy * dy > clickSlop * clickSlop) return;
      const target = event.native && event.native.target;
      if (target && target.tagName !== "CANVAS") return;
      identifyFromPointer(event);
    }));
    viewHandles.push(view.on("immediate-click", function (event) {
      if (event.button != null && event.button !== 0) return;
      if (areaMode) {
        event.stopPropagation();
        addAreaVertex(event);
        return;
      }
      if (streetMode) {
        event.stopPropagation();
        openStreetViewAt(event);
        return;
      }
      identifyFromPointer(event);
    }));
    viewHandles.push(view.watch("stationary", function (stationary) {
      if (stationary) refreshLabels();
    }));
  }

  function setMode(nextMode) {
    const goingFlat = nextMode === "2d";
    if (switching) return;
    if (!goingFlat && isMobileClient()) return;
    if (goingFlat && view.type === "2d") return;
    if (!goingFlat && view.type === "3d") return;
    switching = true;
    if (areaMode) {
      drawLayer.removeAll();
      areaVertices = [];
      stopAreaDraw();
      areaPanel.hidden = true;
    }
    const keepStreet = streetMode;
    if (streetMode) stopStreetMode();
    view.closePopup();
    basemapExpand.expanded = false;
    const center = view.center ? view.center.clone() : null;
    const zoom = view.zoom;
    const viewpoint = view.viewpoint ? view.viewpoint.clone() : null;
    if (view.type === "3d" && view.camera) savedCamera = view.camera.clone();
    unbindView();
    detachChrome();
    const leaving = view;
    leaving.container = null;

    if (goingFlat) {
      if (!mapView) {
        mapView = createMapView("viewDiv", center, zoom);
      } else {
        mapView.map = map;
        mapView.container = "viewDiv";
        if (viewpoint) mapView.viewpoint = viewpoint;
      }
      view = mapView;
    } else {
      if (!sceneView) {
        sceneView = createSceneView("viewDiv");
        if (map.ground == null) map.ground = "world-elevation";
      } else {
        sceneView.map = map;
        sceneView.container = "viewDiv";
      }
      view = sceneView;
    }

    view.popup.autoCloseEnabled = false;
    try { view.popup.alignment = "top-center"; } catch (err) { /* API antigua */ }
    styleHighlights(view);
    mountChrome();
    bindView();
    watchPopup();
    applyViewStyle();
    view.when(function () {
      if (view.type === "3d" && clipExtent) view.clippingArea = clipExtent.clone();
      if (view.type === "3d" && savedCamera) return view.goTo(savedCamera, { animate: false });
      if (view.type === "2d" && viewpoint) return view.goTo(viewpoint, { animate: false });
    }).then(function () {
      if (view.type === "3d" && homeViewpoint3d) homeWidget.viewpoint = homeViewpoint3d.clone();
      else if (homeExtent) homeWidget.viewpoint = new Viewpoint({ targetGeometry: homeExtent.clone() });
      filterParcelas();
      refreshLabels();
      syncLayout();
      setPopupOpen(view.popup && view.popup.visible);
      if (keepStreet) startStreetMode();
      switching = false;
    }).catch(function (err) {
      switching = false;
      console.error(err);
    });
  }

  mountChrome();
  bindView();
  watchPopup();
  applyViewStyle();
  if (btnView) {
    btnView.addEventListener("click", function () {
      if (isMobileClient()) return;
      setMode(view.type === "3d" ? "2d" : "3d");
    });
  }

  let lastMobile = preferFlatBoot;
  function applyMobilePolicy() {
    const mobile = isMobileClient();
    document.body.classList.toggle("mobile-2d", mobile);
    if (btnView) btnView.hidden = mobile;
    if (mobile && view && view.type === "3d") {
      setMode("2d");
    }
    if (mobile !== lastMobile && view && view.ui) {
      lastMobile = mobile;
      detachChrome();
      mountChrome();
    } else {
      lastMobile = mobile;
    }
  }
  let areaMode = false;
  let areaVertices = [];
  let ignoreIdentifyUntil = 0;
  let startClickAt = 0;
  const areaOrange = [255, 106, 0, 1];

  const areaFill = {
    type: "simple-fill",
    color: [255, 145, 0, 0.38],
    outline: { color: areaOrange, width: 3 }
  };
  const areaVertexSymbol = {
    type: "point-3d",
    symbolLayers: [{
      type: "icon",
      size: 14,
      resource: { primitive: "circle" },
      material: { color: [255, 255, 255, 1] },
      outline: { color: areaOrange, size: 2 }
    }]
  };
  const areaStartSymbol = {
    type: "point-3d",
    symbolLayers: [{
      type: "icon",
      size: 22,
      resource: { primitive: "square" },
      material: { color: areaOrange },
      outline: { color: [255, 255, 255, 1], size: 2 }
    }]
  };

  function setAreaFigures(residentes, uni, pluri) {
    const fmt = function (value) { return value.toLocaleString("es-ES"); };
    document.getElementById("areaResidentes").textContent = fmt(residentes);
    document.getElementById("areaUni").textContent = fmt(uni);
    document.getElementById("areaPluri").textContent = fmt(pluri);
  }

  function clearAreaFigures() {
    document.getElementById("areaResidentes").textContent = "—";
    document.getElementById("areaUni").textContent = "—";
    document.getElementById("areaPluri").textContent = "—";
  }

  function polygonRingsLonLat(geometry) {
    if (!geometry || !geometry.rings) return [];
    const sr = geometry.spatialReference;
    if (!sr || sr.isWGS84 || sr.wkid === 4326) return geometry.rings;
    if (sr.isWebMercator) return webMercatorUtils.webMercatorToGeographic(geometry).rings || [];
    return [];
  }

  function pointInPolygon(lon, lat, rings) {
    let inside = false;
    for (let r = 0; r < rings.length; r++) {
      if (pointInRing(lon, lat, rings[r])) inside = !inside;
    }
    return inside;
  }

  function summarizeArea(geometry) {
    const rings = polygonRingsLonLat(geometry);
    if (!rings.length || rings[0].length < 3) {
      setAreaFigures(0, 0, 0);
      return;
    }
    let minLon = Infinity;
      let maxLon = -Infinity;
      let minLat = Infinity;
      let maxLat = -Infinity;
      rings[0].forEach(function (coord) {
        if (coord[0] < minLon) minLon = coord[0];
        if (coord[0] > maxLon) maxLon = coord[0];
        if (coord[1] < minLat) minLat = coord[1];
        if (coord[1] > maxLat) maxLat = coord[1];
      });
      let residentes = 0;
      let uni = 0;
      let pluri = 0;
      censusPoints.forEach(function (point) {
        if (point.lon < minLon || point.lon > maxLon || point.lat < minLat || point.lat > maxLat) return;
        if (!pointInPolygon(point.lon, point.lat, rings)) return;
        residentes += point.residentes;
        if (point.tipo === "plurifamiliar") pluri += 1;
        else uni += 1;
      });
    setAreaFigures(residentes, uni, pluri);
    areaHint.textContent = "Cada vivienda cuenta si su portal cae dentro del polígono.";
  }

  function areaRing() {
    const ring = areaVertices.map(function (vertex) { return [vertex.lon, vertex.lat]; });
    ring.push(ring[0]);
    return ring;
  }

  function areaPointSymbol(start) {
    if (view.type === "2d") {
      return start
        ? {
          type: "simple-marker",
          style: "square",
          size: 14,
          color: areaOrange,
          outline: { color: [255, 255, 255, 1], width: 2 }
        }
        : {
          type: "simple-marker",
          style: "circle",
          size: 9,
          color: [255, 255, 255, 1],
          outline: { color: areaOrange, width: 2 }
        };
    }
    return start ? areaStartSymbol : areaVertexSymbol;
  }

  function paintArea() {
    drawLayer.removeAll();
    if (areaVertices.length >= 3) {
      drawLayer.add(new Graphic({
        geometry: new Polygon({
          rings: [areaRing()],
          spatialReference: { wkid: 4326 }
        }),
        symbol: areaFill
      }));
    } else if (areaVertices.length >= 2) {
      drawLayer.add(new Graphic({
        geometry: {
          type: "polyline",
          paths: [areaVertices.map(function (vertex) { return [vertex.lon, vertex.lat]; })],
          spatialReference: { wkid: 4326 }
        },
        symbol: { type: "simple-line", color: areaOrange, width: 3 }
      }));
    }
    areaVertices.forEach(function (vertex, index) {
      drawLayer.add(new Graphic({
        geometry: new Point({ longitude: vertex.lon, latitude: vertex.lat }),
        symbol: areaPointSymbol(index === 0)
      }));
    });
  }

  function nearFirstVertex(event) {
    if (areaVertices.length < 3) return false;
    const mapPoint = event.mapPoint || (event.x != null && event.y != null
      ? view.toMap({ x: event.x, y: event.y })
      : null);
    const ll = lonLatOf(mapPoint);
    const first = areaVertices[0];
    if (ll) {
      const cos = Math.cos(((first.lat + ll.lat) * 0.5) * Math.PI / 180) || 1;
      const dxm = (ll.lon - first.lon) * 111320 * cos;
      const dym = (ll.lat - first.lat) * 110540;
      const resolution = view.resolution > 0 ? view.resolution : (view.scale || 2000) * 0.00028;
      const meters = resolution * 32;
      if (dxm * dxm + dym * dym <= meters * meters) return true;
    }
    if (event.x == null || event.y == null || !mapPoint) return false;
    const screen = view.toScreen(new Point({
      longitude: first.lon,
      latitude: first.lat,
      z: mapPoint.z
    }));
    if (!screen) return false;
    const dx = event.x - screen.x;
    const dy = event.y - screen.y;
    return dx * dx + dy * dy <= 32 * 32;
  }

  function onStartVertexClick() {
    const now = Date.now();
    if (now - startClickAt < 500) {
      startClickAt = 0;
      closeArea();
      return;
    }
    startClickAt = now;
  }

  function drawSurface() {
    return view.container && view.container.querySelector(".esri-view-surface");
  }

  function stopAreaDraw() {
    areaMode = false;
    areaVertices = [];
    startClickAt = 0;
    btnArea.classList.remove("is-active");
    btnArea.title = "Dibujar área";
    btnArea.setAttribute("aria-label", "Dibujar área");
    const surface = drawSurface();
    if (surface) surface.style.cursor = "";
  }

  function stopStreetMode() {
    streetMode = false;
    btnStreet.classList.remove("is-active");
    btnStreet.title = "Street View";
    btnStreet.setAttribute("aria-label", "Street View");
    document.body.classList.remove("street-mode");
    const surface = drawSurface();
    if (surface && !areaMode) surface.style.cursor = "";
  }

  function startStreetMode() {
    if (areaMode) {
      drawLayer.removeAll();
      stopAreaDraw();
      areaPanel.hidden = true;
    }
    view.closePopup();
    basemapExpand.expanded = false;
    streetMode = true;
    btnStreet.classList.add("is-active");
    btnStreet.title = "Salir de Street View";
    btnStreet.setAttribute("aria-label", "Salir de Street View");
    document.body.classList.add("street-mode");
    const surface = drawSurface();
    if (surface) surface.style.cursor = "crosshair";
  }

  function streetViewUrl(lon, lat) {
    let url = "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=" +
      encodeURIComponent(lat + "," + lon);
    if (view.type === "3d" && view.camera && typeof view.camera.heading === "number") {
      url += "&heading=" + encodeURIComponent(String(Math.round(view.camera.heading)));
    }
    return url;
  }

  function openStreetViewAt(event) {
    const mapPoint = event.mapPoint || view.toMap({ x: event.x, y: event.y });
    const ll = lonLatOf(mapPoint);
    if (!ll) return;
    ignoreIdentifyUntil = Date.now() + 700;
    stopStreetMode();
    window.open(streetViewUrl(ll.lon, ll.lat), "_blank", "noopener,noreferrer");
  }

  function startAreaDraw() {
    if (streetMode) stopStreetMode();
    view.closePopup();
    basemapExpand.expanded = false;
    drawLayer.removeAll();
    areaVertices = [];
    startClickAt = 0;
    clearAreaFigures();
    if (typeof setChatOpen === "function") setChatOpen(false);
    areaPanel.hidden = false;
    areaHint.textContent = "Clic en el mapa para los vértices. Doble clic en el primero para cerrar.";
    areaMode = true;
    btnArea.classList.add("is-active");
    btnArea.title = "Cancelar dibujo";
    btnArea.setAttribute("aria-label", "Cancelar dibujo");
    const surface = drawSurface();
    if (surface) surface.style.cursor = "crosshair";
  }

  function addAreaVertex(event) {
    const mapPoint = event.mapPoint || view.toMap({ x: event.x, y: event.y });
    const ll = lonLatOf(mapPoint);
    if (!ll) {
      areaHint.textContent = "Ese clic no cae sobre el terreno. Prueba otra vez dentro del municipio.";
      return;
    }
    if (nearFirstVertex(event)) {
      onStartVertexClick();
      return;
    }
    startClickAt = 0;
    const previous = areaVertices[areaVertices.length - 1];
    if (previous) {
      const dx = ll.lon - previous.lon;
      const dy = ll.lat - previous.lat;
      if (dx * dx + dy * dy < 1e-10) return;
    }
    areaVertices.push(ll);
    paintArea();
    areaHint.textContent = areaVertices.length < 3
      ? "Clic para añadir vértices. Hacen falta al menos tres."
      : "Doble clic en el primer punto, el cuadrado, para cerrar.";
  }

  function closeArea() {
    if (areaVertices.length < 3) return;
    const ring = areaRing();
    drawLayer.removeAll();
    drawLayer.add(new Graphic({
      geometry: new Polygon({ rings: [ring], spatialReference: { wkid: 4326 } }),
      symbol: areaFill
    }));
    ignoreIdentifyUntil = Date.now() + 700;
    stopAreaDraw();
    areaPanel.hidden = false;
    summarizeArea(drawLayer.graphics.getItemAt(0).geometry);
  }

  btnArea.addEventListener("click", function () {
    if (areaMode) {
      drawLayer.removeAll();
      stopAreaDraw();
      areaPanel.hidden = true;
      return;
    }
    startAreaDraw();
  });

  btnStreet.addEventListener("click", function () {
    if (streetMode) {
      stopStreetMode();
      return;
    }
    startStreetMode();
  });

  document.getElementById("btnClearArea").addEventListener("click", function () {
    drawLayer.removeAll();
    stopAreaDraw();
    areaPanel.hidden = true;
  });

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function residentesTxt(count) {
    const n = Number(count);
    return n === 1 ? "1 residente" : n + " residentes";
  }

  function catastroUrl(rc) {
    const ref = String(rc || "").replace(/\s/g, "").toUpperCase();
    if (ref.length < 14) return "";
    return "https://www1.sedecatastro.gob.es/Cartografia/mapa.aspx?refcat=" + encodeURIComponent(ref);
  }

  function catastroAnchor(rc, size) {
    const url = catastroUrl(rc);
    if (!url) return "";
    const sm = size === "sm";
    return (
      "<a class='btn-catastro" + (sm ? " btn-catastro-sm" : "") + "' href=\"" + esc(url) +
      "\" target=\"_blank\" rel=\"noopener noreferrer\">" +
      (sm ? "Catastro" : "Ver en Catastro") + "</a>"
    );
  }

  function catastroLink(rc) {
    return catastroAnchor(rc);
  }

  function refCatastralTxt(ref, rc, incidencia) {
    const value = String(ref || rc || "").trim();
    if (value) return value;
    if (incidencia) return "Sin ref. catastral";
    return "—";
  }

  function sexoChips(hombres, mujeres) {
    return popupChips(hombres, mujeres, null);
  }

  function normalizeVids(vids) {
    if (Array.isArray(vids)) {
      return vids.map(function (v) { return String(v || "").trim(); }).filter(Boolean);
    }
    return String(vids || "").split(",").map(function (v) { return v.trim(); }).filter(Boolean);
  }

  const padronRegistry = {};
  let padronRegSeq = 0;

  function registerPadronAction(vids, meta) {
    const id = "p" + (++padronRegSeq);
    padronRegistry[id] = {
      vids: normalizeVids(vids),
      meta: typeof meta === "string" ? { direccion: meta } : (meta || {})
    };
    return id;
  }

  function resolvePadronAction(raw) {
    if (!raw) return null;
    if (padronRegistry[raw]) return padronRegistry[raw];
    // Compatibilidad: JSON o lista de vids en el hash
    try {
      const data = JSON.parse(decodeURIComponent(raw));
      if (data && typeof data === "object" && data.v != null) {
        return {
          vids: normalizeVids(data.v),
          meta: {
            direccion: data.d || "",
            portal: data.portal || "",
            portalKind: data.portalKind || "Portal",
            planta: data.planta || "",
            letra: data.letra || "",
            ref: data.ref || ""
          }
        };
      }
    } catch (err) { /* ignore */ }
    return { vids: normalizeVids(raw), meta: {} };
  }

  function padronButton(vids, metaOrTitle, size) {
    // ArcGIS sanitiza el HTML del popup: elimina <button> y data-*.
    // Registramos la acción y usamos un hash corto que sí se conserva.
    const list = normalizeVids(vids);
    const sm = size === "sm";
    if (!list.length) {
      return sm
        ? ""
        : "<span class='btn-padron is-disabled'>Padrón no disponible</span>";
    }
    const meta = typeof metaOrTitle === "string"
      ? { direccion: metaOrTitle }
      : (metaOrTitle || {});
    const id = registerPadronAction(list, meta);
    const label = String(meta.direccion || "").replace(/[<>"']/g, "");
    const text = sm ? "Padrón" : "Ver padrón de residentes";
    return (
      "<a href='#padron:" + id +
      "' class='btn-padron" + (sm ? " btn-padron-sm" : "") +
      "' title=\"" + esc(label) + "\">" + text + "</a>"
    );
  }

  /** Iconos SVG compactos (viewBox con margen para que no se recorten). */
  function popupIcon(kind) {
    const common =
      " class='popup-ico' viewBox='0 0 24 24' width='16' height='16'" +
      " aria-hidden='true' focusable='false' preserveAspectRatio='xMidYMid meet'";
    if (kind === "people") {
      return "<svg" + common + "><path fill='currentColor' d='M8.5 8.5a2.75 2.75 0 1 1 5.5 0 2.75 2.75 0 0 1-5.5 0zm7.75 0a2.25 2.25 0 1 1 4.5 0 2.25 2.25 0 0 1-4.5 0zM4.5 16.75c0-1.93 2.69-3.25 5.75-3.25s5.75 1.32 5.75 3.25V19h-11.5v-2.25zm10.7-.35c.55-.25 1.2-.4 1.9-.4 2.45 0 4.4 1.05 4.4 2.35V19h-4.55v-2.25c0-.55-.07-1.05-.2-1.5-.3-.05-.62-.1-.95-.1-.55 0-1.07.08-1.55.2.1-.4.15-.82.15-1.25v-.1z'/></svg>";
    }
    if (kind === "male") {
      return "<svg" + common + "><path fill='currentColor' d='M14.2 4.5h5.3v5.3h-1.7V7.4l-3.55 3.55a4.25 4.25 0 1 1-1.2-1.2L16.6 6.2h-2.4V4.5zM9.75 19a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5z'/></svg>";
    }
    if (kind === "female") {
      return "<svg" + common + "><path fill='currentColor' d='M12 4.5a3.75 3.75 0 0 1 1.55 7.16L12.7 14.5h2.3v1.6h-2.3l-.35 1.4h-1.7l-.35-1.4H8v-1.6h2.3l-.85-2.84A3.75 3.75 0 0 1 12 4.5zm0 1.6a2.15 2.15 0 1 0 0 4.3 2.15 2.15 0 0 0 0-4.3z'/></svg>";
    }
    if (kind === "age") {
      return "<svg" + common + "><path fill='currentColor' d='M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zm0 1.6a6.9 6.9 0 1 0 0 13.8 6.9 6.9 0 0 0 0-13.8zm-.7 2.4h1.5v4.3l3.2 1.9-.75 1.25-3.95-2.35V7.5z'/></svg>";
    }
    if (kind === "house") {
      return "<svg" + common + "><path fill='currentColor' d='M12 4.2 4.5 10v9.3h5.2v-5.2h4.6v5.2h5.2V10L12 4.2zm0 2.1 5.5 4.2v7.3h-2.2v-5.2H8.7v5.2H6.5v-7.3L12 6.3z'/></svg>";
    }
    if (kind === "building") {
      return "<svg" + common + "><path fill='currentColor' d='M5 4.5h7.2V19.5H5V4.5zm8.3 3.2H19V19.5h-5.7V7.7zM6.7 7h2v1.8h-2V7zm0 3.1h2v1.8h-2v-1.8zm0 3.1h2v1.8h-2v-1.8zm8.8-3.1h2v1.8h-2v-1.8zm0 3.1h2v1.8h-2v-1.8z'/></svg>";
    }
    return "";
  }

  function edadChip(edadMedia) {
    if (edadMedia == null || edadMedia === "") return "";
    return (
      "<span class='chip chip-age'>" + popupIcon("age") +
      "<span>Edad media " + esc(String(edadMedia).replace(".", ",")) + " años</span></span>"
    );
  }

  function chipSpans(hombres, mujeres, edadMedia) {
    const h = Number(hombres) || 0;
    const m = Number(mujeres) || 0;
    const age = edadChip(edadMedia);
    if (!h && !m && !age) return "";
    return (
      (h ? "<span class='chip chip-h'>" + popupIcon("male") + "<span>" + h + " hombre" + (h === 1 ? "" : "s") + "</span></span>" : "") +
      (m ? "<span class='chip chip-m'>" + popupIcon("female") + "<span>" + m + " mujer" + (m === 1 ? "" : "es") + "</span></span>" : "") +
      (age || "")
    );
  }

  function popupChips(hombres, mujeres, edadMedia) {
    const inner = chipSpans(hombres, mujeres, edadMedia);
    return inner ? "<div class='popup-chips'>" + inner + "</div>" : "";
  }

  function tipoBadge(tipo, label) {
    const kind = tipo === "plurifamiliar" || tipo === "bloque" ? "building" : "house";
    const cls = kind === "building" ? "chip chip-tipo chip-tipo-pluri" : "chip chip-tipo chip-tipo-uni";
    const text = label || (kind === "building" ? "Plurifamiliar" : "Unifamiliar");
    return "<span class='" + cls + "'>" + popupIcon(kind) + "<span>" + esc(text) + "</span></span>";
  }

  function popupShell(opts) {
    const residentes = Number(opts.residentes) || 0;
    const chips = popupChips(opts.hombres, opts.mujeres, opts.edad_media);
    const padronMeta = opts.padronMeta || { direccion: opts.title || "" };
    const padron = opts.showPadron === false ? "" : padronButton(opts.vids, padronMeta);
    const hasBody = !!(opts.extraHtml && String(opts.extraHtml).trim());
    const sticky =
      (opts.incidencia ? "<p class='popup-note incidencia'>" + esc(opts.incidencia) + "</p>" : "") +
      "<div class='popup-hero'>" +
      "<div class='popup-stat'>" +
      "<span class='popup-stat-ico'>" + popupIcon("people") + "</span>" +
      "<div class='popup-stat-label'>" + (residentes === 1 ? "Residente empadronado" : "Residentes empadronados") + "</div>" +
      "<div class='popup-stat-count'>" + esc(String(residentes)) + "</div>" +
      "</div></div>" +
      chips +
      "<dl class='popup-meta'>" + (opts.metaHtml || "") + "</dl>" +
      "<div class='popup-actions'>" +
      padron +
      (opts.catastroHtml || "") +
      "</div>";
    return (
      "<div class='popup-card popup-card--sticky'>" +
      "<div class='popup-sticky'>" + sticky + "</div>" +
      (hasBody ? "<div class='popup-scroll'>" + opts.extraHtml + "</div>" : "") +
      "</div>"
    );
  }

  function metaItem(label, value) {
    if (value == null || value === "" || value === "—") return "";
    return "<div><dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd></div>";
  }

  function metaTipo(tipo, label) {
    const pluri = tipo === "plurifamiliar";
    const text = label || (pluri ? "Plurifamiliar" : "Unifamiliar");
    return (
      "<div class='meta-tipo'><dt>Tipo</dt><dd>" +
      tipoBadge(pluri ? "plurifamiliar" : "unifamiliar", text) +
      "</dd></div>"
    );
  }

  function dwellingHtml(attrs) {
    const refTxt = refCatastralTxt(attrs.ref, attrs.rc, attrs.incidencia);
    const vids = attrs.vid || attrs.id || "";
    const planta = attrs.planta === "Unifamiliar" ? "" : (attrs.planta || "");
    const meta = {
      direccion: attrs.direccion || "",
      portal: attrs.portal || "",
      portalKind: attrs.portalKind || "Portal",
      planta: planta,
      letra: attrs.letra || attrs.puerta || "",
      ref: String(attrs.ref || attrs.rc || "").trim()
    };
    const tipo = attrs.tipo === "plurifamiliar" ? "plurifamiliar" : "unifamiliar";
    return popupShell({
      residentes: attrs.residentes,
      hombres: attrs.hombres,
      mujeres: attrs.mujeres,
      edad_media: attrs.edad_media,
      incidencia: attrs.incidencia,
      title: attrs.direccion,
      vids: vids,
      metaHtml:
        metaItem("Portal", meta.portal ? ((meta.portalKind || "Portal") + " " + meta.portal) : "") +
        metaItem("Planta", planta) +
        metaItem("Puerta / letra", meta.letra) +
        metaItem("Ref. catastral", refTxt) +
        metaTipo(tipo),
      showPadron: true,
      padronMeta: meta,
      catastroHtml: catastroLink(attrs.ref || attrs.rc)
    });
  }

  function plantaLabel(planta) {
    const text = planta || "Sin planta";
    if (text === "Baja" || text === "Sótano" || text === "Sin planta" || text === "Unifamiliar" || text.indexOf("Sótano") === 0) {
      return text;
    }
    return "Planta " + text;
  }

  function floorsHtml(list) {
    const addresses = {};
    const portals = {};
    list.forEach(function (unidad) {
      addresses[unidad.direccion || ""] = true;
      if (unidad.portal) portals[unidad.portal] = true;
    });
    const showAddress = Object.keys(addresses).length > 1;
    const showPortal = Object.keys(portals).length > 1;
    const groups = [];
    const index = {};
    list.forEach(function (unidad) {
      const planta = unidad.planta || "Sin planta";
      const direccion = unidad.direccion || "";
      const key = (showAddress ? direccion : "") + "\n" + planta;
      if (index[key] == null) {
        index[key] = groups.length;
        groups.push({ planta: planta, direccion: direccion, unidades: [] });
      }
      groups[index[key]].unidades.push(unidad);
    });
    groups.sort(function (a, b) {
      const byFloor = plantaOrder(a.planta) - plantaOrder(b.planta);
      if (byFloor) return byFloor;
      return (a.direccion || "").localeCompare(b.direccion || "", "es");
    });
    return (
      "<div class='floors'>" +
      groups.map(function (group) {
        const title = (showAddress && group.direccion ? group.direccion + " · " : "") + plantaLabel(group.planta);
        const residentes = group.unidades.reduce(function (sum, unidad) {
          return sum + (Number(unidad.residentes) || 0);
        }, 0);
        const viviendas = group.unidades.length === 1 ? "1 vivienda" : group.unidades.length + " viviendas";
        const rows = group.unidades.slice().sort(compareUnidad).map(function (unidad) {
          const ref = String(unidad.ref || "").trim();
          const label = unidadLabel(unidad, showPortal);
          const meta = padronMetaFromUnidad(unidad, unidad.direccion || group.direccion);
          const unitChips = chipSpans(unidad.hombres, unidad.mujeres, unidad.edad_media);
          return (
            "<li>" +
            "<div class='floor-main'><span class='floor-ref'>" + label + "</span>" +
            "<b class='floor-res'>" + esc(residentesTxt(unidad.residentes)) + "</b></div>" +
            (unitChips ? "<div class='floor-chips'>" + unitChips + "</div>" : "") +
            "<div class='floor-actions'>" +
            padronButton(unidad.vid, meta, "sm") +
            catastroAnchor(ref, "sm") +
            "</div></li>"
          );
        }).join("");
        return (
          "<details class='floor-group'><summary><span class='floor-label'>" + esc(title) + "</span>" +
          "<span class='floor-meta'><b>" + esc(residentesTxt(residentes)) + "</b> · " + esc(viviendas) + "</span></summary>" +
          "<ul class='floor-dwellings'>" + rows + "</ul></details>"
        );
      }).join("") +
      "</div>"
    );
  }

  function mediaTxt(residentes, viviendas) {
    const value = viviendas ? Number(residentes) / Number(viviendas) : 0;
    const digits = Math.abs(value - Math.round(value)) < 0.05 ? 0 : 1;
    return value.toLocaleString("es-ES", {
      minimumFractionDigits: digits,
      maximumFractionDigits: 1
    }) + " por vivienda";
  }

  function buildingHtml(building) {
    if (building.tipo === "casas") {
      const casas = building.casas || [];
      const viviendas = casas.length;
      return popupShell({
        residentes: building.residentes,
        hombres: building.hombres,
        mujeres: building.mujeres,
        edad_media: building.edad_media,
        title: building.direccion,
        showPadron: false,
        metaHtml:
          metaItem("Viviendas", String(viviendas)) +
          metaItem("Parcela", building.rc || "") +
          metaTipo("unifamiliar", "Varias unifamiliares"),
        extraHtml: "<ul class='breakdown'>" + casas.map(function (casa) {
          const casaChips = chipSpans(casa.hombres, casa.mujeres, casa.edad_media);
          return (
            "<li>" +
            "<div class='floor-main'><span>" + esc(casa.direccion) + "</span>" +
            "<b>" + esc(residentesTxt(casa.residentes)) + "</b></div>" +
            (casaChips ? "<div class='floor-chips'>" + casaChips + "</div>" : "") +
            "<div class='floor-actions'>" +
            padronButton(casa.vid, { direccion: casa.direccion, ref: casa.ref || "" }, "sm") +
            "</div></li>"
          );
        }).join("") + "</ul>",
        catastroHtml: catastroLink(building.rc)
      });
    }
    if (building.tipo === "unifamiliar" || building.viviendas === 1) {
      return dwellingHtml({
        direccion: building.direccion,
        planta: building.planta,
        letra: building.letra,
        residentes: building.residentes,
        hombres: building.hombres,
        mujeres: building.mujeres,
        edad_media: building.edad_media,
        ref: building.ref,
        rc: building.rc,
        incidencia: building.incidencia,
        tipo: "unifamiliar",
        vid: (building.vids && building.vids[0]) || building.vid || ""
      });
    }
    const viviendas = Number(building.viviendas);
    const list = building.unidades || [];
    return popupShell({
      residentes: building.residentes,
      hombres: building.hombres,
      mujeres: building.mujeres,
      edad_media: building.edad_media,
      title: building.direccion,
      showPadron: false,
      metaHtml:
        metaItem("Viviendas", viviendas === 1 ? "1 vivienda" : viviendas + " viviendas") +
        metaItem("Media", mediaTxt(building.residentes, viviendas)) +
        metaItem("Parcela", building.rc || "") +
        metaTipo("plurifamiliar"),
      extraHtml: floorsHtml(list),
      catastroHtml: catastroLink(building.rc)
    });
  }

  function setPopupOpen(open) {
    document.body.classList.toggle("popup-open", !!open);
  }

  function popupMainEl() {
    return document.querySelector(".esri-view .esri-popup__main-container");
  }

  function resetPopupSize() {
    const main = popupMainEl();
    if (!main) return;
    main.style.height = "";
    main.style.maxHeight = "";
    main.style.width = "";
    main.style.transform = "";
    main.style.removeProperty("--popup-nudge");
    main.style.removeProperty("--floors-max");
    const content = main.querySelector(".esri-popup__content");
    if (content) content.style.maxHeight = "";
  }

  function syncPopupScrollAreas(main, heightPx) {
    if (!main) return;
    const h = Number(heightPx) || main.getBoundingClientRect().height;
    const sticky = main.querySelector(".popup-sticky");
    const stickyH = sticky ? sticky.getBoundingClientRect().height : 160;
    // Zona scroll bajo la cabecera fija.
    const scrollMax = Math.max(120, Math.round(h - stickyH - 48));
    main.style.setProperty("--floors-max", scrollMax + "px");
    // Al abrir una planta, la lista de viviendas tiene scroll propio.
    main.style.setProperty("--floor-open-max", Math.max(100, Math.round(scrollMax * 0.72)) + "px");
    const content = main.querySelector(".esri-popup__content");
    if (content) {
      content.style.maxHeight = Math.max(140, Math.round(h - 56)) + "px";
      content.style.overflowY = "hidden";
    }
    const scroll = main.querySelector(".popup-scroll");
    if (scroll) {
      scroll.style.maxHeight = scrollMax + "px";
    }
  }

  function ensurePopupResize() {
    const main = popupMainEl();
    if (!main) return;
    try { view.popup.alignment = "top-center"; } catch (err) { /* ignore */ }
    syncPopupScrollAreas(main);
    if (main.querySelector(".popup-resize-handle")) return;
    const handle = document.createElement("div");
    handle.className = "popup-resize-handle";
    handle.title = "Arrastra hacia abajo para ampliar; dentro de la lista, desplázate con el scroll";
    handle.addEventListener("pointerdown", onPopupResizePointerDown);
    main.appendChild(handle);
  }

  /** Sube el mapa para dejar hueco al emergente bajo la barra de búsqueda. */
  function liftMapForPopup(mapPoint) {
    if (!view || !mapPoint) return;
    const h = (view.height || 600);
    const topPad = Math.max(120, Math.round(h * 0.38));
    const bottomPad = Math.max(40, Math.round(h * 0.12));
    const go = {
      target: mapPoint,
      padding: {
        top: topPad,
        bottom: bottomPad,
        left: 40,
        right: 40
      }
    };
    view.goTo(go, { animate: true, duration: 280 }).catch(function () { /* ignore */ });
  }

  function onPopupResizePointerDown(ev) {
    const handle = ev.currentTarget;
    const main = handle.closest(".esri-popup__main-container");
    if (!main) return;
    ev.preventDefault();
    ev.stopPropagation();
    try { view.popup.alignment = "top-center"; } catch (err) { /* ignore */ }

    const startY = ev.clientY;
    const startRect = main.getBoundingClientRect();
    const startH = startRect.height;
    const startTop = startRect.top;
    const minH = 200;
    const maxH = Math.max(minH, window.innerHeight - startTop - 12);

    handle.setPointerCapture(ev.pointerId);

    function onMove(e) {
      // Arrastrar hacia abajo → más alto; el borde superior se mantiene.
      const dy = e.clientY - startY;
      const newH = Math.max(minH, Math.min(maxH, startH + dy));
      main.style.height = newH + "px";
      main.style.maxHeight = newH + "px";
      syncPopupScrollAreas(main, newH);
      // Si ArcGIS reancla el popup hacia arriba, compensar.
      const nowTop = main.getBoundingClientRect().top;
      const drift = nowTop - startTop;
      if (Math.abs(drift) > 0.5) {
        const prev = parseFloat(main.style.getPropertyValue("--popup-nudge") || "0") || 0;
        const nudge = prev - drift;
        main.style.setProperty("--popup-nudge", String(nudge) + "px");
        main.style.transform = "translateY(" + nudge + "px)";
      }
    }

    function onUp(e) {
      try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    }

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  function openPopup(mapPoint, title, html) {
    try { view.popup.alignment = "top-center"; } catch (err) { /* ignore */ }
    resetPopupSize();
    liftMapForPopup(mapPoint);
    view.openPopup({
      location: mapPoint,
      title: title,
      content: html
    });
    setPopupOpen(true);
    setTimeout(ensurePopupResize, 0);
    setTimeout(ensurePopupResize, 80);
  }

  function watchPopup() {
    if (popupVisibleHandle) {
      popupVisibleHandle.remove();
      popupVisibleHandle = null;
    }
    if (!view || !view.popup || typeof view.popup.watch !== "function") return;
    try {
      popupVisibleHandle = view.popup.watch("visible", function (visible) {
        setPopupOpen(!!visible);
        if (visible) {
          setTimeout(ensurePopupResize, 0);
          setTimeout(ensurePopupResize, 80);
        } else {
          resetPopupSize();
          if (!switching) {
            selectedTarget = null;
            clearHighlight();
          }
        }
      });
      setPopupOpen(!!view.popup.visible);
      if (view.popup.visible) ensurePopupResize();
    } catch (err) {
      console.error(err);
    }
  }

  function pointLayers() {
    return [unifamiliarLayer, plurifamiliarLayer, incidenciaLayer].filter(Boolean);
  }

  function pointInRing(x, y, ring) {
    let inside = false;
    let j = ring.length - 1;
    for (let i = 0; i < ring.length; i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-15) + xi) {
        inside = !inside;
      }
      j = i;
    }
    return inside;
  }

  function insideLimite(lon, lat) {
    return !limiteRing || pointInRing(lon, lat, limiteRing);
  }

  function lonLatOf(mapPoint) {
    if (!mapPoint) return null;
    const sr = mapPoint.spatialReference;
    if (sr && sr.isWebMercator) {
      const geo = webMercatorUtils.webMercatorToGeographic(mapPoint);
      return { lon: geo.x, lat: geo.y };
    }
    if (typeof mapPoint.longitude === "number" && typeof mapPoint.latitude === "number") {
      return { lon: mapPoint.longitude, lat: mapPoint.latitude };
    }
    if (sr && sr.isWGS84) return { lon: mapPoint.x, lat: mapPoint.y };
    return null;
  }

  let identifySeq = 0;

  function clearSelection() {
    selectedTarget = null;
    clearHighlight();
    if (view && view.popup) view.closePopup();
    setPopupOpen(false);
  }

  function identify(x, y, mapPoint) {
    const seq = ++identifySeq;
    const ll = lonLatOf(mapPoint);
    const ground = ll
      ? new Point({ longitude: ll.lon, latitude: ll.lat })
      : mapPoint;
    if (!ground) return;
    const layers = pointLayers();
    const hit = layers.length
      ? view.hitTest({ x: x, y: y }, { include: layers })
      : Promise.resolve({ results: [] });
    hit.then(function (response) {
      if (seq !== identifySeq) return null;
      const graphicHit = response.results.find(function (result) {
        return result.graphic && (result.graphic.layer === unifamiliarLayer || result.graphic.layer === plurifamiliarLayer || result.graphic.layer === incidenciaLayer);
      });
      if (graphicHit) {
        const attrs = graphicHit.graphic.attributes;
        const wantedDir = String(attrs.direccion || "").trim();
        let building = null;
        if (attrs.tipo === "plurifamiliar") {
          building = edificios.find(function (item) {
            return item.tipo === "plurifamiliar" &&
              item.rc === attrs.rc &&
              (!wantedDir || String(item.direccion || "").trim() === wantedDir);
          }) || edificiosPorRc[attrs.rc];
        } else {
          building = edificiosPorRc[attrs.rc];
        }
        const geom = graphicHit.graphic.geometry;
        const llHit = lonLatOf(geom) || ll;
        applyHighlight({
          lon: llHit ? llHit.lon : null,
          lat: llHit ? llHit.lat : null,
          tipo: attrs.tipo,
          rc: attrs.rc,
          ref: attrs.ref || "",
          incidencia: attrs.incidencia || ""
        });
        if (attrs.incidencia || attrs.tipo !== "plurifamiliar" || !building) {
          openPopup(graphicHit.mapPoint || ground, attrs.direccion, dwellingHtml(attrs));
        } else {
          openPopup(graphicHit.mapPoint || ground, building.direccion, buildingHtml(building));
        }
        return null;
      }
      if (!parcelasOk) {
        clearSelection();
        return null;
      }
      return parcelasLayer.queryFeatures({
        geometry: ground,
        spatialRelationship: "intersects",
        outFields: ["REFCAT"],
        returnGeometry: false
      });
    }).then(function (result) {
      if (seq !== identifySeq || result == null) return;
      if (!result.features || !result.features.length) {
        clearSelection();
        return;
      }
      const rc = (result.features[0].attributes.REFCAT || "").trim();
      const building = edificiosPorRc[rc];
      if (!building) {
        clearSelection();
        return;
      }
      applyHighlight({
        lon: building.lon,
        lat: building.lat,
        tipo: building.tipo,
        rc: building.rc,
        ref: building.ref || "",
        incidencia: building.incidencia || ""
      });
      openPopup(ground, building.direccion, buildingHtml(building));
    }).catch(function (err) {
      console.error(err);
    });
  }

  const clickSlop = 18;
  let press = null;

  let lastIdentifyAt = 0;

  function identifyFromPointer(event) {
    if (areaMode || streetMode || Date.now() < ignoreIdentifyUntil) return;
    const now = Date.now();
    if (now - lastIdentifyAt < 450) return;
    lastIdentifyAt = now;
    const mapPoint = event.mapPoint || view.toMap({ x: event.x, y: event.y });
    if (!mapPoint) return;
    identify(event.x, event.y, mapPoint);
  }

  function highlightKind(target) {
    if (!target) return "uni";
    if (target.incidencia) return "incidencia";
    if (target.tipo === "plurifamiliar" || target.tipo === "casas") return "pluri";
    return "uni";
  }

  function highlightSymbol(flat, kind) {
    const gold = "#f5c518";
    const fill = [245, 197, 24, 0.22];
    if (flat) {
      return {
        type: "simple-marker",
        style: kind === "pluri" ? "square" : (kind === "incidencia" ? "diamond" : "circle"),
        size: kind === "pluri" ? 28 : 24,
        color: fill,
        outline: { color: gold, width: 3.5 }
      };
    }
    if (kind === "pluri") {
      return new PointSymbol3D({
        symbolLayers: [
          new IconSymbol3DLayer({
            resource: { primitive: "square" },
            size: 42,
            material: { color: fill },
            outline: { color: gold, size: 3.5 }
          })
        ],
        verticalOffset: {
          screenLength: 52,
          maxWorldLength: 48,
          minWorldLength: 8
        },
        callout: new LineCallout3D({
          size: 3,
          color: [245, 197, 24, 1]
        })
      });
    }
    return new PointSymbol3D({
      symbolLayers: [
        new IconSymbol3DLayer({
          resource: { primitive: kind === "incidencia" ? "kite" : "circle" },
          size: 28,
          material: { color: fill },
          outline: { color: gold, size: 3 }
        })
      ]
    });
  }

  function highlightRing(lon, lat, meters) {
    const ring = [];
    const cos = Math.cos(lat * Math.PI / 180) || 1;
    for (let i = 0; i <= 48; i++) {
      const angle = (i / 48) * Math.PI * 2;
      ring.push([
        lon + (Math.cos(angle) * meters) / (111320 * cos),
        lat + (Math.sin(angle) * meters) / 110540
      ]);
    }
    return new Polygon({
      rings: [ring],
      spatialReference: { wkid: 4326 }
    });
  }

  function clearHighlight() {
    if (highlightHandle) {
      highlightHandle.remove();
      highlightHandle = null;
    }
    highlightLayer.removeAll();
    highlightGroundLayer.removeAll();
  }

  function sqlText(value) {
    return String(value || "").replace(/'/g, "''");
  }

  function applyHighlight(target) {
    selectedTarget = target || null;
    clearHighlight();
    if (!target || target.lon == null || target.lat == null) return;
    const kind = highlightKind(target);
    const flat = view.type === "2d";
    const point = new Point({ longitude: target.lon, latitude: target.lat });
    highlightGroundLayer.add(new Graphic({
      geometry: highlightRing(target.lon, target.lat, kind === "pluri" ? 36 : 12),
      symbol: {
        type: "simple-fill",
        color: [245, 197, 24, 0.28],
        outline: { color: [245, 197, 24, 1], width: 3 }
      }
    }));
    highlightLayer.add(new Graphic({
      geometry: point,
      symbol: highlightSymbol(flat, kind)
    }));
    const layer = target.incidencia
      ? incidenciaLayer
      : (kind === "pluri" ? plurifamiliarLayer : unifamiliarLayer);
    if (!layer) return;
    const where = target.ref
      ? "ref = '" + sqlText(target.ref) + "'"
      : (target.rc ? "rc = '" + sqlText(target.rc) + "'" : "");
    if (!where) return;
    view.whenLayerView(layer).then(function (layerView) {
      if (selectedTarget !== target) return;
      return layer.queryFeatures({
        where: where,
        returnGeometry: false
      }).then(function (result) {
        if (selectedTarget !== target) return;
        if (highlightHandle) {
          highlightHandle.remove();
          highlightHandle = null;
        }
        if (result.features && result.features.length) {
          highlightHandle = layerView.highlight(result.features);
        }
      });
    }).catch(function (err) {
      console.error(err);
    });
  }

  function focusOf(building, address) {
    const wanted = String(address || "").trim();
    const units = (building.unidades || []).filter(function (unidad) {
      if (unidad.lon == null || unidad.lat == null) return false;
      return !wanted || String(unidad.direccion || "").trim() === wanted;
    });
    if (units.length) {
      let lon = 0;
      let lat = 0;
      units.forEach(function (unidad) {
        lon += unidad.lon;
        lat += unidad.lat;
      });
      return { lon: lon / units.length, lat: lat / units.length };
    }
    return { lon: building.lon, lat: building.lat };
  }

  function flyTo(lon, lat) {
    const target = new Point({ longitude: lon, latitude: lat });
    if (view.type === "2d") {
      return view.goTo({ target: target, zoom: 18 }, { duration: 900 });
    }
    return view.goTo(
      { target: target, heading: 28, tilt: 67, zoom: 18 },
      { duration: 1200 }
    );
  }

  function showBuilding(building, address) {
    const focus = focusOf(building, address);
    const point = new Point({
      longitude: focus.lon,
      latitude: focus.lat
    });
    applyHighlight({
      lon: focus.lon,
      lat: focus.lat,
      tipo: building.tipo,
      rc: building.rc,
      ref: building.ref || "",
      incidencia: building.incidencia || ""
    });
    openPopup(point, address || building.direccion, buildingHtml(building));
    flyTo(focus.lon, focus.lat).catch(function (err) {
      console.error(err);
    });
  }

  const searchInput = document.getElementById("searchInput");
  const searchList = document.getElementById("searchList");

  function hideSearch() {
    searchList.hidden = true;
    searchList.innerHTML = "";
  }

  function addressParts(text) {
    const label = String(text || "").trim();
    const match = label.match(/^(.*\S)\s+(\d+)([A-Za-z]?)$/);
    if (!match) {
      return { street: label.toUpperCase(), number: 1000000, suffix: "", label: label };
    }
    return {
      street: match[1].toUpperCase(),
      number: parseInt(match[2], 10),
      suffix: match[3].toUpperCase(),
      label: label
    };
  }

  function rowsOf(building) {
    if (building.tipo === "plurifamiliar" && building.unidades && building.unidades.length) {
      const grouped = {};
      const order = [];
      building.unidades.forEach(function (unidad) {
        const label = (unidad.direccion || "").trim();
        if (!label) return;
        if (!grouped[label]) {
          grouped[label] = { residentes: 0, viviendas: 0 };
          order.push(label);
        }
        grouped[label].residentes += Number(unidad.residentes) || 0;
        grouped[label].viviendas += 1;
      });
      if (order.length) {
        return order.map(function (label) {
          const group = grouped[label];
          const detail = group.viviendas === 1
            ? group.residentes + " residentes · unifamiliar"
            : group.residentes + " residentes · " + group.viviendas + " viviendas";
          return { building: building, label: label, detail: detail, parts: addressParts(label) };
        });
      }
    }
    const detail = building.incidencia
      ? building.residentes + " residentes · incidencia" + (building.letra ? " · " + building.letra : "")
      : building.viviendas === 1
        ? building.residentes + " residentes · unifamiliar"
        : building.residentes + " residentes · " + building.viviendas + " viviendas";
    return [{
      building: building,
      label: building.direccion,
      detail: detail,
      parts: addressParts(building.direccion)
    }];
  }

  function renderSearch(query) {
    const q = query.trim().toUpperCase();
    if (q.length < 2) {
      hideSearch();
      return;
    }
    const qParts = addressParts(q);
    const qHasNumber = /\s\d+[A-Za-z]?$/.test(q);
    const qStreet = qHasNumber ? qParts.street : q;
    const matches = [];
    const seen = {};
    for (let i = 0; i < edificios.length; i++) {
      rowsOf(edificios[i]).forEach(function (row) {
        const streetHit = qStreet.length >= 2 && row.parts.street.indexOf(qStreet) !== -1;
        const labelHit = row.label.toUpperCase().indexOf(q) !== -1;
        if (!streetHit && !labelHit) return;
        if (qHasNumber && row.parts.number !== qParts.number) return;
        const key = row.label.toUpperCase() + "|" + (row.building.rc || "") +
          (row.building.incidencia ? "|" + (row.building.ref || row.building.letra || "i") : "");
        if (seen[key]) return;
        seen[key] = true;
        matches.push(row);
      });
    }
    matches.sort(function (a, b) {
      const byStreet = a.parts.street.localeCompare(b.parts.street, "es");
      if (byStreet) return byStreet;
      if (a.parts.number !== b.parts.number) return a.parts.number - b.parts.number;
      const bySuffix = a.parts.suffix.localeCompare(b.parts.suffix, "es");
      if (bySuffix) return bySuffix;
      return a.label.localeCompare(b.label, "es");
    });
    if (!matches.length) {
      hideSearch();
      return;
    }
    searchList.innerHTML = matches
      .map(function (row, index) {
        return (
          "<li><button type='button' data-index='" + index + "'>" +
          esc(row.label) +
          "<small>" + esc(row.detail) + "</small></button></li>"
        );
      })
      .join("");
    searchList.hidden = false;
    searchList._matches = matches;
  }

  searchInput.addEventListener("input", function () {
    renderSearch(searchInput.value);
  });

  searchList.addEventListener("click", function (event) {
    const button = event.target.closest("button");
    if (!button || !searchList._matches) return;
    const row = searchList._matches[Number(button.dataset.index)];
    searchInput.value = row.label;
    hideSearch();
    showBuilding(row.building, row.label);
  });

  document.addEventListener("click", function (event) {
    if (!document.getElementById("searchBox").contains(event.target)) hideSearch();
  });

  function loadLimite() {
    return fetch(LIMITE_QUERY).then(function (response) {
      if (!response.ok) throw new Error("limite");
      return response.json();
    }).then(function (data) {
      const feature = (data.features || [])[0];
      const rings = feature && feature.geometry && feature.geometry.rings;
      if (!rings || !rings.length) throw new Error("limite vacio");
      return rings;
    }).catch(function () {
      return fetch("data/limite.json").then(function (response) { return response.json(); }).then(function (geo) {
        return geo.features[0].geometry.coordinates;
      });
    });
  }

  function applyLimite(rings) {
    if (!rings || !rings.length || !rings[0] || rings[0].length < 4) return;
    limiteRing = rings[0];
    const polygon = new Polygon({
      rings: rings,
      spatialReference: { wkid: 4326 }
    });
    buildingsLayer.filter = {
      geometries: [polygon],
      spatialRelationship: "contains"
    };
    const extent = polygon.extent.clone().expand(2.4);
    clipExtent = extent;
    limitePolygon = polygon;
    if (view.type === "3d") view.clippingArea = extent;
    frameMunicipio(polygon.extent);
    maskLayer.removeAll();
    maskLayer.add(new Graphic({
      geometry: polygon,
      symbol: {
        type: "simple-fill",
        color: [0, 0, 0, 0],
        outline: { color: [15, 111, 106, 1], width: 2.5 }
      }
    }));
    filterParcelas();
  }

  function filterParcelas() {
    if (!parcelasOk || !limitePolygon) return;
    view.whenLayerView(parcelasLayer).then(function (layerView) {
      layerView.filter = {
        geometry: limitePolygon,
        spatialRelationship: "intersects"
      };
    }).catch(function (err) {
      console.error(err);
    });
  }

  function frameMunicipio(extent) {
    homeExtent = extent.clone().expand(0.78);
    const camera = view.type === "2d"
      ? { target: homeExtent.clone() }
      : { target: homeExtent.clone(), heading: 0, tilt: 22 };
    view.goTo(camera, { duration: 0 }).then(function () {
      if (view.type === "3d") homeViewpoint3d = view.viewpoint.clone();
      homeWidget.viewpoint = view.viewpoint.clone();
    }).catch(function (err) {
      console.error(err);
    });
  }

  function offsetLonLat(lon, lat, index, total, meters) {
    if (!total || total < 2) return { lon: lon, lat: lat };
    const angle = (2 * Math.PI * index) / total - Math.PI / 2;
    const m = meters == null ? 12 : meters;
    const cos = Math.cos(lat * Math.PI / 180) || 1;
    return {
      lon: lon + (m * Math.sin(angle)) / (111320 * cos),
      lat: lat + (m * Math.cos(angle)) / 110540
    };
  }

  /** Separación en espiral para muchos puntos en el mismo sitio (p. ej. Cañada). */
  function offsetSpiralLonLat(lon, lat, index, stepMeters) {
    if (!index) return { lon: lon, lat: lat };
    const step = stepMeters == null ? 7 : stepMeters;
    const angle = index * 2.399963229728653; // ángulo áureo
    const m = step * Math.sqrt(index);
    const cos = Math.cos(lat * Math.PI / 180) || 1;
    return {
      lon: lon + (m * Math.sin(angle)) / (111320 * cos),
      lat: lat + (m * Math.cos(angle)) / 110540
    };
  }

  /**
   * Separa viviendas con coordenadas idénticas (o casi) para poder clicarlas.
   * Cañada (incidencias) y conjuntos unifamiliares con mismo XY (p. ej. Océano Atlántico 2/4).
   */
  function spreadCoincidentFeatures(features) {
    const groups = {};
    (features || []).forEach(function (feature) {
      const coords = feature.geometry && feature.geometry.coordinates;
      if (!coords) return;
      const key = coords[0].toFixed(5) + "|" + coords[1].toFixed(5);
      (groups[key] = groups[key] || []).push(feature);
    });
    Object.keys(groups).forEach(function (key) {
      const list = groups[key];
      if (list.length < 2) return;
      const baseLon = list[0].geometry.coordinates[0];
      const baseLat = list[0].geometry.coordinates[1];
      const useSpiral = list.length > 8;
      const ringMeters = list.length > 20 ? 16 : 12;
      const spiralStep = list.length > 40 ? 5.5 : 6.5;
      list.forEach(function (feature, index) {
        const nudged = useSpiral
          ? offsetSpiralLonLat(baseLon, baseLat, index, spiralStep)
          : offsetLonLat(baseLon, baseLat, index, list.length, ringMeters);
        feature.geometry.coordinates[0] = nudged.lon;
        feature.geometry.coordinates[1] = nudged.lat;
      });
    });
  }

  function streetNameOf(direccion) {
    return String(direccion || "")
      .replace(/\s+\d+[A-Za-z]?(?:\s*[-/].*)?$/i, "")
      .trim()
      .toUpperCase();
  }

  function stripViaPrefix(name) {
    return String(name || "")
      .replace(
        /^(CALLE|CL|AVDA|AVENIDA|AV|PASEO|PS|PLAZA|PZ|CAMINO|CM|CTRA|CARRETERA|CR|GLORIETA|GT|TRAVESIA|TRVA|RONDA|RD)\s+/i,
        ""
      )
      .trim();
  }

  function normCalleKey(name) {
    return stripViaPrefix(
      String(name || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[º°ª]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase()
    )
      .replace(/^DE\s+/, "")
      .replace(/(\d)\s*O\b/g, "$1") // 1O DE MAYO → 1 DE MAYO
      .replace(/\bO\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function callesMatch(a, b) {
    const na = normCalleKey(a);
    const nb = normCalleKey(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.endsWith(nb) || nb.endsWith(na)) return true;
    return false;
  }

  function parseAddressParts(direccion) {
    const text = String(direccion || "").trim().toUpperCase();
    const m = text.match(/^(.*?)\s+(\d+)[A-Z]?(?:\s*[-/].*)?$/i);
    if (!m) {
      return { street: stripViaPrefix(streetNameOf(direccion)), num: "" };
    }
    return {
      street: stripViaPrefix(m[1]),
      num: String(parseInt(m[2], 10))
    };
  }

  function houseSortKey(props) {
    props = props || {};
    const label = houseNumberLabel(props);
    if (label) {
      const n = parseInt(label, 10);
      if (!isNaN(n)) return n;
    }
    const ref = String(props.ref || "");
    if (ref.length >= 18) {
      const cargo = parseInt(ref.slice(14, 18), 10);
      if (!isNaN(cargo)) return cargo;
    }
    return 99999;
  }

  function metersToLonLat(lon, lat, eastM, northM) {
    const cos = Math.cos(lat * Math.PI / 180) || 1;
    return {
      lon: lon + eastM / (111320 * cos),
      lat: lat + northM / 110540
    };
  }

  function offsetAlongBearing(lon, lat, alongM, acrossM, bearingRad) {
    const cosB = Math.cos(bearingRad);
    const sinB = Math.sin(bearingRad);
    const east = alongM * cosB - acrossM * sinB;
    const north = alongM * sinB + acrossM * cosB;
    return metersToLonLat(lon, lat, east, north);
  }

  /** Dirección de la calle a partir de otros puntos ya bien colocados. */
  function estimateStreetBearing(baseLon, baseLat, street, buildings, rc) {
    const pts = [];
    (buildings || []).forEach(function (b) {
      if (b.lon == null || b.lat == null) return;
      const sameStreet = street && streetNameOf(b.direccion) === street;
      const sameRc = rc && b.rc && String(b.rc) === String(rc);
      if (!sameStreet && !sameRc) return;
      const cos = Math.cos(baseLat * Math.PI / 180) || 1;
      const dx = (b.lon - baseLon) * 111320 * cos;
      const dy = (b.lat - baseLat) * 110540;
      if (dx * dx + dy * dy < 4 || dx * dx + dy * dy > 320 * 320) return;
      pts.push({ x: dx, y: dy });
    });
    if (pts.length < 2) return 0;
    let mx = 0;
    let my = 0;
    pts.forEach(function (p) { mx += p.x; my += p.y; });
    mx /= pts.length;
    my /= pts.length;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    pts.forEach(function (p) {
      const x = p.x - mx;
      const y = p.y - my;
      sxx += x * x;
      sxy += x * y;
      syy += y * y;
    });
    return 0.5 * Math.atan2(2 * sxy, sxx - syy);
  }

  function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      const intersect = ((yi > lat) !== (yj > lat)) &&
        (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-30) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function pointInParcel(lon, lat, rings) {
    if (!rings || !rings.length) return false;
    if (!pointInRing(lon, lat, rings[0])) return false;
    for (let h = 1; h < rings.length; h++) {
      if (pointInRing(lon, lat, rings[h])) return false;
    }
    return true;
  }

  function parcelCentroid(rings) {
    let lon = 0;
    let lat = 0;
    let n = 0;
    (rings[0] || []).forEach(function (p) {
      lon += p[0];
      lat += p[1];
      n += 1;
    });
    if (!n) return null;
    return { lon: lon / n, lat: lat / n };
  }

  function parcelExtentMeters(rings) {
    const c = parcelCentroid(rings);
    if (!c) return { width: 40, height: 40, cx: 0, cy: 0 };
    let minE = 0;
    let maxE = 0;
    let minN = 0;
    let maxN = 0;
    const cos = Math.cos(c.lat * Math.PI / 180) || 1;
    (rings[0] || []).forEach(function (p, idx) {
      const e = (p[0] - c.lon) * 111320 * cos;
      const n = (p[1] - c.lat) * 110540;
      if (!idx) {
        minE = maxE = e;
        minN = maxN = n;
      } else {
        minE = Math.min(minE, e);
        maxE = Math.max(maxE, e);
        minN = Math.min(minN, n);
        maxN = Math.max(maxN, n);
      }
    });
    return {
      cx: c.lon,
      cy: c.lat,
      width: Math.max(20, maxE - minE),
      height: Math.max(20, maxN - minN)
    };
  }

  /** Reparte chalets dentro del polígono catastral (SIT), no en espiral desde el portal. */
  function layoutListInParcel(list, rings, bearing) {
    const n = list.length;
    const ext = parcelExtentMeters(rings);
    const spacings = [15, 12, 10, 8, 6.5, 5.5];
    let slots = [];
    for (let s = 0; s < spacings.length; s++) {
      const space = spacings[s];
      slots = [];
      const halfA = ext.width * 0.55;
      const halfC = ext.height * 0.55;
      for (let along = -halfA; along <= halfA + 0.01; along += space) {
        for (let across = -halfC; across <= halfC + 0.01; across += space) {
          const p = offsetAlongBearing(ext.cx, ext.cy, along, across, bearing);
          if (pointInParcel(p.lon, p.lat, rings)) {
            slots.push({ lon: p.lon, lat: p.lat, along: along, across: across });
          }
        }
      }
      slots.sort(function (a, b) {
        if (a.across !== b.across) return a.across - b.across;
        return a.along - b.along;
      });
      if (slots.length >= n) break;
    }
    if (slots.length < n) return false;
    // Si sobran huecos, coger una muestra repartida
    const step = slots.length / n;
    list.forEach(function (feature, index) {
      const slot = slots[Math.min(slots.length - 1, Math.floor(index * step))];
      feature.geometry.coordinates[0] = slot.lon;
      feature.geometry.coordinates[1] = slot.lat;
    });
    return true;
  }

  function layoutListStreetGrid(list, buildings) {
    const baseLon = list[0].geometry.coordinates[0];
    const baseLat = list[0].geometry.coordinates[1];
    const street = streetNameOf(list[0].properties.direccion);
    const rc = list[0].properties.rc || "";
    const bearing = estimateStreetBearing(baseLon, baseLat, street, buildings, rc);
    const n = list.length;
    const alongSpacing = n > 80 ? 7.5 : (n > 40 ? 9 : 11);
    const acrossSpacing = 13;
    let cols;
    if (n <= 10) cols = n;
    else if (n <= 30) cols = Math.ceil(n / 2);
    else cols = Math.min(22, Math.max(8, Math.ceil(Math.sqrt(n * 1.6))));
    const rows = Math.ceil(n / cols);
    list.forEach(function (feature, index) {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const along = (col - (cols - 1) / 2) * alongSpacing;
      const across = (row - (rows - 1) / 2) * acrossSpacing;
      const nudged = offsetAlongBearing(baseLon, baseLat, along, across, bearing);
      feature.geometry.coordinates[0] = nudged.lon;
      feature.geometry.coordinates[1] = nudged.lat;
    });
  }

  function featuresNeedSharedPortalLayout(list) {
    if (!list || list.length < 2) return false;
    // Mismo portal/dirección, o casi el mismo XY (< 8 m)
    const base = list[0].geometry && list[0].geometry.coordinates;
    if (!base) return false;
    const cos = Math.cos(base[1] * Math.PI / 180) || 1;
    let maxDist2 = 0;
    for (let i = 1; i < list.length; i++) {
      const c = list[i].geometry && list[i].geometry.coordinates;
      if (!c) continue;
      const dx = (c[0] - base[0]) * 111320 * cos;
      const dy = (c[1] - base[1]) * 110540;
      maxDist2 = Math.max(maxDist2, dx * dx + dy * dy);
    }
    return maxDist2 < 8 * 8;
  }

  /** Agrupa unifamiliares que comparten portal (dirección) o están apelotonados. */
  function coincidentUniGroups(features) {
    const byAddr = {};
    const byXy = {};
    (features || []).forEach(function (feature) {
      if (!feature.properties || feature.properties.tipo !== "unifamiliar") return;
      const coords = feature.geometry && feature.geometry.coordinates;
      if (!coords) return;
      const addr = String(feature.properties.direccion || "").trim();
      if (addr) (byAddr[addr] = byAddr[addr] || []).push(feature);
      const xy = coords[0].toFixed(5) + "|" + coords[1].toFixed(5);
      (byXy[xy] = byXy[xy] || []).push(feature);
    });
    const used = {};
    const groups = [];
    function mark(list) {
      list.forEach(function (f) {
        const vid = f.properties.vid != null ? f.properties.vid : f.properties.id;
        used[String(vid)] = true;
      });
    }
    Object.keys(byAddr).forEach(function (addr) {
      const list = byAddr[addr];
      if (!featuresNeedSharedPortalLayout(list)) return;
      groups.push(list);
      mark(list);
    });
    Object.keys(byXy).forEach(function (xy) {
      const list = byXy[xy].filter(function (f) {
        const vid = f.properties.vid != null ? f.properties.vid : f.properties.id;
        return !used[String(vid)];
      });
      if (list.length > 1) groups.push(list);
    });
    return groups;
  }

  function fetchParcelRingsByRc(rcs) {
    const unique = [];
    const seen = {};
    (rcs || []).forEach(function (rc) {
      const key = String(rc || "").trim().toUpperCase();
      if (!key || seen[key]) return;
      seen[key] = true;
      unique.push(key);
    });
    if (!unique.length || !parcelasLayer) return Promise.resolve({});
    const chunks = [];
    for (let i = 0; i < unique.length; i += 12) chunks.push(unique.slice(i, i + 12));
    return Promise.all(chunks.map(function (chunk) {
      const where = chunk.map(function (rc) {
        return "REFCAT='" + rc.replace(/'/g, "''") + "'";
      }).join(" OR ");
      return parcelasLayer.queryFeatures({
        where: where,
        outFields: ["REFCAT"],
        returnGeometry: true,
        outSpatialReference: { wkid: 4326 }
      });
    })).then(function (results) {
      const byRc = {};
      results.forEach(function (res) {
        (res.features || []).forEach(function (graphic) {
          const rc = String((graphic.attributes && graphic.attributes.REFCAT) || "").trim().toUpperCase();
          const rings = graphic.geometry && graphic.geometry.rings;
          if (rc && rings && rings.length) byRc[rc] = rings;
        });
      });
      return byRc;
    }).catch(function (err) {
      console.warn("No se pudieron cargar parcelas para posicionar chalets", err);
      return {};
    });
  }

  /** Puntos de ACCESOS_PORTALES por parcela (14 chars). Con timeout para no bloquear el visor. */
  function fetchPortalesByRc(rcs) {
    const unique = [];
    const seen = {};
    (rcs || []).forEach(function (rc) {
      const key = String(rc || "").trim().toUpperCase().slice(0, 14);
      if (key.length < 14 || seen[key]) return;
      seen[key] = true;
      unique.push(key);
    });
    if (!unique.length || !portalesLayer) return Promise.resolve({});

    const queryOnce = portalesLayer.load().then(function () {
      const chunks = [];
      // Pocos RC por consulta: ACCESOS puede devolver muchos puntos por parcela.
      for (let i = 0; i < unique.length; i += 4) chunks.push(unique.slice(i, i + 4));
      return Promise.all(chunks.map(function (chunk) {
        const where = chunk.map(function (rc) {
          return "REFCATASTRAL LIKE '" + rc.replace(/'/g, "''") + "%'";
        }).join(" OR ");
        return portalesLayer.queryFeatures({
          where: where,
          outFields: ["REFCATASTRAL", "ACCESO", "CALLE"],
          returnGeometry: true,
          outSpatialReference: { wkid: 4326 },
          resultRecordCount: 2000
        });
      }));
    }).then(function (results) {
      const byRc = {};
      results.forEach(function (res) {
        (res.features || []).forEach(function (graphic) {
          const attrs = graphic.attributes || {};
          const rc = String(attrs.REFCATASTRAL || "").trim().toUpperCase().slice(0, 14);
          const geom = graphic.geometry;
          const lon = geom && (geom.longitude != null ? geom.longitude : geom.x);
          const lat = geom && (geom.latitude != null ? geom.latitude : geom.y);
          if (!rc || lon == null || lat == null) return;
          const acceso = String(attrs.ACCESO || "").replace(/\D/g, "");
          let num = "";
          try { num = String(parseInt(acceso, 10)); } catch (e) { num = ""; }
          if (!num) return;
          (byRc[rc] = byRc[rc] || []).push({
            calle: attrs.CALLE || "",
            num: num,
            lon: Number(lon),
            lat: Number(lat)
          });
        });
      });
      return byRc;
    }).catch(function (err) {
      console.warn("No se pudieron cargar portales municipales", err);
      return {};
    });

    const timeout = new Promise(function (resolve) {
      setTimeout(function () { resolve({}); }, 12000);
    });
    return Promise.race([queryOnce, timeout]);
  }

  function portalsForAddress(portalesByRc, rc, street, num) {
    if (!rc || !street || !num) return [];
    const list = portalesByRc[rc] || [];
    return list.filter(function (p) {
      return p.num === String(num) && callesMatch(p.calle, street);
    });
  }

  /** Asigna cada vivienda a un portal municipal de su calle (fachada), no al centro de parcela. */
  function layoutListOnPortalPoints(list, portals) {
    if (!list || !list.length || !portals || portals.length < 2) return false;
    if (portals.length < Math.max(2, Math.ceil(list.length * 0.55))) return false;
    const sortedPortals = portals.slice().sort(function (a, b) {
      if (Math.abs(a.lat - b.lat) > 1e-7) return a.lat - b.lat;
      return a.lon - b.lon;
    });
    list.sort(function (a, b) {
      return houseSortKey(a.properties) - houseSortKey(b.properties);
    });
    const step = sortedPortals.length / list.length;
    list.forEach(function (feature, index) {
      const portal = sortedPortals[Math.min(sortedPortals.length - 1, Math.floor(index * step + 1e-9))];
      feature.geometry.coordinates[0] = portal.lon;
      feature.geometry.coordinates[1] = portal.lat;
    });
    return true;
  }

  /**
   * Reparte dentro de la parcela pero solo cerca de la fachada (ancla = media de portales).
   * Evita meter Avda Velázquez en el interior hacia 1 de Mayo.
   */
  function layoutListNearFacade(list, rings, anchorLon, anchorLat, bearing) {
    if (!list || !list.length || !rings || anchorLon == null || anchorLat == null) return false;
    const n = list.length;
    const ext = parcelExtentMeters(rings);
    const maxDist = Math.max(28, Math.min(55, Math.sqrt(ext.width * ext.height) * 0.22));
    const maxDist2 = maxDist * maxDist;
    const cos = Math.cos(anchorLat * Math.PI / 180) || 1;
    const spacings = [12, 10, 8, 6.5, 5.5];
    let slots = [];
    for (let s = 0; s < spacings.length; s++) {
      const space = spacings[s];
      slots = [];
      const halfA = ext.width * 0.55;
      const halfC = ext.height * 0.55;
      for (let along = -halfA; along <= halfA + 0.01; along += space) {
        for (let across = -halfC; across <= halfC + 0.01; across += space) {
          const p = offsetAlongBearing(ext.cx, ext.cy, along, across, bearing || 0);
          if (!pointInParcel(p.lon, p.lat, rings)) continue;
          const dx = (p.lon - anchorLon) * 111320 * cos;
          const dy = (p.lat - anchorLat) * 110540;
          if (dx * dx + dy * dy > maxDist2) continue;
          slots.push({ lon: p.lon, lat: p.lat, along: along, across: across });
        }
      }
      slots.sort(function (a, b) {
        if (a.across !== b.across) return a.across - b.across;
        return a.along - b.along;
      });
      if (slots.length >= n) break;
    }
    if (slots.length < n) return false;
    const step = slots.length / n;
    list.forEach(function (feature, index) {
      const slot = slots[Math.min(slots.length - 1, Math.floor(index * step))];
      feature.geometry.coordinates[0] = slot.lon;
      feature.geometry.coordinates[1] = slot.lat;
    });
    return true;
  }

  function layoutAddressGroup(list, parcelByRc, portalesByRc, buildings) {
    if (!list || !list.length) return false;
    list.sort(function (a, b) {
      return houseSortKey(a.properties) - houseSortKey(b.properties);
    });
    const parts = parseAddressParts(list[0].properties && list[0].properties.direccion);
    const rc = String((list[0].properties && list[0].properties.rc) || "").trim().toUpperCase().slice(0, 14);
    const rings = parcelByRc[rc];
    const street = streetNameOf(list[0].properties.direccion);
    const portals = portalsForAddress(portalesByRc, rc, parts.street, parts.num);

    if (layoutListOnPortalPoints(list, portals)) return true;

    let anchorLon = list[0].geometry.coordinates[0];
    let anchorLat = list[0].geometry.coordinates[1];
    if (portals.length) {
      anchorLon = portals.reduce(function (s, p) { return s + p.lon; }, 0) / portals.length;
      anchorLat = portals.reduce(function (s, p) { return s + p.lat; }, 0) / portals.length;
    }
    const bearing = estimateStreetBearing(anchorLon, anchorLat, street, buildings, rc);
    if (rings && layoutListNearFacade(list, rings, anchorLon, anchorLat, bearing)) return true;

    // Parcela multi-fachada: no rellenar todo el polígono (mezcla calles).
    const streetsOnRc = {};
    (portalesByRc[rc] || []).forEach(function (p) {
      streetsOnRc[normCalleKey(p.calle)] = true;
    });
    const multiFacade = Object.keys(streetsOnRc).length >= 2;
    if (rings && !multiFacade && layoutListInParcel(list, rings, bearing)) return true;

    // Anclar a la media de portales de esa calle y rejilla corta.
    if (portals.length) {
      list.forEach(function (feature) {
        feature.geometry.coordinates[0] = anchorLon;
        feature.geometry.coordinates[1] = anchorLat;
      });
      layoutListStreetGrid(list, buildings);
      return true;
    }
    if (rings && layoutListInParcel(list, rings, bearing)) return true;
    layoutListStreetGrid(list, buildings);
    return true;
  }

  /**
   * Unifamiliares que comparten portal/XY: portales SIT por fachada si existen;
   * si no, franja cerca de la calle; nunca espiral.
   */
  function layoutCoincidentUnifamiliares(features, buildings) {
    const groups = coincidentUniGroups(features);
    if (!groups.length) return Promise.resolve();
    const rcs = [];
    const portalRcs = [];
    groups.forEach(function (list) {
      list.forEach(function (feature) {
        const rc = feature.properties && feature.properties.rc;
        if (rc) rcs.push(rc);
      });
      // Solo pedir ACCESOS para grupos grandes (chalets / multi-fachada).
      if (list.length >= 4) {
        list.forEach(function (feature) {
          const rc = feature.properties && feature.properties.rc;
          if (rc) portalRcs.push(rc);
        });
      }
    });
    const loadingP = document.querySelector("#loading p");
    if (loadingP) loadingP.textContent = "Colocando unifamiliares…";
    return Promise.all([
      fetchParcelRingsByRc(rcs),
      fetchPortalesByRc(portalRcs)
    ]).then(function (pair) {
      const parcelByRc = pair[0] || {};
      const portalesByRc = pair[1] || {};
      groups.forEach(function (list) {
        // Separar por dirección: misma parcela puede tener Velázquez y 1 de Mayo.
        const byAddr = {};
        list.forEach(function (feature) {
          const addr = String((feature.properties && feature.properties.direccion) || "").trim() || "_";
          (byAddr[addr] = byAddr[addr] || []).push(feature);
        });
        const addrKeys = Object.keys(byAddr);
        if (addrKeys.length > 1) {
          addrKeys.forEach(function (addr) {
            layoutAddressGroup(byAddr[addr], parcelByRc, portalesByRc, buildings);
          });
          return;
        }

        list.sort(function (a, b) {
          return houseSortKey(a.properties) - houseSortKey(b.properties);
        });
        // Si cada vivienda tiene RC distinta con polígono, usar su parcela.
        const byRc = {};
        list.forEach(function (feature) {
          const key = String((feature.properties && feature.properties.rc) || "").trim().toUpperCase();
          if (!key) return;
          (byRc[key] = byRc[key] || []).push(feature);
        });
        const rcKeys = Object.keys(byRc);
        const multiRcWithParcel = rcKeys.filter(function (key) {
          return parcelByRc[key] && byRc[key].length >= 1;
        });
        if (multiRcWithParcel.length >= 2 && multiRcWithParcel.length >= rcKeys.length * 0.6) {
          let any = false;
          multiRcWithParcel.forEach(function (key) {
            if (layoutAddressGroup(byRc[key], parcelByRc, portalesByRc, buildings)) any = true;
          });
          if (any) return;
        }
        if (layoutAddressGroup(list, parcelByRc, portalesByRc, buildings)) return;
        layoutListStreetGrid(list, buildings);
      });
    });
  }

  function syncEdificiosCoordsFromFeatures(features, buildings) {
    const byVid = {};
    (features || []).forEach(function (feature) {
      const props = feature.properties || {};
      const vid = props.vid != null ? props.vid : props.id;
      if (vid == null || !feature.geometry || !feature.geometry.coordinates) return;
      byVid[String(vid)] = feature.geometry.coordinates;
    });
    (buildings || []).forEach(function (building) {
      if (building.tipo !== "unifamiliar") return;
      const vid = building.vid != null ? building.vid : (building.vids && building.vids[0]);
      const coords = vid != null ? byVid[String(vid)] : null;
      if (!coords) return;
      building.lon = coords[0];
      building.lat = coords[1];
    });
  }

  function meanCoords(featureList) {
    let lon = 0;
    let lat = 0;
    let n = 0;
    (featureList || []).forEach(function (feature) {
      const coords = feature.geometry && feature.geometry.coordinates;
      if (!coords) return;
      lon += coords[0];
      lat += coords[1];
      n += 1;
    });
    if (!n) return null;
    return { lon: lon / n, lat: lat / n };
  }

  function applyCoords(featureList, lon, lat) {
    (featureList || []).forEach(function (feature) {
      if (!feature.geometry || !feature.geometry.coordinates) return;
      feature.geometry.coordinates[0] = lon;
      feature.geometry.coordinates[1] = lat;
    });
  }

  /** Si varias direcciones caen en el mismo punto, las separa unos metros para poder clicarlas. */
  function spreadStackedAddressGroups(groups) {
    if (!groups || groups.length < 2) return;
    const base = meanCoords(groups.reduce(function (all, g) {
      return all.concat(g.features || []);
    }, []));
    if (!base) return;
    const cos = Math.cos(base.lat * Math.PI / 180) || 1;
    let maxDist2 = 0;
    groups.forEach(function (group) {
      const c = meanCoords(group.features);
      if (!c) return;
      const dx = (c.lon - base.lon) * 111320 * cos;
      const dy = (c.lat - base.lat) * 110540;
      maxDist2 = Math.max(maxDist2, dx * dx + dy * dy);
    });
    if (maxDist2 > 9) return; // ya hay >3 m de separación
    groups.forEach(function (group, index) {
      const nudged = offsetLonLat(base.lon, base.lat, index, groups.length, 14);
      group.lon = nudged.lon;
      group.lat = nudged.lat;
      applyCoords(group.features, nudged.lon, nudged.lat);
    });
  }

  function separateHouses(features) {
    const byRc = {};
    features.forEach(function (feature) {
      const rc = (feature.properties && feature.properties.rc) || "";
      (byRc[rc] = byRc[rc] || []).push(feature);
    });
    const kept = [];
    const search = [];
    const byParcel = {};

    Object.keys(byRc).forEach(function (rc) {
      const byAddr = {};
      byRc[rc].forEach(function (feature) {
        const addr = ((feature.properties && feature.properties.direccion) || "").trim();
        (byAddr[addr] = byAddr[addr] || []).push(feature);
      });
      const houseFeatures = [];
      const aptByAddr = {};
      Object.keys(byAddr).forEach(function (addr) {
        const group = byAddr[addr];
        if (group.length === 1) houseFeatures.push(group[0]);
        else aptByAddr[addr] = group;
      });
      let aptFeatures = [];
      Object.keys(aptByAddr).forEach(function (addr) {
        aptByAddr[addr].forEach(function (feature) { aptFeatures.push(feature); });
      });

      if (
        aptFeatures.length &&
        houseFeatures.length &&
        isGroundCommunity(byRc[rc]) &&
        looksLikeHouseNumbers(aptFeatures) &&
        !looksLikeChaletCluster(aptFeatures)
      ) {
        houseFeatures.forEach(function (feature) {
          const addr = ((feature.properties && feature.properties.direccion) || "").trim();
          (aptByAddr[addr] = aptByAddr[addr] || []).push(feature);
          aptFeatures.push(feature);
        });
        houseFeatures.length = 0;
      }

      // Urbanizaciones de chalets: varias viviendas en la misma dirección sin planta
      // (p. ej. Camilo José Cela 2) → un punto unifamiliar por chalet, no un bloque.
      Object.keys(aptByAddr).forEach(function (addr) {
        const group = aptByAddr[addr];
        if (!looksLikeChaletCluster(group)) return;
        group.forEach(function (feature) {
          houseFeatures.push(feature);
        });
        delete aptByAddr[addr];
      });
      aptFeatures = [];
      Object.keys(aptByAddr).forEach(function (addr) {
        aptByAddr[addr].forEach(function (feature) { aptFeatures.push(feature); });
      });

      // Solo separar en anillo fachadas/direcciones distintas.
      // Si son chalets sueltos en el mismo XY, NO expandir en círculo:
      // layoutCoincidentUnifamiliares los coloca dentro de la parcela.
      const aptAddrs = Object.keys(aptByAddr);
      if (aptAddrs.length) {
        const stackGroups = [];
        houseFeatures.forEach(function (feature) {
          stackGroups.push({ features: [feature] });
        });
        aptAddrs.forEach(function (addr) {
          stackGroups.push({ features: aptByAddr[addr], address: addr });
        });
        spreadStackedAddressGroups(stackGroups);
      }

      houseFeatures.forEach(function (feature) {
        const props = feature.properties;
        props.tipo = "unifamiliar";
        if (!props.planta || props.planta === "Sin planta") props.planta = "Unifamiliar";
        const coords = feature.geometry.coordinates;
        kept.push(feature);
        search.push({
          rc: rc,
          ref: props.ref || "",
          lon: coords[0],
          lat: coords[1],
          direccion: props.direccion,
          viviendas: 1,
          residentes: Number(props.residentes) || 0,
          hombres: Number(props.hombres) || 0,
          mujeres: Number(props.mujeres) || 0,
          edad_media: props.edad_media,
          vid: props.vid || props.id,
          vids: [props.vid || props.id].filter(Boolean),
          tipo: "unifamiliar",
          planta: props.planta,
          letra: props.letra || ""
        });
      });

      if (aptAddrs.length) {
        aptAddrs.forEach(function (addr) {
          const group = aptByAddr[addr];
          let lon = 0;
          let lat = 0;
          let residentes = 0;
          let hombres = 0;
          let mujeres = 0;
          let edadSum = 0;
          let edadN = 0;
          group.forEach(function (feature) {
            const coords = feature.geometry.coordinates;
            const props = feature.properties;
            lon += coords[0];
            lat += coords[1];
            residentes += Number(props.residentes) || 0;
            hombres += Number(props.hombres) || 0;
            mujeres += Number(props.mujeres) || 0;
            if (props.edad_media != null && props.residentes) {
              edadSum += Number(props.edad_media) * (Number(props.residentes) || 0);
              edadN += Number(props.residentes) || 0;
            }
            props.tipo = "plurifamiliar";
            kept.push(feature);
          });
          const entry = {
            rc: rc,
            lon: lon / group.length,
            lat: lat / group.length,
            direccion: addr,
            viviendas: group.length,
            residentes: residentes,
            hombres: hombres,
            mujeres: mujeres,
            edad_media: edadN ? Math.round((edadSum / edadN) * 10) / 10 : null,
            tipo: "plurifamiliar",
            planta: "",
            letra: ""
          };
          // Varias fachadas en la misma parcela: un marcador por dirección
          search.push(entry);
          if (!byParcel[rc]) byParcel[rc] = entry;
        });
      } else if (houseFeatures.length === 1) {
        byParcel[rc] = search[search.length - 1];
      } else if (houseFeatures.length) {
        let lon = 0;
        let lat = 0;
        let residentes = 0;
        const casas = houseFeatures.map(function (feature) {
          const coords = feature.geometry.coordinates;
          lon += coords[0];
          lat += coords[1];
          residentes += Number(feature.properties.residentes) || 0;
          return {
            direccion: feature.properties.direccion,
            residentes: Number(feature.properties.residentes) || 0,
            hombres: Number(feature.properties.hombres) || 0,
            mujeres: Number(feature.properties.mujeres) || 0,
            edad_media: feature.properties.edad_media,
            vid: feature.properties.vid || feature.properties.id
          };
        });
        casas.sort(function (a, b) { return a.direccion.localeCompare(b.direccion, "es"); });
        byParcel[rc] = {
          rc: rc,
          lon: lon / houseFeatures.length,
          lat: lat / houseFeatures.length,
          direccion: casas.map(function (casa) { return casa.direccion; }).slice(0, 3).join(" · "),
          viviendas: houseFeatures.length,
          residentes: residentes,
          tipo: "casas",
          casas: casas,
          planta: "",
          letra: ""
        };
      }
    });

    return { features: kept, search: search, byParcel: byParcel };
  }

  function refreshLabels() {
    if (!view || !view.ready || view.scale > MARKER_SCALE) {
      labelLayer.removeAll();
      return;
    }
    const mapPoint = view.toMap({ x: view.width / 2, y: view.height * 0.62 });
    const ll = lonLatOf(mapPoint);
    if (!ll) return;
    const showUni = view.scale <= 6000;
    const cos = Math.cos(ll.lat * Math.PI / 180) || 1;
    const maxMeters = 220;
    const max2 = maxMeters * maxMeters;
    const graphics = [];
    for (let i = 0; i < labelPoints.length; i++) {
      const item = labelPoints[i];
      if (item.kind === "uni" && !showUni) continue;
      const dx = (item.lon - ll.lon) * 111320 * cos;
      const dy = (item.lat - ll.lat) * 110540;
      if (dx * dx + dy * dy > max2) continue;
      graphics.push(new Graphic({
        geometry: new Point({ longitude: item.lon, latitude: item.lat }),
        symbol: numberSymbol(item.residentes, item.kind === "pluri")
      }));
    }
    labelLayer.removeAll();
    labelLayer.addMany(graphics);
  }

  function fieldVal(attrs, names) {
    if (!attrs) return null;
    const list = Array.isArray(names) ? names : [names];
    for (let i = 0; i < list.length; i++) {
      const key = list[i];
      if (attrs[key] != null && attrs[key] !== "") return attrs[key];
      const up = String(key).toUpperCase();
      if (attrs[up] != null && attrs[up] !== "") return attrs[up];
      const low = String(key).toLowerCase();
      if (attrs[low] != null && attrs[low] !== "") return attrs[low];
    }
    return null;
  }

  function ensurePortalSignIn() {
    const rest = PORTAL_URL.replace(/\/$/, "") + "/sharing/rest";
    return IdentityManager.checkSignInStatus(rest).catch(function () {
      const loadingP = document.querySelector("#loading p");
      if (loadingP) loadingP.textContent = "Inicia sesión en el Portal de ArcGIS…";
      return IdentityManager.getCredential(rest);
    });
  }

  function portalLayer(itemId) {
    return new FeatureLayer({
      portalItem: { id: itemId }
    });
  }

  function queryAllGraphics(layer) {
    return layer.load().then(function () {
      const pageSize = Math.min(
        (layer.capabilities && layer.capabilities.query && layer.capabilities.query.maxRecordCount) || 2000,
        2000
      );
      return layer.queryFeatureCount({ where: "1=1" }).then(function (count) {
        const pages = Math.max(1, Math.ceil(count / pageSize));
        const tasks = [];
        for (let i = 0; i < pages; i++) {
          tasks.push(layer.queryFeatures({
            where: "1=1",
            outFields: ["*"],
            returnGeometry: true,
            outSpatialReference: { wkid: 4326 },
            start: i * pageSize,
            num: pageSize
          }));
        }
        return Promise.all(tasks).then(function (results) {
          const graphics = [];
          results.forEach(function (res) {
            (res.features || []).forEach(function (g) { graphics.push(g); });
          });
          return graphics;
        });
      });
    });
  }

  function graphicToViviendaFeature(graphic) {
    const a = graphic.attributes || {};
    const geom = graphic.geometry;
    let lon = null;
    let lat = null;
    if (geom) {
      if (typeof geom.longitude === "number" && typeof geom.latitude === "number") {
        lon = geom.longitude;
        lat = geom.latitude;
      } else if (geom.spatialReference && geom.spatialReference.isWebMercator) {
        const geo = webMercatorUtils.webMercatorToGeographic(geom);
        lon = geo.x;
        lat = geo.y;
      } else {
        lon = geom.x;
        lat = geom.y;
      }
    }
    if (lon == null) lon = Number(fieldVal(a, ["lon", "LONGITUDE", "x"]));
    if (lat == null) lat = Number(fieldVal(a, ["lat", "LATITUDE", "y"]));
    const vid = fieldVal(a, ["vid", "id"]);
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        vid: vid,
        id: fieldVal(a, ["id"]) != null ? fieldVal(a, ["id"]) : vid,
        direccion: fieldVal(a, ["direccion"]) || "",
        tipo: fieldVal(a, ["tipo"]) || "",
        planta: fieldVal(a, ["planta"]) || "",
        piso: fieldVal(a, ["piso"]) || "",
        portal: fieldVal(a, ["portal"]) || "",
        letra: fieldVal(a, ["letra"]) || "",
        ref: fieldVal(a, ["ref", "ReferenciaCatastral"]) || "",
        rc: fieldVal(a, ["rc", "REFCAT_14"]) || "",
        residentes: Number(fieldVal(a, ["residentes", "HABITANTES"])) || 0,
        hombres: Number(fieldVal(a, ["hombres"])) || 0,
        mujeres: Number(fieldVal(a, ["mujeres"])) || 0,
        edad_media: fieldVal(a, ["edad_media"]),
        incidencia: fieldVal(a, ["incidencia"]) || "",
        b0: Number(fieldVal(a, ["b0"])) || 0,
        b1: Number(fieldVal(a, ["b1"])) || 0,
        b2: Number(fieldVal(a, ["b2"])) || 0,
        b3: Number(fieldVal(a, ["b3"])) || 0,
        b4: Number(fieldVal(a, ["b4"])) || 0
      }
    };
  }

  function applyUniXyOverrides(features, overrides) {
    if (!features || !overrides || typeof overrides !== "object") return features;
    const byRef = overrides.by_ref || {};
    const byRc = overrides.by_rc || {};
    const byDir = overrides.by_direccion || {};
    features.forEach(function (feature) {
      const props = feature.properties || {};
      if (props.incidencia) return;
      if (!feature.geometry || !feature.geometry.coordinates) return;
      const ref = String(props.ref || "").trim().toUpperCase();
      const rc = String(props.rc || "").trim().toUpperCase();
      const dir = String(props.direccion || "").trim().toUpperCase();
      let xy = null;
      if (ref && byRef[ref]) xy = byRef[ref];
      else if (dir && byDir[dir]) xy = byDir[dir];
      else if (rc && byRc[rc] && (!props.tipo || props.tipo === "unifamiliar")) xy = byRc[rc];
      if (!xy || xy.length < 2) return;
      const lon = Number(xy[0]);
      const lat = Number(xy[1]);
      if (!isFinite(lon) || !isFinite(lat)) return;
      feature.geometry.coordinates[0] = lon;
      feature.geometry.coordinates[1] = lat;
    });
    return features;
  }

  function loadUniXyOverrides() {
    return fetch("data/uni_xy_overrides.json?v=2")
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function loadViviendasCollection() {
    const withOverrides = function (fc) {
      return loadUniXyOverrides().then(function (overrides) {
        if (overrides) applyUniXyOverrides(fc.features || [], overrides);
        return fc;
      });
    };
    if (!USE_PORTAL) {
      return fetch("data/viviendas.geojson?v=18").then(function (r) { return r.json(); }).then(withOverrides);
    }
    const loadingP = document.querySelector("#loading p");
    if (loadingP) loadingP.textContent = "Cargando viviendas del Portal…";
    const layer = portalLayer(VIVIENDAS_ITEM_ID);
    return queryAllGraphics(layer).then(function (graphics) {
      return withOverrides({
        type: "FeatureCollection",
        features: graphics.map(graphicToViviendaFeature).filter(function (f) {
          const c = f.geometry && f.geometry.coordinates;
          return c && isFinite(c[0]) && isFinite(c[1]);
        })
      });
    });
  }

  function loadMetaFromFeatures(features) {
    let residentes = 0;
    const parcelas = {};
    features.forEach(function (f) {
      const p = f.properties || {};
      residentes += Number(p.residentes) || 0;
      if (p.rc) parcelas[p.rc] = true;
    });
    return {
      viviendas: features.length,
      residentes: residentes,
      parcelas: Object.keys(parcelas).length,
      fuente: USE_PORTAL ? "portal" : "local"
    };
  }

  function ensurePersonasLayer() {
    if (personasLayer) return Promise.resolve(personasLayer);
    if (!USE_PORTAL) return Promise.resolve(null);
    personasLayer = portalLayer(PERSONAS_ITEM_ID);
    return personasLayer.load().then(function () { return personasLayer; });
  }

  function personFromAttrs(a) {
    return {
      nombre: fieldVal(a, ["nombre"]) || "",
      dni: fieldVal(a, ["dni", "Identificador"]) || null,
      tipo_doc: fieldVal(a, ["tipo_doc", "tipo_do", "Tipo_documento"]) || null,
      sexo: fieldVal(a, ["sexo"]) || "",
      edad: fieldVal(a, ["edad"]),
      anio: fieldVal(a, ["anio"]),
      nacionalidad: fieldVal(a, ["nacionalidad"]) || null
    };
  }

  function loadPeopleByVids(vids) {
    const list = normalizeVids(vids);
    if (!list.length) return Promise.resolve([]);
    if (!USE_PORTAL) {
      return loadPersonasLocal().then(function (db) {
        const people = [];
        list.forEach(function (vid) {
          (db[String(vid)] || []).forEach(function (p) { people.push(p); });
        });
        return people;
      });
    }
    return ensurePersonasLayer().then(function (layer) {
      const chunks = [];
      for (let i = 0; i < list.length; i += 40) chunks.push(list.slice(i, i + 40));
      return Promise.all(chunks.map(function (chunk) {
        const where = chunk.map(function (vid) {
          const n = Number(vid);
          if (!isNaN(n) && String(n) === String(vid)) return "vid = " + n;
          return "vid = '" + String(vid).replace(/'/g, "''") + "'";
        }).join(" OR ");
        return layer.queryFeatures({
          where: where,
          outFields: ["*"],
          returnGeometry: false
        });
      })).then(function (results) {
        const people = [];
        results.forEach(function (res) {
          (res.features || []).forEach(function (g) {
            people.push(personFromAttrs(g.attributes || {}));
          });
        });
        return people;
      });
    });
  }

  function loadPersonasLocal() {
    if (personasCache) return Promise.resolve(personasCache);
    if (personasLoading) return personasLoading;
    personasLoading = fetch("data/personas.json?v=16").then(function (r) { return r.json(); }).then(function (data) {
      personasCache = data || {};
      personasLoading = null;
      return personasCache;
    }).catch(function (err) {
      personasLoading = null;
      throw err;
    });
    return personasLoading;
  }

  function closePadron() {
    const panel = document.getElementById("padronPanel");
    const metaEl = document.getElementById("padronMeta");
    if (panel) panel.hidden = true;
    if (metaEl) {
      metaEl.hidden = true;
      metaEl.innerHTML = "";
    }
    document.body.classList.remove("padron-open");
    currentPadronContext = null;
  }

  function renderPadronPeople(people, body, summary, subEl) {
    people.sort(function (a, b) {
      const ae = a.edad == null ? 999 : a.edad;
      const be = b.edad == null ? 999 : b.edad;
      if (ae !== be) return ae - be;
      return String(a.nombre || "").localeCompare(String(b.nombre || ""), "es");
    });
    const h = people.filter(function (p) { return p.sexo === "H"; }).length;
    const m = people.filter(function (p) { return p.sexo === "M"; }).length;
    const ages = people.map(function (p) { return p.edad; }).filter(function (v) { return v != null && v !== ""; });
    const media = ages.length ? (ages.reduce(function (s, v) { return s + Number(v); }, 0) / ages.length) : null;
    subEl.textContent = people.length
      ? people.length + (people.length === 1 ? " persona empadronada" : " personas empadronadas")
      : "No hay detalle individual para esta vivienda";
    summary.innerHTML =
      "<div class='padron-stat'><b>" + people.length + "</b><span>Total</span></div>" +
      "<div class='padron-stat'><b>" + h + " / " + m + "</b><span>H / M</span></div>" +
      "<div class='padron-stat'><b>" + (media == null ? "—" : media.toLocaleString("es-ES", { maximumFractionDigits: 1 })) + "</b><span>Edad media</span></div>";
    if (!people.length) {
      body.innerHTML = "<p class='hint'>Esta vivienda tiene recuento de residentes, pero no se ha podido vincular el detalle nominal.</p>";
      return;
    }
    body.innerHTML =
      "<table class='padron-table'><thead><tr>" +
      "<th>Nombre</th><th>DNI / Doc.</th><th>Sexo</th><th>Edad</th><th>Nacionalidad</th>" +
      "</tr></thead><tbody>" +
      people.map(function (p) {
        const sex = p.sexo === "H" ? "<i class='sex-dot h'></i>Hombre" : (p.sexo === "M" ? "<i class='sex-dot m'></i>Mujer" : "—");
        const rawDni = String(p.dni || "").trim();
        const tipoDoc = String(p.tipo_doc || "").trim();
        const hasDni = rawDni && rawDni !== "-" && rawDni !== "—" && tipoDoc.toLowerCase() !== "ninguna";
        const doc = hasDni
          ? ((tipoDoc && tipoDoc.toLowerCase() !== "ninguna")
            ? "<span class='doc-type'>" + esc(tipoDoc) + "</span> "
            : "") + esc(rawDni)
          : "—";
        return "<tr><td>" + esc(p.nombre || "—") + "</td><td class='doc-cell'>" + doc + "</td><td>" + sex +
          "</td><td>" + (p.edad == null || p.edad === "" ? "—" : esc(String(p.edad))) + "</td><td>" +
          esc(p.nacionalidad || "—") + "</td></tr>";
      }).join("") +
      "</tbody></table>";
  }

  function renderPadronMeta(meta) {
    const metaEl = document.getElementById("padronMeta");
    if (!metaEl) return;
    const portal = meta && meta.portal
      ? ((meta.portalKind || "Portal") + " " + meta.portal)
      : "";
    const planta = meta && meta.planta && meta.planta !== "Unifamiliar" && meta.planta !== "Sin planta"
      ? meta.planta
      : "";
    const letra = (meta && meta.letra) || "";
    const ref = (meta && meta.ref) || "";
    const items = [
      metaItem("Portal", portal),
      metaItem("Planta", planta),
      metaItem("Puerta / letra", letra),
      metaItem("Ref. catastral", ref)
    ].join("");
    if (!items) {
      metaEl.hidden = true;
      metaEl.innerHTML = "";
      return;
    }
    metaEl.hidden = false;
    metaEl.innerHTML = items;
  }

  function openPadron(vids, metaOrTitle) {
    const panel = document.getElementById("padronPanel");
    const body = document.getElementById("padronBody");
    const summary = document.getElementById("padronSummary");
    const titleEl = document.getElementById("padronTitle");
    const subEl = document.getElementById("padronSub");
    if (!panel) return;
    const meta = typeof metaOrTitle === "string"
      ? { direccion: metaOrTitle }
      : (metaOrTitle || {});
    const title = meta.direccion || "Vivienda";
    currentPadronContext = { vids: vids, meta: meta, title: title };
    titleEl.textContent = title;
    renderPadronMeta(meta);
    subEl.textContent = "Cargando residentes…";
    summary.innerHTML = "";
    body.innerHTML = "<p class='hint'>Cargando padrón…</p>";
    // Cierra el emergente: el padrón es una interfaz aparte.
    if (view && view.popup) view.closePopup();
    setPopupOpen(false);
    panel.hidden = false;
    document.body.classList.add("padron-open");
    loadPeopleByVids(vids).then(function (people) {
      renderPadronPeople(people, body, summary, subEl);
    }).catch(function (err) {
      console.error(err);
      body.innerHTML = "<p class='hint'>No se ha podido consultar el padrón en el Portal. ¿Has iniciado sesión?</p>";
    });
  }

  document.getElementById("btnPadronClose").addEventListener("click", closePadron);
  document.addEventListener("click", function (event) {
    const btn = event.target.closest && event.target.closest("a.btn-padron, .btn-padron");
    if (!btn || btn.classList.contains("is-disabled")) return;
    if (!btn.classList.contains("btn-padron")) return;
    event.preventDefault();
    let vids = normalizeVids(btn.getAttribute("data-vids") || "");
    let meta = {
      direccion: btn.getAttribute("data-title") || btn.getAttribute("title") || "",
      portal: "",
      portalKind: "Portal",
      planta: "",
      letra: "",
      ref: ""
    };
    if (!vids.length) {
      const href = btn.getAttribute("href") || "";
      const m = href.match(/#padron:([^&\s]+)/);
      if (m) {
        const action = resolvePadronAction(m[1]);
        if (action) {
          vids = normalizeVids(action.vids);
          meta = Object.assign({}, meta, action.meta || {});
        }
      }
    }
    if (!vids.length && currentPadronContext) vids = normalizeVids(currentPadronContext.vids);
    if ((!meta.direccion || !meta.ref) && currentPadronContext && currentPadronContext.meta) {
      meta = Object.assign({}, currentPadronContext.meta, meta.direccion ? { direccion: meta.direccion } : {});
    }
    openPadron(vids, meta);
  });

  const boot = USE_PORTAL
    ? ensurePortalSignIn().then(function () {
      const loadingP = document.querySelector("#loading p");
      if (loadingP) loadingP.textContent = "Cargando datos del Portal…";
      return Promise.all([
        loadViviendasCollection(),
        loadLimite(),
        view.when(),
        buildingsLayer.when(),
        parcelasLayer.when().then(function () { parcelasOk = true; }).catch(function () { parcelasOk = false; }),
        ensurePersonasLayer()
      ]);
    })
    : Promise.all([
      fetch("data/meta.json?v=13").then(function (r) { return r.json(); }),
      loadViviendasCollection(),
      loadLimite(),
      view.when(),
      buildingsLayer.when(),
      parcelasLayer.when().then(function () { parcelasOk = true; }).catch(function () { parcelasOk = false; })
    ]);

  boot.then(function (results) {
    let viviendasFc;
    let limiteData;
    if (USE_PORTAL) {
      viviendasFc = results[0];
      limiteData = results[1];
      meta = loadMetaFromFeatures(viviendasFc.features || []);
    } else {
      meta = results[0];
      viviendasFc = results[1];
      limiteData = results[2];
    }
    applyLimite(limiteData);
    const insideFeatures = (viviendasFc.features || []).filter(function (feature) {
      const coords = feature.geometry && feature.geometry.coordinates;
      return coords && insideLimite(coords[0], coords[1]);
    });
    const normal = [];
    const incidenciaFeatures = [];
    insideFeatures.forEach(function (feature) {
      if (feature.properties && feature.properties.incidencia) incidenciaFeatures.push(feature);
      else normal.push(feature);
    });
    // Cañada y otras incidencias: muchas viviendas comparten el centroide de parcela.
    spreadCoincidentFeatures(incidenciaFeatures);
    const split = separateHouses(normal);
    edificios = split.search;
    // Chalets que comparten portal: dentro del polígono catastral (SIT), no espiral.
    return layoutCoincidentUnifamiliares(split.features, edificios).then(function () {
      syncEdificiosCoordsFromFeatures(split.features, edificios);
      incidenciaFeatures.forEach(function (feature) {
        const props = feature.properties;
        const coords = feature.geometry.coordinates;
        edificios.push({
          rc: props.rc,
          ref: props.ref || "",
          lon: coords[0],
          lat: coords[1],
          direccion: props.direccion,
          viviendas: 1,
          residentes: Number(props.residentes) || 0,
          hombres: Number(props.hombres) || 0,
          mujeres: Number(props.mujeres) || 0,
          edad_media: props.edad_media,
          vid: props.vid || props.id,
          vids: [props.vid || props.id].filter(Boolean),
          tipo: "unifamiliar",
          planta: props.planta,
          letra: props.letra || "",
          incidencia: props.incidencia
        });
      });
      edificiosPorRc = split.byParcel;
      censusPoints = split.features.concat(incidenciaFeatures).map(function (feature) {
        const coords = feature.geometry.coordinates;
        const props = feature.properties || {};
        return {
          lon: coords[0],
          lat: coords[1],
          tipo: props.tipo,
          residentes: Number(props.residentes) || 0
        };
      });
      const layers = buildPointLayers(split.features);
      incRenderer3d = {
        type: "simple",
        symbol: new PointSymbol3D({
          symbolLayers: [
            new IconSymbol3DLayer({
              resource: { primitive: "kite" },
              size: 14,
              material: { color: "#c2410c" }
            })
          ]
        })
      };
      incRenderer2d = {
        type: "simple",
        symbol: flatMarker("#c2410c", "diamond", 11)
      };
      if (incidenciaFeatures.length) {
        incidenciaLayer = layerFromUrl("Incidencias", featureUrl(incidenciaFeatures), {
          minScale: MARKER_SCALE,
          labelsVisible: false,
          elevationInfo: { mode: "relative-to-scene", offset: 2, unit: "meters" },
          renderer: incRenderer3d
        });
        layers.push(incidenciaLayer);
        incidenciaFeatures.forEach(function (feature) {
          const coords = feature.geometry.coordinates;
          labelPoints.push({
            lon: coords[0],
            lat: coords[1],
            residentes: feature.properties.residentes,
            kind: "uni"
          });
        });
      }
      map.addMany(layers);
      map.reorder(labelLayer, map.layers.length - 1);
      map.reorder(highlightGroundLayer, map.layers.length - 1);
      map.reorder(highlightLayer, map.layers.length - 1);
      const parcelas = Object.keys(edificiosPorRc).length;
      const extraParcelas = {};
      incidenciaFeatures.forEach(function (feature) {
        const rc = feature.properties && feature.properties.rc;
        if (rc && !edificiosPorRc[rc]) extraParcelas[rc] = true;
      });
      const parcelaCount = parcelas + Object.keys(extraParcelas).length;
      let residentes = 0;
      split.features.concat(incidenciaFeatures).forEach(function (feature) {
        residentes += Number(feature.properties && feature.properties.residentes) || 0;
      });
      const totalViviendas = split.features.length + incidenciaFeatures.length;
      const fmt = function (value) { return value.toLocaleString("es-ES"); };
      document.getElementById("statViviendas").textContent = fmt(totalViviendas);
      document.getElementById("statResidentes").textContent = fmt(residentes);
      document.getElementById("statParcelas").textContent = fmt(parcelaCount);
      return Promise.all(layers.map(function (layer) { return layer.when(); })).then(function () {
        applyViewStyle();
        refreshLabels();
      });
    });
  }).then(function () {
    document.getElementById("loading").classList.add("hidden");
    syncLayout();
    maybeShowIntro();
  }).catch(function (error) {
    console.error(error);
    const msg = (error && (error.message || error.name)) || "";
    document.querySelector("#loading p").textContent = USE_PORTAL
      ? ("No se ha podido cargar el Portal. Inicia sesión con tu usuario de la organización. " + msg).trim()
      : "No se ha podido cargar el visor. Recarga la página.";
  });

  const INTRO_KEY = "residentes-intro-hide-v2";
  const introOverlay = document.getElementById("introOverlay");
  const introHide = document.getElementById("introHide");
  const btnIntroClose = document.getElementById("btnIntroClose");

  function showIntro() {
    introHide.checked = false;
    introOverlay.hidden = false;
  }

  function hideIntro() {
    if (introHide.checked) {
      try { localStorage.setItem(INTRO_KEY, "1"); } catch (err) {}
    }
    introOverlay.hidden = true;
  }

  function maybeShowIntro() {
    let skip = false;
    try { skip = localStorage.getItem(INTRO_KEY) === "1"; } catch (err) {}
    if (!skip) showIntro();
  }

  btnIntroClose.addEventListener("click", hideIntro);
  btnHelp.addEventListener("click", showIntro);
  introOverlay.addEventListener("click", function (event) {
    if (event.target === introOverlay) hideIntro();
  });

  /* ---- Chatbot de prueba (agregados prefijados, sin PII) ---- */
  const chatLog = document.getElementById("chatLog");
  const chatPresets = document.getElementById("chatPresets");
  const chatForm = document.getElementById("chatForm");
  const chatInput = document.getElementById("chatInput");
  const btnChatClose = document.getElementById("btnChatClose");
  let chatStats = null;
  let chatStatsLoading = null;

  const CHAT_PRESETS = [
    { id: "barrio_joven", label: "Barrio más joven" },
    { id: "barrio_viejo", label: "Barrio más envejecido" },
    { id: "longevo", label: "Residente más longevo" },
    { id: "calles_m2030", label: "Top 10 calles · mujeres 20–30" },
    { id: "uni_max", label: "Unifamiliar con más residentes" },
    { id: "extranjeros", label: "¿Cuántos extranjeros hay?" },
    { id: "nacionalidades", label: "¿De qué nacionalidades?" },
    { id: "canada_real", label: "Residentes en Cañada Real" }
  ];

  function fmtNum(n) {
    return Number(n || 0).toLocaleString("es-ES");
  }

  function chatEsc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function appendChat(role, html) {
    if (!chatLog) return;
    const div = document.createElement("div");
    div.className = "chat-bubble " + role;
    div.innerHTML = html;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function loadChatStats() {
    if (chatStats) return Promise.resolve(chatStats);
    if (chatStatsLoading) return chatStatsLoading;
    chatStatsLoading = fetch("data/chat_stats.json?v=3")
      .then(function (r) {
        if (!r.ok) throw new Error("No se pudo cargar chat_stats.json");
        return r.json();
      })
      .then(function (data) {
        chatStats = data;
        chatStatsLoading = null;
        return chatStats;
      })
      .catch(function (err) {
        chatStatsLoading = null;
        throw err;
      });
    return chatStatsLoading;
  }

  function answerChat(id, s) {
    if (id === "barrio_joven" || /barrio.*joven|m[aá]s joven/i.test(id)) {
      const b = s.barrio_mas_joven;
      if (!b) return "No hay datos de edad por barrio.";
      const lines = (s.barrios || []).map(function (x) {
        return "· " + x.nombre + ": " + String(x.edad_media).replace(".", ",") + " años (" + fmtNum(x.residentes) + " res.)";
      });
      return (
        "<strong>" + chatEsc(b.nombre) + "</strong> es el más joven, con edad media de <strong>" +
        chatEsc(String(b.edad_media).replace(".", ",")) + " años</strong>.\n\n" +
        lines.map(chatEsc).join("\n")
      );
    }
    if (id === "barrio_viejo" || /envejec|mayor edad|m[aá]s viej/i.test(id)) {
      const b = s.barrio_mas_envejecido;
      if (!b) return "No hay datos de edad por barrio.";
      return (
        "<strong>" + chatEsc(b.nombre) + "</strong> es el más envejecido, con edad media de <strong>" +
        chatEsc(String(b.edad_media).replace(".", ",")) + " años</strong> " +
        "(" + fmtNum(b.residentes) + " residentes)."
      );
    }
    if (id === "longevo" || /longevo|m[aá]s mayor|edad m[aá]xima/i.test(id)) {
      const L = s.residente_mas_longevo;
      if (!L || L.edad == null) {
        return "No hay dato de edad máxima. Regenera <code>chat_stats.json</code>.";
      }
      const n = Number(L.personas) || 1;
      let msg =
        "La edad máxima en el padrón (dentro del límite municipal) es de <strong>" +
        fmtNum(L.edad) + " años</strong>";
      if (n > 1) {
        msg += " (hay <strong>" + fmtNum(n) + "</strong> personas con esa edad)";
      }
      msg += ".";
      if (L.sexo_predominante) {
        msg += " Sexo: <strong>" + chatEsc(L.sexo_predominante) + "</strong>.";
      }
      if (L.barrio) {
        msg += " Barrio: <strong>" + chatEsc(L.barrio) + "</strong>.";
      }
      if (L.via) {
        msg += " Vía: <strong>" + chatEsc(L.via) + "</strong>.";
      }
      msg += "\n\n<em>Sin nombres ni documentos; solo curiosidad agregada.</em>";
      return msg;
    }
    if (id === "calles_m2030" || /mujeres.*20|20.*30|calles.*mujer/i.test(id)) {
      const rows = s.top_calles_mujeres_20_30 || [];
      if (!rows.length) return "Sin datos para ese filtro.";
      const list = rows.map(function (r, i) {
        return (i + 1) + ". " + chatEsc(r.via) + " — <strong>" + fmtNum(r.mujeres_20_30) + "</strong>";
      }).join("\n");
      return "Las 10 vías con más <strong>mujeres de 20 a 30 años</strong>:\n\n" + list;
    }
    if (id === "uni_max" || /unifamiliar|casa.*resident/i.test(id)) {
      const u = s.unifamiliar_mas_residentes;
      const note = (s.notas && s.notas.unifamiliar) || "";
      if (!u) return "No hay unifamiliares que cumplan el filtro.";
      const top = (s.top_unifamiliares || []).slice(0, 5).map(function (r, i) {
        return (i + 1) + ". " + chatEsc(r.direccion) + " — <strong>" + fmtNum(r.residentes) + "</strong>";
      }).join("\n");
      return (
        "La vivienda unifamiliar con más residentes (sin residencias/colectivos) es:\n\n" +
        "<strong>" + chatEsc(u.direccion) + "</strong> — " + fmtNum(u.residentes) + " residentes.\n\n" +
        "Top 5:\n" + top +
        (note ? "\n\n<em>" + chatEsc(note) + "</em>" : "")
      );
    }
    if (id === "extranjeros" || /extranjer|no espa/i.test(id)) {
      return (
        "Hay <strong>" + fmtNum(s.extranjeros) + "</strong> ciudadanos con nacionalidad extranjera " +
        "(" + chatEsc(String(s.pct_extranjeros).replace(".", ",")) + "% del padrón en el límite municipal).\n" +
        "Total residentes de referencia: " + fmtNum(s.residentes) + "."
      );
    }
    if (id === "nacionalidades" || /nacionalidad/i.test(id)) {
      const rows = s.top_nacionalidades || [];
      const list = rows.slice(0, 12).map(function (r, i) {
        return (i + 1) + ". " + chatEsc(r.nacionalidad) + " — <strong>" + fmtNum(r.residentes) + "</strong>";
      }).join("\n");
      return (
        "Hay <strong>" + fmtNum(s.nacionalidades_distintas) + "</strong> nacionalidades extranjeras distintas.\n" +
        "Principales:\n\n" + list
      );
    }
    if (id === "canada_real" || /ca[nñ]ada/i.test(id)) {
      const c = s.canada_real || {};
      if (!c.residentes && !c.viviendas) {
        return "No hay datos agregados de Cañada Real. Regenera <code>chat_stats.json</code>.";
      }
      return (
        "En <strong>Cañada Real</strong> hay <strong>" + fmtNum(c.residentes) + "</strong> residentes " +
        "en <strong>" + fmtNum(c.viviendas) + "</strong> viviendas " +
        "(según dirección o incidencia con «Cañada Real» / «Cañada Galiana», dentro del límite municipal)."
      );
    }
    return (
      "Prueba una de las preguntas sugeridas. Esta demo solo responde a consultas prefijadas " +
      "(barrios, calles, unifamiliares, extranjeros, Cañada Real)."
    );
  }

  function resolveChatQuery(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    const byId = CHAT_PRESETS.find(function (p) { return p.id === t; });
    if (byId) return byId.id;
    const lower = t.toLowerCase();
    if (/joven/.test(lower) && /barrio/.test(lower)) return "barrio_joven";
    if (/envejec|viejo|mayor/.test(lower) && /barrio/.test(lower)) return "barrio_viejo";
    if (/longevo|m[aá]s mayor|edad m[aá]xima/.test(lower)) return "longevo";
    if (/mujer/.test(lower) && /(20|treinta|calle)/.test(lower)) return "calles_m2030";
    if (/unifamiliar|casa/.test(lower)) return "uni_max";
    if (/nacionalidad/.test(lower)) return "nacionalidades";
    if (/extranjer/.test(lower)) return "extranjeros";
    if (/ca[nñ]ada/.test(lower)) return "canada_real";
    return t;
  }

  function askChat(raw) {
    const key = resolveChatQuery(raw);
    if (!key) return;
    const preset = CHAT_PRESETS.find(function (p) { return p.id === key; });
    appendChat("user", chatEsc(preset ? preset.label : raw));
    loadChatStats()
      .then(function (s) {
        appendChat("bot", answerChat(key, s));
      })
      .catch(function () {
        appendChat("bot", "No se han podido cargar los agregados. Ejecuta <code>python build_chat_stats.py</code> y recarga.");
      });
  }

  function setChatOpen(open) {
    if (!chatPanel || !btnChat) return;
    chatPanel.hidden = !open;
    btnChat.classList.toggle("is-active", open);
    btnChat.setAttribute("aria-pressed", open ? "true" : "false");
    if (!open) {
      if (chatLog) chatLog.innerHTML = "";
      if (chatInput) chatInput.value = "";
      return;
    }
    appendChat(
      "bot",
      "Hola. Puedo responder a unas consultas agregadas del padrón (sin nombres ni documentos).\nElige una pregunta o escribe, por ejemplo: «extranjeros»."
    );
    loadChatStats().catch(function () {});
  }

  if (chatPresets) {
    CHAT_PRESETS.forEach(function (p) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chat-chip";
      btn.textContent = p.label;
      btn.addEventListener("click", function () { askChat(p.id); });
      chatPresets.appendChild(btn);
    });
  }

  if (btnChat) {
    btnChat.addEventListener("click", function () {
      setChatOpen(chatPanel.hidden);
    });
  }
  if (btnChatClose) {
    btnChatClose.addEventListener("click", function () { setChatOpen(false); });
  }
  if (chatForm) {
    chatForm.addEventListener("submit", function (event) {
      event.preventDefault();
      const value = chatInput ? chatInput.value : "";
      if (chatInput) chatInput.value = "";
      askChat(value);
    });
  }

  function layoutPadding() {
    const bar = document.querySelector(".topbar");
    const height = bar ? Math.ceil(bar.getBoundingClientRect().bottom) + 8 : 76;
    const narrow = window.matchMedia("(max-width: 980px)").matches;
    const mobile = isMobileClient();
    return {
      top: height,
      right: mobile ? 6 : (narrow ? 8 : 12),
      bottom: mobile ? 6 : (narrow ? 8 : 12),
      left: mobile ? 6 : (narrow ? 8 : 12)
    };
  }

  function applyPopupLayout() {
    const narrow = window.matchMedia("(max-width: 980px)").matches;
    view.popup.dockEnabled = narrow;
    view.popup.dockOptions = {
      buttonEnabled: false,
      breakpoint: false,
      position: "bottom-center"
    };
  }

  function syncLayout() {
    if (!view || !view.ui) return;
    view.padding = layoutPadding();
    applyPopupLayout();
  }

  window.addEventListener("resize", function () {
    applyMobilePolicy();
    syncLayout();
  });
});
