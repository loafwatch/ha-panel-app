import { reg } from "../registry";
import { css, html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { PageBase } from "./base";
import { call } from "../util";
import type { TvConfig } from "../types";

/**
 * TV remote for Android TV / Google TV devices (the Android TV Remote integration).
 * D-pad, back/home, playback, volume and power go through remote.send_command;
 * app shortcuts use remote.turn_on with an activity (an app link or package name).
 */
export class PageTv extends PageBase {
  @state() private sel = 0;
  private rep?: number;
  private repDelay?: number;

  protected watched() {
    return (this.config.tv ?? []).flatMap((t) => [t.remote, t.media_player, t.adb].filter(Boolean) as string[]);
  }

  private get tv(): TvConfig | undefined {
    const tvs = this.config.tv ?? [];
    return tvs[Math.min(this.sel, tvs.length - 1)];
  }

  private send(command: string) {
    const t = this.tv;
    if (!t) return;
    navigator.vibrate?.(8);
    call(this.hass, "remote", "send_command", { entity_id: t.remote, command });
  }

  /** Press-and-hold repeats (for scrolling lists and volume). */
  private hold(command: string) {
    return {
      down: (e: PointerEvent) => {
        e.preventDefault();
        this.stop();
        this.send(command);
        this.repDelay = window.setTimeout(() => (this.rep = window.setInterval(() => this.send(command), 160)), 450);
      },
      up: () => this.stop(),
    };
  }

  private stop() {
    window.clearTimeout(this.repDelay);
    window.clearInterval(this.rep);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stop();
  }

  private launch(a: NonNullable<TvConfig["apps"]>[number]) {
    const t = this.tv;
    if (!t) return;
    navigator.vibrate?.(8);
    if (a.package && t.adb) call(this.hass, "media_player", "select_source", { entity_id: t.adb, source: a.package });
    else if (a.activity) call(this.hass, "remote", "turn_on", { entity_id: t.remote, activity: a.activity });
  }

  private key(icon: string, command: string, cls = "", repeat = false) {
    if (repeat) {
      const h = this.hold(command);
      return html`<button class="k ${cls}" @pointerdown=${h.down} @pointerup=${h.up} @pointerleave=${h.up} @pointercancel=${h.up}>
        <ha-icon icon=${icon}></ha-icon>
      </button>`;
    }
    return html`<button class="k ${cls}" @click=${() => this.send(command)}><ha-icon icon=${icon}></ha-icon></button>`;
  }

  render() {
    const tvs = this.config.tv ?? [];
    const t = this.tv;
    if (!t) return html`<div class="page"><div class="empty">No TV configured.</div></div>`;
    const r = this.st(t.remote);
    const mp = this.st(t.media_player);
    const off = !r || r.state === "off" || r.state === "unavailable";
    const app = mp?.attributes.app_name ?? this.st(t.adb)?.attributes.app_id ?? r?.attributes.current_activity ?? "";
    const title = mp?.attributes.media_title;
    const art = mp?.attributes.entity_picture;
    return html`
      <div class="page fill">
        ${tvs.length > 1
          ? html`<div class="seg top">
              ${tvs.map(
                (x, i) => html`<button class=${i === this.sel ? "on" : ""} @click=${() => (this.sel = i)}>${x.name ?? "TV " + (i + 1)}</button>`,
              )}
            </div>`
          : nothing}
        <div class="grid">
          <div class="tile remote">
            <div class="dpad">
              <div class="ring">
                ${this.key("mdi:chevron-up", "DPAD_UP", "up", true)} ${this.key("mdi:chevron-left", "DPAD_LEFT", "left", true)}
                ${this.key("mdi:chevron-right", "DPAD_RIGHT", "right", true)} ${this.key("mdi:chevron-down", "DPAD_DOWN", "down", true)}
                <button class="ok" @click=${() => this.send("DPAD_CENTER")}>OK</button>
              </div>
            </div>
            <div class="row3">
              ${this.key("mdi:arrow-left", "BACK")} ${this.key("mdi:home-outline", "HOME")} ${this.key("mdi:play-pause", "MEDIA_PLAY_PAUSE")}
            </div>
          </div>

          <div class="side">
            <div class="tile now ${off ? "off" : ""}">
              ${art && !off ? html`<img src=${art} alt="" />` : html`<div class="noart"><ha-icon icon="mdi:television"></ha-icon></div>`}
              <div class="ntxt">
                <div class="label">${t.name ?? "TV"}</div>
                <div class="big">${off ? "Off" : title ?? (app ? prettyApp(app) : "On")}</div>
                ${!off && title && app ? html`<div class="sub">${prettyApp(app)}</div>` : nothing}
              </div>
              <button class="k power ${off ? "" : "lit"}" @click=${() => this.send("POWER")} aria-label="Power">
                <ha-icon icon="mdi:power"></ha-icon>
              </button>
            </div>

            ${t.apps?.length
              ? html`<div class="tile apps">
                  ${t.apps.map(
                    (a) => html`<button class="app" style="--ac:${a.color ?? "var(--accent)"}" @click=${() => this.launch(a)}>
                      <ha-icon icon=${a.icon ?? "mdi:application-outline"}></ha-icon><span>${a.name}</span>
                    </button>`,
                  )}
                </div>`
              : nothing}

            <div class="tile vol">
              ${this.key("mdi:rewind", "MEDIA_REWIND", "", true)} ${this.key("mdi:volume-minus", "VOLUME_DOWN", "", true)}
              ${this.key("mdi:volume-mute", "VOLUME_MUTE")} ${this.key("mdi:volume-plus", "VOLUME_UP", "", true)}
              ${this.key("mdi:fast-forward", "MEDIA_FAST_FORWARD", "", true)}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  static styles = [
    PageBase.styles,
    css`
      .page.fill {
        display: flex;
        flex-direction: column;
        height: 100%;
        box-sizing: border-box;
      }
      .seg.top {
        align-self: flex-start;
        margin-bottom: var(--gap);
      }
      .grid {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
        gap: var(--gap);
      }
      button {
        font: inherit;
        color: inherit;
        border: 0;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
      }
      .k {
        display: grid;
        place-items: center;
        background: var(--tile-2);
        border-radius: 50%;
        width: 64px;
        height: 64px;
        transition: transform 0.08s, background 0.15s;
      }
      .k:active,
      .ok:active,
      .app:active {
        transform: scale(0.92);
        background: color-mix(in srgb, var(--accent) 30%, var(--tile-2));
      }
      .k ha-icon {
        --mdc-icon-size: 30px;
      }

      /* remote */
      .remote {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 28px;
      }
      .dpad {
        width: min(100%, 360px);
        aspect-ratio: 1;
        max-height: calc(100% - 120px);
      }
      .ring {
        position: relative;
        width: 100%;
        height: 100%;
        border-radius: 50%;
        background: var(--tile-2);
        box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent) 40%, transparent), 0 0 26px color-mix(in srgb, var(--accent) 22%, transparent);
      }
      .ring .k {
        position: absolute;
        background: transparent;
        width: 30%;
        height: 30%;
      }
      .ring .k ha-icon {
        --mdc-icon-size: 44px;
      }
      .ring .up {
        top: 2%;
        left: 35%;
      }
      .ring .down {
        bottom: 2%;
        left: 35%;
      }
      .ring .left {
        left: 2%;
        top: 35%;
      }
      .ring .right {
        right: 2%;
        top: 35%;
      }
      .ok {
        position: absolute;
        inset: 31%;
        border-radius: 50%;
        background: linear-gradient(135deg, var(--accent), var(--cy));
        color: #fff;
        font-size: 22px;
        font-weight: 700;
        letter-spacing: 1px;
        transition: transform 0.08s;
      }
      .row3 {
        display: flex;
        gap: 34px;
      }
      .row3 .k {
        width: 76px;
        height: 76px;
      }

      /* right column */
      .side {
        display: flex;
        flex-direction: column;
        gap: var(--gap);
        min-height: 0;
      }
      .now {
        display: flex;
        align-items: center;
        gap: 18px;
      }
      .now img,
      .noart {
        width: 96px;
        height: 96px;
        border-radius: 14px;
        object-fit: cover;
        flex: none;
      }
      .noart {
        display: grid;
        place-items: center;
        background: var(--tile-2);
      }
      .noart ha-icon {
        --mdc-icon-size: 44px;
        color: var(--text-2);
      }
      .ntxt {
        flex: 1;
        min-width: 0;
      }
      .ntxt .big {
        font-size: 26px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ntxt .sub {
        color: var(--text-2);
        margin-top: 2px;
      }
      .now.off .big {
        color: var(--text-2);
      }
      .power.lit {
        background: color-mix(in srgb, var(--accent) 25%, var(--tile-2));
        box-shadow: 0 0 0 2px var(--accent);
      }
      .apps {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        grid-auto-rows: minmax(70px, 1fr);
        gap: 12px;
      }
      .app {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        border-radius: 16px;
        background: var(--tile-2);
        box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--ac) 55%, transparent);
        font-weight: 600;
        transition: transform 0.08s;
      }
      .app ha-icon {
        --mdc-icon-size: 32px;
        color: var(--ac);
      }
      .vol {
        display: flex;
        justify-content: space-around;
        align-items: center;
      }
    `,
  ];
}

/** "com.google.android.youtube.tv" → "Youtube"; leaves friendly names alone. */
function prettyApp(a: string) {
  if (!a.includes(".")) return a;
  const known: Record<string, string> = {
    "com.google.android.apps.tv.launcherx": "Home screen",
    "com.google.android.youtube.tv": "YouTube",
    "com.netflix.ninja": "Netflix",
    "uk.co.bbc.iplayer": "BBC iPlayer",
    "bbc.iplayer.android": "BBC iPlayer",
    "ar.tvplayer.tv": "TiviMate",
    "air.ITVMobilePlayer": "ITVX",
    "com.channel4.ondemand": "Channel 4",
    "com.channel5.my5": "Channel 5",
    "com.disney.disneyplus": "Disney+",
    "com.spotify.tv.android": "Spotify",
    "com.amazon.amazonvideo.livingroom": "Prime Video",
    "org.jellyfin.androidtv": "Jellyfin",
  };
  if (known[a]) return known[a];
  const p = a.split(".").filter((x) => !["com", "uk", "co", "android", "tv", "app", "apps", "google"].includes(x));
  const w = p[0] ?? a;
  return w.charAt(0).toUpperCase() + w.slice(1);
}

reg("panel-tv", PageTv);
