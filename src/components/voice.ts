import { reg } from "../registry";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { tokens } from "../styles";
import type { HomeAssistant, PanelConfig } from "../types";

/** Full-screen voice assistant overlay, driven directly by the satellite's state. */
export class PanelVoice extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) config!: PanelConfig;
  @property({ type: Boolean, reflect: true }) dark = false;
  @state() private visible = false;
  private hideTimer?: number;
  private lastState = "idle";

  /** Linger after the assistant finishes so the reply can be read. */
  static LINGER_MS = 4000;

  protected shouldUpdate(changed: PropertyValues) {
    if (changed.size === 1 && changed.has("hass")) {
      const v = this.config?.voice;
      if (!v) return false;
      const old = changed.get("hass") as HomeAssistant | undefined;
      return !old || [v.satellite, v.stt, v.tts, this.config?.voice_match?.status_sensor].some((id) => id && old.states[id] !== this.hass.states[id]);
    }
    return true;
  }

  protected willUpdate() {
    const v = this.config?.voice;
    if (!v) return;
    const s = this.hass.states[v.satellite]?.state ?? "idle";
    if (s !== this.lastState) {
      // Only open for a real conversation (listening), not for announcements.
      if (s === "listening") {
        window.clearTimeout(this.hideTimer);
        this.visible = true;
      } else if (s === "idle" && this.visible) {
        window.clearTimeout(this.hideTimer);
        this.hideTimer = window.setTimeout(() => (this.visible = false), PanelVoice.LINGER_MS);
      }
      this.lastState = s;
    }
  }

  get open() {
    return this.visible;
  }

  /** The satellite's "interrupt" button: from config, or the View Assist Companion App
   *  convention (assist_satellite.vaca_x -> button.vaca_x_interrupt) if that entity exists. */
  private get interruptButton(): string | undefined {
    const v = this.config?.voice;
    if (!v) return undefined;
    if (v.interrupt) return v.interrupt;
    const guess = v.satellite.replace(/^assist_satellite\./, "button.") + "_interrupt";
    return this.hass.states[guess] ? guess : undefined;
  }

  /** Tapping the overlay stops the assistant straight away (listening, thinking or
   *  speaking) and closes the overlay. */
  private tap(state: string) {
    this.visible = false;
    window.clearTimeout(this.hideTimer);
    const btn = this.interruptButton;
    if (btn && state !== "idle") {
      this.hass.callService("button", "press", { entity_id: btn }).catch(() => {});
    }
  }

  /** During voice enrolment the Settings page shows the sentence to read; don't cover it. */
  private get enrolling() {
    const id = this.config?.voice_match?.status_sensor;
    return !!id && this.hass.states[id]?.state === "active";
  }

  render() {
    const v = this.config?.voice;
    if (!v || !this.visible || this.enrolling) return nothing;
    const s = this.hass.states[v.satellite]?.state ?? "idle";
    const heard = v.stt ? this.hass.states[v.stt]?.state : "";
    const reply = v.tts ? this.hass.states[v.tts]?.state : "";
    const ok = (x?: string) => x && !["unknown", "unavailable", ""].includes(x);
    const showHeard = s !== "listening" && ok(heard);
    const showReply = (s === "responding" || s === "idle") && ok(reply);
    return html`
      <div class="ov s-${s}" @click=${() => this.tap(s)}>
        <div class="edge soft"><i></i></div>
        <div class="edge"><i></i></div>
        <div class="bars">${[0, 1, 2, 3, 4].map((i) => html`<i style="--i:${i}"></i>`)}</div>
        <div class="status">${s === "listening" ? "Listening…" : s === "processing" ? "Thinking…" : ""}</div>
        ${showHeard ? html`<div class="heard">“${heard}”</div>` : nothing}
        ${showReply ? html`<div class="reply">${reply}</div>` : nothing}
      </div>
    `;
  }

  static styles = [
    tokens,
    css`
      .ov {
        position: fixed;
        inset: 0;
        z-index: 50;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 18px;
        padding: 60px;
        background: rgba(10, 4, 20, 0.62);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        color: #fff;
        text-align: center;
        animation: fade 0.25s ease-out;
        font-family: var(--font);
      }
      @keyframes fade {
        from {
          opacity: 0;
        }
      }

      /* glowing screen edge: a rotating conic gradient clipped to a ring */
      .edge {
        position: absolute;
        inset: 0;
        padding: 7px;
        overflow: hidden;
        pointer-events: none;
        -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
        -webkit-mask-composite: xor;
        mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
        transition: opacity 0.6s;
      }
      .edge.soft {
        padding: 30px;
        opacity: 0.4;
      }
      .edge i {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 200vmax;
        height: 200vmax;
        margin: -100vmax 0 0 -100vmax;
        background: conic-gradient(#ff2e97, #7a1bd1, #00c8d4, #ff6ec7, #ff2e97);
        animation: spin 4s linear infinite;
      }
      .s-processing .edge i {
        animation-duration: 1.6s;
      }
      .s-idle .edge {
        opacity: 0.25;
      }
      .s-idle .edge.soft {
        opacity: 0.1;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      /* sound bars */
      .bars {
        display: flex;
        align-items: center;
        gap: 16px;
        height: 170px;
      }
      .bars i {
        width: 24px;
        height: 160px;
        border-radius: 12px;
        background: linear-gradient(#ff2e97, #7a1bd1 55%, #00c8d4);
        transform: scaleY(0.18);
        animation: bounce 1s ease-in-out infinite;
        animation-delay: calc(var(--i) * -0.23s - (var(--i) * var(--i)) * 0.05s);
      }
      .s-listening .bars i {
        animation-duration: calc(0.8s + var(--i) * 0.07s);
      }
      .s-processing .bars i {
        animation: wave 1.1s ease-in-out infinite;
        animation-delay: calc(var(--i) * 0.12s);
      }
      .s-responding .bars i {
        animation-duration: calc(0.42s + var(--i) * 0.05s);
      }
      .s-idle .bars i {
        animation: none;
        transform: scaleY(0.12);
        transition: transform 0.5s;
      }
      @keyframes bounce {
        0%,
        100% {
          transform: scaleY(0.18);
        }
        50% {
          transform: scaleY(1);
        }
      }
      @keyframes wave {
        0%,
        100% {
          transform: scaleY(0.15);
        }
        30% {
          transform: scaleY(0.5);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .edge i,
        .bars i {
          animation: none !important;
        }
      }
      .status {
        margin-top: 36px;
        font-size: 36px;
        font-weight: 500;
        letter-spacing: 0.01em;
        color: #fff;
        min-height: 44px;
      }
      .s-responding .status,
      .s-idle .status {
        display: none;
      }
      .heard {
        font-size: 24px;
        color: rgba(255, 255, 255, 0.8);
        max-width: 900px;
        line-height: 1.4;
      }
      .reply {
        font-size: 28px;
        font-weight: 600;
        max-width: 900px;
        line-height: 1.45;
        white-space: normal;
      }
    `,
  ];
}

reg("panel-voice", PanelVoice);
