export class RequestValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RequestValidationError'
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readAmount(value, label, allowZero = true) {
  const amount = Number(value)
  if (!Number.isInteger(amount) || amount < (allowZero ? 0 : 1) || amount > 1_000_000_000) {
    throw new RequestValidationError(`${label} must be a valid amount in rupees.`)
  }
  return amount
}

function normalizeRequest(body) {
  if (!isObject(body) || !isObject(body.budget)) {
    throw new RequestValidationError('A budget is required to run an analysis.')
  }

  const { budget } = body
  const income = readAmount(budget.income, 'Monthly income', false)
  const savingsGoal = readAmount(budget.savingsGoal, 'Savings goal')
  if (!Array.isArray(budget.fixedExpenses) || !Array.isArray(budget.flexibleExpenses)) {
    throw new RequestValidationError('The budget must include fixed and flexible expense categories.')
  }

  const categories = [
    ...budget.fixedExpenses.map((expense) => ({ ...expense, type: 'fixed' })),
    ...budget.flexibleExpenses.map((expense) => ({ ...expense, type: 'flexible' })),
  ]
  if (categories.length > 100) {
    throw new RequestValidationError('A budget can include up to 100 categories.')
  }

  const categoryKeys = new Set()
  const normalizedCategories = categories.map((expense) => {
    if (!isObject(expense) || typeof expense.category !== 'string') {
      throw new RequestValidationError('Each category needs a name and monthly budget.')
    }
    const category = expense.category.trim()
    if (!category || category.length > 40) {
      throw new RequestValidationError('Category names must be between 1 and 40 characters.')
    }
    const key = category.toLocaleLowerCase()
    if (categoryKeys.has(key)) {
      throw new RequestValidationError('Category names must be unique across fixed and flexible expenses.')
    }
    categoryKeys.add(key)
    return {
      category,
      amount: readAmount(expense.amount, `${category} budget`),
      type: expense.type,
    }
  })

  const { fixedExpenses, flexibleExpenses } = normalizedCategories.reduce((groups, expense) => {
    groups[expense.type === 'fixed' ? 'fixedExpenses' : 'flexibleExpenses'].push(expense)
    return groups
  }, { fixedExpenses: [], flexibleExpenses: [] })

  if (!Array.isArray(body.transactions) || body.transactions.length > 5000) {
    throw new RequestValidationError('Transaction data must be a list of at most 5,000 expenses.')
  }
  const transactions = body.transactions.map((transaction) => {
    if (!isObject(transaction) || typeof transaction.category !== 'string') {
      throw new RequestValidationError('Each transaction needs a category, amount, and date.')
    }
    const category = categoryKeys.has(transaction.category.trim().toLocaleLowerCase())
      ? normalizedCategories.find((item) => item.category.toLocaleLowerCase() === transaction.category.trim().toLocaleLowerCase())
      : null
    if (!category) {
      throw new RequestValidationError('Every logged expense must use a category in the current budget.')
    }
    if (typeof transaction.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(transaction.date)) {
      throw new RequestValidationError('Each logged expense needs a valid date.')
    }
    return {
      category: category.category,
      amount: readAmount(transaction.amount, 'Expense amount', false),
      date: transaction.date,
    }
  })

  return {
    income,
    savingsGoal,
    fixedExpenses,
    flexibleExpenses,
    transactions,
  }
}

function computeSnapshot(data) {
  const categorySpend = new Map()
  for (const transaction of data.transactions) {
    const key = transaction.category.toLocaleLowerCase()
    categorySpend.set(key, (categorySpend.get(key) || 0) + transaction.amount)
  }

  const categories = [...data.fixedExpenses, ...data.flexibleExpenses].map((expense) => {
    const spent = categorySpend.get(expense.category.toLocaleLowerCase()) || 0
    return {
      ...expense,
      spent,
      remaining: Math.max(0, expense.amount - spent),
      overBudget: Math.max(0, spent - expense.amount),
    }
  })
  const plannedExpenses = categories.reduce((total, category) => total + category.amount, 0)
  const totalSpent = data.transactions.reduce((total, transaction) => total + transaction.amount, 0)
  const overBudget = categories.reduce((total, category) => total + category.overBudget, 0)
  const expectedSavings = data.income - plannedExpenses - overBudget
  return {
    income: data.income,
    savingsGoal: data.savingsGoal,
    plannedExpenses,
    totalSpent,
    remainingBudget: plannedExpenses - totalSpent,
    expectedSavings,
    savingsGap: Math.max(0, data.savingsGoal - expectedSavings),
    categories,
  }
}

function parseLocalDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RequestValidationError(`${label} must be a valid calendar date.`)
  }
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RequestValidationError(`${label} must be a valid calendar date.`)
  }
  return { year, month, day }
}

