/**
 * OpsAgents: the agent loop (Gemini function calling + structured JSON output) and guardrails.
 * DEMO DATA project (fictional brand).
 *
 * The model is injected as callModel(request) -> Gemini generateContent response, so:
 *   - in Apps Script it is a UrlFetchApp call to the Gemini API (see apps-script/Gemini.js)
 *   - in tests it is a scripted fake, so the loop, tool routing and guardrails run without a key.
 * Depends on OpsTools (and the generated OPS_* constants for defaults).
 */
var OpsAgents = (function () {
  var AGENTS = {
    steward: { prompt: 'data_steward', tools: ['list_rejected'], output: 'steward' },
    analyst: {
      prompt: 'inventory_analyst',
      tools: ['list_low_cover', 'get_stock', 'get_sales', 'get_lead_time', 'list_dead_stock'],
      output: 'analyst',
    },
    writer: { prompt: 'report_writer', tools: ['get_week_summary'], output: 'writer' },
  };
  // Agents only get read-only tools. Writing (save_approval) is done by code after guardrails.

  var GEMINI_KEYS = { type: 1, description: 1, properties: 1, items: 1, required: 1, enum: 1, nullable: 1, minimum: 1, maximum: 1 };

  /** JSON Schema (lowercase types) -> Gemini Schema (uppercase types, supported keys only). */
  function toGeminiSchema(s) {
    if (Array.isArray(s)) return s.map(toGeminiSchema);
    if (!s || typeof s !== 'object') return s;
    var out = {};
    Object.keys(s).forEach(function (k) {
      if (!GEMINI_KEYS[k]) return;
      var v = s[k];
      if (k === 'type') out.type = String(v).toUpperCase();
      else if (k === 'properties') {
        out.properties = {};
        Object.keys(v).forEach(function (p) {
          out.properties[p] = toGeminiSchema(v[p]);
        });
      } else if (k === 'items') out.items = toGeminiSchema(v);
      else out[k] = v;
    });
    return out;
  }

  /** Small JSON Schema check (type, required, enum, min/max) used on model output. Returns problem strings. */
  function check(value, schema, path) {
    path = path || '$';
    var problems = [];
    if (!schema) return problems;
    var t = schema.type;
    var isInt = typeof value === 'number' && Math.floor(value) === value;
    var ok =
      (t === 'object' && value && typeof value === 'object' && !Array.isArray(value)) ||
      (t === 'array' && Array.isArray(value)) ||
      (t === 'string' && typeof value === 'string') ||
      (t === 'number' && typeof value === 'number') ||
      (t === 'integer' && isInt) ||
      (t === 'boolean' && typeof value === 'boolean') ||
      !t;
    if (!ok) return [path + ' should be ' + t];
    if (schema.enum && schema.enum.indexOf(value) === -1) problems.push(path + ' not in ' + schema.enum.join('/'));
    if (typeof value === 'number') {
      if (schema.minimum != null && value < schema.minimum) problems.push(path + ' below ' + schema.minimum);
      if (schema.maximum != null && value > schema.maximum) problems.push(path + ' above ' + schema.maximum);
    }
    if (t === 'object') {
      (schema.required || []).forEach(function (k) {
        if (value[k] === undefined) problems.push(path + '.' + k + ' is missing');
      });
      Object.keys(schema.properties || {}).forEach(function (k) {
        if (value[k] !== undefined) problems = problems.concat(check(value[k], schema.properties[k], path + '.' + k));
      });
    }
    if (t === 'array') {
      value.forEach(function (v, i) {
        problems = problems.concat(check(v, schema.items, path + '[' + i + ']'));
      });
    }
    return problems;
  }

  function jsonCopy(x) {
    return JSON.parse(JSON.stringify(x));
  }

  function preview(x) {
    var s = JSON.stringify(x);
    return s.length > 300 ? s.slice(0, 300) + '...' : s;
  }

  function firstContent(res) {
    var c = res && res.candidates && res.candidates[0] && res.candidates[0].content;
    return c && c.parts ? c : { role: 'model', parts: [] };
  }

  function textOf(res) {
    return firstContent(res)
      .parts.filter(function (p) {
        return typeof p.text === 'string';
      })
      .map(function (p) {
        return p.text;
      })
      .join('');
  }

  function addUsage(usage, res) {
    var u = (res && res.usageMetadata) || {};
    usage.model_calls++;
    usage.prompt_tokens += u.promptTokenCount || 0;
    usage.output_tokens += u.candidatesTokenCount || 0;
    usage.total_tokens += u.totalTokenCount || 0;
  }

  function defaults(name) {
    // Generated.js defines these in Apps Script and in the Node vm context.
    if (name === 'schemas') return typeof OPS_TOOL_SCHEMAS !== 'undefined' ? OPS_TOOL_SCHEMAS : [];
    if (name === 'prompts') return typeof OPS_PROMPTS !== 'undefined' ? OPS_PROMPTS : {};
    if (name === 'outputs') return typeof OPS_OUTPUT_SCHEMAS !== 'undefined' ? OPS_OUTPUT_SCHEMAS : {};
  }

  /**
   * Run one agent.
   * @param {Object} o
   *   agent       'steward' | 'analyst' | 'writer'
   *   input       user message text
   *   data        data object for OpsTools
   *   callModel   function(request) -> Gemini generateContent response (synchronous)
   *   maxSteps    tool-calling rounds before forcing the final answer (default 6)
   *   prefetched  optional [{tool, args, result}] that code already ran; sent with the first message
   *               so the model can skip those calls (see analystPrefetch)
   *   deadline    optional epoch ms. Before another tool round, the loop checks that this round plus
   *               the final answer still fit (estimated from the slowest model call so far); if not,
   *               it goes straight to the final answer. Apps Script stops a run at 6 minutes.
   */
  function runAgent(o) {
    var cfg = AGENTS[o.agent];
    if (!cfg) throw new Error('Unknown agent ' + o.agent);
    var schemas = o.schemas || defaults('schemas');
    var prompts = o.prompts || defaults('prompts');
    var outputs = o.outputSchemas || defaults('outputs');
    var maxSteps = o.maxSteps || 6;
    var decls = schemas
      .filter(function (t) {
        return cfg.tools.indexOf(t.name) !== -1;
      })
      .map(function (t) {
        return { name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) };
      });
    var system = { parts: [{ text: prompts[cfg.prompt] }] };
    var trace = [];
    var firstText = o.input;
    if (o.prefetched && o.prefetched.length) {
      firstText +=
        '\n\nTool results already fetched by code (same tools you have; do not call these again):\n' +
        o.prefetched
          .map(function (p) {
            return p.tool + ' ' + JSON.stringify(p.args) + ' -> ' + JSON.stringify(p.result);
          })
          .join('\n');
      o.prefetched.forEach(function (p) {
        trace.push({ step: 0, tool: p.tool, args: p.args, ok: !p.result.error, prefetched: true, result_preview: preview(p.result) });
      });
    }
    var contents = [{ role: 'user', parts: [{ text: firstText }] }];
    var usage = { model_calls: 0, prompt_tokens: 0, output_tokens: 0, total_tokens: 0, model_seconds: 0 };
    var now = o.now || Date.now; // injectable clock for tests
    var slowestCallMs = 0;
    var callModel = function (req) {
      var t0 = now();
      try {
        return o.callModel(req);
      } finally {
        var ms = now() - t0;
        if (ms > slowestCallMs) slowestCallMs = ms;
        usage.model_seconds = Math.round((usage.model_seconds + ms / 1000) * 10) / 10;
      }
    };
    var steps = 0;
    var stoppedForTime = false;

    for (var step = 0; step < maxSteps; step++) {
      // a tool round and the final answer each take about one model call
      if (o.deadline && step > 0 && now() + 2 * slowestCallMs > o.deadline) {
        stoppedForTime = true;
        break;
      }
      var res = callModel({
        systemInstruction: system,
        contents: contents,
        tools: [{ functionDeclarations: decls }],
        generationConfig: { temperature: 0.2 },
      });
      addUsage(usage, res);
      steps++;
      var content = firstContent(res);
      contents.push({ role: 'model', parts: content.parts });
      var calls = content.parts.filter(function (p) {
        return p.functionCall;
      });
      if (!calls.length) break;
      var responses = calls.map(function (p) {
        var name = p.functionCall.name;
        var args = p.functionCall.args || {};
        var allowed = cfg.tools.indexOf(name) !== -1;
        var result = allowed
          ? jsonCopy(OpsTools.run(name, args, o.data))
          : { error: 'Tool ' + name + ' is not available to the ' + o.agent + ' agent.' };
        trace.push({ step: step + 1, tool: name, args: args, ok: !result.error, result_preview: preview(result) });
        return { functionResponse: { name: name, response: { result: result } } };
      });
      contents.push({ role: 'user', parts: responses });
    }

    contents.push({
      role: 'user',
      parts: [{ text: 'Give your final answer now as JSON matching the response schema. Use only numbers that came from tool results or this conversation.' }],
    });
    var finalRes = callModel({
      systemInstruction: system,
      contents: contents,
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(outputs[cfg.output]),
      },
    });
    addUsage(usage, finalRes);
    var text = textOf(finalRes);
    var output;
    try {
      output = JSON.parse(text);
    } catch (e) {
      return { ok: false, agent: o.agent, error: 'Model did not return valid JSON', raw: text, trace: trace, usage: usage, steps: steps };
    }
    var problems = check(output, outputs[cfg.output]);
    var result = { ok: problems.length === 0, agent: o.agent, output: output, problems: problems, trace: trace, usage: usage, steps: steps, stopped_for_time: stoppedForTime };
    if (o.agent === 'analyst' && result.ok) result.checked = checkSuggestions(output, o.data);
    return result;
  }

  /**
   * Guardrail for the analyst: compare each suggestion with what the tools say.
   * Flags never block a suggestion; they are shown next to it in the Approvals sheet.
   */
  function checkSuggestions(output, data) {
    var low = OpsTools.run('list_low_cover', { days: 21 }, data);
    var dead = OpsTools.run('list_dead_stock', {}, data);
    var lowBySku = {};
    (low.items || []).forEach(function (i) {
      lowBySku[i.sku] = i;
    });
    var deadSkus = (dead.items || []).map(function (i) {
      return i.sku;
    });
    var known = {};
    data.products.forEach(function (p) {
      known[p.sku] = true;
    });
    return (output.suggestions || []).map(function (s) {
      var sku = String(s.sku || '').toUpperCase();
      var flags = [];
      var base = lowBySku[sku] ? lowBySku[sku].baseline_order_qty : null;
      if (!known[sku]) flags.push('unknown_sku');
      if (deadSkus.indexOf(sku) !== -1) flags.push('dead_stock');
      if (known[sku] && !lowBySku[sku]) flags.push('not_in_low_cover_list');
      if (base && (s.qty < base * 0.5 || s.qty > base * 2)) flags.push('outside_baseline_range');
      return { sku: sku, qty: s.qty, confidence: s.confidence, reason: s.reason, baseline_qty: base, flags: flags };
    });
  }

  /** Save checked suggestions as Pending approvals (code does the write, not the model). */
  function saveSuggestions(checked, data, now) {
    return checked.map(function (c) {
      if (c.flags.indexOf('unknown_sku') !== -1) return { sku: c.sku, skipped: 'unknown SKU' };
      var reason = c.reason + (c.flags.length ? ' [check: ' + c.flags.join(', ') + ']' : '');
      return jsonCopy(
        OpsTools.run('save_approval', { sku: c.sku, qty: c.qty, reason: reason, confidence: c.confidence, requested_by: 'inventory-analyst', now: now }, data),
      );
    });
  }

  /**
   * Choose a model from the names the API lists: prefer stable "gemini-<version>-flash"
   * (no preview/exp/lite/tts/image/audio variants), newest version first; then any flash model;
   * then any gemini model. Returns null if the list is empty.
   */
  function pickModel(names) {
    var version = function (n) {
      var m = String(n).match(/^gemini-(\d+(?:\.\d+)?)/);
      return m ? parseFloat(m[1]) : -1;
    };
    var newest = function (list) {
      return list.slice().sort(function (a, b) {
        return version(b) - version(a) || (a < b ? -1 : 1);
      })[0];
    };
    var odd = /preview|exp|lite|tts|image|audio|live|thinking|embedding|vision|-\d{3,}$/;
    var stableFlash = names.filter(function (n) {
      return /^gemini-\d+(\.\d+)?-flash$/.test(n);
    });
    if (stableFlash.length) return newest(stableFlash);
    var anyFlash = names.filter(function (n) {
      return /^gemini-.*flash/.test(n) && !odd.test(n);
    });
    if (anyFlash.length) return newest(anyFlash);
    var anyGemini = names.filter(function (n) {
      return /^gemini-/.test(n) && !/embedding|tts|image|audio/.test(n);
    });
    var stable = anyGemini.filter(function (n) {
      return !odd.test(n);
    });
    if (stable.length) return newest(stable);
    return anyGemini.length ? newest(anyGemini) : null;
  }

  /**
   * The calls the analyst prompt always makes, run by code up front: list_low_cover, list_dead_stock,
   * and get_sales for 7 and 28 days per flagged SKU. Each Gemini round can take 25-110 s, so this turns
   * up to 7 model calls into 2 and keeps the run under the Apps Script 6-minute limit.
   */
  function analystPrefetch(data, days) {
    days = days || 21;
    var calls = [
      { tool: 'list_low_cover', args: { days: days } },
      { tool: 'list_dead_stock', args: {} },
    ];
    var low = OpsTools.run('list_low_cover', { days: days }, data);
    (low.items || []).forEach(function (i) {
      calls.push({ tool: 'get_sales', args: { sku: i.sku, days: 7 } });
      calls.push({ tool: 'get_sales', args: { sku: i.sku, days: 28 } });
    });
    return calls.map(function (c) {
      return { tool: c.tool, args: c.args, result: jsonCopy(OpsTools.run(c.tool, c.args, data)) };
    });
  }

  /** Writer JSON -> plain text, used for the email body and the Google Doc. */
  function renderReport(r) {
    var lines = [r.title, '', r.headline, ''];
    (r.sections || []).forEach(function (s) {
      lines.push(s.heading);
      (s.bullets || []).forEach(function (b) {
        lines.push('- ' + b);
      });
      lines.push('');
    });
    if (r.actions && r.actions.length) {
      lines.push('Next actions');
      r.actions.forEach(function (a, i) {
        lines.push(i + 1 + '. ' + a);
      });
    }
    lines.push('', 'Demo data: fictional brand, synthetic numbers. Reorders are suggestions until a person approves them.');
    return lines.join('\n');
  }

  return {
    AGENTS: AGENTS,
    toGeminiSchema: toGeminiSchema,
    check: check,
    runAgent: runAgent,
    checkSuggestions: checkSuggestions,
    saveSuggestions: saveSuggestions,
    analystPrefetch: analystPrefetch,
    renderReport: renderReport,
    pickModel: pickModel,
    textOf: textOf,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = OpsAgents;
