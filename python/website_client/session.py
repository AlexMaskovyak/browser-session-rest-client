"""Own one temporary browser session, without exporting authentication."""

import selectors
import signal
import sys
import threading
from urllib.parse import urlsplit


class LoginError(Exception):
    """A bounded, user-facing login failure."""


def website_url(value):
    try:
        if not isinstance(value, str) or len(value) > 8192 or any(ord(c) <= 32 for c in value):
            raise ValueError()
        parsed = urlsplit(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise ValueError()
        port = parsed.port or 443
        return (parsed.hostname.lower(), port)
    except (ValueError, TypeError):
        raise LoginError("Use an HTTPS website URL without embedded credentials or a fragment.") from None


class BrowserSession:
    """An owned browser, kept alive for the caller's discovery and generation steps.

    Nothing is saved for a later invocation. Callers must use a context manager.
    """

    def __init__(self, url, browser="chrome"):
        self._origin = website_url(url)
        if browser not in {"chrome", "chromium", "msedge"}:
            raise LoginError("Choose chrome, chromium or msedge as the browser.")
        self._url = url
        self._browser_name = browser
        self._manager = self._browser = self._context = self._page = None
        self._previous_term = None

    def __repr__(self):
        return "<BrowserSession temporary; credentials not exported>"

    def __enter__(self):
        try:
            from playwright.sync_api import sync_playwright

            if threading.current_thread() is threading.main_thread():
                self._previous_term = signal.signal(signal.SIGTERM, self._terminate)
            self._manager = sync_playwright().start()
            self._browser = self._manager.chromium.launch(
                headless=False,
                channel=None if self._browser_name == "chromium" else self._browser_name,
            )
            self._context = self._browser.new_context(accept_downloads=False)
            self._page = self._context.new_page()
        except (KeyboardInterrupt, SystemExit):
            self.close()
            raise
        except Exception:
            self.close()
            raise LoginError(
                "Could not open the browser. Install Chrome, or run "
                "'python -m playwright install chromium' and select '--browser chromium'."
            ) from None
        try:
            self._page.goto(self._url, wait_until="domcontentloaded", timeout=60000)
            return self
        except (KeyboardInterrupt, SystemExit):
            self.close()
            raise
        except Exception:
            self.close()
            raise LoginError("Could not open the website. Check its address and connection, then retry.") from None

    @staticmethod
    def _terminate(_signum, _frame):
        raise KeyboardInterrupt()

    def _check_open(self):
        if not self._browser.is_connected() or self._page.is_closed():
            raise LoginError("The login browser closed. Run the command again to start a fresh session.")

    def confirm_login(self, input_stream=None, output_stream=None):
        """Wait for human confirmation while continuing to process browser events."""
        input_stream = sys.stdin if input_stream is None else input_stream
        output_stream = sys.stderr if output_stream is None else output_stream
        if not input_stream.isatty():
            raise LoginError("Login requires an interactive terminal. Run the command directly, without a pipe.")
        print(
            "Log in in the browser, including verification codes. Return to the requested "
            "website, then press Enter here to finish. Ctrl+C cancels and closes the browser.",
            file=output_stream, flush=True,
        )
        try:
            if sys.platform == "win32":
                import msvcrt
                while True:
                    self._check_open()
                    self._page.wait_for_timeout(100)
                    if msvcrt.kbhit():
                        key = msvcrt.getwch()
                        if key == "\x03":
                            raise KeyboardInterrupt()
                        if key in {"\r", "\n"}:
                            break
            else:
                with selectors.DefaultSelector() as terminal:
                    terminal.register(input_stream, selectors.EVENT_READ)
                    while True:
                        self._check_open()
                        self._page.wait_for_timeout(100)
                        if terminal.select(timeout=0):
                            if not input_stream.readline():
                                raise LoginError("Terminal input closed. Run the command again.")
                            break
            self._check_open()
            current = urlsplit(self._page.url)
            login_paths = {"login", "log_in", "signin", "sign_in", "sign-in", "sign_in_two_factor", "mfa"}
            if (website_url(self._page.url) != self._origin
                    or current.path.rstrip("/").split("/")[-1].lower() in login_paths
                    or self._page.locator('input[type="password"]:visible').count()):
                raise LoginError("Login is not complete. Return to the requested website after signing in, then retry.")
        except (LoginError, KeyboardInterrupt):
            raise
        except Exception:
            raise LoginError("The browser session ended unexpectedly. Run the command again.") from None
        return {"sessionReady": True, "authentication": "user-confirmed", "apiVerified": False}

    def close(self):
        # Close every acquired resource even if an earlier close fails.
        for resource, method in ((self._context, "close"), (self._browser, "close"), (self._manager, "stop")):
            if resource is not None:
                try:
                    getattr(resource, method)()
                except Exception:
                    pass
        self._context = self._browser = self._manager = self._page = None
        if self._previous_term is not None:
            signal.signal(signal.SIGTERM, self._previous_term)
            self._previous_term = None

    def __exit__(self, *_args):
        self.close()