export function createSavingsForecast(body) {
  const data = normalizeRequest(body)
  const asOf = parseLocalDate(body.asOf, 'Forecast date')
  const daysInMonth = new Date(Date.UTC(asOf.year, asOf.month, 0)).getUTCDate()
  const monthKey = `${String(asOf.year).padStart(4, '0')}-${String(asOf.month).padStart(2, '0')}`

  const spentByCategory = new Map()
  let loggedSpending = 0
  for (const transaction of data.transactions) {
    const transactionDate = parseLocalDate(transaction.date, 'Expense date')
    const transactionMonth = `${String(transactionDate.year).padStart(4, '0')}-${String(transactionDate.month).padStart(2, '0')}`
    if (transactionMonth !== monthKey) continue
    if (transactionDate.day > asOf.day) {
      throw new RequestValidationError('Forecast date cannot be earlier than a logged expense date.')
    }
    loggedSpending += transaction.amount
    const categoryKey = transaction.category.toLocaleLowerCase()
    spentByCategory.set(categoryKey, (spentByCategory.get(categoryKey) || 0) + transaction.amount)
  }

  const fixedProjected = data.fixedExpenses.reduce((total, expense) => {
    const spent = spentByCategory.get(expense.category.toLocaleLowerCase()) || 0
    return total + Math.max(expense.amount, spent)
  }, 0)
  const flexibleProjections = data.flexibleExpenses.map((expense) => {
    const spent = spentByCategory.get(expense.category.toLocaleLowerCase()) || 0
    const paceProjection = spent === 0 ? expense.amount : (spent / asOf.day) * daysInMonth
    const projected = Math.max(spent, Math.min(expense.amount, paceProjection))
    return {
      category: expense.category,
      budget: expense.amount,
      spent,
      projected: Math.round(projected),
      paceOverBudget: Math.max(0, Math.round(paceProjection - expense.amount)),
    }
  })
  const projectedFlexible = flexibleProjections.reduce((total, expense) => total + expense.projected, 0)
  const projectedExpenses = fixedProjected + projectedFlexible
  const projectedSavings = data.income - projectedExpenses

  return {
    asOf: body.asOf,
    daysElapsed: asOf.day,
    daysInMonth,
    daysRemaining: daysInMonth - asOf.day,
    loggedSpending,
    plannedExpenses: data.fixedExpenses.reduce((total, expense) => total + expense.amount, 0)
      + data.flexibleExpenses.reduce((total, expense) => total + expense.amount, 0),
    projectedExpenses,
    projectedSavings,
    savingsGoal: data.savingsGoal,
    projectedGap: Math.max(0, data.savingsGoal - projectedSavings),
    status: projectedSavings < data.savingsGoal ? 'below-goal' : 'on-track',
    confidence: asOf.day < 7 ? 'early' : 'pace-based',
    categoryProjections: flexibleProjections,
  }
}

function allocateCuts(categories, requested) {
  const flexible = categories
    .filter((category) => category.type === 'flexible')
    .map((category) => ({ ...category, reduction: 0 }))
  let remaining = requested

  while (remaining > 0) {
    const available = flexible.filter((category) => category.remaining - category.reduction > 0)
    if (!available.length) break
    const totalWeight = available.reduce((total, category) => total + category.remaining - category.reduction, 0)
    let allocated = 0
    const target = remaining
    for (const category of available) {
      const capacity = category.remaining - category.reduction
      const share = Math.min(capacity, Math.floor(target * (capacity / totalWeight)))
      category.reduction += share
      allocated += share
    }
    remaining -= allocated
    for (const category of available) {
      if (remaining === 0) break
      if (category.remaining - category.reduction > 0) {
        category.reduction += 1
        remaining -= 1
      }
    }
    if (allocated === 0 && remaining === target) break
  }

  return {
    categories: flexible
      .map((category) => ({
        category: category.category,
        current: category.amount,
        spent: category.spent,
        reduction: Math.round(category.reduction),
        recommended: Math.max(category.spent, category.amount - Math.round(category.reduction)),
      }))
      .filter((category) => category.reduction > 0),
    allocated: requested - remaining,
    unmet: remaining,
  }
}

export function createRecommendation(body) {
  const snapshot = computeSnapshot(normalizeRequest(body))
  const allocation = allocateCuts(snapshot.categories, snapshot.savingsGap)
  return {
    snapshot,
    recommendations: allocation.categories,
    totalReduction: allocation.allocated,
    unmet: allocation.unmet,
    achievable: allocation.unmet < 0.5,
  }
}

export function createAffordabilityCheck(body) {
  const data = normalizeRequest(body)
  const snapshot = computeSnapshot(data)
  const purchaseAmount = readAmount(body.purchase?.amount, 'Purchase amount', false)
  const purchaseName = typeof body.purchase?.name === 'string' ? body.purchase.name.trim().slice(0, 80) : ''
  const projectedSavings = snapshot.expectedSavings - purchaseAmount
  const gapAfterPurchase = Math.max(0, data.savingsGoal - projectedSavings)
  const allocation = allocateCuts(snapshot.categories, gapAfterPurchase)
  return {
    purchase: { amount: purchaseAmount, name: purchaseName },
    projectedSavings,
    savingsGoal: data.savingsGoal,
    affordableWithoutChanges: projectedSavings >= data.savingsGoal,
    remainingBudget: snapshot.remainingBudget - purchaseAmount,
    recommendations: allocation.categories,
    totalReduction: allocation.allocated,
    unmet: allocation.unmet,
    canProtectGoal: allocation.unmet < 0.5,
  }
}

export function buildAiContext(body, mode) {
  const result = mode === 'affordability' ? createAffordabilityCheck(body) : createRecommendation(body)

  return {
    result,
    facts: mode === 'affordability'
      ? {
          type: 'affordability',
          purchase: result.purchase,
          projectedSavingsAfterPurchase: result.projectedSavings,
          savingsGoal: result.savingsGoal,
          canAffordWithoutChangingPlan: result.affordableWithoutChanges,
          remainingBudgetAfterPurchase: result.remainingBudget,
          canProtectGoalWithFlexibleCuts: result.canProtectGoal,
          flexibleAdjustments: result.recommendations,
          unallocatedGap: result.unmet,
        }
      : {
          type: 'savings-recommendation',
          income: result.snapshot.income,
          plannedExpenses: result.snapshot.plannedExpenses,
          loggedSpending: result.snapshot.totalSpent,
          expectedSavings: result.snapshot.expectedSavings,
          savingsGoal: result.snapshot.savingsGoal,
          gap: result.snapshot.savingsGap,
          achievableWithUnspentFlexibleBudgets: result.achievable,
          flexibleAdjustments: result.recommendations,
          unallocatedGap: result.unmet,
        },
  }
}
