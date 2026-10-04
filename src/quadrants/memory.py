import json
import os
import sqlite3
from typing import List, Dict, Any

class MemoryNode:
    """
    Manages episodic memory, chat context, and NodeOS integration.
    """
    def __init__(self, kernel):
        self.kernel = kernel
        self.history: List[Dict[str, Any]] = []
        self.workspace_dir = os.getcwd()
        
    def append_message(self, role: str, content: str):
        self.history.append({"role": role, "content": content})
        
    def get_context(self, max_tokens: int = 4000) -> List[Dict[str, Any]]:
        current_len = 0
        context = []
        for msg in reversed(self.history):
            msg_len = len(msg['content']) // 4
            if current_len + msg_len > max_tokens:
                break
            context.insert(0, msg)
            current_len += msg_len
        return context
        
    def clear(self):
        self.history = []

    def sync_to_nodeos(self, task_name: str, status: str):
        """
        Emits workflow intent back to the native AGY-NodeOS SQLite graph.
        """
        db_path = os.path.join(self.workspace_dir, "agy_nodeos.db")
        if not os.path.exists(db_path):
            return
            
        try:
            conn = sqlite3.connect(db_path)
            c = conn.cursor()
            # Log cognitive action into NodeOS native state
            c.execute(
                "CREATE TABLE IF NOT EXISTS agy_cognitive_state (id INTEGER PRIMARY KEY, task TEXT, status TEXT)"
            )
            c.execute("INSERT INTO agy_cognitive_state (task, status) VALUES (?, ?)", (task_name, status))
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"NodeOS Sync Error: {e}")
