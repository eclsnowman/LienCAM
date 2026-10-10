# FAQ

## Is LienCAM free?

Yes. It is free and open source, runs on your own computer, and needs no account or cloud.

## Is it finished?

No. It is in alpha: it works, and it has rough edges. See [Known limitations](Known-Limitations) for what is not proven.

## Which machines does it run?

It posts G-code for UCCNC, GRBL, grblHAL, LinuxCNC and Generic ([Post-Processors](Post-Processors)). Direct control is alpha on [UCCNC](Controllers-UCCNC-UC100-AXBB-E), proven on one machine; [GRBL / grblHAL](Controllers-GRBL-and-grblHAL) and [LinuxCNC](Controllers-LinuxCNC) are experimental, simulator-only.

## Do I need a machine to try it?

No. You can draw, model, make toolpaths, simulate the cut and post G-code without one. The Control tab also has a built-in simulator. You can even [run it in your browser](Run-in-your-browser).

## My machine is not on the example list.

Start from the generic starter or the closest example and edit it ([Set up your machine](Set-Up-Your-Machine)). Set the Controller to the dialect your controller reads. If none matches, choose Generic and adjust the post in the Post Process dialog.

## Can I use my Fusion tool library?

Yes: import its `.tools` file in the Tool Library. It arrives as a new library and your existing libraries are untouched. See [Tool library](Tool-Library).

## Does it run on Linux or macOS?

Builds exist but nobody has run them yet, and they are unsigned. See [Install on Linux](Install-on-Linux) and [Install on macOS](Install-on-macOS). The browser version works wherever the browser does.

## Do old project files keep working?

Not promised before 1.0. Expect to re-save projects from one alpha to the next.

## Is the G-code safe to run?

Read it before you run it, run it in the air first, and keep a hand near the E-STOP. LienCAM is provided with no warranty.

## Where do I ask for help?

In [GitHub Discussions](https://github.com/eclsnowman/LienCAM/discussions). LienCAM is a hobby project; there is no company or paid support behind it. For something broken, see [Reporting a bug](Reporting-a-Bug). Common problems are in [Troubleshooting](Troubleshooting).
