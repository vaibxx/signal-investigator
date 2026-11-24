# Signal Investigator

A bounded, tool-using agent for investigating a drop in an AI product’s evaluation pass rate. Did answer quality fall within a segment, or did the release receive a harder mix of questions?

## Reproduce a run

Requires Python 3.9+. The offline planner and the test suite use the standard library.

```sh
python investigate.py --scenario traffic-shift
python -m unittest -v
```

The traffic-shift example falls from 86% to 54%. Lookup questions still pass 90% of the time and summaries still pass 50% of the time. Reweighting the old rates using the new traffic mix accounts for the full 32 percentage-point drop.

## Run the agent with a model

The [recorded Gemini run](examples/gemini-traffic-shift.json) shows each selected action, its measured evidence and the verdict. To reproduce it, configure `SIGNAL_API_KEY` privately and run:

```sh
python investigate.py --model gemini-3.5-flash-lite --endpoint https://generativelanguage.googleapis.com/v1beta/openai/chat/completions --scenario traffic-shift
```

For a local model, start a local server that supports the chat completions API, and supply the model identifier it serves:

```sh
python investigate.py --model YOUR_MODEL --endpoint http://localhost:11434/v1/chat/completions --scenario mixed-change
```

For a hosted endpoint, configure its HTTPS URL and set `SIGNAL_API_KEY` in your environment. The planner receives segment labels, aggregate evidence and available action names. Each turn it chooses one action. The host checks the choice, runs a local measurement and returns the observation for the next turn. The offline planner makes deterministic choices using the same tool loop.

## Tools and stopping rules

| Action | Evidence |
| --- | --- |
| score | Overall pass rates and sample sizes across two windows |
| segments | Per-segment pass rates and current sample volume |
| mix | Counterfactual pass rate using old segment rates and new volume weights |
| finish | Verdict assembled from the collected measurements |

A drop of at least three percentage points triggers the detailed investigation. The agent must collect both segment and mix evidence before closing such an alert. Runs stop after at most four actions. Repeated, unknown, and premature actions fail explicitly. The tests exercise the HTTP model interface using a scripted endpoint and verify an alternative tool order.

## Bring evaluation counts

Save a JSON file with one key per segment. Each pair is `[[before successes, before total], [after successes, after total]]`:

```json
{"lookup": [[81, 90], [9, 10]], "summary": [[5, 10], [45, 90]]}
```

```sh
python investigate.py --input counts.json
```

Built-in scenarios include a within-segment regression, a traffic shift, a mixed decline, and a release below the alert threshold. The decomposition is descriptive. It assumes comparable segment definitions in both windows and positive sample counts. It does not estimate statistical significance or establish a causal explanation.
