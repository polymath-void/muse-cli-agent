"""
NodeOS Native Integration Plugin for Muse CLI Agent.
Provides spatial AST indexing, workflow intent dispatch, and graph traversal
directly against the agy_nodeos.db SQLite database, eliminating the need for
unbounded grep/find operations.
"""
import os
import json
import sqlite3
from datetime import datetime


def _get_db_path():
    """Resolve agy_nodeos.db from CWD, project root, or parent directories."""
    src_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(os.getcwd(), "agy_nodeos.db"),
        os.path.join(src_dir, "..", "agy_nodeos.db"),
        os.path.join(src_dir, "..", "..", "agy_nodeos.db"),
    ]
    for p in candidates:
        real = os.path.realpath(p)
        if os.path.exists(real) and os.path.getsize(real) > 0:
            return real
    return None


def nodeos_search_symbol(symbol: str) -> str:
    """
    Fast-lookup class/function/variable definitions from the NodeOS AST graph.
    Replaces unbounded grep/find with indexed SQLite FTS queries.
    """
    db_path = _get_db_path()
    if not db_path:
        return json.dumps({"error": "agy_nodeos.db not found. Run 'jage' or 'nodeos' to index."})

    try:
        conn = sqlite3.connect(db_path)
        c = conn.cursor()
        c.execute(
            "SELECT n.node_type, n.name, n.scope_path, m.module_name "
            "FROM ast_nodes n LEFT JOIN modules m ON n.module_id = m.module_id "
            "WHERE n.name LIKE ? LIMIT 25",
            (f"%{symbol}%",)
        )
        rows = c.fetchall()
        conn.close()

        if not rows:
            return json.dumps({"results": [], "hint": f"No AST nodes matching '{symbol}'. Try a broader term."})

        results = []
        for r in rows:
            results.append({
                "type": r[0],
                "name": r[1],
                "scope": r[2] if r[2] else "root",
                "module": r[3] if r[3] else "unknown"
            })
        return json.dumps({"results": results}, indent=2)
    except sqlite3.OperationalError as e:
        if "no such table" in str(e):
            return json.dumps({"error": "AST Database not initialized. Run 'jage' or 'nodeos' first."})
        return json.dumps({"error": str(e)})


def nodeos_emit_intent(task_name: str) -> str:
    """
    Drop a JSON intent into workflow.json to trigger background daemon processing.
    The NodeOS watchdog monitors this file and picks up pending intents.
    """
    workflow_path = os.path.join(os.getcwd(), "workflow.json")

    intent = {
        "task": task_name,
        "status": "pending",
        "emitted_at": datetime.now().isoformat(),
        "source": "muse-cli-agent"
    }

    try:
        existing = []
        if os.path.exists(workflow_path):
            with open(workflow_path, "r") as f:
                data = json.load(f)
                if isinstance(data, list):
                    existing = data
                elif isinstance(data, dict):
                    existing = [data]

        existing.append(intent)

        with open(workflow_path, "w") as f:
            json.dump(existing, f, indent=2)

        return json.dumps({"status": "emitted", "task": task_name})
    except Exception as e:
        return json.dumps({"error": str(e)})


def nodeos_get_graph(limit: str = "20") -> str:
    """
    Return the top connected AST nodes from the graph for deep codebase context.
    Provides spatial awareness of the entire project topology.
    """
    db_path = _get_db_path()
    if not db_path:
        return json.dumps({"error": "agy_nodeos.db not found."})

    try:
        lim = int(limit)
    except (ValueError, TypeError):
        lim = 20

    try:
        conn = sqlite3.connect(db_path)
        c = conn.cursor()

        # Get nodes
        c.execute(
            "SELECT node_id, node_type, name FROM ast_nodes ORDER BY node_id LIMIT ?",
            (lim,)
        )
        nodes = [{"id": r[0], "type": r[1], "name": r[2]} for r in c.fetchall()]

        # Get edges if table exists
        edges = []
        try:
            c.execute(
                "SELECT source_id, target_id, relation_type FROM ast_edges LIMIT ?",
                (lim,)
            )
            edges = [{"src": r[0], "dst": r[1], "type": r[2]} for r in c.fetchall()]
        except sqlite3.OperationalError:
            pass

        # Get modules
        modules = []
        try:
            c.execute("SELECT module_id, module_name FROM modules LIMIT ?", (lim,))
            modules = [{"id": r[0], "name": r[1]} for r in c.fetchall()]
        except sqlite3.OperationalError:
            pass

        conn.close()

        return json.dumps({
            "nodes": nodes,
            "edges": edges,
            "modules": modules,
            "total_nodes": len(nodes)
        }, indent=2)
    except sqlite3.OperationalError as e:
        if "no such table" in str(e):
            return json.dumps({"error": "AST Database not initialized. Run 'jage' or 'nodeos' first."})
        return json.dumps({"error": str(e)})


def nodeos_daemon_status() -> str:
    """Check if the NodeOS daemon is alive."""
    import subprocess
    try:
        result = subprocess.run(
            ["nodeos", "-c", "ping"],
            capture_output=True, text=True, timeout=5
        )
        if "pong" in result.stdout.lower():
            return "NodeOS Daemon: ALIVE"
        return f"NodeOS Daemon: UNKNOWN ({result.stdout.strip()})"
    except FileNotFoundError:
        return "NodeOS Daemon: NOT INSTALLED"
    except subprocess.TimeoutExpired:
        return "NodeOS Daemon: TIMEOUT (may be offline)"
    except Exception as e:
        return f"NodeOS Daemon: ERROR ({str(e)})"


def register(kernel):
    """Register all NodeOS tools into the kernel's dynamic tool registry."""
    kernel.tools.add_tool("nodeos_search_symbol", nodeos_search_symbol)
    kernel.tools.add_tool("nodeos_emit_intent", nodeos_emit_intent)
    kernel.tools.add_tool("nodeos_get_graph", nodeos_get_graph)
    kernel.tools.add_tool("nodeos_daemon_status", nodeos_daemon_status)
