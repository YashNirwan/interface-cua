/**
 * Meridian Core — HTML rendering.
 *
 * Deliberate constraints, enforced by hand throughout this file:
 *   - Structure is tables. No grid, no flex, no divs-for-layout.
 *   - No test ids, no ARIA, no <label for>, no landmark elements, no role.
 *   - Controls are named ONLY by the text in the <td> to their left.
 *   - ids/names follow the ASP.NET WebForms convention
 *     (id="ctl00_MainContent_txtFoo" name="ctl00$MainContent$txtFoo").
 *   - Buttons are <input type="submit" value="..."> so their accessible name
 *     comes from @value rather than text content.
 *   - Data tables carry a <caption> holding the section name, which is the
 *     only thing that makes ambiguous controls ("View") disambiguable.
 *
 * Inline <style> is allowed for colour only; every <style> rule here is
 * cosmetic and none of it participates in layout.
 */

import {
  type Account,
  type ActivityEntry,
  type Member,
  SUB_ACCOUNT_TYPES,
  displayName,
  formatMoney,
  totalBalance,
} from './data.js';

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

/** Escape everything interpolated into HTML. The app is fake; it still should not be XSS-able. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ctlId(short: string): string {
  return `ctl00_MainContent_${short}`;
}

function ctlName(short: string): string {
  return `ctl00$MainContent$${short}`;
}

function textField(short: string, value = '', size = 24, type: 'text' | 'password' = 'text'): string {
  return `<input type="${type}" name="${ctlName(short)}" id="${ctlId(short)}" size="${size}" maxlength="40" value="${esc(value)}">`;
}

function submitButton(short: string, value: string): string {
  return `<input type="submit" name="${ctlName(short)}" id="${ctlId(short)}" value="${esc(value)}">`;
}

function hiddenField(short: string, value: string): string {
  return `<input type="hidden" name="${ctlName(short)}" id="${ctlId(short)}" value="${esc(value)}">`;
}

const VIEWSTATE =
  '<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="dDwtNjE3ODM0MjQ1O3Q8O2w8aTwxPjs+O2w8dDw7bDxpPDE+Oz47bDx0PDs7Pjs+Pjs+Pjs+Pg==">' +
  '<input type="hidden" name="__EVENTTARGET" id="__EVENTTARGET" value="">' +
  '<input type="hidden" name="__EVENTARGUMENT" id="__EVENTARGUMENT" value="">';

function formOpen(action: string, method: 'post' | 'get' = 'post'): string {
  const open = `<form name="aspnetForm" method="${method}" action="${esc(action)}">`;
  return method === 'post' ? open + VIEWSTATE : open;
}

/* ------------------------------------------------------------------ */
/* document shells                                                     */
/* ------------------------------------------------------------------ */

const STYLE = `
body { font-family: Verdana, Arial, sans-serif; font-size: 11px; color: #000000; margin: 0; }
td { font-family: Verdana, Arial, sans-serif; font-size: 11px; }
caption { font-family: Verdana, Arial, sans-serif; font-size: 11px; font-weight: bold; text-align: left; padding: 4px 2px; color: #003366; }
input, select { font-family: Verdana, Arial, sans-serif; font-size: 11px; }
a { color: #003366; }
a:visited { color: #003366; }
.err { color: #CC0000; font-weight: bold; }
.dim { color: #555555; }
`;

function doc(title: string, body: string, bodyAttrs = 'bgcolor="#EFEFE7" text="#000000" link="#003366" vlink="#003366"'): string {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<title>${esc(title)}</title>
<style type="text/css">${STYLE}</style>
</head>
<body ${bodyAttrs}>
${body}
</body>
</html>`;
}

/**
 * The standard main-frame screen chrome: a navy title band above the content,
 * built from nested tables the way a 2003 intranet app would have done it.
 */
function screen(title: string, content: string): string {
  const body = `<table width="100%" border="0" cellpadding="0" cellspacing="0">
  <tr>
    <td bgcolor="#003366">
      <table width="100%" border="0" cellpadding="5" cellspacing="0">
        <tr>
          <td><font color="#FFFFFF" size="2"><b>${esc(title)}</b></font></td>
          <td align="right"><font color="#AFC4DA" size="1">MERIDIAN CORE v4.2.1&nbsp;&nbsp;</font></td>
        </tr>
      </table>
    </td>
  </tr>
  <tr><td bgcolor="#7F9DB9" height="2"></td></tr>
  <tr>
    <td>
      <table width="100%" border="0" cellpadding="10" cellspacing="0">
        <tr>
          <td width="8">&nbsp;</td>
          <td valign="top">
${content}
          </td>
          <td width="8">&nbsp;</td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
  return doc(`Meridian Core - ${title}`, body);
}

