const MONEY_STRONG = /\b(?:payments?|invoices?|billing|refunds?|checkout|vat|moms|salary|salaries|beløb|currency|currencies|dkk)(?![\wæøå])/i
const FIGURE = /\d[\d.,]*\s?(?:kr\b\.?|dkk\b|eur\b|usd\b|€|\$)|(?:\bkr\.?|\bdkk|€|\$)\s?\d/i
const MONEY_WORD = /\b(?:rents?|leje|prices?|amounts?|tax(?:es)?)\b/i
const CALCULATION = /\b(?:totals?|sums?|figures?|calculat\w*|computed|rounding|due|paid|owed|matches)\b/i
const SECURITY = /\b(?:passwords?|secrets?|credentials?|api keys?|encryption|permissions?|auth|authentication|authori[sz]ation|logins?|log in|sign in)\b|(?<![\w.])\.env\b|\b(?:access|auth|api|bearer|refresh|session|csrf|jwt|secret)\s+tokens?\b/i
const PRIVACY = /\b(?:personal data|privacy|gdpr|cpr|consent|date of birth|personnummer)\b/i

export function heldWhenBlocked(text: string): boolean {
  const t = text ?? ''
  const money = MONEY_STRONG.test(t) || FIGURE.test(t) || (MONEY_WORD.test(t) && CALCULATION.test(t))
  return money || SECURITY.test(t) || PRIVACY.test(t)
}

export const HELD_WORDS = 'could not be verified, and it is about money, security or privacy'
