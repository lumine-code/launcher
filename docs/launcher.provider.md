# launcher.provider

Contributes a factory for a new item in the workspace center.

|             |                                                                     |
| ----------- | ------------------------------------------------------------------- |
| Version     | `1.0.0`                                                             |
| Provided by | A package's `provideLauncher()` method, or core on the service hub. |
| Consumed by | Launcher.                                                           |
| Owner       | Launcher.                                                           |

## Registration

```json
{
  "providedServices": {
    "launcher.provider": {
      "versions": { "1.0.0": "provideLauncher" }
    }
  }
}
```

Providers publish descriptors during synchronous bootstrap. Expensive construction belongs behind `create`, not inside the service method.

## Contract

Required descriptor fields:

| Field             | Type                              | Meaning                                                       |
| ----------------- | --------------------------------- | ------------------------------------------------------------- |
| `id`              | `string`                          | Unique, non-empty content type ID, normally the package name. |
| `label`           | `string`                          | Non-empty name shown in New.                                  |
| `create(context)` | `PaneItem` or `Promise<PaneItem>` | Return a fresh, live, unattached item allowed in center.      |

Optional descriptor fields:

| Field   | Type            | Meaning                                 |
| ------- | --------------- | --------------------------------------- |
| `order` | finite `number` | Ordering before label; defaults to 100. |

The creation context contains `pane`, `window`, and an `AbortSignal` named `signal`. The pane and presentation window are captured before asynchronous work. They are the destination, even if focus changes while the factory runs. A provider may read the pane's current item to obtain context such as a working directory; it must not open the result, split panes, change focus, or mutate workspace layout.

The item implements the ordinary pane-item protocol and allows `center`. It owns its document, process, save behavior, serialization, and resources. Creating a second item must not return an already open singleton. The registry stores content types rather than live workspace items. Opening existing resources continues to use the workspace's named path openers; creating content does not imply support for any file extension.

## Minimal example

```js
module.exports = {
  provideLauncher() {
    return {
      id: "example-view",
      label: "Example Document",
      create: async ({ signal }) => {
        signal.throwIfAborted();
        const { createDocumentEditor } = await this.ensureRuntime();
        signal.throwIfAborted();
        return createDocumentEditor();
      },
    };
  },
};
```

## Behavior

Duplicate IDs and invalid descriptors are rejected. New lists registered types by order and label, and refreshes as provider edges arrive or disappear. Registering or listing a type never invokes its factory. A failed factory leaves the picker available and reports the action error.

Launcher validates the returned item and opens it with `location: "center"`, the captured `pane`, and `pending: false`. It disposes an unattached result if opening is cancelled, refused, or fails. Existing attached items returned in violation of the contract remain owned by their current pane.

## Teardown

The consumer returns a Disposable for each provider edge. Removing the edge removes that type and aborts its unfinished creations. Closing the picker, closing the destination, or deactivating Launcher also cancels relevant work. Providers honor cancellation and release partially constructed resources. If an asynchronous factory nevertheless returns late, Launcher destroys its unattached result.

## Versioning

Providers declare `1.0.0`; consumers declare `^1.0.0`. This is a new preproduction contract with no compatibility aliases.
