def fetch_url(url: str) -> str:
    """Fetch a URL."""
    import urllib.request
    try:
        with urllib.request.urlopen(url) as response:
            return response.read().decode('utf-8')
    except Exception as e:
        return str(e)

def search(query: str) -> list:
    """Search the web."""
    return [f"Mock result for {query}"]

def register(kernel):
    if hasattr(kernel, 'tools_node'):
        kernel.tools_node.add_tool(fetch_url)
        kernel.tools_node.add_tool(search)
