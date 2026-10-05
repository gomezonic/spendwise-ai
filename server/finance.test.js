import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildAiContext,
  createAffordabilityCheck,
  createRecommendation,
  createSavingsForecast,
  RequestValidationError,
} from './finance.js'

const budget = {
  income: 30_000,
  savingsGoal: 7_000,
  fixedExpenses: [
    { category: 'Rent', amount: 8_000 },
    { category: 'Bills', amount: 1_500 },
  ],
  flexibleExpenses: [
    { category: 'Food', amount: 6_000 },
    { category: 'Shopping', amount: 3_000 },
    { category: 'Entertainment', amount: 2_000 },
    { category: 'Travel', amount: 2_000 },
    { category: 'Other', amount: 2_000 },
  ],
}

test('recommendations bridge the savings gap using flexible categories only', () => {
  const result = createRecommendation({ budget, transactions: [] })
  assert.equal(result.snapshot.expectedSavings, 5_500)
  assert.equal(result.snapshot.savingsGap, 1_500)
  assert.equal(result.totalReduction, 1_500)
  assert.equal(result.unmet, 0)
  assert.equal(result.achievable, true)
  assert.equal(result.recommendations.reduce((total, item) => total + item.reduction, 0), 1_500)
  assert.ok(result.recommendations.every((item) => item.current >= item.recommended))
  assert.ok(result.recommendations.every((item) => item.recommended >= item.spent))
  assert.ok(result.recommendations.every((item) => !['Rent', 'Bills'].includes(item.category)))
})

test('logged overspending lowers projected savings and limits proposed reductions', () => {
  const result = createRecommendation({
    budget,
    transactions: [{ category: 'Food', amount: 6_500, date: '2026-10-04' }],
  })
  assert.equal(result.snapshot.expectedSavings, 5_000)
  assert.equal(result.snapshot.categories.find((item) => item.category === 'Food').overBudget, 500)
  assert.equal(result.recommendations.find((item) => item.category === 'Food'), undefined)
  assert.equal(result.totalReduction, 2_000)
  assert.equal(result.achievable, true)
})

test('unreachable goals report the part flexible budgets cannot cover', () => {
  const result = createRecommendation({
    budget: { ...budget, savingsGoal: 25_000 },
    transactions: [],
  })
  assert.equal(result.achievable, false)
  assert.equal(result.totalReduction, 15_000)
  assert.equal(result.unmet, 4_500)
})

test('affordability checks include the purchase and identify goal-protecting cuts', () => {
  const result = createAffordabilityCheck({
    budget,
    transactions: [],
    purchase: { name: 'Headphones', amount: 1_500 },
  })
  assert.equal(result.projectedSavings, 4_000)
  assert.equal(result.affordableWithoutChanges, false)
  assert.equal(result.canProtectGoal, true)
  assert.equal(result.totalReduction, 3_000)
  assert.equal(result.recommendations.reduce((total, item) => total + item.reduction, 0), 3_000)
})

test('AI context excludes the user name and expense notes', () => {
  const { facts } = buildAiContext({
    budget: { ...budget, name: 'Private name' },
    transactions: [{ category: 'Food', amount: 400, date: '2026-10-04', note: 'Personal note' }],
  }, 'recommendations')
  const serialized = JSON.stringify(facts)
  assert.equal(serialized.includes('Private name'), false)
  assert.equal(serialized.includes('Personal note'), false)
})

test('duplicate categories are rejected because spending cannot be attributed safely', () => {
  assert.throws(
    () => createRecommendation({
      budget: {
        ...budget,
        flexibleExpenses: [...budget.flexibleExpenses, { category: 'rent', amount: 100 }],
      },
      transactions: [],
    }),
    RequestValidationError,
  )
})

test('savings forecast preserves planned costs when no expenses are logged', () => {
  const result = createSavingsForecast({ budget, transactions: [], asOf: '2026-10-15' })
  assert.equal(result.daysElapsed, 15)
  assert.equal(result.daysInMonth, 31)
  assert.equal(result.projectedExpenses, 24_500)
  assert.equal(result.projectedSavings, 5_500)
  assert.equal(result.confidence, 'pace-based')
})

test('savings forecast projects an active flexible category using its month-to-date pace', () => {
  const result = createSavingsForecast({
    budget,
    transactions: [{ category: 'Food', amount: 1_500, date: '2026-10-15' }],
    asOf: '2026-10-15',
  })
  assert.equal(result.loggedSpending, 1_500)
  assert.equal(result.categoryProjections.find((item) => item.category === 'Food').projected, 3_100)
  assert.equal(result.categoryProjections.find((item) => item.category === 'Shopping').projected, 3_000)
  assert.equal(result.projectedExpenses, 21_600)
  assert.equal(result.projectedSavings, 8_400)
})

test('savings forecast surfaces category pace overages without relaxing fixed costs', () => {
  const result = createSavingsForecast({
    budget,
    transactions: [{ category: 'Food', amount: 6_500, date: '2026-10-15' }],
    asOf: '2026-10-15',
  })
  const food = result.categoryProjections.find((item) => item.category === 'Food')
  assert.equal(food.projected, 6_500)
  assert.equal(food.paceOverBudget, 7_433)
  assert.equal(result.projectedExpenses, 25_000)
  assert.equal(result.projectedSavings, 5_000)
  assert.equal(result.status, 'below-goal')
})

test('savings forecast accounts for fixed-expense overages without treating them as adjustable', () => {
  const result = createSavingsForecast({
    budget,
    transactions: [{ category: 'Rent', amount: 8_500, date: '2026-10-15' }],
    asOf: '2026-10-15',
  })
  assert.equal(result.projectedExpenses, 25_000)
  assert.equal(result.projectedSavings, 5_000)
  assert.equal(result.categoryProjections.some((item) => item.category === 'Rent'), false)
})

test('early-month forecast is identified as uncertain', () => {
  const result = createSavingsForecast({
    budget,
    transactions: [{ category: 'Food', amount: 200, date: '2026-10-03' }],
    asOf: '2026-10-03',
  })
  assert.equal(result.confidence, 'early')
  assert.equal(result.categoryProjections.find((item) => item.category === 'Food').projected, 2_067)
})

test('forecast rejects invalid calendar dates and dates before logged expenses', () => {
  assert.throws(
    () => createSavingsForecast({ budget, transactions: [], asOf: '2026-02-30' }),
    RequestValidationError,
  )
  assert.throws(
    () => createSavingsForecast({
      budget,
      transactions: [{ category: 'Food', amount: 100, date: '2026-10-16' }],
      asOf: '2026-10-15',
    }),
    RequestValidationError,
  )
})
