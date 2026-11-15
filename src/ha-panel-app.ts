import { LitElement, css, html } from "lit";
import { property, state } from "lit/decorators.js";
import type { HomeAssistant, PanelInfo } from "./types";

export const VERSION = "0.0.1";

/**
 * Root element registered as a Home Assistant custom panel.
 * Home Assistant sets `hass` on every state change and `panel` once.
 */
export class HaPanelApp extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @property({ attribute: false }) panel?: PanelInfo;
  @property({ type: Boolean }) narrow = false;

  @state() private now = new Date();
  private timer?: number;

  connectedCallback(): void {
    super.connectedCallback();
    this.timer = window.setInterval(() => (this.now = new Date()), 1000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.timer);
  }

  render() {
    const rooms = this.panel?.config?.rooms ?? [];
    const connected = !!this.hass;
    return html`
      <main>
        <div class="clock">${this.now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</div>
        <div class="status">
          <span class="dot ${connected ? "ok" : ""}"></span>
          ${connected ? "Connected to Home Assistant" : "Waiting for Home Assistant…"}
        </div>
        <div class="meta">ha-panel-app v${VERSION} · ${rooms.length} room${rooms.length === 1 ? "" : "s"} configured</div>
      </main>
    `;
  }

  static styles = css`
    :host {
      display: block;
      height: 100%;
      min-height: 100vh;
      background: var(--primary-background-color);
      color: var(--primary-text-color);
      font-family: var(--paper-font-body1_-_font-family, Roboto, system-ui, sans-serif);
    }
    main {
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 14px;
    }
    .clock {
      font-size: 96px;
      font-weight: 300;
      letter-spacing: -0.02em;
    }
    .status {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 18px;
    }
    .dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--error-color, #db4437);
    }
    .dot.ok {
      background: var(--success-color, #43a047);
      box-shadow: 0 0 10px var(--success-color, #43a047);
    }
    .meta {
      font-size: 13px;
      color: var(--secondary-text-color);
    }
  `;
}

// Guard against double registration (the file may also be loaded as a dashboard resource).
if (!customElements.get("ha-panel-app")) customElements.define("ha-panel-app", HaPanelApp);

declare global {
  interface HTMLElementTagNameMap {
    "ha-panel-app": HaPanelApp;
  }
}
