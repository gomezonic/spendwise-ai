const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'
const DEFAULT_MODEL = 'openai/gpt-oss-20b'
const REQUEST_TIMEOUT_MS = 30_000
const EXPLANATION_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'spendwise_explanation',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        reasoning: { type: 'string' },
      },
      required: ['summary', 'reasoning'],
      additionalProperties: false,
    },
  },
}

export async function generateExplanation(facts, mode, options = {}) {
  const apiKey = options.apiKey ?? process.env.GROQ_API_KEY
  const model = options.model ?? process.env.GROQ_MODEL ?? DEFAULT_MODEL
  const fetchImpl = options.fetchImpl ?? fetch
  const usesGptOssModel = /^openai\/gpt-oss-(?:20b|120b)$/i.test(model)

  if (!apiKey) {
    const error = new Error('AI is not configured yet. Add GROQ_API_KEY to your server environment and restart Spendwise.')
    error.status = 503
    throw error
  }

  const modeInstructions = mode === 'affordability'
    ? 'Explain whether the purchase can fit without changing the plan, and whether the savings goal can be protected by reducing only flexible spending. Mention that fixed expenses cannot be reduced.'
    : 'Explain whether the savings goal is achievable and the specific flexible categories and reductions that can bridge any gap. Never suggest reducing fixed expenses.'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetchImpl(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        ...(usesGptOssModel
          ? {
              reasoning_effort: 'low',
              max_completion_tokens: 1024,
              response_format: EXPLANATION_RESPONSE_FORMAT,
            }
          : {
              max_tokens: 350,
              response_format: { type: 'json_object' },
            }),
        messages: [
          {
            role: 'system',
            content: 'You are Spendwise, a kind and practical budgeting assistant. Financial figures and proposed adjustments in the input are authoritative and already calculated; never recalculate, change, or invent numbers. Do not give investment, tax, or debt advice. Be specific, concise, non-judgmental, and return only a JSON object with string fields "summary" and "reasoning".',
          },
          {
            role: 'user',
            content: `${modeInstructions}\n\nUse only these verified facts. Each adjustment is a flexible category; fixed expenses are not adjustable. If "unallocatedGap" is greater than zero, be transparent that the goal cannot be reached by reducing the remaining flexible budgets alone.\n\n${JSON.stringify(facts)}`,
          },
        ],
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const error = new Error(`Groq returned HTTP ${response.status}. Check the model name, API key, and provider quota.`)
      error.status = response.status === 429 ? 503 : 502
      throw error
    }

    const payload = await response.json()
    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new Error('Groq returned an empty response.')
    }
    const parsed = JSON.parse(content)
    if (typeof parsed.summary !== 'string' || typeof parsed.reasoning !== 'string') {
      throw new Error('Groq returned an unexpected response format.')
    }
    return {
      summary: parsed.summary.slice(0, 400),
      reasoning: parsed.reasoning.slice(0, 800),
      model,
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('The AI request took too long. Please try again.')
      timeoutError.status = 504
      throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