/** A bold pseudo-heading. Intentionally not an <h1> — the app has no semantic headings. */
function headingCell(text: string): string {
  return `<table border="0" cellpadding="0" cellspacing="0"><tr><td><font size="2"><b>${esc(text)}</b></font></td></tr></table>
<table border="0" cellpadding="0" cellspacing="0"><tr><td height="8">&nbsp;</td></tr></table>`;
}

function spacerRow(height = 10): string {
  return `<table border="0" cellpadding="0" cellspacing="0"><tr><td height="${height}">&nbsp;</td></tr></table>`;
}

/** `<td>Label:</td><td>value</td>` — the pattern the accessible-name fallback must handle. */
function labelRow(label: string, value: string): string {
  return `        <tr>
          <td bgcolor="#E4E4DC" width="150" valign="top" nowrap="nowrap">${esc(label)}</td>
          <td bgcolor="#FFFFFF" valign="top">${value}</td>
        </tr>`;
}

function fieldRow(label: string, control: string): string {
  return `        <tr>
          <td width="150" align="right" nowrap="nowrap">${esc(label)}</td>
          <td>${control}</td>
        </tr>`;
}

function errorBanner(message: string): string {
  return `<table border="0" cellpadding="4" cellspacing="0" width="100%">
  <tr><td bgcolor="#FFF0F0"><span class="err">${esc(message)}</span></td></tr>
</table>${spacerRow(8)}`;
}

/* ------------------------------------------------------------------ */
/* sign-on / shell / navigation                                        */
/* ------------------------------------------------------------------ */

export function loginPage(message?: string): string {
  const banner = message ? errorBanner(message) : '';
  const body = `<table width="100%" height="100%" border="0" cellpadding="0" cellspacing="0">
  <tr>
    <td align="center" valign="middle">
      <table border="1" cellpadding="0" cellspacing="0" bordercolor="#7F9DB9" bgcolor="#FFFFFF" width="420">
        <tr>
          <td bgcolor="#003366" colspan="2"><table width="100%" cellpadding="6" cellspacing="0" border="0"><tr>
            <td><font color="#FFFFFF" size="2"><b>Meridian Core &mdash; Member Services</b></font></td>
          </tr></table></td>
        </tr>
        <tr>
          <td colspan="2">
            <table width="100%" border="0" cellpadding="8" cellspacing="0">
              <tr><td>
                ${banner}
                ${formOpen('/meridian/login')}
                <table border="0" cellpadding="4" cellspacing="0">
${fieldRow('User ID:', textField('txtUserId'))}
${fieldRow('Password:', textField('txtPassword', '', 24, 'password'))}
                  <tr>
                    <td>&nbsp;</td>
                    <td>${submitButton('btnSignOn', 'Sign On')}</td>
                  </tr>
                </table>
                </form>
              </td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td bgcolor="#E4E4DC" colspan="2"><font size="1" class="dim">&nbsp;Authorised personnel only. Activity is logged.</font></td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
  return doc('Meridian Core - Sign On', body);
}

/** The actual frameset. Chromium still renders these; that is exactly the point. */
export function framesetPage(): string {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<title>Meridian Core</title>
</head>
<frameset cols="190,*" frameborder="1" framespacing="0" border="1">
  <frame name="navFrame" src="/meridian/nav" scrolling="auto" marginwidth="0" marginheight="0">
  <frame name="mainFrame" src="/meridian/search" scrolling="auto" marginwidth="0" marginheight="0">
  <noframes>
  <body bgcolor="#EFEFE7">
  <table border="0" cellpadding="10"><tr><td>This application requires a browser with frame support.</td></tr></table>
  </body>
  </noframes>
</frameset>
</html>`;
}

