# Build from source

You only need this if you want to change LienCAM or build your own copy. To just use it, see [Install on Windows](Install-on-Windows) or [Run in your browser](Run-in-your-browser).

## What you need

- Git and Node.js (the current LTS release).
- About 8 GB of RAM; the build asks Node for up to 8 GB.

## Get it running

```
git clone https://github.com/eclsnowman/LienCAM.git
cd LienCAM
npm ci
npm run dev
```

`npm ci` installs exactly the versions in the lock file. `npm run dev` starts the dev server; open the address it prints.

## Tests and build

```
npm test
npm run build
```

`npm test` runs the whole suite and takes a while; while working on one thing, run just its files with `npx vitest run <path>`. `npm run build` type-checks and writes the browser version to `dist/`.

## Desktop app and installers

```
npm run desktop
npm run package:win
npm run package:linux
npm run package:mac
```

`desktop` builds and opens the desktop app. The three `package` commands build the Windows installer and portable file, the Linux AppImage and tar.gz, and the macOS dmg and zip; run each on its own platform. The files appear in `release/`. The installers are unsigned.

## Contributing

Read the contributor pages in the sidebar, starting with [Architecture overview](Architecture-Overview) and [Testing](Testing). If something goes wrong, see [Reporting a bug](Reporting-a-Bug).
