const DESTINATIONS = ["current", "detached-window", "this-window"];

function snapshotOpenerOverrides(value, detail) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error("Opener overrides must be an array.");
  if (detail.project !== undefined || typeof detail.path !== "string" || !detail.path) {
    throw new Error("Opener overrides require an explicit file path.");
  }
  const ids = new Set();
  return Object.freeze(
    Array.from(value, (entry) => {
      if (!entry || typeof entry !== "object") {
        throw new Error("An opener override must have an ID, destinations and an open callback.");
      }
      const { id, destinations, open } = entry;
      const capturedDestinations = Array.isArray(destinations) ? [...destinations] : [];
      if (typeof id !== "string" || !id.trim() || ids.has(id)) {
        throw new Error("Opener override IDs must be nonempty and unique.");
      }
      if (
        !Array.isArray(destinations) ||
        capturedDestinations.length === 0 ||
        new Set(capturedDestinations).size !== capturedDestinations.length ||
        capturedDestinations.some((destination) => !DESTINATIONS.includes(destination))
      ) {
        throw new Error("Opener overrides must declare supported, unique window destinations.");
      }
      if (typeof open !== "function") {
        throw new Error("An opener override must provide an open callback.");
      }
      ids.add(id);
      return Object.freeze({ id, destinations: Object.freeze(capturedDestinations), open });
    }),
  );
}

module.exports = { snapshotOpenerOverrides };
