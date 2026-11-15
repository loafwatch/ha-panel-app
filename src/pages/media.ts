import { css, html } from "lit";
import { state } from "lit/decorators.js";
import { PageBase } from "./base";

/** Embeds a media server's web app (e.g. Jellyfin). Loaded on first visit only. */
export class PageMedia extends PageBase {
  @state() private visited = false;

  protected watched() {
    return [];
  }

  protected updated(c: Map<string, unknown>) {
    super.updated(c as any);
    if (this.active && !this.visited) this.visited = true;
  }

  render() {
    const m = this.config.media;
    if (!m?.url) return html`<div class="page"><div class="empty">No media server configured.</div></div>`;
    return html`<div class="wrap">
      ${this.visited
        ? html`<iframe src=${m.url} allow="autoplay; fullscreen; encrypted-media" allowfullscreen title=${m.title ?? "Media"}></iframe>`
        : html`<div class="empty">Loading…</div>`}
    </div>`;
  }

  static styles = [
    PageBase.styles,
    css`
      .wrap {
        position: absolute;
        inset: 0 0 84px 0;
        background: #101010;
      }
      iframe {
        width: 100%;
        height: 100%;
        border: 0;
        display: block;
      }
    `,
  ];
}

customElements.get("panel-media") || customElements.define("panel-media", PageMedia);
