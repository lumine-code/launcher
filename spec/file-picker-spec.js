const path = require("node:path");

describe("Launcher file picker", () => {
  const file = __filename;
  const otherFile = path.join(__dirname, "launcher-spec.js");
  let main, projectPaths;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    projectPaths = lumine.project.getPaths();
    lumine.project.setPaths([]);
    lumine.config.set("tree-view.alwaysOpenExisting", false);
    main = (await lumine.packages.activatePackage("launcher")).mainModule;
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("launcher");
    await lumine.workspace.discardEditorWindows();
    for (const pane of lumine.workspace.getPanes()) {
      for (const item of [...pane.getItems()]) await pane.destroyItem(item, true);
    }
    lumine.project.setPaths(projectPaths);
  });

  const choiceIds = (list) => list.getItems().map(({ id }) => id);
  const sessionId = (list) => list.getActionContext("spec").sessionId;

  function expectDefaultSelected(list) {
    const choice = list.getItems().find(({ isDefault }) => isDefault);
    expect(choice).toBeDefined();
    expect(list.getSelectedItem()).toBe(choice);
  }

  it("chooses a file once and opens it in the clicked empty inactive pane", async () => {
    const workspace = lumine.workspace;
    const activeEditor = await workspace.open(file, { opener: "text-editor", pending: false });
    const activePane = workspace.paneForItem(activeEditor);
    const emptyPane = activePane.splitRight({ activate: false });
    activePane.activate();
    const window = emptyPane.getContainer().getWindow();
    let complete;
    const choose = spyOn(window, "showOpenDialog").and.callFake(
      () => new Promise((resolve) => (complete = resolve)),
    );
    const show = spyOn(main, "show").and.callThrough();
    const target = emptyPane.getElement().querySelector(".item-views");
    const actions = lumine.contextMenu
      .templateForElement(target)
      .filter(({ label }) => label === "Open\u2026");

    expect(actions.length).toBe(1);
    expect(actions[0].enabled).not.toBe(false);
    expect(lumine.commands.canDispatch(target, actions[0].command)).toBe(true);
    lumine.commands.dispatch(target, actions[0].command);
    expect(show).toHaveBeenCalledTimes(1);
    const opening = show.calls.mostRecent().returnValue;
    await conditionPromise(() => Boolean(complete));

    expect(main.pickers.size).toBe(0);
    activePane.activate();
    expect(choose).toHaveBeenCalledOnceWith({ title: "Open", properties: ["openFile"] });
    complete({ canceled: false, filePaths: [otherFile] });
    const host = await opening;
    const list = host.getModel();

    expect(host.isVisible()).toBe(true);
    expect(host.isDestroyed()).toBe(false);
    expect(main.pickers.get(window).host).toBe(host);
    expect(main.pickers.get(window).context).toEqual(
      jasmine.objectContaining({ pane: emptyPane, window, path: otherFile }),
    );
    expect(choiceIds(list)).toContain("text-editor");
    expectDefaultSelected(list);
    await list.selectItemById("text-editor");
    const result = await list.runAction("launcher:open-current");

    expect(result.status).toBe("success");
    expect(emptyPane.getItems().some((item) => item.getPath?.() === otherFile)).toBe(true);
    expect(activePane.getItems()).toEqual([activeEditor]);
    expect(choose).toHaveBeenCalledTimes(1);
  });

  it("creates no Launcher host or request when the initial native file dialog is cancelled", async () => {
    const pane = lumine.workspace.getCenter().getActivePane();
    const window = pane.getContainer().getWindow();
    const addList = spyOn(lumine.workspace, "addSelectList").and.callThrough();
    const choose = spyOn(window, "showOpenDialog").and.resolveTo({
      canceled: true,
      filePaths: [],
    });
    const host = await main.open({ target: pane.getElement() });

    expect(choose).toHaveBeenCalledTimes(1);
    expect(host).toBeUndefined();
    expect(addList).not.toHaveBeenCalled();
    expect(main.pickers.size).toBe(0);
    expect(main.requests.size).toBe(0);
    expect(pane.getItems()).toEqual([]);
  });

  it("starts the native picker at the first project root instead of the active file's directory", async () => {
    const workspace = lumine.workspace;
    const firstRoot = path.dirname(__dirname);
    const secondRoot = path.join(firstRoot, "lib");
    lumine.project.setPaths([firstRoot, secondRoot]);
    const activeEditor = await workspace.open(path.join(secondRoot, "main.js"), {
      opener: "text-editor",
      pending: false,
    });
    const activePane = workspace.paneForItem(activeEditor);
    const emptyPane = activePane.splitRight({ activate: false });
    activePane.activate();
    const choose = spyOn(emptyPane.getContainer().getWindow(), "showOpenDialog").and.resolveTo({
      canceled: false,
      filePaths: [otherFile],
    });

    const host = await main.openResource({
      target: emptyPane.getElement().querySelector(".item-views"),
    });

    expect(choose).toHaveBeenCalledOnceWith({
      title: "Open",
      properties: ["openFile"],
      defaultPath: firstRoot,
    });
    expect(main.pickers.get(host.window).host).toBe(host);
    expect(main.pickers.get(host.window).context.pane).toBe(emptyPane);
    expectDefaultSelected(host.getModel());
  });

  it("leaves the native default directory unspecified without project roots", async () => {
    const pane = lumine.workspace.getCenter().getActivePane();
    const choose = spyOn(pane.getContainer().getWindow(), "showOpenDialog").and.resolveTo({
      canceled: false,
      filePaths: [otherFile],
    });

    const host = await main.open({ target: pane.getElement() });

    expect(choose).toHaveBeenCalledTimes(1);
    expect(Object.hasOwn(choose.calls.mostRecent().args[0], "defaultPath")).toBe(false);
    expectDefaultSelected(host.getModel());
  });

  it("ignores a cancelled initial native dialog result after a newer Launcher opens", async () => {
    const pane = lumine.workspace.getCenter().getActivePane();
    const window = pane.getContainer().getWindow();
    let complete;
    spyOn(window, "showOpenDialog").and.callFake(
      () => new Promise((resolve) => (complete = resolve)),
    );
    const opening = main.open({ target: pane.getElement() });
    await conditionPromise(() => Boolean(complete));

    expect(main.pickers.size).toBe(0);
    expect(await main.open({ target: pane.getElement() })).toBeUndefined();
    const current = await main.provideLauncher().open({ path: file, pane });
    const record = main.pickers.get(window);
    const list = current.getModel();
    const session = sessionId(list);
    const ids = choiceIds(list);
    complete({ canceled: false, filePaths: [otherFile] });
    expect(await opening).toBeUndefined();

    expect(current.isVisible()).toBe(true);
    expect(current.isDestroyed()).toBe(false);
    expect(main.pickers.get(window)).toBe(record);
    expect(record.host).toBe(current);
    expect(record.context.path).toBe(file);
    expect(sessionId(list)).toBe(session);
    expect(choiceIds(list)).toEqual(ids);
    expectDefaultSelected(list);
    expect(pane.getItems()).toEqual([]);
  });

  it("cleans up a failed initial native dialog and allows another opening", async () => {
    const pane = lumine.workspace.getCenter().getActivePane();
    const window = pane.getContainer().getWindow();
    const choose = spyOn(window, "showOpenDialog").and.rejectWith(new Error("Picker failed"));
    const errors = spyOn(lumine.notifications, "addError").and.callThrough();

    expect(await main.open({ target: pane.getElement() })).toBeUndefined();

    expect(main.pickers.size).toBe(0);
    expect(main.requests.size).toBe(0);
    expect(errors).toHaveBeenCalledOnceWith("Unable to show Launcher.", {
      detail: "Picker failed",
      dismissable: true,
    });
    choose.and.resolveTo({ canceled: false, filePaths: [otherFile] });
    const host = await main.open({ target: pane.getElement() });

    expect(choose).toHaveBeenCalledTimes(2);
    expect(main.pickers.get(window).host).toBe(host);
    expect(main.pickers.get(window).context.path).toBe(otherFile);
    expectDefaultSelected(host.getModel());
  });

  it("uses the native picker belonging to its captured detached window", async () => {
    const workspace = lumine.workspace;
    const extra = await workspace.openEditorWindow({ show: false });
    const pane = extra.getEditorContainer().getActivePane();
    const mainDialog = spyOn(workspace.getMainWindow(), "showOpenDialog");
    const extraDialog = spyOn(extra, "showOpenDialog").and.resolveTo({
      canceled: false,
      filePaths: [otherFile],
    });
    const host = await main.open({ target: pane.getElement() });

    expect(host.window).toBe(extra);
    expect(extraDialog).toHaveBeenCalledOnceWith({ title: "Open", properties: ["openFile"] });
    expect(mainDialog).not.toHaveBeenCalled();
    expect(main.pickers.get(extra).host).toBe(host);
    expect(main.pickers.get(extra).context).toEqual(
      jasmine.objectContaining({ pane, window: extra, path: otherFile }),
    );
  });
});
