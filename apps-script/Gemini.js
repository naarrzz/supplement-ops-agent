/**
 * Gemini API call for the agent loop (OpsAgents.runAgent takes this as callModel).
 * The key lives in Script Properties (GEMINI_API_KEY), never in code, logs or the repo.
 * DEMO DATA project (fictional brand).
 *
 * Model choice: GEMINI_MODEL in Script Properties if set. Otherwise the script asks the API which
 * models this key can use (models.list), picks the newest stable "flash" model
 * (OpsAgents.pickModel) and saves it. If that model is retired or overloaded, it switches (see callGemini_).
 */
var GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/';

function geminiKey_() {
  var key = props_().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('Set GEMINI_API_KEY in Project Settings > Script Properties.');
  return key;
}

/**
 * Lists models that support generateContent for this key and saves the best flash model,
 * skipping any model in `exclude` (ones that just failed).
 */
function pickGeminiModel_(exclude) {
  exclude = [].concat(exclude || []);
  var res = UrlFetchApp.fetch(GEMINI_BASE + 'models?pageSize=200', {
    headers: { 'x-goog-api-key': geminiKey_() },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Could not list Gemini models (HTTP ' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 300));
  }
  var all = (JSON.parse(res.getContentText()).models || [])
    .filter(function (m) {
      return (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1;
    })
    .map(function (m) {
      return String(m.name).replace(/^models\//, '');
    });
  var names = all.filter(function (n) {
    return exclude.indexOf(n) === -1;
  });
  var pick = OpsAgents.pickModel(names);
  console.log('Gemini models (' + all.length + '): ' + all.join(', ').slice(0, 800) + ' | skipping: ' + (exclude.join(', ') || 'none') + ' | picked: ' + pick);
  if (!pick) throw new Error('No other Gemini model with generateContent is available to this key.');
  props_().setProperty('GEMINI_MODEL', pick);
  return pick;
}

function geminiModel_() {
  return props_().getProperty('GEMINI_MODEL') || pickGeminiModel_();
}

var GEMINI_MAX_MODELS = 3; // how many different models to try before giving up

/**
 * One generateContent call. A model that is unavailable (404) or overloaded (500/503/504) is not
 * retried: the script switches to the next best available model (up to 3) and saves the one that
 * works. 429 (rate limit) waits once, then also switches, since free-tier quotas are per model.
 */
function callGemini_(request) {
  var key = geminiKey_();
  var model = geminiModel_();
  var tried = [model];
  var waited429 = false;
  for (var attempt = 0; attempt < 6; attempt++) {
    var t0 = Date.now();
    console.log('Gemini call: model ' + model + ', attempt ' + (attempt + 1) + ', ' + JSON.stringify(request).length + ' chars');
    var res = UrlFetchApp.fetch(GEMINI_BASE + 'models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(request),
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    console.log('Gemini HTTP ' + code + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
    if (code === 200) return JSON.parse(res.getContentText());
    if (code === 429 && !waited429) {
      waited429 = true;
      Utilities.sleep(5000);
      continue;
    }
    if ([404, 429, 500, 503, 504].indexOf(code) !== -1) {
      if (tried.length >= GEMINI_MAX_MODELS) {
        throw new Error('Gemini is unavailable right now (HTTP ' + code + ' from ' + tried.join(', ') + '). This is on Google\'s side; try again later.');
      }
      model = pickGeminiModel_(tried);
      tried.push(model);
      waited429 = false;
      continue;
    }
    throw new Error('Gemini (' + model + ') HTTP ' + code + ': ' + res.getContentText().slice(0, 500));
  }
  throw new Error('Gemini did not answer after ' + tried.length + ' model(s): ' + tried.join(', ') + '.');
}

var GEMINI_BENCH_BUDGET_MS = 5 * 60 * 1000; // menu runs also stop at 6 minutes

/**
 * Menu: times one tiny call on each candidate flash model (lite included) and saves the fastest
 * one that answered as GEMINI_MODEL. Use it when agent runs hit the 6-minute limit.
 */
function menuBenchmarkGemini() {
  var start = Date.now();
  var key = geminiKey_();
  var res = UrlFetchApp.fetch(GEMINI_BASE + 'models?pageSize=200', { headers: { 'x-goog-api-key': key }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    alert_('Gemini benchmark', 'Could not list models (HTTP ' + res.getResponseCode() + ').');
    return;
  }
  var names = (JSON.parse(res.getContentText()).models || [])
    .filter(function (m) {
      return (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1;
    })
    .map(function (m) {
      return String(m.name).replace(/^models\//, '');
    });
  var current = props_().getProperty('GEMINI_MODEL');
  var candidates = OpsAgents.benchmarkCandidates(names, current, 6);
  var rows = [];
  var slowest = 30000;
  candidates.forEach(function (model) {
    if (Date.now() + slowest > start + GEMINI_BENCH_BUDGET_MS) {
      rows.push({ model: model, note: 'skipped (time)' });
      return;
    }
    var t0 = Date.now();
    var r = UrlFetchApp.fetch(GEMINI_BASE + 'models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }] }),
      muteHttpExceptions: true,
    });
    var ms = Date.now() - t0;
    if (ms > slowest) slowest = ms;
    rows.push({ model: model, code: r.getResponseCode(), seconds: Math.round(ms / 100) / 10 });
    console.log('Benchmark ' + model + ': HTTP ' + r.getResponseCode() + ' in ' + (ms / 1000).toFixed(1) + ' s');
  });
  var ok = rows
    .filter(function (r) {
      return r.code === 200;
    })
    .sort(function (a, b) {
      return a.seconds - b.seconds;
    });
  if (ok.length) props_().setProperty('GEMINI_MODEL', ok[0].model);
  alert_(
    'Gemini benchmark',
    rows
      .map(function (r) {
        return r.model + (r.note ? ': ' + r.note : ': HTTP ' + r.code + ', ' + r.seconds + ' s') + (r.model === current ? ' (was current)' : '');
      })
      .join('\n') + '\n\n' + (ok.length ? 'Saved GEMINI_MODEL = ' + ok[0].model : 'No model answered; GEMINI_MODEL unchanged.'),
  );
}

/** Menu: one tiny Gemini call, to check the key, the model and the speed. */
function menuTestGemini() {
  var t0 = Date.now();
  try {
    var res = callGemini_({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }] });
    var text = OpsAgents.textOf(res);
    alert_('Gemini test', 'Model: ' + props_().getProperty('GEMINI_MODEL') + '\nReply: ' + text.slice(0, 100) +
      '\nTime: ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  } catch (e) {
    alert_('Gemini test', 'Failed after ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s: ' + String(e.message || e).slice(0, 600));
  }
}
