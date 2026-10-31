# Release scene masters

These files are regenerated from one release browser build, through production
controls, with no development-store writes and no copied test-evidence images.
The build receipt pins the source commit and the bytes served to Chromium.

```powershell
$env:VITE_DEMO_BUILD='true'
npm run build:media
Remove-Item Env:VITE_DEMO_BUILD
node tools/capture/scenes.mjs dist
```

The argument is the built renderer directory, not a URL or a source revision.
Each capture replaces `S02.png` through `S16.png` and `SP.png` in place.
Every PNG has a same-name JSON sidecar in the shared capture harness's
`schemaVersion: 1, shots` format, including build commit, bundle fingerprint,
scene ID, dimensions, source fingerprint, byte count, and screenshot SHA-256.
Changed source or build files invalidate the build receipt.

The action/state log and contact sheet are written under
`src/tests/evidence/WO-2391/`. For diagnostics, `--only S02,S03` selects scenes;
`--evidence <directory>` separates consecutive run logs. A failed route removes
its old master before running, records a scene-named failure, and exits nonzero.

The shipped soft-jaw Model demonstrates fillets and a bore in S03; the knob's
3D finish operations appear in S10. S09 imports a fresh raster of the approved
LIEN mark onto a jaw face. SP combines a newly captured knob render with the
approved wordmark; it is a rendered application part, not a photograph of a cut
part.