export function navPage(userId: string): string {
  const link = (href: string, target: string, text: string): string =>
    `        <tr><td bgcolor="#FFFFFF">&nbsp;<a href="${esc(href)}" target="${esc(target)}">${esc(text)}</a></td></tr>
        <tr><td bgcolor="#C8C8BE" height="1"></td></tr>`;

  const body = `<table width="100%" border="0" cellpadding="0" cellspacing="0">
  <tr><td bgcolor="#003366"><table width="100%" cellpadding="5" cellspacing="0" border="0"><tr>
    <td><font color="#FFFFFF" size="1"><b>MAIN MENU</b></font></td>
  </tr></table></td></tr>
  <tr>
    <td>
      <table width="100%" border="0" cellpadding="4" cellspacing="0">
${link('/meridian/search', 'mainFrame', 'Member Search')}
${link('/meridian/services', 'mainFrame', 'Account Services')}
${link('/meridian/logout', '_top', 'Sign Off')}
      </table>
    </td>
  </tr>
  <tr><td height="20">&nbsp;</td></tr>
  <tr><td bgcolor="#E4E4DC"><font size="1" class="dim">&nbsp;Operator:<br>&nbsp;${esc(userId)}</font></td></tr>
</table>`;
  return doc('Navigation', body, 'bgcolor="#E4E4DC" text="#000000" link="#003366" vlink="#003366"');
}

/* ------------------------------------------------------------------ */
/* search                                                              */
/* ------------------------------------------------------------------ */

export function searchPage(memberId = '', surname = ''): string {
  const content = `${headingCell('Member Search')}
${formOpen('/meridian/search')}
<table border="1" cellpadding="0" cellspacing="0" bordercolor="#7F9DB9" bgcolor="#FFFFFF">
  <tr><td>
    <table border="0" cellpadding="5" cellspacing="0">
${fieldRow('Member ID:', textField('txtMemberId', memberId, 16))}
${fieldRow('Surname:', textField('txtSurname', surname, 24))}
      <tr>
        <td>&nbsp;</td>
        <td>${submitButton('btnSearch', 'Search')}&nbsp;${submitButton('btnClear', 'Clear')}</td>
      </tr>
    </table>
  </td></tr>
</table>
</form>
${spacerRow()}
<font size="1" class="dim">Enter a 6-digit member number, or a surname to list matching records.</font>`;
  return screen('Member Search', content);
}

export function searchResultsPage(surname: string, matches: readonly Member[]): string {
  const rows = matches
    .map(
      (m, i) => `      <tr bgcolor="${i % 2 === 0 ? '#FFFFFF' : '#F4F4EC'}">
        <td><a href="/meridian/member/${esc(m.id)}">${esc(m.id)}</a></td>
        <td>${esc(displayName(m))}</td>
        <td>${esc(m.status)}</td>
        <td>${esc(m.branch)}</td>
      </tr>`,
    )
    .join('\n');

  const content = `${headingCell('Search Results')}
<table border="0" cellpadding="0" cellspacing="0"><tr><td>${esc(`${matches.length} record(s) matched surname "${surname}".`)}</td></tr></table>
${spacerRow(8)}
<table border="1" cellpadding="4" cellspacing="0" bordercolor="#7F9DB9" width="100%">
  <caption>Search Results</caption>
  <tr bgcolor="#003366">
    <td><font color="#FFFFFF"><b>Member ID</b></font></td>
    <td><font color="#FFFFFF"><b>Name</b></font></td>
    <td><font color="#FFFFFF"><b>Status</b></font></td>
    <td><font color="#FFFFFF"><b>Branch</b></font></td>
  </tr>
${rows}
</table>
${spacerRow()}
<table border="0" cellpadding="0" cellspacing="0"><tr><td><a href="/meridian/search">Return to Member Search</a></td></tr></table>`;
  return screen('Search Results', content);
}

