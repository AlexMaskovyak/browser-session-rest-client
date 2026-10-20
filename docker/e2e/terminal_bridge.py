"""Run the real CLI with an interactive controlling terminal; bridge bytes only."""
import errno
import os
import pty
import selectors
import signal
import sys


def main():
    child, terminal = pty.fork()
    if child == 0:
        os.execvp(sys.argv[1], sys.argv[1:])
    def terminate(_signal=None, _frame=None):
        try:
            os.kill(child, signal.SIGTERM)
        except ProcessLookupError:
            pass
    signal.signal(signal.SIGTERM, terminate)
    reaped = False
    selector = selectors.DefaultSelector()
    selector.register(terminal, selectors.EVENT_READ)
    selector.register(sys.stdin.fileno(), selectors.EVENT_READ)
    try:
        finished = False
        while not finished:
            for event, _ in selector.select():
                if event.fd == terminal:
                    try:
                        data = os.read(terminal, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        data = b""
                    if not data:
                        finished = True
                        break
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                else:
                    data = os.read(sys.stdin.fileno(), 4096)
                    if not data:
                        selector.unregister(sys.stdin.fileno())
                        os.kill(child, signal.SIGTERM)
                    else:
                        os.write(terminal, data)
        _, status = os.waitpid(child, 0)
        reaped = True
        return os.waitstatus_to_exitcode(status)
    finally:
        selector.close()
        os.close(terminal)
        if not reaped:
            terminate()


if __name__ == "__main__":
    sys.exit(main())
