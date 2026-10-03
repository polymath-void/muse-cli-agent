import sys
import json
import os
import sqlite3
import subprocess
import hashlib
import re
import urllib.request

def run_command(cmd):
    try:
        return subprocess.check_output(cmd, shell=True, encoding="utf-8")
    except Exception as e:
        return f"error: {str(e)}"

def get_git_diff_summary():
    return run_command("git diff --stat")

def get_git_branches():
    return run_command("git branch -a")

def get_system_processes():
    return run_command("ps aux | head -n 20")

def get_system_env():
    return json.dumps(dict(os.environ), indent=2)

def query_db(db_path, query):
    if not os.path.exists(db_path):
        return json.dumps({"error": f"DB not found: {db_path}"})
    try:
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute(query)
        rows = cur.fetchall()
        cols = [d[0] for d in cur.description]
        conn.close()
        return json.dumps({"columns": cols, "rows": rows}, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})

def list_db_tables(db_path):
    if not os.path.exists(db_path):
        return json.dumps({"error": f"DB not found: {db_path}"})
    try:
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table';")
        tables = [t[0] for t in cur.fetchall()]
        conn.close()
        return json.dumps({"tables": tables}, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})

def parse_python_ast(filepath):
    if not os.path.exists(filepath):
        return json.dumps({"error": f"File not found: {filepath}"})
    import ast
    try:
        with open(filepath, "r") as f:
            tree = ast.parse(f.read(), filename=filepath)
        funcs = [node.name for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)]
        classes = [node.name for node in ast.walk(tree) if isinstance(node, ast.ClassDef)]
        return json.dumps({"functions": funcs, "classes": classes}, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})

def scan_secrets(directory="."):
    findings = []
    secret_patterns = [r"api[_-]?key", r"secret[_-]?key", r"password\s*=", r"auth[_-]?token"]
    for root, dirs, files in os.walk(directory):
        if ".git" in dirs:
            dirs.remove(".git")
        if "node_modules" in dirs:
            dirs.remove("node_modules")
        for file in files:
            if file.endswith((".ts", ".js", ".py", ".json", ".env")):
                fp = os.path.join(root, file)
                try:
                    with open(fp, "r", errors="ignore") as f:
                        for idx, line in enumerate(f, 1):
                            for pat in secret_patterns:
                                if re.search(pat, line, re.IGNORECASE):
                                    findings.append(f"{fp}:{idx} matches {pat}")
                except:
                    pass
    return json.dumps({"potential_secrets": findings}, indent=2)

def hash_file(filepath):
    if not os.path.exists(filepath):
        return json.dumps({"error": "File not found"})
    sha256 = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(8192):
            sha256.update(chunk)
    return json.dumps({"sha256": sha256.hexdigest()}, indent=2)

if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    args = sys.argv[2:]
    
    if action == "git_diff_summary":
        print(get_git_diff_summary())
    elif action == "git_branches":
        print(get_git_branches())
    elif action == "system_processes":
        print(get_system_processes())
    elif action == "system_env":
        print(get_system_env())
    elif action == "db_query":
        print(query_db(args[0], args[1]))
    elif action == "db_tables":
        print(list_db_tables(args[0]))
    elif action == "ast_symbols":
        print(parse_python_ast(args[0]))
    elif action == "scan_secrets":
        print(scan_secrets(args[0] if args else "."))
    elif action == "hash_file":
        print(hash_file(args[0]))
    else:
        print(json.dumps({"error": f"Unknown action: {action}"}))
