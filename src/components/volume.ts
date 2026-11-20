import { reg } from "../registry";
import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../types";

/**
 * Compact volume pill for a `number` entity (e.g. the tablet's media volume).
 * Minus / level bar / plus; the bar is tappable to jump to a level.
 */
export class PanelVolume extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @property() entity = "";
  /** Local value while a change is in flight, so taps feel instant. */
  @state() private pending?: number;
  private sendTimer?: number;
  private clearTimer?: number;

  private get st() {
    return this.entity ? this.hass?.states[this.entity] : undefined;
  }

  private get range() {
    const a = this.st?.attributes ?? {};
    return { min: Number(a.min ?? 0), max: Number(a.max ?? 15), step: Number(a.step ?? 1) };
  }

  private get value() {
    if (this.pending !== undefined) return this.pending;
    const v = Number(this.st?.state);
    return Number.isFinite(v) ? v : this.range.min;
  }

  private set(v: number) {
    const { min, max } = this.range;
    const nv = Math.max(min, Math.min(max, Math.round(v)));
    this.pending = nv;
    clearTimeout(this.sendTimer);
    clearTimeout(this.clearTimer);
    this.sendTimer = window.setTimeout(() => {
      this.hass?.callService("number", "set_value", { value: nv }, { entity_id: this.entity });
      this.clearTimer = window.setTimeout(() => (this.pending = undefined), 2500);
    }, 250);
  }

  private tapBar(e: PointerEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const { min, max } = this.range;
    this.set(min + ((e.clientX - r.left) / r.width) * (max - min));
  }

  render() {
    if (!this.st) return nothing;
    const { min, max, step } = this.range;
    const v = this.value;
    const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
    const icon = v <= min ? "mdi:volume-off" : pct < 40 ? "mdi:volume-low" : pct < 75 ? "mdi:volume-medium" : "mdi:volume-high";
    return html`<div class="pill" @click=${(e: Event) => e.stopPropagation()}>
      <button aria-label="Volume down" @click=${() => this.set(v - step)}><ha-icon icon="mdi:minus"></ha-icon></button>
      <ha-icon class="ic" icon=${icon}></ha-icon>
      <div class="bar" role="slider" aria-label="Volume" aria-valuenow=${v} aria-valuemin=${min} aria-valuemax=${max} @pointerdown=${this.tapBar}>
        <i style="width:${pct}%"></i>
      </div>
      <button aria-label="Volume up" @click=${() => this.set(v + step)}><ha-icon icon="mdi:plus"></ha-icon></button>
    </div>`;
  }

  static styles = css`
    :host {
      display: inline-block;
    }
    .pill {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px;
      border-radius: 999px;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(8px);
      color: #fff;
    }
    button {
      display: grid;
      place-items: center;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: 0;
      background: rgba(255, 255, 255, 0.14);
      color: #fff;
      cursor: pointer;
      --mdc-icon-size: 26px;
      -webkit-tap-highlight-color: transparent;
    }
    .ic {
      --mdc-icon-size: 24px;
      opacity: 0.9;
    }
    .bar {
      position: relative;
      width: 160px;
      height: 10px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.2);
      cursor: pointer;
      touch-action: none;
    }
    .bar::before {
      content: "";
      position: absolute;
      inset: -16px 0;
    }
    .bar i {
      position: absolute;
      inset: 0 auto 0 0;
      border-radius: 999px;
      background: #fff;
      transition: width 0.15s;
    }
  `;
}

reg("panel-volume", PanelVolume);
