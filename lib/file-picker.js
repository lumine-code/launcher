const { abortIfNeeded } = require("./opening");
const { resolveResourceContext } = require("./path-context");

module.exports = async function pickFile(launcher, destination, signal) {
  abortIfNeeded(signal);
  if (!launcher.disposables || launcher.disposables.disposed) return null;
  const [defaultPath] = lumine.project.getPaths();
  const result = await destination.window.showOpenDialog({
    title: "Open",
    properties: ["openFile"],
    ...(defaultPath ? { defaultPath } : {}),
  });
  abortIfNeeded(signal);
  if (result.canceled || !result.filePaths?.length) return null;
  return resolveResourceContext(launcher, destination, { path: result.filePaths[0] }, signal);
};
