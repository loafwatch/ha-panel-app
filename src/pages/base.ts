import { LitElement, type CSSResultGroup, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import type { DataHub } from "../data";
import type { HomeAssistant, PageId, PanelConfig } from "../types";
import { shared, tokens } from "../styles";

/**
 * Base for every page. Re-renders only when an entity the page cares about
 * changes (Home Assistant pushes a new `hass` on *every* state change in the
 * house), when the page becomes active, or when shared data changes.
 */
export abstract class PageBase extends LitElement {
  static styles: CSSResultGroup = [tokens, shared];

  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) config!: PanelConfig;
  @property({ attribute: false }) hub!: DataHub;
  @property({ type: Boolean, reflect: true }) active = false;
  @property({ type: Boolean, reflect: true }) dark = false;

  /** Entities whose changes should re-render this page. */
  protected abstract watched(): string[];
  /** Whether this page uses DataHub data (forecast, to-dos, calendar). */
  protected usesHub = false;
  /** Re-render every second while active (clocks, countdowns). */
  protected ticks = false;

  private tick?: number;
  private onHub = () => this.requestUpdate();

  connectedCallback() {
    super.connectedCallback();
    if (this.usesHub) this.hub?.addEventListener("change", this.onHub);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.hub?.removeEventListener("change", this.onHub);
    window.clearInterval(this.tick);
  }

  protected navigate(page: PageId | "photos") {
    this.dispatchEvent(new CustomEvent("panel-navigate", { detail: page, bubbles: true, composed: true }));
  }

  protected toast(msg: string) {
    this.dispatchEvent(new CustomEvent("panel-toast", { detail: msg, bubbles: true, composed: true }));
  }

  protected shouldUpdate(changed: PropertyValues): boolean {
    if (!this.hass) return false;
    if (changed.size !== 1 || !changed.has("hass")) return true;
    const old = changed.get("hass") as HomeAssistant | undefined;
    if (!old) return true;
    if (!this.active) return false;
    return this.watched().some((id) => old.states[id] !== this.hass.states[id]);
  }

  protected updated(changed: PropertyValues) {
    if (changed.has("hub") && this.usesHub) {
      (changed.get("hub") as DataHub | undefined)?.removeEventListener("change", this.onHub);
      this.hub?.addEventListener("change", this.onHub);
    }
    if (changed.has("active") && this.ticks) {
      window.clearInterval(this.tick);
      if (this.active) this.tick = window.setInterval(() => this.requestUpdate(), 1000);
    }
  }

  protected st(id?: string) {
    return id ? this.hass.states[id] : undefined;
  }
}
