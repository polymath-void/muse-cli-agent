"""
Platform abstraction layer for Muse CLI Agent.
Detects the runtime environment and resolves binary paths portably.
Never hardcode /data/data/com.termux — use this module instead.
"""
import os
import sys
import shutil
import platform


def detect_platform() -> dict:
    """Return a dict describing the current runtime environment."""
    system = platform.system()
    machine = platform.machine()

    is_termux = (
        system == "Linux"
        and "TERMUX_VERSION" in os.environ
    ) or (
        system == "Android"
    ) or (
        os.path.isdir("/data/data/com.termux")
    )

    is_wsl = system == "Linux" and "microsoft" in platform.release().lower()

    return {
        "system": system,
        "machine": machine,
        "is_termux": is_termux,
        "is_wsl": is_wsl,
        "is_macos": system == "Darwin",
        "is_windows": system == "Windows",
        "is_linux": system == "Linux" and not is_termux and not is_wsl,
        "home": os.path.expanduser("~"),
        "prefix": os.environ.get("PREFIX", "/usr"),
    }


PLATFORM = detect_platform()


def which(binary: str) -> str | None:
    """
    Find a binary on PATH using shutil.which().
    This is the ONLY correct way to resolve binary paths.
    Never hardcode /data/data/com.termux/files/usr/bin/.
    """
    return shutil.which(binary)


def run_native(cmd: str, *args, **kwargs) -> tuple[str, str, int]:
    """
    Run a native command portably. Resolves the binary via which().
    Returns (stdout, stderr, returncode).
    """
    import subprocess

    binary = which(cmd)
    if not binary:
        return ("", f"{cmd}: command not found", 127)

    full_args = [binary] + list(args)
    try:
        result = subprocess.run(
            full_args,
            capture_output=True,
            text=True,
            timeout=kwargs.get("timeout", 30),
            cwd=kwargs.get("cwd"),
        )
        return (result.stdout.strip(), result.stderr.strip(), result.returncode)
    except subprocess.TimeoutExpired:
        return ("", f"{cmd}: timed out", 124)
    except Exception as e:
        return ("", str(e), 1)


def has_command(cmd: str) -> bool:
    """Check if a command exists on the system."""
    return which(cmd) is not None


def project_root() -> str:
    """Return the muse-cli-agent project root, resolved portably."""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def src_dir() -> str:
    """Return the src/ directory path."""
    return os.path.dirname(os.path.abspath(__file__))
