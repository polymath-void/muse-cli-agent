import ast
import operator
import subprocess

def token_counter(text):
    # Heuristic: 1 token ~= 4 characters
    return len(text) // 4

def memory_compressor(kernel, max_history=10):
    if hasattr(kernel, 'memory') and isinstance(kernel.memory, list):
        if len(kernel.memory) > max_history:
            kernel.memory = kernel.memory[-max_history:]
            return f"Memory compressed to last {max_history} entries."
        return "Memory is within limits."
    return "Kernel has no compatible memory."

def schedule_task(kernel, cron_string, task):
    if hasattr(kernel, 'fleet') and hasattr(kernel.fleet, 'scheduler'):
        kernel.fleet.scheduler.add_job(cron_string, task)
        return f"Task scheduled with cron: {cron_string}"
    return "Scheduler not available."

def math_calculator(expression):
    # Simple and safe enough for basic math
    try:
        node = ast.parse(expression, mode='eval')
        def _eval(node):
            if isinstance(node, ast.Expression):
                return _eval(node.body)
            elif isinstance(node, ast.BinOp):
                op_map = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv}
                return op_map[type(node.op)](_eval(node.left), _eval(node.right))
            elif isinstance(node, ast.Constant):
                return node.value
            else:
                raise ValueError("Unsupported operation")
        result = _eval(node)
        return str(result)
    except Exception as e:
        return f"Error evaluating expression: {e}"

def ast_viewer(path):
    try:
        result = subprocess.run(["syntycode", "context", path], capture_output=True, text=True, check=True)
        return result.stdout
    except Exception as e:
        return f"Error viewing AST: {e}"

def register(kernel):
    kernel.tools.add_tool("count_tokens", token_counter)
    kernel.tools.add_tool("compress_memory", lambda: memory_compressor(kernel))
    kernel.tools.add_tool("schedule", lambda cron, task: schedule_task(kernel, cron, task))
    kernel.tools.add_tool("math", math_calculator)
    kernel.tools.add_tool("view_ast", ast_viewer)
