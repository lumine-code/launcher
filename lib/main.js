const fs = require("node:fs/promises");
const path = require("node:path");
const { CompositeDisposable, Disposable } = require("lumine");

const COMMANDS = {
  "open-with:open": {
    description: "Open the target with the selected or default opener.",
    destination: "current",
  },
  "open-with:new-window": {
    description: "Open the target in a separate project window.",
    destination: "new-window",
  },
  "open-with:detached-window": {
    description: "Open the file in another window sharing this workspace.",
    destination: "detached-window",
  },
  "open-with:this-window": {
    description: "Switch this workspace to the target's project and open it.",
    destination: "this-window",
  },
};

function abortIfNeeded(signal) {
  if (signal?.aborted) {
    const error = new Error("Opening was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function supports(choice, destination) {
  if (destination === "this-window") {
    return (
      choice.destinations.includes("current") &&
      choice.destinations.some((value) => value !== "current")
    );
  }
  return choice.destinations.includes(destination);
}

class OpenWithPackage {
  activate() {
    this.disposables = new CompositeDisposable();
    this.treeConnections = new Set();
    this.pickers = new Map();
    this.requests = new Map();
    this.operations = new Set();
    const commands = {
      "open-with:toggle": {
        description: "Choose how and where to open the selected file or folder.",
        didDispatch: (event) => this.toggle(event),
      },
    };
    for (const [command, { description, destination }] of Object.entries(COMMANDS)) {
      commands[command] = {
        description,
        didDispatch: (event) => this.openDefault(event, destination),
      };
    }
    this.disposables.add(lumine.commands.add("lumine-workspace", commands));
  }

  async deactivate() {
    const pickers = [...this.pickers.values()];
    this.disposables.dispose();
    this.disposables = null;
    for (const controller of this.operations) controller.abort();
    this.operations.clear();
    this.treeConnections.clear();
    this.treeView = null;
    this.pickers.clear();
    for (const { controller } of this.requests.values()) controller.abort();
    this.requests.clear();
    await Promise.all(pickers.map(({ host }) => host.destroy()));
  }

  consumeTreeViewSelection(service) {
    const connections = this.treeConnections;
    if (!this.disposables || this.disposables.disposed) return new Disposable();
    const record = { service };
    connections.add(record);
    this.treeView = service;
    return new Disposable(() => {
      connections.delete(record);
      if (this.treeConnections === connections) {
        this.treeView = [...connections].at(-1)?.service ?? null;
      }
    });
  }

  provideBackgroundTips() {
    return {
      packageName: "open-with",
      tips: [
        "{% if keys['open-with:toggle'] %}Use {{ 'open-with:toggle' | keystroke }} to choose how and where a file or folder opens.{% else %}Choose Open With in the tree view to select how and where a file or folder opens.{% endif %}",
      ],
    };
  }

  async resolveContext(event, signal) {
    const owner = this.disposables;
    const target = event?.target ?? lumine.workspace.getElement();
    const window = lumine.workspace.getWindowForElement(target);
    if (!window || window.isDestroyed()) return null;
    let targetPath;
    if (target.closest?.(".tree-view")) {
      const paths = this.treeView?.selectedPaths() ?? [];
      if (paths.length === 0) return null;
      if (paths.length !== 1) {
        lumine.notifications.addWarning("Select one file or folder to open.");
        return null;
      }
      [targetPath] = paths;
    } else {
      const editor = target.closest?.("lumine-text-editor:not([mini])")?.getModel?.();
      const item = editor ?? window.getEditorContainer().getActivePaneItem();
      if (!item) return null;
      targetPath = item.getPath?.();
      if (!targetPath) {
        lumine.notifications.addWarning("The active item has no saved file or folder.");
        return null;
      }
    }
    try {
      const stat = await fs.stat(targetPath);
      abortIfNeeded(signal);
      if (this.disposables !== owner || owner?.disposed) return null;
      if (!stat.isFile() && !stat.isDirectory()) {
        lumine.notifications.addWarning("Select a regular file or folder to open.");
        return null;
      }
      if (window.isDestroyed()) return null;
      return {
        path: targetPath,
        pathKind: stat.isDirectory() ? "directory" : "file",
        window,
        pane: window.getEditorContainer().getActivePane(),
      };
    } catch (error) {
      if (signal?.aborted || this.disposables !== owner || owner?.disposed) return null;
      lumine.notifications.addWarning("The selected path is unavailable.", {
        detail: `${targetPath}\n\n${error.message}`,
      });
      return null;
    }
  }

  async toggle(event) {
    const owner = this.disposables;
    if (!owner || owner.disposed) return;
    const window = lumine.workspace.getWindowForElement(
      event?.target ?? lumine.workspace.getElement(),
    );
    const existing = this.pickers.get(window);
    if (existing) {
      existing.host.cancel();
      return;
    }
    const pending = this.requests.get(window);
    if (pending) {
      pending.controller.abort();
      this.requests.delete(window);
      return;
    }
    const request = { controller: new AbortController() };
    this.requests.set(window, request);
    try {
      const context = await this.resolveContext(event, request.controller.signal);
      if (
        this.disposables !== owner ||
        owner.disposed ||
        !context ||
        this.requests.get(window) !== request
      ) {
        if (this.requests.get(window) === request) this.requests.delete(window);
        return;
      }
      return await this.showForContext(context, request);
    } catch (error) {
      if (this.requests.get(window) === request) this.requests.delete(window);
      if (error.name !== "AbortError" && this.disposables === owner) {
        lumine.notifications.addError("Unable to show Open With.", {
          detail: error.message,
          dismissable: true,
        });
      }
    }
  }

  async openDefault(event, destination = "current") {
    const owner = this.disposables;
    if (!owner || owner.disposed) return;
    const controller = new AbortController();
    this.operations.add(controller);
    try {
      const context = await this.resolveContext(event, controller.signal);
      abortIfNeeded(controller.signal);
      if (this.disposables !== owner || !context) return;
      const choice = lumine.workspace.getAvailablePathOpeners(context.path, context)[0];
      if (!choice) return;
      if (!supports(choice, destination)) {
        lumine.notifications.addWarning(`${choice.label} cannot use this window destination.`, {
          detail: "Choose another opener in Open With.",
        });
        return;
      }
      return await this.execute(context, choice, destination, controller.signal);
    } catch (error) {
      if (error.name !== "AbortError" && this.disposables === owner) {
        lumine.notifications.addError("Unable to open the selected path.", {
          detail: error.message,
          dismissable: true,
        });
      }
    } finally {
      this.operations.delete(controller);
    }
  }

  async showForContext(context, request = { controller: new AbortController() }) {
    const owner = this.disposables;
    if (!owner || owner.disposed) return;
    this.requests.set(context.window, request);
    await this.pickers.get(context.window)?.host.destroy();
    if (
      this.disposables !== owner ||
      context.window.isDestroyed() ||
      this.requests.get(context.window) !== request
    )
      return;
    const choices = lumine.workspace.getAvailablePathOpeners(context.path, context);
    const commands = {};
    const actions = [];
    for (const [command, { description, destination }] of Object.entries(COMMANDS)) {
      commands[command] = {
        description,
        didDispatch: (event) => {
          event.stopPropagation();
          return this.execute(context, event.detail.item, destination, event.detail.signal);
        },
      };
      actions.push({
        command,
        context: "item",
        primary: destination === "current",
        group: "Open",
        when: ({ item }) => supports(item, destination),
        disposition: "close",
      });
    }
    const host = lumine.workspace.addSelectList(
      {
        items: choices,
        getItemId: (choice) => choice.id,
        placeholderText: `Choose an opener for ${path.basename(context.path)}`,
        search: { getFilterText: (choice) => choice.label },
        renderItem: (choice, { highlight }) => ({
          primary: highlight(choice.label),
          trailing: choice.isDefault ? [{ text: "Default", className: "badge badge-info" }] : [],
        }),
        commands,
        actions,
      },
      { className: "open-with", crumb: "Open With", window: context.window },
    );
    const record = { host, context, request };
    this.pickers.set(context.window, record);
    const subscriptions = new CompositeDisposable(
      host.onDidHide(() => {
        if (!host.getModel().isActionPending()) void host.destroy();
      }),
      host.onDidFinishAction(() => {
        if (!host.isVisible()) void host.destroy();
      }),
      host.onDidCancel(() => void host.destroy()),
      host.onDidDestroy(() => {
        if (this.pickers.get(context.window) === record) this.pickers.delete(context.window);
        if (this.requests.get(context.window) === request) this.requests.delete(context.window);
        request.controller.abort();
        subscriptions.dispose();
      }),
    );
    try {
      await host.show();
      return host;
    } catch (error) {
      await host.destroy();
      throw error;
    }
  }

  async execute(context, selected, destination, signal) {
    abortIfNeeded(signal);
    const owner = this.disposables;
    if (!owner || owner.disposed || context.window.isDestroyed()) return;
    const choice = lumine.workspace
      .getAvailablePathOpeners(context.path, context)
      .find(({ id }) => id === selected.id);
    if (!choice) throw new Error("The selected opener is no longer available.");
    if (!supports(choice, destination))
      throw new Error(`${choice.label} cannot use this window destination.`);
    const workspace = lumine.workspace;
    const options = { opener: choice.id, pathKind: context.pathKind, signal };
    if (destination === "new-window") {
      return workspace.openPathInNewWindow(context.path, options);
    }
    if (destination === "detached-window") {
      let window;
      try {
        window = await workspace.openEditorWindow({ show: false });
        abortIfNeeded(signal);
        const item = await workspace.open(context.path, {
          ...options,
          destination,
          pane: window.getEditorContainer().getActivePane(),
        });
        abortIfNeeded(signal);
        if (!item) {
          await workspace.releaseEditorWindow(window);
          return;
        }
        await window.show();
        abortIfNeeded(signal);
        if (this.disposables !== owner || owner.disposed) return;
        await window.focus();
        return item;
      } catch (error) {
        if (window && !window.isDestroyed()) {
          if (window.getEditorContainer().getPaneItems().length === 0)
            await workspace.releaseEditorWindow(window);
          else await window.show();
        }
        throw error;
      }
    }
    if (destination === "this-window" && context.pathKind === "file") {
      const projectPath = path.dirname(context.path);
      const changed = await lumine.project.setState([projectPath]);
      abortIfNeeded(signal);
      const current = lumine.project.getPaths();
      if (
        !changed &&
        !(current.length === 1 && path.resolve(current[0]) === path.resolve(projectPath))
      ) {
        const error = new Error("Changing the project was cancelled.");
        error.name = "AbortError";
        throw error;
      }
      if (this.disposables !== owner || owner.disposed) return;
      return workspace.open(context.path, {
        opener: choice.id,
        pathKind: "file",
        signal,
        pane: workspace.getMainWindow().getEditorContainer().getActivePane(),
      });
    }
    return workspace.open(context.path, {
      ...options,
      pane: context.pane,
      searchAllPanes: lumine.config.get("tree-view.alwaysOpenExisting") ?? false,
    });
  }
}

module.exports = new OpenWithPackage();
