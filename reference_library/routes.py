"""Every HTTP route of the pack, in one place, each behind the request guard."""
import asyncio

from server import PromptServer

from . import dialogs, guard, library, slices, thumbs, transfer

routes = PromptServer.instance.routes

routes.post("/library_image/browse")(guard._guard(dialogs._browse, local=True))

routes.get("/library_image/assets")(guard._guard(library._assets))

routes.post("/library_image/pick")(guard._guard(dialogs._pick, local=True))

for _route, _fn in {
    "/library_image/add": library._add,
    "/library_image/rename": library._rename,
    "/library_image/replace": library._replace,
    "/library_image/remove": library._remove,
    "/library_image/library/rename": library._lib_rename,
    "/library_image/library/delete": library._lib_delete,
}.items():
    def _make(fn):
        run = library._locked(fn)
        # Add / Replace read the new files first, outside the lock (see _probe_all).
        precheck = {library._add: lambda b: [i.get("path") for i in b.get("items") or [] if isinstance(i, dict)]
                    if isinstance(b.get("items"), list) else [],
                    library._replace: lambda b: [b.get("path")]}.get(fn)

        async def handler(request):
            body = await guard._json_body(request)
            if precheck is None:
                return await run(body)
            return await run(body, await asyncio.to_thread(library._probe_all, precheck(body)))
        return guard._guard(handler, local=True)  # every change: this computer only
    routes.post(_route)(_make(_fn))

# Both read and write files on this computer: local only.
routes.post("/library_image/library/export")(guard._guard(transfer._export_route, local=True))
routes.post("/library_image/library/import")(guard._guard(transfer._import_route, local=True))

routes.get("/library_image/file")(guard._guard(library._file))

routes.post("/library_image/slice")(guard._guard(slices._slice, local=True))  # writes a file: this computer only

routes.get("/library_image/thumb")(guard._guard(thumbs._thumb))

routes.get("/library_image/trusted")(guard._guard(library._trusted_route, local=True))