/** Business outcome, not an error: HTTP 200 with the exact detector string. */
export function notFoundPage(): string {
  const content = `${headingCell('Search Results')}
<table border="1" cellpadding="8" cellspacing="0" bordercolor="#7F9DB9" bgcolor="#FFFFFF">
  <tr><td>No member records matched the supplied criteria.</td></tr>
</table>
${spacerRow()}
<table border="0" cellpadding="0" cellspacing="0"><tr><td><a href="/meridian/search">Return to Member Search</a></td></tr></table>`;
  return screen('Search Results', content);
}

/** Field-level validation failure. Also HTTP 200 — WebForms never used status codes. */
export function validationPage(title: string, message: string, backHref: string, backText: string): string {
  const content = `${headingCell(title)}
${errorBanner(message)}
<table border="0" cellpadding="0" cellspacing="0"><tr><td><a href="${esc(backHref)}">${esc(backText)}</a></td></tr></table>`;
  return screen(title, content);
}

/* ------------------------------------------------------------------ */
/* member detail                                                       */
/* ------------------------------------------------------------------ */

function accountRow(member: Member, account: Account, index: number): string {
  const ctl = String(index + 2).padStart(2, '0');
  return `      <tr bgcolor="${index % 2 === 0 ? '#FFFFFF' : '#F4F4EC'}">
        <td>${esc(account.type)}</td>
        <td>${esc(account.number)}</td>
        <td>${esc(account.status)}</td>
        <td align="right">${esc(formatMoney(account.balance))}</td>
        <td align="center">
          <form name="frmAcct${esc(ctl)}" method="post" action="/meridian/member/${esc(member.id)}/account">
            <input type="hidden" name="ctl00$MainContent$hidAccount" value="${esc(account.number)}">
            <input type="submit" name="ctl00$MainContent$gvAccounts$ctl${esc(ctl)}$btnView" id="ctl00_MainContent_gvAccounts_ctl${esc(ctl)}_btnView" value="View">
          </form>
        </td>
      </tr>`;
}

function activityRow(member: Member, entry: ActivityEntry, index: number): string {
  // Only the most recent posting is actionable. That is what makes the page
  // ambiguous by name ("View" appears in two sections) but resolvable by
  // section ("View" inside "Recent Activity" is unique).
  const action =
    index === 0
      ? `          <form name="frmAct01" method="post" action="/meridian/member/${esc(member.id)}/activity">
            <input type="hidden" name="ctl00$MainContent$hidEntry" value="0">
            <input type="submit" name="ctl00$MainContent$gvActivity$ctl02$btnView" id="ctl00_MainContent_gvActivity_ctl02_btnView" value="View">
          </form>`
      : '          &nbsp;';
  return `      <tr bgcolor="${index % 2 === 0 ? '#FFFFFF' : '#F4F4EC'}">
        <td nowrap="nowrap">${esc(entry.date)}</td>
        <td>${esc(entry.description)}</td>
        <td>${esc(entry.account)}</td>
        <td align="right">${esc(formatMoney(entry.amount))}</td>
        <td align="center">
${action}
        </td>
      </tr>`;
}

