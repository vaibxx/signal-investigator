"""Investigate changes in model answer quality from aggregated evaluation counts."""
import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

ACTIONS = {"score", "segments", "mix", "finish"}
SCENARIOS = {
    # Each pair is (successful answers, evaluated answers), before and after.
    "retrieval-regression": {"lookup": [[90, 100], [60, 100]], "summary": [[80, 100], [80, 100]]},
    "traffic-shift": {"lookup": [[81, 90], [9, 10]], "summary": [[5, 10], [45, 90]]},
    "quiet-release": {"lookup": [[90, 100], [89, 100]], "summary": [[80, 100], [80, 100]]},
    "mixed-change": {"lookup": [[81, 90], [7, 10]], "summary": [[5, 10], [36, 90]]},
}
THRESHOLD = 0.03


def validate(data):
    if not isinstance(data, dict) or not data:
        raise ValueError("Expected a nonempty object keyed by evaluation segment")
    for name, pair in data.items():
        if not name or not isinstance(pair, list) or len(pair) != 2:
            raise ValueError("Each segment needs before and after counts")
        for counts in pair:
            if not isinstance(counts, list) or len(counts) != 2:
                raise ValueError("Each count must be [successes, total]")
            passed, total = counts
            if type(total) is not int or type(passed) is not int or not 0 <= passed <= total or total == 0:
                raise ValueError("Counts require 0 <= successes <= total and total > 0")


def measure(action, data):
    totals = [sum(pair[i][1] for pair in data.values()) for i in (0, 1)]
    rates = [sum(pair[i][0] for pair in data.values()) / totals[i] for i in (0, 1)]
    if action == "score":
        return {"before": rates[0], "after": rates[1], "delta": rates[1] - rates[0], "sample_sizes": totals}
    if action == "segments":
        return {name: {"before": a / n, "after": b / m, "after_count": m}
                for name, ((a, n), (b, m)) in data.items()}
    counterfactual = sum((a / n) * (m / totals[1]) for (a, n), (_, m) in data.values())
    return {"old_rates_at_new_weights": counterfactual,
            "mix_effect": counterfactual - rates[0], "within_effect": rates[1] - counterfactual}


def next_required(seen):
    if "score" not in seen:
        return "score"
    if seen["score"]["delta"] > -THRESHOLD + 1e-12:
        return "finish"
    for action in ("segments", "mix"):
        if action not in seen:
            return action
    return "finish"


def verdict(seen):
    if "mix" not in seen:
        return "below-alert-threshold"
    mix, within = (seen["mix"][k] for k in ("mix_effect", "within_effect"))
    if abs(mix) < 1e-10 or (within < 0 and mix >= 0):
        return "within-segment-decline"
    if abs(within) < 1e-10 or (mix < 0 and within >= 0):
        return "traffic-mix-shift"
    return "mixed-decline"


def model_action(url, model, seen, remaining):
    # Only aggregate observations and legal actions enter the model context.
    prompt = {"goal": "Investigate a release quality alert. First score; stop for a decline smaller than 3 percentage points. For a material decline inspect both segments and mix, in either order, before finishing.",
              "tool_descriptions": {"score": "overall pass rates", "segments": "rates by segment",
                                    "mix": "counterfactual attribution", "finish": "deliver grounded verdict"},
              "observations": seen, "remaining_actions": sorted(remaining)}
    body = {"model": model, "temperature": 0, "messages": [
        {"role": "system", "content": "Choose one remaining action. Respond only with a JSON object with string key action."},
        {"role": "user", "content": json.dumps(prompt)}]}
    if url == "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions":
        body["response_format"] = {"type": "json_object"}
    headers = {"Content-Type": "application/json"}
    if os.environ.get("SIGNAL_API_KEY"):
        headers["Authorization"] = "Bearer " + os.environ["SIGNAL_API_KEY"]
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    return json.loads(payload["choices"][0]["message"]["content"])["action"]


def investigate(data, choose=None):
    validate(data)
    seen, trace = {}, []
    for step in range(4):
        remaining = ACTIONS - seen.keys()
        action = choose(seen, remaining) if choose else next_required(seen)
        if not isinstance(action, str) or action not in remaining:
            raise ValueError(f"Invalid or repeated action at step {step + 1}")
        if not seen and action != "score":
            raise ValueError("First action must establish the overall score")
        if action == "finish":
            if next_required(seen) != "finish":
                raise ValueError("Insufficient evidence for a verdict")
            return {"verdict": verdict(seen), "trace": trace + [{"action": "finish"}]}
        if next_required(seen) == "finish":
            raise ValueError("Evidence budget exhausted or alert below threshold")
        seen[action] = measure(action, data)
        trace.append({"action": action, "evidence": seen[action]})
    raise ValueError("Tool budget exhausted")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--scenario", choices=SCENARIOS, default="traffic-shift")
    source.add_argument("--input", type=Path, help="JSON evaluation counts")
    parser.add_argument("--model", help="Use a chat-completions model as the planner")
    parser.add_argument("--endpoint", default="http://localhost:11434/v1/chat/completions")
    args = parser.parse_args()
    try:
        data = json.loads(args.input.read_text(encoding="utf-8")) if args.input else SCENARIOS[args.scenario]
        choose = (lambda seen, remaining: model_action(args.endpoint, args.model, seen, remaining)) if args.model else None
        print(json.dumps(investigate(data, choose), indent=2))
    except (ValueError, OSError, KeyError, TypeError, IndexError) as error:
        print(f"Investigation stopped: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
