# Tool library

The Tool Library window holds every cutter in named libraries, with search, filters and a tabbed editor with a live tool diagram. Open it with **Tool Library** at the left of the top toolbar. For the editor tabs, holders and probes, see the tool library section of [Toolpaths 2.5D](Toolpaths-2.5D).

## Tool reach

Every toolpath is kept to what the tool can reach: the neck, shank and holder stay clear of the part, the stock and any workholding. An operation that could not reach full depth says "Stopped short", with an amber arrow on its row in the design tree and a Reach row marked "Stopped short" in the Summary group of its Properties panel. A tool with a longer reach cuts the rest.

## Importing tools, including Fusion tool libraries

1. Press Import below the tool list.
2. Pick a `.tools` file (the zipped tool library that Fusion and other CAM programs export) or a `.json` export from LienCAM.
3. The file arrives as a **new** library named after the file, and the list jumps to it. Imports never mix into your existing libraries.
4. Holders embedded in the file are imported too, and each tool keeps its link to its holder.

Unreadable records are skipped and named in the console; the rest still imports. A file with no readable tools leaves no empty library.

## Exporting tools

- The Export button in the footer saves the selected tool as a single `.tool.json` file, with its holder embedded.
- The export button below the list saves every tool (All) or just the selected library (Lib) as one `.json` file.

All of these can be imported again.

## Tool numbers

Set tool numbers on the Post tab. Blank numbers receive the lowest free number. For two tools with the same number, use **Post Process > Properties > Tool numbers** to assign a per-program number; the library stays unchanged. See [Post Process](Post-Process#post-safety). Manual tool changers stop for you to change tools.

If something goes wrong, see [Reporting a bug](Reporting-a-Bug).
