import assert from 'node:assert/strict'
import test from 'node:test'
import { generateExplanation } from './groq.js'

test('Groq requests use a server-side key and return validated explanation fields', async () => {
  let captured
  const facts = { type: 'savings-recommendation', flexibleAdjustments: [{ category: 'Food', reduction: 500 }] }
  const result = await generateExplanation(facts, 'recommendations', {
    apiKey: 'test-only-secret',
    model: 'openai/gpt-oss-20b',
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) }
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({ summary: 'Reduce food by ₹500.', reasoning: 'This keeps fixed costs untouched.' }),
          },
        }],
      }), { status: 200 })
    },
  })

  assert.equal(captured.url, 'https://api.groq.com/openai/v1/chat/completions')
  assert.equal(captured.options.headers.Authorization, 'Bearer test-only-secret')
  assert.equal(captured.body.model, 'openai/gpt-oss-20b')
  assert.equal(captured.body.reasoning_effort, 'low')
  assert.equal(captured.body.max_completion_tokens, 1024)
  assert.deepEqual(captured.body.response_format, {
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
  })
  assert.match(captured.body.messages[1].content, /Food/)
  assert.deepEqual(result, {
    summary: 'Reduce food by ₹500.',
    reasoning: 'This keeps fixed costs untouched.',
    model: 'openai/gpt-oss-20b',
  })
})

test('other configured models use the compatible JSON response format', async () => {
  let requestBody
  await generateExplanation({}, 'recommendations', {
    apiKey: 'test-only-secret',
    model: 'llama-3.3-70b-versatile',
    fetchImpl: async (url, options) => {
      requestBody = JSON.parse(options.body)
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({ summary: 'The goal is reachable.', reasoning: 'The budget leaves room for savings.' }),
          },
        }],
      }), { status: 200 })
    },
  })

  assert.equal(requestBody.max_tokens, 350)
  assert.equal(requestBody.reasoning_effort, undefined)
  assert.deepEqual(requestBody.response_format, { type: 'json_object' })
})

test('Groq requests fail explicitly when the server key is missing', async () => {
  await assert.rejects(
    generateExplanation({}, 'recommendations', { apiKey: '', fetchImpl: async () => assert.fail('must not call Groq without a key') }),
    (error) => error.status === 503 && error.message.includes('GROQ_API_KEY'),
  )
})

test('Groq rate limits are returned as a retryable service error', async () => {
  await assert.rejects(
    generateExplanation({}, 'recommendations', {
      apiKey: 'test-only-secret',
      fetchImpl: async () => new Response('{}', { status: 429 }),
    }),
    (error) => error.status === 503 && error.message.includes('HTTP 429'),
  )
})

test('invalid model output is rejected instead of returned as an explanation', async () => {
  await assert.rejects(
    generateExplanation({}, 'recommendations', {
      apiKey: 'test-only-secret',
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ summary: 42, reasoning: 'ok' }) } }],
      }), { status: 200 }),
    }),
    /unexpected response format/,
  )
})
