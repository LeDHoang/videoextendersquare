from datetime import datetime, timezone

from server.social.recommendations.ranking import rerank_page
from server.social.recommendations.types import Candidate, CatalogItem

NOW = datetime(2026, 11, 1, tzinfo=timezone.utc)


def _candidate(post_id, owner, score, exploration=0.0):
    item = CatalogItem(post_id, owner, (), NOW, 0, 0)
    return Candidate(item=item, final_score=score, primary_source=f"s-{post_id}", features={"exploration": exploration})


def _three_from_a():
    # Three earlier reels from creator a, then one from f so a is not back to back.
    return [_candidate(f"p{i}", "a", 1.0) for i in range(3)] + [_candidate("pf", "f", 1.0)]


def test_strong_creator_can_pass_three_when_far_ahead():
    page = rerank_page([_candidate("a3", "a", 10.0), _candidate("b0", "b", 0.1)], 1, explore=False, preselected=_three_from_a())
    assert [candidate.item.post_id for candidate in page] == ["a3"]


def test_creator_overflow_penalty_is_stronger_past_two():
    # 3.0 - 0.45*3 = 1.65 would beat 1.4; the overflow penalty pushes the 4th reel below it.
    page = rerank_page([_candidate("a3", "a", 3.0), _candidate("b0", "b", 1.4)], 1, explore=False, preselected=_three_from_a())
    assert [candidate.item.post_id for candidate in page] == ["b0"]


def test_seed_owner_skips_overflow_penalty():
    page = rerank_page(
        [_candidate("a3", "a", 3.0), _candidate("b0", "b", 1.4)],
        1,
        explore=False,
        preselected=_three_from_a(),
        seed_owner="a",
    )
    assert [candidate.item.post_id for candidate in page] == ["a3"]


def test_exploration_swap_avoids_back_to_back_creator():
    picks = [_candidate("x0", "x", 5.0), _candidate("y0", "y", 4.0), _candidate("z0", "z", 3.0)]
    same_as_prev = _candidate("y1", "y", 0.1, exploration=0.9)
    fresh = _candidate("w0", "w", 0.05, exploration=0.9)
    page = rerank_page(picks + [same_as_prev, fresh], 3)
    owners = [candidate.item.owner_id for candidate in page]
    assert page[-1].item.post_id == "w0"
    assert all(left != right for left, right in zip(owners, owners[1:]))


def test_exploration_swap_checks_preselected_on_one_item_page():
    pinned = _candidate("p0", "y", 9.0)
    pick = _candidate("x0", "x", 5.0)
    same_as_pinned = _candidate("y1", "y", 0.1, exploration=0.9)
    fresh = _candidate("w0", "w", 0.05, exploration=0.9)
    page = rerank_page([pick, same_as_pinned, fresh], 1, preselected=[pinned])
    assert [candidate.item.post_id for candidate in page] == ["w0"]
