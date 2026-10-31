import io
import signal
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from website_client import BrowserSession, LoginError
from website_client.cli import main
from website_client.session import website_url


@pytest.mark.parametrize("url", ["http://example.test", "https://user:secret@example.test", "https://example.test/#secret", "https://example.test:bad", "https://example.test/\nsecret", "https:///missing"])
def test_rejects_invalid_urls(url):
    with pytest.raises(LoginError):
        website_url(url)


def test_normalizes_origin():
    assert website_url("https://EXAMPLE.test/path?q=x") == website_url("https://example.test:443/other")


@pytest.fixture
def browser(monkeypatch):
    page = Mock()
    page.is_closed.return_value = False
    page.url = "https://example.test/app"
    page.locator.return_value.count.return_value = 0
    context = Mock()
    context.new_page.return_value = page
    owned = Mock()
    owned.new_context.return_value = context
    owned.is_connected.return_value = True
    manager = Mock()
    manager.chromium.launch.return_value = owned
    monkeypatch.setitem(sys.modules, "playwright.sync_api", SimpleNamespace(sync_playwright=lambda: SimpleNamespace(start=lambda: manager)))
    return SimpleNamespace(page=page, context=context, owned=owned, manager=manager)


class Terminal(io.StringIO):
    def isatty(self):
        return True


def terminal_ready(monkeypatch):
    selector = Mock()
    selector.__enter__ = Mock(return_value=selector)
    selector.__exit__ = Mock(return_value=False)
    selector.select.return_value = [(None, None)]
    monkeypatch.setattr("website_client.session.selectors.DefaultSelector", lambda: selector)


def test_owned_browser_lifecycle_and_no_credential_exports(browser, monkeypatch):
    terminal_ready(monkeypatch)
    previous = signal.getsignal(signal.SIGTERM)
    with BrowserSession("https://example.test/app") as session:
        result = session.confirm_login(Terminal("\n"), io.StringIO())
        assert result == {"sessionReady": True, "authentication": "user-confirmed", "apiVerified": False}
        browser.owned.close.assert_not_called()
        assert "example.test" not in repr(session)
    browser.context.close.assert_called_once()
    browser.owned.close.assert_called_once()
    browser.manager.stop.assert_called_once()
    browser.context.storage_state.assert_not_called()
    browser.context.cookies.assert_not_called()
    browser.context.new_page.assert_called_once()
    assert signal.getsignal(signal.SIGTERM) == previous


@pytest.mark.parametrize("failure", ["launch", "context", "page", "navigate"])
def test_setup_failure_is_redacted_and_cleans_resources(browser, failure):
    targets = {"launch": browser.manager.chromium.launch, "context": browser.owned.new_context,
               "page": browser.context.new_page, "navigate": browser.page.goto}
    targets[failure].side_effect = RuntimeError("private-token-value")
    with pytest.raises(LoginError) as error:
        with BrowserSession("https://example.test/app"):
            pytest.fail("Setup should fail")
    assert "private-token" not in str(error.value)
    browser.manager.stop.assert_called_once()
    if failure != "launch":
        browser.owned.close.assert_called_once()
    if failure in {"page", "navigate"}:
        browser.context.close.assert_called_once()


@pytest.mark.parametrize("state", ["password", "sso", "login", "mfa", "closed", "disconnected", "eof"])
def test_unfinished_or_closed_sessions_fail(browser, monkeypatch, state):
    terminal_ready(monkeypatch)
    if state == "password": browser.page.locator.return_value.count.return_value = 1
    if state == "sso": browser.page.url = "https://sso.example.test/app"
    if state in {"login", "mfa"}: browser.page.url = "https://example.test/" + state
    if state == "closed": browser.page.is_closed.return_value = True
    if state == "disconnected": browser.owned.is_connected.return_value = False
    with pytest.raises(LoginError):
        with BrowserSession("https://example.test/app") as session:
            session.confirm_login(Terminal("" if state == "eof" else "\n"), io.StringIO())
    browser.owned.close.assert_called_once()


def test_keyboard_interrupt_closes_browser(browser, monkeypatch):
    terminal_ready(monkeypatch)
    browser.page.wait_for_timeout.side_effect = KeyboardInterrupt()
    monkeypatch.setattr(sys, "stdin", Terminal("\n"))
    assert main(["login", "--url", "https://example.test/app"]) == 130
    browser.owned.close.assert_called_once()


def test_signals_defer_cancellation_until_between_browser_calls(browser):
    previous = signal.getsignal(signal.SIGINT)
    with BrowserSession("https://example.test/app") as session:
        signal.getsignal(signal.SIGINT)(signal.SIGINT, None)
        with pytest.raises(KeyboardInterrupt):
            session._check_open()
    assert signal.getsignal(signal.SIGINT) == previous
    browser.owned.close.assert_called_once()


def test_cli_refuses_pipes_before_launch(browser, monkeypatch):
    monkeypatch.setattr(sys, "stdin", io.StringIO("\n"))
    assert main(["login", "--url", "https://example.test/app"]) == 1
    browser.manager.chromium.launch.assert_not_called()


def test_cli_returns_bounded_readiness(browser, monkeypatch, capsys):
    terminal_ready(monkeypatch)
    monkeypatch.setattr(sys, "stdin", Terminal("\n"))
    assert main(["login", "--url", "https://example.test/app"]) == 0
    output = capsys.readouterr().out
    assert '"sessionClosed": true' in output
    assert '"apiVerified": false' in output
    assert '"clientGenerated": false' in output


def test_command_help():
    output = subprocess.check_output([sys.executable, "-m", "website_client.cli", "login", "--help"], text=True)
    assert "verification" in output
    assert "does not save a login" in output
