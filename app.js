require([
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
  let uniRenderer3d = null;
  let uniRenderer2d = null;
  let pluriRenderer3d = null;
  let pluriRenderer2d = null;
  let incRenderer3d = null;
  let incRenderer2d = null;

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

  function compareUnidad(a, b) {
    const byFloor = plantaOrder(a.planta) - plantaOrder(b.planta);
    if (byFloor) return byFloor;
    const byAddress = (a.direccion || "").localeCompare(b.direccion || "", "es");
    if (byAddress) return byAddress;
    return (a.letra || "").localeCompare(b.letra || "", "es");
  }

  function buildPointLayers(features) {
    const uni = [];
    const unidadesPorRc = {};
    features.forEach(function (feature) {
      const props = feature.properties || {};
      if (props.tipo === "plurifamiliar") {
        const list = unidadesPorRc[props.rc] || (unidadesPorRc[props.rc] = []);
        list.push({
          direccion: props.direccion,
          planta: props.planta,
          letra: props.letra,
          residentes: props.residentes,
          ref: props.ref || ""
        });
        return;
      }
      uni.push(feature);
    });

    edificios.forEach(function (building) {
      building.unidades = (unidadesPorRc[building.rc] || []).slice().sort(compareUnidad);
    });

    const pluri = [];
    edificios.forEach(function (building) {
      if (building.tipo !== "plurifamiliar") return;
      if (building.lon == null || building.lat == null) return;
      pluri.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [building.lon, building.lat, 6] },
        properties: {
          rc: building.rc,
          direccion: building.direccion,
          residentes: building.residentes,
          viviendas: building.viviendas,
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

  const map = new Map({
    basemap: basemaps[0],
    ground: "world-elevation",
    layers: [maskLayer, parcelasLayer, buildingsLayer, drawLayer, labelLayer]
  });

  const homeCamera = {
    position: { longitude: -3.526, latitude: 40.332, z: 2400 },
    heading: 18,
    tilt: 58
  };

  let view = new SceneView({
    container: "viewDiv",
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
    popup: {
      autoOpenEnabled: false,
      autoCloseEnabled: false,
      dockEnabled: false,
      collapseEnabled: false
    },
    ui: { padding: { top: 76, right: 12, bottom: 12, left: 12 } }
  });

  view.popup.autoCloseEnabled = false;
  sceneView = view;

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
  const btnView = document.getElementById("btnView");

  function detachChrome() {
    [homeWidget, btnView, basemapExpand, btnArea].forEach(function (item) {
      view.ui.remove(item);
    });
  }

  function mountChrome() {
    homeWidget.view = view;
    basemapGallery.view = view;
    basemapExpand.view = view;
    basemapExpand.expanded = false;
    view.ui.add([homeWidget, btnView, basemapExpand, btnArea], "top-right");
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
    btnView.textContent = flat ? "3D" : "2D";
    btnView.title = flat ? "Vista 3D" : "Vista 2D";
    btnView.setAttribute("aria-label", btnView.title);
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
      if (areaMode) return;
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
      identifyFromPointer(event);
    }));
    viewHandles.push(view.watch("stationary", function (stationary) {
      if (stationary) refreshLabels();
    }));
  }

  function setMode(nextMode) {
    const goingFlat = nextMode === "2d";
    if (switching) return;
    if (goingFlat && view.type === "2d") return;
    if (!goingFlat && view.type === "3d") return;
    switching = true;
    if (areaMode) {
      drawLayer.removeAll();
      areaVertices = [];
      stopAreaDraw();
      areaPanel.hidden = true;
    }
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
        mapView = new MapView({
          container: "viewDiv",
          map: map,
          center: center,
          zoom: zoom,
          popupEnabled: false,
          popup: {
            autoOpenEnabled: false,
            autoCloseEnabled: false,
            dockEnabled: false,
            collapseEnabled: false
          },
          ui: { padding: { top: 76, right: 12, bottom: 12, left: 12 } }
        });
      } else {
        mapView.map = map;
        mapView.container = "viewDiv";
        if (viewpoint) mapView.viewpoint = viewpoint;
      }
      view = mapView;
    } else {
      sceneView.map = map;
      sceneView.container = "viewDiv";
      view = sceneView;
    }

    view.popup.autoCloseEnabled = false;
    mountChrome();
    bindView();
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
      switching = false;
    }).catch(function (err) {
      switching = false;
      console.error(err);
    });
  }

  mountChrome();
  bindView();
  applyViewStyle();
  btnView.addEventListener("click", function () {
    setMode(view.type === "3d" ? "2d" : "3d");
  });
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

  function startAreaDraw() {
    view.closePopup();
    basemapExpand.expanded = false;
    drawLayer.removeAll();
    areaVertices = [];
    startClickAt = 0;
    clearAreaFigures();
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

  function row(label, value) {
    return "<p><span>" + esc(label) + "</span><b>" + esc(value) + "</b></p>";
  }

  function catastroUrl(rc) {
    const ref = String(rc || "").replace(/\s/g, "").toUpperCase();
    if (ref.length < 14) return "";
    return "https://www1.sedecatastro.gob.es/Cartografia/mapa.aspx?refcat=" + encodeURIComponent(ref);
  }

  function catastroAnchor(rc) {
    const url = catastroUrl(rc);
    if (!url) return "";
    return (
      "<a class='catastro-link' href=\"" + esc(url) +
      "\" target=\"_blank\" rel=\"noopener noreferrer\">Ver en Catastro</a>"
    );
  }

  function catastroLink(rc) {
    const anchor = catastroAnchor(rc);
    if (!anchor) return "";
    return "<p class='popup-link'>" + anchor + "</p>";
  }

  function catastroBlock(rc) {
    const ref = String(rc || "").trim();
    const url = catastroUrl(ref);
    if (!url) return "";
    return row("Ref. catastral", ref) + catastroLink(ref);
  }

  const catastroCache = {};
  let popupSeq = 0;

  function catastroRef(value) {
    return String(value || "").replace(/\s/g, "").toUpperCase();
  }

  function plantaCatastro(code) {
    const text = String(code || "").trim().toUpperCase();
    if (!text || text === ".") return "";
    if (text === "00" || text === "BJ") return "Baja";
    if (text === "-1" || text === "SS") return "Sótano";
    if (text === "-2") return "Sótano -2";
    if (text.charAt(0) === "+") return text;
    const n = parseInt(text, 10);
    if (!isNaN(n)) return String(n);
    return text;
  }

  function asList(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  function metros(value) {
    const text = String(value == null ? "" : value).trim();
    if (!text) return "";
    if (/^\d+$/.test(text)) return Number(text).toLocaleString("es-ES") + " m²";
    return text + " m²";
  }

  function catastroHtml(data) {
    const result = data && data.consulta_dnprcResult;
    if (!result) return "<p class='popup-note'>Catastro no ha devuelto datos.</p>";
    const bico = result.bico;
    const bi = bico && bico.bi;
    if (!bi) {
      const error = asList(result.lerr)[0];
      const text = (error && (error.des || (error.err && error.err.des))) || "Sin datos de este inmueble";
      return "<p class='popup-note'>" + esc(text) + "</p>";
    }
    const debi = bi.debi || {};
    const finca = bico.finca || {};
    const lines = [];
    if (debi.luso) lines.push(row("Uso", debi.luso));
    if (debi.sfc) lines.push(row("Superficie", metros(debi.sfc)));
    if (debi.ant) lines.push(row("Antigüedad", debi.ant));
    if (finca.dff && finca.dff.ss) lines.push(row("Parcela", metros(finca.dff.ss)));
    const units = asList(bico.lcons);
    const shown = units.slice(0, 10);
    const unitHtml = shown.map(function (unit) {
      const loint = (((unit.dt || {}).lourb || {}).loint) || {};
      const planta = plantaCatastro(loint.pt);
      const label = [planta, unit.lcd].filter(Boolean).join(" · ");
      const surface = unit.dfcons && unit.dfcons.stl != null ? metros(unit.dfcons.stl) : "";
      return "<li><span>" + esc(label || "Unidad") + "</span><b>" + esc(surface) + "</b></li>";
    }).join("");
    const more = units.length > shown.length
      ? "<p class='popup-note'>Y " + (units.length - shown.length) + " unidades más.</p>"
      : "";
    return (
      "<p class='breakdown-title'>Catastro</p>" +
      lines.join("") +
      (unitHtml ? "<ul class='breakdown'>" + unitHtml + "</ul>" : "") +
      more
    );
  }

  function applyCatastro(seq, html) {
    if (seq !== popupSeq) return;
    const slot = document.querySelector(".popup-card .catastro-extra");
    if (slot) slot.innerHTML = html;
  }

  function catastroSlot(ref) {
    const key = catastroRef(ref);
    if (key.length < 18) return "";
    const seq = ++popupSeq;
    if (catastroCache[key]) {
      return "<div class='catastro-extra'>" + catastroCache[key] + "</div>";
    }
    fetch(
      "https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/COVCCallejero.svc/json/Consulta_DNPRC?RefCat=" +
      encodeURIComponent(key)
    ).then(function (response) {
      if (!response.ok) throw new Error("catastro");
      return response.json();
    }).then(function (data) {
      const html = catastroHtml(data);
      catastroCache[key] = html;
      applyCatastro(seq, html);
    }).catch(function () {
      applyCatastro(seq, "<p class='popup-note'>No se ha podido consultar Catastro.</p>");
    });
    return "<div class='catastro-extra'><p class='popup-note'>Consultando Catastro…</p></div>";
  }

  function dwellingHtml(attrs) {
    const letra = attrs.letra ? attrs.letra : "—";
    return (
      "<div class='popup-card'>" +
      (attrs.incidencia ? "<p class='popup-note incidencia'>" + esc(attrs.incidencia) + "</p>" : "") +
      row("Planta", attrs.planta || "—") +
      row("Letra", letra) +
      row("Residentes", residentesTxt(attrs.residentes)) +
      row("Ref. catastral", attrs.ref || attrs.rc || "—") +
      catastroSlot(attrs.ref || attrs.rc) +
      catastroLink(attrs.ref || attrs.rc) +
      "</div>"
    );
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
    list.forEach(function (unidad) { addresses[unidad.direccion || ""] = true; });
    const showAddress = Object.keys(addresses).length > 1;
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
        const rows = group.unidades.slice().sort(function (a, b) {
          return (a.letra || "").localeCompare(b.letra || "", "es");
        }).map(function (unidad) {
          const ref = String(unidad.ref || "").trim();
          const label = unidad.letra ? unidad.letra + " · " + (ref || "Sin referencia") : (ref || "Sin referencia");
          return (
            "<li><span class='floor-ref'>" + esc(label) + "</span>" +
            "<b class='floor-res'>" + esc(residentesTxt(unidad.residentes)) + "</b>" +
            catastroAnchor(ref) + "</li>"
          );
        }).join("");
        return (
          "<details><summary><span class='floor-label'>" + esc(title) + "</span>" +
          "<span class='floor-meta'><b>" + esc(residentesTxt(residentes)) + "</b> · " + esc(viviendas) + "</span></summary>" +
          "<ul>" + rows + "</ul></details>"
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
      return (
        "<div class='popup-card'>" +
        row("Viviendas", viviendas === 1 ? "1 unifamiliar" : viviendas + " unifamiliares") +
        row("Residentes", residentesTxt(building.residentes)) +
        catastroBlock(building.rc) +
        "<p class='popup-note'>Varias viviendas unifamiliares en la misma parcela.</p>" +
        "<ul class='breakdown'>" +
        casas.map(function (casa) {
          return "<li><span>" + esc(casa.direccion) + "</span><b>" + esc(residentesTxt(casa.residentes)) + "</b></li>";
        }).join("") +
        "</ul></div>"
      );
    }
    if (building.tipo === "unifamiliar" || building.viviendas === 1) {
      return (
        "<div class='popup-card'>" +
        (building.incidencia ? "<p class='popup-note incidencia'>" + esc(building.incidencia) + "</p>" : "") +
        row("Planta", building.planta || "—") +
        row("Letra", building.letra || "—") +
        row("Residentes", residentesTxt(building.residentes)) +
        row("Ref. catastral", building.ref || building.rc || "—") +
        catastroSlot(building.ref || building.rc) +
        catastroLink(building.ref || building.rc) +
        "</div>"
      );
    }
    const viviendas = Number(building.viviendas);
    const list = building.unidades || [];
    return (
      "<div class='popup-card'>" +
      row("Viviendas", viviendas === 1 ? "1 vivienda" : viviendas + " viviendas") +
      row("Residentes", residentesTxt(building.residentes)) +
      row("Media", mediaTxt(building.residentes, viviendas)) +
      floorsHtml(list) +
      "</div>"
    );
  }

  function openPopup(mapPoint, title, html) {
    view.openPopup({
      location: mapPoint,
      title: title,
      content: html
    });
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
        const building = edificiosPorRc[attrs.rc];
        if (attrs.incidencia || attrs.tipo !== "plurifamiliar" || !building) {
          openPopup(graphicHit.mapPoint || ground, attrs.direccion, dwellingHtml(attrs));
        } else {
          openPopup(graphicHit.mapPoint || ground, building.direccion, buildingHtml(building));
        }
        return null;
      }
      if (!parcelasOk) return null;
      return parcelasLayer.queryFeatures({
        geometry: ground,
        spatialRelationship: "intersects",
        outFields: ["REFCAT"],
        returnGeometry: false
      });
    }).then(function (result) {
      if (seq !== identifySeq || !result || !result.features || !result.features.length) return;
      const rc = (result.features[0].attributes.REFCAT || "").trim();
      const building = edificiosPorRc[rc];
      if (!building) return;
      openPopup(ground, building.direccion, buildingHtml(building));
    }).catch(function (err) {
      console.error(err);
    });
  }

  const clickSlop = 18;
  let press = null;

  let lastIdentifyAt = 0;

  function identifyFromPointer(event) {
    if (areaMode || Date.now() < ignoreIdentifyUntil) return;
    const now = Date.now();
    if (now - lastIdentifyAt < 450) return;
    lastIdentifyAt = now;
    const mapPoint = event.mapPoint || view.toMap({ x: event.x, y: event.y });
    if (!mapPoint) return;
    identify(event.x, event.y, mapPoint);
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

  function showBuilding(building) {
    const point = new Point({
      longitude: building.lon,
      latitude: building.lat
    });
    openPopup(point, building.direccion, buildingHtml(building));
    flyTo(building.lon, building.lat).catch(function (err) {
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
    showBuilding(row.building);
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
      const aptFeatures = [];
      Object.keys(byAddr).forEach(function (addr) {
        const group = byAddr[addr];
        if (group.length === 1) houseFeatures.push(group[0]);
        else group.forEach(function (feature) { aptFeatures.push(feature); });
      });

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
          tipo: "unifamiliar",
          planta: props.planta,
          letra: props.letra || ""
        });
      });

      if (aptFeatures.length) {
        let lon = 0;
        let lat = 0;
        let residentes = 0;
        const dirs = [];
        aptFeatures.forEach(function (feature) {
          const coords = feature.geometry.coordinates;
          lon += coords[0];
          lat += coords[1];
          residentes += Number(feature.properties.residentes) || 0;
          feature.properties.tipo = "plurifamiliar";
          if (dirs.indexOf(feature.properties.direccion) === -1) dirs.push(feature.properties.direccion);
          kept.push(feature);
        });
        byParcel[rc] = {
          rc: rc,
          lon: lon / aptFeatures.length,
          lat: lat / aptFeatures.length,
          direccion: dirs.slice(0, 3).join(" · "),
          viviendas: aptFeatures.length,
          residentes: residentes,
          tipo: "plurifamiliar",
          planta: "",
          letra: ""
        };
        search.push(byParcel[rc]);
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
            residentes: Number(feature.properties.residentes) || 0
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

  Promise.all([
    fetch("data/meta.json?v=2").then(function (r) { return r.json(); }),
    fetch("data/viviendas.geojson?v=4").then(function (r) { return r.json(); }),
    loadLimite(),
    view.when(),
    buildingsLayer.when(),
    parcelasLayer.when().then(function () {
      parcelasOk = true;
    }).catch(function () {
      parcelasOk = false;
    })
  ]).then(function (results) {
    applyLimite(results[2]);
    meta = results[0];
    const insideFeatures = (results[1].features || []).filter(function (feature) {
      const coords = feature.geometry && feature.geometry.coordinates;
      return coords && insideLimite(coords[0], coords[1]);
    });
    const normal = [];
    const incidenciaFeatures = [];
    insideFeatures.forEach(function (feature) {
      if (feature.properties && feature.properties.incidencia) incidenciaFeatures.push(feature);
      else normal.push(feature);
    });
    const split = separateHouses(normal);
    edificios = split.search;
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
  }).then(function () {
    document.getElementById("loading").classList.add("hidden");
    syncLayout();
    maybeShowIntro();
  }).catch(function (error) {
    console.error(error);
    document.querySelector("#loading p").textContent =
      "No se ha podido cargar el visor. Recarga la página.";
  });

  const INTRO_KEY = "residentes-intro-hide";
  const introOverlay = document.getElementById("introOverlay");
  const introHide = document.getElementById("introHide");
  const btnIntroClose = document.getElementById("btnIntroClose");
  const btnHelp = document.getElementById("btnHelp");

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

  function layoutPadding() {
    const bar = document.querySelector(".topbar");
    const height = bar ? Math.ceil(bar.getBoundingClientRect().bottom) + 8 : 76;
    const narrow = window.matchMedia("(max-width: 980px)").matches;
    return {
      top: height,
      right: narrow ? 8 : 12,
      bottom: narrow ? 8 : 12,
      left: narrow ? 8 : 12
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
    syncLayout();
  });
});
