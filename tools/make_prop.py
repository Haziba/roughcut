#!/usr/bin/env python3
"""Make a light 3D prop from a sentence, using AssetFurnace (~/image-to-3dlab) on this machine.

    <assetfurnace>/.venv/bin/python tools/make_prop.py --out props/<id> --prompt "a grey armchair"

Three steps, each one of AssetFurnace's own tools, so its tested recipes and licence records
apply unchanged:

1. picture: Qwen-Image 2.1 through stable-diffusion.cpp (AssetFurnace's viewer/image_api.py)
2. 3D:      Pixal3D (scripts/pixal3d_generate.py)
3. finish:  retopologise to a few thousand faces and shrink the textures
            (scripts/retopo_repaint.py, no repaint and no detail bake, to stay light)

Hunyuan3D is deliberately never used: its licence excludes the UK.

Progress goes to <out>/status.json for the dev server to read; logs to <out>/log.txt.
The final file is <out>/prop.glb, next to the source picture and AssetFurnace's provenance.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

AF = Path(os.environ.get("ASSETFURNACE", Path.home() / "image-to-3dlab")).resolve()
PY = AF / ".venv" / "bin" / "python"

# Pixal3D builds the model in the frame of a level camera looking straight at the front, so the
# picture must be taken that way: any camera tilt or turn comes out as a tilted, turned model.
STYLE = (
    "{prompt}. Just this one object, standing upright, the whole of it in frame and centred, "
    "photographed straight on from the front at its own mid-height with a level camera, no tilt, "
    "plain pure white background, soft even studio lighting, product photograph, no other objects, "
    "no text."
)
# The AssetFurnace release this script was written against: it uses that release's internal
# image_api module and script flags, so a newer one may need changes here. A different version
# only logs a warning; the job still runs.
TESTED_AF = "v0.4.1"
FACES = 4000
TEXTURE = 512


def write_status(out: Path, **fields) -> None:
    path = out / "status.json"
    status = json.loads(path.read_text()) if path.exists() else {}
    status.update(fields, updated=time.time())
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(status))
    tmp.replace(path)


def run(cmd: list[str], log, cwd: Path = AF) -> None:
    log.write(f"\n$ {' '.join(map(str, cmd))}\n")
    log.flush()
    code = subprocess.run([str(c) for c in cmd], cwd=cwd, stdout=log, stderr=subprocess.STDOUT).returncode
    if code:
        tool = cmd[1] if str(cmd[0]) == str(PY) else cmd[0]
        raise RuntimeError(f"{Path(str(tool)).name} failed (exit {code}); see log.txt")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)

    # props/.paused-until holds a Unix time; jobs wait for it before starting (delete it to resume now).
    pause = out.parent / ".paused-until"
    while pause.exists():
        try:
            until = float(pause.read_text())
        except ValueError:
            break
        if until <= time.time():
            break
        time.sleep(30)

    sys.path[:0] = [str(AF), str(AF / "viewer")]
    with open(out / "log.txt", "a") as log:
        version = subprocess.run(["git", "-C", AF, "describe", "--tags"], capture_output=True, text=True).stdout.strip()
        if version != TESTED_AF:
            log.write(f"WARNING: tested with AssetFurnace {TESTED_AF}, found {version or 'unknown version'}\n")
        try:
            import image_api  # AssetFurnace's text-to-image module

            write_status(out, stage="image")
            settings = image_api.clean_settings({"seed": args.seed})
            source = out / "source.png"
            run(image_api.build_command(STYLE.format(prompt=args.prompt.strip().lstrip("-").strip().rstrip(".")), settings,
                                        source, image_api.resolve_weights()), log)

            write_status(out, stage="model")
            raw = out / "raw.glb"
            run([PY, AF / "scripts" / "pixal3d_generate.py", source, raw, "--seed", args.seed], log)

            write_status(out, stage="finish")
            run([PY, AF / "scripts" / "retopo_repaint.py", raw, source, out / "prop.glb",
                 "--faces", FACES, "--skip-paint", "--skip-bake", "--texture-size", TEXTURE,
                 "--atlas", 1024, "--steps-dir", out / "steps"], log)

            # The in-between files are ~180 MB a prop; keep the picture, the result and the records.
            for name in ("raw.glb", "raw.ply", "raw_base.png", "source__matted.png"):
                (out / name).unlink(missing_ok=True)
            shutil.rmtree(out / "steps", ignore_errors=True)
            shutil.rmtree(out / "raw.svviews", ignore_errors=True)

            write_status(out, stage="done")
            return 0
        except Exception as e:  # noqa: BLE001 - any failure ends the job; the log has detail
            log.write(f"\nERROR: {e}\n")
            write_status(out, stage="error", error=str(e) or type(e).__name__)
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
