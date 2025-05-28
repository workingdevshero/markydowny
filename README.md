<img src="marky.png" style="width:200px">

# Markydowny

A simple, beautiful static web app for rendering markdown files via drag and drop.

## Features

- 📤 **Drag & Drop**: Simply drag your markdown files into the drop zone
- 🖱️ **Click to Browse**: Alternative file selection via clicking
- 🎨 **Beautiful Rendering**: Clean, readable markdown output with syntax highlighting
- 📱 **Responsive Design**: Works great on desktop and mobile
- ↩️ **Easy Reset**: Go back to drop zone to load another file

## How to Use

1. Open `index.html` in your web browser
2. Either:
   - Drag and drop a `.md` or `.markdown` file into the drop zone
   - Click the "Choose File" button to browse for a file
3. Watch your markdown render beautifully!
4. Click the "← Back to Drop Zone" button to load another file

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
