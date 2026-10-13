# open-with

Choose how and where to open files and folders.

Extracted from [tree-view](https://github.com/lumine-code/tree-view).

## Features

- **File actions**: choose an available file opener, with the default first and the text editor always available.
- **Window destinations**: open a document in the current window, a new project window, or a detached editor window.
- **Folder actions**: open a folder as a project in the current window or a new window.
- **System actions**: open a path externally or reveal it in the system file manager.
- **Direct commands**: use the default opener without showing the picker.

## Installation

To install `open-with` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/open-with`.

## Commands

Commands available in `lumine-workspace`:

- `open-with:toggle`: show or hide the action picker for the selected tree entry or active file,
- `open-with:open`: open the selected path using its default opener,
- `open-with:new-window`: open the selected path with its default opener in a new project window,
- `open-with:detached-window`: open the selected file with its default opener in a detached editor window,
- `open-with:this-window`: open the selected path with its default opener as the current window's project.

Commands available in `.open-with .select-list`:

- `open-with:open`: run the selected opener or system action in the current window,
- `open-with:new-window`: use the selected opener in a new project window,
- `open-with:detached-window`: use the selected opener in a detached editor window,
- `open-with:this-window`: use the selected opener as the current window's project.

## Usage

Choose Open With from a file or folder's tree context menu, or use the package menu for the active file. The picker marks the action that ordinary opening would use as Default. Window destinations are available only for actions that open editor content; external opening and showing a path in the file manager have no editor-window destination. Folders can open as projects in the current window or a new window. For files, Open uses the current project's active editor pane, while This Window replaces the project with the file's containing directory.

## Services

- `tree-view.selection`: consumed to read the selected paths and identify entries in the tree.
- `background-tips.provider`: provided to background-tips to explain the action picker.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
