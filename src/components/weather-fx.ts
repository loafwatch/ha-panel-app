import { reg } from "../registry";
import { LitElement, css, html, nothing, svg } from "lit";
import { property } from "lit/decorators.js";

/**
 * Animated weather background. Drop it inside a positioned tile:
 *   <panel-weather-fx condition="rainy" ?dark=${dark}></panel-weather-fx>
 * Colours adapt to light and dark mode; `subtle` tones it down for small tiles.
 */
export class PanelWeatherFx extends LitElement {
  @property() condition = "";
  @property({ type: Boolean, reflect: true }) dark = false;
  @property({ type: Boolean, reflect: true }) subtle = false;

  render() {
    const c = this.condition;
    const has = (re: RegExp) => re.test(c);
    const rain = has(/rain|pouring|lightning-rainy/) ? (has(/pouring/) ? 70 : 42) : 0;
    const snow = has(/snow|hail/);
    const sun = c === "sunny" || c === "partlycloudy";
    const night = c === "clear-night";
    const clouds = has(/cloud|rain|pouring|lightning|snow|hail|fog|windy|exceptional/) ? (c === "partlycloudy" ? 2 : 4) : 0;
    const fog = c === "fog";
    const wind = has(/windy/);
    const flash = has(/lightning/);
    return html`
      ${sun ? html`<div class="sun"><div class="rays"></div><div class="core"></div></div>` : nothing}
      ${night ? this.stars() : nothing}
      ${clouds ? this.clouds(clouds, rain > 0 || flash) : nothing}
      ${fog ? html`<i class="fog f1"></i><i class="fog f2"></i><i class="fog f3"></i>` : nothing}
      ${rain ? this.drops(rain) : nothing}
      ${snow ? this.flakes(36) : nothing}
      ${wind ? this.gusts() : nothing}
      ${flash ? html`<div class="flash"></div>` : nothing}
    `;
  }

  private clouds(n: number, heavy: boolean) {
    const shape = "M25 60a20 20 0 0 1 4-39.6A28 28 0 0 1 82 18a22 22 0 0 1 13 42Z";
    const layers = [
      { top: 4, w: 46, dur: 70, delay: -10, o: 1 },
      { top: 30, w: 34, dur: 52, delay: -40, o: 0.8 },
      { top: 52, w: 52, dur: 90, delay: -70, o: 0.65 },
      { top: 16, w: 28, dur: 44, delay: -22, o: 0.7 },
    ].slice(0, n);
    return layers.map(
      (l) => html`<svg
        class="cloud ${heavy ? "heavy" : ""}"
        viewBox="0 0 110 64"
        style="top:${l.top}%;width:${l.w}%;animation-duration:${l.dur}s;animation-delay:${l.delay}s;opacity:${l.o}"
      >
        ${svg`<path d=${shape} />`}
      </svg>`,
    );
  }

  private drops(n: number) {
    return Array.from({ length: n }, (_, i) => {
      const left = (i * 37.3) % 100;
      const delay = -((i * 0.173) % 1.1);
      const dur = 0.7 + ((i * 7) % 5) / 10;
      return html`<i class="drop" style="left:${left}%;animation-delay:${delay}s;animation-duration:${dur}s"></i>`;
    });
  }

  private flakes(n: number) {
    return Array.from({ length: n }, (_, i) => {
      const left = (i * 29.7) % 100;
      const size = 4 + (i % 4);
      const dur = 7 + (i % 5) * 1.3;
      return html`<i class="flake" style="left:${left}%;width:${size}px;height:${size}px;animation-duration:${dur}s,${dur / 3}s;animation-delay:${-i * 0.6}s,${-i * 0.3}s"></i>`;
    });
  }

  private stars() {
    return Array.from({ length: 34 }, (_, i) => {
      const left = (i * 41.7) % 100;
      const top = (i * 23.9) % 85;
      const size = 2 + (i % 3);
      return html`<i class="star" style="left:${left}%;top:${top}%;width:${size}px;height:${size}px;animation-delay:${-(i % 7) * 0.7}s"></i>`;
    });
  }

  private gusts() {
    return Array.from({ length: 7 }, (_, i) => html`<i class="gust" style="top:${12 + i * 12}%;animation-delay:${-i * 0.9}s;animation-duration:${3 + (i % 3)}s"></i>`);
  }

