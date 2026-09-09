/**
 * Meridian Core — synthetic seed data.
 *
 * NO REAL PII IS USED ANYWHERE IN THIS FILE. Every member name, member number,
 * account number, branch, balance and transaction below is invented for the
 * purpose of exercising an automation harness against a deliberately archaic
 * web UI. Any resemblance to a real person or a real financial institution is
 * coincidental and unintended.
 *
 * The store is in-memory and mutable (the sub-account flow appends to it).
 * `resetMembers()` restores the pristine seed so a test run is deterministic.
 */

export type AccountType = 'Savings' | 'Checking' | 'Money Market' | 'Certificate';

export interface Account {
  readonly type: AccountType;
  readonly number: string;
  readonly status: string;
  readonly balance: number;
}

export interface ActivityEntry {
  readonly date: string;
  readonly description: string;
  readonly amount: number;
  readonly account: string;
}

export interface Member {
  readonly id: string;
  readonly firstName: string;
  readonly surname: string;
  readonly status: string;
  readonly branch: string;
  readonly memberSince: string;
  /** Restricted records render the permission-denied screen instead of detail. */
  readonly restricted: boolean;
  accounts: Account[];
  activity: ActivityEntry[];
}

/** The pristine seed. Never mutated — `resetMembers()` deep-copies from here. */
function seed(): Member[] {
  return [
    {
      id: '100288',
      firstName: 'Harold',
      surname: 'Whitfield',
      status: 'Active',
      branch: 'Riverton Main',
      memberSince: '2001-09-24',
      restricted: false,
      accounts: [
        { type: 'Savings', number: 'SAV-0100288-01', status: 'Active', balance: 18240.13 },
        { type: 'Certificate', number: 'CDA-0100288-01', status: 'Matured', balance: 25000.0 },
      ],
      activity: [
        { date: '2026-08-31', description: 'Certificate maturity notice', amount: 0, account: 'CDA-0100288-01' },
        { date: '2026-08-14', description: 'Dividend posting', amount: 61.44, account: 'SAV-0100288-01' },
      ],
    },
    {
      id: '100482',
      firstName: 'Dana',
      surname: 'Whitfield',
      status: 'Active',
      branch: 'Riverton Main',
      memberSince: '2014-03-11',
      restricted: false,
      accounts: [
        { type: 'Savings', number: 'SAV-0100482-01', status: 'Active', balance: 4812.55 },
        { type: 'Checking', number: 'CHK-0100482-01', status: 'Active', balance: 1204.09 },
      ],
      activity: [
        { date: '2026-09-04', description: 'Share draft clearing', amount: -218.7, account: 'CHK-0100482-01' },
        { date: '2026-09-01', description: 'Payroll deposit', amount: 1840.0, account: 'CHK-0100482-01' },
        { date: '2026-08-27', description: 'Branch withdrawal', amount: -300.0, account: 'SAV-0100482-01' },
      ],
    },
    {
      id: '100517',
      firstName: 'Marcus',
      surname: 'Ellery',
      status: 'Active',
      branch: 'Eastgate Annex',
      memberSince: '2019-08-02',
      restricted: false,
      accounts: [{ type: 'Savings', number: 'SAV-0100517-01', status: 'Active', balance: 132.4 }],
      activity: [
        { date: '2026-09-02', description: 'Counter deposit', amount: 40.0, account: 'SAV-0100517-01' },
        { date: '2026-07-19', description: 'Service charge', amount: -3.0, account: 'SAV-0100517-01' },
      ],
    },
    {
      id: '100640',
      firstName: 'Dana',
      surname: 'Whitfield-Ross',
      status: 'Active',
      branch: 'Northfield Plaza',
      memberSince: '2021-01-19',
      restricted: false,
      accounts: [
        { type: 'Checking', number: 'CHK-0100640-01', status: 'Active', balance: 987.62 },
        { type: 'Money Market', number: 'MMK-0100640-01', status: 'Dormant', balance: 15320.44 },
      ],
      activity: [
        { date: '2026-09-03', description: 'Bill payment — utilities', amount: -142.18, account: 'CHK-0100640-01' },
        { date: '2026-08-20', description: 'Transfer from money market', amount: 500.0, account: 'CHK-0100640-01' },
      ],
    },
    {
      id: '100731',
      firstName: 'Alan',
      surname: 'Okonkwo',
      status: 'Active',
      branch: 'Eastgate Annex',
      memberSince: '2016-11-30',
      restricted: false,
      accounts: [{ type: 'Checking', number: 'CHK-0100731-01', status: 'Active', balance: 2450.0 }],
      activity: [{ date: '2026-08-29', description: 'ATM withdrawal', amount: -80.0, account: 'CHK-0100731-01' }],
    },
    {
      id: '100845',
      firstName: 'Beatriz',
      surname: 'Santoro',
      status: 'Closed',
      branch: 'Northfield Plaza',
      memberSince: '2009-05-06',
      restricted: false,
      accounts: [{ type: 'Savings', number: 'SAV-0100845-01', status: 'Closed', balance: 0 }],
      activity: [{ date: '2025-12-15', description: 'Account closure — residual paid', amount: -12.03, account: 'SAV-0100845-01' }],
    },
    {
      id: '100999',
      firstName: 'Priya',
      surname: 'Raghunathan',
      status: 'Active',
      branch: 'Riverton Main',
      memberSince: '2011-06-22',
      restricted: true,
      accounts: [{ type: 'Savings', number: 'SAV-0100999-01', status: 'Active', balance: 77_412.9 }],
      activity: [{ date: '2026-09-05', description: 'Restricted — detail suppressed', amount: 0, account: 'SAV-0100999-01' }],
    },
  ];
}

