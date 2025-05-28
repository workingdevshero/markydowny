<img src="marky.png" style="width:200px">

# Markydowny

A simple, beautiful static web app for rendering markdown files via drag and drop.

## Features

- 📤 **Drag & Drop**: Simply drag your markdown files or folders into the drop zone
- 📁 **Folder Support**: Drop entire folders containing markdown files
- 📄 **Multiple File Selection**: When multiple markdown files are found, choose which one to view
- 🖱️ **Click to Browse**: Alternative file selection via clicking
- 🎨 **Beautiful Rendering**: Clean, readable markdown output with syntax highlighting
- 🖼️ **Image Support**: Relative image paths in markdown are automatically resolved from folders
- ⛶ **Fullscreen Mode**: Expand content for distraction-free reading
- 📱 **Responsive Design**: Works great on desktop and mobile
- ↩️ **Easy Reset**: Go back to drop zone to load another file

## How to Use

1. Open `index.html` in your web browser
2. Either:
   - Drag and drop a `.md` or `.markdown` file into the drop zone
   - Drag and drop a folder containing markdown files
   - Click the "Choose File" button to browse for a file
3. If you dropped a folder with multiple markdown files, select which one you want to view from the list
4. Watch your markdown render beautifully!
5. Use the fullscreen button (⛶) for distraction-free reading
6. Click the "← Back to Drop Zone" button to load another file

## Supported File Types

- `.md` (Markdown)
- `.markdown` (Markdown)
- `.txt` (Plain text)
- Any other text file

## Technical Details

- Pure HTML, CSS, and JavaScript - no build process needed
- Uses [marked.js](https://marked.js.org/) from CDN for markdown parsing
- Fully static - works offline after initial load
- Mobile-responsive design

## Running the App

Simply open `index.html` in any modern web browser. No server or installation required!

For development, you can also serve it with a simple HTTP server:

```bash
# Python 3
python -m http.server 8000

# Python 2
python -m SimpleHTTPServer 8000

# Node.js (if you have npx)
npx serve .

# Or any other static file server
```

Then open `http://localhost:8000` in your browser. 
