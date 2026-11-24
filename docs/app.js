// Signal Investigator (web). The engine is a port of investigate.py (see engine.js and
// tests/web_parity.mjs). The Gemini key lives only in `apiKey`: never stored, only sent to Google.
import { ACTIONS, GuardrailError, SCENARIOS, TOOL_DESCRIPTIONS, investigate, nextRequired, plannerPrompt, validate } from './engine.js';

const MODEL = 'gemini-3.5-flash-lite';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

let apiKey = null;
let running = false;
let rows = [];

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pts = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(1)} pts`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- counts table ---------------- */
const PRESETS = [
  ['traffic-shift', 'Traffic shift'],
  ['retrieval-regression', 'Real regression'],
  ['mixed-change', 'Mixed change'],
  ['quiet-release', 'Quiet release']
];

function loadData(data) {
  rows = Object.entries(data).map(([name, [[bp, bt], [ap, at]]]) => ({ name, bp, bt, ap, at }));
  renderRows();
}

function toData() {
  const data = {};
  for (const r of rows) data[r.name.trim()] = [[r.bp, r.bt], [r.ap, r.at]];
  return data;
}

function renderRows() {
  const tb = $('#rows');
  tb.innerHTML = rows.map((r, i) => `
    <tr data-i="${i}">
      <td><input class="name" data-k="name" value="${esc(r.name)}" aria-label="Segment name" /></td>
      <td><input data-k="bp" inputmode="numeric" value="${r.bp}" aria-label="Before passed" /></td>
      <td><input data-k="bt" inputmode="numeric" value="${r.bt}" aria-label="Before total" /><span class="rate"></span></td>
      <td><input data-k="ap" inputmode="numeric" value="${r.ap}" aria-label="After passed" /></td>
      <td><input data-k="at" inputmode="numeric" value="${r.at}" aria-label="After total" /><span class="rate"></span></td>
      <td><button class="del" type="button" aria-label="Remove segment" title="Remove">✕</button></td>
    </tr>`).join('');
  refresh();
}

function refresh() {
  const trs = [...document.querySelectorAll('#rows tr')];
  rows.forEach((r, i) => {
    const tr = trs[i];
    if (!tr) return;
    const okB = Number.isInteger(r.bp) && Number.isInteger(r.bt) && r.bt > 0 && r.bp >= 0 && r.bp <= r.bt;
    const okA = Number.isInteger(r.ap) && Number.isInteger(r.at) && r.at > 0 && r.ap >= 0 && r.ap <= r.at;
    tr.querySelector('[data-k="bp"]').classList.toggle('bad', !okB);
    tr.querySelector('[data-k="bt"]').classList.toggle('bad', !okB);
    tr.querySelector('[data-k="ap"]').classList.toggle('bad', !okA);
    tr.querySelector('[data-k="at"]').classList.toggle('bad', !okA);
    tr.querySelector('[data-k="name"]').classList.toggle('bad', !r.name.trim());
    const rates = tr.querySelectorAll('.rate');
    rates[0].textContent = okB ? pct(r.bp / r.bt) : '';
    rates[1].textContent = okA ? pct(r.ap / r.at) : '';
  });
  const pill = $('#overall');
  try {
    const data = toData();
    if (Object.keys(data).length !== rows.length) throw new Error('duplicate names');
    validate(data);
    const t = [0, 1].map((k) => rows.reduce((s, r) => s + (k ? r.at : r.bt), 0));
    const p = [0, 1].map((k) => rows.reduce((s, r) => s + (k ? r.ap : r.bp), 0));
    const before = p[0] / t[0], after = p[1] / t[1];
    pill.textContent = `${pct(before)} → ${pct(after)}`;
    pill.className = `pill ${after < before - 1e-12 ? 'down' : 'ok'}`;
  } catch {
    pill.textContent = 'check counts';
    pill.className = 'pill down';
  }
  $('#json').value = JSON.stringify(toData());
}

$('#rows').addEventListener('input', (e) => {
  const input = e.target.closest('input');
  if (!input) return;
  const r = rows[+input.closest('tr').dataset.i];
  const k = input.dataset.k;
  r[k] = k === 'name' ? input.value : input.value.trim() === '' ? NaN : Number(input.value);
  document.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
  refresh();
});
$('#rows').addEventListener('click', (e) => {
  if (!e.target.closest('.del') || rows.length <= 1) return;
  rows.splice(+e.target.closest('tr').dataset.i, 1);
  renderRows();
});
$('#add-row').addEventListener('click', () => {
  let n = rows.length + 1;
  while (rows.some((r) => r.name === `segment-${n}`)) n++;
  rows.push({ name: `segment-${n}`, bp: 40, bt: 50, ap: 40, at: 50 });
  renderRows();
});
$('#toggle-json').addEventListener('click', () => { $('#json-box').hidden = !$('#json-box').hidden; });
$('#apply-json').addEventListener('click', () => {
  try {
    const data = JSON.parse($('#json').value);
    validate(data);
    loadData(data);
    $('#json-msg').textContent = 'Loaded.';
  } catch (e) {
    $('#json-msg').textContent = e.message;
  }
});

$('#presets').innerHTML = PRESETS.map(([id, label]) => `<button class="chip" type="button" data-id="${id}">${label}</button>`).join('');
$('#presets').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b));
  loadData(structuredClone(SCENARIOS[b.dataset.id]));
});

/* ---------------- planner + key ---------------- */
const planner = () => document.querySelector('input[name="planner"]:checked').value;
document.querySelectorAll('input[name="planner"]').forEach((r) => r.addEventListener('change', () => {
  $('#key-area').hidden = planner() !== 'gemini';
  updatePlannerPill();
}));
function updatePlannerPill() {
  const pill = $('#planner-pill');
  if (planner() === 'offline') { pill.textContent = 'Built-in'; pill.className = 'pill'; return; }
  pill.textContent = apiKey ? 'Gemini · key in memory' : 'Gemini · needs key';
  pill.className = `pill ${apiKey ? 'ok' : 'down'}`;
}
$('#key-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#key-input').value.trim();
  $('#key-input').value = '';
  if (!v) return;
  apiKey = v;
  $('#key-input').placeholder = 'Key set. Paste a new one to replace it';
  updatePlannerPill();
});

async function geminiChoose(seen, remaining) {
  const prompt = plannerPrompt(seen, remaining);
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: 'Choose one remaining action. Respond only with a JSON object with string key action.' }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(prompt) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: { type: 'OBJECT', properties: { action: { type: 'STRING', enum: ACTIONS } }, required: ['action'] }
      }
    })
  });
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error?.message || ''; } catch { /* not json */ }
    if (res.status === 400 && /api key/i.test(msg)) throw new Error('Google rejected this API key. Check it and set it again.');
    if (res.status === 403) throw new Error('This key is not allowed to use the Gemini API. Enable it in Google AI Studio.');
    if (res.status === 429) throw new Error('Your key hit its rate limit. Wait a minute and try again.');
    if (res.status === 404) throw new Error(`The model ${MODEL} is not available for this key.`);
    throw new Error(msg || `Gemini returned an error (${res.status}).`);
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  lastPrompt = prompt;
  return JSON.parse(text).action;
}
let lastPrompt = null;

/* ---------------- timeline rendering ---------------- */
let stepNo = 0;
function addStep(html, cls = '') {
  $('#empty')?.remove();
  const el = document.createElement('div');
  el.className = `step ${cls}`;
  el.innerHTML = `<div class="dot">${cls.includes('final') ? '✓' : ++stepNo}</div><div class="body">${html}</div>`;
  $('#timeline').append(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return el;
}
function thinking(label) {
  $('#empty')?.remove();
  const el = document.createElement('div');
  el.className = 'step thinking';
  el.innerHTML = `<div class="dot">…</div><div class="body"><span class="spin"></span>${esc(label)}</div>`;
  $('#timeline').append(el);
  return el;
}
const sawBlock = (prompt) => prompt
  ? `<details class="saw"><summary>What the model saw</summary><pre>${esc(JSON.stringify(prompt, null, 2))}</pre></details>`
  : '';

function renderStep(action, evidence, data, chooser, prompt) {
  const who = `<small>${chooser === 'gemini' ? 'Gemini chose' : 'Built-in planner chose'}</small>`;
  if (action === 'score') {
    const material = evidence.delta <= -0.03 + 1e-12;
    const why = material
      ? `A ${pts(evidence.delta)} change is past the 3-point alert threshold, so the agent has to explain it.`
      : `A ${pts(evidence.delta)} change is under the 3-point alert threshold, so the alert can close.`;
    return addStep(`
      <h3><code>score</code> Overall pass rate ${who}</h3>
      <div class="scorebox">
        <div class="big"><small>Before · n=${evidence.sample_sizes[0]}</small>${pct(evidence.before)}</div>
        <div class="arrow">→</div>
        <div class="big"><small>After · n=${evidence.sample_sizes[1]}</small>${pct(evidence.after)}</div>
        <span class="delta ${evidence.delta < 0 ? 'down' : 'up'}">${pts(evidence.delta)}</span>
      </div>
      <p class="why">${why}</p>${sawBlock(prompt)}`);
  }
  if (action === 'segments') {
    const tb = Object.values(data).reduce((s, p) => s + p[0][1], 0);
    const ta = Object.values(data).reduce((s, p) => s + p[1][1], 0);
    const changes = Object.entries(evidence).map(([n, e]) => [n, e.after - e.before]).sort((a, b) => a[1] - b[1]);
    const worst = changes[0];
    const steady = changes.every(([, d]) => Math.abs(d) < 0.03);
    const why = steady
      ? 'Every segment kept roughly the same pass rate. Watch how the traffic share moved instead.'
      : `Biggest change inside a segment: ${esc(worst[0])} (${pts(worst[1])}).`;
    const el = addStep(`
      <h3><code>segments</code> Pass rate inside each segment ${who}</h3>
      <div class="segs">${Object.entries(evidence).map(([n, e]) => `
        <div class="seg-row">
          <div class="name">${esc(n)} <span>traffic share ${pct(data[n][0][1] / tb)} → ${pct(e.after_count / ta)}</span></div>
          <div class="bars">
            <span>before</span><div class="bar b"><i data-w="${e.before}"></i></div><span class="v">${pct(e.before)}</span>
            <span>after</span><div class="bar a"><i data-w="${e.after}"></i></div><span class="v">${pct(e.after)}</span>
          </div>
        </div>`).join('')}
      </div>
      <p class="why">${why}</p>${sawBlock(prompt)}`);
    requestAnimationFrame(() => requestAnimationFrame(() => el.querySelectorAll('.bar i').forEach((i) => (i.style.width = `${i.dataset.w * 100}%`))));
    return el;
  }
  if (action === 'mix') {
    const before = evidence.old_rates_at_new_weights - evidence.mix_effect;
    const after = evidence.old_rates_at_new_weights + evidence.within_effect;
    return addStep(`
      <h3><code>mix</code> What if only the traffic mix had changed? ${who}</h3>
      ${waterfall(before, evidence.mix_effect, evidence.within_effect, after)}
      <p class="why">Old segment rates at the new traffic mix would score <b>${pct(evidence.old_rates_at_new_weights)}</b>.
      The mix change accounts for <b>${pts(evidence.mix_effect)}</b> and changes inside segments for <b>${pts(evidence.within_effect)}</b>.</p>${sawBlock(prompt)}`);
  }
  return null;
}

function waterfall(before, mix, within, after) {
  const W = 640, H = 230, top = 22, base = 190, left = 40;
  const max = Math.min(1, Math.max(before, after, before + mix, 0.05) * 1.12);
  const y = (v) => base - (v / max) * (base - top);
  const bw = 92, gap = (W - left - 4 * bw) / 4;
  const bars = [
    ['Before', 0, before, 'var(--before)', pct(before)],
    ['Mix effect', before, before + mix, mix < 0 ? '#ff9a4d' : 'var(--good)', pts(mix)],
    ['Inside segments', before + mix, before + mix + within, within < 0 ? 'var(--bad)' : 'var(--good)', pts(within)],
    ['After', 0, after, 'url(#wf-grad)', pct(after)]
  ];
  const rects = bars.map(([label, a, b, fill, val], i) => {
    const x = left + i * (bw + gap) + gap / 2;
    const y1 = y(Math.max(a, b)), h = Math.max(2, Math.abs(y(a) - y(b)));
    const conn = i < 3 ? `<line x1="${x + bw}" x2="${x + bw + gap}" y1="${y(b)}" y2="${y(b)}" stroke="rgba(255,240,220,0.25)" stroke-dasharray="3 3"/>` : '';
    return `<rect x="${x}" y="${y1}" width="${bw}" height="${h}" rx="5" fill="${fill}"><animate attributeName="height" from="0" to="${h}" dur="0.7s" fill="freeze"/></rect>${conn}
      <text class="val" x="${x + bw / 2}" y="${y1 - 7}" text-anchor="middle">${val}</text>
      <text x="${x + bw / 2}" y="${base + 18}" text-anchor="middle">${label}</text>`;
  }).join('');
  return `<svg class="waterfall" viewBox="0 0 ${W} ${H + 6}" role="img" aria-label="Waterfall from before to after pass rate">
    <defs><linearGradient id="wf-grad" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ffb800"/><stop offset="1" stop-color="#ff5a1f"/></linearGradient></defs>
    <line x1="${left - 6}" x2="${W}" y1="${base}" y2="${base}" stroke="rgba(255,240,220,0.15)"/>
    <text x="${left - 10}" y="${y(max) + 4}" text-anchor="end">${pct(max)}</text><text x="${left - 10}" y="${base + 4}" text-anchor="end">0%</text>
    ${rects}</svg>`;
}

function renderVerdict(v, seen, data) {
  const s = seen.score, m = seen.mix;
  let cls, tag, title, text;
  if (v === 'below-alert-threshold') {
    [cls, tag, title] = ['quiet', 'No alert', 'Within normal range'];
    text = `The pass rate moved ${pts(s.delta)}, under the 3-point alert threshold. Nothing to investigate.`;
  } else if (v === 'traffic-mix-shift') {
    [cls, tag, title] = ['mix', 'Not a model regression', 'The question mix changed, not the model'];
    text = `Segment pass rates held up. Re-weighting the old rates with the new traffic gives ${pct(m.old_rates_at_new_weights)}, which accounts for the ${pts(s.delta)} change. Look at what changed in incoming traffic before touching the model.`;
  } else if (v === 'within-segment-decline') {
    const worst = Object.entries(seen.segments).sort((a, b) => (a[1].after - a[1].before) - (b[1].after - b[1].before))[0];
    [cls, tag, title] = ['regress', 'Real regression', 'The model got worse inside segments'];
    text = `The traffic mix explains ${pts(m.mix_effect)}; the decline happens inside segments (${pts(m.within_effect)}). Start with ${worst[0]}, which went from ${pct(worst[1].before)} to ${pct(worst[1].after)}.`;
  } else {
    [cls, tag, title] = ['both', 'Mixed decline', 'Harder traffic and a real regression'];
    text = `Of the ${pts(s.delta)} change, the traffic mix explains ${pts(m.mix_effect)} and declines inside segments explain ${pts(m.within_effect)}. Both need attention.`;
  }
  addStep(`<div class="verdict ${cls}"><span class="tag">${tag}</span><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`, 'final');
}

/* ---------------- run ---------------- */
$('#run').addEventListener('click', async () => {
  if (running) return;
  let data;
  try {
    data = toData();
    if (Object.keys(data).length !== rows.length) throw new Error('Segment names must be unique.');
    validate(data);
  } catch (e) {
    $('#timeline').innerHTML = '';
    stepNo = 0;
    addStep(`<div class="blocked"><b>Check your counts</b>${esc(e.message)}</div>`);
    return;
  }
  const mode = planner();
  if (mode === 'gemini' && !apiKey) {
    $('#key-input').focus();
    updatePlannerPill();
    return;
  }

  running = true;
  $('#run').disabled = true;
  $('#timeline').innerHTML = '';
  stepNo = 0;
  let pending = null;

  const choose = async (seen, remaining) => {
    pending = thinking(mode === 'gemini' ? `Gemini is choosing the next tool from: ${[...remaining].join(', ')}` : 'Choosing the next tool…');
    lastPrompt = null;
    try {
      if (mode === 'gemini') return await geminiChoose(seen, remaining);
      await sleep(650);
      return nextRequired(seen);
    } finally {
      await sleep(mode === 'gemini' ? 250 : 0);
    }
  };

  try {
    await investigate(data, choose, (step) => {
      pending?.remove();
      pending = null;
      if (step.action === 'finish') renderVerdict(step.verdict, step.seen, data);
      else renderStep(step.action, step.evidence, data, mode, lastPrompt);
    });
  } catch (e) {
    pending?.remove();
    if (e instanceof GuardrailError) {
      addStep(`<div class="blocked"><b>Guardrail stopped the agent</b>${esc(e.message)}. The agent must follow the evidence rules, so the run ends without a verdict.</div>`);
    } else {
      addStep(`<div class="blocked"><b>Could not finish</b>${esc(e.message || String(e))}</div>`);
    }
  } finally {
    running = false;
    $('#run').disabled = false;
  }
});

// start with the most interesting case
document.querySelector('.chip[data-id="traffic-shift"]').classList.add('on');
loadData(structuredClone(SCENARIOS['traffic-shift']));
