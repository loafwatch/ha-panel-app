import { css, html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { PageBase } from "./base";
import { activeRoom, roomState } from "./music-state";
import { binsInfo } from "./bins";
import { timersOf } from "./timers-state";
import { WEATHER_ICON, call, dayLabel, fmtCountdown, fmtDay, fmtTime, isOn, longPress, weatherLabel } from "../util";

export class PageHome extends PageBase {
  protected usesHub = true;
  protected ticks = true;
  @state() private adding: string | null = null;
  @state() private done = new Set<string>();

  protected watched() {
    const c = this.config;
    return [
      c.weather,
      c.timers?.sensor,
      c.timers?.alarm_switch,
      c.energy?.power,
      c.energy?.rate,
      ...(c.energy?.costs ?? []).map((x) => x.entity),
      ...(c.lights ?? []).map((l) => l.entity),
      ...(c.music?.rooms ?? []).flatMap((r) => [r.player, r.device ?? ""]),
      c.music?.room_entity,
      c.bins?.due_entity,
      c.bins?.out_entity,
    ].filter(Boolean) as string[];
  }

  render() {
    const now = new Date();
    return html`
      <div class="page">
        ${this.binsBanner()}
        <div class="grid">
          <div class="col">${this.clockTile(now)} ${this.upcomingTile()}</div>
          <div class="col">${this.timersTile()} ${this.lightsTile()} ${this.scenesTile()}</div>
          <div class="col">${this.nowPlayingTile()} ${this.listsTile()} ${this.energyTile()}</div>
        </div>
      </div>
    `;
  }

  // ---------- tiles ----------

  private clockTile(now: Date) {
    const w = this.st(this.config.weather);
    const today = this.hub.daily[0];
    return html`
      <div class="tile tap clock" @click=${() => this.navigate("weather")}>
        <div class="time">${fmtTime(now)}</div>
        <div class="date">${fmtDay(now)}</div>
        ${w
          ? html`<div class="wx">
              <ha-icon icon=${WEATHER_ICON[w.state] ?? "mdi:weather-cloudy"}></ha-icon>
              <span class="temp">${Math.round(w.attributes.temperature)}°</span>
              <span class="muted">${weatherLabel(w.state)}${today
                ? html` · ${Math.round(today.temperature ?? 0)}° / ${Math.round(today.templow ?? 0)}°`
                : nothing}</span>
            </div>`
          : nothing}
      </div>
    `;
  }

  private upcomingTile() {
    const evs = this.hub.events.filter((e) => e.end.getTime() > Date.now()).slice(0, 7);
    let last = "";
    return html`
      <div class="tile tap upcoming" @click=${() => this.navigate("calendar")}>
        <div class="label"><ha-icon icon="mdi:calendar-month"></ha-icon>Coming up</div>
        ${evs.length
          ? evs.map((e) => {
              const d = dayLabel(e.start);
              const head = d !== last ? html`<div class="day">${d}</div>` : nothing;
              last = d;
              const live = !e.allDay && e.start.getTime() <= Date.now() && e.end.getTime() > Date.now();
              return html`${head}
                <div class="ev ${live ? "live" : ""}">
                  <span class="when">${e.allDay ? "All day" : fmtTime(e.start)}</span>
                  <span class="what">${e.summary}</span>
                </div>`;
            })
          : html`<div class="empty">Nothing on the calendar</div>`}
      </div>
    `;
  }

  private timersTile() {
    const t = this.config.timers;
    if (!t) return nothing;
    const list = timersOf(this.hass, t.sensor);
    const ringing = isOn(this.st(t.alarm_switch));
    return html`
      <div class="tile timers ${ringing ? "ringing" : ""}">
        <div class="label tap-label" @click=${() => this.navigate("timers")}>
          <ha-icon icon="mdi:timer-outline"></ha-icon>Timers
          <ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
        </div>
        ${ringing
          ? html`<button class="btn primary stop" @click=${() => call(this.hass, "switch", "turn_off", { entity_id: t.alarm_switch })}>
              <ha-icon icon="mdi:alarm-off"></ha-icon>Stop alarm
            </button>`
          : nothing}
        ${list.map(
          (x) => html`<div class="timer">
            <div class="tname">${x.name}</div>
            <div class="tleft">${fmtCountdown(x.left)}</div>
            ${t.add_minute_script
              ? html`<button class="btn sm" @click=${() => call(this.hass, "script", "turn_on", { entity_id: t.add_minute_script, variables: { timer_id: x.id, minutes: 1 } })}>+1</button>`
              : nothing}
            <button class="btn sm icon" aria-label="Cancel" @click=${() => call(this.hass, "view_assist", "cancel_timer", { timer_id: x.id })}>
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>`
        )}
        <div class="quick">
          ${(t.quick ?? [1, 3, 5, 10, 15]).map(
            (m) => html`<button class="btn" @click=${() => this.startTimer(m)}>${m}m</button>`
          )}
        </div>
      </div>
    `;
  }

  private startTimer(m: number) {
    const t = this.config.timers!;
    call(this.hass, "view_assist", "set_timer", {
      entity_id: t.sensor,
      type: "Timer",
      name: `${m} min`,
      time: `${m} minute${m === 1 ? "" : "s"}`,
    });
    this.toast(`Timer set for ${m} minute${m === 1 ? "" : "s"}`);
  }

  private lightsTile() {
    const rooms = this.config.lights ?? [];
    if (!rooms.length) return nothing;
    return html`
      <div class="tile lights">
        <div class="label tap-label" @click=${() => this.navigate("lights")}>
          <ha-icon icon="mdi:lightbulb-group-outline"></ha-icon>Lights
          <ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
        </div>
        <div class="lgrid">
          ${rooms.map((r) => {
            const e = this.st(r.entity);
            const on = isOn(e);
            const pct = on && e?.attributes.brightness ? Math.round((e.attributes.brightness / 255) * 100) : 0;
            const lp = longPress(
              () => call(this.hass, "light", "toggle", { entity_id: r.entity }),
              () => this.navigate("lights")
            );
            return html`<div
              class="lt ${on ? "on" : ""}"
              @pointerdown=${lp.down}
              @pointermove=${lp.move}
              @pointerup=${lp.up}
              @pointerleave=${lp.cancel}
              @pointercancel=${lp.cancel}
            >
              <ha-icon icon=${r.icon ?? (on ? "mdi:lightbulb-on" : "mdi:lightbulb-outline")}></ha-icon>
              <div class="ln">${r.name}</div>
              <div class="ls">${!e ? "Unavailable" : on ? (pct ? `${pct}%` : "On") : "Off"}</div>
            </div>`;
          })}
        </div>
      </div>
    `;
  }

  private scenesTile() {
    const sc = this.config.scenes ?? [];
    if (!sc.length) return nothing;
    return html`
      <div class="tile scenes">
        <div class="label"><ha-icon icon="mdi:palette-outline"></ha-icon>Scenes</div>
        <div class="srow">
          ${sc.map(
            (s) => html`<button class="scene" @click=${() => {
              call(this.hass, "scene", "turn_on", { entity_id: s.entity });
              this.toast(s.name);
            }}>
              <ha-icon icon=${s.icon ?? "mdi:palette"}></ha-icon><span>${s.name}</span>
            </button>`
          )}
        </div>
      </div>
    `;
  }

  private nowPlayingTile() {
    const m = this.config.music;
    if (!m?.rooms.length) return nothing;
    const act = activeRoom(this.hass, m.rooms, m.room_entity);
    const p = act ? this.st(act.player) : undefined;
    const a = p?.attributes ?? {};
    return html`
      <div class="tile tap np" @click=${() => this.navigate("music")}>
        ${p
          ? html`
              <div class="npart" style=${a.entity_picture ? `background-image:url("${a.entity_picture}")` : ""}>
                ${a.entity_picture ? nothing : html`<ha-icon icon="mdi:music"></ha-icon>`}
              </div>
              <div class="npinfo">
                <div class="nptitle">${a.media_title ?? "Playing"}</div>
                <div class="npartist muted">${a.media_artist ?? ""}</div>
                <div class="nproom">${p.state === "paused" ? "Paused" : "Playing"} · ${act!.name}</div>
                <div class="npctl" @click=${(e: Event) => e.stopPropagation()}>
                  <button class="round" @click=${() => call(this.hass, "media_player", "media_previous_track", { entity_id: act!.player })}>
                    <ha-icon icon="mdi:skip-previous"></ha-icon>
                  </button>
                  <button class="round main" @click=${() => call(this.hass, "media_player", "media_play_pause", { entity_id: act!.player })}>
                    <ha-icon icon=${p.state === "playing" ? "mdi:pause" : "mdi:play"}></ha-icon>
                  </button>
                  <button class="round" @click=${() => call(this.hass, "media_player", "media_next_track", { entity_id: act!.player })}>
                    <ha-icon icon="mdi:skip-next"></ha-icon>
                  </button>
                </div>
              </div>
            `
          : html`<div class="npart idle"><ha-icon icon="mdi:music"></ha-icon></div>
              <div class="npinfo">
                <div class="nptitle">Nothing playing</div>
                <div class="npartist muted">Tap to pick some music</div>
              </div>`}
      </div>
    `;
  }

  private listsTile() {
    const lists = this.config.todo_lists ?? [];
    if (!lists.length) return nothing;
    return html`${lists.map((l) => {
      const items = (this.hub.todos[l.entity] ?? []).filter((i) => i.status === "needs_action");
      return html`
        <div class="tile list">
          <div class="label"><ha-icon icon=${l.icon ?? "mdi:format-list-checks"}></ha-icon>${l.name}
            <span class="count">${items.length || ""}</span></div>
          ${items.slice(0, 6).map(
            (i) => html`<div class="item ${this.done.has(i.uid) ? "done" : ""}" @click=${() => this.complete(l.entity, i.uid)}>
              <span class="box"><ha-icon icon="mdi:check"></ha-icon></span><span>${i.summary}</span>
            </div>`
          )}
          ${items.length > 6 ? html`<div class="muted more">+${items.length - 6} more</div>` : nothing}
          ${!items.length && this.adding !== l.entity ? html`<div class="empty">All done</div>` : nothing}
          ${this.adding === l.entity
            ? html`<form class="add" @submit=${(e: Event) => this.add(e, l.entity)}>
                <input id="add-${l.entity}" placeholder="Add an item…" autocomplete="off" enterkeyhint="done" />
                <button class="btn primary" type="submit">Add</button>
              </form>`
            : html`<button class="addbtn" @click=${() => this.openAdd(l.entity)}><ha-icon icon="mdi:plus"></ha-icon>Add</button>`}
        </div>
      `;
    })}`;
  }

  private async openAdd(entity: string) {
    this.adding = entity;
    await this.updateComplete;
    (this.renderRoot.querySelector(`#add-${CSS.escape(entity)}`) as HTMLInputElement | null)?.focus();
  }

  private add(e: Event, entity: string) {
    e.preventDefault();
    const input = this.renderRoot.querySelector(`#add-${CSS.escape(entity)}`) as HTMLInputElement | null;
    const v = input?.value.trim();
    if (v) call(this.hass, "todo", "add_item", { entity_id: entity, item: v });
    this.adding = null;
  }

  private complete(entity: string, uid: string) {
    this.done = new Set(this.done).add(uid);
    window.setTimeout(() => {
      call(this.hass, "todo", "update_item", { entity_id: entity, item: uid, status: "completed" });
      const s = new Set(this.done);
      s.delete(uid);
      this.done = s;
    }, 600);
  }

  private energyTile() {
    const en = this.config.energy;
    if (!en) return nothing;
    const p = this.st(en.power);
    const rate = this.st(en.rate);
    const costs = (en.costs ?? []).map((c) => ({ name: c.name, v: Number(this.st(c.entity)?.state) || 0 }));
    const total = costs.reduce((s, c) => s + c.v, 0);
    const w = Number(p?.state) || 0;
    return html`
      <div class="tile tap energy" @click=${() => this.navigate("energy")}>
        <div class="label"><ha-icon icon="mdi:lightning-bolt-outline"></ha-icon>Energy</div>
        <div class="erow">
          <div><div class="big">${w >= 1000 ? (w / 1000).toFixed(2) + " kW" : Math.round(w) + " W"}</div>
            <div class="muted">using now${rate ? ` · ${(Number(rate.state) * 100).toFixed(1)}p/kWh` : ""}</div></div>
          ${costs.length
            ? html`<div class="right"><div class="big">£${total.toFixed(2)}</div>
                <div class="muted">today · ${costs.map((c) => `${c.name} £${c.v.toFixed(2)}`).join(" · ")}</div></div>`
            : nothing}
        </div>
        <div class="meter"><span style="width:${Math.min(100, (w / 4000) * 100)}%"></span></div>
      </div>
    `;
  }

  private binsBanner() {
    const b = binsInfo(this.hass, this.config);
    if (!b || !b.due) return nothing;
    return html`
      <div class="bins tile" style="--bin:${b.next?.color ?? "var(--accent)"}">
        <ha-icon icon="mdi:trash-can-outline"></ha-icon>
        <div class="btxt"><b>${b.next?.name ?? "Bin"}</b> goes out tonight · collected ${b.next ? dayLabel(b.next.date).toLowerCase() : "tomorrow"}</div>
        ${this.config.bins?.out_entity
          ? html`<button class="btn primary" @click=${() => call(this.hass, "input_boolean", "turn_on", { entity_id: this.config.bins!.out_entity })}>It's out</button>`
          : nothing}
      </div>
    `;
  }

  static styles = [
    PageBase.styles,
    css`
      .grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: var(--gap);
        align-items: start;
      }
      @media (max-width: 1000px) {
        .grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .col:nth-child(3) {
          grid-column: 1 / -1;
        }
      }
      @media (max-width: 640px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
      .col {
        display: flex;
        flex-direction: column;
        gap: var(--gap);
        min-width: 0;
      }
      .tap-label {
        cursor: pointer;
      }
      .chev {
        margin-left: auto;
        --mdc-icon-size: 20px;
        color: var(--text-2);
      }
      /* clock */
      .clock .time {
        font-size: 76px;
        font-weight: 300;
        line-height: 1;
        letter-spacing: -0.02em;
      }
      .clock .date {
        margin-top: 8px;
        font-size: 17px;
        color: var(--text-2);
      }
      .wx {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 16px;
        font-size: 15px;
      }
      .wx ha-icon {
        --mdc-icon-size: 34px;
        color: var(--accent);
      }
      .wx .temp {
        font-size: 28px;
        font-weight: 600;
      }
      /* upcoming */
      .day {
        font-size: 13px;
        font-weight: 700;
        color: var(--text-2);
        margin: 12px 0 4px;
      }
      .day:first-of-type {
        margin-top: 0;
      }
      .ev {
        display: flex;
        gap: 12px;
        padding: 6px 0;
        font-size: 15px;
        line-height: 1.35;
      }
      .ev .when {
        flex: 0 0 62px;
        color: var(--text-2);
        font-variant-numeric: tabular-nums;
      }
      .ev.live .when {
        color: var(--accent);
        font-weight: 700;
      }
      .ev .what {
        min-width: 0;
      }
      /* timers */
      .timer {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 0;
      }
      .tname {
        flex: 1;
        min-width: 0;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tleft {
        font-size: 24px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        color: var(--accent);
      }
      .btn.sm {
        padding: 6px 12px;
        font-size: 14px;
      }
      .btn.icon {
        padding: 6px;
      }
      .quick {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 8px;
      }
      .quick .btn {
        flex: 1;
        min-width: 52px;
        padding: 12px 0;
      }
      .timers.ringing {
        animation: ring 1s ease-in-out infinite;
      }
      @keyframes ring {
        50% {
          box-shadow: 0 0 0 3px var(--pk), 0 0 24px var(--pk);
        }
      }
      .stop {
        width: 100%;
        margin-bottom: 8px;
        padding: 14px;
      }
      /* lights */
      .lgrid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .lt {
        border-radius: var(--radius-sm);
        padding: 12px 14px;
        background: var(--tile-2);
        border: 1px solid var(--line);
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
        touch-action: manipulation;
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      .lt ha-icon {
        color: var(--text-2);
      }
      .lt.on {
        border-color: var(--cy);
        box-shadow: 0 0 12px rgba(0, 200, 212, 0.25);
      }
      .lt.on ha-icon {
        color: var(--cy);
      }
      .ln {
        margin-top: 8px;
        font-weight: 600;
        font-size: 15px;
      }
      .ls {
        font-size: 13px;
        color: var(--text-2);
      }
      .lt.on .ls {
        color: var(--cy);
        font-weight: 600;
      }
      /* scenes */
      .srow {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(70px, 1fr));
        gap: 8px;
      }
      .scene {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        padding: 12px 4px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--line);
        background: var(--tile-2);
        color: var(--text);
        font: 600 13px var(--font);
        cursor: pointer;
      }
      .scene ha-icon {
        color: var(--accent);
      }
      .scene:active {
        transform: scale(0.95);
      }
      /* now playing */
      .np {
        display: flex;
        gap: 16px;
        align-items: center;
      }
      .npart {
        flex: 0 0 104px;
        height: 104px;
        border-radius: 16px;
        background: var(--grad) center/cover no-repeat;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
      }
      .npart ha-icon {
        --mdc-icon-size: 40px;
      }
      .npart.idle {
        opacity: 0.7;
      }
      .npinfo {
        min-width: 0;
        flex: 1;
      }
      .nptitle {
        font-size: 17px;
        font-weight: 700;
        line-height: 1.35;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .npartist {
        font-size: 14px;
        line-height: 1.4;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .nproom {
        font-size: 12px;
        color: var(--accent);
        font-weight: 600;
        margin-top: 2px;
      }
      .npctl {
        display: flex;
        gap: 10px;
        margin-top: 8px;
      }
      .round {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        border: 1px solid var(--line);
        background: var(--tile-2);
        color: var(--text);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }
      .round.main {
        background: var(--grad);
        border: none;
        color: #fff;
      }
      /* lists */
      .count {
        margin-left: auto;
        color: var(--text-2);
        font-weight: 600;
      }
      .item {
        display: flex;
        gap: 12px;
        align-items: center;
        padding: 8px 0;
        font-size: 15px;
        cursor: pointer;
        transition: opacity 0.4s;
      }
      .box {
        flex: 0 0 24px;
        height: 24px;
        border-radius: 8px;
        border: 2px solid var(--line);
        display: flex;
        align-items: center;
        justify-content: center;
        color: transparent;
      }
      .box ha-icon {
        --mdc-icon-size: 16px;
      }
      .item.done {
        opacity: 0.4;
        text-decoration: line-through;
      }
      .item.done .box {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
      .more {
        font-size: 13px;
      }
      .addbtn {
        margin-top: 6px;
        display: flex;
        align-items: center;
        gap: 6px;
        background: none;
        border: none;
        color: var(--accent);
        font: 600 14px var(--font);
        padding: 6px 0;
        cursor: pointer;
      }
      .add {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }
      .add input {
        flex: 1;
        min-width: 0;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--tile-2);
        color: var(--text);
        padding: 10px 16px;
        font: 15px var(--font);
        outline: none;
      }
      .add input:focus {
        border-color: var(--accent);
      }
      /* energy */
      .erow {
        display: flex;
        justify-content: space-between;
        gap: 12px;
      }
      .big {
        font-size: 26px;
        font-weight: 600;
      }
      .right {
        text-align: right;
      }
      .energy .muted {
        font-size: 12px;
        line-height: 1.5;
      }
      .meter {
        margin-top: 14px;
        height: 6px;
        border-radius: 3px;
        background: rgba(127, 127, 127, 0.2);
        overflow: hidden;
      }
      .meter span {
        display: block;
        height: 100%;
        background: linear-gradient(90deg, var(--cy), var(--pk));
        transition: width 0.6s;
      }
      /* bins */
      .bins {
        display: flex;
        align-items: center;
        gap: 14px;
        margin-bottom: var(--gap);
        border: 2px solid var(--bin);
        animation: binpulse 2s ease-in-out infinite;
      }
      .bins ha-icon {
        --mdc-icon-size: 30px;
        color: var(--bin);
      }
      .btxt {
        flex: 1;
        font-size: 16px;
      }
      @keyframes binpulse {
        50% {
          box-shadow: 0 0 0 3px var(--bin), 0 0 22px var(--bin);
        }
      }
    `,
  ];
}

customElements.get("panel-home") || customElements.define("panel-home", PageHome);
