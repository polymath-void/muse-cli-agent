import sys
import json
import os
import sqlite3
import urllib.request
import platform

def get_sys_stats():
    import psutil if 'psutil' in sys.modules else None
    return {
        "platform": platform.system(),
        "release": platform.release(),
        "python_version": platform.python_version(),
        "cwd": os.getcwd()
    }

def query_sqlite(db_path, query):
    if not os.path.exists(db_path):
        return {"error": f"Database not found: {db_path}"}
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute(query)
        rows = cursor.fetchall()
        cols = [description[0] for description in cursor.description]
        conn.close()
        return {"columns": cols, "rows": rows}
    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    tool = sys.argv[1] if len(sys.argv) > 1 else "info"
    if tool == "info":
        print(json.dumps(get_sys_stats()))
    elif tool == "sql":
        db = sys.argv[2] if len(sys.argv) > 2 else ""
        q = sys.argv[3] if len(sys.argv) > 3 else "SELECT 1"
        print(json.dumps(query_sqlite(db, q)))
