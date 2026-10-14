module.exports = {
  version: 1,
  dependencies: ["markdown-preview", "language-gfm"],
  viewport: { width: 1100, height: 620 },
  async prepare({ open }) {
    await open("README.md");
  },
  scenes: [
    {
      id: "file-openers",
      file: "demo.png",
      caption:
        "Choose a registered opener for a Markdown file, with the default editor identified.",
      async run({ command }) {
        command("open-with:toggle");
      },
      ready() {
        const picker = document.querySelector(".open-with");
        return (
          picker?.getBoundingClientRect().height > 0 &&
          picker.textContent.includes("Markdown Preview") &&
          picker.textContent.includes("Default")
        );
      },
    },
  ],
};
