/**
 * Gemini API call for the agent loop (OpsAgents.runAgent takes this as callModel).
 * The key lives in Script Properties (GEMINI_API_KEY), never in code, logs or the repo.
 * DEMO DATA project (fictional brand).
 *
 * Model choice: GEMINI_MODEL in Script Properties if set. Otherwise the script asks the API which
 * models this key can use (models.list), picks the newest stable "flash" model
 * (OpsAgents.pickModel) and saves it. If that model later returns 404 (retired), it picks again.
 */
var GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/';

function geminiKey_() {
  var key = props_().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('Set GEMINI_API_KEY in Project Settings > Script Properties.');
  return key;
}

/** Lists models that support generateContent for this key and saves the best flash model. */
function pickGeminiModel_(exclude) {
  var res = UrlFetchApp.fetch(GEMINI_BASE + 'models?pageSize=200', {
    headers: { 'x-goog-api-key': geminiKey_() },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Could not list Gemini models (HTTP ' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 300));
  }
  var names = (JSON.parse(res.getContentText()).models || [])
    .filter(function (m) {
      return (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1;
    })
    .map(function (m) {
      return String(m.name).replace(/^models\//, '');
    })
    .filter(function (n) {
      return n !== exclude;
    });
  var pick = OpsAgents.pickModel(names);
  if (!pick) throw new Error('No Gemini model with generateContent is available to this key.');
  props_().setProperty('GEMINI_MODEL', pick);
  return pick;
}

function geminiModel_() {
  return props_().getProperty('GEMINI_MODEL') || pickGeminiModel_();
}

function callGemini_(request) {
  var key = geminiKey_();
  var model = geminiModel_();
  var repicked = false;
  for (var attempt = 0; attempt < 5; attempt++) {
    var res = UrlFetchApp.fetch(GEMINI_BASE + 'models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(request),
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    if (code === 200) return JSON.parse(res.getContentText());
    if (code === 404 && !repicked) {
      model = pickGeminiModel_(model); // model retired or not available to this key: choose again once
      repicked = true;
      continue;
    }
    if (code === 429 || code >= 500) {
      Utilities.sleep(Math.pow(2, attempt) * 2000); // free tier is rate-limited; back off and retry
      continue;
    }
    throw new Error('Gemini (' + model + ') HTTP ' + code + ': ' + res.getContentText().slice(0, 500));
  }
  throw new Error('Gemini (' + model + ') is still busy or rate-limited after 5 tries (free tier). Try again in a minute.');
}
