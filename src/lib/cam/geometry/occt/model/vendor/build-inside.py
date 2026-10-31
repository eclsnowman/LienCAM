#!/usr/bin/python3
# Runs INSIDE donalffons/opencascade.js:2.0.0-beta.b5ff984 (see build.sh). WO-3047.
#
# The image ships OCCT 7.6.2 and its bindings precompiled as LTO bitcode with -Os
# and emscripten's JS exception emulation (-fexceptions). With that emulation every
# C++ call that can throw leaves wasm for a JS invoke_* trampoline and comes back; a
# CPU profile of a STEP read spent ~44% of its time in those crossings. This script
# recompiles the same OCCT sources and the bound classes with native wasm exceptions
# (-fwasm-exceptions) and -O3, then links with the image's own buildFromYaml.py.
# Same OCCT commit, same source files, same bindings: only compiler flags change.
#
# The image builds OCCT without OCC_CONVERT_SIGNALS, so OCCT never calls setjmp and
# native wasm exceptions need no SUPPORT_LONGJMP.
#
# /cache keeps the compiled objects between runs: existing .o files are skipped, so
# an interrupted build resumes and a second build only relinks.
import os, shutil, subprocess, sys
from multiprocessing import Pool

import yaml

sys.path.insert(0, "/opencascade.js/src")
from Common import ocIncludePaths, additionalIncludePaths  # noqa: E402

FLAGS = ["-flto", "-fwasm-exceptions", "-DIGNORE_NO_ATOMICS=1", "-DOCCT_NO_PLUGINS",
         "-frtti", "-DHAVE_RAPIDJSON", "-O3"]
OCCT = "/occt/src/"
IMG_SOURCES = "/opencascade.js/build/sources/"
IMG_BINDINGS = "/opencascade.js/build/bindings/"
CACHE = "/cache/"

# The same include list compileSources.py uses.
SRC_INC = ["-I/rapidjson/include", "-I/freetype/include/freetype", "-I/freetype/include"] + \
  ["-I" + d for d, _, _ in os.walk(OCCT)]
BIND_INC = ["-I" + p for p in ocIncludePaths + additionalIncludePaths]


def compile_one(job):
  src, out, inc = job
  if os.path.exists(out):
    return
  os.makedirs(os.path.dirname(out), exist_ok=True)
  subprocess.check_call(["emcc", *FLAGS, *inc, "-c", src, "-o", out + ".tmp"])
  os.rename(out + ".tmp", out)


def main():
  # 1. The image's scripts compile the generated myMain.h bindings and any
  #    additionalBindCode at link time: give them the same flags.
  for f in ["compileSources.py", "compileBindings.py", "buildFromYaml.py"]:
    p = "/opencascade.js/src/" + f
    s = open(p).read()
    s = s.replace('"-fexceptions",', '"-fwasm-exceptions",')
    s = s.replace('"-sDISABLE_EXCEPTION_CATCHING=0",', "")
    s = s.replace('"-Os",', '"-O3",')
    open(p, "w").write(s)

  # 2. OCCT sources: exactly the set the image compiled (one .o per source file).
  jobs = []
  for d, _, files in os.walk(IMG_SOURCES):
    for f in files:
      if f.endswith(".o"):
        rel = os.path.relpath(os.path.join(d, f), IMG_SOURCES)[:-2]
        jobs.append((OCCT + rel, CACHE + "sources/" + rel + ".o", SRC_INC))
  # 3. The bound classes named in the yml.
  cfg = yaml.safe_load(open("/src/occt-model.yml"))
  want = {b["symbol"] for b in cfg["mainBuild"]["bindings"]}
  found = {}
  for d, _, files in os.walk(IMG_BINDINGS):
    for f in files:
      if f.endswith(".cpp") and f[:-4] in want:
        found[f[:-4]] = os.path.join(d, f)
  missing = want - set(found)
  if missing:
    raise SystemExit("missing bindings: %s" % sorted(missing))
  for sym, cpp in found.items():
    jobs.append((cpp, CACHE + "bindings/" + sym + ".cpp.o", BIND_INC))
  jobs.sort()
  print("compiling %d objects (%d sources, %d bindings)" % (len(jobs), len(jobs) - len(found), len(found)), flush=True)
  with Pool(os.cpu_count()) as pool:
    for i, _ in enumerate(pool.imap_unordered(compile_one, jobs, chunksize=4)):
      if i % 250 == 0:
        print("  %d / %d" % (i, len(jobs)), flush=True)

  # 4. Put the recompiled objects where buildFromYaml.py links them from.
  for src, out, _ in jobs:
    if src.startswith(OCCT):
      shutil.copyfile(out, IMG_SOURCES + os.path.relpath(src, OCCT) + ".o")
    else:
      shutil.copyfile(out, src + ".o")

  # 5. Link (and regenerate the d.ts) with the image's own script.
  os.chdir("/src")
  subprocess.check_call(["python3", "/opencascade.js/src/buildFromYaml.py", "occt-model.yml"])


if __name__ == "__main__":
  main()
