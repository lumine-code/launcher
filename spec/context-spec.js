describe("Launcher command context", () => {
  let main;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("launcher")).mainModule;
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("launcher");
    await lumine.workspace.discardEditorWindows();
  });

  function switchPaneAfterDestruction(host, pane) {
    const destroy = host.destroy.bind(host);
    return spyOn(host, "destroy").and.callFake(async () => {
      await destroy();
      expect(host.getModel().isDestroyed()).toBe(true);
      pane.activate();
    });
  }

  async function dispatch(command, target = lumine.workspace.getElement()) {
    const show = spyOn(main, "show").and.callThrough();
    lumine.commands.dispatch(target, command);
    expect(show).toHaveBeenCalledTimes(1);
    const call = show.calls.mostRecent();
    const event = call.args[1];
    expect(Object.isFrozen(event.context)).toBe(true);
    return { event, host: await call.returnValue };
  }

  it("keeps the Open dispatch pane when switching to New after real asynchronous destruction", async () => {
    const workspace = lumine.workspace;
    const original = workspace.getCenter().getActivePane();
    const another = original.splitRight({ activate: false });
    original.activate();
    const existing = await main.open({
      target: workspace.getElement(),
      detail: { path: __filename },
    });
    const destroy = switchPaneAfterDestruction(existing, another);

    const { event, host } = await dispatch("launcher:new");

    expect(event.context.documentPane).toBe(original);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(existing.isDestroyed()).toBe(true);
    expect(workspace.getCenter().getActivePane()).toBe(another);
    expect(main.pickers.get(host.window).mode).toBe("new");
    expect(main.pickers.get(host.window).context.pane).toBe(original);
  });

  it("keeps the New dispatch pane when switching to Open after real asynchronous destruction", async () => {
    const workspace = lumine.workspace;
    const original = workspace.getCenter().getActivePane();
    const another = original.splitRight({ activate: false });
    original.activate();
    const existing = await main.create({ target: workspace.getElement() });
    const destroy = switchPaneAfterDestruction(existing, another);
    const openDialog = spyOn(workspace.getMainWindow(), "showOpenDialog").and.resolveTo({
      canceled: false,
      filePaths: [__filename],
    });

    const { event, host } = await dispatch("launcher:open");

    expect(event.context.documentPane).toBe(original);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(existing.isDestroyed()).toBe(true);
    expect(openDialog).toHaveBeenCalledTimes(1);
    expect(workspace.getCenter().getActivePane()).toBe(another);
    expect(main.pickers.get(host.window).mode).toBe("open");
    expect(main.pickers.get(host.window).context.pane).toBe(original);
    expect(main.pickers.get(host.window).context.path).toBe(__filename);
  });

  it("owns a main-dock request in its captured auxiliary document presentation and clears it on close", async () => {
    const workspace = lumine.workspace;
    const mainWindow = workspace.getMainWindow();
    const extra = await workspace.openEditorWindow({ show: false });
    const documentPane = extra.getEditorContainer().getActivePane();
    documentPane.activate();
    const dockTarget = workspace.getLeftDock().getActivePane().getElement();

    const { event, host } = await dispatch("launcher:new", dockTarget);

    expect(event.context.window).toBe(mainWindow);
    expect(event.context.documentPane).toBe(documentPane);
    expect(host.window).toBe(extra);
    expect(main.pickers.get(extra).context.pane).toBe(documentPane);
    expect(main.pickers.has(mainWindow)).toBe(false);
    expect(main.requests.has(extra)).toBe(true);
    expect(main.requests.has(mainWindow)).toBe(false);

    expect(await workspace.closeEditorWindow(extra)).toBe(true);

    expect(host.isDestroyed()).toBe(true);
    expect(main.pickers.size).toBe(0);
    expect(main.requests.size).toBe(0);
  });
});
