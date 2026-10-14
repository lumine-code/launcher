const fs = require("node:fs/promises");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
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
        "{% if keys['open-with:toggle'] %}Use {{ 'open-with:toggle' | keystroke }} in the tree view to choose how and where a file or folder opens.{% else %}Choose Open With in the tree view to select how and where a file or folder opens.{% endif %}",
      ],
    };
  }

  async resolveContext(event, signal) {
    const owner = this.disposables;
    const target = event?.target ?? lumine.workspace.getElement();
    const commandContext = lumine.workspace.resolveCommandContext(event ?? target);
    const { window, documentPane } = commandContext;
    if (!window || window.isDestroyed()) return null;
    let targetPath;
    let project;
    let uriFragment;
    const detail = event?.detail;
    const pane = detail?.pane ?? documentPane;
    if (!window.getEditorContainer().getPanes().includes(pane)) {
      lumine.notifications.addWarning("The pane that requested opening is unavailable.");
      return null;
    }
    if (detail?.project !== undefined) {
      const value = detail.project;
      if (
        !value ||
        !Array.isArray(value.paths) ||
        value.paths.length === 0 ||
        value.paths.some((entry) => typeof entry !== "string" || entry.length === 0)
      ) {
        lumine.notifications.addWarning("Choose a project with existing folders to open.");
        return null;
      }
      project = {
        paths: [...value.paths],
        devMode: value.devMode === true,
        safeMode: value.safeMode === true,
      };
      [targetPath] = project.paths;
    } else if (detail?.path !== undefined) {
      if (typeof detail.path !== "string" || detail.path.length === 0) {
        lumine.notifications.addWarning("Choose a local file or folder to open.");
        return null;
      }
      targetPath = detail.path;
    } else if (target.closest?.(".tree-view")) {
      const paths = this.treeView?.selectedPaths() ?? [];
      if (paths.length === 0) return null;
      if (paths.length !== 1) {
        lumine.notifications.addWarning("Select one file or folder to open.");
        return null;
      }
      [targetPath] = paths;
    } else {
      const item = commandContext.editor ?? commandContext.documentItem;
      if (!item) return null;
      targetPath = item.getPath?.();
      if (!targetPath) {
        lumine.notifications.addWarning("The active item has no saved file or folder.");
        return null;
      }
    }
    try {
      if (/^file:/i.test(targetPath)) {
        const uri = new URL(targetPath);
        uriFragment = uri.hash || undefined;
        targetPath = fileURLToPath(uri);
      }
      if (typeof detail?.uriFragment === "string") uriFragment = detail.uriFragment;
      const stat = await fs.stat(targetPath);
      if (project) {
        const stats = await Promise.all(project.paths.map((entry) => fs.stat(entry)));
        if (stats.some((entry) => !entry.isDirectory())) {
          lumine.notifications.addWarning("Every project path must be an existing folder.");
          return null;
        }
      }
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
        pane,
        ...(uriFragment == null ? {} : { uriFragment }),
        ...(project ? { project } : {}),
        ...Object.fromEntries(
          ["initialLine", "initialColumn"]
            .filter((key) => Number.isInteger(detail?.[key]) && detail[key] >= 0)
            .map((key) => [key, detail[key]]),
        ),
      };
    } catch (error) {
      if (signal?.aborted || this.disposables !== owner || owner?.disposed) return null;
      lumine.notifications.addWarning("The selected path is unavailable.", {
        detail: `${targetPath}\n\n${error.message}`,
      });
      return null;
    }
  }

  availableChoices(context) {
    const choices = lumine.workspace.getAvailablePathOpeners(context.path, context);
    if (!context.project) return choices;
    return choices
      .filter(({ id }) => ["project-folder", "open-external", "open-external:show"].includes(id))
      .map((choice) => ({ ...choice, isDefault: choice.id === "project-folder" }))
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault));
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
      const choice = this.availableChoices(context)[0];
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
    const choices = this.availableChoices(context);
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
    const host = lumine.workspace.addSelectList(
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
          didRender: (element) => {
            const didClick = (event) => {
              const folderShift = context.pathKind === "directory" && event.shiftKey;
              if (event.button !== 0 || (!event.ctrlKey && !event.altKey && !folderShift)) return;
              event.preventDefault();
              event.stopImmediatePropagation();
              const list = host.getModel();
              void list.selectItemById(choice.id);
              lumine.commands.dispatch(
                list.getElement(),
                event.altKey
                  ? "open-with:detached-window"
                  : event.ctrlKey
                    ? "open-with:new-window"
                    : "open-with:this-window",
              );
            };
            element.addEventListener("click", didClick, true);
            return new Disposable(() => element.removeEventListener("click", didClick, true));
          },
        }),
        commands,
        actions,
      },
      {
        className: context.pathKind === "directory" ? "open-with directory" : "open-with",
        crumb: "Open With",
        window: context.window,
      },
    );
    const record = { host, context, request, closing: false };
    this.pickers.set(context.window, record);
    const subscriptions = new CompositeDisposable(
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

  async execute(context, selected, destination, signal) {
    abortIfNeeded(signal);
    const owner = this.disposables;
    if (!owner || owner.disposed || context.window.isDestroyed()) return;
    const choice = this.availableChoices(context).find(({ id }) => id === selected.id);
    if (!choice) throw new Error("The selected opener is no longer available.");
    if (!supports(choice, destination))
      throw new Error(`${choice.label} cannot use this window destination.`);
    const workspace = lumine.workspace;
    const options = {
      opener: choice.id,
      pathKind: context.pathKind,
      signal,
      ...(context.initialLine == null ? {} : { initialLine: context.initialLine }),
      ...(context.initialColumn == null ? {} : { initialColumn: context.initialColumn }),
      ...(context.uriFragment == null ? {} : { uriFragment: context.uriFragment }),
    };
    if (context.project) {
      const { paths, devMode, safeMode } = context.project;
      const stats = await Promise.all(paths.map((entry) => fs.stat(entry)));
      abortIfNeeded(signal);
      if (stats.some((entry) => !entry.isDirectory()))
        throw new Error("Every project path must be an existing folder.");
      if (this.disposables !== owner || owner.disposed) return;
      if (choice.id === "project-folder") {
        if (
          destination === "new-window" ||
          (devMode && !lumine.window.isDevMode()) ||
          (safeMode && !lumine.window.isSafeMode())
        ) {
          return lumine.application.openWindow({
            pathsToOpen: paths,
            newWindow: true,
            reuseEmptyWindow: false,
            devMode,
            safeMode,
          });
        }
        return lumine.project.setState(paths);
      }
      return Promise.all(
        paths.map((entry) => workspace.open(entry, { ...options, pane: context.pane })),
      );
    }
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
        ...options,
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
