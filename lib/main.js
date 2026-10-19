const path = require("node:path");
const { CompositeDisposable, Disposable } = require("lumine");
const ProviderRegistry = require("./provider-registry");

const COMMANDS = {
  "launcher:open-current": {
    description: "Use the selected opener in the captured editor pane.",
    destination: "current",
  },
  "launcher:open-new-window": {
    description: "Open the target in a separate project window.",
    destination: "new-window",
  },
  "launcher:open-detached-window": {
    description: "Open the file in another window sharing this workspace.",
    destination: "detached-window",
  },
  "launcher:open-this-window": {
    description: "Switch this workspace to the target's project and open it.",
    destination: "this-window",
  },
};

class LauncherPackage {
  activate() {
    this.disposables = new CompositeDisposable();
    this.treeConnections = new Set();
    this.pickers = new Map();
    this.requests = new Map();
    this.operations = new Set();
    this.providers = new ProviderRegistry(() => this.refreshProviders());
    this.disposables.add(
      lumine.commands.add("lumine-workspace", {
        "launcher:open": {
          description: "Choose how and where to open an existing resource.",
          didDispatch: (event) => this.open(event),
        },
        "launcher:new": {
          description: "Choose new content for the current editor pane.",
          didDispatch: (event) => this.create(event),
        },
        "launcher:open-resource": {
          isAvailable: (event) => this.hasResource(event),
          description: "Choose how to open the selected tree entry or saved content.",
          hiddenInCommandPalette: true,
          didDispatch: (event) => this.openResource(event),
        },
      }),
    );
  }

  async deactivate() {
    const pickers = [...(this.pickers?.values() ?? [])];
    this.providers?.dispose();
    this.disposables?.dispose();
    this.disposables = null;
    for (const controller of this.operations ?? []) controller.abort();
    this.operations?.clear();
    this.treeConnections?.clear();
    this.treeView = null;
    this.pickers?.clear();
    for (const { controller } of this.requests?.values() ?? []) controller.abort();
    this.requests?.clear();
    await Promise.all(pickers.map(({ host }) => host.destroy()));
  }

  consumeTreeViewSelection(service) {
    const connections = this.treeConnections;
    if (!this.disposables || this.disposables.disposed) return new Disposable();
    const record = { service };
    connections.add(record);
    this.treeView = service;
    lumine.commands.invalidateAvailability();
    return new Disposable(() => {
      connections.delete(record);
      if (this.treeConnections === connections) {
        this.treeView = [...connections].at(-1)?.service ?? null;
        lumine.commands.invalidateAvailability();
      }
    });
  }

  provideBackgroundTips() {
    return {
      packageName: "launcher",
      tips: [
        "Choose New Content… from File to create a content type supplied by an active package.",
        "Use {{ 'launcher:open-resource' | keystroke }} in the tree view to choose how and where a resource opens.",
      ],
    };
  }

  resolveContext(event, signal) {
    return require("./path-context").resolvePathContext(this, event, signal);
  }

  availableChoices(context) {
    return require("./path-context").availableChoices(context);
  }

  open(event) {
    return this.show("open", event);
  }

  hasResource(event) {
    if (event.target?.closest?.(".tree-view"))
      return this.treeView?.getSelectionSnapshot?.().count === 1;
    const item = event.target?.closest?.(".tab")?.item ?? event.context?.documentItem;
    return Boolean(item?.getPath?.());
  }

  openResource(event) {
    const target = event?.target ?? lumine.workspace.getElement();
    const context = event?.context ?? lumine.workspace.resolveCommandContext(event ?? target);
    let resourcePath;
    if (target.closest?.(".tree-view")) {
      const paths = this.treeView?.selectedPaths() ?? [];
      if (paths.length === 0) return;
      if (paths.length !== 1) {
        lumine.notifications.addWarning("Select one file or folder to open.");
        return;
      }
      [resourcePath] = paths;
    } else {
      const item = target.closest?.(".tab")?.item ?? context.documentItem;
      if (!item) return;
      resourcePath = item.getPath?.();
      if (!resourcePath) {
        lumine.notifications.addWarning("The selected content has no saved resource to open.");
        return;
      }
    }
    return this.open({ target, detail: { path: resourcePath, pane: context.documentPane } });
  }

  create(event) {
    return this.show("new", event);
  }

  consumeLauncher(provider) {
    return this.providers.add(provider);
  }

  provideLauncher() {
    const owner = this.disposables;
    const dispatch = async (method, options = {}) => {
      if (this.disposables !== owner || owner.disposed) {
        throw new Error("The launcher service has been retired.");
      }
      return this[method]({
        target: options.pane?.getElement() ?? lumine.workspace.getElement(),
        detail: options,
      });
    };
    return {
      open: (options) => dispatch("open", options),
      create: (options) => dispatch("create", options),
    };
  }

  refreshProviders() {
    for (const record of this.pickers.values()) {
      if (record.mode === "new") {
        void record.host.getModel().setItems(this.providers.choices());
      }
    }
  }

  creationContext(event) {
    const context = event?.context ?? lumine.workspace.resolveCommandContext(event);
    const pane = event?.detail?.pane ?? context.documentPane;
    const window =
      context.destinationWindow ?? pane?.getContainer?.()?.getWindow?.() ?? context.window;
    if (!window || window.isDestroyed()) return null;
    if (!window.getEditorContainer().getPanes().includes(pane)) {
      lumine.notifications.addWarning("Choose an available editor pane.");
      return null;
    }
    return { pane, window };
  }

