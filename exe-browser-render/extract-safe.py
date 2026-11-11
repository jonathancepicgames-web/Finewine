#!/usr/bin/env python3
"""Extract a ZIP without allowing traversal, symlinks, or unbounded expansion."""
import os
import pathlib
import stat
import sys
import zipfile

MAX_FILES = 12000
MAX_TOTAL = 700 * 1024 * 1024
MAX_ONE = 250 * 1024 * 1024


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: extract-safe.py archive.zip destination", file=sys.stderr)
        return 2
    archive = pathlib.Path(sys.argv[1])
    destination = pathlib.Path(sys.argv[2]).resolve()
    destination.mkdir(parents=True, exist_ok=True)

    total = 0
    count = 0
    try:
        with zipfile.ZipFile(archive) as zf:
            infos = zf.infolist()
            if len(infos) > MAX_FILES:
                raise ValueError("ZIP contains too many entries.")
            for info in infos:
                raw = info.filename.replace("\\", "/")
                rel = pathlib.PurePosixPath(raw)
                if rel.is_absolute() or any(part in ("..", "") for part in rel.parts):
                    raise ValueError(f"Unsafe path in ZIP: {info.filename[:100]}")
                if not rel.parts:
                    continue
                unix_mode = (info.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(unix_mode):
                    raise ValueError("ZIP contains a symbolic link; extraction blocked.")
                if info.is_dir():
                    continue
                if info.file_size > MAX_ONE:
                    raise ValueError(f"A ZIP item exceeds the {MAX_ONE // (1024 * 1024)} MB extraction limit.")
                total += info.file_size
                count += 1
                if total > MAX_TOTAL:
                    raise ValueError("Expanded ZIP exceeds the total extraction limit.")
                target = (destination / pathlib.Path(*rel.parts)).resolve()
                if target != destination and destination not in target.parents:
                    raise ValueError(f"Unsafe path in ZIP: {info.filename[:100]}")
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info, "r") as source, open(target, "wb") as output:
                    copied = 0
                    while True:
                        chunk = source.read(1024 * 1024)
                        if not chunk:
                            break
                        copied += len(chunk)
                        if copied > info.file_size or copied > MAX_ONE:
                            raise ValueError("ZIP item expanded beyond its declared size.")
                        output.write(chunk)
                try:
                    os.chmod(target, 0o640)
                except OSError:
                    pass
    except (OSError, zipfile.BadZipFile, RuntimeError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(f"Extracted {count} file(s), {total} bytes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
