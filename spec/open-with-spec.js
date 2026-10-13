const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { CompositeDisposable } = require("lumine");

describe("Open With", () => {
  let main, external, leases, scratch, file, otherFile, folder, selected, tree, row;
  let projectPaths, newWindow, detachedWindow;

  beforeEach(async () => {
    jasmine.useRealClock();
    projectPaths = lumine.project.getPaths();
    lumine.project.setPaths([]);
    scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lumine-open-with-")));
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
    main = (await lumine.packages.activatePackage("open-with")).mainModule;
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
    await lumine.packages.deactivatePackage("open-with");
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
      throw new Error("Open With scratch directory escaped the private temporary root");
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const event = () => ({ target: row });
  const show = () => main.toggle(event());
  const actionNames = (list) => list.getAvailableActions().map(({ command }) => command);

  function registerViewer(options = {}) {
    const viewer = document.createElement("div");
    viewer.getURI = () => file;
    viewer.getPath = () => file;
    viewer.getTitle = () => "Document Viewer";
    viewer.destroy = jasmine.createSpy("destroy viewer").and.callFake(() => viewer.remove());
    const open = jasmine.createSpy("open viewer").and.returnValue(viewer);
    const descriptor = {
      id: "open-with:spec-viewer",
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

  it("puts the actual default first and marks only that row", async () => {
    registerViewer();
    const host = await show();
    const list = host.getModel();

    expect(list.getItems().map(({ id }) => id)).toEqual([
      "open-with:spec-viewer",
      "open-external",
      "open-external:show",
      "text-editor",
    ]);
    expect(list.getSelectedItem().id).toBe("open-with:spec-viewer");
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
    const result = await list.runAction("open-with:open");

    expect(result.status).toBe("success");
    const editor = originalPane.getItems().find((item) => item.getPath?.() === file);
    expect(editor?.getText()).toBe("first document\n");
    expect(otherPane.getItems()).toEqual([]);
    expect(host.isDestroyed()).toBe(true);
    expect(newWindow).not.toHaveBeenCalled();
    expect(detachedWindow).not.toHaveBeenCalled();
  });

  it("opens the selected viewer in an independent project window", async () => {
    const { open } = registerViewer({ isDefaultEligible: () => false });
    const host = await show();
    expect(host.getModel().getSelectedItem().id).toBe("text-editor");
    await host.getModel().selectItemById("open-with:spec-viewer");
    const result = await host.getModel().runAction("open-with:new-window");

    expect(result.status).toBe("success");
    expect(newWindow).toHaveBeenCalledOnceWith(file, {
      opener: "open-with:spec-viewer",
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
    await host.getModel().selectItemById("open-with:spec-viewer");
    const workspaceOpen = spyOn(lumine.workspace, "open").and.callThrough();
    const result = await host.getModel().runAction("open-with:detached-window");

    expect(result.status).toBe("success");
    expect(detachedWindow).toHaveBeenCalledOnceWith({ show: false });
    expect(open).toHaveBeenCalledTimes(1);
    const [openedPath, options] = open.calls.mostRecent().args;
    expect(openedPath).toBe(file);
    expect(options.opener).toBe("open-with:spec-viewer");
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
    const result = await host.getModel().runAction("open-with:detached-window");

    expect(result.status).toBe("success");
    expect(pane.getItems()[0].getText()).toBe("first document\n");
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps a plain click on a label opening the clicked opener in the current pane", async () => {
    const { viewer, open } = registerViewer({ isDefaultEligible: () => false });
    const host = await show();
    const originalPane = lumine.workspace.getMainWindow().getEditorContainer().getActivePane();
    expect(host.getModel().getSelectedItem().id).toBe("text-editor");
    const { result } = await clickChoice(host, "open-with:spec-viewer", {}, ".primary-text");

    expect(result.status).toBe("success");
    expect(result.command).toBe("open-with:open");
    expect(open).toHaveBeenCalledTimes(1);
    expect(originalPane.getItems()).toContain(viewer);
    expect(newWindow).not.toHaveBeenCalled();
    expect(detachedWindow).not.toHaveBeenCalled();
    expect(host.isDestroyed()).toBe(true);
  });

  it("opens a nonselected nondefault opener exactly once on Ctrl-click", async () => {
    const { open } = registerViewer({ isDefaultEligible: () => false });
    const host = await show();
    expect(host.getModel().getSelectedItem().id).toBe("text-editor");
    const { click, result } = await clickChoice(host, "open-with:spec-viewer", { ctrlKey: true });

    expect(click.defaultPrevented).toBe(true);
    expect(result.status).toBe("success");
    expect(result.command).toBe("open-with:new-window");
    expect(newWindow).toHaveBeenCalledOnceWith(file, {
      opener: "open-with:spec-viewer",
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
    expect(host.getModel().getSelectedItem().id).toBe("open-with:spec-viewer");
    const { result } = await clickChoice(host, "text-editor", { altKey: true }, ".primary-text");

    expect(result.status).toBe("success");
    expect(result.command).toBe("open-with:detached-window");
    expect(detachedWindow).toHaveBeenCalledOnceWith({ show: false });
    expect(pane.getItems().length).toBe(1);
    expect(pane.getItems()[0].getPath()).toBe(file);
    expect(pane.getItems()[0].getText()).toBe("first document\n");
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(newWindow).not.toHaveBeenCalled();
  });

  it("prefers the detached destination when Alt and Ctrl are held together", async () => {
    const host = await show();
    const execute = spyOn(main, "execute").and.resolveTo();
    const { result } = await clickChoice(host, "text-editor", { altKey: true, ctrlKey: true });

    expect(result.status).toBe("success");
    expect(result.command).toBe("open-with:detached-window");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.calls.mostRecent().args[2]).toBe("detached-window");
  });

  it("keeps a folder Alt-click unavailable and opens its project only on Ctrl-click", async () => {
    selected = [folder];
    const host = await show();
    const unsupported = await clickChoice(host, "project-folder", { altKey: true });

    expect(unsupported.result.status).toBe("unavailable");
    expect(unsupported.result.command).toBe("open-with:detached-window");
    expect(host.isVisible()).toBe(true);
    expect(lumine.project.getPaths()).toEqual([]);
    expect(newWindow).not.toHaveBeenCalled();
    expect(detachedWindow).not.toHaveBeenCalled();
    const { result } = await clickChoice(host, "project-folder", { ctrlKey: true });
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
    expect(result.command).toBe("open-with:this-window");
    expect(lumine.project.getPaths()).toEqual([folder]);
    expect(newWindow).not.toHaveBeenCalled();
    expect(detachedWindow).not.toHaveBeenCalled();
    expect(lumine.shell.openPath).not.toHaveBeenCalled();
    expect(host.isDestroyed()).toBe(true);
  });

  it("keeps a file Shift-click opening the clicked opener in the current pane", async () => {
    const { viewer, open } = registerViewer({ isDefaultEligible: () => false });
    const host = await show();
    const { result } = await clickChoice(
      host,
      "open-with:spec-viewer",
      { shiftKey: true },
      ".primary-text",
    );

    expect(result.status).toBe("success");
    expect(result.command).toBe("open-with:open");
    expect(open).toHaveBeenCalledTimes(1);
    expect(lumine.workspace.paneForItem(viewer)).toBeDefined();
    expect(lumine.project.getPaths()).toEqual([]);
    expect(newWindow).not.toHaveBeenCalled();
    expect(detachedWindow).not.toHaveBeenCalled();
  });

  it("resolves Shift-Enter as This Window only while choosing a folder opener", async () => {
    const fileHost = await show();
    const fileInput = fileHost.getModel().getQueryEditor().getElement();
    const fileBindings = lumine.keymaps.findKeyBindings({
      target: fileInput,
      keystrokes: "shift-enter",
    });
    expect(fileBindings.some((binding) => binding.command === "open-with:this-window")).toBe(false);
    fileHost.cancel();
    await fileHost.destroy();
    selected = [folder];
    const folderHost = await show();
    const folderInput = folderHost.getModel().getQueryEditor().getElement();
    const folderBindings = lumine.keymaps.findKeyBindings({
      target: folderInput,
      keystrokes: "shift-enter",
    });

    expect(folderBindings[0]?.command).toBe("open-with:this-window");
  });

  for (const id of ["open-external", "open-external:show"]) {
    it(`does not fall back to the primary action for Ctrl-click or Alt-click on ${id}`, async () => {
      const open = spyOn(external, "openExternal").and.resolveTo("");
      const showInFolder = spyOn(external, "showInFolder").and.resolveTo("");
      const host = await show();
      for (const modifiers of [{ ctrlKey: true }, { altKey: true }]) {
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
      expect(result.command).toBe("open-with:this-window");
      expect(host.isVisible()).toBe(true);
      expect(host.getModel().getSelectedItem().id).toBe(id);
      expect(lumine.project.getPaths()).toEqual([]);
      expect(open).not.toHaveBeenCalled();
      expect(showInFolder).not.toHaveBeenCalled();
      expect(newWindow).not.toHaveBeenCalled();
      expect(detachedWindow).not.toHaveBeenCalled();
    });
  }

  it("handles a filtered badge click and removes modifier listeners from rerendered and destroyed rows", async () => {
    registerViewer();
    const host = await show();
    const list = host.getModel();
    const retiredRow = choiceRow(list, "open-with:spec-viewer");
    const dispatch = spyOn(lumine.commands, "dispatch").and.callThrough();
    await list.setQuery("document");
    const currentRow = choiceRow(list, "open-with:spec-viewer");
    expect(currentRow).not.toBe(retiredRow);
    expect(currentRow.querySelector(".character-match")).not.toBeNull();
    const retiredClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    retiredRow.querySelector(".badge").dispatchEvent(retiredClick);
    await flushMicrotasks();

    expect(retiredClick.defaultPrevented).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    const { result } = await clickChoice(
      host,
      "open-with:spec-viewer",
      { ctrlKey: true },
      ".badge",
    );
    expect(result.status).toBe("success");
    expect(newWindow).toHaveBeenCalledTimes(1);
    expect(dispatch.calls.first().args[0]).toBe(list.getElement());
    expect(dispatch.calls.first().args[1]).toBe("open-with:new-window");
    expect(host.isDestroyed()).toBe(true);
    const cancelledHost = await show();
    const destroyedRow = choiceRow(cancelledHost.getModel(), "open-with:spec-viewer");
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
    const result = await host.getModel().runAction("open-with:this-window");

    expect(result.status).toBe("success");
    expect(lumine.project.getPaths()).toEqual([scratch]);
    expect(lumine.workspace.paneForItem(viewer)).toBeDefined();
    expect(open.calls.mostRecent().args[1].opener).toBe("open-with:spec-viewer");
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

      expect(actionNames(list)).toEqual(["open-with:open"]);
      for (const command of [
        "open-with:new-window",
        "open-with:detached-window",
        "open-with:this-window",
      ]) {
        expect((await list.runAction(command)).status).toBe("unavailable");
      }
      expect(action).not.toHaveBeenCalled();
      expect(newWindow).not.toHaveBeenCalled();
      expect(detachedWindow).not.toHaveBeenCalled();
      expect((await list.runAction("open-with:open")).status).toBe("success");
      expect(action).toHaveBeenCalledOnceWith(file);
      expect(lumine.workspace.getPaneItems()).toEqual([]);
    });
  }

  it("offers a folder project as the default with current and new-window actions only", async () => {
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
    expect(actionNames(list)).toContain("open-with:open");
    expect(actionNames(list)).toContain("open-with:new-window");
    expect(actionNames(list)).not.toContain("open-with:detached-window");
    expect((await list.runAction("open-with:detached-window")).status).toBe("unavailable");
    expect(detachedWindow).not.toHaveBeenCalled();
    expect((await list.runAction("open-with:open")).status).toBe("success");
    expect(lumine.project.getPaths()).toEqual([folder]);
    expect(lumine.workspace.getTextEditors().some((editor) => editor.getPath() === folder)).toBe(
      false,
    );
  });

  it("opens a folder as a separate project in a new window", async () => {
    selected = [folder];
    const host = await show();
    const result = await host.getModel().runAction("open-with:new-window");

    expect(result.status).toBe("success");
    expect(newWindow).toHaveBeenCalledOnceWith(folder, {
      opener: "project-folder",
      pathKind: "directory",
      signal: result.signal,
    });
    expect(lumine.project.getPaths()).toEqual([]);
    expect(detachedWindow).not.toHaveBeenCalled();
  });

  it("refuses a direct detached-window command for a folder with a reason", async () => {
    selected = [folder];
    const warning = spyOn(lumine.notifications, "addWarning");
    await main.openDefault(event(), "detached-window");

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.calls.mostRecent().args[0]).toContain("Project Folder");
    expect(detachedWindow).not.toHaveBeenCalled();
    expect(newWindow).not.toHaveBeenCalled();
    expect(lumine.project.getPaths()).toEqual([]);
  });

  it("keeps direct commands on the workspace for user-defined quick bindings", () => {
    const commands = lumine.commands.findCommands({ target: lumine.workspace.getElement() });
    for (const name of [
      "open-with:toggle",
      "open-with:open",
      "open-with:new-window",
      "open-with:detached-window",
      "open-with:this-window",
    ])
      expect(commands.map((command) => command.name)).toContain(name);
  });

  for (const [command, destination] of [
    ["open-with:open", "current"],
    ["open-with:new-window", "new-window"],
    ["open-with:detached-window", "detached-window"],
  ]) {
    it(`uses the default opener for the direct ${command} command`, async () => {
      registerViewer();
      const host = await show();
      await host.getModel().selectItemById("text-editor");
      const execute = spyOn(main, "execute").and.resolveTo();
      await lumine.commands.dispatch(row, command);

      expect(execute).toHaveBeenCalledTimes(1);
      const [context, choice, actualDestination] = execute.calls.mostRecent().args;
      expect(context.path).toBe(file);
      expect(choice.id).toBe("open-with:spec-viewer");
      expect(actualDestination).toBe(destination);
    });
  }

  it("keeps an external default from opening a new or detached window through a direct command", async () => {
    lumine.config.set("open-external.flag", true);
    const warning = spyOn(lumine.notifications, "addWarning");
    await main.openDefault(event(), "new-window");
    await main.openDefault(event(), "detached-window");

    expect(warning).toHaveBeenCalledTimes(2);
    expect(lumine.shell.openPath).not.toHaveBeenCalled();
    expect(newWindow).not.toHaveBeenCalled();
    expect(detachedWindow).not.toHaveBeenCalled();
  });

  it("handles a picker command once with its selected opener without bubbling to the workspace default", async () => {
    registerViewer();
    const host = await show();
    const list = host.getModel();
    await list.selectItemById("text-editor");
    const execute = spyOn(main, "execute").and.resolveTo();
    const openDefault = spyOn(main, "openDefault").and.callThrough();
    await lumine.commands.dispatch(list.getQueryEditor().getElement(), "open-with:new-window");
    await flushMicrotasks();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.calls.mostRecent().args[1].id).toBe("text-editor");
    expect(execute.calls.mostRecent().args[2]).toBe("new-window");
    expect(openDefault).not.toHaveBeenCalled();
  });

  it("resolves Enter, Ctrl+Enter and Alt+Enter on the picker input", async () => {
    const host = await show();
    const input = host.getModel().getQueryEditor().getElement();
    for (const [keystrokes, command] of [
      ["enter", "open-with:open"],
      ["ctrl-enter", "open-with:new-window"],
      ["alt-enter", "open-with:detached-window"],
    ]) {
      const matches = lumine.keymaps.findKeyBindings({ target: input, keystrokes });
      expect(matches[0]?.command).toBe(command);
    }
  });

  it("uses the active saved item outside the tree view", async () => {
    await lumine.workspace.open(otherFile, { opener: "text-editor" });
    const host = await main.toggle({ target: lumine.workspace.getElement() });
    const open = spyOn(lumine.workspace, "open").and.callThrough();
    await host.getModel().runAction("open-with:open");

    expect(open.calls.mostRecent().args[0]).toBe(otherFile);
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
    await lumine.workspace.open();
    await main.toggle({ target: lumine.workspace.getElement() });
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
    await host.getModel().runAction("open-with:open");

    expect(open.calls.mostRecent().args[0]).toBe(otherFile);
  });

  it("does not let an old provider lease retire the new package generation's selection", async () => {
    const oldLease = main.consumeTreeViewSelection({ selectedPaths: () => [file] });
    leases.add(oldLease);
    await lumine.packages.deactivatePackage("open-with");
    main = (await lumine.packages.activatePackage("open-with")).mainModule;
    leases.add(main.consumeTreeViewSelection({ selectedPaths: () => [otherFile] }));
    oldLease.dispose();
    const host = await show();
    const open = spyOn(lumine.workspace, "open").and.callThrough();
    await host.getModel().runAction("open-with:open");

    expect(open.calls.mostRecent().args[0]).toBe(otherFile);
  });

  it("disposes the native picker on a second toggle and on package deactivation", async () => {
    const first = await show();
    await show();
    expect(first.isDestroyed()).toBe(true);
    const second = await show();
    await lumine.packages.deactivatePackage("open-with");

    expect(second.isDestroyed()).toBe(true);
    expect(second.getModel().isDestroyed()).toBe(true);
    expect(
      lumine.commands
        .findCommands({ target: lumine.workspace.getElement() })
        .map(({ name }) => name),
    ).not.toContain("open-with:toggle");
  });

  it("does not recreate a picker when path lookup completes after package deactivation", async () => {
    let release;
    spyOn(fsPromises, "stat").and.returnValue(new Promise((resolve) => (release = resolve)));
    const addSelectList = spyOn(lumine.workspace, "addSelectList").and.callThrough();
    const pending = show();
    await flushMicrotasks();
    await lumine.packages.deactivatePackage("open-with");
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
    await host.getModel().runAction("open-with:open");

    expect(open.calls.mostRecent().args[0]).toBe(otherFile);
    expect(main.requests.size).toBe(0);
  });

  it("cleans up a failed opener discovery and allows a later toggle", async () => {
    const catalog = spyOn(lumine.workspace, "getAvailablePathOpeners").and.throwError(
      "Discovery failed",
    );
    const error = spyOn(lumine.notifications, "addError");
    await show();

    expect(error).toHaveBeenCalledOnceWith("Unable to show Open With.", {
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
      const action = host.getModel().runAction("open-with:open");
      const options = await began;
      if (retirement === "deactivation") await lumine.packages.deactivatePackage("open-with");
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
    await host.getModel().selectItemById("open-with:spec-viewer");
    const action = host.getModel().runAction("open-with:this-window");
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
    const action = host.getModel().runAction("open-with:detached-window");
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
    const action = list.runAction("open-with:detached-window");
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
    await expectAsync(host.getModel().runAction("open-with:detached-window")).toBeRejectedWithError(
      "The selected opener is no longer available.",
    );
    expect(detachedWindow).not.toHaveBeenCalled();
    expect(newWindow).not.toHaveBeenCalled();
  });
});
