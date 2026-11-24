# Signal Investigator

A bounded, tool-using agent for investigating a drop in an AI product’s evaluation pass rate. Did answer quality fall within a segment, or did the release receive a harder mix of questions?

### ▶ [Use it in your browser](https://vaibxx.github.io/signal-investigator/)

Enter your own before/after evaluation counts per segment (or start from a preset) and watch the agent investigate step by step: overall score, per-segment rates and traffic share, a waterfall that splits the drop into mix and within-segment effects, then a verdict. Run it with the built-in deterministic planner, or let **Gemini choose each tool** with your own API key. The key stays in the tab's memory, goes only to Google's Gemini API, and is never stored. Every Gemini step shows exactly what the model saw: aggregated rates and the legal actions, never raw records.

The browser engine ([`docs/engine.js`](docs/engine.js)) is a port of `investigate.py`. CI runs [`tests/web_parity.mjs`](tests/web_parity.mjs) on every push to check that both reach identical verdicts, evidence and errors on the built-in scenarios plus 300 random datasets.

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

## Background and references

Signal Investigator applies a few well-established ideas to LLM evaluation:

- **Rate decomposition.** E. M. Kitagawa, ["Components of a Difference Between Two Rates"](https://www.jstor.org/stable/2281213), *Journal of the American Statistical Association* 50(272), 1168–1194, 1955. Kitagawa split a change in an overall rate into a *composition* part and a *rate* part. The `mix` tool does the same for pass rates: old segment rates at the new traffic mix give the counterfactual, so `mix_effect + within_effect` equals the observed change. Signal uses the one-sided version (old rates, new weights); Kitagawa's symmetric form averages both windows.
- **Simpson's paradox.** E. H. Simpson, ["The Interpretation of Interaction in Contingency Tables"](https://doi.org/10.1111/j.2517-6161.1951.tb00088.x), *Journal of the Royal Statistical Society, Series B* 13(2), 238–241, 1951. An aggregate rate can move very differently from every segment rate. The `traffic-shift` scenario is exactly this case: both segments hold steady while the overall score falls 32 points.
- **Dataset shift.** S. Rabanser, S. Günnemann, Z. C. Lipton, ["Failing Loudly: An Empirical Study of Methods for Detecting Dataset Shift"](https://arxiv.org/abs/1810.11953), NeurIPS 2019. A change in the question mix is a form of dataset shift. Shift detectors tell you the inputs changed; Signal Investigator asks how much of a metric change that shift explains.
- **Tool-using agents.** S. Yao et al., ["ReAct: Synergizing Reasoning and Acting in Language Models"](https://arxiv.org/abs/2210.03629), ICLR 2023. The investigation is an action → observation loop in this style, deliberately bounded: a fixed tool set, a four-step budget, and evidence rules the host enforces before any verdict.
