"""Run the packaged production entry point over real TCP with disposable data."""
import os
from pathlib import Path
import re
import subprocess
import threading
import time
import httpx

ROOT = Path(__file__).resolve().parents[2]


def test_release_contents_startup_static_and_restart(tmp_path):
    import sys
    package = tmp_path / "release"
    subprocess.run([sys.executable, str(ROOT / "scripts/package_release.py"), str(package)], check=True, capture_output=True)
    names = {p.relative_to(package).as_posix() for p in package.rglob("*") if p.is_file()}
    assert {"startup.sh", "requirements.txt", "backend/pantry/app.py", "backend/pantry/schema.sql", "frontend/dist/index.html"} <= names
    assert not any(any(part in path.split('/') for part in ('.env', 'node_modules', '.venv', 'tests', 'data', '__pycache__')) for path in names)
    assert not any(path.endswith(('.sqlite', '.mjs')) for path in names)
    runtime = os.getenv("PANTRY_RELEASE_PYTHON") or sys.executable
    env = dict(os.environ, PORT="0", PANTRY_HOST="127.0.0.1", PANTRY_DATA_DIR=str(tmp_path / "data"), APP_ORIGIN="http://127.0.0.1:5173", PATH=str(Path(runtime).parent) + os.pathsep + os.environ["PATH"])
    env.pop("SESSION_SECRET", None)
    for _ in range(2):
        process = subprocess.Popen(["bash", "startup.sh"], cwd=package, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        lines = []
        reader = threading.Thread(target=lambda: lines.extend(process.stdout), daemon=True)
        reader.start()
        try:
            base = None
            for attempt in range(200):
                if process.poll() is not None: raise AssertionError("Runtime exited before readiness: " + "".join(lines))
                if not base:
                    match = re.search(r"Pantry API on (http://127\.0\.0\.1:\d+)", "".join(lines))
                    if match: base = match[1]
                if base:
                    try:
                        if httpx.get(base + "/api/health", timeout=1).status_code == 200: break
                    except httpx.TransportError: pass
                time.sleep(.05)
            else: raise AssertionError("Packaged application did not become healthy")
            with httpx.Client(base_url=base) as client:
                assert client.get('/api/health').json() == {"ok": True}
                html = client.get('/')
                assert html.status_code == 200 and 'script-src' in html.headers['content-security-policy']
                assert client.get('/some/browser/route').text == html.text
                asset = re.search(r'src="(/assets/[^\"]+\.js)"', html.text)[1]
                assert client.get(asset).status_code == 200
                assert client.get('/api/me').status_code == 401
                assert client.get('/api/missing').json() == {"error": "Not found."}
            key = (tmp_path / 'data/session-secret.key').read_text()
            if _ == 0: original = key
            else: assert key == original
        finally:
            process.terminate()
            try: process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            reader.join(timeout=2)
        assert process.returncode in (0, -15) and 'Application shutdown complete.' in ''.join(lines), ''.join(lines)
