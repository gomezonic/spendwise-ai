import './style.css'

const STORAGE_KEY = 'spendwise-budget-v1'
const app = document.querySelector('#app')

const starterExpenses = {
  fixed: ['Rent', 'Bills'],
  flexible: ['Food', 'Shopping', 'Entertainment'],
}

let budget = loadBudget()
let recommendationResult = null
let affordabilityResult = null
let recommendationError = ''
let affordabilityError = ''
let forecastRequestId = 0

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return entities[character]
  })
}

function formatCurrency(amount) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount)
}

function loadBudget() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return null

    const loadedBudget = JSON.parse(saved)
    if (!loadedBudget || !Array.isArray(loadedBudget.fixedExpenses) || !Array.isArray(loadedBudget.flexibleExpenses)) {
      throw new Error('The saved budget has an invalid format.')
    }
    loadedBudget.transactions = Array.isArray(loadedBudget.transactions) ? loadedBudget.transactions : []
    return loadedBudget
  } catch (error) {
    console.error('Could not load the saved budget.', error)
    return null
  }
}

function saveBudget(nextBudget) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextBudget))
    budget = nextBudget
    recommendationResult = null
    affordabilityResult = null
    recommendationError = ''
    affordabilityError = ''
    renderDashboard()
  } catch (error) {
    console.error('Could not save the budget.', error)
    showError('Your budget could not be saved in this browser. Check your storage settings and try again.')
  }
}

function showError(message) {
  const errorElement = app.querySelector('[data-error], [data-tracking-error]')
  if (!errorElement) return
  errorElement.textContent = message
  errorElement.hidden = false
}

function makeAiPayload() {
  const { income, savingsGoal, fixedExpenses, flexibleExpenses } = budget
  return {
    budget: { income, savingsGoal, fixedExpenses, flexibleExpenses },
    transactions: getCurrentMonthTransactions().map(({ category, amount, date }) => ({ category, amount, date })),
  }
}

function makeForecastPayload() {
  return {
    ...makeAiPayload(),
    asOf: localDateString(),
  }
}

function renderForecastCategories(forecast) {
  return forecast.categoryProjections.length
    ? `<div class="forecast-category-list">
        ${forecast.categoryProjections.map((category) => {
          const overBudget = category.projected > category.budget
          return `<div class="forecast-category">
            <span class="forecast-category-name">${escapeHtml(category.category)}</span>
            <span class="forecast-category-current">${formatCurrency(category.spent)} spent</span>
            <span class="forecast-category-projected ${overBudget ? 'negative-value' : ''}">${formatCurrency(category.projected)} projected${overBudget ? ' · over budget' : ''}</span>
          </div>`
        }).join('')}
      </div>`
    : '<p class="forecast-empty">Add a flexible category to see a category-level projection.</p>'
}

async function requestSavingsForecast() {
  const state = app.querySelector('[data-forecast-state]')
  if (!state || !budget) return
  const requestId = ++forecastRequestId
  state.textContent = 'Updating from this month’s logged spending…'
  state.className = 'forecast-state forecast-loading'

  try {
    const forecast = await callApi('forecast', makeForecastPayload())
    if (requestId !== forecastRequestId) return
    const panel = app.querySelector('[data-forecast-panel]')
    if (!panel) return
    panel.querySelector('[data-forecast-savings]').textContent = formatCurrency(forecast.projectedSavings)
    panel.querySelector('[data-forecast-expenses]').textContent = formatCurrency(forecast.projectedExpenses)
    panel.querySelector('[data-forecast-days]').textContent = `${forecast.daysElapsed} of ${forecast.daysInMonth} days elapsed`
    panel.querySelector('[data-forecast-gap]').textContent = forecast.projectedGap > 0
      ? `${formatCurrency(forecast.projectedGap)} below your goal`
      : `${formatCurrency(forecast.projectedSavings - forecast.savingsGoal)} above your goal`
    panel.querySelector('[data-forecast-gap]').className = `forecast-gap ${forecast.projectedGap > 0 ? 'forecast-gap-warning' : 'forecast-gap-ok'}`
    panel.querySelector('[data-forecast-categories]').innerHTML = renderForecastCategories(forecast)
    const progress = forecast.savingsGoal > 0
      ? Math.max(0, Math.min(100, forecast.projectedSavings / forecast.savingsGoal * 100))
      : (forecast.projectedSavings >= 0 ? 100 : 0)
    panel.querySelector('[data-forecast-progress]').style.width = `${progress}%`
    panel.querySelector('[data-forecast-progress-track]').setAttribute('aria-valuenow', String(Math.round(progress)))
    panel.querySelector('[data-forecast-confidence]').textContent = forecast.confidence === 'early'
      ? 'Early estimate: a few days of spending can make this projection jump around.'
      : `Based on the spending pace in each used flexible category across ${forecast.daysElapsed} days. Categories without logged spending stay at their planned budget.`
    state.textContent = forecast.confidence === 'early' ? 'Early month-end estimate' : 'Projected from current spending pace'
    state.className = `forecast-state ${forecast.status === 'on-track' ? 'forecast-state-ok' : 'forecast-state-warning'}`
  } catch (error) {
    if (requestId !== forecastRequestId) return
    console.error('Savings forecast request failed:', error)
    state.textContent = error.message
    state.className = 'forecast-state forecast-state-error'
  }
}

