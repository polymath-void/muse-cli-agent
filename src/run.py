"""Muse CLI Agent — Entry Point."""
import os
import sys

# Ensure src/ is on the path for internal imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from kernel import QuadTreeKernel
from tui import run


def main():
    kernel = QuadTreeKernel()
    run(kernel)


if __name__ == "__main__":
    main()
