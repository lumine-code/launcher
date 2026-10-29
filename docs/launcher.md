# launcher

Opens the resource or new-content picker in a captured workspace context.

|             |                                        |
| ----------- | -------------------------------------- |
| Version     | `1.1.0`                                |
| Provided by | Launcher's `provideLauncher()` method. |
| Consumed by | Packages that request a picker.        |
| Owner       | Launcher.                              |

## Registration

```json
{
  "consumedServices": {
    "launcher": {
      "versions": { "^1.1.0": "consumeLauncher" }
    }
  }
}
```

## Contract

```ts
type LauncherOpenerOverride = {
  id: string;
  destinations: Array<"current" | "detached-window" | "this-window">;
  open(
    filePath: string,
    options: WorkspaceOpenOptions & {
      pane: Pane;
      signal?: AbortSignal;
      pending?: boolean;
    },
  ): Promise<PaneItem | undefined | null>;
};

type Launcher = {
  open(options?: {
    pane?: Pane;
    path?: string;
    project?: { paths: string[]; devMode?: boolean; safeMode?: boolean };
    initialLine?: number;
    initialColumn?: number;
    uriFragment?: string;
    openerOverrides?: LauncherOpenerOverride[];
  }): Promise<SelectListHost | undefined>;
  create(options?: { pane?: Pane }): Promise<SelectListHost | undefined>;
};
```

`pane` is an available center pane and determines its presentation window. Capture it before awaiting unrelated work. Without a pane, Launcher captures the current document pane. `open` accepts either `path` or `project`; without either, it shows a native file chooser before the opener list. Paths may be local paths or file URLs. Cursor positions are zero-based non-negative integers. A separate `uriFragment` overrides the fragment carried by a file URL.

## Request-scoped opener overrides

`openerOverrides` replaces how selected public openers open a file for this request. Each `id` matches an available public opener; its label and default selection remain unchanged. An override does not register a workspace opener or affect another Launcher request. Launcher snapshots the override list, destination lists, IDs and callback references before awaiting request preparation, so later mutations do not change the request.

Overrides require an explicit `path` identifying an existing file. Directory paths, `project` requests and requests that need a native chooser are rejected. Malformed entries, duplicate IDs, unsupported destination values and non-function `open` callbacks are rejected cleanly. Each override's actions are limited to the intersection of the public opener's supported destinations and its `destinations` list. Callbacks can use `current`, `detached-window` and `this-window`; `new-window` is unavailable because callbacks cannot cross into another editor process.

The callback receives the resolved file path and the standard workspace opening options for the chosen action, including its destination pane, cursor positions and URI fragment when supplied. `WorkspaceOpenOptions` denotes the ordinary `workspace.open()` options; `pending` and other presentation options depend on the selected action. The callback owns opening and presenting its item, and returns that item or `undefined` or `null` when nothing opened. Launcher does not open or attach the returned item a second time.

The selected action's `signal` cancels unfinished opening work. Callbacks must honor cancellation before committing an open, release unused resources and avoid publishing an item after their provider retires. The caller owns the callback's provider-edge lifecycle; consuming Launcher does not keep another provider alive.

## Minimal example

```js
consumeLauncher(service) {
  this.launcher = service;
  return new Disposable(() => {
    if (this.launcher === service) this.launcher = null;
  });
}

async openResource(filePath) {
  const pane = lumine.workspace.resolveCommandContext(
    lumine.workspace.getElement(),
  ).documentPane;
  return this.launcher?.open({ path: filePath, pane });
}
```

## Behavior

The promise resolves when the picker is shown, rather than when an item is opened. The returned host exposes the ordinary select-list lifecycle. Requesting the same picker again dismisses it; requesting the other picker replaces it. Opening preserves the captured path, pane, positions, and fragment while the user chooses an action.

Commands `launcher:open` and `launcher:new` expose the same operations to menus and keymaps. Their event detail accepts the corresponding options. The contextual wrapper `launcher:open-resource` captures the selected tree entry or saved center item and passes its explicit path to Open. Global Open always selects a resource when no explicit path or project is supplied, regardless of editor focus.

## Teardown

Consumers return a Disposable that releases their reference when the service edge disappears. A retired service rejects further requests. Removing Launcher dismisses its pickers and aborts pending requests and actions, including override callbacks through their action signals. Callers remain responsible for releasing callback references and handling their providers' retirement. Consuming this service never activates Launcher.

## Versioning

The provider declares `1.1.0`. Consumers using `openerOverrides` declare `^1.1.0`; existing consumers declaring `^1.0.0` remain compatible. This preproduction API replaces command requests under the former package name without aliases.
