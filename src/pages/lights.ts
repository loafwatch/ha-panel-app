import { reg } from "../registry";
import { css, html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { PageBase } from "./base";
import { call, isOn } from "../util";
import type { HassEntity, LightRoomConfig } from "../types";

export class PageLights extends PageBase {
  @state() private sel = 0;

  protected watched() {
    return (this.config.lights ?? []).flatMap((r) => {
      const m = this.musicOf(r);
      const t = this.tvOf(r);
      return [r.entity, ...(r.members ?? []), m?.player ?? "", t?.media_player ?? "", t?.remote ?? ""];
    });
  }

  /** The music room and TV that belong to a room: named explicitly, or with the same name. */
  private musicOf(r: LightRoomConfig) {
    const want = (r.music ?? r.name).toLowerCase();
    return this.config.music?.rooms.find((m) => m.name.toLowerCase() === want);
  }
  private tvOf(r: LightRoomConfig) {
    const want = (r.tv ?? r.name).toLowerCase();
    return this.config.tv?.find((t) => (t.name ?? "").toLowerCase() === want);
  }

  /** Speaker and TV for the room, under its lights. Nothing is ever played from here. */
  private extras(r: LightRoomConfig) {
    const m = this.musicOf(r);
    const t = this.tvOf(r);
    const mp = m ? this.st(m.player) : undefined;
    const tvp = t?.media_player ? this.st(t.media_player) : t ? this.st(t.remote) : undefined;
    const busy = mp && (mp.state === "playing" || mp.state === "paused");
    const vol = Math.round(((mp?.attributes.volume_level as number) ?? 0) * 100);
    const tvOn = !!tvp && !["off", "unavailable", "standby", "unknown"].includes(tvp.state);
    return html`
      ${m
        ? html`<div class="cl sc">Speaker</div>
            <div class="xrow">
              <ha-icon icon=${busy ? "mdi:speaker-play" : "mdi:speaker"}></ha-icon>
              <div class="xt">
                ${busy
                  ? html`<b>${mp!.attributes.media_title ?? "Playing"}</b><span>${mp!.state === "paused" ? "Paused" : mp!.attributes.media_artist ?? ""}</span>`
                  : html`<b>${mp ? "Nothing playing" : "Unavailable"}</b>`}
              </div>
              ${busy
                ? html`<button class="btn icon" aria-label=${mp!.state === "playing" ? "Pause" : "Play"} @click=${() => call(this.hass, "media_player", "media_play_pause", { entity_id: m.player })}>
                      <ha-icon icon=${mp!.state === "playing" ? "mdi:pause" : "mdi:play"}></ha-icon></button>
                    <button class="btn icon" aria-label="Stop" @click=${() => call(this.hass, "media_player", "media_stop", { entity_id: m.player })}><ha-icon icon="mdi:stop"></ha-icon></button>`
                : nothing}
              <button class="btn" @click=${() => this.navigate("music")}><ha-icon icon="mdi:music"></ha-icon>Music</button>
            </div>
            ${mp && mp.state !== "unavailable"
              ? html`<div class="ctl">
                  <div class="cl">Volume <b>${vol}%</b></div>
                  <input type="range" min="0" max="100" .value=${String(vol)} style="--v:${vol}%"
                    @input=${(ev: Event) => setV(ev)}
                    @change=${(ev: Event) => call(this.hass, "media_player", "volume_set", { entity_id: m.player, volume_level: Number((ev.target as HTMLInputElement).value) / 100 })} />
                </div>`
              : nothing}`
        : nothing}
      ${t
        ? html`<div class="cl sc">TV</div>
            <div class="xrow">
              <ha-icon icon=${tvOn ? "mdi:television" : "mdi:television-off"}></ha-icon>
              <div class="xt">
                <b>${!tvp ? "Unavailable" : tvOn ? tvp.attributes.app_name ?? tvp.attributes.media_title ?? "On" : "Off"}</b>
              </div>
              <button class="btn" @click=${() => call(this.hass, "remote", tvOn ? "turn_off" : "turn_on", { entity_id: t.remote })}>
                <ha-icon icon="mdi:power"></ha-icon>${tvOn ? "Turn off" : "Turn on"}</button>
              <button class="btn" @click=${() => this.navigate("tv")}><ha-icon icon="mdi:remote-tv"></ha-icon>Remote</button>
            </div>`
        : nothing}
    `;
  }

  private pct(e?: HassEntity) {
    return isOn(e) && e?.attributes.brightness ? Math.round((e.attributes.brightness / 255) * 100) : 0;
  }

  render() {
    const rooms = this.config.lights ?? [];
    if (!rooms.length) return html`<div class="page"><div class="empty">No lights configured.</div></div>`;
    const r = rooms[Math.min(this.sel, rooms.length - 1)];
    const e = this.st(r.entity);
    const on = isOn(e);
    const pct = this.pct(e);
    const modes: string[] = e?.attributes.supported_color_modes ?? [];
    const ct = modes.some((m) => ["color_temp", "hs", "xy", "rgb", "rgbw", "rgbww"].includes(m));
    const kMin = e?.attributes.min_color_temp_kelvin ?? 2200;
    const kMax = e?.attributes.max_color_temp_kelvin ?? 6500;
    const k = e?.attributes.color_temp_kelvin ?? Math.round((kMin + kMax) / 2);
    return html`
      <div class="page">
        <div class="layout">
          <div class="list">
            ${rooms.map((x, i) => {
              const s = this.st(x.entity);
              const o = isOn(s);
              return html`<button class="room ${i === this.sel ? "sel" : ""} ${o ? "on" : ""}" @click=${() => (this.sel = i)}>
                <ha-icon icon=${x.icon ?? (o ? "mdi:lightbulb-on" : "mdi:lightbulb-outline")}></ha-icon>
                <span class="rn">${x.name}</span>
                <span class="rs">${!s ? "Unavailable" : o ? (this.pct(s) ? this.pct(s) + "%" : "On") : "Off"}</span>
                <span class="sw ${o ? "on" : ""}" @click=${(ev: Event) => {
                  ev.stopPropagation();
                  call(this.hass, "light", "toggle", { entity_id: x.entity });
                }}><i></i></span>
              </button>`;
            })}
          </div>
          <div class="tile detail">
            <div class="dhead">
              <div class="dname">${r.name}</div>
              <button class="btn ${on ? "primary" : ""}" @click=${() => call(this.hass, "light", "toggle", { entity_id: r.entity })}>
                <ha-icon icon=${on ? "mdi:lightbulb-on" : "mdi:lightbulb-outline"}></ha-icon>${on ? "On" : "Off"}
              </button>
            </div>
            <div class="ctl">
              <div class="cl">Brightness <b>${on ? pct + "%" : "Off"}</b></div>
              <input type="range" min="1" max="100" .value=${String(pct || 1)} style="--v:${pct}%"
                @input=${(ev: Event) => setV(ev)}
                @change=${(ev: Event) => call(this.hass, "light", "turn_on", { entity_id: r.entity, brightness_pct: Number((ev.target as HTMLInputElement).value) })} />
            </div>
            ${ct
              ? html`<div class="ctl">
                  <div class="cl">Warmth</div>
                  <input class="warm" type="range" min=${kMin} max=${kMax} step="50" .value=${String(k)}
                    @change=${(ev: Event) => call(this.hass, "light", "turn_on", { entity_id: r.entity, color_temp_kelvin: Number((ev.target as HTMLInputElement).value) })} />
                </div>`
              : nothing}
            ${r.scenes?.length
              ? html`<div class="cl sc">Scenes</div>
                  <div class="scenes">
                    ${r.scenes.map(
                      (s) => html`<button class="chip" @click=${() => {
                        call(this.hass, "scene", "turn_on", { entity_id: s.entity });
                        this.toast(s.name);
                      }}><ha-icon icon=${s.icon ?? "mdi:palette"}></ha-icon>${s.name}</button>`
                    )}
                  </div>`
              : nothing}
            ${r.members?.length
              ? html`<div class="cl sc">Lights</div>
                  <div class="members">
                    ${r.members.map((m) => {
                      const s = this.st(m);
                      const o = isOn(s);
                      const p = this.pct(s);
                      return html`<div class="mem ${o ? "on" : ""}">
                        <button class="mt" @click=${() => call(this.hass, "light", "toggle", { entity_id: m })}>
                          <ha-icon icon=${o ? "mdi:lightbulb-on" : "mdi:lightbulb-outline"}></ha-icon>
                        </button>
                        <div class="mb">
                          <div class="mn">${s?.attributes.friendly_name?.replace(new RegExp("^" + escRe(r.name) + "\\s*", "i"), "") ?? m}</div>
                          <input type="range" min="1" max="100" .value=${String(p || 1)} style="--v:${p}%"
                            @input=${(ev: Event) => setV(ev)}
                            @change=${(ev: Event) => call(this.hass, "light", "turn_on", { entity_id: m, brightness_pct: Number((ev.target as HTMLInputElement).value) })} />
                        </div>
                        <span class="mp">${s ? (o ? p + "%" : "Off") : "—"}</span>
                      </div>`;
                    })}
                  </div>`
              : nothing}
            ${this.extras(r)}
          </div>
        </div>
      </div>
    `;
  }

  static styles = [
    PageBase.styles,
    css`
      .layout {
        display: grid;
        grid-template-columns: minmax(240px, 1fr) minmax(0, 2fr);
        gap: var(--gap);
        align-items: start;
      }
      @container (max-width: 800px) {
        .layout {
          grid-template-columns: 1fr;
        }
      }
      .list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .room {
        display: grid;
        grid-template-columns: 30px 1fr auto auto;
        align-items: center;
        gap: 12px;
        padding: 14px 16px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--line);
        background: var(--tile);
        color: var(--text);
        box-shadow: var(--glow);
        font: 600 16px var(--font);
        text-align: left;
        cursor: pointer;
      }
      .room.sel {
        border: 2px solid var(--accent);
      }
      .room ha-icon {
        color: var(--text-2);
      }
      .room.on ha-icon {
        color: var(--cy);
      }
      .rs {
        font-size: 13px;
        color: var(--text-2);
        font-weight: 500;
      }
      .sw {
        width: 46px;
        height: 28px;
        border-radius: 14px;
        background: rgba(127, 127, 127, 0.3);
        position: relative;
        transition: background 0.2s;
      }
      .sw i {
        position: absolute;
        top: 3px;
        left: 3px;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        background: #fff;
        transition: left 0.2s;
      }
      .sw.on {
        background: var(--cy);
      }
      .sw.on i {
        left: 21px;
      }
      .dhead {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 18px;
      }
      .dname {
        font-size: 26px;
        font-weight: 700;
      }
      .ctl {
        margin-bottom: 18px;
      }
      .ctl input {
        width: 100%;
      }
      .cl {
        font-size: 14px;
        color: var(--text-2);
        margin-bottom: 10px;
        display: flex;
        justify-content: space-between;
      }
      .cl b {
        color: var(--text);
      }
      .cl.sc {
        margin-top: 8px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 12px;
        color: var(--accent);
      }
      input.warm {
        background: linear-gradient(90deg, #ffb35c, #fff3e0, #cfe6ff);
      }
      .xrow .btn.icon {
        padding: 10px;
      }
      .xrow {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 14px;
        border-radius: var(--radius-sm);
        background: var(--tile-2);
        --mdc-icon-size: 28px;
      }
      .xrow > ha-icon {
        color: var(--accent);
      }
      .xt {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }
      .xt b,
      .xt span {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .xt span {
        color: var(--text-2);
        font-size: 14px;
      }
      .scenes {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 18px;
      }
      .scenes ha-icon {
        color: var(--accent);
        --mdc-icon-size: 18px;
      }
      .members {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
        gap: 10px;
      }
      .mem {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        border-radius: var(--radius-sm);
        background: var(--tile-2);
        border: 1px solid var(--line);
      }
      .mt {
        width: 42px;
        height: 42px;
        border-radius: 50%;
        border: none;
        background: rgba(127, 127, 127, 0.15);
        color: var(--text-2);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }
      .mem.on .mt {
        background: rgba(0, 200, 212, 0.18);
        color: var(--cy);
      }
      .mb {
        flex: 1;
        min-width: 0;
      }
      .mn {
        font-size: 14px;
        font-weight: 600;
        margin-bottom: 8px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .mb input {
        width: 100%;
      }
      .mp {
        font-size: 13px;
        color: var(--text-2);
        width: 40px;
        text-align: right;
      }
    `,
  ];
}

function setV(ev: Event) {
  const t = ev.target as HTMLInputElement;
  t.style.setProperty("--v", t.value + "%");
}

function escRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

reg("panel-lights", PageLights);