export function memberPage(member: Member): string {
  const accounts = member.accounts.map((a, i) => accountRow(member, a, i)).join('\n');
  const activity = member.activity.map((e, i) => activityRow(member, e, i)).join('\n');

  const content = `${headingCell(`Member ${member.id} — Profile`)}
<table border="1" cellpadding="0" cellspacing="0" bordercolor="#7F9DB9" width="100%">
  <tr>
    <td>
      <table border="0" cellpadding="4" cellspacing="1" width="100%" bgcolor="#C8C8BE">
        <caption>Member Information</caption>
${labelRow('Name:', esc(displayName(member)))}
${labelRow('Member ID:', esc(member.id))}
${labelRow('Status:', esc(member.status))}
${labelRow('Branch:', esc(member.branch))}
${labelRow('Member Since:', esc(member.memberSince))}
      </table>
    </td>
  </tr>
</table>
${spacerRow()}
<table border="1" cellpadding="0" cellspacing="0" bordercolor="#7F9DB9">
  <tr>
    <td>
      <table border="0" cellpadding="4" cellspacing="1" bgcolor="#C8C8BE">
        <caption>Relationship Summary</caption>
${labelRow('Total Relationship Balance:', esc(formatMoney(totalBalance(member))))}
${labelRow('Accounts On File:', esc(String(member.accounts.length)))}
      </table>
    </td>
  </tr>
</table>
${spacerRow()}
<table border="1" cellpadding="4" cellspacing="0" bordercolor="#7F9DB9" width="100%">
  <caption>Accounts</caption>
  <tr bgcolor="#003366">
    <td><font color="#FFFFFF"><b>Account Type</b></font></td>
    <td><font color="#FFFFFF"><b>Account Number</b></font></td>
    <td><font color="#FFFFFF"><b>Status</b></font></td>
    <td align="right"><font color="#FFFFFF"><b>Current Balance</b></font></td>
    <td width="60">&nbsp;</td>
  </tr>
${accounts}
</table>
${spacerRow(8)}
<table border="0" cellpadding="0" cellspacing="0">
  <tr><td>
    <form name="frmOpenSub" method="get" action="/meridian/member/${esc(member.id)}/subaccount">
      <input type="submit" name="ctl00$MainContent$btnOpenSub" id="ctl00_MainContent_btnOpenSub" value="Open Sub-Account">
    </form>
  </td></tr>
</table>
${spacerRow()}
<table border="1" cellpadding="4" cellspacing="0" bordercolor="#7F9DB9" width="100%">
  <caption>Recent Activity</caption>
  <tr bgcolor="#003366">
    <td><font color="#FFFFFF"><b>Posting Date</b></font></td>
    <td><font color="#FFFFFF"><b>Description</b></font></td>
    <td><font color="#FFFFFF"><b>Account</b></font></td>
    <td align="right"><font color="#FFFFFF"><b>Amount</b></font></td>
    <td width="60">&nbsp;</td>
  </tr>
${activity}
</table>
${spacerRow()}
<table border="0" cellpadding="0" cellspacing="0"><tr><td><a href="/meridian/search">Return to Member Search</a></td></tr></table>`;
  return screen('Member Profile', content);
}

export function permissionDeniedPage(): string {
  const content = `${headingCell('Member Profile')}
<table border="1" cellpadding="8" cellspacing="0" bordercolor="#CC0000" bgcolor="#FFF0F0" width="100%">
  <tr><td><span class="err">You are not authorised to view this member record. Contact your security administrator.</span></td></tr>
</table>
${spacerRow()}
<table border="0" cellpadding="0" cellspacing="0"><tr><td><a href="/meridian/search">Return to Member Search</a></td></tr></table>`;
  return screen('Member Profile', content);
}

export function accountDetailPage(member: Member, account: Account): string {
  const content = `${headingCell(`Account ${account.number} — Detail`)}
<table border="1" cellpadding="0" cellspacing="0" bordercolor="#7F9DB9">
  <tr><td>
    <table border="0" cellpadding="4" cellspacing="1" bgcolor="#C8C8BE">
      <caption>Account Detail</caption>
${labelRow('Member:', esc(`${member.id} ${displayName(member)}`))}
${labelRow('Account Type:', esc(account.type))}
${labelRow('Account Number:', esc(account.number))}
${labelRow('Status:', esc(account.status))}
${labelRow('Current Balance:', esc(formatMoney(account.balance)))}
    </table>
  </td></tr>
</table>
${spacerRow()}
<table border="0" cellpadding="0" cellspacing="0"><tr><td><a href="/meridian/member/${esc(member.id)}">Return to Member Profile</a></td></tr></table>`;
  return screen('Account Detail', content);
}

