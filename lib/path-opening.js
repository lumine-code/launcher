const fs = require("node:fs/promises");
const path = require("node:path");
const { abortIfNeeded, supports } = require("./opening");

async function openPath(launcher, context, selected, destination, signal) {
  abortIfNeeded(signal);
  const owner = launcher.disposables;
  if (!owner || owner.disposed || context.window.isDestroyed()) return;
  const choice = launcher.availableChoices(context).find(({ id }) => id === selected.id);
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
    if (launcher.disposables !== owner || owner.disposed) return;
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
    const results = [];
    // System actions have visible effects; preserve the project's root order.
    for (const entry of paths) {
      abortIfNeeded(signal);
      if (launcher.disposables !== owner || owner.disposed || context.window.isDestroyed()) return;
      results.push(await workspace.open(entry, { ...options, pane: context.pane }));
    }
    return results;
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
      if (launcher.disposables !== owner || owner.disposed) return;
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
    if (launcher.disposables !== owner || owner.disposed) return;
    return workspace.open(context.path, {
      ...options,
      pane: workspace.getMainWindow().getEditorContainer().getActivePane(),
    });
  }
  return workspace.open(context.path, {
    ...options,
    pane: context.pane,
    pending: lumine.config.get("core.allowPendingPaneItems"),
    searchAllPanes: lumine.config.get("tree-view.alwaysOpenExisting") ?? false,
  });
}

module.exports = openPath;