async function callApi(endpoint, payload) {
  const apiPath = endpoint === 'forecast' ? '/api/forecast' : `/api/ai/${endpoint}`
  const response = await fetch(apiPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const result = await response.json()
  if (!response.ok) {
    throw new Error(result.error || `AI request failed with status ${response.status}.`)
  }
  return result
}

function renderAdjustments(adjustments) {
  if (!adjustments.length) return '<p class="ai-no-adjustments">No category cuts are needed to reach this goal.</p>'
  const maxAmount = Math.max(...adjustments.map((adjustment) => adjustment.current), 1)
  return `
    <div class="recommendation-graph" role="img" aria-label="Comparison of current flexible category budgets with the recommended monthly limits">
      <div class="graph-legend"><span><i class="legend-current"></i>Current budget</span><span><i class="legend-recommended"></i>Recommended</span></div>
      ${adjustments.map((adjustment) => `
        <div class="graph-category">
          <div class="graph-category-heading"><strong>${escapeHtml(adjustment.category)}</strong><span>Save ${formatCurrency(adjustment.reduction)}</span></div>
          <div class="graph-bar-row"><span>Now</span><div class="graph-bar-track"><i class="graph-bar current-bar" style="width:${Math.max(2, adjustment.current / maxAmount * 100)}%"></i></div><b>${formatCurrency(adjustment.current)}</b></div>
          <div class="graph-bar-row"><span>Plan</span><div class="graph-bar-track"><i class="graph-bar recommended-bar" style="width:${Math.max(2, adjustment.recommended / maxAmount * 100)}%"></i></div><b>${formatCurrency(adjustment.recommended)}</b></div>
        </div>`).join('')}
    </div>`
}

function renderAiPanel() {
  if (!recommendationResult) {
    return `<div class="ai-empty"><span class="ai-spark" aria-hidden="true">✳</span><div><strong>Get a plan that protects your goal</strong><p>Spendwise will look at your flexible budgets and logged expenses, then show where small changes could help.</p></div></div>`
  }

  const result = recommendationResult
  return `
    <div class="ai-result">
      <div class="ai-copy"><p class="ai-summary">${escapeHtml(result.summary)}</p><p class="ai-reasoning">${escapeHtml(result.reasoning)}</p></div>
      <div class="ai-metrics">
        <div><span>Current expected savings</span><strong>${formatCurrency(result.snapshot.expectedSavings)}</strong></div>
        <div><span>Goal gap</span><strong>${formatCurrency(result.snapshot.savingsGap)}</strong></div>
        <div><span>Potential flexible cuts</span><strong>${formatCurrency(result.totalReduction)}</strong></div>
      </div>
      ${result.recommendations.length ? renderAdjustments(result.recommendations) : ''}
      ${result.unmet > 0
        ? `<p class="unmet-gap">Flexible budgets have only ${formatCurrency(result.totalReduction)} available to reduce, leaving ${formatCurrency(result.unmet)} of the goal gap uncovered.</p>`
        : ''}
      <p class="model-caption">Explanation from ${escapeHtml(result.model)}. Numbers and cut amounts are calculated by Spendwise.</p>
    </div>`
}

function renderAffordabilityResult() {
  if (!affordabilityResult) return ''
  const result = affordabilityResult
  return `
    <div class="affordability-result ${result.affordableWithoutChanges ? 'affordability-ok' : 'affordability-caution'}">
      <div class="ai-copy"><p class="ai-summary">${escapeHtml(result.summary)}</p><p class="ai-reasoning">${escapeHtml(result.reasoning)}</p></div>
      <div class="ai-metrics">
        <div><span>Projected savings after purchase</span><strong>${formatCurrency(result.projectedSavings)}</strong></div>
        <div><span>Monthly savings goal</span><strong>${formatCurrency(result.savingsGoal)}</strong></div>
      </div>
      ${result.recommendations.length ? `<div class="affordability-adjustments"><h3>Flexible changes to keep your goal</h3>${renderAdjustments(result.recommendations)}</div>` : ''}
      ${!result.canProtectGoal
        ? `<p class="unmet-gap">Even using all remaining flexible budgets would leave ${formatCurrency(result.unmet)} of the goal gap uncovered. Keep fixed expenses unchanged.</p>`
        : ''}
      <p class="model-caption">Explanation from ${escapeHtml(result.model)}. Numbers and cut amounts are calculated by Spendwise.</p>
    </div>`
}

function localDateString(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getCurrentMonthTransactions() {
  const currentMonth = localDateString().slice(0, 7)
  return budget.transactions.filter((transaction) => transaction.date?.slice(0, 7) === currentMonth)
}

function getCategorySpend(transactions) {
  return transactions.reduce((spending, transaction) => {
    const key = transaction.category.toLocaleLowerCase()
    spending.set(key, (spending.get(key) || 0) + transaction.amount)
    return spending
  }, new Map())
}

function expenseRow(type, name = '', amount = '') {
  return `
    <div class="expense-input-row">
      <input name="${type}Category" type="text" aria-label="${type} expense category" value="${escapeHtml(name)}" placeholder="e.g. ${type === 'fixed' ? 'Rent' : 'Food'}" maxlength="40">
      <label>
        <span class="visually-hidden">Monthly amount in rupees</span>
        <span class="input-currency" aria-hidden="true">₹</span>
        <input name="${type}Amount" type="number" min="0" step="1" aria-label="${type} expense amount in rupees" value="${escapeHtml(amount)}" placeholder="Amount">
      </label>
      <button class="icon-button remove-row" type="button" aria-label="Remove category" title="Remove category">×</button>
    </div>`
}

function renderSetup(values = {}) {
  forecastRequestId += 1
  const fixed = values.fixedExpenses?.length
    ? values.fixedExpenses
    : starterExpenses.fixed.map((category) => ({ category, amount: '' }))
  const flexible = values.flexibleExpenses?.length
    ? values.flexibleExpenses
    : starterExpenses.flexible.map((category) => ({ category, amount: '' }))

  app.innerHTML = `
    <main class="setup-shell">
      <header class="brand-header">
        <a class="brand" href="#" aria-label="Spendwise home">
          <span class="brand-mark">s</span>
          <span>spendwise<span class="brand-period">.</span></span>
        </a>
        <span class="header-note">Your money, with a plan</span>
      </header>

      <section class="setup-card">
        <div class="eyebrow"><span class="eyebrow-dot"></span> YOUR MONTHLY PLAN</div>
        <h1>Let’s make your money<br class="desktop-break"> work for you.</h1>
        <p class="intro-copy">A few details are all we need to build a plan that feels doable.</p>

        <form id="budget-form" novalidate>
          <div class="form-section">
            <div class="section-heading">
              <span class="step-number">01</span>
              <div><h2>The basics</h2><p>Start with your monthly take-home.</p></div>
            </div>
            <div class="basics-grid">
              <label class="field">
                <span>Your name</span>
                <input name="name" type="text" autocomplete="given-name" placeholder="e.g. Alex" maxlength="50" value="${escapeHtml(values.name || '')}" required>
              </label>
              <label class="field">
                <span>Monthly income</span>
                <span class="money-input"><span>₹</span><input name="income" type="number" min="1" step="1" inputmode="numeric" placeholder="30,000" value="${escapeHtml(values.income ?? '')}" required></span>
              </label>
            </div>
          </div>

          <div class="form-section">
            <div class="section-heading">
              <span class="step-number">02</span>
              <div><h2>Monthly expenses</h2><p>Fixed costs stay put; flexible ones can move.</p></div>
            </div>
            <div class="expense-groups">
              <section class="expense-group">
                <div class="group-heading">
                  <div><span class="group-icon fixed-icon">↗</span><h3>Fixed expenses</h3></div>
                  <span class="group-tag">NON-ADJUSTABLE</span>
                </div>
                <div class="expense-rows" data-rows="fixed">${fixed.map((item) => expenseRow('fixed', item.category, item.amount)).join('')}</div>
                <button class="add-row" type="button" data-add="fixed"><span>＋</span> Add fixed expense</button>
              </section>
              <section class="expense-group">
                <div class="group-heading">
                  <div><span class="group-icon flex-icon">↗</span><h3>Flexible expenses</h3></div>
                  <span class="group-tag flexible-tag">CAN BE ADJUSTED</span>
                </div>
                <div class="expense-rows" data-rows="flexible">${flexible.map((item) => expenseRow('flexible', item.category, item.amount)).join('')}</div>
                <button class="add-row" type="button" data-add="flexible"><span>＋</span> Add flexible expense</button>
              </section>
            </div>
          </div>

          <div class="form-section goal-section">
            <div class="section-heading">
              <span class="step-number">03</span>
              <div><h2>Your savings goal</h2><p>What would you like to set aside this month?</p></div>
            </div>
            <label class="field goal-field">
              <span>Monthly savings goal</span>
              <span class="money-input"><span>₹</span><input name="goal" type="number" min="0" step="1" inputmode="numeric" placeholder="5,000" value="${escapeHtml(values.savingsGoal ?? '')}" required></span>
            </label>
          </div>

          <p class="form-error" data-error role="alert" hidden></p>
          <div class="setup-actions">
            ${budget ? '<button class="secondary-button cancel-setup" data-cancel-setup type="button">Cancel</button>' : ''}
            <button class="primary-button" type="submit">Build my money plan <span aria-hidden="true">→</span></button>
          </div>
          <p class="privacy-note"><span aria-hidden="true">▣</span> Your plan is saved in this browser. AI requests send budget data to Groq when you ask for help.</p>
        </form>
      </section>
      <footer class="page-footer">A little more clarity. A little less money stress.</footer>
    </main>`

  app.querySelectorAll('[data-add]').forEach((button) => {
    button.addEventListener('click', () => {
      const type = button.dataset.add
      app.querySelector(`[data-rows="${type}"]`).insertAdjacentHTML('beforeend', expenseRow(type))
    })
  })

  app.querySelector('#budget-form').addEventListener('submit', handleSetupSubmit)
  app.querySelector('[data-cancel-setup]')?.addEventListener('click', renderDashboard)
}

function handleSetupClick(event) {
  const button = event.target.closest('.remove-row')
  if (!button) return
  const rows = button.closest('.expense-rows')
  if (rows.children.length > 1) {
    button.closest('.expense-input-row').remove()
  } else {
    button.closest('.expense-input-row').querySelectorAll('input').forEach((input) => {
      input.value = ''
    })
  }
}

function readExpenses(form, type) {
  const categories = [...form.querySelectorAll(`[name="${type}Category"]`)]
  const amounts = [...form.querySelectorAll(`[name="${type}Amount"]`)]
  const expenses = []

  categories.forEach((categoryInput, index) => {
    const category = categoryInput.value.trim()
    const amountValue = amounts[index].value.trim()
    if (!category && !amountValue) return
    if (!category || !amountValue) {
      throw new Error('Add both a category name and amount, or remove the empty row.')
    }
    const amount = Number(amountValue)
    if (!Number.isInteger(amount) || amount < 0) {
      throw new Error('Expense amounts must be whole rupees and zero or more.')
    }
    expenses.push({ category, amount })
  })

  return expenses
}

function handleSetupSubmit(event) {
  event.preventDefault()
  const form = event.currentTarget
  const errorElement = app.querySelector('[data-error]')
  errorElement.hidden = true

  try {
    const name = form.elements.name.value.trim()
    const income = Number(form.elements.income.value)
    const savingsGoal = Number(form.elements.goal.value)
    const fixedExpenses = readExpenses(form, 'fixed')
    const flexibleExpenses = readExpenses(form, 'flexible')
    const categoryNames = [...fixedExpenses, ...flexibleExpenses].map((expense) => expense.category.toLocaleLowerCase())
    const currentMonth = localDateString().slice(0, 7)
    const currentCategories = new Set(categoryNames)
    const orphanedTransactions = (budget?.transactions || []).filter((transaction) => (
      transaction.date?.slice(0, 7) === currentMonth
      && !currentCategories.has(transaction.category.toLocaleLowerCase())
    ))

    if (!name) throw new Error('Please enter your name.')
    if (!Number.isInteger(income) || income <= 0) throw new Error('Monthly income must be a whole-rupee amount greater than ₹0.')
    if (!Number.isInteger(savingsGoal) || savingsGoal < 0) throw new Error('Your savings goal must be a whole-rupee amount of zero or more.')
    if (new Set(categoryNames).size !== categoryNames.length) throw new Error('Expense category names must be unique.')
    if (orphanedTransactions.length) {
      const category = orphanedTransactions[0].category
      throw new Error(`“${category}” has logged expenses this month. Keep that category, or delete its expenses before removing it from your plan.`)
    }

    saveBudget({
      name,
      income,
      savingsGoal,
      fixedExpenses,
      flexibleExpenses,
      transactions: budget?.transactions || [],
    })
  } catch (error) {
    showError(error.message)
  }
}

function renderDashboard() {
  if (!budget) {
    renderSetup()
    return
  }

  const monthTransactions = getCurrentMonthTransactions()
  const categorySpend = getCategorySpend(monthTransactions)
  const totalSpent = monthTransactions.reduce((total, transaction) => total + transaction.amount, 0)
  const allExpenses = [
    ...budget.fixedExpenses.map((expense) => ({ ...expense, type: 'fixed' })),
    ...budget.flexibleExpenses.map((expense) => ({ ...expense, type: 'flexible' })),
  ]
  const plannedExpenses = allExpenses.reduce((total, expense) => total + expense.amount, 0)
  const overBudget = allExpenses.reduce((total, expense) => (
    total + Math.max(0, (categorySpend.get(expense.category.toLocaleLowerCase()) || 0) - expense.amount)
  ), 0)
  const expectedSavings = budget.income - plannedExpenses - overBudget
  const remainingBudget = plannedExpenses - totalSpent
  const difference = expectedSavings - budget.savingsGoal
  const goalProgress = budget.savingsGoal > 0
    ? Math.max(0, Math.min(100, (expectedSavings / budget.savingsGoal) * 100))
    : (expectedSavings >= 0 ? 100 : 0)
  const onTrack = difference >= 0

  app.innerHTML = `
    <main class="dashboard-shell">
      <header class="dashboard-header">
        <a class="brand" href="#" aria-label="Spendwise home">
          <span class="brand-mark">s</span>
          <span>spendwise<span class="brand-period">.</span></span>
        </a>
        <button class="text-button" id="edit-plan" type="button"><span aria-hidden="true">✎</span> Edit plan</button>
      </header>

      <section class="welcome-row">
        <div>
          <div class="eyebrow"><span class="eyebrow-dot"></span> YOUR MONTHLY SNAPSHOT</div>
          <h1>Looking good, ${escapeHtml(budget.name)}<span class="wave" aria-hidden="true">✳</span></h1>
          <p class="intro-copy">Here’s your money plan for this month. Small steps add up.</p>
        </div>
        <div class="month-pill"><span aria-hidden="true">◷</span> This month</div>
      </section>

      <section class="summary-grid" aria-label="Budget summary">
        <article class="summary-card income-card">
          <div class="summary-label"><span class="summary-icon income-icon">↗</span> Monthly income</div>
          <p class="summary-value">${formatCurrency(budget.income)}</p>
          <p class="summary-hint">Your take-home for the month</p>
        </article>
        <article class="summary-card expense-card">
          <div class="summary-label"><span class="summary-icon expense-icon">↘</span> Planned expenses</div>
          <p class="summary-value">${formatCurrency(plannedExpenses)}</p>
          <p class="summary-hint">${formatCurrency(totalSpent)} spent across ${monthTransactions.length} ${monthTransactions.length === 1 ? 'expense' : 'expenses'}</p>
        </article>
        <article class="summary-card savings-card">
          <div class="summary-label"><span class="summary-icon savings-icon">✳</span> Expected savings</div>
          <p class="summary-value ${expectedSavings < 0 ? 'negative-value' : ''}">${formatCurrency(expectedSavings)}</p>
          <p class="summary-hint">After planned costs and any overages</p>
        </article>
        <article class="summary-card goal-card">
          <div class="summary-label"><span class="summary-icon goal-icon">◎</span> Savings goal</div>
          <p class="summary-value">${formatCurrency(budget.savingsGoal)}</p>
          <p class="summary-hint">${onTrack ? 'Within reach with this plan' : `${formatCurrency(Math.abs(difference))} gap to close`}</p>
        </article>
      </section>

      <section class="dashboard-grid">
        <article class="panel breakdown-panel">
          <div class="panel-heading">
            <div><div class="eyebrow">THE DETAILS</div><h2>Your budget breakdown</h2></div>
            <span class="category-count">${allExpenses.length} ${allExpenses.length === 1 ? 'category' : 'categories'}</span>
          </div>
          ${allExpenses.length
            ? `<div class="expense-list">
                ${allExpenses.map((expense) => {
                  const categoryAmount = categorySpend.get(expense.category.toLocaleLowerCase()) || 0
                  const remainingCategoryBudget = expense.amount - categoryAmount
                  return `<div class="expense-item">
                    <span class="expense-bullet ${expense.type === 'fixed' ? 'bullet-fixed' : 'bullet-flexible'}"></span>
                    <div class="expense-info">
                      <div class="expense-name-row"><span class="expense-name">${escapeHtml(expense.category)}</span><span class="expense-type ${expense.type}">${expense.type === 'fixed' ? 'Fixed' : 'Flexible'}</span></div>
                      <div class="expense-track"><span class="expense-fill ${expense.type}" style="width:${Math.min(100, (categoryAmount / Math.max(expense.amount, 1)) * 100)}%"></span></div>
                      <span class="category-remaining">${remainingCategoryBudget >= 0
                        ? `${formatCurrency(remainingCategoryBudget)} left`
                        : `${formatCurrency(Math.abs(remainingCategoryBudget))} over budget`}</span>
                    </div>
                    <span class="expense-amount">${formatCurrency(categoryAmount)} <span class="budget-amount">/ ${formatCurrency(expense.amount)}</span></span>
                    ${expense.type === 'fixed' ? '<span class="lock-indicator" aria-label="Non-adjustable">▣</span>' : ''}
                  </div>`
                }).join('')}
              </div>`
            : '<div class="empty-expenses"><span class="empty-icon">＋</span><p>No expenses added yet.</p><span>Add your monthly costs to see your budget breakdown.</span></div>'}
          <div class="breakdown-footer"><span>Logged so far <span class="breakdown-subtext">· ${remainingBudget >= 0
            ? `${formatCurrency(remainingBudget)} budget left`
            : `${formatCurrency(Math.abs(remainingBudget))} over total budget`}</span></span><strong>${formatCurrency(totalSpent)}</strong></div>
        </article>

        <article class="panel progress-panel">
          <div class="eyebrow">ONE GOAL, ONE STEP AT A TIME</div>
          <h2>Your savings goal</h2>
          <p class="panel-description">A clear target makes it easier to stay on track.</p>
          <div class="goal-amount-row"><span>Monthly target</span><strong>${formatCurrency(budget.savingsGoal)}</strong></div>
          <div class="goal-amount-row expected-row"><span>Expected savings</span><strong class="${expectedSavings < 0 ? 'negative-value' : ''}">${formatCurrency(expectedSavings)}</strong></div>
          <div class="progress-track" role="progressbar" aria-label="Savings goal progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(goalProgress)}"><span style="width:${goalProgress}%"></span></div>
          <div class="progress-caption"><span>0%</span><span>${Math.round(goalProgress)}% of goal</span><span>100%</span></div>
          <div class="status-message ${onTrack ? 'on-track' : 'needs-attention'}">
            <span class="status-symbol" aria-hidden="true">${onTrack ? '✓' : '!'}</span>
            <div><strong>${onTrack ? 'You’re on track' : 'A little gap to work on'}</strong><p>${onTrack
              ? (budget.savingsGoal > 0 ? `Your plan leaves ${formatCurrency(difference)} beyond your goal.` : 'Your budget is currently within your income.')
                : `You’re ${formatCurrency(Math.abs(difference))} short based on your plan and logged overages.`}</p></div>
          </div>
          <p class="calculation-note">Assumes you use the rest of each planned category budget; logged overages reduce expected savings.</p>
        </article>
      </section>

      <section class="panel forecast-panel" data-forecast-panel aria-labelledby="forecast-title">
        <div class="forecast-heading">
          <div><div class="eyebrow">A LOOK AHEAD</div><h2 id="forecast-title">Savings prediction</h2><p class="panel-description">A month-end estimate based on your logged spending pace.</p></div>
          <span class="forecast-state forecast-loading" data-forecast-state role="status" aria-live="polite">Preparing your estimate…</span>
        </div>
        <div class="forecast-layout">
          <div class="forecast-summary">
            <span>Projected savings this month</span>
            <strong data-forecast-savings>—</strong>
            <div class="forecast-goal-line"><span>Your goal</span><strong>${formatCurrency(budget.savingsGoal)}</strong></div>
            <p class="forecast-gap" data-forecast-gap>Calculating goal progress…</p>
            <div class="progress-track forecast-progress" data-forecast-progress-track role="progressbar" aria-label="Projected savings goal progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span data-forecast-progress style="width:0%"></span></div>
          </div>
          <div class="forecast-detail">
            <div class="forecast-detail-top"><span>Projected monthly expenses</span><strong data-forecast-expenses>—</strong></div>
            <div class="forecast-detail-top"><span>Month progress</span><strong data-forecast-days>—</strong></div>
            <div data-forecast-categories><p class="forecast-empty">Calculating flexible category estimates…</p></div>
          </div>
        </div>
        <p class="forecast-confidence" data-forecast-confidence>Forecast uses fixed budgets and month-to-date spending.</p>
      </section>

      <section class="ai-grid" aria-label="AI money assistant">
        <article class="panel ai-panel">
          <div class="panel-heading ai-panel-heading">
            <div><div class="eyebrow"><span class="ai-heading-spark">✳</span> YOUR SPENDWISE ASSISTANT</div><h2>Savings recommendations</h2></div>
            <span class="ai-badge">OPEN-WEIGHT AI</span>
          </div>
          <div id="recommendation-content">${renderAiPanel()}</div>
          <p class="form-error ai-error" data-recommendation-error role="alert" ${recommendationError ? '' : 'hidden'}>${escapeHtml(recommendationError)}</p>
          <button class="primary-button ai-action" data-ai-action="recommendations" type="button">✨ ${recommendationResult ? 'Refresh recommendations' : 'Find ways to reach my goal'} <span aria-hidden="true">→</span></button>
          <p class="ai-privacy-note">When requested, AI sends your income, goal, category budgets and this month’s expense categories, amounts and dates to Groq. Purchase checks also send the optional item description and amount. Your profile name and expense notes stay on this device.</p>
        </article>

        <article class="panel affordability-panel">
          <div class="eyebrow"><span class="ai-heading-spark">✳</span> A QUICK CHECK BEFORE YOU BUY</div>
          <h2>Can I afford this?</h2>
          <p class="panel-description">Check how a purchase could affect your savings goal.</p>
          <form id="affordability-form" class="affordability-form" novalidate>
            <label class="field"><span>What are you thinking of buying? <span class="optional-label">OPTIONAL</span></span>
              <input name="purchaseName" type="text" maxlength="80" placeholder="e.g. New headphones">
            </label>
            <label class="field"><span>Purchase amount</span>
              <span class="money-input"><span>₹</span><input name="purchaseAmount" type="number" min="1" step="1" inputmode="numeric" placeholder="1,500" required></span>
            </label>
            <p class="form-error ai-error" data-affordability-error role="alert" ${affordabilityError ? '' : 'hidden'}>${escapeHtml(affordabilityError)}</p>
            <button class="secondary-button ai-action" data-ai-action="affordability" type="submit">Check with AI <span aria-hidden="true">→</span></button>
          </form>
          <div id="affordability-content">${renderAffordabilityResult()}</div>
        </article>
      </section>

      <section class="panel tracking-panel" aria-labelledby="tracking-title">
        <div class="tracking-heading">
          <div><div class="eyebrow">KEEP YOUR PLAN UP TO DATE</div><h2 id="tracking-title">Expenses this month</h2><p class="panel-description">Log a purchase to update category balances, spending, and budget remaining.</p></div>
          <span class="tracking-total">${formatCurrency(totalSpent)} <span>logged</span></span>
        </div>
        <div class="tracking-grid">
          <form id="expense-form" class="expense-form" novalidate>
            <label class="field"><span>Category</span>
              <select name="category" required>
                <option value="">Choose a category</option>
                ${allExpenses.map((expense) => `<option value="${escapeHtml(expense.category)}">${escapeHtml(expense.category)} · ${expense.type === 'fixed' ? 'Fixed' : 'Flexible'}</option>`).join('')}
              </select>
            </label>
            <label class="field"><span>Amount</span>
              <span class="money-input"><span>₹</span><input name="amount" type="number" min="1" step="1" inputmode="numeric" placeholder="350" required></span>
            </label>
            <label class="field"><span>Date</span>
              <input name="date" type="date" min="${localDateString(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}" max="${localDateString()}" value="${localDateString()}" required>
            </label>
            <label class="field note-field"><span>Note <span class="optional-label">OPTIONAL</span></span>
              <input name="note" type="text" maxlength="100" placeholder="e.g. Lunch with friends">
            </label>
            <p class="form-error" data-tracking-error role="alert" hidden></p>
            <button class="primary-button expense-submit" type="submit">＋ Add expense</button>
          </form>
          <div class="tracking-side">
            <div class="remaining-card">
              <span>Overall budget remaining</span>
              <strong class="${remainingBudget < 0 ? 'negative-value' : ''}">${formatCurrency(remainingBudget)}</strong>
            </div>
            <div class="transaction-list" aria-live="polite">
              <h3>Recent expenses</h3>
              ${monthTransactions.length
                ? [...monthTransactions].sort((first, second) => second.date.localeCompare(first.date)).map((transaction) => `
                  <div class="transaction-item">
                    <span class="transaction-dot"></span>
                    <div class="transaction-details"><strong>${escapeHtml(transaction.category)}</strong><span>${escapeHtml(transaction.note || 'No note')} · ${new Date(`${transaction.date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span></div>
                    <strong class="transaction-amount">${formatCurrency(transaction.amount)}</strong>
                    <button class="icon-button delete-transaction" type="button" data-transaction-id="${escapeHtml(transaction.id)}" aria-label="Delete ${escapeHtml(transaction.category)} expense of ${formatCurrency(transaction.amount)}" title="Delete expense">×</button>
                  </div>`).join('')
                : '<p class="no-transactions">No expenses logged yet. Add your first one to get started.</p>'}
            </div>
          </div>
        </div>
      </section>
      <footer class="dashboard-footer"><span>Spendwise is here to help you feel good about your money.</span><span>Made for real life <span class="footer-star">✳</span></span></footer>
    </main>`

  app.querySelector('#edit-plan').addEventListener('click', () => renderSetup(budget))
  app.querySelector('#expense-form').addEventListener('submit', handleExpenseSubmit)
  app.querySelector('[data-ai-action="recommendations"]').addEventListener('click', handleRecommendationRequest)
  app.querySelector('#affordability-form').addEventListener('submit', handleAffordabilityRequest)
  app.querySelectorAll('.delete-transaction').forEach((button) => {
    button.addEventListener('click', () => deleteTransaction(button.dataset.transactionId))
  })
  requestSavingsForecast()
}

async function handleRecommendationRequest(event) {
  const button = event.currentTarget
  const errorElement = app.querySelector('[data-recommendation-error]')
  errorElement.hidden = true
  button.disabled = true
  button.textContent = 'Thinking through your plan…'
  recommendationError = ''
  try {
    recommendationResult = await callApi('recommendations', makeAiPayload())
    recommendationError = ''
  } catch (error) {
    console.error('Savings recommendation request failed:', error)
    recommendationError = error.message
  }
  renderDashboard()
}

async function handleAffordabilityRequest(event) {
  event.preventDefault()
  const form = event.currentTarget
  const errorElement = app.querySelector('[data-affordability-error]')
  errorElement.hidden = true
  const amount = Number(form.elements.purchaseAmount.value)
  if (!Number.isInteger(amount) || amount <= 0) {
    affordabilityError = 'Enter a purchase amount greater than ₹0.'
    renderDashboard()
    return
  }

  const button = form.querySelector('[data-ai-action="affordability"]')
  button.disabled = true
  button.textContent = 'Checking your plan…'
  affordabilityError = ''
  try {
    affordabilityResult = await callApi('affordability', {
      ...makeAiPayload(),
      purchase: { name: form.elements.purchaseName.value.trim(), amount },
    })
    affordabilityError = ''
  } catch (error) {
    console.error('Affordability request failed:', error)
    affordabilityError = error.message
  }
  renderDashboard()
}

function handleExpenseSubmit(event) {
  event.preventDefault()
  const form = event.currentTarget
  const errorElement = app.querySelector('[data-tracking-error]')
  errorElement.hidden = true

  try {
    const category = form.elements.category.value
    const amount = Number(form.elements.amount.value)
    const date = form.elements.date.value
    const note = form.elements.note.value.trim()
    const allowedCategories = [...budget.fixedExpenses, ...budget.flexibleExpenses].map((expense) => expense.category)
    const today = localDateString()
    const monthStart = localDateString(new Date(new Date().getFullYear(), new Date().getMonth(), 1))

    if (!allowedCategories.includes(category)) throw new Error('Choose a category from your budget.')
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('Enter a whole-rupee expense amount greater than ₹0.')
    if (!date || date < monthStart || date > today) throw new Error('Choose a date in this month that is not in the future.')

    const transaction = {
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      category,
      amount,
      date,
      note,
    }
    saveBudget({ ...budget, transactions: [...budget.transactions, transaction] })
  } catch (error) {
    showError(error.message)
  }
}

function deleteTransaction(transactionId) {
  const transactions = budget.transactions.filter((transaction) => transaction.id !== transactionId)
  if (transactions.length === budget.transactions.length) {
    showError('That expense could not be found. Refresh the page and try again.')
    return
  }
  saveBudget({ ...budget, transactions })
}

app.addEventListener('click', handleSetupClick)
renderDashboard()