  static styles = css`
    :host {
      position: absolute;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
      border-radius: inherit;
      z-index: 0;
      --cloud: rgba(110, 96, 150, 0.2);
      --cloud-heavy: rgba(80, 70, 110, 0.28);
      --rain: rgba(0, 150, 170, 0.6);
      --snow: rgba(120, 140, 185, 0.8);
      --sun: rgba(255, 160, 30, 0.55);
      --sun-core: rgba(255, 190, 60, 0.9);
      --star: rgba(122, 27, 209, 0.55);
      --fog: rgba(140, 130, 165, 0.25);
      --gust: rgba(122, 27, 209, 0.25);
      --flash: rgba(255, 255, 255, 0.85);
    }
    :host([dark]) {
      --cloud: rgba(215, 205, 245, 0.16);
      --cloud-heavy: rgba(160, 150, 200, 0.24);
      --rain: rgba(0, 229, 240, 0.6);
      --snow: rgba(255, 255, 255, 0.9);
      --sun: rgba(255, 170, 50, 0.4);
      --sun-core: rgba(255, 200, 80, 0.85);
      --star: rgba(255, 255, 255, 0.9);
      --fog: rgba(200, 190, 230, 0.16);
      --gust: rgba(255, 255, 255, 0.22);
      --flash: rgba(200, 220, 255, 0.4);
    }
    :host([subtle]) {
      opacity: 0.65;
    }
    i {
      position: absolute;
      display: block;
    }

    /* clouds drift right to left across the tile */
    .cloud {
      position: absolute;
      left: 100%;
      fill: var(--cloud);
      animation: drift linear infinite;
    }
    .cloud.heavy {
      fill: var(--cloud-heavy);
    }
    @keyframes drift {
      to {
        left: -60%;
      }
    }

    /* rain */
    .drop {
      top: -20%;
      width: 2px;
      height: 18px;
      border-radius: 2px;
      background: linear-gradient(transparent, var(--rain));
      transform: rotate(12deg);
      animation: fall linear infinite;
    }
    @keyframes fall {
      to {
        transform: translate(-28px, 360px) rotate(12deg);
      }
    }
    :host([subtle]) .drop {
      height: 12px;
    }

    /* snow */
    .flake {
      top: -6%;
      border-radius: 50%;
      background: var(--snow);
      animation: snowfall linear infinite, sway ease-in-out infinite alternate;
    }
    @keyframes snowfall {
      to {
        top: 106%;
      }
    }
    @keyframes sway {
      from {
        margin-left: -12px;
      }
      to {
        margin-left: 12px;
      }
    }

    /* sun: warm glow with slowly turning rays */
    .sun {
      position: absolute;
      top: -90px;
      right: -90px;
      width: 300px;
      height: 300px;
    }
    .core {
      position: absolute;
      inset: 90px;
      border-radius: 50%;
      background: radial-gradient(circle, var(--sun-core), transparent 70%);
      animation: pulse 5s ease-in-out infinite;
    }
    .rays {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      background: repeating-conic-gradient(var(--sun) 0 6deg, transparent 6deg 20deg);
      -webkit-mask: radial-gradient(circle, transparent 28%, #000 32%, transparent 70%);
      mask: radial-gradient(circle, transparent 28%, #000 32%, transparent 70%);
      animation: turn 40s linear infinite;
    }
    @keyframes turn {
      to {
        transform: rotate(360deg);
      }
    }
    @keyframes pulse {
      50% {
        transform: scale(1.12);
        opacity: 0.8;
      }
    }

    /* clear night */
    .star {
      border-radius: 50%;
      background: var(--star);
      animation: twinkle 3.5s ease-in-out infinite;
    }
    @keyframes twinkle {
      50% {
        opacity: 0.15;
        transform: scale(0.6);
      }
    }

    /* fog bands */
    .fog {
      left: -50%;
      width: 200%;
      height: 26%;
      border-radius: 50%;
      background: var(--fog);
      filter: blur(14px);
      animation: band 18s ease-in-out infinite alternate;
    }
    .f1 {
      top: 20%;
    }
    .f2 {
      top: 48%;
      animation-duration: 24s;
      animation-direction: alternate-reverse;
    }
    .f3 {
      top: 72%;
      animation-duration: 30s;
    }
    @keyframes band {
      to {
        transform: translateX(22%);
      }
    }

    /* wind */
    .gust {
      left: 100%;
      width: 30%;
      height: 2px;
      border-radius: 2px;
      background: linear-gradient(90deg, transparent, var(--gust), transparent);
      animation: gust linear infinite;
    }
    @keyframes gust {
      to {
        transform: translateX(-450%);
      }
    }

    /* lightning */
    .flash {
      position: absolute;
      inset: 0;
      background: var(--flash);
      opacity: 0;
      animation: flash 7s infinite;
    }
    @keyframes flash {
      0%,
      90%,
      93%,
      96%,
      100% {
        opacity: 0;
      }
      91%,
      95% {
        opacity: 1;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      * {
        animation: none !important;
      }
    }
  `;
}

reg("panel-weather-fx", PanelWeatherFx);
