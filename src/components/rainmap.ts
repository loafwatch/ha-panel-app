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

/** Map zoom (base map) can be 9–11; radar tiles always come at RAD_Z and are scaled up. */
const Z_MIN = 9;
const Z_MAX = 11;
const RAD_Z = 7;
/** Forecast frames every 15 minutes, eased between the model's hourly values. */
const FC_STEP = 15 * 60_000;
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/";

interface Frame {
  kind: "radar" | "fc";
  t: number; // ms
  path?: string; // radar tile path
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
  // the faint, semi-transparent beige is the lightest drizzle / returns
  return { v: 0, snow: true };
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
  @state() private z = 10;
  @query("canvas") private canvas?: HTMLCanvasElement;

  private ro?: ResizeObserver;
  private loadedAt = 0;
  private radar: Frame[] = [];
  /** forecast per zoom level (each covers that zoom's view) */
  private fcCache = new Map<number, { at: number; pts: FcPoint[]; times: number[] }>();
  private host = "";
  private fc: FcPoint[] = [];
  private fcTimes: number[] = [];
  /** low-res (radar zoom) grid of nearest forecast point per pixel */
  private nearest?: { idx: Int32Array; wt: Float32Array; N: number };
  private tileCache = new Map<string, Promise<ImageData | null>>();
  private timer?: number;
  private drawSeq = 0;

  private get K() {
    return 2 ** (this.z - RAD_Z);
  }

  private get home() {
    const z = this.hass?.states["zone.home"]?.attributes;
    const lat = this.latitude ?? z?.latitude;
    const lon = this.longitude ?? z?.longitude;
    return lat != null && lon != null ? { lat: Number(lat), lon: Number(lon) } : undefined;
  }

  /** Visible area in map-zoom pixels. */
  private view() {
    const h = this.home!;
    const cx = worldX(h.lon, this.z);
    const cy = worldY(h.lat, this.z);
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
    if (this.active && this.size.w && this.home) {
      if (Date.now() - this.loadedAt > 60 * 60 * 1000) this.load();
      else if (c.has("z")) this.useZoom();
    }
    if (c.has("sel") || c.has("size") || c.has("frames") || c.has("z")) this.draw();
  }

  private async load() {
    this.loadedAt = Date.now();
    this.fcCache.clear();
    this.err = "";
    // radar: the last two hours, every 10 minutes
    try {
      const j = await (await fetch("https://api.rainviewer.com/public/weather-maps.json")).json();
      this.host = j.host;
      this.radar = (j.radar?.past ?? []).map((f: any) => ({ kind: "radar", t: f.time * 1000, path: f.path }) as Frame);
    } catch (e) {
      this.radar = [];
      console.warn("ha-panel-app: radar", e);
    }
    await this.useZoom(true);
  }

  /** Make sure the forecast for this zoom is loaded, then rebuild the timeline. */
  private async useZoom(first = false) {
    const z = this.z;
    let fc = this.fcCache.get(z);
    if (!fc) {
      try {
        fc = await this.fetchForecast();
        this.fcCache.set(z, fc);
      } catch (e) {
        console.warn("ha-panel-app: rain forecast", e);
      }
    }
    if (z !== this.z) return; // zoomed again meanwhile
    this.fc = fc?.pts ?? [];
    this.fcTimes = fc?.times ?? [];
    this.nearest = undefined;
    const frames: Frame[] = [...this.radar];
    if (this.fcTimes.length > 1) {
      // hourly values are totals for the hour ending at each timestamp: treat them as the
      // rate at the middle of that hour and ease between them every 15 minutes
      const c0 = this.fcTimes[0] - 1800_000;
      const c1 = this.fcTimes[this.fcTimes.length - 1] - 1800_000;
      const now = Date.now();
      for (let t = Math.ceil(now / FC_STEP) * FC_STEP; t <= Math.min(c1, now + 12 * 3600_000); t += FC_STEP)
        if (t >= c0) frames.push({ kind: "fc", t });
    }
    if (!frames.length) {
      this.err = "Couldn't load the rain map";
      return;
    }
    const keepT = this.frames[this.sel]?.t;
    this.frames = frames;
    if (first || keepT == null) {
      const lastRadar = frames.map((f) => f.kind).lastIndexOf("radar");
      this.sel = lastRadar >= 0 ? lastRadar : 0;
    } else {
      // stay on (about) the same time after zooming
      let best = 0;
      frames.forEach((f, i) => Math.abs(f.t - keepT) < Math.abs(frames[best].t - keepT) && (best = i));
      this.sel = best;
    }
    this.draw();
  }

