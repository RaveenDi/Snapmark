# Snapmark

A tiny, fast screenshot annotator. Take a screenshot, it shows up in Snapmark by itself; draw an arrow, add a note, and either press **Ctrl+S** to save it as a new image or drag it straight into a chat, an email or a folder.

Works on Windows, macOS and Linux. Free and open source (MIT).

## What it does

- **Finds your screenshots for you.** On first start Snapmark looks up where your system saves screenshots (the Windows *Screenshots* folder including OneDrive, the macOS screenshot location, `~/Pictures/Screenshots` on Linux). It only asks you to pick a folder if it cannot find one. You can change the folder any time from the bottom of the sidebar.
- **Recent images on the left.** Everything in the screenshot folder, newest first, plus any image you opened from elsewhere. New screenshots appear live and open on the workbench automatically (unless you are in the middle of drawing).
- **Workbench in the middle.** Scroll to zoom at the cursor, drag empty space (or hold Space, or use the middle mouse button) to pan.
- **Arrows** — drag to draw. Double-click an arrow to type a label at its end.
- **Lines and shapes, point by point** — click, click, click; the line follows your cursor. Click the first point to close the shape, or finish an open line with Enter or a double-click. Later you can drag one end of an open line onto the other end to close it.
- **Rectangles, ellipses, freehand pen**, 8 colours, 4 sizes, optional fill.
- **Text** — double-click anywhere and type.
- **Ctrl+S / Cmd+S saves a new image** next to the original (`name-marked.png`, `name-marked-2.png`, …). The original is never overwritten.
- **Drag out without saving** — drag the *Drag out* chip (top right of the workbench) onto any app or folder. You can also drag any thumbnail from the sidebar.
- **Copy / paste** — Ctrl+C copies the marked-up image, Ctrl+V pastes an image from the clipboard as a new item.

## Shortcuts

| Action | Windows / Linux | macOS |
| --- | --- | --- |
| Save as a new image | Ctrl+S | Cmd+S |
| Save as… (choose name and place) | Ctrl+Shift+S | Cmd+Shift+S |
| Copy image / paste image | Ctrl+C / Ctrl+V | Cmd+C / Cmd+V |
| Undo / redo | Ctrl+Z / Ctrl+Y | Cmd+Z / Cmd+Shift+Z |
| Open an image | Ctrl+O | Cmd+O |
| Fit / actual size / zoom | Ctrl+0 / Ctrl+1 / Ctrl + and − | Cmd+0 / Cmd+1 / Cmd + and − |
| Tools | V select, A arrow, L line/shape, R rectangle, O ellipse, P pen, T text, F fill | same |
| Finish line / cancel / remove last point | Enter / Esc / Backspace | same |
| Delete selected drawing | Delete | Delete |
| Nudge selected drawing | Arrow keys (Shift = 10 px) | same |
| Straight lines, squares, circles | hold Shift | same |

## Install

**Windows (64-bit):** download `Snapmark.Setup.x.y.z.exe` from the [latest release](https://github.com/RaveenDi/Snapmark/releases/latest) and run it. It installs for the current user in one click and adds Start menu and desktop shortcuts.

The installer is not code-signed, so Windows SmartScreen may warn the first time you run it: choose *More info*, then *Run anyway*.

**macOS and Linux:** there is no download yet. Run from source, or build a `.dmg` / `.AppImage` yourself with the commands under *Build the installers* below. These platforms have not been tested yet.

## Run from source

Requires [Node.js](https://nodejs.org) 20 or newer.

```
npm install
npm start
```

## Build the installers

```
npm run dist:win     # Windows installer (.exe) into dist/
npm run dist:mac     # macOS .dmg (must be run on a Mac)
npm run dist:linux   # Linux AppImage
```

`npm run icon` redraws `build/icon.png`. `npm run smoke` starts the real app against a throwaway folder and checks drawing, saving, zoom and the sidebar end to end.

## How it is put together

No framework and no bundler, which is why it starts quickly.

```
src/main/main.js      window, files, saving, clipboard, drag-out, folder watching
src/main/detect.js    finds the system screenshot folder
src/main/preload.js   the small, safe bridge between page and system
src/renderer/editor.js   the canvas workbench: zoom, pan, every drawing tool, export
src/renderer/app.js      sidebar, toolbar, shortcuts
```

The page runs sandboxed with context isolation; it can only reach the system through the functions listed in `preload.js`.

## License

[MIT](LICENSE)