let members: Member[] = seed();

/** Restore the pristine seed. Called on server start so every run is identical. */
export function resetMembers(): void {
  members = seed();
}

export function allMembers(): readonly Member[] {
  return members;
}

export function findMember(id: string): Member | undefined {
  return members.find((m) => m.id === id);
}

/** Case-insensitive substring match on surname, so "Whitfield" hits the hyphenated one too. */
export function searchBySurname(surname: string): Member[] {
  const needle = surname.trim().toLowerCase();
  if (needle === '') return [];
  return members
    .filter((m) => m.surname.toLowerCase().includes(needle))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function displayName(member: Member): string {
  return `${member.firstName} ${member.surname}`;
}

export function totalBalance(member: Member): number {
  return member.accounts.reduce((sum, a) => sum + a.balance, 0);
}

const TYPE_PREFIX: Readonly<Record<AccountType, string>> = {
  Savings: 'SAV',
  Checking: 'CHK',
  'Money Market': 'MMK',
  Certificate: 'CDA',
};

/**
 * Deterministic account number: PREFIX-0<memberId>-NN where NN is the next
 * sequence for that member. Deterministic on purpose — replay must be able to
 * assert on the created number.
 */
export function nextAccountNumber(member: Member, type: AccountType): string {
  const prefix = TYPE_PREFIX[type];
  const seq = String(member.accounts.length + 1).padStart(2, '0');
  return `${prefix}-0${member.id}-${seq}`;
}

export function appendAccount(member: Member, type: AccountType, balance: number): Account {
  const account: Account = {
    type,
    number: nextAccountNumber(member, type),
    status: 'Active',
    balance,
  };
  member.accounts = [...member.accounts, account];
  return account;
}

export function isAccountType(value: string): value is AccountType {
  return value === 'Savings' || value === 'Checking' || value === 'Money Market' || value === 'Certificate';
}

/** The three types offered by the sub-account form (Checking is not openable as a sub-account). */
export const SUB_ACCOUNT_TYPES: readonly AccountType[] = ['Savings', 'Money Market', 'Certificate'];

/**
 * Hand-rolled rather than Intl so the output is byte-identical on every host:
 * `$4,812.55`, `-$218.70`, `$0.00`.
 */
export function formatMoney(amount: number): string {
  const fixed = Math.abs(amount).toFixed(2);
  const parts = fixed.split('.');
  const whole = parts[0] ?? '0';
  const frac = parts[1] ?? '00';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${amount < 0 ? '-' : ''}$${grouped}.${frac}`;
}
