"""Installed Python command for the website client generator."""

import argparse
import json
import sys

from .session import BrowserSession, LoginError, website_url


def parser():
    result = argparse.ArgumentParser(
        prog="website-client",
        description="Build standalone Python website clients. Start by checking browser login.",
        epilog="Python generation is being rewritten. Login is the first supported milestone.",
    )
    commands = result.add_subparsers(dest="command", required=True)
    login = commands.add_parser(
        "login", help="Open a temporary browser and sign in manually.",
        description="Open the website in a temporary browser. Log in and complete verification "
        "codes there, then press Enter in this terminal. This command closes the browser afterward; "
        "it does not save a login or generate a client. Website scripts run normally.",
        epilog="Requires an interactive terminal and installed Chrome. For Chromium, first run "
        "'python -m playwright install chromium', then select '--browser chromium'. "
        "Ctrl+C cancels. A successful result confirms your handoff, not an authenticated API request.",
    )
    login.add_argument("--url", required=True, help="HTTPS address of the website to sign into.")
    login.add_argument("--browser", choices=["chrome", "chromium", "msedge"], default="chrome")
    return result


def main(args=None):
    options = parser().parse_args(args)
    try:
        website_url(options.url)
        if not sys.stdin.isatty():
            raise LoginError("Login requires an interactive terminal. Run the command directly, without a pipe.")
        print("Opening a temporary browser. Enter credentials only on the website.", file=sys.stderr, flush=True)
        with BrowserSession(options.url, options.browser) as session:
            result = session.confirm_login()
        print(json.dumps({**result, "sessionClosed": True, "clientGenerated": False}))
        return 0
    except KeyboardInterrupt:
        print("Login cancelled. The temporary browser session was closed.", file=sys.stderr)
        return 130
    except LoginError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception:
        print("Login failed. Run the command again to start a fresh session.", file=sys.stderr)
        return 1


def entrypoint():
    sys.exit(main())


if __name__ == "__main__":
    entrypoint()