export function activityDetailPage(member: Member, entry: ActivityEntry): string {
  const content = `${headingCell(`Posting ${entry.date} — Detail`)}
<table border="1" cellpadding="0" cellspacing="0" bordercolor="#7F9DB9">
  <tr><td>
    <table border="0" cellpadding="4" cellspacing="1" bgcolor="#C8C8BE">
      <caption>Activity Detail</caption>
${labelRow('Member:', esc(`${member.id} ${displayName(member)}`))}
${labelRow('Posting Date:', esc(entry.date))}
${labelRow('Description:', esc(entry.description))}
${labelRow('Account:', esc(entry.account))}
${labelRow('Amount:', esc(formatMoney(entry.amount)))}
    </table>
  </td></tr>
</table>
${spacerRow()}
<table border="0" cellpadding="0" cellspacing="0"><tr><td><a href="/meridian/member/${esc(member.id)}">Return to Member Profile</a></td></tr></table>`;
  return screen('Activity Detail', content);
}

/* ------------------------------------------------------------------ */
/* sub-account flow                                                    */
/* ------------------------------------------------------------------ */

export function subAccountFormPage(member: Member, values?: { type?: string; deposit?: string; purpose?: string }): string {
  const selected = values?.type ?? '';
  const options = SUB_ACCOUNT_TYPES.map(
    (t) => `            <option value="${esc(t)}"${t === selected ? ' selected="selected"' : ''}>${esc(t)}</option>`,
  ).join('\n');

  const content = `${headingCell(`Open Sub-Account — Member ${member.id}`)}
${formOpen(`/meridian/member/${member.id}/subaccount`)}
<table border="1" cellpadding="0" cellspacing="0" bordercolor="#7F9DB9" bgcolor="#FFFFFF">
  <tr><td>
    <table border="0" cellpadding="5" cellspacing="0">
${fieldRow('Member:', `${esc(member.id)} ${esc(displayName(member))}`)}
${fieldRow(
    'Account Type:',
    `<select name="ctl00$MainContent$ddlType" id="ctl00_MainContent_ddlType">
${options}
          </select>`,
  )}
${fieldRow('Initial Deposit:', textField('txtDeposit', values?.deposit ?? '', 12))}
${fieldRow('Purpose:', textField('txtPurpose', values?.purpose ?? '', 40))}
      <tr>
        <td>&nbsp;</td>
        <td>${submitButton('btnContinue', 'Continue')}</td>
      </tr>
    </table>
  </td></tr>
</table>
</form>
${spacerRow()}
<font size="1" class="dim">Minimum opening deposit is $25.00. Postings are irreversible once confirmed.</font>
${spacerRow(8)}
<table border="0" cellpadding="0" cellspacing="0"><tr><td><a href="/meridian/member/${esc(member.id)}">Return to Member Profile</a></td></tr></table>`;
  return screen('Open Sub-Account', content);
}

export function subAccountReviewPage(
  member: Member,
  values: { type: string; deposit: string; purpose: string },
): string {
  const content = `${headingCell(`Review Sub-Account — Member ${member.id}`)}
<table border="1" cellpadding="0" cellspacing="0" bordercolor="#7F9DB9" width="100%">
  <tr><td>
    <table border="0" cellpadding="4" cellspacing="1" width="100%" bgcolor="#C8C8BE">
      <caption>Review Sub-Account</caption>
${labelRow('Member:', esc(`${member.id} ${displayName(member)}`))}
${labelRow('Account Type:', esc(values.type))}
${labelRow('Initial Deposit:', esc(formatMoney(Number(values.deposit))))}
${labelRow('Purpose:', esc(values.purpose === '' ? '(not supplied)' : values.purpose))}
    </table>
  </td></tr>
</table>
${spacerRow()}
<table border="0" cellpadding="0" cellspacing="0"><tr><td>
${formOpen(`/meridian/member/${member.id}/subaccount/confirm`)}
${hiddenField('hidType', values.type)}
${hiddenField('hidDeposit', values.deposit)}
${hiddenField('hidPurpose', values.purpose)}
<table border="0" cellpadding="0" cellspacing="0"><tr>
  <td>${submitButton('btnPost', 'Post New Sub-Account')}</td>
  <td>&nbsp;</td>
  <td>${submitButton('btnCancel', 'Cancel')}</td>
</tr></table>
</form>
</td></tr></table>
${spacerRow()}
<font size="1" class="dim">Posting this sub-account cannot be undone from this screen.</font>`;
  return screen('Review Sub-Account', content);
}

