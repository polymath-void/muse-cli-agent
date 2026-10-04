import json
import time
import os
import hashlib

class TraceKernel:
    def __init__(self, workspace_root: str):
        self.audit_dir = os.path.join(workspace_root, ".muse", "audit")
        os.makedirs(self.audit_dir, exist_ok=True)
        self.trace_file = os.path.join(self.audit_dir, "trace.jsonl")

    def log_tool_call(self, tool_name: str, args: list, tokens_in: int, tokens_out: int, duration_ms: float):
        ts = time.time()
        args_str = "|".join(map(str, args))
        args_hash = hashlib.sha256(args_str.encode()).hexdigest()[:12]
        
        record = {
            "ts": ts,
            "tool": tool_name,
            "argsHash": args_hash,
            "tokensIn": tokens_in,
            "tokensOut": tokens_out,
            "durationMs": duration_ms
        }
        
        with open(self.trace_file, "a") as f:
            f.write(json.dumps(record) + "\n")
