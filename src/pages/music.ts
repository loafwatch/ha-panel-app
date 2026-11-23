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
  @state() private recent: Pl[] = [];
  @state() private lyrics = false;
  @state() private q = "";
  @state() private found?: { tracks: Track[]; albums: Pl[]; artists: Pl[]; playlists: Pl[] } | null;
  @state() private searching = false;
  private qTimer?: number;
  private qSeq = 0;
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
  /** After a skip from the panel, ignore other titles until this one is reported (or it times out). */
  private expect?: { title: string; until: number };
  private pending = false;

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
    if (changed.has("active") && !this.active && this.lyrics) this.lyrics = false;
    if (this.active && (this.libState === "idle" || Date.now() - this.libLoaded > 15 * 60 * 1000)) this.loadLibrary();
    else if (this.active && this.libState === "ok" && Date.now() - this.recentLoaded > 60 * 1000) this.loadRecent();
    this.trackChange();
  }

  /** Follow track changes reported by Home Assistant (skips from elsewhere, natural track ends). */
  private trackChange() {
    const r = this.room;
    if (!r || !roomState(this.hass, r)) return;
    const a = this.hass.states[r.player].attributes;
    const title: string | undefined = a.media_title;
    if (!title) return;
    if (this.expect) {
      if (title === this.expect.title || Date.now() > this.expect.until) this.expect = undefined;
      else return; // stale report of the old track straight after a skip
    }
    if (this.pending) return;
    const key = r.player + "|" + title;
    if (key === this.key) {
      if (this.cur && !this.cur.img && a.entity_picture) this.cur = { ...this.cur, img: a.entity_picture };
      return;
    }
    const sameRoom = !!this.key?.startsWith(r.player + "|");
    let dir: "" | "R" | "L" = "";
    if (sameRoom && this.next?.title === title) dir = "R";
    else if (sameRoom && this.prev?.title === title) dir = "L";
    const img = dir === "R" && this.next?.img ? this.next.img : a.entity_picture;
    this.pending = true;
    whenLoaded(img, () => {
      this.pending = false;
      this.advance(r, { title, artist: a.media_artist, img }, dir, sameRoom);
    });
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
      this.loadRecent();
    } catch {
      this.libState = "error";
    }
  }

  private recentLoaded = 0;

  /** Playlists most recently played (Music Assistant tracks plays from voice, the panel and its own app). */
  private async loadRecent() {
    this.recentLoaded = Date.now();
    const ce = await this.hub.musicEntry();
    if (!ce) return;
    try {
      const r = await this.hub.respond<{ items: any[] }>("music_assistant", "get_library", {
        config_entry_id: ce,
        media_type: "playlist",
        limit: 5,
        order_by: "last_played_desc",
      });
      this.recent = (r?.items ?? []).filter((p) => !JUNK.test(p.name)).map((p) => ({ uri: p.uri, name: p.name, image: p.image }));
    } catch {
      this.recent = [];
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
    const target = dir > 0 ? this.next : this.prev;
    if (!target) return;
    this.expect = { title: target.title, until: Date.now() + 8000 };
    this.pending = true;
    whenLoaded(target.img, () => {
      this.pending = false;
      this.advance(r, { ...target }, dir > 0 ? "R" : "L", true);
    });
  }

  private ctl(service: string, data: Record<string, any> = {}) {
    if (this.room) call(this.hass, "media_player", service, { entity_id: this.room.player, ...data });
  }

  /** Stop this room: stops Music Assistant's player, and closes whatever app the
   *  device itself is showing (e.g. the TV mirroring a Spotify session from elsewhere). */
  private stopRoom() {
    const r = this.room;
    if (!r) return;
    call(this.hass, "media_player", "media_stop", { entity_id: r.player });
    const d = r.device ? this.hass?.states[r.device] : undefined;
    if (d && !["off", "idle", "standby", "unavailable"].includes(d.state) && r.device!.split(".")[0] === "media_player") {
      // turning a Cast device "off" just quits the app on it; harmless for speakers that don't support it
      this.hass?.callService("media_player", "turn_off", {}, { entity_id: r.device }).catch(() => undefined);
    }
    this.toast(`Stopped ${r.name}`);
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
      ${this.lyrics && p && r
        ? html`<panel-lyrics .hass=${this.hass} entity=${r.player} proxy=${this.config.music?.lyrics_proxy ?? ""} @close=${() => (this.lyrics = false)}></panel-lyrics>`
        : nothing}
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
          <button class="fav" aria-label="Lyrics" @click=${() => (this.lyrics = true)}><ha-icon icon="mdi:script-text-outline"></ha-icon></button>
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
          <button class="b sm" aria-label="Stop" @click=${() => this.stopRoom()}><ha-icon icon="mdi:stop"></ha-icon></button>
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

  private radioRow() {
    const st = this.config.music?.radio;
    if (!st?.length) return nothing;
    const r = this.room;
    const now = r ? this.st(r.player) : undefined;
    const playingUri = String(now?.attributes.media_content_id ?? "");
    return html`<div class="sec">Radio</div>
      <div class="radio" style="--n:${st.length}">
        ${st.map((s) => {
          const on = !!playingUri && (playingUri === s.uri || playingUri.endsWith(s.uri.split("/").pop() ?? "\u0000"));
          return html`<button class="station ${on ? "on" : ""}" @click=${() => this.playRadio(s.uri, s.name)} aria-label=${s.name}>
            <span class="logo" style=${s.image ? `background-image:url("${s.image}")` : ""}>${s.image ? nothing : html`<ha-icon icon="mdi:radio"></ha-icon>`}</span>
            <span class="sn">${s.name.replace(/^BBC (Radio )?/, "")}</span>
          </button>`;
        })}
      </div>`;
  }

  private playRadio(uri: string, name: string) {
    const r = this.room;
    if (!r) return;
    call(this.hass, "music_assistant", "play_media", { entity_id: r.player, media_id: uri, media_type: "radio", enqueue: "replace" });
    this.toast(`Playing ${name} in ${r.name}`);
  }

  private onQuery(e: InputEvent) {
    this.q = (e.target as HTMLInputElement).value;
    window.clearTimeout(this.qTimer);
    if (this.q.trim().length < 2) {
      this.found = undefined;
      this.searching = false;
      return;
    }
    this.searching = true;
    this.qTimer = window.setTimeout(() => this.search(this.q.trim()), 450);
  }

  private clearSearch() {
    window.clearTimeout(this.qTimer);
    this.q = "";
    this.found = undefined;
    this.searching = false;
  }

  private async search(q: string) {
    const seq = ++this.qSeq;
    const ce = await this.hub.musicEntry();
    if (!ce) return;
    const r = await this.hub.respond<any>("music_assistant", "search", {
      config_entry_id: ce,
      name: q,
      media_type: ["track", "artist", "album", "playlist"],
      limit: 8,
    });
    if (seq !== this.qSeq) return; // a newer search has started
    const img = (x: any) => x?.image ?? x?.album?.image ?? undefined;
    const names = (a: any[] | undefined) => (a ?? []).map((x) => x.name).join(", ");
    this.found = {
      tracks: (r?.tracks ?? []).map((t: any) => ({ uri: t.uri, title: t.name, artist: names(t.artists), img: img(t) })),
      albums: (r?.albums ?? []).map((a: any) => ({ uri: a.uri, name: `${a.name}${a.artists?.length ? " · " + names(a.artists) : ""}`, image: img(a) })),
      artists: (r?.artists ?? []).map((a: any) => ({ uri: a.uri, name: a.name, image: img(a) })),
      playlists: (r?.playlists ?? []).map((p: any) => ({ uri: p.uri, name: p.name, image: img(p) })),
    };
    this.searching = false;
  }

  /** Play a single search result now ("play") or after the current track ("next"). */
  private playTrack(t: Track, how: "play" | "next") {
    const r = this.room;
    if (!r || !t.uri) return;
    call(this.hass, "music_assistant", "play_media", { entity_id: r.player, media_id: t.uri, media_type: "track", enqueue: how });
    this.toast(how === "play" ? `Playing ${t.title} in ${r.name}` : `${t.title} will play next in ${r.name}`);
  }

  private searchBox() {
    return html`<div class="search">
      <ha-icon icon="mdi:magnify"></ha-icon>
      <input
        type="search"
        placeholder="Search Spotify: songs, artists, albums"
        .value=${this.q}
        @input=${this.onQuery}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter") {
            window.clearTimeout(this.qTimer);
            (e.target as HTMLInputElement).blur();
            if (this.q.trim().length >= 2) this.search(this.q.trim());
          }
        }}
        enterkeyhint="search"
        autocomplete="off"
      />
      ${this.q ? html`<button class="clr" aria-label="Clear search" @click=${this.clearSearch}><ha-icon icon="mdi:close"></ha-icon></button>` : nothing}
    </div>`;
  }

  private results() {
    const f = this.found;
    if (this.searching && !f) return html`<div class="empty">Searching…</div>`;
    if (!f) return nothing;
    if (!f.tracks.length && !f.albums.length && !f.artists.length && !f.playlists.length)
      return html`<div class="empty">Nothing found for "${this.q}"</div>`;
    return html`
      ${f.tracks.length
        ? html`<div class="sec">Songs</div>
            ${f.tracks.map(
              (t) => html`<div class="row tap" @click=${() => this.playTrack(t, "play")}>
                <div class="thumb" style=${t.img ? `background-image:url("${t.img}")` : ""}>${t.img ? nothing : html`<ha-icon icon="mdi:music-note"></ha-icon>`}</div>
                <div class="rt"><div class="rn">${t.title}</div><div class="ra muted">${t.artist ?? ""}</div></div>
                <button class="rb" aria-label="Play next" @click=${(e: Event) => {
                  e.stopPropagation();
                  this.playTrack(t, "next");
                }}><ha-icon icon="mdi:playlist-plus"></ha-icon></button>
                <button class="rb play" aria-label="Play now"><ha-icon icon="mdi:play"></ha-icon></button>
              </div>`,
            )}`
        : nothing}
      ${f.artists.length ? html`<div class="sec">Artists</div>${f.artists.slice(0, 4).map((p) => this.plRow(p))}` : nothing}
      ${f.albums.length ? html`<div class="sec">Albums</div>${f.albums.slice(0, 5).map((p) => this.plRow(p))}` : nothing}
      ${f.playlists.length ? html`<div class="sec">Playlists</div>${f.playlists.slice(0, 5).map((p) => this.plRow(p))}` : nothing}
    `;
  }

  private lists(live: boolean) {
    // The search box stays in one place in the template so typing never re-creates it
    // (re-creating it drops focus and closes the on-screen keyboard).
    return html`${this.searchBox()}${this.q.trim().length >= 2 ? this.results() : this.library(live)}`;
  }

  private library(live: boolean) {
    return html`
      ${this.radioRow()}
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
              ${this.recent.length ? html`<div class="sec">Recently played</div>${this.recent.map((p) => this.plRow(p))}` : nothing}
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
        padding: 18px 28px 124px 12px;
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
          padding: 0 24px 124px;
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
      .search {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 0 8px 0 16px;
        height: 52px;
        margin: 4px 0 6px;
        border-radius: 999px;
        background: var(--tile-2);
        box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--accent) 35%, transparent);
      }
      .search:focus-within {
        box-shadow: inset 0 0 0 2px var(--accent), 0 0 16px color-mix(in srgb, var(--accent) 35%, transparent);
      }
      .search ha-icon {
        --mdc-icon-size: 24px;
        color: var(--text-2);
        flex: none;
      }
      .search input {
        flex: 1;
        min-width: 0;
        border: 0;
        outline: 0;
        background: transparent;
        color: var(--text);
        font: 500 17px var(--font);
      }
      .search input::-webkit-search-cancel-button {
        display: none;
      }
      .search .clr {
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: inherit;
        cursor: pointer;
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
      .radio {
        display: grid;
        /* one column per station, so the logos stretch across the full width */
        grid-template-columns: repeat(var(--n, 7), minmax(0, 1fr));
        gap: 10px;
      }
      .station {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        padding: 0;
        background: none;
        border: 0;
        color: var(--text);
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
      }
      .station .logo {
        width: 100%;
        aspect-ratio: 1;
        border-radius: 14px;
        background: var(--tile-2) center / cover no-repeat;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 0 0 2px transparent;
        transition: box-shadow 0.2s, transform 0.15s;
      }
      .station:active .logo {
        transform: scale(0.96);
      }
      .station.on .logo {
        box-shadow: 0 0 0 3px var(--accent), 0 0 14px var(--accent-soft);
      }
      .station .sn {
        font-size: 12px;
        color: var(--text-2);
        text-align: center;
        line-height: 1.2;
      }
      .station.on .sn {
        color: var(--text);
        font-weight: 600;
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

/** Run `cb` once an image is decoded (so it never flashes blank), or after 600 ms at most. */
function whenLoaded(url: string | undefined, cb: () => void) {
  if (!url) return cb();
  let done = false;
  const go = () => {
    if (!done) {
      done = true;
      cb();
    }
  };
  const im = new Image();
  im.src = url;
  im.decode().then(go, go);
  window.setTimeout(go, 600);
}

function mmss(s: number) {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

reg("panel-music", PageMusic);