export function subAccountDonePage(member: Member, account: Account): string {
  const content = `${headingCell(`Open Sub-Account — Member ${member.id}`)}
<table border="1" cellpadding="8" cellspacing="0" bordercolor="#7F9DB9" bgcolor="#F0FFF0" width="100%">
  <tr><td><b>Sub-account created successfully.</b></td></tr>
</table>
${spacerRow()}
<table border="1" cellpadding="0" cellspacing="0" bordercolor="#7F9DB9">
  <tr><td>
    <table border="0" cellpadding="4" cellspacing="1" bgcolor="#C8C8BE">
      <caption>New Sub-Account</caption>
${labelRow('Account Number:', esc(account.number))}
${labelRow('Account Type:', esc(account.type))}
${labelRow('Status:', esc(account.status))}
${labelRow('Opening Balance:', esc(formatMoney(account.balance)))}
    </table>
  </td></tr>
</table>
${spacerRow()}
<table border="0" cellpadding="0" cellspacing="0"><tr><td><a href="/meridian/member/${esc(member.id)}">Return to Member Profile</a></td></tr></table>`;
  return screen('Sub-Account Posted', content);
}

/* ------------------------------------------------------------------ */
/* account services (menu stub)                                        */
/* ------------------------------------------------------------------ */

export function accountServicesPage(): string {
  const content = `${headingCell('Account Services')}
<table border="1" cellpadding="4" cellspacing="0" bordercolor="#7F9DB9">
  <caption>Available Functions</caption>
  <tr bgcolor="#FFFFFF"><td><a href="/meridian/search">Open Sub-Account (select a member first)</a></td></tr>
  <tr bgcolor="#F4F4EC"><td><span class="dim">Stop Payment &mdash; unavailable in this environment</span></td></tr>
  <tr bgcolor="#FFFFFF"><td><span class="dim">Wire Origination &mdash; unavailable in this environment</span></td></tr>
</table>`;
  return screen('Account Services', content);
}

/* ------------------------------------------------------------------ */
/* fault screens                                                       */
/* ------------------------------------------------------------------ */

/** The armed-`notice` interstitial. Acknowledging it continues to the pending URL. */
export function systemNoticePage(continueTo: string): string {
  const content = `<table border="1" cellpadding="10" cellspacing="0" bordercolor="#7F9DB9" bgcolor="#FFFFE8" width="100%">
  <tr><td><font size="2"><b>System Notice</b></font></td></tr>
  <tr><td>Scheduled maintenance window begins at 23:00 ET.</td></tr>
  <tr><td>
    ${formOpen('/meridian/_notice/ack')}
    ${hiddenField('hidReturn', continueTo)}
    ${submitButton('btnAcknowledge', 'Acknowledge')}
    </form>
  </td></tr>
</table>`;
  return screen('System Notice', content);
}

/** The armed-`error500` page. Served with HTTP 500. */
export function serverErrorPage(): string {
  const body = `<table width="100%" border="0" cellpadding="0" cellspacing="0">
  <tr><td bgcolor="#FFFFCC"><table width="100%" cellpadding="8" cellspacing="0" border="0">
    <tr><td><font size="3" color="#CC0000"><b>Server Error in &#39;/MeridianCore&#39; Application.</b></font></td></tr>
  </table></td></tr>
  <tr><td bgcolor="#C8C8BE" height="2"></td></tr>
  <tr><td><table width="100%" cellpadding="10" cellspacing="0" border="0">
    <tr><td><b>Unhandled exception in module MBRSVC. Reference 0x8007007E.</b></td></tr>
    <tr><td><font size="1" class="dim">Description: An unhandled exception occurred during the execution of the current web request. Review the stack trace for more information about the error and where it originated in the code.</font></td></tr>
    <tr><td><a href="/meridian/search">Return to Member Search</a></td></tr>
  </table></td></tr>
</table>`;
  return doc('Server Error', body);
}