  /** Met Office UKV 2 km for the area on screen (plus a margin). */
  private async fetchForecast() {
    const v = this.view();
    const z = this.z;
    const pad = 24;
    const lat1 = latOf(v.y0 - pad, z);
    const lat0 = latOf(v.y0 + this.size.h + pad, z);
    const lon0 = lonOf(v.x0 - pad, z);
    const lon1 = lonOf(v.x0 + this.size.w + pad, z);
    // Open-Meteo's free tier counts every grid point as a call (600 a minute, 10,000 a day).
    // Zoomed in, fetch the native 2 km grid in bounding-box strips (up to 1000 points each);
    // zoomed right out, sample a 4 km grid instead so it costs about the same.
    const q = "&hourly=precipitation&models=ukmo_uk_deterministic_2km&forecast_hours=14&timeformat=unixtime&timezone=GMT";
    const get = async (url: string) => {
      for (let attempt = 0; ; attempt++) {
        const r = await fetch(url);
        const j = await r.json();
        if (r.ok) return (Array.isArray(j) ? j : [j]) as any[];
        if (attempt === 0 && /minutely/i.test(j?.reason ?? "")) {
          await new Promise((res) => setTimeout(res, 65_000));
          continue;
        }
        throw new Error(j?.reason ?? r.status);
      }
    };
    let parts: any[][];
    if (z >= 10) {
      const strips = Math.max(1, Math.ceil(((lat1 - lat0) * (lon1 - lon0) * 1900) / 850));
      const step = (lat1 - lat0) / strips;
      parts = await Promise.all(
        Array.from({ length: strips }, (_, i) => {
          const a0 = lat0 + step * i;
          const a1 = i === strips - 1 ? lat1 : a0 + step - 0.0005;
          return get(`https://api.open-meteo.com/v1/forecast?bounding_box=${a0.toFixed(4)},${lon0.toFixed(4)},${a1.toFixed(4)},${lon1.toFixed(4)}${q}`);
        }),
      );
    } else {
      const dLat = 0.036;
      const dLon = 0.06;
      const pts: [number, number][] = [];
      for (let la = lat0; la <= lat1; la += dLat) for (let lo = lon0; lo <= lon1; lo += dLon) pts.push([la, lo]);
      const chunks: [number, number][][] = [];
      for (let i = 0; i < pts.length; i += 150) chunks.push(pts.slice(i, i + 150));
      parts = await Promise.all(
        chunks.map((c) =>
          get(`https://api.open-meteo.com/v1/forecast?latitude=${c.map((p) => p[0].toFixed(3)).join(",")}&longitude=${c.map((p) => p[1].toFixed(3)).join(",")}${q}`),
        ),
      );
    }
    const list = parts.flat();
    if (!list[0]?.hourly) throw new Error("no forecast data");
    return {
      at: Date.now(),
      times: (list[0].hourly.time as number[]).map((t) => t * 1000),
      pts: list.map((p) => ({ x7: worldX(p.longitude, RAD_Z), y7: worldY(p.latitude, RAD_Z), mm: p.hourly.precipitation.map((x: number | null) => x ?? 0) })),
    };
  }

  private zoom(d: number) {
    const z = Math.max(Z_MIN, Math.min(Z_MAX, this.z + d));
    if (z === this.z) return;
    this.stop();
    this.z = z;
  }

  // ---------- drawing ----------

  /** Low-res grid (radar-zoom pixels) covering the view. */
  private grid() {
    const v = this.view();
    const K = this.K;
    const ox = Math.floor(v.x0 / K) - 1;
    const oy = Math.floor(v.y0 / K) - 1;
    const w = Math.ceil(this.size.w / K) + 3;
    const h = Math.ceil(this.size.h / K) + 3;
    return { ox, oy, w, h, v };
  }

