import re

class RedactorKernel:
    def __init__(self):
        # Regex patterns for secrets
        self.patterns = [
            r'sk-[A-Za-z0-9-_]+',       # OpenAI/Anthropic/generic secret keys
            r'ghp_[A-Za-z0-9]+',        # GitHub PATs
            r'AKIA[0-9A-Z]{16}',        # AWS Access Key
            r'-----BEGIN.*?-----'       # Private keys
        ]
        self.compiled_patterns = [re.compile(p, re.DOTALL) for p in self.patterns]

    def redact(self, text: str) -> str:
        """Redacts secrets from logs, web content, and traces."""
        if not isinstance(text, str):
            return text
            
        redacted_text = text
        for pattern in self.compiled_patterns:
            redacted_text = pattern.sub('[REDACTED]', redacted_text)
            
        return redacted_text
