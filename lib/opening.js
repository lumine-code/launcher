function abortIfNeeded(signal) {
  if (signal?.aborted) {
    const error = new Error("Opening was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function supports(choice, destination) {
  if (destination === "this-window") {
    return (
      choice.destinations.includes("current") &&
      choice.destinations.some((value) => value !== "current")
    );
  }
  return choice.destinations.includes(destination);
}

module.exports = { abortIfNeeded, supports };
