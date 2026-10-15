const { CompositeDisposable } = require("lumine");
const { abortIfNeeded } = require("./opening");

function discard(item) {
  if (item && !lumine.workspace.paneForItem(item) && !item.isDestroyed?.()) {
    item.destroy?.();
  }
}

function awaitCreation(provider, context, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      try {
        abortIfNeeded(signal);
      } catch (error) {
        reject(error);
      }
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        abortIfNeeded(signal);
        return provider.create({ ...context, signal });
      })
      .then((item) => {
        if (signal.aborted) discard(item);
        else resolve(item);
      }, reject)
      .catch(reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

async function createContent(launcher, context, choice, signal) {
  const owner = launcher.disposables;
  if (
    !owner ||
    owner.disposed ||
    context.window.isDestroyed() ||
    !context.window.getEditorContainer().getPanes().includes(context.pane)
  ) {
    abortIfNeeded(AbortSignal.abort());
  }
  const record = launcher.providers.get(choice.id);
  if (!record) throw new Error("The selected content type is no longer available.");
  const controller = new AbortController();
  launcher.operations.add(controller);
  const lifetime = new CompositeDisposable(
    context.pane.onDidDestroy(() => controller.abort()),
    context.window.onWillDestroy(() => controller.abort()),
  );
  const creationSignal = AbortSignal.any([
    signal ?? new AbortController().signal,
    record.controller.signal,
    controller.signal,
  ]);
  let item;
  try {
    abortIfNeeded(creationSignal);
    item = await awaitCreation(record.provider, context, creationSignal);
    abortIfNeeded(creationSignal);
    if (
      launcher.disposables !== owner ||
      owner.disposed ||
      context.window.isDestroyed() ||
      !context.window.getEditorContainer().getPanes().includes(context.pane)
    )
      return;
    if (
      !item ||
      typeof item.getTitle !== "function" ||
      item.isDestroyed?.() ||
      lumine.workspace.paneForItem(item)
    ) {
      throw new Error("A launcher provider must create a fresh, unattached pane item.");
    }
    if (
      !(item.getAllowedLocations?.() ?? [item.getDefaultLocation?.() ?? "center"]).includes(
        "center",
      )
    ) {
      throw new Error("The selected content cannot open in the editor area.");
    }
    return await lumine.workspace.open(item, {
      pane: context.pane,
      location: "center",
      pending: false,
      signal: creationSignal,
    });
  } finally {
    launcher.operations.delete(controller);
    lifetime.dispose();
    discard(item);
  }
}

module.exports = createContent;
