const path = require("node:path");
const { supports } = require("./opening");

const DESTINATIONS = {
  "launcher:open-current": {
    description: "Use the selected opener in the captured editor pane.",
    destination: "current",
  },
  "launcher:open-new-window": {
    description: "Open the target in a separate project window.",
    destination: "new-window",
  },
  "launcher:open-detached-window": {
    description: "Open the file in another window sharing this workspace.",
    destination: "detached-window",
  },
  "launcher:open-this-window": {
    description: "Switch this workspace to the target's project and open it.",
    destination: "this-window",
  },
};

function pickerOptions(launcher, context) {
  const directory = context.pathKind === "directory";
  const commands = {};
  const actions = [];
  for (const [command, { description, destination }] of Object.entries(DESTINATIONS)) {
    commands[command] = {
      description,
      didDispatch: (event) => {
        event.stopPropagation();
        return launcher.execute(context, event.detail.item, destination, event.detail.signal);
      },
    };
    actions.push({
      command,
      context: "item",
      primary: ({ item }) => destination === primaryDestination(item, directory),
      group: "Open",
      when: ({ item }) =>
        supports(item, destination) &&
        !(directory && destination === "current" && supports(item, "this-window")),
      disposition: "close",
    });
  }
  return {
    items: launcher.availableChoices(context),
    getItemId: (choice) => choice.id,
    placeholderText: context.project
      ? "Choose how to open this project"
      : `Choose an opener for ${path.basename(context.path)}`,
    search: { getFilterText: (choice) => choice.label },
    renderItem: (choice, { highlight }) => ({
      primary: highlight(choice.label),
      trailing: choice.isDefault ? [{ text: "Default", className: "badge badge-info" }] : [],
    }),
    commands,
    actions,
  };
}

function primaryDestination(choice, directory) {
  if (directory && supports(choice, "new-window")) return "new-window";
  if (directory && supports(choice, "this-window")) return "this-window";
  if (choice.openerOverride) {
    return ["current", "detached-window", "this-window"].find((destination) =>
      supports(choice, destination),
    );
  }
  return "current";
}

module.exports = { pickerOptions };
