/**
 * Gemini API call for the agent loop (OpsAgents.runAgent takes this as callModel).
 * The key lives in Script Properties (GEMINI_API_KEY), never in code, logs or the repo.
 * DEMO DATA project (fictional brand).
 */
function callGemini_(request) {
  var key = props_().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('Set GEMINI_API_KEY in Project Settings > Script Properties.');
  var model = props_().getProperty('GEMINI_MODEL') || 'gemini-2.5-flash';
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  for (var attempt = 0; attempt < 4; attempt++) {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(request),
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    if (code === 200) return JSON.parse(res.getContentText());
    if (code === 429 || code >= 500) {
      Utilities.sleep(Math.pow(2, attempt) * 2000); // free tier is rate-limited; back off and retry
      continue;
    }
    throw new Error('Gemini HTTP ' + code + ': ' + res.getContentText().slice(0, 500));
  }
  throw new Error('Gemini is still rate-limited after 4 tries (free tier). Try again in a minute.');
}
