import subprocess
import asyncio
import threading

class BackgroundScheduler:
    def __init__(self):
        self.tasks = []
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._start_loop, daemon=True)
        self._thread.start()

    def _start_loop(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def queue_command(self, cmd: str, cwd: str = '.'):
        async def _run():
            process = await asyncio.create_subprocess_shell(
                cmd,
                cwd=cwd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await process.communicate()
            return stdout.decode(), stderr.decode(), process.returncode
            
        future = asyncio.run_coroutine_threadsafe(_run(), self._loop)
        self.tasks.append(future)
        return future

class FleetNode:
    def __init__(self):
        self.scheduler = BackgroundScheduler()

    def run_command(self, cmd: str, cwd: str = '.') -> str:
        try:
            result = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True)
            return f'stdout:\n{result.stdout}\nstderr:\n{result.stderr}'
        except Exception as e:
            return f'error: {str(e)}'
            
    def run_background_command(self, cmd: str, cwd: str = '.'):
        return self.scheduler.queue_command(cmd, cwd)