  async show(mode, event) {
    const owner = this.disposables;
    if (!owner || owner.disposed) return;
    const target = event?.target ?? lumine.workspace.getElement();
    const context = event?.context ?? lumine.workspace.resolveCommandContext(event ?? target);
    const detail = { ...event?.detail };
    if (Array.isArray(detail.project?.paths)) {
      detail.project = { ...detail.project, paths: [...detail.project.paths] };
    }
    const pane = detail.pane ?? context.documentPane;
    const window =
      context.destinationWindow ?? pane?.getContainer?.()?.getWindow?.() ?? context.window;
    const invocation = {
      target,
      detail,
      context: { ...context, destinationWindow: window },
    };
    const existing = this.pickers.get(window);
    if (existing?.mode === mode) {
      existing.host.cancel();
      return;
    }
    if (existing) await existing.host.destroy();
    const pending = this.requests.get(window);
    if (pending) {
      pending.controller.abort();
      this.requests.delete(window);
      if (pending.mode === mode) return;
    }
    const request = { controller: new AbortController(), mode };
    this.requests.set(window, request);
    try {
      const context =
        mode === "open"
          ? await this.resolveContext(invocation, request.controller.signal)
          : this.creationContext(invocation);
      if (
        this.disposables !== owner ||
        owner.disposed ||
        !context ||
        this.requests.get(window) !== request
      ) {
        if (this.requests.get(window) === request) this.requests.delete(window);
        return;
      }
      return mode === "open"
        ? await this.showForContext(context, request)
        : await this.showNew(context, request);
    } catch (error) {
      if (this.requests.get(window) === request) this.requests.delete(window);
      if (error.name !== "AbortError" && this.disposables === owner) {
        lumine.notifications.addError("Unable to show Launcher.", {
          detail: error.message,
          dismissable: true,
        });
      }
    }
  }

  async showNew(context, request) {
    return this.showPicker(
      context,
      request,
      {
        items: this.providers.choices(),
        getItemId: (item) => item.id,
        placeholderText: "Choose what to create",
        search: { getFilterText: (item) => item.label },
        renderItem: (item, { highlight }) => ({ primary: highlight(item.label) }),
        commands: {
          "launcher:create": {
            description: "Create the selected content in the captured editor pane.",
            didDispatch: (event) => {
              event.stopPropagation();
              return this.createItem(context, event.detail.item, event.detail.signal);
            },
          },
        },
        actions: [
          { command: "launcher:create", context: "item", primary: true, disposition: "close" },
        ],
      },
      { className: "launcher launcher-new", crumb: "New", window: context.window },
    );
  }

  createItem(context, choice, signal) {
    return require("./creation")(this, context, choice, signal);
  }

  async showForContext(context, request = { controller: new AbortController() }) {
    const owner = this.disposables;
    if (!owner || owner.disposed) return;
    this.requests.set(context.window, request);
    await this.pickers.get(context.window)?.host.destroy();
    if (
      this.disposables !== owner ||
      context.window.isDestroyed() ||
      !context.window.getEditorContainer().getPanes().includes(context.pane) ||
      this.requests.get(context.window) !== request
    )
      return;
    const choices = this.availableChoices(context);
    const { supports } = require("./opening");
    const directory = context.pathKind === "directory";
    const primaryDestination = (choice) => {
      if (directory && supports(choice, "new-window")) return "new-window";
      if (directory && supports(choice, "this-window")) return "this-window";
      return "current";
    };
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
        primary: ({ item }) => destination === primaryDestination(item),
        group: "Open",
        when: ({ item }) =>
          supports(item, destination) &&
          !(directory && destination === "current" && supports(item, "this-window")),
        disposition: "close",
      });
    }
    return this.showPicker(
      context,
      request,
      {
        items: choices,
        getItemId: (choice) => choice.id,
        placeholderText: context.project
          ? "Choose how to open this project"
          : `Choose an opener for ${path.basename(context.path)}`,
        search: { getFilterText: (choice) => choice.label },
        renderItem: (choice, { highlight }) => ({
          primary: highlight(choice.label),
          trailing: choice.isDefault ? [{ text: "Default", className: "badge badge-info" }] : [],
        }),
        commands,
        actions,
      },
      {
        className: context.pathKind === "directory" ? "launcher directory" : "launcher",
        crumb: "Open",
        window: context.window,
      },
    );
  }

  async showPicker(context, request, modelOptions, hostOptions) {
    const host = lumine.workspace.addSelectList(modelOptions, hostOptions);
    const record = { host, context, request, mode: request.mode ?? "open", closing: false };
    this.pickers.set(context.window, record);
    const subscriptions = new CompositeDisposable(
      context.pane.onDidDestroy(() => void host.destroy()),
      context.window.onWillDestroy(() => void host.destroy()),
      host.onDidHide(() => {
        record.closing = true;
        if (!host.getModel().isActionPending()) void host.destroy();
      }),
      host.onDidFinishAction(() => {
        if (record.closing) void host.destroy();
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
      await host.show({ crumb: true });
      return host;
    } catch (error) {
      await host.destroy();
      throw error;
    }
  }

  execute(context, selected, destination, signal) {
    return require("./path-opening")(this, context, selected, destination, signal);
  }
}

module.exports = new LauncherPackage();
