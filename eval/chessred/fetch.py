"""Fetch a few games of the ChessReD dataset for evaluation.

ChessReD (Masouris and van Gemert, 2023) has phone photos taken after every
move of real games, with the position in each photo. Its 2K subset also
has the board corners. The archive is 4.7 GB, so instead of downloading
it we read its directory over HTTP range requests and pull out only the
photos of the games we want, shrinking each to 1024 px with ffmpeg.

    python3 eval/chessred/fetch.py --list
    python3 eval/chessred/fetch.py --games 8

Data license: CC BY-NC-SA 4.0. The files stay in footage/chessred/, which
git ignores.
"""

import argparse
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

RECORD = "https://data.4tu.nl/file/99b5c721-280b-450b-b058-b2900b69a90f/"
ANNOTATIONS = RECORD + "3cae6364-daca-4967-b426-1e4b68cdb64c"
ARCHIVE_2K = RECORD + "410e41c7-dde5-413f-8722-3e112363a1a2"
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "footage", "chessred")


class RemoteFile(io.RawIOBase):
    """A read-only, seekable file backed by HTTP range requests."""

    def __init__(self, url):
        self.url = url
        self.pos = 0
        req = urllib.request.Request(url, headers={"Range": "bytes=0-0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            self.size = int(r.headers["Content-Range"].split("/")[1])
        self.requests = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=io.SEEK_SET):
        if whence == io.SEEK_SET:
            self.pos = offset
        elif whence == io.SEEK_CUR:
            self.pos += offset
        else:
            self.pos = self.size + offset
        return self.pos

    def readinto(self, buf):
        if self.pos >= self.size:
            return 0
        end = min(self.size, self.pos + len(buf)) - 1
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{end}"})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    data = r.read()
                break
            except Exception:
                if attempt == 3:
                    raise
        self.requests += 1
        buf[: len(data)] = data
        self.pos += len(data)
        return len(data)


def load_annotations():
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "annotations.json")
    if not os.path.exists(path):
        print("downloading annotations.json (22 MB)")
        with urllib.request.urlopen(ANNOTATIONS, timeout=300) as r, open(path, "wb") as f:
            shutil.copyfileobj(r, f)
    with open(path) as f:
        return json.load(f)


def games_with_corners(ann):
    """Game id -> list of image records, for images that have corners."""
    cornered = {c["image_id"] for c in ann["annotations"].get("corners", [])}
    games = {}
    for img in ann["images"]:
        if img["id"] in cornered:
            games.setdefault(img["game_id"], []).append(img)
    return games


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="list the games that have corners")
    ap.add_argument("--games", type=int, default=8, help="how many games to fetch")
    ap.add_argument("--size", type=int, default=1024, help="longest side of saved photos")
    args = ap.parse_args()

    ann = load_annotations()
    games = games_with_corners(ann)
    if args.list:
        for gid, imgs in sorted(games.items()):
            cams = sorted({i.get("camera", "?") for i in imgs})
            print(f"game {gid}: {len(imgs)} photos, cameras {cams}, e.g. {imgs[0]['path']}")
        return

    # Spread the picks over the games so different phones and angles show up.
    ids = sorted(games)
    step = max(1, len(ids) // args.games)
    chosen = ids[::step][: args.games]
    wanted = {img["path"]: img for gid in chosen for img in games[gid]}
    print(f"fetching games {chosen}: {len(wanted)} photos")

    remote = RemoteFile(ARCHIVE_2K)
    archive = zipfile.ZipFile(io.BufferedReader(remote, buffer_size=4 << 20))
    by_name = {n.rsplit("/", 1)[-1]: n for n in archive.namelist() if not n.endswith("/")}
    tmp = tempfile.mkdtemp()
    done = 0
    for path in sorted(wanted):
        member = by_name.get(os.path.basename(path))
        if member is None:
            print(f"  not in archive: {path}")
            continue
        dest = os.path.join(OUT, path)
        if os.path.exists(dest):
            done += 1
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        raw = os.path.join(tmp, "raw.jpg")
        with archive.open(member) as src, open(raw, "wb") as f:
            shutil.copyfileobj(src, f)
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", raw, "-vf",
             f"scale='if(gt(iw,ih),{args.size},-2)':'if(gt(iw,ih),-2,{args.size})'", "-q:v", "3", dest],
            check=True,
        )
        done += 1
        if done % 25 == 0:
            print(f"  {done}/{len(wanted)} photos, {remote.requests} requests")
    shutil.rmtree(tmp)
    print(f"done: {done} photos in {OUT}")


if __name__ == "__main__":
    sys.exit(main())
