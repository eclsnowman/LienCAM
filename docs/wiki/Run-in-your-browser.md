# Run in your browser

You can try LienCAM without installing anything:

**https://eclsnowman.github.io/LienCAM/app/**

It is the same program as the desktop app, running in your browser tab. Nothing is uploaded: your files stay on your computer, and there is no account.

## What the demo leaves to the desktop app

UCCNC control needs the [Windows desktop app](Install-on-Windows). You can design, simulate and post G-code in the browser. Save a `.camproject` file with the save button; clearing browser data erases the tab's autosave, so keep the download.

You need a recent browser with WebGL2, and about 8 GB of RAM for big jobs.

## Hosting the static build yourself

The browser version is a folder of static files; any web server can host it. Build it once, then serve the folder:

```
npm ci
npm run build
```

The result is in `dist/`. Serve that folder with any static file server (for example `npx vite preview`, or copy it to a web host) and open the address in a browser.

See [Build from source](Build-from-source) for the full developer setup, and [Reporting a bug](Reporting-a-Bug) if something goes wrong.
