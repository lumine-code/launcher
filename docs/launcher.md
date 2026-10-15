# launcher

Opens the resource or new-content picker in a captured workspace context.

|             |                                        |
| ----------- | -------------------------------------- |
| Version     | `1.0.0`                                |
| Provided by | Launcher's `provideLauncher()` method. |
| Consumed by | Packages that request a picker.        |
| Owner       | Launcher.                              |

## Registration

```json
{
  "consumedServices": {
    "launcher": {
      "versions": { "^1.0.0": "consumeLauncher" }
    }
  }
}
```

## Contract

```ts
type Launcher = {
  open(options?: {
    pane?: Pane;
    path?: string;
    project?: { paths: string[]; devMode?: boolean; safeMode?: boolean };
    initialLine?: number;
    initialColumn?: number;
    uriFragment?: string;
  }): Promise<SelectListHost | undefined>;
  create(options?: { pane?: Pane }): Promise<SelectListHost | undefined>;
};
```

`pane` is an available center pane and determines its presentation window. Capture it before awaiting unrelated work. Without a pane, Launcher captures the current document pane. `open` accepts either `path` or `project`; without either, it shows a native file chooser before the opener list. Paths may be local paths or file URLs. Cursor positions are zero-based non-negative integers. A separate `uriFragment` overrides the fragment carried by a file URL.

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

Consumers return a Disposable that releases their reference when the service edge disappears. A retired service rejects further requests. Removing Launcher dismisses its pickers and cancels unfinished work. Consuming this service never activates Launcher.

## Versioning

The provider declares `1.0.0`; consumers declare `^1.0.0`. This preproduction API replaces command requests under the former package name without aliases.
