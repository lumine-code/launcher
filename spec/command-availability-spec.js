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
  it("allows native Open independently but requires one saved resource for its alias", () => {
    const has = (id) => lumine.commands.canDispatch(target, "launcher:" + id);
    expect(has("open-resource")).toBe(false);
    expect(has("open")).toBe(true);
    snapshot = { count: 2 };
    expect(has("open-resource")).toBe(false);
    snapshot = { count: 1 };
    expect(has("open-resource")).toBe(true);
  });
});
