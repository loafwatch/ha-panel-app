// Custom elements are queued here and only registered once the entry point has
// confirmed this is the newest copy of the app (see ha-panel-app.ts).
const queue: [string, CustomElementConstructor][] = [];

export function reg(tag: string, cls: CustomElementConstructor) {
  queue.push([tag, cls]);
}

export function defineAll() {
  for (const [tag, cls] of queue) if (!customElements.get(tag)) customElements.define(tag, cls);
}
