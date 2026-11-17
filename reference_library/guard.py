"""Which requests the library routes answer: this computer only, another machine (read-only), or refused."""
import ipaddress
import urllib.parse

from aiohttp import web

async def _json_body(request):
    try:
        body = await request.json()
        return body if isinstance(body, dict) else {}
    except Exception:
        return {}


def _loopback(host):
    host = (host or "").strip("[]").removeprefix("::ffff:").lower()
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _same_origin(origin, host):
    """True if an Origin header ("http://127.0.0.1:8188") names the host and port the request was sent
    to (its Host header). "null" (sandboxed pages, file://) and anything unparsable are not."""
    try:
        netloc = urllib.parse.urlsplit(origin).netloc
    except ValueError:
        return False
    return bool(netloc) and netloc.lower() == (host or "").lower()


def _trust(request):
    """How far to trust a request to the library routes:
      "local"   from this computer, addressed to it by a loopback name (127.0.0.1, localhost, [::1]);
      "remote"  from another machine (ComfyUI started with --listen): may browse the library only;
      None      refused: a cross-site request, or one that arrives from this computer under another
                host name, which is what DNS rebinding (a web page whose domain points at
                127.0.0.1) and local proxies look like. ComfyUI's own origin check misses both, and
                is off entirely with --enable-cors-header. Also refused: a request from a page of
                another origin, same-site ones included (a page on another localhost port is
                "same-site" to the browser, since ports don't count for that).
    Requests without these browser headers (scripts, curl) are judged by address alone."""
    site = request.headers.get("Sec-Fetch-Site")
    if site is not None and site not in ("same-origin", "none"):
        return None
    origin = request.headers.get("Origin")
    if origin is not None and not _same_origin(origin, request.host):
        return None
    peer_local = _loopback(request.remote)
    host_local = _loopback(urllib.parse.urlsplit("//" + (request.host or "")).hostname)
    if peer_local:
        return "local" if host_local else None
    return "remote"


_LOCAL_ONLY = "Changing the library works only on the computer running ComfyUI."
_REFUSED = ("Refused: open ComfyUI at http://127.0.0.1 or http://localhost to use the Reference Library "
            "(requests through other host names or from other websites are blocked for safety).")


def _guard(handler, local=False):
    """Wraps a library route: refuses untrusted requests, and remote ones too when `local`."""
    async def guarded(request):
        trust = _trust(request)
        if trust is None:
            return web.json_response({"error": _REFUSED}, status=403)
        if local and trust != "local":
            return web.json_response({"error": _LOCAL_ONLY}, status=403)
        return await handler(request)
    guarded.__name__ = getattr(handler, "__name__", "guarded")
    return guarded
