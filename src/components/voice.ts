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
      return !old || [v.satellite, v.stt, v.tts].some((id) => id && old.states[id] !== this.hass.states[id]);
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

  render() {
    const v = this.config?.voice;
    if (!v || !this.visible) return nothing;
    const s = this.hass.states[v.satellite]?.state ?? "idle";
    const heard = v.stt ? this.hass.states[v.stt]?.state : "";
    const reply = v.tts ? this.hass.states[v.tts]?.state : "";
    const ok = (x?: string) => x && !["unknown", "unavailable", ""].includes(x);
    const showHeard = s !== "listening" && ok(heard);
    const showReply = (s === "responding" || s === "idle") && ok(reply);
    return html`
      <div class="ov" @click=${() => (this.visible = false)}>
        <div class="orb s-${s}"><i></i><i></i><i></i></div>
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
        gap: 22px;
        padding: 40px;
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
      .orb {
        position: relative;
        width: 150px;
        height: 150px;
      }
      .orb i {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        background: radial-gradient(circle at 35% 30%, #fff 0, var(--pk) 30%, var(--pu) 65%, transparent 72%);
        box-shadow: 0 0 40px var(--pk), 0 0 80px rgba(122, 27, 209, 0.6);
      }
      .orb i:nth-child(2),
      .orb i:nth-child(3) {
        background: none;
        border: 2px solid rgba(0, 229, 240, 0.7);
        box-shadow: 0 0 18px rgba(0, 229, 240, 0.5);
      }
      .s-listening i:first-child {
        animation: breathe 1.4s ease-in-out infinite;
      }
      .s-listening i:nth-child(2) {
        animation: ripple 1.6s ease-out infinite;
      }
      .s-listening i:nth-child(3) {
        animation: ripple 1.6s ease-out 0.8s infinite;
      }
      .s-processing i:first-child {
        animation: spin 1.2s linear infinite;
        background: conic-gradient(from 0deg, var(--pk), var(--pu), var(--cy-bright), var(--pk));
        -webkit-mask: radial-gradient(circle, transparent 52%, #000 54%);
        mask: radial-gradient(circle, transparent 52%, #000 54%);
      }
      .s-processing i:nth-child(2),
      .s-processing i:nth-child(3),
      .s-idle i:nth-child(2),
      .s-idle i:nth-child(3) {
        display: none;
      }
      .s-responding i:first-child {
        animation: talk 0.5s ease-in-out infinite alternate;
      }
      .s-responding i:nth-child(2) {
        animation: ripple 1.2s ease-out infinite;
      }
      .s-responding i:nth-child(3) {
        display: none;
      }
      @keyframes breathe {
        50% {
          transform: scale(1.08);
        }
      }
      @keyframes ripple {
        from {
          transform: scale(0.9);
          opacity: 0.9;
        }
        to {
          transform: scale(1.7);
          opacity: 0;
        }
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      @keyframes talk {
        to {
          transform: scale(1.12);
        }
      }
      .status {
        font-size: 18px;
        color: rgba(255, 255, 255, 0.75);
        min-height: 22px;
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
