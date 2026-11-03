"""ui/tokens.py reads web/src/styles/tokens.css instead of keeping its own copy."""

import ast
from pathlib import Path

from ui import tokens as T


def test_reads_the_root_block_of_tokens_css():
    assert len(T.TOKENS) > 80
    assert T.COLOR_ACCENT == T.TOKENS["--sx-accent"] == "#ff3b1f"
    # A comment after the declaration is not part of the value.
    assert T.TOKENS["--sx-ink-3"] == "#8e959e"
    # The 640px media query redefines this inside a second :root; the base value wins.
    assert T.TOKENS["--sx-header-h"] == "64px"


def test_every_constant_comes_from_a_token():
    allowed = set(T.TOKENS.values()) | {v.split()[0] for v in T.TOKENS.values()}
    names = [n for n in vars(T) if n.isupper() and not n.startswith("_") and n != "TOKENS"]
    assert len(names) >= 35
    for name in names:
        assert getattr(T, name) in allowed, name


def test_holds_no_hand_kept_values():
    tree = ast.parse(Path(T.__file__).read_text(encoding="utf-8"))
    assigned = [n for n in tree.body if isinstance(n, ast.Assign) and n.targets[0].id[0].isalpha()]
    assert len(assigned) >= 35
    for node in assigned:
        if node.targets[0].id != "TOKENS":
            assert ast.unparse(node.value).startswith("TOKENS["), node.targets[0].id
