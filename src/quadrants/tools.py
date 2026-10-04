import os

class ToolsNode:
    def read_file(self, path: str) -> str:
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return f.read()
        except Exception as e:
            return f'error: {str(e)}'

    def write_to_file(self, path: str, content: str) -> str:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            with open(path, 'w', encoding='utf-8') as f:
                f.write(content)
            return 'success'
        except Exception as e:
            return f'error: {str(e)}'

    def replace_file_content(self, path: str, target: str, replacement: str) -> str:
        try:
            with open(path, 'r', encoding='utf-8') as f:
                content = f.read()
            content = content.replace(target, replacement)
            with open(path, 'w', encoding='utf-8') as f:
                f.write(content)
            return 'success'
        except Exception as e:
            return f'error: {str(e)}'
    def __init__(self):
        self.dynamic_tools = {}
    
    def add_tool(self, arg1, arg2=None):
        func = arg2 if arg2 else arg1
        name = arg1 if arg2 else func.__name__
        if not hasattr(self, 'dynamic_tools'):
            self.dynamic_tools = {}
        self.dynamic_tools[name] = func
