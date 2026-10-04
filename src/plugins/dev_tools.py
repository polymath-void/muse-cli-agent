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
    kernel.tools.add_tool("git_status", git_status)
    kernel.tools.add_tool("git_add", git_add)
    kernel.tools.add_tool("git_commit", git_commit)
    kernel.tools.add_tool("git_push", git_push)
    kernel.tools.add_tool("search_rg", search_rg)
    kernel.tools.add_tool("search_fd", search_fd)
    kernel.tools.add_tool("tree_map", tree_map)
    kernel.tools.add_tool("python_repl", python_repl)
    kernel.tools.add_tool("sqlite_inspect", sqlite_inspect)