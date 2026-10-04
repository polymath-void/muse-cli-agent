"""
System integration tools — platform-independent.
On Termux: uses termux-* APIs for Android hardware access.
On other platforms: falls back to standard OS equivalents.
"""
import subprocess
import json
import shutil


def _run_cmd(cmd: str, *args) -> str:
    """Run a command resolved via PATH, never hardcoded."""
    binary = shutil.which(cmd)
    if not binary:
        return f"Error: '{cmd}' not found on this platform"
    try:
        result = subprocess.run(
            [binary, *args],
            capture_output=True, text=True, check=True, timeout=10
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        return f"Error: {e.stderr.strip()}"
    except subprocess.TimeoutExpired:
        return f"Error: {cmd} timed out"
    except Exception as e:
        return f"Error: {str(e)}"


def clipboard_get() -> str:
    """Read clipboard. Uses termux-clipboard-get on Android, xclip/pbpaste elsewhere."""
    if shutil.which("termux-clipboard-get"):
        return _run_cmd("termux-clipboard-get")
    elif shutil.which("pbpaste"):
        return _run_cmd("pbpaste")
    elif shutil.which("xclip"):
        return _run_cmd("xclip", "-selection", "clipboard", "-o")
    return "Error: no clipboard tool available"


def clipboard_set(text: str) -> str:
    """Write clipboard. Uses termux-clipboard-set on Android, xclip/pbcopy elsewhere."""
    if shutil.which("termux-clipboard-set"):
        _run_cmd("termux-clipboard-set", text)
    elif shutil.which("pbcopy"):
        subprocess.run(["pbcopy"], input=text, text=True)
    elif shutil.which("xclip"):
        subprocess.run(["xclip", "-selection", "clipboard"], input=text, text=True)
    else:
        return "Error: no clipboard tool available"
    return "Clipboard updated"


def battery_status() -> str:
    """Battery info. Termux API on Android, pmset on macOS, /sys on Linux."""
    if shutil.which("termux-battery-status"):
        output = _run_cmd("termux-battery-status")
        try:
            data = json.loads(output)
            return f"Battery: {data.get('percentage')}% ({data.get('status')})"
        except (json.JSONDecodeError, TypeError):
            return output
    elif shutil.which("pmset"):
        return _run_cmd("pmset", "-g", "batt")
    else:
        # Linux /sys fallback
        try:
            with open("/sys/class/power_supply/BAT0/capacity") as f:
                pct = f.read().strip()
            with open("/sys/class/power_supply/BAT0/status") as f:
                status = f.read().strip()
            return f"Battery: {pct}% ({status})"
        except FileNotFoundError:
            return "Battery: N/A (no battery detected)"


def toast(text: str) -> str:
    """Show notification. Termux toast on Android, notify-send on Linux, osascript on macOS."""
    if shutil.which("termux-toast"):
        _run_cmd("termux-toast", text)
    elif shutil.which("notify-send"):
        _run_cmd("notify-send", "Muse", text)
    elif shutil.which("osascript"):
        _run_cmd("osascript", "-e", f'display notification "{text}" with title "Muse"')
    else:
        return f"Toast (no backend): {text}"
    return "Notification shown"


def open_url(url: str) -> str:
    """Open URL in browser. Termux on Android, open on macOS, xdg-open on Linux."""
    if shutil.which("termux-open-url"):
        _run_cmd("termux-open-url", url)
    elif shutil.which("open"):
        _run_cmd("open", url)
    elif shutil.which("xdg-open"):
        _run_cmd("xdg-open", url)
    else:
        return f"Error: no URL opener. Visit manually: {url}"
    return f"Opened {url}"


def sys_memory() -> str:
    """Memory info. Uses free on Linux/Termux, vm_stat on macOS."""
    if shutil.which("free"):
        return _run_cmd("free", "-m")
    elif shutil.which("vm_stat"):
        return _run_cmd("vm_stat")
    return "Error: no memory info tool available"


def register(kernel):
    kernel.tools.add_tool("clipboard_get", clipboard_get)
    kernel.tools.add_tool("clipboard_set", clipboard_set)
    kernel.tools.add_tool("battery_status", battery_status)
    kernel.tools.add_tool("toast", toast)
    kernel.tools.add_tool("open_url", open_url)
    kernel.tools.add_tool("sys_memory", sys_memory)