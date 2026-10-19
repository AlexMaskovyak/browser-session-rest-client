"""Single-request HTTP worker; private request configuration is read from stdin."""

import base64
import json
import sys


def main():
    from curl_cffi import requests

    configuration = json.load(sys.stdin)
    method = configuration["method"]
    body = configuration.get("body")
    if method in {"POST", "PUT"} and configuration.get("authorizedWrite") is True:
        body = base64.b64decode(configuration["bodyBase64"], validate=True)
        if len(body) > 16 * 1024 * 1024:
            raise ValueError("Write body exceeds size limit")
    elif method == "POST":
        if (
            configuration.get("authorizedPost") is not True
            or not isinstance(body, str)
            or len(body.encode("utf-8")) > 1024 * 1024
        ):
            raise ValueError("POST request is not authorized")
        body = body.encode("utf-8")
    elif method not in {"GET", "HEAD"} or body is not None:
        raise ValueError("Unsupported method")
    response = requests.request(
        method,
        configuration["url"],
        headers=configuration["headers"],
        **({"data": body} if method in {"POST", "PUT"} else {}),
        timeout=configuration["timeout"],
        impersonate="chrome",
        default_headers=False,
        allow_redirects=False,
    )
    json.dump(
        {
            "status": response.status_code,
            "headers": list(response.headers.multi_items()),
            "url": response.url,
            "body": base64.b64encode(response.content).decode("ascii"),
        },
        sys.stdout,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(1)
