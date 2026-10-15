module.exports = {
  version: 1,
  dependencies: ["markdown-preview", "language-gfm", "jupyter-view", "terminal", "graviss"],
  viewport: { width: 1100, height: 620 },
  async prepare({ open }) {
    await open("README.md");
  },
  scenes: [
    {
      id: "file-openers",
      file: "demo.png",
      caption: "Choose how to open a Markdown file, with the default editor identified.",
      async run({ lumine }) {
        const pane = lumine.workspace.getCenter().getActivePane();
        await lumine.packages.getActivePackage("launcher").mainModule.openResource({
          target: pane.getActiveItem().getElement(),
        });
      },
      ready() {
        const picker = document.querySelector(".launcher");
        return (
          picker?.getBoundingClientRect().height > 0 &&
          picker.textContent.includes("Markdown Preview") &&
          picker.textContent.includes("Default")
        );
      },
    },
    {
      id: "new-content",
      file: "demo-new.png",
      caption: "Create text, notebook, terminal, or Graviss content in the editor area.",
      async run({ command }) {
        command("launcher:new");
      },
      ready() {
        const picker = document.querySelector(".launcher-new");
        return (
          picker?.getBoundingClientRect().height > 0 &&
          ["Text Editor", "Jupyter Notebook", "Terminal", "Graviss"].every((label) =>
            picker.textContent.includes(label),
          )
        );
      },
    },
  ],
};
