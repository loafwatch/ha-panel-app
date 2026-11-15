import { css, html, nothing, type PropertyValues } from "lit";
import { state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { PageBase } from "./base";
import { roomState, selectedRoomIndex } from "./music-state";
import { call, longPress, mediaPosition } from "../util";
import type { RoomConfig } from "../types";

interface Pl {
  uri: string;
  name: string;
  image?: string;
}
interface Peek {
  title: string;
  img?: string;
}

const JUNK = /\(from library\)|^Infinite Mix|^All favorited tracks|^Recently (added|played) tracks/i;

export class PageMusic extends PageBase {
  @state() private localRoom = 0;
  @state() private playlists: Pl[] = [];
  @state() private favourites: Pl[] = [];
  @state() private libState: "idle" | "loading" | "ok" | "error" = "idle";
  @state() private next?: Peek | null;
  @state() private prev?: Peek | null;
  @state() private liked?: boolean;
  @state() private slide: "" | "R" | "L" = "";
  @state() private artKey = 0;

  private libLoaded = 0;
  private curTitle?: string;
  private curImg?: string;
  private queueFor?: string;

  protected ticks = true;

  protected watched() {
    const m = this.config.music;
    return [m?.room_entity, ...(m?.rooms ?? []).flatMap((r) => [r.player, r.device ?? "", r.favorite_button ?? ""])].filter(Boolean) as string[];
  }

  private get rooms(): RoomConfig[] {
    return this.config.music?.rooms ?? [];
  }
  private get ri() {
    return selectedRoomIndex(this.hass, this.rooms, this.config.music?.room_entity, this.localRoom);
  }
  private get room() {
    return this.rooms[this.ri];
  }

  protected updated(changed: PropertyValues) {
    super.updated(changed);
    if (this.active && (this.libState === "idle" || Date.now() - this.libLoaded > 15 * 60 * 1000)) this.loadLibrary();
    this.trackChange();
  }

  /** Detect a track change in the selected room and update the carousel. */
  private trackChange() {
    const r = this.room;
    if (!r || !roomState(this.hass, r)) return;
    const a = this.hass.states[r.player].attributes;
    const title: string | undefined = a.media_title;
    if (!title) return; // ignore the blank gap during a skip
    const key = r.player + "|" + title;
    if (this.queueFor === key) return;
    const sameRoom = this.queueFor?.startsWith(r.player + "|");
    let dir: "" | "R" | "L" = "";
    if (sameRoom && this.next?.title === title) dir = "R";
    else if (sameRoom && this.prev?.title === title) dir = "L";
    const newPrev = !sameRoom ? null : dir === "L" ? null : this.curTitle ? { title: this.curTitle, img: this.curImg } : this.prev;
    const img = dir === "R" && this.next?.img ? this.next.img : a.entity_picture;
    this.queueFor = key;
    this.curTitle = title;
    this.curImg = img;
    this.prev = newPrev ?? null;
    this.next = undefined;
    this.liked = undefined;
    this.slide = dir;
    this.artKey++;
    this.fetchQueue(r.player, key);
  }

  private async fetchQueue(player: string, key: string) {
    const r = await this.hub.respond<Record<string, any>>("music_assistant", "get_queue", {}, { entity_id: player });
    if (this.queueFor !== key) return;
    const q = r?.[player] ?? {};
    const ni = q.next_item?.media_item;
    const cu = q.current_item?.media_item;
    this.next = ni ? { title: ni.name, img: ni.image } : null;
    this.liked = cu ? !!cu.favorite : false;
    if (this.next?.img) new Image().src = this.next.img; // preload for a seamless skip
  }

  private async loadLibrary() {
    this.libState = "loading";
    this.libLoaded = Date.now();
    const ce = await this.hub.musicEntry();
    if (!ce) {
      this.libState = "error";
      return;
    }
    const q = async (extra: Record<string, any>) => {
      const r = await this.hub.respond<{ items: any[] }>("music_assistant", "get_library", {
        config_entry_id: ce,
        media_type: "playlist",
        limit: 500,
        order_by: "name",
        ...extra,
      });
      return (r?.items ?? []).filter((p) => !JUNK.test(p.name)).map((p) => ({ uri: p.uri, name: p.name, image: p.image }));
    };
    try {
      const [all, favs] = await Promise.all([q({}), q({ favorite: true })]);
      const liked = all.filter((p) => /^Liked Songs/i.test(p.name));
      this.favourites = [...liked, ...favs.filter((p) => !/^Liked Songs/i.test(p.name))];
      this.playlists = all.filter((p) => !/^Liked Songs/i.test(p.name));
      this.libState = "ok";
    } catch {
      this.libState = "error";
    }
  }

  // ---------- actions ----------

  private pickRoom(i: number) {
    this.localRoom = i;
    const re = this.config.music?.room_entity;
    if (re) call(this.hass, "input_select", "select_option", { entity_id: re, option: this.rooms[i].name });
  }

  private play(p: Pl, shuffle: boolean) {
    const r = this.room;
    if (!r) return;
    call(this.hass, "media_player", "shuffle_set", { entity_id: r.player, shuffle });
    call(this.hass, "music_assistant", "play_media", { entity_id: r.player, media_id: p.uri, enqueue: "replace" });
    this.toast(`${shuffle ? "Shuffling" : "Playing"} ${p.name} in ${r.name}`);
    this.renderRoot.querySelector(".page")?.scrollTo({ top: 0, behavior: "smooth" });
  }

  private ctl(service: string, data: Record<string, any> = {}) {
    if (this.room) call(this.hass, "media_player", service, { entity_id: this.room.player, ...data });
  }

  private like() {
    const r = this.room;
    if (!r) return;
    if (this.liked) return this.toast("Already in your liked songs");
    if (!r.favorite_button) return this.toast("No favourite button set up for this room");
    this.liked = true;
    call(this.hass, "button", "press", { entity_id: r.favorite_button });
    this.toast("Added to your liked songs");
  }

  // ---------- render ----------

  render() {
    const r = this.room;
    if (!r) return html`<div class="page"><div class="empty">No music rooms configured.</div></div>`;
    const live = roomState(this.hass, r);
    const p = this.hass.states[r.player];
    return html`
      <div class="page">
        <div class="rooms">
          ${this.rooms.map((x, i) => {
            const s = roomState(this.hass, x);
            return html`<button class="chip ${i === this.ri ? "on" : ""}" @click=${() => this.pickRoom(i)}>
              ${s === "playing" ? html`<span class="eq"><i></i><i></i><i></i></span>` : nothing}${x.name}
            </button>`;
          })}
        </div>
        ${live ? this.player(r, p) : this.idle(r)}
        ${this.library()}
      </div>
    `;
  }

  private idle(r: RoomConfig) {
    return html`<div class="hero idle">
      <div class="art none"><ha-icon icon="mdi:music"></ha-icon></div>
      <div class="title">Nothing playing in ${r.name}</div>
      <div class="artist muted">Pick a playlist below</div>
      <ha-icon class="down" icon="mdi:chevron-down"></ha-icon>
    </div>`;
  }

  private player(r: RoomConfig, p: any) {
    const a = p.attributes;
    const dur = Number(a.media_duration) || 0;
    const pos = mediaPosition(p);
    const rep = a.repeat ?? "off";
    const vol = Math.round((Number(a.volume_level) || 0) * 100);
    const img = this.curImg ?? a.entity_picture;
    const long = String(a.media_title ?? "").length > 40;
    return html`
      <div class="hero">
        <div class="car">
          <div class="side prev ${this.prev?.img ? "" : "empty"}" style=${this.prev?.img ? `background-image:url("${this.prev.img}")` : ""}
            @click=${() => this.ctl("media_previous_track")}></div>
          ${keyed(this.artKey, html`<div class="art ${this.slide ? "from" + this.slide : ""}" style=${img ? `background-image:url("${img}")` : ""}>
            ${img ? nothing : html`<ha-icon icon="mdi:music"></ha-icon>`}</div>`)}
          <div class="side next ${this.next?.img ? "" : "empty"}" style=${this.next?.img ? `background-image:url("${this.next.img}")` : ""}
            @click=${() => this.ctl("media_next_track")}></div>
        </div>
        <div class="trow">
          <div class="title ${long ? "long" : ""}">${a.media_title ?? "Playing"}</div>
          <button class="fav ${this.liked ? "on" : ""}" aria-label="Add to liked songs" @click=${this.like}>
            <ha-icon icon=${this.liked ? "mdi:heart" : "mdi:plus"}></ha-icon>
          </button>
        </div>
        <div class="artist muted">${a.media_artist ?? a.media_album_name ?? ""}</div>
        <div class="where">${p.state === "paused" ? "Paused" : "Playing"} in ${r.name}</div>
        ${dur
          ? html`<div class="bar"><span style="width:${((pos / dur) * 100).toFixed(2)}%"></span></div>
              <div class="times muted"><span>${mmss(pos)}</span><span>${mmss(dur)}</span></div>`
          : nothing}
        <div class="ctl">
          <button class="b sm ${a.shuffle ? "on" : ""}" aria-label="Shuffle" @click=${() => this.ctl("shuffle_set", { shuffle: !a.shuffle })}>
            <ha-icon icon="mdi:shuffle-variant"></ha-icon></button>
          <button class="b md" aria-label="Previous" @click=${() => this.ctl("media_previous_track")}><ha-icon icon="mdi:skip-previous"></ha-icon></button>
          <button class="b lg" aria-label="Play or pause" @click=${() => this.ctl("media_play_pause")}>
            <ha-icon icon=${p.state === "playing" ? "mdi:pause" : "mdi:play"}></ha-icon></button>
          <button class="b md" aria-label="Next" @click=${() => this.ctl("media_next_track")}><ha-icon icon="mdi:skip-next"></ha-icon></button>
          <button class="b sm ${rep !== "off" ? "on" : ""}" aria-label="Repeat"
            @click=${() => this.ctl("repeat_set", { repeat: rep === "off" ? "all" : rep === "all" ? "one" : "off" })}>
            <ha-icon icon=${rep === "one" ? "mdi:repeat-once" : "mdi:repeat"}></ha-icon></button>
        </div>
        <div class="vol">
          <ha-icon icon="mdi:volume-medium"></ha-icon>
          <input type="range" min="0" max="100" .value=${String(vol)} style="--v:${vol}%"
            @input=${(e: Event) => {
              const t = e.target as HTMLInputElement;
              t.style.setProperty("--v", t.value + "%");
            }}
            @change=${(e: Event) => this.ctl("volume_set", { volume_level: Number((e.target as HTMLInputElement).value) / 100 })} />
        </div>
      </div>
    `;
  }

  private library() {
    if (this.libState === "error") return html`<div class="empty">Couldn't load your music. Is Music Assistant running?</div>`;
    if (this.libState !== "ok") return html`<div class="empty">Loading your music…</div>`;
    return html`
      <div class="sec">Favourites</div>
      <div class="row">${this.favourites.map((p) => this.tile(p, true))}</div>
      ${this.favourites.length < 2 ? html`<div class="empty">Tip: heart a playlist in Music Assistant to pin it here.</div>` : nothing}
      <div class="sec">All playlists <span>${this.playlists.length}</span></div>
      <div class="grid">${this.playlists.map((p) => this.tile(p, false))}</div>
    `;
  }

  private tile(p: Pl, big: boolean) {
    const lp = longPress(
      () => this.play(p, false),
      () => this.play(p, true),
      650
    );
    return html`<div class="pl ${big ? "big" : ""}" @pointerdown=${lp.down} @pointermove=${lp.move} @pointerup=${lp.up}
      @pointercancel=${lp.cancel} @pointerleave=${lp.cancel}>
      <div class="cover" style=${p.image ? `background-image:url("${p.image}")` : ""}>${p.image ? nothing : html`<ha-icon icon="mdi:playlist-music"></ha-icon>`}</div>
      <div class="pn">${p.name}</div>
    </div>`;
  }

  static styles = [
    PageBase.styles,
    css`
      .rooms {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        position: sticky;
        top: -24px;
        z-index: 2;
        margin: -24px -28px 0;
        padding: 20px 28px 14px;
        background: linear-gradient(var(--bg) 78%, transparent);
      }
      .eq {
        display: inline-flex;
        align-items: flex-end;
        gap: 2px;
        height: 12px;
      }
      .eq i {
        width: 3px;
        background: var(--cy);
        border-radius: 1px;
        animation: eq 1s ease-in-out infinite;
      }
      .eq i:nth-child(2) {
        animation-delay: 0.2s;
      }
      .eq i:nth-child(3) {
        animation-delay: 0.4s;
      }
      @keyframes eq {
        0%,
        100% {
          height: 3px;
        }
        50% {
          height: 12px;
        }
      }
      .hero {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        padding: 18px 0 28px;
      }
      .car {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        overflow: hidden;
        padding: 8px 0;
      }
      .art {
        position: relative;
        z-index: 3;
        flex: 0 0 auto;
        width: min(340px, 40vh);
        aspect-ratio: 1;
        border-radius: 22px;
        background: var(--grad) center/cover no-repeat;
        box-shadow: 0 0 14px rgba(255, 46, 151, 0.18), 0 8px 24px rgba(0, 0, 0, 0.28);
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
      }
      .art ha-icon {
        --mdc-icon-size: 80px;
      }
      .art.none {
        width: min(220px, 28vh);
        opacity: 0.85;
      }
      .art.fromR {
        animation: fromR 0.45s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      .art.fromL {
        animation: fromL 0.45s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      @keyframes fromR {
        from {
          transform: translateX(55%) scale(0.8);
          opacity: 0.4;
        }
      }
      @keyframes fromL {
        from {
          transform: translateX(-55%) scale(0.8);
          opacity: 0.4;
        }
      }
      .side {
        position: relative;
        z-index: 1;
        flex: 0 0 auto;
        width: min(230px, 28vh);
        aspect-ratio: 1;
        border-radius: 18px;
        background: rgba(127, 127, 127, 0.15) center/cover no-repeat;
        opacity: 0.38;
        transform: scale(0.8);
        cursor: pointer;
        transition: opacity 0.3s;
      }
      .side.prev {
        margin-right: -70px;
        -webkit-mask-image: linear-gradient(90deg, transparent, #000 75%);
        mask-image: linear-gradient(90deg, transparent, #000 75%);
      }
      .side.next {
        margin-left: -70px;
        -webkit-mask-image: linear-gradient(90deg, #000 25%, transparent);
        mask-image: linear-gradient(90deg, #000 25%, transparent);
      }
      .side.empty {
        visibility: hidden;
      }
      .trow {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        margin-top: 22px;
        max-width: 100%;
      }
      .title {
        font-size: 24px;
        font-weight: 700;
        line-height: 1.3;
        min-width: 0;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .title.long {
        font-size: 19px;
      }
      .hero.idle .title {
        margin-top: 22px;
      }
      .fav {
        flex: 0 0 auto;
        width: 42px;
        height: 42px;
        border-radius: 50%;
        border: 2px solid var(--line);
        background: none;
        color: var(--text);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }
      .fav.on {
        border-color: var(--pk);
        color: var(--pk);
        background: rgba(255, 46, 151, 0.1);
      }
      .artist {
        margin-top: 6px;
        font-size: 16px;
        line-height: 1.4;
        max-width: 100%;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .where {
        margin-top: 6px;
        font-size: 13px;
        font-weight: 600;
        color: var(--accent);
      }
      .bar {
        width: min(520px, 80%);
        height: 4px;
        border-radius: 2px;
        background: rgba(127, 127, 127, 0.25);
        margin-top: 18px;
        overflow: hidden;
      }
      .bar span {
        display: block;
        height: 100%;
        background: linear-gradient(90deg, var(--pk), var(--cy));
        transition: width 1s linear;
      }
      .times {
        width: min(520px, 80%);
        display: flex;
        justify-content: space-between;
        font-size: 12px;
        margin-top: 6px;
        font-variant-numeric: tabular-nums;
      }
      .ctl {
        display: flex;
        align-items: center;
        gap: 22px;
        margin-top: 16px;
      }
      .b {
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        border: none;
        background: none;
        color: var(--text);
        cursor: pointer;
        transition: transform 0.12s;
        -webkit-tap-highlight-color: transparent;
      }
      .b:active {
        transform: scale(0.9);
      }
      .b.sm {
        width: 56px;
        height: 56px;
        color: var(--text-2);
      }
      .b.sm.on {
        color: var(--pk);
        filter: drop-shadow(0 0 6px rgba(255, 46, 151, 0.55));
      }
      .b.md {
        width: 68px;
        height: 68px;
        background: var(--tile-2);
        border: 1px solid var(--line);
        --mdc-icon-size: 30px;
      }
      .b.lg {
        width: 92px;
        height: 92px;
        background: var(--grad);
        color: #fff;
        box-shadow: 0 0 22px rgba(255, 46, 151, 0.5);
        --mdc-icon-size: 40px;
      }
      .vol {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-top: 20px;
        width: min(420px, 70%);
        color: var(--text-2);
      }
      .vol input {
        flex: 1;
      }
      .down {
        margin-top: 10px;
        color: var(--accent);
        animation: bob 1.6s ease-in-out infinite;
      }
      @keyframes bob {
        50% {
          transform: translateY(6px);
        }
      }
      .sec {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--accent);
        margin: 22px 0 12px;
      }
      .sec span {
        color: var(--text-2);
        margin-left: 6px;
      }
      .row {
        display: flex;
        gap: 16px;
        overflow-x: auto;
        padding: 2px 2px 8px;
        scrollbar-width: none;
      }
      .row::-webkit-scrollbar {
        display: none;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
        gap: 18px;
      }
      .pl {
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
        transition: transform 0.15s;
      }
      .pl:active {
        transform: scale(0.96);
      }
      .pl.big {
        flex: 0 0 180px;
      }
      .cover {
        width: 100%;
        aspect-ratio: 1;
        border-radius: 16px;
        background: var(--grad) center/cover no-repeat;
        border: 1px solid var(--line);
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
      }
      .cover ha-icon {
        --mdc-icon-size: 44px;
      }
      .pn {
        margin-top: 8px;
        font-size: 13px;
        font-weight: 600;
        line-height: 1.35;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
    `,
  ];
}

function mmss(s: number) {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}


customElements.get("panel-music") || customElements.define("panel-music", PageMusic);
