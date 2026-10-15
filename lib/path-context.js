const fs = require("node:fs/promises");
const { fileURLToPath } = require("node:url");
const { abortIfNeeded } = require("./opening");

async function resolvePathContext(launcher, event, signal) {
  const owner = launcher.disposables;
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
  } else {
    const result = await window.showOpenDialog({
      title: "Open",
      properties: ["openFile"],
    });
    abortIfNeeded(signal);
    if (result.canceled || !result.filePaths?.length) return null;
    [targetPath] = result.filePaths;
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
    if (launcher.disposables !== owner || owner?.disposed) return null;
    if (!stat.isFile() && !stat.isDirectory()) {
      lumine.notifications.addWarning("Select a regular file or folder to open.");
      return null;
    }
    if (window.isDestroyed() || !window.getEditorContainer().getPanes().includes(pane)) return null;
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
    if (signal?.aborted || launcher.disposables !== owner || owner?.disposed) return null;
    lumine.notifications.addWarning("The selected path is unavailable.", {
      detail: `${targetPath}\n\n${error.message}`,
    });
    return null;
  }
}

function availableChoices(context) {
  const choices = lumine.workspace.getAvailablePathOpeners(context.path, context);
  if (!context.project) return choices;
  return choices
    .filter(({ id }) => ["project-folder", "open-external", "open-external:show"].includes(id))
    .map((choice) => ({ ...choice, isDefault: choice.id === "project-folder" }))
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault));
}

module.exports = { resolvePathContext, availableChoices };
