# Spendwise

Spendwise is a JavaScript budgeting dashboard with local browser storage and optional AI explanations powered by an open-weight Groq model.

## Run locally

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` and set `GROQ_API_KEY` to a Groq API key. Keep `.env` private; it is ignored by Git.
3. Start the app with `npm run dev`, then open `http://localhost:5173`.

`GROQ_MODEL` can be set in `.env` to another model available to your Groq account. The default is `openai/gpt-oss-20b`. The API key is read by the server and is never sent to browser code.

AI requests share income, savings goal, category names and budgets, and the current month's logged expense categories, amounts, and dates with Groq. Affordability checks also send the optional purchase description and amount. The user's profile name and expense notes are not sent. Budget arithmetic and suggested reduction amounts are calculated by the server; the model only writes explanations.

The deterministic savings prediction is computed locally by the app server and does not call Groq. Fixed expenses remain at their planned amounts. Flexible categories with logged spending are projected from their month-to-date pace, capped at the category budget unless actual spending has already exceeded it. Categories without logged expenses remain at their planned amounts. Estimates based on fewer than seven days of activity are marked as early estimates.

AI endpoints are limited to 20 requests per client IP every 15 minutes to reduce accidental or automated API-key usage.

Run `npm test` for finance calculation tests and `npm run build` for a production build. Use `npm start` to serve a built production app on port 3000 (or the `PORT` set in `.env`).
