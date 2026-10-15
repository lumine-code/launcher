const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { CompositeDisposable } = require("lumine");

describe("Open", () => {
  const primaryClick = process.platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
  let main, external, leases, scratch, file, otherFile, folder, selected, tree, row;
  let projectPaths, newWindow, detachedWindow;

  beforeEach(async () => {
    jasmine.useRealClock();
    projectPaths = lumine.project.getPaths();
    lumine.project.setPaths([]);
    scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lumine-launcher-")));
    file = path.join(scratch, "document.txt");
    otherFile = path.join(scratch, "other.txt");
    folder = path.join(scratch, "project");
    fs.writeFileSync(file, "first document\n");
    fs.writeFileSync(otherFile, "second document\n");
    fs.mkdirSync(folder);
    leases = new CompositeDisposable();
    external = (await lumine.packages.activatePackage("open-external")).mainModule;
    lumine.config.set("open-external.flag", false);
    lumine.config.set("open-external.list", ["txt"]);
    main = (await lumine.packages.activatePackage("launcher")).mainModule;
    selected = [file];
    leases.add(main.consumeTreeViewSelection({ selectedPaths: () => selected }));
    tree = document.createElement("div");
    tree.className = "tree-view";
    row = document.createElement("li");
    row.className = "entry file";
    tree.appendChild(row);
    lumine.workspace.getLeftDock().getActivePane().getElement().appendChild(tree);
    jasmine.attachToDOM(lumine.workspace.getElement());
    newWindow = spyOn(lumine.workspace, "openPathInNewWindow").and.resolveTo();
    detachedWindow = spyOn(lumine.workspace, "openEditorWindow").and.rejectWith(
      new Error("A test must provide a hidden window model before opening it"),
    );
    spyOn(lumine.workspace, "releaseEditorWindow").and.callFake((window) => window.destroy());
    spyOn(lumine.shell, "openPath").and.resolveTo("");
    spyOn(lumine.shell, "showItemInFolder").and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("launcher");
    leases.dispose();
    await lumine.packages.deactivatePackage("open-external");
    for (const pane of lumine.workspace.getPanes()) {
      for (const item of [...pane.getItems()]) await pane.destroyItem(item);
    }
    tree.remove();
    lumine.project.setPaths(projectPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), scratch);
    if (
      !relative ||
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    )
      throw new Error("Open scratch directory escaped the private temporary root");
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const event = () => ({ target: row });
  const show = () => main.openResource(event());
  const actionNames = (list) => list.getAvailableActions().map(({ command }) => command);

  function registerViewer(options = {}) {
    const viewer = document.createElement("div");
    viewer.getURI = () => file;
    viewer.getPath = () => file;
    viewer.getTitle = () => "Document Viewer";
    viewer.destroy = jasmine.createSpy("destroy viewer").and.callFake(() => viewer.remove());
    const open = jasmine.createSpy("open viewer").and.returnValue(viewer);
    const descriptor = {
      id: "launcher:spec-viewer",
      label: "Document Viewer",
      canOpen: (uri) => uri === file,
      open,
      ...options,
    };
    leases.add(lumine.workspace.addPathOpener(descriptor));
    return { viewer, open, descriptor };
  }

  function hiddenEditorWindow() {
    const pane = lumine.workspace.getActivePane().splitRight();
    let destroyed = false;
    const window = {
      getEditorContainer: () => ({
        getActivePane: () => pane,
        getPaneItems: () => pane.getItems(),
        getPanes: () => [pane],
      }),
      isDestroyed: () => destroyed,
      show: jasmine.createSpy("show hidden window").and.resolveTo(),
      focus: jasmine.createSpy("focus hidden window"),
      destroy: jasmine.createSpy("destroy hidden window").and.callFake(() => {
        destroyed = true;
        pane.destroy();
      }),
    };
    detachedWindow.and.resolveTo(window);
    return { window, pane };
  }

  function choiceRow(list, id) {
    const index = list.getDisplayedItems().findIndex((choice) => choice.id === id);
    return list.getElement().querySelectorAll('[role="option"]')[index];
  }

  async function clickChoice(host, id, modifiers = {}, selector) {
    const list = host.getModel();
    const row = choiceRow(list, id);
    const target = selector ? row.querySelector(selector) : row;
    let complete;
    const finished = new Promise((resolve) => (complete = resolve));
    const subscription = list.onDidFinishAction(complete);
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ...modifiers,
    });
    target.dispatchEvent(click);
    const result = await finished;
    subscription.dispose();
    await flushMicrotasks();
    return { click, result };
  }

  async function confirmWithEnter(host) {
    const list = host.getModel();
    const input = list.getQueryEditor().getElement();
    const [binding] = lumine.keymaps.findKeyBindings({ target: input, keystrokes: "enter" });
    expect(binding.command).toBe("core:confirm");
    let complete;
    const finished = new Promise((resolve) => (complete = resolve));
    const subscription = list.onDidFinishAction(complete);
    lumine.commands.dispatch(input, binding.command);
    const result = await finished;
    subscription.dispose();
    await flushMicrotasks();
    return result;
  }

  it("puts the actual default first and marks only that row", async () => {
    registerViewer();
    const host = await show();
    const list = host.getModel();

    expect(list.getItems().map(({ id }) => id)).toEqual([
      "launcher:spec-viewer",
      "open-external",
      "open-external:show",
      "text-editor",
    ]);
    expect(list.getSelectedItem().id).toBe("launcher:spec-viewer");
    const rows = list.getElement().querySelectorAll('[role="option"]');
    expect(rows[0].textContent).toContain("Document Viewer");
    expect(rows[0].querySelector(".badge").textContent).toBe("Default");
    expect(list.getElement().querySelectorAll(".badge").length).toBe(1);
    expect(host.window).toBe(lumine.workspace.getWindowForElement(tree));
  });

  it("marks Open Externally as default when automatic external opening is enabled", async () => {
    lumine.config.set("open-external.flag", true);
    const host = await show();
    const list = host.getModel();

    expect(list.getSelectedItem().id).toBe("open-external");
    expect(list.getItems()[0]).toEqual({
      id: "open-external",
      label: "Open Externally",
      isDefault: true,
      destinations: ["current"],
    });
    expect(list.getElement().querySelector('[role="option"] .badge').textContent).toBe("Default");
    expect(lumine.shell.openPath).not.toHaveBeenCalled();
  });

  it("opens the captured file and selected opener in its original pane", async () => {
    registerViewer();
    const originalPane = lumine.workspace.getMainWindow().getEditorContainer().getActivePane();
    const host = await show();
    const list = host.getModel();
    selected = [otherFile];
    const otherPane = originalPane.splitRight();
    otherPane.activate();
    await list.selectItemById("text-editor");
    const result = await list.runAction("launcher:open-current");

    expect(result.status).toBe("success");
    const editor = originalPane.getItems().find((item) => item.getPath?.() === file);
    expect(editor?.getText()).toBe("first document\n");
    expect(otherPane.getItems()).toEqual([]);
    expect(host.isDestroyed()).toBe(true);
    expect(newWindow).not.toHaveBeenCalled();
    expect(detachedWindow).not.toHaveBeenCalled();
  });

  for (const allowPending of [true, false]) {
    it(`respects pending configuration ${allowPending} for default opening`, async () => {
      lumine.config.set("core.allowPendingPaneItems", allowPending);
      const host = await show();
      await host.getModel().runAction("launcher:open-current");
      const pane = lumine.workspace.getMainWindow().getEditorContainer().getActivePane();
      const editor = pane.getItems().find((item) => item.getPath?.() === file);

      expect(editor).toBeDefined();
      expect(pane.getPendingItem() === editor).toBe(allowPending);
      expect(lumine.config.get("core.allowPendingPaneItems")).toBe(allowPending);
    });
  }

  it("opens the selected viewer in an independent project window", async () => {
    const { open } = registerViewer({ isDefaultEligible: () => false });
    const host = await show();
    expect(host.getModel().getSelectedItem().id).toBe("text-editor");
    await host.getModel().selectItemById("launcher:spec-viewer");
    const result = await host.getModel().runAction("launcher:open-new-window");

    expect(result.status).toBe("success");
    expect(newWindow).toHaveBeenCalledOnceWith(file, {
      opener: "launcher:spec-viewer",
      pathKind: "file",
      signal: result.signal,
    });
    expect(open).not.toHaveBeenCalled();
    expect(detachedWindow).not.toHaveBeenCalled();
    expect(host.isDestroyed()).toBe(true);
  });

  it("opens the selected viewer before showing and focusing a detached window", async () => {
    const { viewer, open } = registerViewer({ isDefaultEligible: () => false });
    const { window, pane } = hiddenEditorWindow();
    const host = await show();
    expect(host.getModel().getSelectedItem().id).toBe("text-editor");
    await host.getModel().selectItemById("launcher:spec-viewer");
    const workspaceOpen = spyOn(lumine.workspace, "open").and.callThrough();
    const result = await host.getModel().runAction("launcher:open-detached-window");

    expect(result.status).toBe("success");
    expect(detachedWindow).toHaveBeenCalledOnceWith({ show: false });
    expect(open).toHaveBeenCalledTimes(1);
    const [openedPath, options] = open.calls.mostRecent().args;
    expect(openedPath).toBe(file);
    expect(options.opener).toBe("launcher:spec-viewer");
    expect(options.pane).toBe(pane);
    expect(options.destination).toBe("detached-window");
    expect(options.pathKind).toBe("file");
    expect(workspaceOpen.calls.mostRecent().args[1].signal).toBe(result.signal);
    expect(pane.getItems()).toContain(viewer);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(open.calls.first().invocationOrder).toBeLessThan(
      window.show.calls.first().invocationOrder,
    );
    expect(window.destroy).not.toHaveBeenCalled();
    expect(newWindow).not.toHaveBeenCalled();
  });

  it("opens Text Editor in a detached window even when another viewer is default", async () => {
    const { open } = registerViewer();
    const { pane } = hiddenEditorWindow();
    const host = await show();
    await host.getModel().selectItemById("text-editor");
    const result = await host.getModel().runAction("launcher:open-detached-window");

    expect(result.status).toBe("success");
    expect(pane.getItems()[0].getText()).toBe("first document\n");
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps a plain click on a label opening the clicked opener in the current pane", async () => {
    const { viewer, open } = registerViewer({ isDefaultEligible: () => false });
    const host = await show();
    const originalPane = lumine.workspace.getMainWindow().getEditorContainer().getActivePane();
    expect(host.getModel().getSelectedItem().id).toBe("text-editor");
    const { result } = await clickChoice(host, "launcher:spec-viewer", {}, ".primary-text");

    expect(result.status).toBe("success");
    expect(result.command).toBe("launcher:open-current");
    expect(open).toHaveBeenCalledTimes(1);
    expect(originalPane.getItems()).toContain(viewer);
    expect(newWindow).not.toHaveBeenCalled();
    expect(detachedWindow).not.toHaveBeenCalled();
    expect(host.isDestroyed()).toBe(true);
  });

  it("opens a nonselected nondefault opener exactly once on Cmd/Ctrl-click", async () => {
    const { open } = registerViewer({ isDefaultEligible: () => false });
    const host = await show();
    expect(host.getModel().getSelectedItem().id).toBe("text-editor");
    const { click, result } = await clickChoice(host, "launcher:spec-viewer", primaryClick);

    expect(click.defaultPrevented).toBe(true);
    expect(result.status).toBe("success");
    expect(result.command).toBe("launcher:open-new-window");
    expect(newWindow).toHaveBeenCalledOnceWith(file, {
      opener: "launcher:spec-viewer",
      pathKind: "file",
      signal: result.signal,
    });
    expect(open).not.toHaveBeenCalled();
    expect(detachedWindow).not.toHaveBeenCalled();
    expect(lumine.workspace.getPaneItems()).toEqual([]);
  });

  it("Alt-clicks Text Editor into one detached pane while another viewer is default", async () => {
    const { open } = registerViewer();
    const { pane, window } = hiddenEditorWindow();
    const host = await show();
    expect(host.getModel().getSelectedItem().id).toBe("launcher:spec-viewer");
    const { result } = await clickChoice(host, "text-editor", { altKey: true }, ".primary-text");

    expect(result.status).toBe("success");
    expect(result.command).toBe("launcher:open-detached-window");
    expect(detachedWindow).toHaveBeenCalledOnceWith({ show: false });
    expect(pane.getItems().length).toBe(1);
    expect(pane.getItems()[0].getPath()).toBe(file);
    expect(pane.getItems()[0].getText()).toBe("first document\n");
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(newWindow).not.toHaveBeenCalled();
  });

  it("only selects the opener when Alt and Cmd/Ctrl are held without an Enter binding", async () => {
    registerViewer();
    const host = await show();
    const list = host.getModel();
    expect(list.getSelectedItem().id).toBe("launcher:spec-viewer");
    const execute = spyOn(main, "execute").and.resolveTo();
    const action = jasmine.createSpy("finished action");
    leases.add(list.onDidFinishAction(action));
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      altKey: true,
      ...primaryClick,
    });
    choiceRow(list, "text-editor").dispatchEvent(click);
    await flushMicrotasks();

    expect(click.defaultPrevented).toBe(true);
    expect(list.getSelectedItem().id).toBe("text-editor");
    expect(action).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(host.isVisible()).toBe(true);
  });

  it("keeps a folder Alt-click unavailable and opens its project only on Cmd/Ctrl-click", async () => {
    selected = [folder];
    const host = await show();
    const unsupported = await clickChoice(host, "project-folder", { altKey: true });

    expect(unsupported.result.status).toBe("unavailable");
    expect(unsupported.result.command).toBe("launcher:open-detached-window");
    expect(host.isVisible()).toBe(true);
    expect(lumine.project.getPaths()).toEqual([]);
    expect(newWindow).not.toHaveBeenCalled();
    expect(detachedWindow).not.toHaveBeenCalled();
    const { result } = await clickChoice(host, "project-folder", primaryClick);
    expect(result.status).toBe("success");
    expect(newWindow).toHaveBeenCalledOnceWith(folder, {
      opener: "project-folder",
      pathKind: "directory",
      signal: result.signal,
    });
    expect(lumine.project.getPaths()).toEqual([]);
    expect(detachedWindow).not.toHaveBeenCalled();
  });

  it("opens a folder project in the current window on Shift-click", async () => {
    selected = [folder];
    const host = await show();
    await host.getModel().selectItemById("open-external");
    const { click, result } = await clickChoice(
      host,
      "project-folder",
      { shiftKey: true },
      ".badge",
    );

    expect(click.defaultPrevented).toBe(true);
    expect(result.status).toBe("success");
    expect(result.command).toBe("launcher:open-this-window");
    expect(lumine.project.getPaths()).toEqual([folder]);
    expect(newWindow).not.toHaveBeenCalled();
    expect(detachedWindow).not.toHaveBeenCalled();
    expect(lumine.shell.openPath).not.toHaveBeenCalled();
    expect(host.isDestroyed()).toBe(true);
  });

  for (const confirmation of ["plain click", "Enter"]) {
    it(`opens the folder project in one new window on ${confirmation}`, async () => {
      selected = [folder];
      const host = await show();
      const result =
        confirmation === "Enter"
          ? await confirmWithEnter(host)
          : (await clickChoice(host, "project-folder", {}, ".primary-text")).result;

      expect(result.status).toBe("success");
      expect(result.command).toBe("launcher:open-new-window");
      expect(newWindow).toHaveBeenCalledOnceWith(folder, {
        opener: "project-folder",
        pathKind: "directory",
        signal: result.signal,
      });
      expect(lumine.project.getPaths()).toEqual([]);
      expect(detachedWindow).not.toHaveBeenCalled();
      expect(lumine.shell.openPath).not.toHaveBeenCalled();
      expect(host.isDestroyed()).toBe(true);
    });
  }

  it("presents New Window as a folder's only primary action with Enter and This Window with Shift-Enter", async () => {
    selected = [folder];
    const host = await show();
    const actions = host.getModel().getAvailableActions();

    expect(actions.map(({ command }) => command)).toEqual([
      "launcher:open-new-window",
      "launcher:open-this-window",
    ]);
    const [newProject, currentProject] = actions;
    expect(newProject.primary).toBe(true);
    expect(newProject.keystrokes).toContain("enter");
    expect(currentProject.primary).toBe(false);
    expect(currentProject.keystrokes).toContain("shift-enter");
  });

  it("only selects a file opener on Shift-click without a Shift-Enter binding", async () => {
    const { viewer, open } = registerViewer({ isDefaultEligible: () => false });
    const host = await show();
    const list = host.getModel();
    const action = jasmine.createSpy("finished action");
    leases.add(list.onDidFinishAction(action));
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      shiftKey: true,
    });
    choiceRow(list, "launcher:spec-viewer").querySelector(".primary-text").dispatchEvent(click);
    await flushMicrotasks();

    expect(click.defaultPrevented).toBe(true);
    expect(list.getSelectedItem().id).toBe("launcher:spec-viewer");
    expect(action).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(lumine.workspace.paneForItem(viewer)).toBeUndefined();
    expect(lumine.project.getPaths()).toEqual([]);
    expect(newWindow).not.toHaveBeenCalled();
    expect(detachedWindow).not.toHaveBeenCalled();
    expect(host.isVisible()).toBe(true);
  });

  it("resolves Shift-Enter as This Window only while choosing a folder opener", async () => {
    const fileHost = await show();
    const fileInput = fileHost.getModel().getQueryEditor().getElement();
    const fileBindings = lumine.keymaps.findKeyBindings({
      target: fileInput,
      keystrokes: "shift-enter",
    });
    expect(fileBindings.some((binding) => binding.command === "launcher:open-this-window")).toBe(
      false,
    );
    fileHost.cancel();
    await fileHost.destroy();
    selected = [folder];
    const folderHost = await show();
    const folderInput = folderHost.getModel().getQueryEditor().getElement();
    const folderBindings = lumine.keymaps.findKeyBindings({
      target: folderInput,
      keystrokes: "shift-enter",
    });

    expect(folderBindings[0]?.command).toBe("launcher:open-this-window");
  });

  for (const id of ["open-external", "open-external:show"]) {
    it(`does not fall back to the primary action for Cmd/Ctrl-click or Alt-click on ${id}`, async () => {
      const open = spyOn(external, "openExternal").and.resolveTo("");
      const showInFolder = spyOn(external, "showInFolder").and.resolveTo("");
      const host = await show();
      for (const modifiers of [primaryClick, { altKey: true }]) {
        const { click, result } = await clickChoice(host, id, modifiers, ".primary-text");
        expect(click.defaultPrevented).toBe(true);
        expect(result.status).toBe("unavailable");
        expect(host.isVisible()).toBe(true);
        expect(host.getModel().getSelectedItem().id).toBe(id);
      }

      expect(open).not.toHaveBeenCalled();
      expect(showInFolder).not.toHaveBeenCalled();
      expect(newWindow).not.toHaveBeenCalled();
      expect(detachedWindow).not.toHaveBeenCalled();
      expect(lumine.workspace.getPaneItems()).toEqual([]);
    });

    it(`keeps a folder Shift-click on ${id} unavailable without running the primary action`, async () => {
      selected = [folder];
      const open = spyOn(external, "openExternal").and.resolveTo("");
      const showInFolder = spyOn(external, "showInFolder").and.resolveTo("");
      const host = await show();
      const { click, result } = await clickChoice(host, id, { shiftKey: true }, ".primary-text");

      expect(click.defaultPrevented).toBe(true);
      expect(result.status).toBe("unavailable");
      expect(result.command).toBe("launcher:open-this-window");
      expect(host.isVisible()).toBe(true);
      expect(host.getModel().getSelectedItem().id).toBe(id);
      expect(lumine.project.getPaths()).toEqual([]);
      expect(open).not.toHaveBeenCalled();
      expect(showInFolder).not.toHaveBeenCalled();
      expect(newWindow).not.toHaveBeenCalled();
      expect(detachedWindow).not.toHaveBeenCalled();
    });

    it(`confirms a folder's ${id} as its own current action without opening a window`, async () => {
      selected = [folder];
      const open = spyOn(external, "openExternal").and.resolveTo("");
      const showInFolder = spyOn(external, "showInFolder").and.resolveTo("");
      const host = await show();
      const list = host.getModel();
      await list.selectItemById(id);
      const actions = list.getAvailableActions();
      expect(actions.map(({ command }) => command)).toEqual(["launcher:open-current"]);
      expect(actions[0].primary).toBe(true);
      expect(actions[0].keystrokes).toContain("enter");
      const result = await confirmWithEnter(host);

      expect(result.status).toBe("success");
      expect(result.command).toBe("launcher:open-current");
      const requested = id === "open-external" ? open : showInFolder;
      const other = id === "open-external" ? showInFolder : open;
      expect(requested).toHaveBeenCalledOnceWith(folder);
      expect(other).not.toHaveBeenCalled();
      expect(newWindow).not.toHaveBeenCalled();
      expect(detachedWindow).not.toHaveBeenCalled();
      expect(lumine.project.getPaths()).toEqual([]);
    });
  }

  it("handles a filtered badge click and removes modifier listeners from rerendered and destroyed rows", async () => {
    registerViewer();
    const host = await show();
    const list = host.getModel();
    const retiredRow = choiceRow(list, "launcher:spec-viewer");
    const dispatch = spyOn(lumine.commands, "dispatch").and.callThrough();
    await list.setQuery("document");
    const currentRow = choiceRow(list, "launcher:spec-viewer");
    expect(currentRow).not.toBe(retiredRow);
    expect(currentRow.querySelector(".character-match")).not.toBeNull();
    const retiredClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ...primaryClick,
    });
    retiredRow.querySelector(".badge").dispatchEvent(retiredClick);
    await flushMicrotasks();

    expect(retiredClick.defaultPrevented).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    const { result } = await clickChoice(host, "launcher:spec-viewer", primaryClick, ".badge");
    expect(result.status).toBe("success");
    expect(newWindow).toHaveBeenCalledTimes(1);
    expect(dispatch.calls.first().args[0]).toBe(list.getElement());
    expect(dispatch.calls.first().args[1]).toBe("launcher:open-new-window");
    expect(host.isDestroyed()).toBe(true);
    const cancelledHost = await show();
    const destroyedRow = choiceRow(cancelledHost.getModel(), "launcher:spec-viewer");
    cancelledHost.cancel();
    await cancelledHost.destroy();
    expect(cancelledHost.isDestroyed()).toBe(true);
    const callCount = dispatch.calls.count();
    const destroyedClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      altKey: true,
    });
    destroyedRow.querySelector(".badge").dispatchEvent(destroyedClick);
    await flushMicrotasks();

    expect(destroyedClick.defaultPrevented).toBe(false);
    expect(dispatch.calls.count()).toBe(callCount);
    expect(detachedWindow).not.toHaveBeenCalled();
  });

  it("replaces the current project with the selected file's parent before opening its viewer", async () => {
    const { viewer, open } = registerViewer();
    lumine.project.setPaths([folder]);
    const host = await show();
    const result = await host.getModel().runAction("launcher:open-this-window");

    expect(result.status).toBe("success");
    expect(lumine.project.getPaths()).toEqual([scratch]);
    expect(lumine.workspace.paneForItem(viewer)).toBeDefined();
    expect(open.calls.mostRecent().args[1].opener).toBe("launcher:spec-viewer");
    expect(newWindow).not.toHaveBeenCalled();
    expect(detachedWindow).not.toHaveBeenCalled();
  });

  for (const [id, method] of [
    ["open-external", "openExternal"],
    ["open-external:show", "showInFolder"],
  ]) {
    it(`offers only current opening for ${id} and never creates a window`, async () => {
      const action = spyOn(external, method).and.resolveTo("");
      const host = await show();
      const list = host.getModel();
      await list.selectItemById(id);

      expect(actionNames(list)).toEqual(["launcher:open-current"]);
      for (const command of [
        "launcher:open-new-window",
        "launcher:open-detached-window",
        "launcher:open-this-window",
      ]) {
        expect((await list.runAction(command)).status).toBe("unavailable");
      }
      expect(action).not.toHaveBeenCalled();
      expect(newWindow).not.toHaveBeenCalled();
      expect(detachedWindow).not.toHaveBeenCalled();
      expect((await list.runAction("launcher:open-current")).status).toBe("success");
      expect(action).toHaveBeenCalledOnceWith(file);
      expect(lumine.workspace.getPaneItems()).toEqual([]);
    });
  }

  it("offers a folder project as the default with distinct current and new-window actions", async () => {
    selected = [folder];
    const host = await show();
    const list = host.getModel();

    expect(list.getItems().map(({ id }) => id)).toEqual([
      "project-folder",
      "open-external",
      "open-external:show",
    ]);
    expect(list.getSelectedItem()).toEqual({
      id: "project-folder",
      label: "Project Folder",
      isDefault: true,
      destinations: ["current", "new-window"],
    });
    expect(actionNames(list)).not.toContain("launcher:open-current");
    expect(actionNames(list)).toContain("launcher:open-this-window");
    expect(actionNames(list)).toContain("launcher:open-new-window");
    expect(actionNames(list)).not.toContain("launcher:open-detached-window");
    expect((await list.runAction("launcher:open-detached-window")).status).toBe("unavailable");
    expect(detachedWindow).not.toHaveBeenCalled();
    expect((await list.runAction("launcher:open-this-window")).status).toBe("success");
    expect(lumine.project.getPaths()).toEqual([folder]);
    expect(lumine.workspace.getTextEditors().some((editor) => editor.getPath() === folder)).toBe(
      false,
    );
  });

  it("opens a folder as a separate project in a new window", async () => {
    selected = [folder];
    const host = await show();
    const result = await host.getModel().runAction("launcher:open-new-window");

    expect(result.status).toBe("success");
    expect(newWindow).toHaveBeenCalledOnceWith(folder, {
      opener: "project-folder",
      pathKind: "directory",
      signal: result.signal,
    });
    expect(lumine.project.getPaths()).toEqual([]);
    expect(detachedWindow).not.toHaveBeenCalled();
  });

  it("registers picker commands and a resource wrapper at workspace scope", () => {
    const names = lumine.commands
      .findCommands({ target: lumine.workspace.getElement() })
      .map(({ name }) => name)
      .filter((name) => name.startsWith("launcher:"));
    expect(names.sort()).toEqual(["launcher:new", "launcher:open", "launcher:open-resource"]);
  });

  it("handles a picker command once with its selected opener without bubbling to the workspace default", async () => {
    registerViewer();
    const host = await show();
    const list = host.getModel();
    await list.selectItemById("text-editor");
    const execute = spyOn(main, "execute").and.resolveTo();
    await lumine.commands.dispatch(list.getQueryEditor().getElement(), "launcher:open-new-window");
    await flushMicrotasks();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.calls.mostRecent().args[1].id).toBe("text-editor");
    expect(execute.calls.mostRecent().args[2]).toBe("new-window");
  });

  it("resolves Enter, Ctrl/Cmd+Enter and Alt+Enter on the picker input", async () => {
    const host = await show();
    const input = host.getModel().getQueryEditor().getElement();
    for (const [keystrokes, command] of [
      ["enter", "core:confirm"],
      [process.platform === "darwin" ? "cmd-enter" : "ctrl-enter", "launcher:open-new-window"],
      ["alt-enter", "launcher:open-detached-window"],
    ]) {
      const matches = lumine.keymaps.findKeyBindings({ target: input, keystrokes });
      expect(matches[0]?.command).toBe(command);
    }
    const primary = host
      .getModel()
      .getAvailableActions()
      .filter((action) => action.primary);
    expect(primary.length).toBe(1);
    expect(primary[0].command).toBe("launcher:open-current");
    expect(primary[0].keystrokes).toContain("enter");
  });

  it("uses the saved item from its center context menu", async () => {
    const editor = await lumine.workspace.open(otherFile, { opener: "text-editor" });
    const host = await main.openResource({ target: editor.getElement() });
    const open = spyOn(lumine.workspace, "open").and.callThrough();
    await host.getModel().runAction("launcher:open-current");

    expect(open.calls.mostRecent().args[0]).toBe(otherFile);
  });

  it("selects a resource in a native dialog for global Open", async () => {
    const window = lumine.workspace.getMainWindow();
    const pane = window.getEditorContainer().getActivePane();
    const choose = spyOn(window, "showOpenDialog").and.resolveTo({
      canceled: false,
      filePaths: [otherFile],
    });
    const focused = await lumine.workspace.open(file);
    const host = await main.open({ target: focused.getElement() });
    const another = pane.splitRight();
    another.activate();
    await host.getModel().runAction("launcher:open-current");
    expect(choose).toHaveBeenCalledOnceWith({ title: "Open", properties: ["openFile"] });
    expect(pane.getItems().some((item) => item.getPath?.() === otherFile)).toBe(true);
    expect(another.getItems()).toEqual([]);
  });

  it("keeps a cancelled native dialog from creating a picker", async () => {
    spyOn(lumine.workspace.getMainWindow(), "showOpenDialog").and.resolveTo({
      canceled: true,
      filePaths: [],
    });
    expect(await main.open({ target: lumine.workspace.getElement() })).toBeUndefined();
    expect(main.pickers.size).toBe(0);
    expect(main.requests.size).toBe(0);
  });

  it("opens an explicit selected path in the captured pane and preserves its cursor position", async () => {
    const original = lumine.workspace.getActivePane();
    const another = original.splitRight();
    another.activate();
    const host = await main.open({
      target: lumine.workspace.getElement(),
      detail: { path: file, pane: original, initialLine: 0, initialColumn: 3 },
    });
    await host.getModel().runAction("launcher:open-current");

    const editor = original.getItems().find((item) => item.getPath?.() === file);
    expect(editor.getCursorBufferPosition().toArray()).toEqual([0, 3]);
    expect(another.getItems()).toEqual([]);
  });

  it("normalizes an explicit file URL and carries its fragment to the selected viewer", async () => {
    const { open } = registerViewer();
    const uri = pathToFileURL(file);
    uri.hash = "nameddest=GROUP";
    const host = await main.open({ target: row, detail: { path: uri.href } });
    await host.getModel().runAction("launcher:open-current");

    expect(open.calls.mostRecent().args[0]).toBe(file);
    expect(open.calls.mostRecent().args[1].uriFragment).toBe("#nameddest=GROUP");
  });

  it("carries explicit viewer positions and fragments when requesting a new window", async () => {
    const host = await main.open({
      target: row,
      detail: { path: file, initialLine: 12, initialColumn: 3, uriFragment: "#nameddest=GROUP" },
    });
    await host.getModel().runAction("launcher:open-new-window");

    expect(newWindow.calls.mostRecent().args[1]).toEqual(
      jasmine.objectContaining({
        opener: "text-editor",
        initialLine: 12,
        initialColumn: 3,
        uriFragment: "#nameddest=GROUP",
      }),
    );
  });

  it("preserves every project folder and launch mode in a new project window", async () => {
    const secondFolder = path.join(scratch, "another-project");
    fs.mkdirSync(secondFolder);
    const host = await main.open({
      target: row,
      detail: { project: { paths: [folder, secondFolder], devMode: true, safeMode: true } },
    });
    const list = host.getModel();
    expect(list.getItems().map(({ id }) => id)).toEqual([
      "project-folder",
      "open-external",
      "open-external:show",
    ]);
    await list.runAction("launcher:open-new-window");

    expect(lumine.application.openWindow).toHaveBeenCalledOnceWith({
      pathsToOpen: [folder, secondFolder],
      devMode: true,
      safeMode: true,
      newWindow: true,
      reuseEmptyWindow: false,
    });
    expect(newWindow).not.toHaveBeenCalled();
    expect(lumine.project.getPaths()).toEqual([]);
  });

  it("restores all project folders in this window and reveals all roots through the system action", async () => {
    const secondFolder = path.join(scratch, "another-project");
    fs.mkdirSync(secondFolder);
    const target = { target: row, detail: { project: { paths: [folder, secondFolder] } } };
    let host = await main.open(target);
    await host.getModel().runAction("launcher:open-this-window");
    expect(lumine.project.getPaths()).toEqual([folder, secondFolder]);

    host = await main.open(target);
    await host.getModel().selectItemById("open-external:show");
    await host.getModel().runAction("launcher:open-current");
    expect(lumine.shell.showItemInFolder.calls.allArgs()).toEqual([[folder], [secondFolder]]);
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
  });

  for (const opener of ["open-external", "open-external:show"]) {
    it(`finishes each project root before dispatching the next ${opener} action`, async () => {
      const secondFolder = path.join(scratch, "another-project");
      fs.mkdirSync(secondFolder);
      const context = await main.resolveContext({
        target: row,
        detail: { project: { paths: [folder, secondFolder] } },
      });
      let release, started;
      const first = new Promise((resolve) => (release = resolve));
      const began = new Promise((resolve) => (started = resolve));
      const open = spyOn(lumine.workspace, "open").and.callFake((uri) => {
        if (uri === folder) {
          started();
          return first;
        }
        return Promise.resolve("second result");
      });
      const pending = main.execute(context, { id: opener }, "current");
      await began;
      expect(open.calls.allArgs().map(([uri]) => uri)).toEqual([folder]);
      release("first result");
      expect(await pending).toEqual(["first result", "second result"]);
      expect(open.calls.allArgs().map(([uri]) => uri)).toEqual([folder, secondFolder]);
    });
  }

  for (const retirement of ["cancellation", "deactivation", "window closure"]) {
    it(`does not dispatch another project root after ${retirement} during the first action`, async () => {
      const secondFolder = path.join(scratch, "another-project");
      fs.mkdirSync(secondFolder);
      const context = await main.resolveContext({
        target: row,
        detail: { project: { paths: [folder, secondFolder] } },
      });
      let release, started;
      const first = new Promise((resolve) => (release = resolve));
      const began = new Promise((resolve) => (started = resolve));
      const open = spyOn(lumine.workspace, "open").and.callFake((uri) => {
        if (uri === folder) {
          started();
          return first;
        }
        return Promise.resolve();
      });
      const controller = new AbortController();
      const pending = main
        .execute(context, { id: "open-external:show" }, "current", controller.signal)
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      await began;
      if (retirement === "cancellation") controller.abort();
      else if (retirement === "deactivation") await lumine.packages.deactivatePackage("launcher");
      else spyOn(context.window, "isDestroyed").and.returnValue(true);
      release();
      const result = await pending;
      if (retirement === "cancellation") expect(result.error?.name).toBe("AbortError");
      else expect(result.value).toBeUndefined();
      expect(open.calls.allArgs().map(([uri]) => uri)).toEqual([folder]);
    });
  }

  it("refuses an incomplete project without partially replacing the current project", async () => {
    const host = await main.open({
      target: row,
      detail: { project: { paths: [folder, path.join(scratch, "missing")] } },
    });

    expect(host).toBeUndefined();
    expect(lumine.project.getPaths()).toEqual([]);
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
  });

  it("resolves Alt-Enter on the tree view to the shared chooser", () => {
    const bindings = lumine.keymaps.findKeyBindings({ target: row, keystrokes: "alt-enter" });
    expect(bindings[0]?.command).toBe("launcher:open-resource");
  });

  it("keeps the chooser alive when a suspended action menu reports an opener failure", async () => {
    const { open } = registerViewer();
    open.and.rejectWith(new Error("The viewer failed to open"));
    const host = await show();
    await host.showActions();
    const actions = lumine.workspace
      .getModalPanels()
      .find((panel) => panel.isVisible())
      .getItem();
    await actions.selectItemById("launcher:open-current");
    await expectAsync(actions.confirmSelection()).toBeRejectedWithError(
      "The viewer failed to open",
    );
    await flushMicrotasks();

    expect(host.isDestroyed()).toBe(false);
    expect(host.getModel().getSelectedItem().id).toBe("launcher:spec-viewer");
    expect(lumine.workspace.getPaneItems()).toEqual([]);
  });

  it("warns for unsaved items or a multiple tree selection while an absent surface stays silent", async () => {
    const warning = spyOn(lumine.notifications, "addWarning");
    const catalog = spyOn(lumine.workspace, "getAvailablePathOpeners").and.callThrough();
    selected = [];
    await show();
    expect(warning).not.toHaveBeenCalled();
    selected = [file, otherFile];
    await show();
    expect(warning).toHaveBeenCalledTimes(1);
    const editor = await lumine.workspace.open();
    await main.openResource({ target: editor.getElement() });
    expect(warning).toHaveBeenCalledTimes(2);
    expect(catalog).not.toHaveBeenCalled();
  });

  it("removes only the retired tree selection provider edge", async () => {
    const first = main.consumeTreeViewSelection({ selectedPaths: () => [file] });
    const second = main.consumeTreeViewSelection({ selectedPaths: () => [otherFile] });
    leases.add(first, second);
    first.dispose();
    const host = await show();
    const open = spyOn(lumine.workspace, "open").and.callThrough();
    await host.getModel().runAction("launcher:open-current");

    expect(open.calls.mostRecent().args[0]).toBe(otherFile);
  });

  it("does not let an old provider lease retire the new package generation's selection", async () => {
    const oldLease = main.consumeTreeViewSelection({ selectedPaths: () => [file] });
    leases.add(oldLease);
    await lumine.packages.deactivatePackage("launcher");
    main = (await lumine.packages.activatePackage("launcher")).mainModule;
    leases.add(main.consumeTreeViewSelection({ selectedPaths: () => [otherFile] }));
    oldLease.dispose();
    const host = await show();
    const open = spyOn(lumine.workspace, "open").and.callThrough();
    await host.getModel().runAction("launcher:open-current");

    expect(open.calls.mostRecent().args[0]).toBe(otherFile);
  });

  it("disposes the native picker on a second toggle and on package deactivation", async () => {
    const first = await show();
    await show();
    expect(first.isDestroyed()).toBe(true);
    const second = await show();
    await lumine.packages.deactivatePackage("launcher");

    expect(second.isDestroyed()).toBe(true);
    expect(second.getModel().isDestroyed()).toBe(true);
    expect(
      lumine.commands
        .findCommands({ target: lumine.workspace.getElement() })
        .map(({ name }) => name),
    ).not.toContain("launcher:open");
  });

  it("does not recreate a picker when path lookup completes after package deactivation", async () => {
    let release;
    spyOn(fsPromises, "stat").and.returnValue(new Promise((resolve) => (release = resolve)));
    const addSelectList = spyOn(lumine.workspace, "addSelectList").and.callThrough();
    const pending = show();
    await flushMicrotasks();
    await lumine.packages.deactivatePackage("launcher");
    release({ isFile: () => true, isDirectory: () => false });
    await pending;

    expect(addSelectList).not.toHaveBeenCalled();
  });

  it("cancels a pending path lookup on a second toggle without creating a late picker", async () => {
    let release;
    const lookup = spyOn(fsPromises, "stat").and.returnValue(
      new Promise((resolve) => (release = resolve)),
    );
    const addSelectList = spyOn(lumine.workspace, "addSelectList").and.callThrough();
    const pending = show();
    await flushMicrotasks();
    await show();
    release({ isFile: () => true, isDirectory: () => false });
    await pending;

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(addSelectList).not.toHaveBeenCalled();
    expect(main.requests.size).toBe(0);
  });

  it("does not replace a newer picker with the cancelled earlier path lookup", async () => {
    const lookups = [];
    spyOn(fsPromises, "stat").and.callFake(() => new Promise((resolve) => lookups.push(resolve)));
    const first = show();
    await flushMicrotasks();
    await show();
    selected = [otherFile];
    const second = show();
    await flushMicrotasks();
    lookups[1]({ isFile: () => true, isDirectory: () => false });
    const host = await second;
    lookups[0]({ isFile: () => true, isDirectory: () => false });
    expect(await first).toBeUndefined();
    const open = spyOn(lumine.workspace, "open").and.callThrough();
    await host.getModel().runAction("launcher:open-current");

    expect(open.calls.mostRecent().args[0]).toBe(otherFile);
    expect(main.requests.size).toBe(0);
  });

  it("cleans up a failed opener discovery and allows a later toggle", async () => {
    const catalog = spyOn(lumine.workspace, "getAvailablePathOpeners").and.throwError(
      "Discovery failed",
    );
    const error = spyOn(lumine.notifications, "addError");
    await show();

    expect(error).toHaveBeenCalledOnceWith("Unable to show Launcher.", {
      detail: "Discovery failed",
      dismissable: true,
    });
    expect(main.requests.size).toBe(0);
    expect(main.pickers.size).toBe(0);
    catalog.and.callThrough();
    const host = await show();
    expect(host.isVisible()).toBe(true);
  });

  for (const retirement of ["cancellation", "deactivation"]) {
    it(`discards a late viewer after picker ${retirement}`, async () => {
      let release, started;
      const constructing = new Promise((resolve) => (release = resolve));
      const began = new Promise((resolve) => (started = resolve));
      const { viewer } = registerViewer({
        open: (_uri, options) => {
          started(options);
          return constructing;
        },
      });
      const open = spyOn(lumine.workspace, "open").and.callThrough();
      const host = await show();
      const action = host.getModel().runAction("launcher:open-current");
      const options = await began;
      if (retirement === "deactivation") await lumine.packages.deactivatePackage("launcher");
      else host.cancel();
      const result = await action;

      expect(result.status).toBe("aborted");
      expect(options.signal.aborted).toBe(true);
      release(viewer);
      await open.calls.mostRecent().returnValue;
      await flushMicrotasks();
      expect(lumine.workspace.paneForItem(viewer)).toBeUndefined();
      expect(viewer.destroy).toHaveBeenCalledTimes(1);
      expect(host.isDestroyed()).toBe(true);
    });
  }

  it("cancels a delayed selected viewer when Open in This Window keeps the current project", async () => {
    lumine.project.setPaths([scratch]);
    const setState = spyOn(lumine.project, "setState").and.resolveTo(false);
    let release, started;
    const constructing = new Promise((resolve) => (release = resolve));
    const began = new Promise((resolve) => (started = resolve));
    const { viewer } = registerViewer({
      isDefaultEligible: () => false,
      open: (_uri, options) => {
        started(options);
        return constructing;
      },
    });
    const open = spyOn(lumine.workspace, "open").and.callThrough();
    const host = await show();
    await host.getModel().selectItemById("launcher:spec-viewer");
    const action = host.getModel().runAction("launcher:open-this-window");
    const options = await began;
    host.cancel();
    const result = await action;

    expect(result.status).toBe("aborted");
    expect(setState).toHaveBeenCalledOnceWith([scratch]);
    expect(open.calls.mostRecent().args[1].signal).toBe(result.signal);
    expect(options.signal.aborted).toBe(true);
    release(viewer);
    await open.calls.mostRecent().returnValue;
    await flushMicrotasks();
    expect(lumine.workspace.paneForItem(viewer)).toBeUndefined();
    expect(viewer.destroy).toHaveBeenCalledTimes(1);
    expect(host.isDestroyed()).toBe(true);
  });

  it("does not focus a detached window after cancellation while its show request is pending", async () => {
    registerViewer();
    const { window } = hiddenEditorWindow();
    let release;
    window.show.and.returnValues(new Promise((resolve) => (release = resolve)), Promise.resolve());
    const execute = spyOn(main, "execute").and.callThrough();
    const host = await show();
    const action = host.getModel().runAction("launcher:open-detached-window");
    await conditionPromise(() => window.show.calls.count() === 1);
    host.cancel();

    expect((await action).status).toBe("aborted");
    release();
    await expectAsync(execute.calls.mostRecent().returnValue).toBeRejectedWithError(
      "Opening was cancelled.",
    );
    expect(window.focus).not.toHaveBeenCalled();
    expect(host.isDestroyed()).toBe(true);
  });

  it("closes an empty detached window when cancellation overtakes its construction", async () => {
    const { window, pane } = hiddenEditorWindow();
    let release;
    detachedWindow.and.returnValue(new Promise((resolve) => (release = resolve)));
    const host = await show();
    const list = host.getModel();
    const open = spyOn(lumine.workspace, "open").and.callThrough();
    const action = list.runAction("launcher:open-detached-window");
    await conditionPromise(() => detachedWindow.calls.count() === 1);
    host.cancel();
    expect((await action).status).toBe("aborted");
    release(window);
    await flushMicrotasks();

    expect(window.destroy).toHaveBeenCalledTimes(1);
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(pane.isDestroyed()).toBe(true);
  });

  it("rechecks an opener's availability before constructing a detached window", async () => {
    let available = true;
    registerViewer({ canOpen: () => available });
    const host = await show();
    available = false;
    await expectAsync(
      host.getModel().runAction("launcher:open-detached-window"),
    ).toBeRejectedWithError("The selected opener is no longer available.");
    expect(detachedWindow).not.toHaveBeenCalled();
    expect(newWindow).not.toHaveBeenCalled();
  });
});
