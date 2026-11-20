import { reg } from "../registry";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../types";
import { mediaPosition } from "../util";

interface Line {
  t: number;
  text: string;
}

interface Found {
  synced?: Line[];
  plain?: string[];
  instrumental?: boolean;
}

const API = "https://lrclib.net/api";
const cache = new Map<string, Found | null>();

/** "Song (Remastered 2011)" / "Song - 2011 Remaster" → "Song" */
function cleanTitle(t: string) {
  return t
    .replace(/\s*[([][^)\]]*(remaster|live|version|edit|mix|mono|stereo|deluxe|feat\.?|with )[^)\]]*[)\]]/gi, "")
    .replace(/\s+-\s+.*(remaster|live|version|edit|mix|mono|stereo).*$/i, "")
    .trim();
}

function firstArtist(a: string) {
  return a.split(/\s*(?:,|&| feat\.? | ft\.? | x )\s*/i)[0].trim();
}

function parseLrc(lrc: string): Line[] {
  const out: Line[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of tags) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Full-screen lyrics for the track playing on a media player. Timed lyrics follow
 * the song line by line (tap a line to jump there); plain lyrics scroll with the song.
 * Lyrics are looked up on demand from LRCLIB; nothing is stored.
 */
export class PanelLyrics extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @property() entity = "";
  /** Optional backend fetcher (e.g. "rest_command.fetch_url") used if the browser can't reach LRCLIB directly. */
  @property() proxy = "";
  @state() private found?: Found | null;
  @state() private idx = -1;
  private key = "";
  private timer?: number;
  private userScrolledAt = 0;

  private get p() {
    return this.entity ? this.hass?.states[this.entity] : undefined;
  }

  connectedCallback() {
    super.connectedCallback();
    this.timer = window.setInterval(() => this.tick(), 250);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this.timer);
  }

  protected updated(c: PropertyValues) {
    if (c.has("hass") || c.has("entity")) {
      const a = this.p?.attributes ?? {};
      const k = `${a.media_title ?? ""}|${a.media_artist ?? ""}`;
      if (k !== this.key && a.media_title) {
        this.key = k;
        this.idx = -1;
        this.load(String(a.media_title), String(a.media_artist ?? ""), String(a.media_album_name ?? ""), Number(a.media_duration) || 0);
      }
    }
  }

  private async get(url: string): Promise<any> {
    try {
      const r = await fetch(url);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(String(r.status));
      return await r.json();
    } catch (e) {
      if (!this.proxy || !this.hass) throw e;
      const [domain, service] = this.proxy.split(".");
      const res: any = await this.hass.callWS({
        type: "call_service",
        domain,
        service,
        service_data: { url },
        return_response: true,
      });
      const body = res?.response?.content ?? res?.response;
      if (res?.response?.status === 404) return null;
      return typeof body === "string" ? JSON.parse(body) : body;
    }
  }

  private async load(title: string, artist: string, album: string, dur: number) {
    const key = this.key;
    if (cache.has(key)) {
      this.found = cache.get(key);
      return;
    }
    this.found = undefined;
    const t = cleanTitle(title);
    const a = firstArtist(artist);
    const pick = (x: any): Found | null =>
      x && (x.syncedLyrics || x.plainLyrics || x.instrumental)
        ? {
            synced: x.syncedLyrics ? parseLrc(x.syncedLyrics) : undefined,
            plain: !x.syncedLyrics && x.plainLyrics ? String(x.plainLyrics).split(/\r?\n/) : undefined,
            instrumental: !!x.instrumental && !x.syncedLyrics && !x.plainLyrics,
          }
        : null;
    let f: Found | null = null;
    try {
      const q = new URLSearchParams({ track_name: t, artist_name: a });
      if (album) q.set("album_name", album);
      if (dur) q.set("duration", String(Math.round(dur)));
      f = pick(await this.get(`${API}/get?${q}`));
      if (!f || !f.synced) {
        const list: any[] = (await this.get(`${API}/search?${new URLSearchParams({ track_name: t, artist_name: a })}`)) ?? [];
        // prefer timed lyrics with a matching length
        const best =
          list.find((x) => x.syncedLyrics && (!dur || Math.abs(x.duration - dur) <= 3)) ?? list.find((x) => x.syncedLyrics) ?? list.find((x) => x.plainLyrics);
        f = pick(best) ?? f;
      }
    } catch (e) {
      console.warn("ha-panel-app: lyrics", e);
      if (this.key === key) this.found = null;
      return;
    }
    cache.set(key, f);
    if (this.key === key) this.found = f;
  }

  private tick() {
    const p = this.p;
    const f = this.found;
    if (!p || !f) return;
    const pos = mediaPosition(p) + 0.3; // show a line a touch early
    const box = this.renderRoot.querySelector(".scroll") as HTMLElement | null;
    if (!box) return;
    const userBusy = Date.now() - this.userScrolledAt < 4000;
    if (f.synced?.length) {
      let i = -1;
      for (let k = 0; k < f.synced.length; k++) if (f.synced[k].t <= pos) i = k;
      if (i !== this.idx) {
        this.idx = i;
        if (!userBusy) this.centre(box, Math.max(0, i));
      }
    } else if (f.plain && !userBusy) {
      const dur = Number(p.attributes.media_duration) || 0;
      if (dur) {
        const frac = Math.min(1, Math.max(0, (pos - 10) / Math.max(1, dur - 30)));
        box.scrollTo({ top: frac * (box.scrollHeight - box.clientHeight), behavior: "smooth" });
      }
    }
  }

  private centre(box: HTMLElement, i: number) {
    const el = box.querySelector(`[data-i="${i}"]`) as HTMLElement | null;
    if (!el) return;
    box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2, behavior: "smooth" });
  }

  private seek(t: number) {
    this.hass?.callService("media_player", "media_seek", { seek_position: Math.max(0, t) }, { entity_id: this.entity });
    this.userScrolledAt = 0;
  }

  private close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  render() {
    const a = this.p?.attributes ?? {};
    const f = this.found;
    return html`<div class="wrap" style=${a.entity_picture ? `--art:url("${a.entity_picture}")` : ""}>
      <div class="bg"></div>
      <div class="head">
        <div class="ti">
          <div class="t">${a.media_title ?? ""}</div>
          <div class="ar">${a.media_artist ?? ""}</div>
        </div>
        <button aria-label="Close lyrics" @click=${this.close}><ha-icon icon="mdi:close"></ha-icon></button>
      </div>
      <div class="scroll" @touchmove=${() => (this.userScrolledAt = Date.now())} @wheel=${() => (this.userScrolledAt = Date.now())}>
        ${f === undefined
          ? html`<div class="msg">Finding lyrics…</div>`
          : f === null
            ? html`<div class="msg">No lyrics found for this track</div>`
            : f.instrumental
              ? html`<div class="msg">♪ Instrumental ♪</div>`
              : f.synced
                ? html`<div class="pad"></div>
                    ${f.synced.map(
                      (l, i) => html`<div class="ln ${i === this.idx ? "now" : i < this.idx ? "past" : ""}" data-i=${i} @click=${() => this.seek(l.t)}>
                        ${l.text || "♪"}
                      </div>`,
                    )}
                    <div class="pad"></div>`
                : html`<div class="pad sm"></div>
                    ${f.plain!.map((l) => html`<div class="ln plain">${l || html`&nbsp;`}</div>`)}
                    <div class="pad sm"></div>`}
      </div>
      <div class="src">Lyrics: LRCLIB</div>
    </div>`;
  }

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 30;
      display: block;
    }
    .wrap {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      background: #0b0812;
      color: #fff;
      overflow: hidden;
      font-family: var(--font, system-ui, sans-serif);
    }
    .bg {
      position: absolute;
      inset: -40px;
      background: var(--art, none) center / cover;
      filter: blur(60px) brightness(0.35) saturate(1.3);
      transform: scale(1.1);
    }
    .head {
      position: relative;
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 20px 24px 8px;
    }
    .ti {
      flex: 1;
      min-width: 0;
    }
    .t {
      font-size: 22px;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ar {
      font-size: 16px;
      opacity: 0.7;
    }
    button {
      display: grid;
      place-items: center;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      border: 0;
      background: rgba(255, 255, 255, 0.14);
      color: #fff;
      cursor: pointer;
      --mdc-icon-size: 30px;
    }
    .scroll {
      position: relative;
      flex: 1;
      overflow-y: auto;
      padding: 0 8%;
      scrollbar-width: none;
      mask-image: linear-gradient(transparent, #000 18%, #000 82%, transparent);
      -webkit-mask-image: linear-gradient(transparent, #000 18%, #000 82%, transparent);
    }
    .scroll::-webkit-scrollbar {
      display: none;
    }
    .pad {
      height: 45%;
    }
    .pad.sm {
      height: 20%;
    }
    .ln {
      font-size: 34px;
      line-height: 1.3;
      font-weight: 700;
      padding: 10px 0;
      opacity: 0.32;
      transition: opacity 0.35s, transform 0.35s;
      transform-origin: left center;
      cursor: pointer;
    }
    .ln.past {
      opacity: 0.22;
    }
    .ln.now {
      opacity: 1;
      transform: scale(1.04);
    }
    .ln.plain {
      font-size: 28px;
      opacity: 0.85;
      padding: 4px 0;
      cursor: default;
    }
    .msg {
      margin-top: 30vh;
      text-align: center;
      font-size: 24px;
      opacity: 0.7;
    }
    .src {
      position: relative;
      text-align: right;
      font-size: 12px;
      opacity: 0.45;
      padding: 6px 24px 14px;
    }
  `;
}

reg("panel-lyrics", PanelLyrics);
