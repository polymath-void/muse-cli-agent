import subprocess

def ingest_architect(schema_path: str) -> str:
    """Ingest architect JSON using syntycode CLI."""
    result = subprocess.run(['syntycode', 'ingest-architect', schema_path], capture_output=True, text=True)
    return result.stdout

def register(kernel):
    if hasattr(kernel, 'tools_node'):
        kernel.tools_node.add_tool(ingest_architect)
