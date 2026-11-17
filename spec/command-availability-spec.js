const { CompositeDisposable } = require("lumine");
describe("Launcher resource command availability", () => {
  let main, target, leases, snapshot;
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("launcher")).mainModule;
    target = document.createElement("div");
    target.className = "tree-view";
    lumine.workspace.getElement().appendChild(target);
    leases = new CompositeDisposable();
    snapshot = { count: 0 };
    leases.add(
      main.consumeTreeViewSelection({
        getSelectionSnapshot: () => snapshot,
        selectedPaths() {
          throw Error("query initialized tree");
        },
      }),
    );
  });
  afterEach(() => {
    leases.dispose();
    target.remove();
  });
  it("allows global Open independently but requires one selected resource in the tree", () => {
    const has = (id) => lumine.commands.canDispatch(target, "launcher:" + id);
    expect(has("open-resource")).toBe(false);
    expect(has("open")).toBe(true);
    snapshot = { count: 2 };
    expect(has("open-resource")).toBe(false);
    snapshot = { count: 1 };
    expect(has("open-resource")).toBe(true);
  });

  it("allows contextual Open in an empty pane and rejects an unsaved document", async () => {
    const pane = lumine.workspace.getCenter().getActivePane();
    const emptyView = pane.getElement().querySelector(".item-views");
    expect(lumine.commands.canDispatch(emptyView, "launcher:open-resource")).toBe(true);

    const editor = await lumine.workspace.open();
    expect(lumine.commands.canDispatch(editor.getElement(), "launcher:open-resource")).toBe(false);
    await pane.destroyItem(editor);
  });
});
