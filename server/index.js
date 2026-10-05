import 'dotenv/config'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { readFile } from 'node:fs/promises'
import { buildAiContext, createSavingsForecast, RequestValidationError } from './finance.js'
import { generateExplanation } from './groq.js'

const app = express()
const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production')
const port = Number(process.env.PORT) || (production ? 3000 : 5173)

app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))
const aiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'AI request limit reached. Please wait a few minutes and try again.' },
})

app.post('/api/forecast', (request, response, next) => {
  try {
    response.json(createSavingsForecast(request.body))
  } catch (error) {
    if (error instanceof RequestValidationError) {
      response.status(400).json({ error: error.message })
      return
    }
    next(error)
  }
})

app.post('/api/ai/:mode', aiRateLimit, async (request, response, next) => {
  const { mode } = request.params
  if (!['recommendations', 'affordability'].includes(mode)) {
    response.status(404).json({ error: 'AI feature not found.' })
    return
  }

  try {
    const { result, facts } = buildAiContext(request.body, mode === 'affordability' ? 'affordability' : 'recommendations')
    const explanation = await generateExplanation(facts, mode)
    response.json({ ...result, ...explanation })
  } catch (error) {
    if (error instanceof RequestValidationError) {
      response.status(400).json({ error: error.message })
      return
    }
    next(error)
  }
})

if (production) {
  app.use(express.static('dist'))
  app.use((request, response) => response.sendFile('index.html', { root: 'dist' }))
} else {
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'custom',
  })
  app.use(vite.middlewares)
  app.use('/', async (request, response, next) => {
    if (request.method !== 'GET' || !request.accepts('html')) {
      next()
      return
    }
    try {
      const sourceHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8')
      const html = await vite.transformIndexHtml(request.originalUrl, sourceHtml)
      response.status(200).type('html').send(html)
    } catch (error) {
      vite.ssrFixStacktrace(error)
      next(error)
    }
  })
}

app.use((error, request, response, next) => {
  if (response.headersSent) {
    next(error)
    return
  }
  console.error('Request failed:', error.message)
  response.status(error.status || 502).json({
    error: error.status ? error.message : 'The request could not be completed. Please try again.',
  })
})

app.listen(port, () => {
  console.log(`Spendwise server listening on http://localhost:${port}`)
})
