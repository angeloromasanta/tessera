"""Entry point for the live agent CLI (see docs/agent-live.md): runs scripts/agent-bridge.py."""
from pathlib import Path
import runpy

if __name__ == "__main__":
    bridge = Path(__file__).resolve().parents[1] / "scripts" / "agent-bridge.py"
    if not bridge.is_file():
        raise SystemExit(f"Live agent editing needs the engine checkout's {bridge.relative_to(bridge.parents[1])}.")
    runpy.run_path(str(bridge), run_name="__main__")
