# Contributing to LienCAM

## Welcome

LienCAM is a hobby project. Thank you for taking the time to help. What helps most:

- Bug reports that can be reproduced, with the project file attached.
- Small fixes.
- Corrections to the documentation.
- Test files that pin down behaviour.

## What the owners decide

The owners decide design, screens, defaults, which controllers are supported and anything that changes how a
machine behaves. If you want to make a large change, please open a discussion in Discussions > Ideas first, so
that you do not spend a weekend on something we would have to say no to.

## How the project works

Development happens in a private repository. This public repository is published release by release. A pull
request here is a proposal and a patch: if we accept it, we bring it into the private repository, credit you in the
release notes and the commit, and close the pull request with a link. The Merge button is not used.

## Good first things

Look for issues labelled `good-first-issue` and `help-wanted`.

## Building and running the tests

You need Node.js and npm.

```
npm install
npm run dev
npm run lint
npm run build
npm run test:public
```

`npm run dev` starts the app in your browser. `npm run test:public` runs the regression tests that ship in this
repository. For a small change, run only the test files for the part you touched.

## Pull request rules

- One concern per pull request.
- Link the issue or the Ideas discussion.
- Include a test, or say why one is not possible.
- No unrelated reformatting.
- A change to machine motion needs a described test on the simulator. It gets extra scrutiny and may be rewritten.

The pull request template (`.github/pull_request_template.md`) walks through these.

## Sign-off and licence

Contributions are accepted under the Apache License 2.0 (see `LICENSE`). There is no CLA and no right to relicense
your work. Instead we use the Developer Certificate of Origin 1.1 (https://developercertificate.org/): by adding a
`Signed-off-by:` line to each commit you certify that you wrote the change, or otherwise have the right to submit
it, under the project's licence. Git does this for you:

```
git commit -s -m "Fix the thing"
```

One folder is the exception. Changes to files under `src/lib/cam/adaptiveClearing2d/engine/` stay under
LGPL-2.1-or-later, because that folder is a marked LGPL module. See `NOTICE` for the full list of folder licences.

## Machine safety

LienCAM comes with no warranty (see `LICENSE`). It can drive a real machine. Changes that touch G-code output,
posts, the controller link or E-STOP are reviewed as safety work and may take longer.

## Conduct

Please be kind. This project follows the Contributor Covenant (`CODE_OF_CONDUCT.md`). Reports go through this
repository's private reporting page, the Security tab > Report a vulnerability, which only the maintainers can read.

## What to expect

Replies are best effort. There is no schedule. A pull request may sit for weeks, and "no" is a normal answer.

## AI-assisted contributions

Using an AI tool is fine if you understand the change and have tested it yourself. Low-effort bulk submissions are
closed.