  /** For each low-res pixel, the four nearest forecast points and their weights (inverse
   *  distance), so the 2 km grid is drawn as a smooth field rather than blocks. */
  private buildNearest(g: { ox: number; oy: number; w: number; h: number }) {
    const N = 4;
    const idx = new Int32Array(g.w * g.h * N).fill(-1);
    const wt = new Float32Array(g.w * g.h * N);
    const pts = this.fc;
    if (pts.length) {
      const cell = 4;
      const buckets = new Map<string, number[]>();
      pts.forEach((p, i) => {
        const k = `${Math.floor(p.x7 / cell)},${Math.floor(p.y7 / cell)}`;
        (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i);
      });
      const bi = new Int32Array(N);
      const bd = new Float32Array(N);
      for (let y = 0; y < g.h; y++)
        for (let x = 0; x < g.w; x++) {
          const px = g.ox + x + 0.5;
          const py = g.oy + y + 0.5;
          const bx = Math.floor(px / cell);
          const by = Math.floor(py / cell);
          bi.fill(-1);
          bd.fill(1e9);
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++)
              for (const i of buckets.get(`${bx + dx},${by + dy}`) ?? []) {
                const d = (pts[i].x7 - px) ** 2 + (pts[i].y7 - py) ** 2;
                if (d >= bd[N - 1]) continue;
                let j = N - 1;
                while (j > 0 && bd[j - 1] > d) {
                  bd[j] = bd[j - 1];
                  bi[j] = bi[j - 1];
                  j--;
                }
                bd[j] = d;
                bi[j] = i;
              }
          if (bi[0] < 0 || bd[0] > 30) continue; // outside the model area
          let sum = 0;
          const o = (y * g.w + x) * N;
          for (let j = 0; j < N; j++) {
            if (bi[j] < 0) continue;
            const w = 1 / (bd[j] + 0.6);
            idx[o + j] = bi[j];
            wt[o + j] = w;
            sum += w;
          }
          for (let j = 0; j < N; j++) wt[o + j] /= sum;
        }
    }
    return { idx, wt, N };
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
      const { idx, wt, N } = this.nearest;
      // which two hourly values this moment sits between
      const T = this.fcTimes;
      let hi = 0;
      while (hi < T.length - 2 && T[hi + 1] - 1800_000 <= f.t) hi++;
      const ca = T[hi] - 1800_000;
      const cb = T[hi + 1] - 1800_000;
      const fr = Math.max(0, Math.min(1, (f.t - ca) / (cb - ca)));
      for (let i = 0; i < g.w * g.h; i++) {
        if (idx[i * N] < 0) continue;
        let mm = 0;
        for (let j = 0; j < N; j++) {
          const k = idx[i * N + j];
          if (k < 0) continue;
          const m = this.fc[k].mm;
          mm += (m[hi] + (m[hi + 1] - m[hi]) * fr) * wt[i * N + j];
        }
        const [r, gg, b, a] = ramp(mmToV(mm));
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
                  // faint returns: a whisper of cyan that strengthens with the tile's own opacity
                  const c = snow ? ramp(0.02 + ((im.data[s + 3] - 80) / 120) * 0.08) : ramp(v);
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
    const K = this.K;
    ctx.filter = `blur(${Math.round(K / 3)}px)`;
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
    }, 380);
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
    const labels = [];
    if (this.size.w) {
      const v = this.view();
      const tx0 = Math.floor(v.x0 / 256);
      const ty0 = Math.floor(v.y0 / 256);
      const tx1 = Math.floor((v.x0 + this.size.w) / 256);
      const ty1 = Math.floor((v.y0 + this.size.h) / 256);
      for (let ty = ty0; ty <= ty1; ty++)
        for (let tx = tx0; tx <= tx1; tx++) {
          const pos = `left:${tx * 256 - v.x0}px;top:${ty * 256 - v.y0}px`;
          tiles.push(html`<img class="t" alt="" src="${ESRI}World_Dark_Gray_Base/MapServer/tile/${this.z}/${ty}/${tx}" style=${pos} />`);
          labels.push(html`<img class="t" alt="" src="${ESRI}World_Dark_Gray_Reference/MapServer/tile/${this.z}/${ty}/${tx}" style=${pos} />`);
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
        : `Forecast · ${new Date(f.t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
    const split = nowR >= 0 && this.frames.length > 1 ? ((nowR + 0.5) / (this.frames.length - 1)) * 100 : -1;
    return html`
      <div class="base">${tiles}</div>
      <canvas></canvas>
      <div class="base labels">${labels}</div>
      <div class="home"><i></i></div>
      <div class="legend"><span>Light</span><b></b><span>Heavy</span></div>
      <div class="zoom">
        <button aria-label="Zoom in" ?disabled=${this.z >= Z_MAX} @click=${() => this.zoom(1)}><ha-icon icon="mdi:plus"></ha-icon></button>
        <button aria-label="Zoom out" ?disabled=${this.z <= Z_MIN} @click=${() => this.zoom(-1)}><ha-icon icon="mdi:minus"></ha-icon></button>
      </div>
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
      <div class="attr">Map © Esri · Radar RainViewer · Forecast Met Office UKV via Open-Meteo</div>
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
        filter: sepia(0.7) hue-rotate(215deg) saturate(2.2) brightness(0.8) contrast(1.15);
      }
      .base.labels {
        filter: sepia(0.3) hue-rotate(215deg) saturate(1.5) brightness(1.15);
        opacity: 0.85;
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
      .zoom {
        position: absolute;
        right: 12px;
        top: 50%;
        transform: translateY(-50%);
        display: flex;
        flex-direction: column;
        border-radius: 999px;
        overflow: hidden;
        background: rgba(13, 10, 22, 0.78);
        backdrop-filter: blur(8px);
      }
      .zoom button {
        display: grid;
        place-items: center;
        width: 46px;
        height: 46px;
        border: 0;
        background: none;
        color: #fff;
        cursor: pointer;
        --mdc-icon-size: 24px;
      }
      .zoom button + button {
        border-top: 1px solid rgba(255, 255, 255, 0.12);
      }
      .zoom button[disabled] {
        opacity: 0.3;
      }
      .attr {
        position: absolute;
        right: 14px;
        top: 16px;
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
