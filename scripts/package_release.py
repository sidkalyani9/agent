"""Stage an allowlisted Python runtime and built frontend, without local data."""
import argparse
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]


def package(destination):
    destination = Path(destination).resolve()
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("Release destination must be empty; existing files were not removed.")
    if not (ROOT / "frontend/dist/index.html").is_file():
        raise ValueError("Build the frontend with npm run build first.")
    destination.mkdir(parents=True, exist_ok=True)
    source = ROOT / "backend/pantry"
    runtime = destination / "backend/pantry"
    runtime.mkdir(parents=True)
    for file in source.iterdir():
        if file.is_file() and file.suffix in {".py", ".sql", ".json", ".txt"}:
            shutil.copy2(file, runtime / file.name)
    shutil.copytree(ROOT / "frontend/dist", destination / "frontend/dist")
    shutil.copy2(ROOT / "backend/requirements.txt", destination / "requirements.txt")
    shutil.copy2(ROOT / "startup.sh", destination / "startup.sh")
    print(f"Release staged at {destination}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", nargs="?", default=str(ROOT / "release"))
    package(parser.parse_args().destination)
