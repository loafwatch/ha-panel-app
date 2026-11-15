import { reg } from "../registry";
import { css, html, nothing, type PropertyValues } from "lit";
import { state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { PageBase } from "./base";
import { roomState, selectedRoomIndex } from "./music-state";
import { call, mediaPosition } from "../util";
import type { HassEntity, RoomConfig } from "../types";

interface Pl {
  uri: string;
  name: string;
  image?: string;
}
interface Track {
  title: string;
  artist?: string;
  img?: string;
  uri?: string;
}

const JUNK = /\(from library\)|^Infinite Mix|^All favorited tracks|^Recently (added|played) tracks/i;
/** Keep showing the player this long through the brief "nothing playing" gap during a skip. */
const GRACE_MS = 6000;

export class PageMusic extends PageBase {
  @state() private localRoom = 0;
  @state() private playlists: Pl[] = [];
  @state() private favourites: Pl[] = [];
  @state() private libState: "idle" | "loading" | "ok" | "error" = "idle";
  @state() private cur?: Track;
  @state() private next?: Track | null;
  @state() private prev?: Track | null;
  @state() private history: Track[] = [];
  @state() private liked?: boolean;
  @state() private slide: "" | "R" | "L" = "";
  @state() private artKey = 0;

  protected ticks = true;
  private libLoaded = 0;
  private key?: string; // player|title currently shown
  private lastLive: Record<string, number> = {};
  private lastLiveState: Record<string, HassEntity> = {};

  protected watched() {
    const m = this.config.music;
    return [m?.room_entity, ...(m?.rooms ?? []).flatMap((r) => [r.player, r.device ?? ""])].filter(Boolean) as string[];
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

  /** The player state to show, riding over short gaps (buffering, skipping). */
  private liveState(r: RoomConfig): HassEntity | undefined {
    const s = this.hass.states[r.player];
    if (roomState(this.hass, r) && s?.attributes.media_title) {
      this.lastLive[r.player] = Date.now();
      this.lastLiveState[r.player] = s;
      return s;
    }
    if (Date.now() - (this.lastLive[r.player] ?? 0) < GRACE_MS) return this.lastLiveState[r.player];
    return undefined;
  }

  protected updated(changed: PropertyValues) {
    super.updated(changed);
    if (this.active && (this.libState === "idle" || Date.now() - this.libLoaded > 15 * 60 * 1000)) this.loadLibrary();
    this.trackChange();
  }

  /** Follow track changes reported by Home Assistant (skips from elsewhere, natural track ends). */
  private trackChange() {
    const r = this.room;
    if (!r || !roomState(this.hass, r)) return;
    const a = this.hass.states[r.player].attributes;
    const title: string | undefined = a.media_title;
    if (!title) return;
    const key = r.player + "|" + title;
    if (key === this.key) {
      if (this.cur && !this.cur.img && a.entity_picture) this.cur = { ...this.cur, img: a.entity_picture };
      return;
    }
    const sameRoom = !!this.key?.startsWith(r.player + "|");
    let dir: "" | "R" | "L" = "";
    if (sameRoom && this.next?.title === title) dir = "R";
    else if (sameRoom && this.prev?.title === title) dir = "L";
    this.advance(r, { title, artist: a.media_artist, img: dir === "R" && this.next?.img ? this.next.img : a.entity_picture }, dir, sameRoom);
  }

  private advance(r: RoomConfig, t: Track, dir: "" | "R" | "L", sameRoom: boolean) {
    if (sameRoom && this.cur && dir !== "L") {
      this.history = [this.cur, ...this.history.filter((h) => h.title !== this.cur!.title)].slice(0, 12);
    }
    this.prev = !sameRoom ? null : dir === "L" ? this.history[1] ?? null : this.cur ?? this.prev ?? null;
    if (dir === "L") this.history = this.history.slice(1);
    if (!sameRoom) this.history = [];
    this.cur = t;
    this.key = r.player + "|" + t.title;
    this.next = undefined;
    this.liked = undefined;
    this.slide = dir;
    this.artKey++;
    const key = this.key;
    window.setTimeout(() => this.fetchQueue(r.player, key), dir ? 1200 : 0);
  }

  private async fetchQueue(player: string, key: string) {
    const r = await this.hub.respond<Record<string, any>>("music_assistant", "get_queue", {}, { entity_id: player });
    if (this.key !== key) return;
    const q = r?.[player] ?? {};
    const ni = q.next_item?.media_item;
    const cu = q.current_item?.media_item;
    this.next = ni ? { title: ni.name, artist: ni.artists?.[0]?.name, img: ni.image, uri: ni.uri } : null;
    this.liked = cu ? !!cu.favorite : false;
    if (cu && this.cur) this.cur = { ...this.cur, uri: cu.uri, img: this.cur.img || cu.image };
    if (this.next?.img) new Image().src = this.next.img;
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

  private pickRoom(i: number) {
    this.localRoom = i;
    const re = this.config.music?.room_entity;
    if (re) call(this.hass, "input_select", "select_option", { entity_id: re, option: this.rooms[i].name });
  }

  private play(uri: string, name: string, shuffle: boolean) {
    const r = this.room;
    if (!r) return;
    call(this.hass, "media_player", "shuffle_set", { entity_id: r.player, shuffle });
    call(this.hass, "music_assistant", "play_media", { entity_id: r.player, media_id: uri, enqueue: "replace" });
    this.toast(`${shuffle ? "Shuffling" : "Playing"} ${name} in ${r.name}`);
  }

  private skip(dir: 1 | -1) {
    const r = this.room;
    if (!r) return;
    call(this.hass, "media_player", dir > 0 ? "media_next_track" : "media_previous_track", { entity_id: r.player });
    // Move straight away; the state update that follows is recognised as the same track and ignored.
    if (dir > 0 && this.next) this.advance(r, { ...this.next }, "R", true);
    else if (dir < 0 && this.prev) this.advance(r, { ...this.prev }, "L", true);
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

  render() {
    const r = this.room;
    if (!r) return html`<div class="page"><div class="empty">No music rooms configured.</div></div>`;
    const p = this.liveState(r);
    return html`
      <div class="layout">
        <div class="left">
          <div class="rooms">
            ${this.rooms.map((x, i) => {
              const s = roomState(this.hass, x);
              return html`<button class="chip ${i === this.ri ? "on" : ""}" @click=${() => this.pickRoom(i)}>
                ${s === "playing" ? html`<span class="eq"><i></i><i></i><i></i></span>` : nothing}${x.name}
              </button>`;
            })}
          </div>
          ${p ? this.player(r, p) : this.idle(r)}
        </div>
        <div class="right">${this.lists(!!p)}</div>
      </div>
    `;
  }

  private idle(r: RoomConfig) {
    return html`<div class="hero idle">
      <div class="art none"><ha-icon icon="mdi:music"></ha-icon></div>
      <div class="title">Nothing playing in ${r.name}</div>
      <div class="artist muted">Pick something from the list</div>
    </div>`;
  }

  private player(r: RoomConfig, p: HassEntity) {
    const a = p.attributes;
    const dur = Number(a.media_duration) || 0;
    const pos = mediaPosition(p);
    const rep = a.repeat ?? "off";
    const vol = Math.round((Number(a.volume_level) || 0) * 100);
    const t = this.cur ?? { title: a.media_title, artist: a.media_artist, img: a.entity_picture };
    const long = String(t.title ?? "").length > 34;
    return html`
      <div class="hero">
        <div class="car">
          <div class="side prev ${this.prev?.img ? "" : "empty"}" style=${this.prev?.img ? `background-image:url("${this.prev.img}")` : ""}
            @click=${() => this.skip(-1)}></div>
          ${keyed(this.artKey, html`<div class="art ${this.slide ? "from" + this.slide : ""}" style=${t.img ? `background-image:url("${t.img}")` : ""}>
            ${t.img ? nothing : html`<ha-icon icon="mdi:music"></ha-icon>`}</div>`)}
          <div class="side next ${this.next?.img ? "" : "empty"}" style=${this.next?.img ? `background-image:url("${this.next.img}")` : ""}
            @click=${() => this.skip(1)}></div>
        </div>
        <div class="trow">
          <div class="title ${long ? "long" : ""}">${t.title ?? "Playing"}</div>
          <button class="fav ${this.liked ? "on" : ""}" aria-label="Add to liked songs" @click=${this.like}>
            <ha-icon icon=${this.liked ? "mdi:heart" : "mdi:plus"}></ha-icon>
          </button>
        </div>
        <div class="artist muted">${t.artist ?? a.media_album_name ?? ""}</div>
        ${dur
          ? html`<div class="bar"><span style="width:${((pos / dur) * 100).toFixed(2)}%"></span></div>
              <div class="times muted"><span>${mmss(pos)}</span><span>${p.state === "paused" ? "Paused" : r.name}</span><span>${mmss(dur)}</span></div>`
          : html`<div class="where">${p.state === "paused" ? "Paused" : "Playing"} in ${r.name}</div>`}
        <div class="ctl">
          <button class="b sm ${a.shuffle ? "on" : ""}" aria-label="Shuffle" @click=${() => this.ctl("shuffle_set", { shuffle: !a.shuffle })}>
            <ha-icon icon="mdi:shuffle-variant"></ha-icon></button>
          <button class="b md" aria-label="Previous" @click=${() => this.skip(-1)}><ha-icon icon="mdi:skip-previous"></ha-icon></button>
          <button class="b lg" aria-label="Play or pause" @click=${() => this.ctl("media_play_pause")}>
            <ha-icon icon=${p.state === "playing" ? "mdi:pause" : "mdi:play"}></ha-icon></button>
          <button class="b md" aria-label="Next" @click=${() => this.skip(1)}><ha-icon icon="mdi:skip-next"></ha-icon></button>
          <button class="b sm ${rep !== "off" ? "on" : ""}" aria-label="Repeat"
            @click=${() => this.ctl("repeat_set", { repeat: rep === "off" ? "all" : rep === "all" ? "one" : "off" })}>
            <ha-icon icon=${rep === "one" ? "mdi:repeat-once" : "mdi:repeat"}></ha-icon></button>
        </div>
        <div class="vol">
          <ha-icon icon="mdi:volume-medium"></ha-icon>
          <input type="range" min="0" max="100" .value=${String(vol)} style="--v:${vol}%"
            @input=${(e: Event) => {
              const el = e.target as HTMLInputElement;
              el.style.setProperty("--v", el.value + "%");
            }}
            @change=${(e: Event) => this.ctl("volume_set", { volume_level: Number((e.target as HTMLInputElement).value) / 100 })} />
        </div>
      </div>
    `;
  }

  private lists(live: boolean) {
    return html`
      ${live
        ? html`<div class="sec">Up next</div>
            ${this.next
              ? this.trackRow(this.next, () => this.skip(1), "mdi:skip-next")
              : html`<div class="empty">${this.next === null ? "Nothing queued after this track" : "…"}</div>`}
            ${this.history.length
              ? html`<div class="sec">Played</div>
                  ${this.history.map((h) => this.trackRow(h, h.uri ? () => this.play(h.uri!, h.title, false) : undefined, "mdi:play"))}`
              : nothing}`
        : nothing}
      ${this.libState === "error"
        ? html`<div class="empty">Couldn't load your music. Is Music Assistant running?</div>`
        : this.libState !== "ok"
          ? html`<div class="empty">Loading your music…</div>`
          : html`
              <div class="sec">Favourites</div>
              ${this.favourites.map((p) => this.plRow(p))}
              ${this.favourites.length < 2 ? html`<div class="empty">Tip: heart a playlist in Music Assistant to pin it here.</div>` : nothing}
              <div class="sec">Playlists <span>${this.playlists.length}</span></div>
              ${this.playlists.map((p) => this.plRow(p))}
            `}
    `;
  }

  private trackRow(t: Track, onTap: (() => void) | undefined, icon: string) {
    return html`<div class="row ${onTap ? "tap" : ""}" @click=${() => onTap?.()}>
      <div class="thumb" style=${t.img ? `background-image:url("${t.img}")` : ""}>${t.img ? nothing : html`<ha-icon icon="mdi:music-note"></ha-icon>`}</div>
      <div class="rt"><div class="rn">${t.title}</div><div class="ra muted">${t.artist ?? ""}</div></div>
      ${onTap ? html`<ha-icon class="ri" icon=${icon}></ha-icon>` : nothing}
    </div>`;
  }

  private plRow(p: Pl) {
    return html`<div class="row tap" @click=${() => this.play(p.uri, p.name, false)}>
      <div class="thumb" style=${p.image ? `background-image:url("${p.image}")` : ""}>${p.image ? nothing : html`<ha-icon icon="mdi:playlist-music"></ha-icon>`}</div>
      <div class="rt"><div class="rn">${p.name}</div></div>
      <button class="rb" aria-label="Shuffle ${p.name}" @click=${(e: Event) => {
        e.stopPropagation();
        this.play(p.uri, p.name, true);
      }}><ha-icon icon="mdi:shuffle-variant"></ha-icon></button>
      <button class="rb play" aria-label="Play ${p.name}"><ha-icon icon="mdi:play"></ha-icon></button>
    </div>`;
  }

  static styles = [
    PageBase.styles,
    css`
      :host {
        display: block;
        height: 100%;
        container-type: inline-size;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(380px, 46%) minmax(0, 1fr);
        height: 100%;
      }
      .left {
        height: 100%;
        overflow-y: auto;
        scrollbar-width: none;
        padding: 18px 20px 96px 28px;
        display: flex;
        flex-direction: column;
      }
      .right {
        height: 100%;
        overflow-y: auto;
        scrollbar-width: none;
        padding: 18px 28px 110px 12px;
        overscroll-behavior: contain;
      }
      .left::-webkit-scrollbar,
      .right::-webkit-scrollbar {
        display: none;
      }
      @container (max-width: 760px) {
        .layout {
          display: block;
          overflow-y: auto;
        }
        .left,
        .right {
          height: auto;
          overflow: visible;
          padding-bottom: 20px;
        }
        .right {
          padding: 0 24px 110px;
        }
      }
      .rooms {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: center;
      }
      .rooms .chip {
        padding: 8px 14px;
        font-size: 13px;
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
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding-top: 12px;
      }
      .car {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        overflow: hidden;
        padding: 6px 0;
      }
      .art {
        position: relative;
        z-index: 3;
        flex: 0 0 auto;
        width: min(290px, 34vh, 70%);
        aspect-ratio: 1;
        border-radius: 20px;
        background: var(--grad) center/cover no-repeat;
        background-color: var(--tile-2);
        box-shadow: 0 0 12px rgba(255, 46, 151, 0.16), 0 8px 22px rgba(0, 0, 0, 0.26);
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
      }
      .art ha-icon {
        --mdc-icon-size: 72px;
      }
      .art.none {
        width: min(200px, 26vh);
        opacity: 0.85;
      }
      .art.fromR {
        animation: fromR 0.42s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      .art.fromL {
        animation: fromL 0.42s cubic-bezier(0.2, 0.8, 0.2, 1);
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
        width: min(190px, 22vh, 40%);
        aspect-ratio: 1;
        border-radius: 16px;
        background: rgba(127, 127, 127, 0.15) center/cover no-repeat;
        opacity: 0.38;
        transform: scale(0.8);
        cursor: pointer;
      }
      .side.prev {
        margin-right: -60px;
        -webkit-mask-image: linear-gradient(90deg, transparent, #000 75%);
        mask-image: linear-gradient(90deg, transparent, #000 75%);
      }
      .side.next {
        margin-left: -60px;
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
        gap: 10px;
        margin-top: 16px;
        max-width: 100%;
      }
      .title {
        font-size: 22px;
        font-weight: 700;
        line-height: 1.3;
        min-width: 0;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .title.long {
        font-size: 18px;
      }
      .hero.idle .title {
        margin-top: 18px;
      }
      .fav {
        flex: 0 0 auto;
        width: 38px;
        height: 38px;
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
        margin-top: 4px;
        font-size: 15px;
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
        width: 86%;
        height: 4px;
        border-radius: 2px;
        background: rgba(127, 127, 127, 0.25);
        margin-top: 14px;
        overflow: hidden;
      }
      .bar span {
        display: block;
        height: 100%;
        background: linear-gradient(90deg, var(--pk), var(--cy));
        transition: width 1s linear;
      }
      .times {
        width: 86%;
        display: flex;
        justify-content: space-between;
        font-size: 12px;
        margin-top: 5px;
        font-variant-numeric: tabular-nums;
      }
      .ctl {
        display: flex;
        align-items: center;
        gap: 16px;
        margin-top: 12px;
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
        width: 50px;
        height: 50px;
        color: var(--text-2);
      }
      .b.sm.on {
        color: var(--pk);
        filter: drop-shadow(0 0 6px rgba(255, 46, 151, 0.55));
      }
      .b.md {
        width: 62px;
        height: 62px;
        background: var(--tile-2);
        border: 1px solid var(--line);
        --mdc-icon-size: 28px;
      }
      .b.lg {
        width: 82px;
        height: 82px;
        background: var(--grad);
        color: #fff;
        box-shadow: 0 0 20px rgba(255, 46, 151, 0.45);
        --mdc-icon-size: 38px;
      }
      .vol {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-top: 16px;
        width: 80%;
        color: var(--text-2);
      }
      .vol input {
        flex: 1;
      }
      .sec {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--accent);
        margin: 20px 0 8px;
      }
      .sec:first-child {
        margin-top: 4px;
      }
      .sec span {
        color: var(--text-2);
        margin-left: 6px;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 8px 10px;
        border-radius: 14px;
        transition: background 0.15s;
        -webkit-tap-highlight-color: transparent;
      }
      .row.tap {
        cursor: pointer;
      }
      .row.tap:active {
        background: var(--accent-soft);
      }
      .thumb {
        flex: 0 0 56px;
        height: 56px;
        border-radius: 10px;
        background: var(--grad) center/cover no-repeat;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
      }
      .rt {
        flex: 1;
        min-width: 0;
      }
      .rn {
        font-size: 15px;
        font-weight: 600;
        line-height: 1.35;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ra {
        font-size: 13px;
        line-height: 1.4;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ri {
        color: var(--text-2);
      }
      .rb {
        flex: 0 0 auto;
        width: 42px;
        height: 42px;
        border-radius: 50%;
        border: 1px solid var(--line);
        background: var(--tile);
        color: var(--text-2);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }
      .rb.play {
        background: var(--grad);
        border: none;
        color: #fff;
      }
    `,
  ];
}

function mmss(s: number) {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

reg("panel-music", PageMusic);
