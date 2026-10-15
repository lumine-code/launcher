const { Disposable } = require("lumine");

class ProviderRegistry {
  constructor(onDidChange) {
    this.records = new Map();
    this.onDidChange = onDidChange;
    this.disposed = false;
  }

  add(provider) {
    if (this.disposed) return new Disposable();
    if (
      !provider ||
      typeof provider.id !== "string" ||
      !provider.id.trim() ||
      typeof provider.label !== "string" ||
      !provider.label.trim() ||
      typeof provider.create !== "function" ||
      (provider.order != null && !Number.isFinite(provider.order))
    ) {
      throw new TypeError("A launcher provider requires id, label and create.");
    }
    if (this.records.has(provider.id)) {
      throw new Error(`A launcher provider with ID '${provider.id}' is already registered.`);
    }
    const record = {
      provider: {
        id: provider.id,
        label: provider.label,
        order: provider.order ?? 100,
        create: provider.create.bind(provider),
      },
      controller: new AbortController(),
    };
    this.records.set(provider.id, record);
    this.onDidChange();
    return new Disposable(() => {
      if (this.records.get(provider.id) !== record) return;
      this.records.delete(provider.id);
      record.controller.abort();
      this.onDidChange();
    });
  }

  get(id) {
    return this.records.get(id);
  }

  choices() {
    return [...this.records.values()]
      .sort(
        (a, b) =>
          a.provider.order - b.provider.order || a.provider.label.localeCompare(b.provider.label),
      )
      .map(({ provider: { id, label } }) => ({ id, label }));
  }

  dispose() {
    this.disposed = true;
    for (const record of this.records.values()) record.controller.abort();
    this.records.clear();
  }
}

module.exports = ProviderRegistry;
