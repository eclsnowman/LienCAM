# Stranger test clean install

Run from the worktree in the foreground:

```powershell
node e2e/stranger-test.mjs
```

After a tooling interruption, rebuild a completed export without relabeling its
source SHA, or retry only Sandbox with a verified installer hash and the recorded
browser evidence:

```powershell
node e2e/stranger-test.mjs --resume <export-run-id>
node e2e/stranger-test.mjs --sandbox-only <export-run-id> <browser-run-id>
```

This exports current main, builds Pages with demo enabled and desktop with demo
disabled, and packages the exported desktop. The external export links to the
existing shared dependency install; it never installs or copies dependencies or
creates a worktree. Do not recursively delete an export's node_modules link.

Every run has a new runtime directory under the system temp directory at
`liencam-stranger/<export-run-id>` and a new evidence directory, so old captures
cannot satisfy a new run. Runtime exports, installer copies and drivers stay
outside the repository; screenshots, trace, video, timings and result are durable
evidence in the repository. Resume commands use that same external runtime;
they require it to remain present.
The driver archive carries the existing Playwright and ffmpeg binaries to the
disposable guest over HTTP. It does not carry another dependency install.
The guest also records a 1 fps video from Playwright page screenshots because
Electron's native screencast returned only a white startup frame in Sandbox.
Step JSON retains actual elapsed times; the trace retains every UI action.
FINDINGS.md points to the run and source SHA. No product fixes are applied.

The browser follows the actual site link. Before publication only that Pages
demo destination is redirected to its local exported equivalent, recorded in
findings. Failures retain screenshots and traces and return exit 1.

Sandbox starts only below 60 percent average CPU across five readings. The
generated WSB has exactly one read-only mapping containing only the installer.
Its logon command downloads the automation driver from a random-token host
endpoint. The guest runs the installer silently, launches the installed app on
a clean profile using the existing fresh-PC first-launch and simulation helpers,
and opens the same starter kit through Open project from installed asset bytes.
No host application is installed or launched. Guest evidence is uploaded to the
host; no writable evidence folder is mapped. The disposable guest shuts down
after the journey. Host endpoints close when the foreground command finishes.

If Sandbox fails to start, the feature is never enabled by this command. The
result records the failure and the completed browser evidence. Enabling the
feature or changing virtualization belongs to the operator.
