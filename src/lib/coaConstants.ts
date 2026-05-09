/**
 * Chart of Accounts (COA) Hierarchy Constants
 * Backend version - mirrors frontend for code generation consistency
 * 
 * Maps account subcategories to their Level 3 COA base codes (3-segment format).
 * Full account codes follow 5-segment format: 1-02-070-0000-00001
 */

export const COA_SUBCATEGORY_MAP: Record<string, string> = {
  // ASSET ACCOUNTS
  cash: "1-02-070",           // CASH & BANK BALANCES
  bank: "1-02-070",           // Alias for cash
  receivable: "1-02-020",     // ACCOUNT RECEIVABLES
  "accounts-receivable": "1-02-020", // Legacy alias
  inventory: "1-02-010",      // STOCK IN TRADE
  fixed: "1-01-010",          // PROPERTY, PLANT & EQUIPMENT
  "fixed-assets": "1-01-010", // Legacy alias
  other_current: "1-02-050",  // OTHER CURRENT ASSETS

  // LIABILITY ACCOUNTS
  payable: "2-04-010",        // CREDITORS, ACCRUED & OTHER LIABILITIES
  "accounts-payable": "2-04-010", // Legacy alias
  tax_payable: "2-05-010",    // PROVISION FOR TAXATION
  "tax-payable": "2-05-010",  // Legacy alias
  st_loan: "2-04-020",        // SHORT-TERM LOANS
  "short-term-loan": "2-04-020", // Alias
  accrued: "2-04-030",        // ACCRUED EXPENSES & LIABILITIES
  "accrued-expenses": "2-04-030", // Alias
  other_current_liability: "2-04-040",  // OTHER CURRENT LIABILITIES

  // EQUITY ACCOUNTS
  equity: "2-01-010",         // ISSUED SUBSCRIBED AND PAID UP CAPITAL
  capital: "2-01-010",        // Alias
  reserves: "2-02-020",       // REVENUE RESERVE
  retained: "2-02-010",       // RETAINED EARNINGS
  drawings: "2-03-010",       // DRAWINGS / DIVIDENDS
  other: "2-03-020",          // OTHER EQUITY

  // REVENUE ACCOUNTS
  sales: "3-01-010",          // PROJECT REVENUE / SALES REVENUE
  revenue: "3-01-010",        // Alias
  other_income: "3-02-010",   // OTHER INCOME
  service: "3-01-020",        // SERVICE REVENUE

  // EXPENSE ACCOUNTS
  cogs: "4-01-010",           // MATERIAL (Cost of Goods Sold)
  "direct-cost": "4-01-010",  // Alias
  payroll: "4-02-010",        // EMPLOYEE PAYROLL & BENEFIT EXPENSES
  "employee-payroll": "4-02-010", // Legacy alias
  occupancy: "4-02-060",      // OCCUPANCY (RENT, RATES & TAXES)
  rent: "4-02-060",           // Alias for occupancy
  utilities: "4-02-070",      // UTILITY BILL
  maintenance: "4-02-050",    // REPAIR & MAINTENANCE
  supplies: "4-02-030",       // OFFICE & OPERATIONAL SUPPLIES
  food: "4-02-040",           // FOOD & PANTRY EXPENSES
  marketing: "4-02-080",      // MARKETING & ADVERTISING
  miscellaneous: "4-02-090",  // MISCELLANEOUS EXPENSES
  depreciation: "4-03-010",   // DEPRECIATION EXPENSE
  interest: "4-04-010",       // INTEREST EXPENSE
  taxes: "4-04-020",          // TAX EXPENSES
};

/**
 * Gets the COA base code for a subcategory
 * Returns the base code (3 segments) that all detail codes for this subcategory should start with
 */
export function getCoaBaseCode(subcategory: string): string | null {
  return COA_SUBCATEGORY_MAP[subcategory] || null;
}

/**
 * Generates the next available account code for a given subcategory
 * @param subcategory - The account subcategory (e.g., "cash", "receivable")
 * @param existingSubDetailCodes - Array of existing sub-detail codes (5th segment) for this subcategory
 * @returns Full 5-segment account code in format: BASE-0000-SUBDETAIL
 * 
 * Example:
 *   getNextCoaAccountCode("cash", [1, 2, 3]) 
 *   → Uses base "1-02-070", finds next available sub-detail code 4
 *   → Returns "1-02-070-0000-00004"
 */
export function getNextCoaAccountCode(subcategory: string, existingSubDetailCodes: number[]): string {
  const baseCode = getCoaBaseCode(subcategory);
  if (!baseCode) {
    throw new Error(`Unknown subcategory: ${subcategory}`);
  }

  // Find next available sub-detail code (00001-99999)
  const sorted = existingSubDetailCodes.sort((a, b) => a - b);
  let nextSubDetailCode = 1;

  for (const code of sorted) {
    if (code !== nextSubDetailCode) {
      break; // Found a gap
    }
    nextSubDetailCode++;
  }

  if (nextSubDetailCode > 99999) {
    throw new Error(`Subcategory ${subcategory} has exhausted all available sub-detail codes (max 99999)`);
  }

  // Format: BASE-0000-SUBDETAIL (5th segment increments, 4th segment stays 0000)
  const subDetailCodeStr = String(nextSubDetailCode).padStart(5, "0");
  return `${baseCode}-0000-${subDetailCodeStr}`;
}

/**
 * Extracts the sub-detail code (5th segment) from a full COA account code
 * @param fullCode - Full account code in format: 1-02-070-0000-00001
 * @returns The sub-detail code (5th segment) as number, or null if invalid format
 */
export function extractSubDetailCode(fullCode: string): number | null {
  const segments = fullCode.split("-");
  if (segments.length !== 5) return null;
  const subDetailCodeStr = segments[4];
  const num = Number(subDetailCodeStr);
  return Number.isInteger(num) && num > 0 ? num : null;
}

/**
 * Extracts the detail code (4th segment) from a full COA account code
 * @param fullCode - Full account code in format: 1-02-070-0000-00001
 * @returns The detail code (4th segment) as number, or null if invalid format
 */
export function extractDetailCode(fullCode: string): number | null {
  const segments = fullCode.split("-");
  if (segments.length !== 5) return null;
  const detailCodeStr = segments[3];
  const num = Number(detailCodeStr);
  return Number.isInteger(num) ? num : null;
}
