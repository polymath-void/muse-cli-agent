"""pytest bootstrap: put src/ on sys.path for all tests."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
