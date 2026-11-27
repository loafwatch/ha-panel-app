import { reg } from "../registry";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { property, query, state } from "lit/decorators.js";
import type { HomeAssistant } from "../types";
import { tokens } from "../styles";

/**
 * Rain map in the panel's style: the last two hours of rain radar (RainViewer) followed by
 * the next twelve hours of rain from the Met Office UKV 2 km model (via Open-Meteo), over a
 * dark map. Centred on Home Assistant's home zone; nothing location-specific lives in code.
 */

/** Map zoom used for the base map; radar tiles come at RAD_Z (1/8 the resolution). */
const MAP_Z = 10;
const RAD_Z = 7;
const K = 2 ** (MAP_Z - RAD_Z);

interface Frame {
  kind: "radar" | "fc";
  t: number; // ms
  path?: string; // radar tile path
  h?: number; // forecast hour index
}

interface FcPoint {
  x7: number; // position in radar-zoom pixels
  y7: number;
  mm: number[];
}

const worldX = (lon: number, z: number) => ((lon + 180) / 360) * 256 * 2 ** z;
const worldY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256 * 2 ** z;
};
const lonOf = (x: number, z: number) => (x / (256 * 2 ** z)) * 360 - 180;
const latOf = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / (256 * 2 ** z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

/** Rain intensity 0..1 → panel colours: cyan, then purple, pink and finally white for downpours. */
const STOPS: [number, number, number, number, number][] = [
  [0.0, 0, 200, 212, 0.0],
  [0.08, 0, 200, 212, 0.38],
  [0.35, 40, 120, 235, 0.6],
  [0.6, 122, 27, 209, 0.72],
  [0.8, 255, 46, 151, 0.82],
  [1.0, 255, 235, 245, 0.92],
];
function ramp(v: number): [number, number, number, number] {
  if (v <= 0) return [0, 0, 0, 0];
  const x = Math.min(1, v);
  for (let i = 1; i < STOPS.length; i++) {
    const [p1, r1, g1, b1, a1] = STOPS[i];
    const [p0, r0, g0, b0, a0] = STOPS[i - 1];
    if (x <= p1) {
      const f = (x - p0) / (p1 - p0);
      return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f, (a0 + (a1 - a0) * f) * 255];
    }
  }
  return [255, 235, 245, 235];
}
/** mm per hour → 0..1 on a log-ish scale (0.1 mm drizzle ≈ 0.1, 4 mm heavy ≈ 0.7, 16 mm+ = 1). */
const mmToV = (mm: number) => (mm < 0.05 ? 0 : Math.min(1, 0.1 + Math.log2(mm / 0.1) * 0.122));

/** RainViewer's colours → the same 0..1 intensity (blues by darkness, yellow/red heavy). */
function radarV(r: number, g: number, b: number): { v: number; snow: boolean } {
  if (b > r + 30) {
    const l = (r + g + b) / 3;
    return { v: Math.max(0.08, Math.min(0.62, 0.08 + ((215 - l) / 130) * 0.54)), snow: false };
  }
  if (r > 180 && b < 90) return { v: g > 150 ? 0.72 : 0.9, snow: false };
  // beige/tan: snow or sleet
  const l = (r + g + b) / 3;
  return { v: Math.max(0.15, Math.min(0.7, (230 - l) / 140)), snow: true };
}

