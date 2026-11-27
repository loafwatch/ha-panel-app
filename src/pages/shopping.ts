import { reg } from "../registry";
import { css, html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { PageBase } from "./base";
import { call } from "../util";

/** Shopping (and any other to-do lists from `todo_lists`): tick items off, add new ones. */
export class PageShopping extends PageBase {
  protected usesHub = true;
  @state() private adding: string | null = null;
  @state() private done = new Set<string>();

  protected watched() {
    return (this.config.todo_lists ?? []).map((l) => l.entity);
  }

  render() {
    const lists = this.config.todo_lists ?? [];
    if (!lists.length) return html`<div class="page"><div class="empty">No lists configured.</div></div>`;
    return html`<div class="page">
      <div class="lists">
        ${lists.map((l) => {
          const items = (this.hub.todos[l.entity] ?? []).filter((i) => i.status === "needs_action");
          return html`<div class="tile list">
            <div class="label"><ha-icon icon=${l.icon ?? "mdi:format-list-checks"}></ha-icon>${l.name}<span class="count">${items.length || ""}</span></div>
            ${this.adding === l.entity
              ? html`<form class="add" @submit=${(e: Event) => this.add(e, l.entity)}>
                  <input id="add-${l.entity}" placeholder="Add an item…" autocomplete="off" enterkeyhint="done" />
                  <button class="btn primary" type="submit">Add</button>
                  <button class="btn" type="button" @click=${() => (this.adding = null)}>Cancel</button>
                </form>`
              : html`<button class="btn primary addbtn" @click=${() => this.openAdd(l.entity)}><ha-icon icon="mdi:plus"></ha-icon>Add an item</button>`}
            ${items.length
              ? html`<div class="items">
                  ${items.map(
                    (i) => html`<button class="item ${this.done.has(i.uid) ? "done" : ""}" @click=${() => this.complete(l.entity, i.uid)}>
                      <span class="box"><ha-icon icon="mdi:check"></ha-icon></span><span>${i.summary}</span>
                    </button>`,
                  )}
                </div>`
              : this.adding !== l.entity
                ? html`<div class="empty">All done</div>`
                : nothing}
          </div>`;
        })}
      </div>
    </div>`;
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
    if (input) input.value = "";
    input?.focus();
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

  static styles = [
    PageBase.styles,
    css`
      .page {
        max-width: 1100px;
        margin: 0 auto;
      }
      .lists {
        display: flex;
        flex-direction: column;
        gap: var(--gap);
        padding-bottom: 100px;
      }
      .count {
        margin-left: auto;
        color: var(--text-2);
        font-weight: 600;
      }
      .addbtn {
        margin: 4px 0 14px;
      }
      .items {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
        gap: 8px;
      }
      .item {
        display: flex;
        gap: 14px;
        align-items: center;
        padding: 14px 16px;
        border-radius: var(--radius-sm);
        border: 0;
        background: var(--tile-2);
        color: var(--text);
        font: 17px var(--font);
        text-align: left;
        cursor: pointer;
        transition: opacity 0.4s;
      }
      .box {
        flex: 0 0 26px;
        height: 26px;
        border-radius: 8px;
        border: 2px solid var(--line);
        display: flex;
        align-items: center;
        justify-content: center;
        color: transparent;
        --mdc-icon-size: 18px;
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
      .add {
        display: flex;
        gap: 8px;
        margin: 4px 0 14px;
      }
      .add input {
        flex: 1;
        min-width: 0;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--tile-2);
        color: var(--text);
        padding: 12px 18px;
        font: 17px var(--font);
        outline: none;
      }
      .add input:focus {
        border-color: var(--accent);
      }
    `,
  ];
}

reg("panel-shopping", PageShopping);
