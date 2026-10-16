const path = require("node:path");
const { CompositeDisposable } = require("lumine");

describe("Launcher operation boundaries", () => {
  let main, pack, leases;
  const loaded = (name) =>
    Object.values(require.cache).some(
      (entry) => entry?.filename === path.join(pack.path, "lib", name + ".js"),
    );

  beforeEach(async () => {
    if (lumine.packages.isPackageLoaded("launcher"))
      await lumine.packages.unloadPackage("launcher");
    pack = await lumine.packages.activatePackage("launcher");
    main = pack.mainModule;
    leases = new CompositeDisposable();
  });

  afterEach(async () => {
    leases.dispose();
    await lumine.packages.unloadPackage("launcher");
  });

  it("registers commands and exchanges providers without loading opening or creation code", () => {
    const create = jasmine.createSpy("create");
    leases.add(main.consumeLauncher({ id: "cold-provider", label: "Cold Provider", create }));
    const service = main.provideLauncher();
    expect(typeof service.open).toBe("function");
    expect(typeof service.create).toBe("function");
    expect(main.providers.choices()).toContain({ id: "cold-provider", label: "Cold Provider" });
    for (const command of ["launcher:open", "launcher:new"])
      expect(lumine.commands.canDispatch(lumine.workspace.getElement(), command)).toBe(true);
    expect(create).not.toHaveBeenCalled();
    for (const name of ["opening", "path-context", "path-opening", "creation"])
      expect(loaded(name)).withContext(name).toBe(false);
  });

  it("loads path discovery on the first actual query without loading opening or creation effects", () => {
    expect(loaded("path-context")).toBe(false);
    const choices = main.availableChoices({ path: __filename, pathKind: "file" });
    expect(choices.some(({ id }) => id === "text-editor")).toBe(true);
    expect(loaded("path-context")).toBe(true);
    expect(loaded("opening")).toBe(true);
    expect(loaded("path-opening")).toBe(false);
    expect(loaded("creation")).toBe(false);
  });
});