export class PanelRainmap extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: Boolean }) active = false;
  @property({ type: Number }) latitude?: number;
  @property({ type: Number }) longitude?: number;

  @state() private frames: Frame[] = [];
  @state() private sel = 0;
  @state() private playing = false;
  @state() private err = "";
  @state() private size = { w: 0, h: 0 };
  @query("canvas") private canvas?: HTMLCanvasElement;

  private ro?: ResizeObserver;
  private loadedAt = 0;
  private host = "";
  private fc: FcPoint[] = [];
  private fcTimes: number[] = [];
  /** low-res (radar zoom) grid of nearest forecast point per pixel */
  private nearest?: Int32Array;
  private tileCache = new Map<string, Promise<ImageData | null>>();
  private timer?: number;
  private drawSeq = 0;

  private get home() {
    const z = this.hass?.states["zone.home"]?.attributes;
    const lat = this.latitude ?? z?.latitude;
    const lon = this.longitude ?? z?.longitude;
    return lat != null && lon != null ? { lat: Number(lat), lon: Number(lon) } : undefined;
  }

  /** Visible area in map-zoom pixels. */
  private view() {
    const h = this.home!;
    const cx = worldX(h.lon, MAP_Z);
    const cy = worldY(h.lat, MAP_Z);
    return { x0: cx - this.size.w / 2, y0: cy - this.size.h / 2, cx, cy };
  }

  connectedCallback() {
    super.connectedCallback();
    this.ro = new ResizeObserver((e) => {
      const r = e[0].contentRect;
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (w && h && (w !== this.size.w || h !== this.size.h)) {
        this.size = { w, h };
        this.nearest = undefined;
      }
    });
    this.ro.observe(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.ro?.disconnect();
    window.clearInterval(this.timer);
  }

  protected updated(c: PropertyValues) {
    if (c.has("active") && !this.active) this.stop();
    if (this.active && this.size.w && this.home && Date.now() - this.loadedAt > 20 * 60 * 1000) this.load();
    if (c.has("sel") || c.has("size") || c.has("frames")) this.draw();
  }

  private async load() {
    this.loadedAt = Date.now();
    this.err = "";
    const h = this.home!;
    const frames: Frame[] = [];
    // radar: the last two hours, every 10 minutes
    try {
      const j = await (await fetch("https://api.rainviewer.com/public/weather-maps.json")).json();
      this.host = j.host;
      for (const f of j.radar?.past ?? []) frames.push({ kind: "radar", t: f.time * 1000, path: f.path });
    } catch (e) {
      console.warn("ha-panel-app: radar", e);
    }
    // forecast: Met Office UKV 2 km for the area on screen (plus a margin)
    try {
      const v = this.view();
      const pad = 40;
      const lat1 = latOf(v.y0 - pad, MAP_Z);
      const lat0 = latOf(v.y0 + this.size.h + pad, MAP_Z);
      const lon0 = lonOf(v.x0 - pad, MAP_Z);
      const lon1 = lonOf(v.x0 + this.size.w + pad, MAP_Z);
      const url =
        "https://api.open-meteo.com/v1/forecast?" +
        `bounding_box=${lat0.toFixed(3)},${lon0.toFixed(3)},${lat1.toFixed(3)},${lon1.toFixed(3)}` +
        "&hourly=precipitation&models=ukmo_uk_deterministic_2km&forecast_hours=14&timeformat=unixtime&timezone=GMT";
      const r = await fetch(url);
      const j = await r.json();
      const list: any[] = Array.isArray(j) ? j : [j];
      if (!r.ok || !list[0]?.hourly) throw new Error(j?.reason ?? r.status);
      this.fcTimes = (list[0].hourly.time as number[]).map((t) => t * 1000);
      this.fc = list.map((p) => ({ x7: worldX(p.longitude, RAD_Z), y7: worldY(p.latitude, RAD_Z), mm: p.hourly.precipitation.map((x: number | null) => x ?? 0) }));
      this.nearest = undefined;
      const now = Date.now();
      // hourly totals are for the hour ending at the timestamp; show each hour that ends after now
      this.fcTimes.forEach((t, i) => {
        if (t > now && t <= now + 13 * 3600_000) frames.push({ kind: "fc", t, h: i });
      });
    } catch (e) {
      console.warn("ha-panel-app: rain forecast", e);
    }
    if (!frames.length) {
      this.err = "Couldn't load the rain map";
      return;
    }
    const lastRadar = frames.map((f) => f.kind).lastIndexOf("radar");
    this.frames = frames;
    this.sel = lastRadar >= 0 ? lastRadar : 0;
  }

  // ---------- drawing ----------

  /** Low-res grid (radar-zoom pixels) covering the view. */
  private grid() {
    const v = this.view();
    const ox = Math.floor(v.x0 / K) - 1;
    const oy = Math.floor(v.y0 / K) - 1;
    const w = Math.ceil(this.size.w / K) + 3;
    const h = Math.ceil(this.size.h / K) + 3;
    return { ox, oy, w, h, v };
  }

  private buildNearest(g: { ox: number; oy: number; w: number; h: number }) {
    const n = new Int32Array(g.w * g.h).fill(-1);
    const pts = this.fc;
    if (!pts.length) return n;
    // bucket the points so each pixel only checks its neighbourhood
    const cell = 2;
    const buckets = new Map<string, number[]>();
    pts.forEach((p, i) => {
      const k = `${Math.floor(p.x7 / cell)},${Math.floor(p.y7 / cell)}`;
      (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i);
    });
    for (let y = 0; y < g.h; y++)
      for (let x = 0; x < g.w; x++) {
        const px = g.ox + x + 0.5;
        const py = g.oy + y + 0.5;
        const bx = Math.floor(px / cell);
        const by = Math.floor(py / cell);
        let best = -1;
        let bd = 4; // ignore anything more than ~2 low-res px away (outside the model area)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            for (const i of buckets.get(`${bx + dx},${by + dy}`) ?? []) {
              const d = (pts[i].x7 - px) ** 2 + (pts[i].y7 - py) ** 2;
              if (d < bd) {
                bd = d;
                best = i;
              }
            }
        n[y * g.w + x] = best;
      }
    return n;
  }

  private radarTile(path: string, x: number, y: number): Promise<ImageData | null> {
    const key = `${path}/${x}/${y}`;
    let p = this.tileCache.get(key);
    if (!p) {
      p = new Promise((res) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          try {
            const c = document.createElement("canvas");
            c.width = c.height = 256;
            const g = c.getContext("2d")!;
            g.drawImage(img, 0, 0);
            res(g.getImageData(0, 0, 256, 256));
          } catch {
            res(null);
          }
        };
        img.onerror = () => res(null);
        img.src = `${this.host}${path}/256/${RAD_Z}/${x}/${y}/2/1_1.png`;
      });
      this.tileCache.set(key, p);
      if (this.tileCache.size > 80) this.tileCache.delete(this.tileCache.keys().next().value!);
    }
    return p;
  }

  private async draw() {
    const cv = this.canvas;
    const f = this.frames[this.sel];
    if (!cv || !f || !this.size.w || !this.home) return;
    const seq = ++this.drawSeq;
    const g = this.grid();
    const low = new ImageData(g.w, g.h);
    const d = low.data;
    if (f.kind === "fc") {
      if (!this.nearest) this.nearest = this.buildNearest(g);
      const n = this.nearest;
      for (let i = 0; i < n.length; i++) {
        if (n[i] < 0) continue;
        const [r, gg, b, a] = ramp(mmToV(this.fc[n[i]].mm[f.h!]));
        d[i * 4] = r;
        d[i * 4 + 1] = gg;
        d[i * 4 + 2] = b;
        d[i * 4 + 3] = a;
      }
    } else {
      const tx0 = Math.floor(g.ox / 256);
      const ty0 = Math.floor(g.oy / 256);
      const tx1 = Math.floor((g.ox + g.w) / 256);
      const ty1 = Math.floor((g.oy + g.h) / 256);
      const tiles: Promise<void>[] = [];
      for (let ty = ty0; ty <= ty1; ty++)
        for (let tx = tx0; tx <= tx1; tx++)
          tiles.push(
            this.radarTile(f.path!, tx, ty).then((im) => {
              if (!im) return;
              for (let y = 0; y < g.h; y++) {
                const wy = g.oy + y - ty * 256;
                if (wy < 0 || wy >= 256) continue;
                for (let x = 0; x < g.w; x++) {
                  const wx = g.ox + x - tx * 256;
                  if (wx < 0 || wx >= 256) continue;
                  const s = (wy * 256 + wx) * 4;
                  if (im.data[s + 3] < 20) continue;
                  const { v, snow } = radarV(im.data[s], im.data[s + 1], im.data[s + 2]);
                  const o = (y * g.w + x) * 4;
                  const c = snow ? [235, 225, 255, (0.35 + v * 0.5) * 255] : ramp(v);
                  d[o] = c[0];
                  d[o + 1] = c[1];
                  d[o + 2] = c[2];
                  d[o + 3] = c[3];
                }
              }
            }),
          );
      await Promise.all(tiles);
    }
    if (seq !== this.drawSeq) return; // a newer frame was asked for meanwhile
    const off = document.createElement("canvas");
    off.width = g.w;
    off.height = g.h;
    off.getContext("2d")!.putImageData(low, 0, 0);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = this.size.w * dpr;
    cv.height = this.size.h * dpr;
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.filter = "blur(3px)";
    ctx.drawImage(off, g.ox * K - g.v.x0, g.oy * K - g.v.y0, g.w * K, g.h * K);
  }

  // ---------- playback ----------

  private toggle() {
    if (this.playing) return this.stop();
    this.playing = true;
    if (this.sel >= this.frames.length - 1) this.sel = 0;
    this.timer = window.setInterval(() => {
      if (this.sel >= this.frames.length - 1) {
        this.stop();
        return;
      }
      this.sel++;
    }, 700);
  }

  private stop() {
    this.playing = false;
    window.clearInterval(this.timer);
  }

  // ---------- render ----------

  render() {
    const h = this.home;
    if (!h) return html`<div class="msg">Set your home location in Home Assistant to see the rain map.</div>`;
    const tiles = [];
    if (this.size.w) {
      const v = this.view();
      const tx0 = Math.floor(v.x0 / 256);
      const ty0 = Math.floor(v.y0 / 256);
      const tx1 = Math.floor((v.x0 + this.size.w) / 256);
      const ty1 = Math.floor((v.y0 + this.size.h) / 256);
      for (let ty = ty0; ty <= ty1; ty++)
        for (let tx = tx0; tx <= tx1; tx++) {
          const s = "abcd"[(tx + ty) & 3];
          tiles.push(
            html`<img class="t" alt="" src="https://${s}.basemaps.cartocdn.com/dark_all/${MAP_Z}/${tx}/${ty}.png" style="left:${tx * 256 - v.x0}px;top:${ty * 256 - v.y0}px" />`,
          );
        }
    }
    const f = this.frames[this.sel];
    const nowR = this.frames.map((x) => x.kind).lastIndexOf("radar");
    const label = !f
      ? this.err || "Loading rain map…"
      : f.kind === "radar"
        ? this.sel === nowR
          ? "Radar · now"
          : `Radar · ${new Date(f.t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
        : `Forecast · ${new Date(f.t - 3600_000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}–${new Date(f.t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
    const split = nowR >= 0 && this.frames.length > 1 ? ((nowR + 0.5) / (this.frames.length - 1)) * 100 : -1;
    return html`
      <div class="base">${tiles}</div>
      <canvas></canvas>
      <div class="home"><i></i></div>
      <div class="legend"><span>Light</span><b></b><span>Heavy</span></div>
      <div class="bar">
        <button class="play" aria-label=${this.playing ? "Pause" : "Play"} @click=${() => this.toggle()} ?disabled=${!this.frames.length}>
          <ha-icon icon=${this.playing ? "mdi:pause" : "mdi:play"}></ha-icon>
        </button>
        <div class="tl">
          <div class="lbl ${f?.kind ?? ""}">${label}</div>
          ${this.frames.length > 1
            ? html`<input type="range" min="0" max=${this.frames.length - 1} .value=${String(this.sel)} style="--split:${split}%"
                @input=${(e: Event) => {
                  this.stop();
                  this.sel = Number((e.target as HTMLInputElement).value);
                }} />`
            : nothing}
        </div>
      </div>
      <div class="attr">© OpenStreetMap · CARTO · RainViewer · Met Office UKV via Open-Meteo</div>
    `;
  }

  static styles = [
    tokens,
    css`
      :host {
        display: block;
        position: relative;
        overflow: hidden;
        border-radius: var(--radius-sm, 14px);
        background: #0d0a16;
        min-height: 280px;
      }
      .base {
        position: absolute;
        inset: 0;
        /* tint the dark map towards the panel's purple */
        filter: sepia(0.6) hue-rotate(215deg) saturate(1.8) brightness(0.85) contrast(1.05);
      }
      .t {
        position: absolute;
        width: 256px;
        height: 256px;
        user-select: none;
        pointer-events: none;
      }
      canvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
      }
      .home {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 14px;
        height: 14px;
        margin: -7px 0 0 -7px;
        border-radius: 50%;
        background: var(--pk);
        box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.85), 0 0 14px var(--pk);
      }
      .home i {
        position: absolute;
        inset: -10px;
        border-radius: 50%;
        border: 2px solid var(--pk);
        animation: ping 2.4s ease-out infinite;
      }
      @keyframes ping {
        from {
          transform: scale(0.4);
          opacity: 0.9;
        }
        to {
          transform: scale(2.2);
          opacity: 0;
        }
      }
      .legend {
        position: absolute;
        top: 12px;
        left: 12px;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-radius: 999px;
        background: rgba(13, 10, 22, 0.72);
        backdrop-filter: blur(6px);
        color: #cfc6e6;
        font: 600 12px var(--font);
      }
      .legend b {
        width: 90px;
        height: 8px;
        border-radius: 4px;
        background: linear-gradient(90deg, rgba(0, 200, 212, 0.5), #2878eb, #7a1bd1, #ff2e97, #ffebf5);
      }
      .bar {
        position: absolute;
        left: 12px;
        right: 12px;
        bottom: 12px;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 14px 8px 8px;
        border-radius: 999px;
        background: rgba(13, 10, 22, 0.78);
        backdrop-filter: blur(8px);
      }
      .play {
        flex: none;
        display: grid;
        place-items: center;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        border: 0;
        background: var(--grad);
        color: #fff;
        cursor: pointer;
        --mdc-icon-size: 26px;
      }
      .tl {
        flex: 1;
        min-width: 0;
      }
      .lbl {
        color: #fff;
        font: 600 14px var(--font);
        margin-bottom: 4px;
      }
      .lbl.fc {
        color: #ff8ad8;
      }
      input[type="range"] {
        width: 100%;
        height: 6px;
        margin: 0;
        appearance: none;
        -webkit-appearance: none;
        border-radius: 3px;
        background: linear-gradient(90deg, rgba(0, 200, 212, 0.55) var(--split), rgba(255, 46, 151, 0.55) var(--split));
        outline: none;
      }
      input[type="range"]::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 0 10px var(--pk);
      }
      .attr {
        position: absolute;
        right: 14px;
        bottom: 72px;
        color: rgba(255, 255, 255, 0.45);
        font: 10px var(--font);
        pointer-events: none;
      }
      .msg {
        padding: 24px;
        color: var(--text-2);
      }
    `,
  ];
}

reg("panel-rainmap", PanelRainmap);
