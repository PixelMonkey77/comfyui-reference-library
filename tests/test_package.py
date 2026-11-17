"""What ComfyUI sees when it loads the pack: the node classes, the web folder and every route."""
from helpers import load_pack

ROUTES = {
    ("get", "/library_image/assets"), ("get", "/library_image/file"), ("get", "/library_image/thumb"),
    ("get", "/library_image/trusted"),
    ("post", "/library_image/browse"), ("post", "/library_image/pick"), ("post", "/library_image/slice"),
    ("post", "/library_image/add"), ("post", "/library_image/rename"), ("post", "/library_image/replace"),
    ("post", "/library_image/remove"), ("post", "/library_image/library/rename"),
    ("post", "/library_image/library/delete"), ("post", "/library_image/library/export"),
    ("post", "/library_image/library/import"),
}


def test_nodes_and_web_folder(pack):
    root = pack.root
    assert root.WEB_DIRECTORY == "./web"
    assert set(root.NODE_CLASS_MAPPINGS) == set(root.NODE_DISPLAY_NAME_MAPPINGS)
    assert {"ReferencePrompt", "ReferenceImage", "ReferenceVideo", "ReferenceAudio", "ReferenceImagesBatch",
            "TaggedPrompt", "LibraryImage", "LibraryVideo", "LibraryAudio", "LibraryImageBatch"} == set(root.NODE_CLASS_MAPPINGS)
    for name, cls in root.NODE_CLASS_MAPPINGS.items():
        assert cls.CATEGORY == "Reference Library" and callable(getattr(cls(), cls.FUNCTION)), name
        assert "required" in cls.INPUT_TYPES(), name


def test_every_route_is_registered(pack):
    assert set(pack.routes.routes.registered) == ROUTES and len(pack.routes.routes.registered) == len(ROUTES)


def test_copies_do_not_share_state(tmp_path):
    """Each loaded copy has its own modules: one "computer"'s library never shows up in another's."""
    a, b = load_pack(str(tmp_path / "a")), load_pack(str(tmp_path / "b"))
    assert a.store is not b.store and a.store._CACHE is not b.store._CACHE
    assert a.store._library_file() != b.store._library_file()
