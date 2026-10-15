const path = require("node:path");
const { CompositeDisposable, Disposable } = require("lumine");

describe("Launcher New", () => {
  let main, leases, ownedItems;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    leases = new CompositeDisposable();
    ownedItems = new Set();
    main = (await lumine.packages.activatePackage("launcher")).mainModule;
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("launcher");
    leases.dispose();
    for (const pane of lumine.workspace.getPanes()) {
      for (const item of [...pane.getItems()]) await pane.destroyItem(item, true);
    }
    for (const item of ownedItems) {
      if (!item.isDestroyed()) item.destroy();
    }
    for (const name of ["jupyter-view", "terminal", "graviss"]) {
      await lumine.packages.deactivatePackage(name);
    }
  });

  const event = () => ({ target: lumine.workspace.getElement() });
  const context = () => main.creationContext(event());
  const choiceIds = (host) =>
    host
      .getModel()
      .getItems()
      .map(({ id }) => id);

  function makeItem({ locations = ["center"] } = {}) {
    const item = document.createElement("div");
    let destroyed = false;
    item.getTitle = () => "Created Content";
    item.getAllowedLocations = () => locations;
    item.isDestroyed = () => destroyed;
    item.destroy = jasmine.createSpy("destroy created content").and.callFake(() => {
      destroyed = true;
      item.remove();
    });
    ownedItems.add(item);
    return item;
  }

  function registerProvider(overrides = {}) {
    const provider = {
      id: "spec-content",
      label: "Spec Content",
      create: jasmine.createSpy("create content").and.callFake(() => makeItem()),
      ...overrides,
    };
    const lease = main.consumeLauncher(provider);
    leases.add(lease);
    return { provider, lease };
  }

  function delayedProvider() {
    let release, started;
    const result = new Promise((resolve) => (release = resolve));
    const began = new Promise((resolve) => (started = resolve));
    const registration = registerProvider({
      create: jasmine.createSpy("create delayed content").and.callFake((options) => {
        started(options);
        return result;
      }),
    });
    return { ...registration, release, began };
  }

  it("labels the public menu actions with real ellipses and routes contextual Open to its wrapper", () => {
    const menus = require("../menus/main.json");
    const packageActions = menus.menu[0].submenu[0].submenu;
    expect(packageActions).toEqual([
      { label: "New Content\u2026", command: "launcher:new" },
      { label: "Open Resource\u2026", command: "launcher:open" },
    ]);
    const contextActions = Object.values(menus["context-menu"])
      .flat()
      .filter(({ command }) => command);
    expect(contextActions.length).toBeGreaterThan(0);
    for (const action of contextActions) {
      if (action.command === "launcher:new") expect(action.label).toBe("New\u2026");
      else {
        expect(action.command).toBe("launcher:open-resource");
        expect(action.label).toBe("Open\u2026");
      }
    }
    expect(JSON.stringify(menus)).not.toContain("\ufffd");
  });

  it("opens the clicked inactive tab resource through one contextual dispatch", async () => {
    const selected = await lumine.workspace.open(__filename, { opener: "text-editor" });
    const active = await lumine.workspace.open(path.join(__dirname, "launcher-spec.js"), {
      opener: "text-editor",
    });
    const pane = lumine.workspace.paneForItem(selected);
    const tab = document.createElement("li");
    tab.className = "tab";
    tab.item = selected;
    pane.getElement().appendChild(tab);
    const open = spyOn(main, "open").and.callThrough();
    try {
      lumine.commands.dispatch(tab, "launcher:open-resource");
      expect(open).toHaveBeenCalledTimes(1);
      const host = await open.calls.mostRecent().returnValue;

      expect(main.pickers.get(host.window).context.path).toBe(__filename);
      expect(main.pickers.get(host.window).context.pane).toBe(pane);
      expect(pane.getActiveItem()).toBe(active);
    } finally {
      tab.remove();
    }
  });

  it("consumes the real core factory and creates independent text editors through the picker", async () => {
    expect(main.providers.get("text-editor")).toBeDefined();
    const pane = context().pane;
    for (let index = 0; index < 2; index++) {
      const host = await main.create(event());
      expect(choiceIds(host)[0]).toBe("text-editor");
      await host.getModel().selectItemById("text-editor");
      expect((await host.getModel().runAction("launcher:create")).status).toBe("success");
      expect(host.isDestroyed()).toBe(true);
    }
    const editors = pane.getItems();
    expect(editors.length).toBe(2);
    expect(editors[0]).not.toBe(editors[1]);
    expect(editors.every((item) => lumine.workspace.isTextEditor(item))).toBe(true);
    expect(editors.every((item) => item.getPath() == null && item.getText() === "")).toBe(true);
    expect(pane.getPendingItem()).toBeFalsy();
  });

  for (const id of ["jupyter-view", "terminal", "graviss"]) {
    it(`wires the actual ${id} package into New and opens its item in center`, async () => {
      if (id === "terminal") localStorage.setItem("terminal.autoShellSet", "true");
      const pack = await lumine.packages.activatePackage(id);
      if (id === "terminal") require(path.join(pack.path, "spec", "helpers")).stubPty();
      expect(main.providers.get(id)).toBeDefined();
      const pane = context().pane;
      const host = await main.create(event());
      expect(choiceIds(host)).toContain(id);
      await host.getModel().selectItemById(id);

      expect((await host.getModel().runAction("launcher:create")).status).toBe("success");
      const item = pane.getActiveItem();
      expect(item).toBeDefined();
      expect(lumine.workspace.paneForItem(item)).toBe(pane);
      expect(item.getDefaultLocation()).toBe("center");
      if (id === "jupyter-view") expect(item.constructor.name).toBe("JupyterNotebookEditor");
      if (id === "terminal") expect(item.getURI().startsWith("terminal://")).toBe(true);
      if (id === "graviss") expect(pack.mainModule.viewers.has(item)).toBe(true);
      expect(host.isDestroyed()).toBe(true);
    });
  }

  it("captures the center pane when invoked from a dock and keeps it after another pane activates", async () => {
    const original = context().pane;
    const dockItem = makeItem({ locations: ["center", "left"] });
    await lumine.workspace.open(dockItem, { location: "left" });
    const host = await main.create({ target: dockItem });
    const another = original.splitRight();
    another.activate();
    await host.getModel().selectItemById("text-editor");
    const open = spyOn(lumine.workspace, "open").and.callThrough();

    await host.getModel().runAction("launcher:create");

    const [item, options] = open.calls.mostRecent().args;
    expect(options).toEqual(jasmine.objectContaining({ pane: original, location: "center" }));
    expect(lumine.workspace.paneForItem(item)).toBe(original);
    expect(another.getItems()).toEqual([]);
    expect(lumine.workspace.paneForItem(dockItem).getContainer().getLocation()).toBe("left");
  });

  it("honors an explicitly captured center pane", async () => {
    const original = context().pane;
    const another = original.splitRight();
    another.activate();
    const host = await main.create({ ...event(), detail: { pane: original } });
    await host.getModel().selectItemById("text-editor");
    await host.getModel().runAction("launcher:create");

    expect(lumine.workspace.isTextEditor(original.getActiveItem())).toBe(true);
    expect(another.getItems()).toEqual([]);
  });

  it("refuses a dock as the explicit destination before showing New", async () => {
    const warning = spyOn(lumine.notifications, "addWarning");
    const show = spyOn(lumine.workspace, "addSelectList").and.callThrough();
    const pane = lumine.workspace.getLeftDock().getActivePane();

    expect(await main.create({ ...event(), detail: { pane } })).toBeUndefined();
    expect(warning).toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });

  it("closes New and refuses stale confirmation when the destination disappeared before creation", async () => {
    const original = context().pane;
    const target = original.splitRight();
    const captured = { ...context(), pane: target };
    const { provider } = registerProvider();
    const host = await main.create({ ...event(), detail: { pane: target } });
    await host.getModel().selectItemById(provider.id);

    target.destroy();
    await flushMicrotasks();
    expect(host.isDestroyed()).toBe(true);
    await expectAsync(main.createItem(captured, { id: provider.id })).toBeRejectedWithError(
      /cancelled/,
    );
    expect(provider.create).not.toHaveBeenCalled();
    expect(main.pickers.size).toBe(0);
  });

  it("provides the public launcher service through the real hub with captured pane options", async () => {
    let service;
    leases.add(
      lumine.packages.serviceHub.consume("launcher", "^1.0.0", (value) => {
        service = value;
        return new Disposable(() => {
          if (service === value) service = null;
        });
      }),
    );
    expect(service).toBeDefined();
    const original = context().pane;
    const another = original.splitRight();
    another.activate();
    const first = await service.create({ pane: original });
    expect(main.pickers.get(first.window).context.pane).toBe(original);
    const second = await service.open({ pane: original, path: __filename });

    expect(first.isDestroyed()).toBe(true);
    expect(second.isDestroyed()).toBe(false);
    expect(main.pickers.get(second.window).context.pane).toBe(original);
    expect(main.pickers.get(second.window).context.path).toBe(__filename);
  });

  it("retires the public service and keeps its replacement usable after reactivation", async () => {
    let service;
    leases.add(
      lumine.packages.serviceHub.consume("launcher", "^1.0.0", (value) => {
        service = value;
        return new Disposable(() => {
          if (service === value) service = null;
        });
      }),
    );
    const retired = service;
    await lumine.packages.deactivatePackage("launcher");
    expect(service).toBeNull();
    await expectAsync(retired.create()).toBeRejectedWithError(/retired/);
    await expectAsync(retired.open({ path: __filename })).toBeRejectedWithError(/retired/);
    main = (await lumine.packages.activatePackage("launcher")).mainModule;

    expect(service).not.toBe(retired);
    const host = await service.create({ pane: context().pane });
    expect(host.isDestroyed()).toBe(false);
    expect(choiceIds(host)).toContain("text-editor");
  });

  it("updates the visible picker when provider edges arrive and disappear", async () => {
    const host = await main.create(event());
    const { lease } = registerProvider();
    await flushMicrotasks();

    expect(choiceIds(host)).toContain("spec-content");
    await host.getModel().selectItemById("spec-content");
    lease.dispose();
    await flushMicrotasks();

    expect(choiceIds(host)).not.toContain("spec-content");
    expect(host.getModel().getSelectedItem().id).toBe("text-editor");
    expect(host.isDestroyed()).toBe(false);
  });

  it("sorts content by provider order and then its displayed label", async () => {
    registerProvider({ id: "spec-z", label: "Zulu", order: 20 });
    registerProvider({ id: "spec-b", label: "Bravo", order: 10 });
    registerProvider({ id: "spec-a", label: "Alpha", order: 20 });
    const host = await main.create(event());
    const ids = choiceIds(host).filter((id) => id.startsWith("spec-"));

    expect(ids).toEqual(["spec-b", "spec-a", "spec-z"]);
  });

  it("rejects duplicate and malformed providers without disturbing the active catalogue", () => {
    const { provider } = registerProvider();
    const before = main.providers.choices();
    expect(() => main.consumeLauncher(provider)).toThrowError(/already registered/);
    for (const malformed of [
      null,
      {},
      { ...provider, id: " " },
      { ...provider, label: " " },
      { ...provider, create: undefined },
      { ...provider, order: Infinity },
    ]) {
      expect(() => main.consumeLauncher(malformed)).toThrowError(TypeError);
    }
    expect(main.providers.choices()).toEqual(before);
  });

  it("calls a provider with its own receiver and the captured context", async () => {
    const captured = context();
    const item = makeItem();
    const provider = {
      id: "receiver-content",
      label: "Receiver Content",
      item,
      create(options) {
        expect(options.pane).toBe(captured.pane);
        expect(options.window).toBe(captured.window);
        expect(options.signal.aborted).toBe(false);
        return this.item;
      },
    };
    leases.add(main.consumeLauncher(provider));

    expect(await main.createItem(captured, { id: provider.id })).toBe(item);
    expect(lumine.workspace.paneForItem(item)).toBe(captured.pane);
    expect(item.destroy).not.toHaveBeenCalled();
  });

  it("rejects a stale selected choice after its provider disappears", async () => {
    const { provider, lease } = registerProvider();
    lease.dispose();
    const open = spyOn(lumine.workspace, "open").and.callThrough();

    await expectAsync(main.createItem(context(), { id: provider.id })).toBeRejectedWithError(
      /no longer available/,
    );
    expect(provider.create).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("does not call the factory after request cancellation", async () => {
    const { provider } = registerProvider();
    const controller = new AbortController();
    controller.abort();

    await expectAsync(
      main.createItem(context(), { id: provider.id }, controller.signal),
    ).toBeRejectedWithError(/cancelled/);
    expect(provider.create).not.toHaveBeenCalled();
  });

  for (const retirement of ["cancellation", "provider disposal", "package deactivation"]) {
    it(`destroys a late unattached result after ${retirement}`, async () => {
      const { provider, lease, release, began } = delayedProvider();
      const item = makeItem();
      const controller = new AbortController();
      const open = spyOn(lumine.workspace, "open").and.callThrough();
      const pending = main.createItem(context(), { id: provider.id }, controller.signal).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const options = await began;
      if (retirement === "cancellation") controller.abort();
      else if (retirement === "provider disposal") lease.dispose();
      else await lumine.packages.deactivatePackage("launcher");

      expect(options.signal.aborted).toBe(true);
      release(item);
      expect((await pending).error?.name).toBe("AbortError");
      await flushMicrotasks();
      expect(open).not.toHaveBeenCalled();
      expect(item.destroy).toHaveBeenCalledTimes(1);
      expect(lumine.workspace.paneForItem(item)).toBeFalsy();
    });
  }

  for (const retirement of ["window closure", "pane closure"]) {
    it(`destroys a late result after target ${retirement}`, async () => {
      const captured = context();
      const { provider, release, began } = delayedProvider();
      const item = makeItem();
      const open = spyOn(lumine.workspace, "open").and.callThrough();
      const pending = main.createItem(captured, { id: provider.id });
      await began;
      if (retirement === "window closure") {
        spyOn(captured.window, "isDestroyed").and.returnValue(true);
      } else {
        spyOn(captured.window.getEditorContainer(), "getPanes").and.returnValue([]);
      }
      release(item);
      await pending;

      expect(open).not.toHaveBeenCalled();
      expect(item.destroy).toHaveBeenCalledTimes(1);
    });
  }

  it("cancels a running picker action immediately and destroys its later factory result", async () => {
    const { release, began } = delayedProvider();
    const item = makeItem();
    const create = spyOn(main, "createItem").and.callThrough();
    const host = await main.create(event());
    await host.getModel().selectItemById("spec-content");
    const action = host.getModel().runAction("launcher:create");
    const options = await began;

    host.cancel();
    expect((await action).status).toBe("aborted");
    expect(options.signal.aborted).toBe(true);
    release(item);
    await expectAsync(create.calls.mostRecent().returnValue).toBeRejectedWithError(/cancelled/);
    await flushMicrotasks();

    expect(item.destroy).toHaveBeenCalledTimes(1);
    expect(lumine.workspace.paneForItem(item)).toBeFalsy();
    expect(host.isDestroyed()).toBe(true);
  });

  it("settles the picker action when a provider disappears before its factory resolves", async () => {
    const { lease, release, began } = delayedProvider();
    const item = makeItem();
    const host = await main.create(event());
    await host.getModel().selectItemById("spec-content");
    const action = host.getModel().runAction("launcher:create");
    const options = await began;

    lease.dispose();
    const outcome = await Promise.race([action, timeoutPromise(1000).then(() => null)]);
    expect(outcome?.status).toBe("aborted");
    expect(options.signal.aborted).toBe(true);
    expect(item.destroy).not.toHaveBeenCalled();
    release(item);
    await flushMicrotasks();

    expect(item.destroy).toHaveBeenCalledTimes(1);
    expect(lumine.workspace.paneForItem(item)).toBeFalsy();
  });

  it("aborts the factory when the captured pane is destroyed and discards its late result", async () => {
    const original = context().pane;
    const target = original.splitRight();
    const captured = { ...context(), pane: target };
    const { provider, release, began } = delayedProvider();
    const item = makeItem();
    const open = spyOn(lumine.workspace, "open").and.callThrough();
    const pending = main.createItem(captured, { id: provider.id }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const options = await began;

    target.destroy();
    const outcome = await Promise.race([pending, timeoutPromise(1000).then(() => null)]);
    expect(outcome?.error?.name).toBe("AbortError");
    expect(options.signal.aborted).toBe(true);
    expect(item.destroy).not.toHaveBeenCalled();
    release(item);
    await flushMicrotasks();

    expect(open).not.toHaveBeenCalled();
    expect(item.destroy).toHaveBeenCalledTimes(1);
    expect(lumine.workspace.paneForItem(item)).toBeFalsy();
  });

  it("keeps the current provider when a lease from an old package generation is disposed", async () => {
    const previous = registerProvider();
    await lumine.packages.deactivatePackage("launcher");
    main = (await lumine.packages.activatePackage("launcher")).mainModule;
    const current = registerProvider();
    previous.lease.dispose();

    await main.createItem(context(), { id: current.provider.id });

    expect(current.provider.create).toHaveBeenCalledTimes(1);
    expect(previous.provider.create).not.toHaveBeenCalled();
    expect(main.providers.get(current.provider.id)).toBeDefined();
  });

  it("rejects an attached singleton without moving or destroying it", async () => {
    const item = makeItem();
    const original = context().pane;
    await lumine.workspace.open(item, { pane: original, location: "center" });
    const another = original.splitRight();
    const { provider } = registerProvider({ create: () => item });
    const captured = { ...context(), pane: another };
    const open = spyOn(lumine.workspace, "open").and.callThrough();

    await expectAsync(main.createItem(captured, { id: provider.id })).toBeRejectedWithError(
      /fresh, unattached/,
    );
    expect(lumine.workspace.paneForItem(item)).toBe(original);
    expect(item.destroy).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects destroyed content and content limited to docks", async () => {
    const destroyed = makeItem();
    destroyed.destroy();
    const dockOnly = makeItem({ locations: ["bottom"] });
    const first = registerProvider({ id: "dead-content", create: () => destroyed });
    const second = registerProvider({ id: "dock-content", create: () => dockOnly });
    const open = spyOn(lumine.workspace, "open").and.callThrough();

    await expectAsync(main.createItem(context(), { id: first.provider.id })).toBeRejectedWithError(
      /fresh, unattached/,
    );
    await expectAsync(main.createItem(context(), { id: second.provider.id })).toBeRejectedWithError(
      /cannot open in the editor area/,
    );
    expect(open).not.toHaveBeenCalled();
    expect(dockOnly.destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys new content when workspace opening fails and keeps New usable", async () => {
    const item = makeItem();
    registerProvider({ create: () => item });
    const host = await main.create(event());
    await host.getModel().selectItemById("spec-content");
    spyOn(lumine.workspace, "open").and.rejectWith(new Error("Cannot attach content"));

    await expectAsync(host.getModel().runAction("launcher:create")).toBeRejectedWithError(
      "Cannot attach content",
    );
    expect(item.destroy).toHaveBeenCalledTimes(1);
    expect(host.isDestroyed()).toBe(false);
    expect(host.getModel().getStatus().message).toBe("Cannot attach content");
  });

  it("switches between New and Open without keeping two pickers or losing the selected path", async () => {
    const target = { ...event(), detail: { path: __filename } };
    const first = await main.create(target);
    const second = await main.open(target);

    expect(first.isDestroyed()).toBe(true);
    expect(second.isDestroyed()).toBe(false);
    expect(main.pickers.size).toBe(1);
    expect(main.pickers.get(second.window).mode).toBe("open");
    expect(
      second
        .getModel()
        .getItems()
        .map(({ id }) => id),
    ).toContain("text-editor");
    const third = await main.create(target);
    expect(second.isDestroyed()).toBe(true);
    expect(third.isDestroyed()).toBe(false);
    expect(main.pickers.size).toBe(1);
    expect(main.pickers.get(third.window).mode).toBe("new");
  });

  it("toggles New off with a second invocation", async () => {
    const host = await main.create(event());
    await main.create(event());

    expect(host.isDestroyed()).toBe(true);
    expect(main.pickers.size).toBe(0);
  });

  it("dispatches the global command and the picker action exactly once", async () => {
    const create = spyOn(main, "create").and.callThrough();
    lumine.commands.dispatch(lumine.workspace.getElement(), "launcher:new");
    expect(create).toHaveBeenCalledTimes(1);
    const host = await create.calls.mostRecent().returnValue;
    await host.getModel().selectItemById("text-editor");
    const createItem = spyOn(main, "createItem").and.callThrough();
    const open = spyOn(lumine.workspace, "open").and.callThrough();
    const input = host.getModel().getQueryEditor().getElement();
    const [binding] = lumine.keymaps.findKeyBindings({ target: input, keystrokes: "enter" });
    expect(binding.command).toBe("core:confirm");
    let finish;
    const finished = new Promise((resolve) => (finish = resolve));
    leases.add(host.getModel().onDidFinishAction(finish));

    lumine.commands.dispatch(input, "core:confirm");
    expect((await finished).status).toBe("success");
    expect(createItem).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(host.isDestroyed()).toBe(true);
  });
});
