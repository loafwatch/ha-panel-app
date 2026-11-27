import { css } from "lit";

/** Design tokens: soft synthwave tiles, with light and dark variants. */
export const tokens = css`
  :host {
    --pk: #ff2e97;
    --pu: #7a1bd1;
    --cy: #00c8d4;
    --cy-bright: #00e5f0;
    --grad: linear-gradient(135deg, var(--pk), var(--pu) 70%, #00a3ae);
    --radius: 22px;
    --radius-sm: 14px;
    --gap: 16px;
    --font: Roboto, "Segoe UI", system-ui, sans-serif;

    /* light */
    --bg: #f5f2fa;
    --bg-2: #ebe5f4;
    --tile: #ffffff;
    --tile-2: #f6f2fb;
    --line: rgba(60, 20, 90, 0.12);
    --text: #1d1428;
    --text-2: #6c6178;
    --glow: 0 1px 2px rgba(40, 10, 70, 0.06), 0 6px 18px rgba(40, 10, 70, 0.08);
    --accent: var(--pu);
    --accent-soft: rgba(122, 27, 209, 0.1);
    --dock: rgba(255, 255, 255, 0.82);
  }
  :host([dark]) {
    --bg: #120a1e;
    --bg-2: #1a1029;
    --tile: #1d1230;
    --tile-2: #251838;
    --line: rgba(255, 46, 151, 0.22);
    --text: #f4eefb;
    --text-2: #a99bbd;
    --glow: 0 0 0 1px rgba(255, 46, 151, 0.18), 0 0 18px rgba(255, 46, 151, 0.12);
    --accent: var(--pk);
    --accent-soft: rgba(255, 46, 151, 0.14);
    --dock: rgba(29, 18, 48, 0.82);
  }
`;

/** Shared component styles used by every page. */
export const shared = css`
  * {
    box-sizing: border-box;
  }
  .tile {
    background: var(--tile);
    border-radius: var(--radius);
    box-shadow: var(--glow);
    padding: 18px 20px;
    position: relative;
    overflow: hidden;
    color: var(--text);
    -webkit-tap-highlight-color: transparent;
  }
  .tile.tap {
    cursor: pointer;
    transition: transform 0.12s ease;
  }
  .tile.tap:active {
    transform: scale(0.98);
  }
  .label {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    margin: 0 0 10px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .muted {
    color: var(--text-2);
  }
  .page {
    container-type: inline-size;
    height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    padding: var(--page-pad-top, 24px) 28px 124px;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    scrollbar-width: none;
  }
  .page::-webkit-scrollbar {
    display: none;
  }
  .page-title {
    font-size: 28px;
    font-weight: 700;
    margin: 4px 0 18px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 9px 16px;
    border-radius: 999px;
    font-size: 14px;
    font-weight: 600;
    border: 1px solid var(--line);
    background: var(--tile-2);
    color: var(--text);
    cursor: pointer;
    user-select: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  .chip.on {
    border: 2px solid var(--accent);
    font-weight: 700;
    box-shadow: 0 0 10px var(--accent-soft);
  }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border: 1px solid var(--line);
    background: var(--tile-2);
    color: var(--text);
    border-radius: 999px;
    padding: 10px 18px;
    font: 600 15px var(--font);
    cursor: pointer;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    transition: transform 0.12s;
  }
  .btn:active {
    transform: scale(0.95);
  }
  .btn.primary {
    background: var(--grad);
    border-color: transparent;
    color: #fff;
  }
  ha-icon {
    --mdc-icon-size: 22px;
  }
  .empty {
    color: var(--text-2);
    font-size: 14px;
    padding: 6px 0;
  }
  input[type="range"] {
    touch-action: pan-y;
    -webkit-appearance: none;
    appearance: none;
    height: 8px;
    border-radius: 4px;
    outline: none;
    background: linear-gradient(90deg, var(--pk) 0, var(--cy) var(--v, 50%), rgba(127, 127, 127, 0.28) var(--v, 50%));
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--tile);
    border: 3px solid var(--accent);
    box-shadow: 0 0 8px var(--accent-soft);
    cursor: pointer;
  }
  input[type="range"]::-moz-range-thumb {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--tile);
    border: 3px solid var(--accent);
  }
`;
