"""Launcher that also works from inside backend\\ — `python run.py`."""

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    from backend.main import main
except ModuleNotFoundError as exc:
    missing = exc.name or "a required dependency"
    sys.exit(
        f"Missing Python dependency: {missing}\n"
        "Activate the project virtual environment and install dependencies:\n"
        "    ..\\venv\\Scripts\\Activate.ps1\n"
        "    pip install -r requirements.txt\n"
        "Then run `python run.py` again."
    )

if __name__ == "__main__":
    main()