import json
import os

termux_tools_code = """
import subprocess
import json

def _run_termux_cmd(*args):
    try:
        result = subprocess.run(["/data/data/com.termux/files/usr/bin/" + args[0], *args[1:]], capture_output=True, text=True, check=True)
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        return f"Error: {e.stderr.strip()}"
    except Exception as e:
        return f"Error: {str(e)}"

def termux_clipboard_get():
    return _run_termux_cmd("termux-clipboard-get")

def termux_clipboard_set(text: str):
    _run_termux_cmd("termux-clipboard-set", text)
    return "Clipboard updated"

def termux_battery_status():
    output = _run_termux_cmd("termux-battery-status")
    try:
        data = json.loads(output)
        return f"Battery: {data.get('percentage')}% ({data.get('status')})"
    except:
        return output

def termux_toast(text: str):
    _run_termux_cmd("termux-toast", text)
    return "Toast shown"

def termux_open_url(url: str):
    _run_termux_cmd("termux-open-url", url)
    return f"Opened {url}"

def sys_info_free():
    return _run_termux_cmd("free", "-m")

def register(kernel):
    kernel.tools.register("termux_clipboard_get", termux_clipboard_get)
    kernel.tools.register("termux_clipboard_set", termux_clipboard_set)
    kernel.tools.register("termux_battery_status", termux_battery_status)
    kernel.tools.register("termux_toast", termux_toast)
    kernel.tools.register("termux_open_url", termux_open_url)
    kernel.tools.register("sys_info_free", sys_info_free)
"""

dev_tools_code = """
import subprocess
import os
import sqlite3
import sys
import io
import contextlib

def _run_cmd(*args, cwd=None):
    try:
        result = subprocess.run(args, capture_output=True, text=True, cwd=cwd)
        if result.returncode != 0:
            return f"Error: {result.stderr.strip()}"
        return result.stdout.strip()
    except Exception as e:
        return f"Error: {str(e)}"

def git_status(cwd="."):
    return _run_cmd("git", "status", cwd=cwd)

def git_add(path, cwd="."):
    return _run_cmd("git", "add", path, cwd=cwd)

def git_commit(message, cwd="."):
    return _run_cmd("git", "commit", "-m", message, cwd=cwd)

def git_push(cwd="."):
    return _run_cmd("git", "push", cwd=cwd)

def search_rg(pattern, cwd="."):
    return _run_cmd("rg", pattern, cwd=cwd)

def search_fd(pattern, cwd="."):
    return _run_cmd("fd", pattern, cwd=cwd)

def tree_map(cwd="."):
    return _run_cmd("tree", "-L", "2", cwd=cwd)

def python_repl(code: str):
    output = io.StringIO()
    try:
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            exec(code, {})
        return output.getvalue()
    except Exception as e:
        return f"Exception: {str(e)}\n{output.getvalue()}"

def sqlite_inspect(query: str):
    db_path = os.path.join(os.getcwd(), "agy_nodeos.db")
    if not os.path.exists(db_path):
        return f"Database not found at {db_path}"
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute(query)
        rows = cursor.fetchall()
        conn.close()
        return str(rows)
    except Exception as e:
        return f"Error: {str(e)}"

def register(kernel):
    kernel.tools.register("git_status", git_status)
    kernel.tools.register("git_add", git_add)
    kernel.tools.register("git_commit", git_commit)
    kernel.tools.register("git_push", git_push)
    kernel.tools.register("search_rg", search_rg)
    kernel.tools.register("search_fd", search_fd)
    kernel.tools.register("tree_map", tree_map)
    kernel.tools.register("python_repl", python_repl)
    kernel.tools.register("sqlite_inspect", sqlite_inspect)
"""

data = {
  "module_name": "muse_kernel",
  "files": [
    { "file_name": "plugins/termux_tools", "language": "python", "code": termux_tools_code.strip() },
    { "file_name": "plugins/dev_tools", "language": "python", "code": dev_tools_code.strip() }
  ]
}

os.makedirs("/data/data/com.termux/files/home/Projects/muse-cli-agent", exist_ok=True)
with open("/data/data/com.termux/files/home/Projects/muse-cli-agent/architecture_plugins_batch1.json", "w") as f:
    json.dump(data, f, indent=2)
