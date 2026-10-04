import json
import os

class BudgetKernel:
    def __init__(self, workspace_root: str):
        self.config_file = os.path.join(workspace_root, ".muse", "config.json")
        self.current_tokens = 0
        self.max_tokens = 100000
        self._load_config()

    def _load_config(self):
        if os.path.exists(self.config_file):
            try:
                with open(self.config_file, "r") as f:
                    data = json.load(f)
                    self.max_tokens = data.get("maxTokensPerGoal", 100000)
            except Exception:
                pass
        else:
            os.makedirs(os.path.dirname(self.config_file), exist_ok=True)
            with open(self.config_file, "w") as f:
                json.dump({"maxTokensPerGoal": 100000, "maxCostUsd": 2.00}, f, indent=2)

    def add_usage(self, tokens: int) -> bool:
        """Returns True if within budget, False if exceeded."""
        self.current_tokens += tokens
        if self.current_tokens > self.max_tokens:
            return False
        return True

    def get_report(self) -> str:
        return f"BUDGET REPORT: {self.current_tokens} / {self.max_tokens} tokens used."
